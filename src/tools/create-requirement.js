/**
 * `create_requirement` 工具：在 `.coder/requirements/<状态>/` 下创建
 * `requirement-NNNN.md`。
 *
 * 一个需求一个文件，状态由目录决定：
 *
 * - 登记：`requirements/登记/requirement-NNNN.md`；
 * - 接受-待开发：`requirements/接受-待开发/requirement-NNNN.md`；
 * - 开发中：`requirements/开发中/requirement-NNNN.md`；
 * - 本版本已完成：`requirements/本版本已完成/requirement-NNNN.md`；
 * - 历史已完成：`requirements/历史已完成/requirement-NNNN.md`；
 * - 丢弃：`requirements/丢弃/requirement-NNNN.md`。
 *
 * 编号取六个目录里已有需求编码的最大值加一，从 0001 开始；编码固定 4 位。
 * 默认写入 `登记/`。
 *
 * 工具只做确定性写入：
 *
 * - `.coder` 已上锁时拒绝执行，需求文档需要通过 unlock 或 update 流程变更；
 * - 生成的内容先按 `src/requirement.js` 的规则自检，自检不过不落盘；
 * - 只写一个文件，写入失败不会留下半成品。
 *
 * @module coder/tools/create-requirement
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CoderError, DOCS_DIR } from '../docs.js'
import { readLock } from '../lock.js'
import {
  REQUIREMENT_DIR,
  REQUIREMENT_FOLDERS,
  REQUIREMENT_STATUSES,
  inspectRequirement,
  requirementMetaOf,
} from '../requirement.js'
import { stepScopeIssue } from '../scope.js'
import { resolveRoot } from './root.js'

/** 需求文件名。 */
const REQUIREMENT_FILE = /^requirement-(\d{4})\.md$/

/** 还没结束时 `# 当前进度` 的默认说明。 */
const DEFAULT_PROGRESS = Object.freeze({
  登记: '已登记，等待处理。',
  '接受-待开发': '已接受，等待开发。',
  开发中: '正在开发。',
})

/**
 * 校验并规范化一个多行文本字段。
 *
 * @param {unknown} value - 工具参数。
 * @param {string} name - 字段名，用于错误信息。
 * @param {{required?: boolean, multiline?: boolean}} [options] - 是否必填、是否允许多行。
 * @returns {string|null} 规范化后的文本；可选字段为空时为 null。
 */
function textField(value, name, options = {}) {
  const required = options.required !== false
  const multiline = options.multiline !== false
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw new CoderError(`${name} 必须是非空字符串。`)
    return null
  }
  if (typeof value !== 'string') throw new CoderError(`${name} 必须是字符串。`)
  const text = value.trim()
  if (!multiline && /\r?\n/.test(text)) throw new CoderError(`${name} 必须是单行文本。`)
  if (text.split(/\r?\n/).some((line) => /^#{1,6}\s/.test(line.trim()))) {
    throw new CoderError(`${name} 不能包含 Markdown 标题行；需求格式用固定的 # 段落。`)
  }
  return text
}

/**
 * 校验验收标准参数。
 *
 * @param {unknown} value - 工具参数。
 * @returns {string[]} 验收标准条目。
 */
function criteriaField(value) {
  if (value === undefined || value === null) throw new CoderError('acceptance 必须是至少一条验收标准。')
  const list = Array.isArray(value) ? value : [value]
  const items = list.map((item, index) =>
    textField(item, `acceptance[${index}]`, { multiline: false }),
  )
  if (items.length === 0) throw new CoderError('acceptance 必须是至少一条验收标准。')
  return items
}

/**
 * 拼出需求文件正文。
 *
 * @param {{requirement: string, background: string|null, acceptance: string[], source: string, scope: string|null, progress: string|null, completion: string|null, discardReason: string|null}} input - 正文内容。
 * @returns {string} Markdown 正文。
 */
function buildRequirementContent({
  requirement,
  background,
  acceptance,
  source,
  scope,
  progress,
  completion,
  discardReason,
}) {
  const lines = ['# 需求', requirement]
  if (background !== null) lines.push('', '# 背景', background)
  lines.push('', '# 验收标准', '')
  for (const [index, item] of acceptance.entries()) lines.push(`${index + 1}. ${item}`)
  lines.push('', '# 提交源', source)
  if (completion !== null) {
    lines.push('', '# 完成说明', completion)
  } else if (discardReason !== null) {
    lines.push('', '# 丢弃原因', discardReason)
  } else {
    lines.push('', '# 当前进度', `[${scope}] 当前进度为 ${progress}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 收集已经用过的 4 位需求编码。
 *
 * @param {string} docsRoot - `.coder/` 的绝对路径。
 * @returns {Promise<Set<number>>} 已用编码。
 */
async function usedNumbers(docsRoot) {
  const used = new Set()
  for (const folder of REQUIREMENT_FOLDERS) {
    const absolute = path.join(docsRoot, REQUIREMENT_DIR, folder)
    let entries = []
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = REQUIREMENT_FILE.exec(entry.name)
      if (match !== null) used.add(Number(match[1]))
    }
  }
  return used
}

/**
 * 构造 `create_requirement` 工具。
 *
 * @param {object} logger - 插件 logger。
 * @returns {object} 工具定义。
 */
export function createCreateRequirementTool(logger) {
  return {
    name: 'create_requirement',
    description: [
      'Create one numbered requirement file under .coder/requirements/<状态>/requirement-NNNN.md. The status is the folder: 登记 (default), 接受-待开发, 开发中, 本版本已完成, 历史已完成, or 丢弃.',
      'The number is the maximum existing requirement code across all six status folders plus one, starting at 0001, using 4 digits. The file contains # 需求, optional # 背景, # 验收标准 (numbered items starting at 1), # 提交源, and a closing section: # 当前进度 ([文件通配] 当前进度为 ...) for 登记 / 接受-待开发 / 开发中, # 完成说明 for 本版本已完成 / 历史已完成, or # 丢弃原因 for 丢弃. Status lives in the folder, not in the file.',
      'The generated content is validated against the requirement format before writing. The tool refuses to write while .coder/lock.md exists: requirement documents then change through unlock or the update flow. Nothing is committed to git.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Project root that contains the .coder/ docs directory. Defaults to the session working directory; the result always reports the absolute path that was used.',
        },
        requirement: {
          type: 'string',
          description: 'The requirement description, written under # 需求. Required and non-empty.',
        },
        source: {
          type: 'string',
          description: 'Where the requirement came from, written under # 提交源. Required and single-line.',
        },
        status: {
          type: 'string',
          enum: REQUIREMENT_FOLDERS,
          description:
            'Requirement status folder. 登记 writes requirements/登记/, the other folders write their own. Defaults to 登记.',
        },
        background: {
          type: 'string',
          description: 'Optional background, written under # 背景.',
        },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Acceptance criteria, written under # 验收标准 as numbered items starting at 1. Required, at least one item.',
        },
        scope: {
          type: 'string',
          description:
            'File path glob used in the # 当前进度 line for 登记 / 接受-待开发 / 开发中, for example src/**. Defaults to **; list requires it to match at least one project file.',
        },
        progress: {
          type: 'string',
          description:
            'Progress text used after「[scope] 当前进度为」for 登记 / 接受-待开发 / 开发中. Defaults depend on the status.',
        },
        completion: {
          type: 'string',
          description: 'Completion note written under # 完成说明 for 本版本已完成 / 历史已完成. Defaults to 已完成。',
        },
        discardReason: {
          type: 'string',
          description: 'Discard reason written under # 丢弃原因 for 丢弃. Defaults to 已丢弃。',
        },
      },
      required: ['requirement', 'source', 'acceptance'],
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
     * @returns {Promise<object>} 创建结果。
     */
    async execute(args, context) {
      const root = resolveRoot(args, context)
      const docsRoot = path.resolve(root, DOCS_DIR)

      const rootStat = await fs.stat(root).catch(() => null)
      if (rootStat === null || !rootStat.isDirectory()) {
        throw new CoderError(`项目根目录不存在或不是目录：${root}`)
      }
      const docsStat = await fs.stat(docsRoot).catch(() => null)
      if (docsStat === null || !docsStat.isDirectory()) {
        throw new CoderError(`${DOCS_DIR}/ 不存在或不是目录：${docsRoot}`)
      }

      const requirement = textField(args?.requirement, 'requirement')
      const source = textField(args?.source, 'source', { multiline: false })
      const status = args?.status === undefined ? '登记' : args.status
      if (!REQUIREMENT_FOLDERS.includes(status)) {
        throw new CoderError(`status 只能是 ${REQUIREMENT_FOLDERS.join('、')}。`)
      }
      const background = textField(args?.background, 'background', { required: false })
      const acceptance = criteriaField(args?.acceptance)

      const phase = REQUIREMENT_STATUSES.find((item) => item.folder === status).phase
      const active = phase === 'active'
      const scope = active
        ? typeof args?.scope === 'string' && args.scope.trim() !== ''
          ? args.scope.trim()
          : '**'
        : null
      if (active) {
        const scopeProblem = stepScopeIssue(scope)
        if (scopeProblem !== null) throw new CoderError(`scope 不合法：${scopeProblem}`)
      }
      const progress = active
        ? typeof args?.progress === 'string' && args.progress.trim() !== ''
          ? textField(args.progress, 'progress', { multiline: false })
          : DEFAULT_PROGRESS[status]
        : null
      const completion =
        phase === 'done'
          ? typeof args?.completion === 'string' && args.completion.trim() !== ''
            ? textField(args.completion, 'completion', { multiline: false })
            : '已完成。'
          : null
      const discardReason =
        phase === 'discarded'
          ? typeof args?.discardReason === 'string' && args.discardReason.trim() !== ''
            ? textField(args.discardReason, 'discardReason', { multiline: false })
            : '已丢弃。'
          : null

      let lock = null
      try {
        lock = await readLock(docsRoot)
      } catch (error) {
        throw new CoderError(
          `无法读取 ${DOCS_DIR}/lock.md：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (lock !== null) {
        throw new CoderError(
          `${DOCS_DIR} 已上锁：create_requirement 不直接写入。请先 unlock，或把需求内容经 update 流程提交。`,
        )
      }

      const used = await usedNumbers(docsRoot).catch((error) => {
        throw new CoderError(
          `无法读取 ${DOCS_DIR}/${REQUIREMENT_DIR}/：${error instanceof Error ? error.message : String(error)}`,
        )
      })
      const next = used.size === 0 ? 1 : Math.max(...used) + 1
      if (next > 9999) {
        throw new CoderError('需求编码已用尽：0001 到 9999 都已被占用。')
      }
      const code = String(next).padStart(4, '0')
      const relative = `${REQUIREMENT_DIR}/${status}/requirement-${code}.md`
      const requirementDoc = `${DOCS_DIR}/${relative}`
      const absolute = path.join(docsRoot, ...relative.split('/'))
      const content = buildRequirementContent({
        requirement,
        background,
        acceptance,
        source,
        scope,
        progress,
        completion,
        discardReason,
      })

      const meta = requirementMetaOf(relative)
      const selfCheck = inspectRequirement(requirementDoc, content, meta)
      if (selfCheck.diagnostics.length > 0) {
        throw new CoderError(`生成的需求内容不符合格式：${selfCheck.diagnostics[0].message}`)
      }

      await fs.mkdir(path.dirname(absolute), { recursive: true })
      try {
        await fs.writeFile(absolute, content, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          throw new CoderError(`需求文件已经存在：${requirementDoc}；请重试以取得新的编码。`)
        }
        throw new CoderError(
          `无法写入 ${requirementDoc}：${error instanceof Error ? error.message : String(error)}`,
        )
      }

      logger.info(`coder: create_requirement created ${requirementDoc} (${status})`)
      return {
        ok: true,
        code,
        number: next,
        status,
        requirement: requirementDoc,
        requirementDir: `${REQUIREMENT_DIR}/${status}`,
        scope,
        text: [
          `已创建需求 ${code}，状态 ${status}。`,
          `文件：${requirementDoc}`,
          active
            ? `进度：[${scope}] 当前进度为 ${progress}`
            : phase === 'done'
              ? `完成说明：${completion}`
              : `丢弃原因：${discardReason}`,
          '未提交 git；需要提交时按项目流程处理。',
        ].join('\n'),
      }
    },
  }
}
