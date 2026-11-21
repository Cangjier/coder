/**
 * `update` 工具：用 `tmp/` 下的源文件替换 `.coder/` 里的设计文档。
 *
 * 未上锁：直接替换，返回「未上锁、不推荐」提示，不提交。
 *
 * 已上锁：分两步。
 *
 * 1. 第一次调用只校验输入、检查 lock hash、生成随机 key，不改文件；
 *    返回 key 和流程计划，要求 dsh 起子代理审查。
 * 2. 第二次调用带 key、相同的 updates、decision 和 review（用户授权原文），
 *    再次检查 lock hash 与源文件 hash，然后替换、重算 hash、按 decision 提交。
 *
 * 所有检查都是确定性的；复杂失败场景交给 git 和 dsh 的 fs 沙盒兜底。
 *
 * @module coder/tools/update
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CoderError, DOCS_DIR, EXPECTED_DOCS } from '../docs.js'
import {
  assertRepoRoot,
  checkpointAll,
  commitPaths,
  createBranch,
  currentBranch,
  validateNewBranch,
} from '../git.js'
import { LOCK_PATH, hashCoder, readLock, rewriteLock, sha256Hex } from '../lock.js'
import { resolveRoot } from './root.js'

/** update 允许替换的目标文件。 */
const TARGETS = new Set(EXPECTED_DOCS.map((relative) => `${DOCS_DIR}/${relative}`))

/** 源文件必须位于项目根目录的 tmp/ 下。 */
const SOURCE_PREFIX = 'tmp/'

/** 等待第二次调用的 key。进程重启后失效。 */
const pending = new Map()

/**
 * 校验并读取一组 updates。
 *
 * @param {string} root - 项目根目录。
 * @param {unknown} updates - 工具参数。
 * @returns {Promise<object[]>} 规范化后的更新项。
 * @throws {CoderError} 路径、源文件或目标不合法时。
 */
async function normalizeUpdates(root, updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new CoderError('updates 必须是非空数组，每项包含 source 和 target。')
  }

  const tmpRoot = path.resolve(root, 'tmp')
  let realTmp
  try {
    realTmp = await fs.realpath(tmpRoot)
  } catch {
    throw new CoderError(`源目录不存在：${tmpRoot}。update 的源文件必须放在 tmp/ 下。`)
  }

  const normalized = []
  const targets = new Set()
  for (const item of updates) {
    if (item === null || typeof item !== 'object') {
      throw new CoderError('updates 的每一项必须是 { source, target } 对象。')
    }
    const { source, target } = item
    if (typeof source !== 'string' || typeof target !== 'string') {
      throw new CoderError('updates 的 source 和 target 必须是字符串。')
    }
    if (source.includes('\\') || target.includes('\\')) {
      throw new CoderError('路径必须使用 / 分隔。')
    }
    const sourceSegments = source.split('/')
    if (
      path.posix.isAbsolute(source) ||
      sourceSegments.includes('') ||
      sourceSegments.includes('.') ||
      sourceSegments.includes('..') ||
      !source.startsWith(SOURCE_PREFIX)
    ) {
      throw new CoderError(`source 必须是 tmp/ 下的相对路径：${source}`)
    }
    if (!TARGETS.has(target)) {
      const allowed = [...TARGETS].join(', ')
      throw new CoderError(`target 必须是以下文件之一：${allowed}；收到：${target}`)
    }
    if (targets.has(target)) {
      throw new CoderError(`target 重复：${target}`)
    }
    targets.add(target)

    const sourceAbsolute = path.resolve(root, ...source.split('/'))
    const sourceStat = await fs.lstat(sourceAbsolute).catch(() => null)
    if (sourceStat === null || !sourceStat.isFile()) {
      throw new CoderError(`源文件不存在或不是普通文件：${source}`)
    }
    const realSource = await fs.realpath(sourceAbsolute)
    if (realSource !== realTmp && !realSource.startsWith(`${realTmp}${path.sep}`)) {
      throw new CoderError(`源文件必须位于 tmp/ 下：${source}`)
    }
    const targetAbsolute = path.resolve(root, ...target.split('/'))
    const targetStat = await fs.lstat(targetAbsolute).catch(() => null)
    if (targetStat === null || !targetStat.isFile()) {
      throw new CoderError(`target 不存在或不是普通文件：${target}`)
    }
    const content = await fs.readFile(sourceAbsolute)
    normalized.push({
      source,
      target,
      sourceAbsolute,
      targetAbsolute,
      content,
      contentHash: sha256Hex(content),
    })
  }
  return normalized
}

/**
 * 读取锁并检查 hash；没上锁时返回 null。
 *
 * @param {string} docsRoot - `.coder/` 的绝对路径。
 * @returns {Promise<{lock: object, hash: string}|null>} 锁状态。
 * @throws {CoderError} 锁格式错误或 hash 不一致时。
 */
async function lockState(docsRoot) {
  const lock = await readLock(docsRoot)
  if (lock === null) return null
  if (!lock.declarationValid) {
    throw new CoderError('lock.md 第一行不是固定声明；请先修正 lock.md。')
  }
  if (!lock.hashValid) {
    throw new CoderError('lock.md 第二行不是 sha256:<64 位小写 hex>；请先修正 lock.md。')
  }
  let current
  try {
    current = (await hashCoder(docsRoot)).hash
  } catch (error) {
    throw new CoderError(
      `无法重新计算 ${DOCS_DIR}/ 的 hash：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (current !== lock.hash) {
    throw new CoderError(
      'lock hash 与当前 .coder 的内容不一致：上锁期间有文件被直接修改。update 拒绝执行；请先自查并修正，或 unlock 后重新 lock。',
    )
  }
  return { lock, hash: current }
}

/**
 * 校验第二次调用与第一次调用是否是同一组输入。
 *
 * @param {object[]} current - 本次规范化的 updates。
 * @param {object[]} previous - 第一次调用保存的 updates。
 * @returns {void}
 * @throws {CoderError} 不一致时。
 */
function assertSameUpdates(current, previous) {
  if (current.length !== previous.length) {
    throw new CoderError('第二次调用的 updates 与第一次不一致：数量不同。')
  }
  for (let index = 0; index < current.length; index += 1) {
    const now = current[index]
    const before = previous[index]
    if (now.source !== before.source || now.target !== before.target) {
      throw new CoderError('第二次调用的 updates 与第一次不一致：source/target 不同。')
    }
    if (now.contentHash !== before.contentHash) {
      throw new CoderError(`第二次调用前源文件内容发生变化：${now.source}`)
    }
  }
}

/**
 * 把源文件内容写入目标文件。
 *
 * @param {object[]} updates - 规范化后的更新项。
 * @returns {Promise<void>}
 */
async function applyUpdates(updates) {
  for (const item of updates) {
    await fs.writeFile(item.targetAbsolute, item.content)
  }
}

/**
 * 构造 `update` 工具。
 *
 * @param {object} logger - 插件 logger。
 * @returns {object} 工具定义。
 */
export function createUpdateTool(logger) {
  return {
    name: 'update',
    description: [
      'Replace .coder/design documents with source files staged under tmp/.',
      'updates is a non-empty array of { source, target }: source must be a file under the project tmp/ directory, and target must be one of .coder/design/file.md, architecture.md, flow.md, data_structure.md.',
      'Without a lock, update replaces the targets directly, returns a warning that the tree is unlocked and that update is intended for process changes, and makes no commit.',
      'While locked, update checks the lock hash on every call and refuses on a mismatch. The first call (no key) validates input, generates a random key, and returns a plan without modifying files: dsh must start a subagent to review the tmp sources and decide supplement or adjustment. The second call passes the same updates, the key, decision (supplement or adjustment), and review (the original user authorization text). It re-checks the lock hash and source hashes, replaces the files, updates the lock hash, and commits.',
      'supplement commits on the current branch. adjustment first commits the current working tree as a checkpoint, then creates the new branch named by the second call\'s branch argument, then replaces, hashes, and commits. The second adjustment call must pass branch; the second supplement call must omit it. No push and no complex rollback: git and the fs sandbox are the backstop.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Project root that contains the .coder/ docs directory and the tmp/ staging directory. Defaults to the session working directory.',
        },
        updates: {
          type: 'array',
          description:
            'Files to replace. Each item maps a tmp/ source file to one .coder/design target file.',
          items: {
            type: 'object',
            properties: {
              source: {
                type: 'string',
                description: 'Source file path relative to the project root; must start with tmp/.',
              },
              target: {
                type: 'string',
                description:
                  'Target design document: .coder/design/file.md, architecture.md, flow.md, or data_structure.md.',
              },
            },
            required: ['source', 'target'],
            additionalProperties: false,
          },
        },
        key: {
          type: 'string',
          description:
            'Key returned by the first locked call. Omit for the first call; pass it on the second call.',
        },
        decision: {
          type: 'string',
          enum: ['supplement', 'adjustment'],
          description:
            'Second locked call only: supplement commits on the current branch; adjustment checkpoints and creates the new branch named by branch.',
        },
        review: {
          type: 'string',
          description:
            'Second locked call only: the original user authorization text for this update. Must be non-empty.',
        },
        branch: {
          type: 'string',
          description:
            'Second locked adjustment call only: the name of the new branch to create. Required for adjustment; omit for supplement.',
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
      },
    },
    isConcurrencySafe: () => false,

    /**
     * @param {object} args - 工具参数。
     * @param {object} context - 工具执行上下文。
     * @returns {Promise<object>} 更新结果。
     */
    async execute(args, context) {
      const root = resolveRoot(args, context)
      const docsRoot = path.resolve(root, DOCS_DIR)
      const updates = await normalizeUpdates(root, args?.updates)
      const state = await lockState(docsRoot)

      if (state === null) {
        await applyUpdates(updates)
        logger.info(`coder: update applied ${updates.length} files without a lock`)
        return {
          locked: false,
          applied: updates.map((item) => ({ source: item.source, target: item.target })),
          text: [
            `未上锁：已直接替换 ${updates.length} 个文件。`,
            '不推荐在未上锁时走 update；update 是用于流程变更的，未上锁时直接修改更简单。',
          ].join('\n'),
        }
      }

      const key = typeof args?.key === 'string' ? args.key.trim() : ''
      if (key === '') {
        const generated = randomBytes(32).toString('hex')
        pending.set(generated, {
          root,
          lockHash: state.hash,
          updates: updates.map((item) => ({
            source: item.source,
            target: item.target,
            contentHash: item.contentHash,
          })),
        })
        logger.info(`coder: update issued a key for ${updates.length} files (${generated.slice(0, 8)}…)`)
        return {
          locked: true,
          phase: 'review',
          key: generated,
          files: updates.map((item) => ({ source: item.source, target: item.target })),
          text: [
            '已上锁。update 第一步只生成密钥，没有修改文件。',
            `密钥：${generated}`,
            `源文件：${updates.map((item) => item.source).join(', ')}`,
            `目标文件：${updates.map((item) => item.target).join(', ')}`,
            '',
            '下一步：',
            '1. 起子代理审查 tmp/ 中的源文件，判断是设计补充（supplement）还是设计调整（adjustment）。',
            '2. 带同样的 updates、key、decision、review（用户授权原文）再次调用 update；调整时还要带 branch（新建分支名）。',
            '补充：当前分支替换文件、更新 hash 并直接提交，不需要 branch。',
            '调整：先 commit 当前工作区作为 checkpoint，按传入的 branch 新建分支，再替换、更新 hash 并提交。',
            '第二次调用会重新检查 lock hash 与源文件 hash；任何变化都会拒绝执行。',
          ].join('\n'),
        }
      }

      const entry = pending.get(key)
      if (entry === undefined || entry.root !== root) {
        throw new CoderError('key 无效或已使用；请重新做一次未带 key 的 update。')
      }
      const decision = args?.decision
      if (decision !== 'supplement' && decision !== 'adjustment') {
        throw new CoderError('第二次调用必须提供 decision：supplement 或 adjustment。')
      }
      if (typeof args?.review !== 'string' || args.review.trim() === '') {
        throw new CoderError('第二次调用必须提供 review（用户授权原文），且不能为空。')
      }
      if (entry.lockHash !== state.hash) {
        throw new CoderError('lock hash 在两次 update 之间发生变化；请重新开始 update。')
      }
      assertSameUpdates(updates, entry.updates)

      const branchArg = typeof args?.branch === 'string' ? args.branch.trim() : ''
      await assertRepoRoot(root)
      if (decision === 'supplement' && branchArg !== '') {
        throw new CoderError('supplement 不新建分支，第二次调用不需要 branch。')
      }
      if (decision === 'adjustment') {
        if (branchArg === '') {
          throw new CoderError('第二次 adjustment 调用必须提供 branch（新建分支名）。')
        }
        await validateNewBranch(root, branchArg)
      }
      pending.delete(key)

      const targetPaths = updates.map((item) => item.target)
      const branchBefore = await currentBranch(root)

      if (decision === 'supplement') {
        await applyUpdates(updates)
        const hash = (await hashCoder(docsRoot)).hash
        await rewriteLock(state.lock, hash)
        const commit = await commitPaths(
          root,
          [...targetPaths, LOCK_PATH],
          'coder: update design (supplement)',
        )
        logger.info(`coder: update supplement applied ${updates.length} files; commit=${commit ?? 'none'}`)
        return {
          locked: true,
          decision,
          branch: branchBefore,
          commit,
          hash,
          files: updates.map((item) => ({ source: item.source, target: item.target })),
          text: [
            `已按设计补充替换 ${updates.length} 个文件。`,
            `分支：${branchBefore}`,
            `commit：${commit ?? '无变化，未产生 commit'}`,
            `新 hash：sha256:${hash}`,
            'lock.md 已更新；当前仍在锁内。',
          ].join('\n'),
        }
      }

      const checkpoint = await checkpointAll(root, 'coder: checkpoint before design adjustment')
      const branch = branchArg
      await createBranch(root, branch)
      await applyUpdates(updates)
      const hash = (await hashCoder(docsRoot)).hash
      await rewriteLock(state.lock, hash)
      const commit = await commitPaths(
        root,
        [...targetPaths, LOCK_PATH],
        'coder: update design (adjustment)',
      )
      logger.info(`coder: update adjustment applied ${updates.length} files on ${branch}; commit=${commit ?? 'none'}`)
      return {
        locked: true,
        decision,
        branch,
        checkpoint,
        commit,
        hash,
        files: updates.map((item) => ({ source: item.source, target: item.target })),
        text: [
          `已按设计调整新建分支并替换 ${updates.length} 个文件。`,
          `checkpoint：${checkpoint ?? '工作区干净，无需 checkpoint'}`,
          `分支：${branch}`,
          `commit：${commit ?? '无变化，未产生 commit'}`,
          `新 hash：sha256:${hash}`,
          'lock.md 已更新；当前仍在锁内。',
        ].join('\n'),
      }
    },
  }
}
