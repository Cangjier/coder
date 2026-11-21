/**
 * `lock` / `unlock` 工具。
 *
 * 锁是 `.coder/lock.md` 这份状态文件：`lock` 写入当前 hash 和授权原文，
 * `unlock` 删除它。锁不拦截任何文件操作，只告诉 dsh 上锁期间修改 `.coder`
 * 必须走 `update`；真正发现直接修改的是 `list` 与 `update` 的 hash 比对。
 *
 * @module coder/tools/lock
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CoderError, DOCS_DIR } from '../docs.js'
import { createLock, hashCoder, readLock, removeLock } from '../lock.js'
import { resolveRoot } from './root.js'

/**
 * 校验授权原文。
 *
 * @param {unknown} value - 工具参数值。
 * @returns {string} 原文。
 * @throws {CoderError} 缺失或为空时。
 */
function authorizationOf(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CoderError('authorization 必须是用户授权原文，且不能为空。')
  }
  return value
}

/**
 * 构造 `lock` 工具。
 *
 * @param {object} logger - 插件 logger。
 * @returns {object} 工具定义。
 */
export function createLockTool(logger) {
  return {
    name: 'lock',
    description: [
      'Lock the project .coder/ documentation tree.',
      'The authorization argument is the original user authorization text and is stored verbatim from line 3 of .coder/lock.md. Line 1 is a fixed declaration, line 2 is sha256 of every .coder file except lock.md (per-file content hashes concatenated, then hashed), and line 3 starts the authorization.',
      'While locked, design changes must go through the update tool; direct edits are detected by list and update through the lock hash. The lock is a soft constraint and does not block file system or bash writes. Use unlock to remove it.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Project root that contains the .coder/ docs directory. Defaults to the session working directory.',
        },
        authorization: {
          type: 'string',
          description: 'Original user authorization text. Stored verbatim from line 3 of .coder/lock.md.',
        },
      },
      required: ['authorization'],
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
     * @param {{root?: string, authorization?: string}} args - 工具参数。
     * @param {object} context - 工具执行上下文。
     * @returns {Promise<object>} 上锁结果。
     */
    async execute(args, context) {
      const root = resolveRoot(args, context)
      const authorization = authorizationOf(args?.authorization)
      const docsRoot = path.resolve(root, DOCS_DIR)

      const stat = await fs.stat(docsRoot).catch(() => null)
      if (stat === null || !stat.isDirectory()) {
        throw new CoderError(`${DOCS_DIR}/ 不存在或不是目录：${docsRoot}`)
      }

      let result
      try {
        result = await hashCoder(docsRoot)
      } catch (error) {
        throw new CoderError(
          `无法计算 ${DOCS_DIR}/ 的 hash：${error instanceof Error ? error.message : String(error)}`,
        )
      }

      let absolute
      try {
        absolute = await createLock(docsRoot, result.hash, authorization)
      } catch (error) {
        if (error && error.code === 'EEXIST') throw new CoderError('已经上锁：.coder/lock.md 已存在。')
        throw new CoderError(
          `无法写入 ${DOCS_DIR}/lock.md：${error instanceof Error ? error.message : String(error)}`,
        )
      }

      logger.info(`coder: locked ${absolute} (${result.files.length} files, ${result.hash.slice(0, 12)}…)`)
      return {
        locked: true,
        path: absolute,
        hash: result.hash,
        files: result.files,
        text: [
          '已上锁。',
          `锁文件：${absolute}`,
          `hash：sha256:${result.hash}`,
          `参与 hash 的文件：${result.files.length} 个`,
          '上锁期间修改 .coder 必须走 update；list 和 update 会用 hash 检查是否被直接修改。',
        ].join('\n'),
      }
    },
  }
}

/**
 * 构造 `unlock` 工具。
 *
 * @param {object} logger - 插件 logger。
 * @returns {object} 工具定义。
 */
export function createUnlockTool(logger) {
  return {
    name: 'unlock',
    description: [
      'Unlock the project .coder/ documentation tree by removing .coder/lock.md.',
      'The authorization argument must match the authorization text stored in lock.md. Unlock does not require the lock hash to match: a hash mismatch is reported in the result so the change can be investigated, but unlocking is still allowed.',
      'After unlock, direct edits to .coder are allowed again until the next lock.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Project root that contains the .coder/ docs directory. Defaults to the session working directory.',
        },
        authorization: {
          type: 'string',
          description: 'Original user authorization text; must match the text stored in .coder/lock.md.',
        },
      },
      required: ['authorization'],
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
     * @param {{root?: string, authorization?: string}} args - 工具参数。
     * @param {object} context - 工具执行上下文。
     * @returns {Promise<object>} 解锁结果。
     */
    async execute(args, context) {
      const root = resolveRoot(args, context)
      const authorization = authorizationOf(args?.authorization)
      const docsRoot = path.resolve(root, DOCS_DIR)

      let lock
      try {
        lock = await readLock(docsRoot)
      } catch (error) {
        throw new CoderError(
          `无法读取 ${DOCS_DIR}/lock.md：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (lock === null) throw new CoderError('当前没有上锁：.coder/lock.md 不存在。')
      if (lock.authorization !== authorization) {
        throw new CoderError('authorization 与 .coder/lock.md 中保存的授权原文不一致，未解锁。')
      }

      let hashMatches = null
      if (lock.hashValid) {
        try {
          hashMatches = (await hashCoder(docsRoot)).hash === lock.hash
        } catch {
          hashMatches = null
        }
      }

      try {
        await removeLock(docsRoot)
      } catch (error) {
        throw new CoderError(
          `无法删除 ${DOCS_DIR}/lock.md：${error instanceof Error ? error.message : String(error)}`,
        )
      }

      logger.info(`coder: unlocked ${docsRoot} (hashMatches=${String(hashMatches)})`)
      const lines = ['已解锁。']
      if (hashMatches === false) {
        lines.push('注意：解锁前 .coder 的 hash 与 lock.md 记录不一致；上锁期间有文件被直接修改，请自查。')
      } else if (hashMatches === null) {
        lines.push('注意：无法比对解锁前的 hash；请确认上锁期间 .coder 没有被直接修改。')
      }
      lines.push('现在可以自由修改 .coder；需要重新约束时再调用 lock。')
      return {
        locked: false,
        path: path.join(docsRoot, 'lock.md'),
        hashMatches,
        text: lines.join('\n'),
      }
    },
  }
}
