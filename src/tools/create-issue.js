/**
 * `create_issue` 工具：在 `.coder/issues/open/` 或 `.coder/issues/close/` 下创建
 * `issue-NNNN.md`。
 *
 * 一个问题一个文件，状态由目录决定：
 *
 * - 开启：`issues/open/issue-NNNN.md`，文件以 `# 当前进度` 收尾；
 * - 关闭：`issues/close/issue-NNNN.md`，文件以 `# 关闭原因` 收尾。
 *
 * 编号取两个目录里已有问题编码的最大值加一，从 0001 开始；编码固定 4 位。
 *
 * 工具只做确定性写入：
 *
 * - `.coder` 已上锁时拒绝执行，问题文档需要通过 unlock 或 update 流程变更；
 * - 生成的内容先按 `src/issue.js` 的规则自检，自检不过不落盘；
 * - 只写一个文件，写入失败不会留下半成品。
 *
 * @module coder/tools/create-issue
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CoderError, DOCS_DIR } from '../docs.js'
import { ISSUE_CLOSE_DIR, ISSUE_OPEN_DIR, inspectIssue } from '../issue.js'
import { readLock } from '../lock.js'
import { stepScopeIssue } from '../scope.js'
import { resolveRoot } from './root.js'

/** 问题文件名。 */
const ISSUE_FILE = /^issue-(\d{4})\.md$/

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
    throw new CoderError(`${name} 不能包含 Markdown 标题行；问题格式用固定的 # 段落。`)
  }
  return text
}

/**
 * 拼出问题文件正文。
 *
 * @param {{problem: string, reproduce: string|null, suggestion: string|null, source: string, scope: string, progress: string|null, closeReason: string|null}} input - 正文内容。
 * @returns {string} Markdown 正文。
 */
function buildIssueContent({ problem, reproduce, suggestion, source, scope, progress, closeReason }) {
  const lines = ['# 问题', problem]
  if (reproduce !== null) lines.push('', '# 复现', reproduce)
  if (suggestion !== null) lines.push('', '# 建议', suggestion)
  lines.push('', '# 提交源', source)
  if (closeReason !== null) {
    lines.push('', '# 关闭原因', closeReason)
  } else {
    lines.push('', '# 当前进度', `[${scope}] 当前进度为 ${progress}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 收集已经用过的 4 位问题编码。
 *
 * @param {string} docsRoot - `.coder/` 的绝对路径。
 * @returns {Promise<Set<number>>} 已用编码。
 */
async function usedNumbers(docsRoot) {
  const used = new Set()
  for (const relative of [ISSUE_OPEN_DIR, ISSUE_CLOSE_DIR]) {
    const absolute = path.join(docsRoot, ...relative.split('/'))
    let entries = []
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = ISSUE_FILE.exec(entry.name)
      if (match !== null) used.add(Number(match[1]))
    }
  }
  return used
}

/**
 * 构造 `create_issue` 工具。
 *
 * @param {object} logger - 插件 logger。
 * @returns {object} 工具定义。
 */
export function createCreateIssueTool(logger) {
  return {
    name: 'create_issue',
    description: [
      'Create one numbered issue file under .coder/issues/open/issue-NNNN.md (status 开启) or .coder/issues/close/issue-NNNN.md (status 关闭).',
      'The number is the maximum existing issue code plus one, starting at 0001, using 4 digits; files in both folders are considered. The file contains # 问题, optional # 复现 and # 建议, # 提交源, and either # 当前进度 ([文件通配] 当前进度为 ...) for an open issue or # 关闭原因 for a closed issue. Status lives in the folder, not in the file.',
      'The generated content is validated against the issue format before writing. The tool refuses to write while .coder/lock.md exists: issue documents then change through unlock or the update flow. Nothing is committed to git.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Project root that contains the .coder/ docs directory. Defaults to the session working directory; the result always reports the absolute path that was used.',
        },
        problem: {
          type: 'string',
          description: 'The issue description, written under # 问题. Required and non-empty.',
        },
        source: {
          type: 'string',
          description: 'Where the issue came from, written under # 提交源. Required and single-line.',
        },
        status: {
          type: 'string',
          enum: ['开启', '关闭'],
          description:
            'Issue status. 开启 writes issues/open/issue-NNNN.md; 关闭 writes issues/close/issue-NNNN.md. Defaults to 开启.',
        },
        reproduce: {
          type: 'string',
          description: 'Optional reproduction steps, written under # 复现.',
        },
        suggestion: {
          type: 'string',
          description: 'Optional suggestion, written under # 建议.',
        },
        scope: {
          type: 'string',
          description:
            'File path glob used in the # 当前进度 line of an open issue, for example src/**. Defaults to **; list requires it to match at least one project file.',
        },
        progress: {
          type: 'string',
          description: 'Progress text used after「[scope] 当前进度为」in an open issue. Defaults to 已登记，等待处理。',
        },
        closeReason: {
          type: 'string',
          description: 'Close reason written under # 关闭原因 when status is 关闭. Defaults to 已关闭。',
        },
      },
      required: ['problem', 'source'],
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

      const problem = textField(args?.problem, 'problem')
      const source = textField(args?.source, 'source', { multiline: false })
      const status = args?.status === undefined ? '开启' : args.status
      if (status !== '开启' && status !== '关闭') {
        throw new CoderError('status 只能是 开启 或 关闭。')
      }
      const reproduce = textField(args?.reproduce, 'reproduce', { required: false })
      const suggestion = textField(args?.suggestion, 'suggestion', { required: false })
      const scope =
        typeof args?.scope === 'string' && args.scope.trim() !== '' ? args.scope.trim() : '**'
      const scopeProblem = stepScopeIssue(scope)
      if (scopeProblem !== null) throw new CoderError(`scope 不合法：${scopeProblem}`)
      const progress =
        status === '开启'
          ? typeof args?.progress === 'string' && args.progress.trim() !== ''
            ? textField(args.progress, 'progress', { multiline: false })
            : '已登记，等待处理。'
          : null
      const closeReason =
        status === '关闭'
          ? typeof args?.closeReason === 'string' && args.closeReason.trim() !== ''
            ? textField(args.closeReason, 'closeReason', { multiline: false })
            : '已关闭。'
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
          `${DOCS_DIR} 已上锁：create_issue 不直接写入。请先 unlock，或把问题内容经 update 流程提交。`,
        )
      }

      const used = await usedNumbers(docsRoot).catch((error) => {
        throw new CoderError(
          `无法读取 ${DOCS_DIR}/issues/：${error instanceof Error ? error.message : String(error)}`,
        )
      })
      const next = used.size === 0 ? 1 : Math.max(...used) + 1
      if (next > 9999) {
        throw new CoderError('问题编码已用尽：0001 到 9999 都已被占用。')
      }
      const code = String(next).padStart(4, '0')
      const issueDir = status === '开启' ? ISSUE_OPEN_DIR : ISSUE_CLOSE_DIR
      const kind = status === '开启' ? 'issue-open' : 'issue-close'
      const relative = `${issueDir}/issue-${code}.md`
      const issueDoc = `${DOCS_DIR}/${relative}`
      const issueAbsolute = path.join(docsRoot, ...relative.split('/'))
      const content = buildIssueContent({ problem, reproduce, suggestion, source, scope, progress, closeReason })

      const selfCheck = inspectIssue(issueDoc, content, kind, code)
      if (selfCheck.diagnostics.length > 0) {
        throw new CoderError(`生成的问题内容不符合格式：${selfCheck.diagnostics[0].message}`)
      }

      await fs.mkdir(path.dirname(issueAbsolute), { recursive: true })
      try {
        await fs.writeFile(issueAbsolute, content, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          throw new CoderError(`问题文件已经存在：${issueDoc}；请重试以取得新的编码。`)
        }
        throw new CoderError(
          `无法写入 ${issueDoc}：${error instanceof Error ? error.message : String(error)}`,
        )
      }

      logger.info(`coder: create_issue created ${issueDoc} (${status})`)
      return {
        ok: true,
        code,
        number: next,
        status,
        issue: issueDoc,
        issueDir,
        scope: status === '开启' ? scope : null,
        text: [
          `已创建${status === '开启' ? '开启' : '关闭'}的问题 ${code}。`,
          `文件：${issueDoc}`,
          status === '开启' ? `进度：[${scope}] 当前进度为 ${progress}` : `关闭原因：${closeReason}`,
          '未提交 git；需要提交时按项目流程处理。',
        ].join('\n'),
      }
    },
  }
}
