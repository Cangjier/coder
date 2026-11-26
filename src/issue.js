/**
 * `.coder/issues/` 下问题文件的解析和确定性检查。
 *
 * 一个问题一个文件，状态由所在目录决定：
 *
 *   .coder/issues/open/issue-0001.md     开启的问题
 *   .coder/issues/close/issue-0001.md    关闭的问题
 *
 * 开启的问题文件：
 *
 *   # 问题
 *   问题描述
 *   # 复现
 *   复现步骤
 *   # 建议
 *   处理建议
 *   # 提交源
 *   提交来源
 *   # 当前进度
 *   [src/**] 当前进度为 正在处理。
 *
 * 关闭的问题文件用 `# 关闭原因` 代替 `# 当前进度`：
 *
 *   # 关闭原因
 *   已修复并验证。
 *
 * 段落顺序固定为 `问题 → 复现 → 建议 → 提交源 → 当前进度 / 关闭原因`；
 * `# 问题`、`# 提交源` 与最后一个段落必填，`# 复现` 与 `# 建议` 可选，
 * 标题也可以写成 `# 复现（可选）`、`# 建议（可选）`。状态不写进文件：
 * 所在文件夹就是状态，出现 `# 状态` 会报错。
 *
 * 开启的问题在 `# 当前进度` 下只写一行 `[文件路径通配] 当前进度为 ...`；
 * 关闭的问题在 `# 关闭原因` 下写至少一行非空原因。
 *
 * 三个目录都是可选的：`list` 只在文件存在时检查内容格式，没有文件不报缺失。
 * 编码固定 4 位数字；同一个编码不能同时出现在 open/ 与 close/。
 *
 * @module coder/issue
 */

import { analyzeMarkdown } from './markdown.js'
import { scopeMatches, stepScopeIssue } from './scope.js'

/** 开启的问题目录，相对于 `.coder/`。 */
export const ISSUE_OPEN_DIR = 'issues/open'

/** 关闭的问题目录，相对于 `.coder/`。 */
export const ISSUE_CLOSE_DIR = 'issues/close'

/** 问题文件：`issues/open/issue-NNNN.md` 或 `issues/close/issue-NNNN.md`。 */
export const ISSUE_FILE_PATTERN = /^issues\/(open|close)\/issue-(\d{4})\.md$/

/** 问题编码：固定 4 位数字。 */
const ISSUE_CODE_PATTERN = /^\d{4}$/

/** 进度行：`[文件路径通配] 当前进度为 ...`。 */
const PROGRESS_PATTERN = /^\[([^\]\r\n]+)\]\s*当前进度为\s*(.+?)\s*$/

/** 每种问题文件允许的段落，按固定顺序。 */
const SECTION_ORDER = Object.freeze({
  'issue-open': Object.freeze(['问题', '复现', '建议', '提交源', '当前进度']),
  'issue-close': Object.freeze(['问题', '复现', '建议', '提交源', '关闭原因']),
})

/** 每种问题文件必须出现的段落。 */
const REQUIRED_SECTIONS = Object.freeze({
  'issue-open': Object.freeze(['问题', '提交源', '当前进度']),
  'issue-close': Object.freeze(['问题', '提交源', '关闭原因']),
})

/**
 * 构造一条诊断。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {number} line - 1-based 行号。
 * @param {string} rule - 稳定规则代码。
 * @param {string} message - 给人看的原因。
 * @returns {{doc: string, line: number, rule: string, severity: 'error', message: string}} 诊断。
 */
function diagnostic(doc, line, rule, message) {
  return { doc, line, rule, severity: 'error', message }
}

/**
 * 根据 `.coder/` 相对路径判断问题文档类型。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {'issue-open'|'issue-close'|null} 文档类型；不是问题文件时为 null。
 */
export function issueKindOf(relative) {
  const match = /^issues\/(open|close)\/issue-\d{4}\.md$/.exec(relative)
  if (match === null) return null
  return match[1] === 'open' ? 'issue-open' : 'issue-close'
}

/**
 * 判断一个相对路径是否是问题文件。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {boolean} 是否是问题文件。
 */
export function isIssueDoc(relative) {
  return issueKindOf(relative) !== null
}

/**
 * 从问题文件路径里取 4 位编码。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {string|null} 编码；不是问题文件时为 null。
 */
export function issueNumber(relative) {
  const match = ISSUE_FILE_PATTERN.exec(relative)
  return match === null ? null : match[2]
}

/**
 * 去掉 `（可选）` / `(可选)` 后缀，得到规范的一级标题名。
 *
 * @param {string} text - 标题文本。
 * @returns {string} 规范标题名。
 */
function sectionName(text) {
  return text.trim().replace(/\s*[（(]\s*可选\s*[）)]\s*$/, '').trim()
}

/**
 * 取一个标题的直属正文：直到下一个任意级别的标题之前。
 *
 * @param {string[]} lines - 文档全部行。
 * @param {{line: number}} heading - 当前标题。
 * @param {{line: number}[]} headings - 全部标题。
 * @param {number} index - 当前标题下标。
 * @param {boolean[]} masked - 围栏内的行。
 * @returns {{text: string, line: number}[]} 非空、非围栏正文行。
 */
function bodyLines(lines, heading, headings, index, masked) {
  const nextLine = index + 1 < headings.length ? headings[index + 1].line : lines.length + 1
  const body = []
  for (let line = heading.line + 1; line < nextLine; line += 1) {
    if (lines[line - 1].trim() !== '' && !masked[line - 1]) body.push({ text: lines[line - 1], line })
  }
  return body
}

/**
 * 检查第一个标题之前不能有正文。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
function preambleDiagnostics(doc, analysis) {
  const firstLine = analysis.headings.length === 0 ? analysis.lines.length + 1 : analysis.headings[0].line
  for (let line = 1; line < firstLine; line += 1) {
    if (analysis.lines[line - 1].trim() !== '' && !analysis.masked[line - 1]) {
      return [diagnostic(doc, line, 'issue.preamble', '第一个标题之前不能有正文；问题文件从标题开始。')]
    }
  }
  return []
}

/**
 * 检查一个问题文件的内容格式。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {'issue-open'|'issue-close'} kind - 文档类型。
 * @param {string} code - 文件名给出的 4 位编码。
 * @param {string[]} [files] - 项目文件；开启的问题用它检查进度通配是否命中。
 * @returns {{diagnostics: object[], entry: object}} 诊断与问题条目。
 */
export function inspectIssue(doc, text, kind, code, files) {
  const diagnostics = []
  const status = kind === 'issue-open' ? '开启' : '关闭'
  const order = SECTION_ORDER[kind]
  const entry = {
    doc,
    line: 1,
    code,
    status,
    progress: null,
    reason: null,
  }

  if (!ISSUE_CODE_PATTERN.test(code)) {
    diagnostics.push(
      diagnostic(doc, 1, 'issue.code.format', `问题编码必须是 4 位数字，例如 0001；收到：${code}`),
    )
  }

  if (text.trim() === '') {
    diagnostics.push(
      diagnostic(
        doc,
        1,
        'issue.empty',
        `问题文件是空的；每个问题一个文件，写 # 问题、# 提交源 与 ${kind === 'issue-open' ? '# 当前进度' : '# 关闭原因'}。`,
      ),
    )
    return { diagnostics, entry }
  }

  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }

  const { lines, headings, masked } = analysis
  if (!headings.some((heading) => heading.level === 1)) {
    diagnostics.push(diagnostic(doc, 1, 'issue.section.missing', '缺少 # 问题 与 # 提交源。'))
    return { diagnostics, entry }
  }

  diagnostics.push(...preambleDiagnostics(doc, analysis))

  const seen = new Map()
  let lastOrder = -1

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.heading.level', '问题文件只用 # 写问题段落。'),
      )
      continue
    }

    const name = sectionName(heading.text)
    if (name === '状态') {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'issue.status.removed',
          '状态由所在文件夹决定：开启的问题放 issues/open/，关闭的问题放 issues/close/；问题文件里不写 # 状态。',
        ),
      )
      continue
    }
    const position = order.indexOf(name)
    if (position === -1) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'issue.section.unknown',
          `未知的问题段落：${name}；只允许 ${order.join(' / ')}。`,
        ),
      )
      continue
    }
    if (seen.has(name)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.section.duplicate', `问题段落重复：${name}（第一次出现在第 ${seen.get(name)} 行）。`),
      )
    } else {
      seen.set(name, heading.line)
    }
    if (position < lastOrder) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.section.order', `问题段落的顺序必须是：${order.join(' → ')}。`),
      )
    }
    lastOrder = Math.max(lastOrder, position)

    const body = bodyLines(lines, heading, headings, index, masked)
    if (body.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'issue.section.empty', `${name} 后面至少需要一行正文。`))
      continue
    }

    if (name === '当前进度') {
      if (body.length > 1) {
        diagnostics.push(diagnostic(doc, body[1].line, 'issue.progress.lines', '当前进度只写一行「[文件路径通配] 当前进度为 ...」。'))
      }
      const progress = PROGRESS_PATTERN.exec(body[0].text.trim())
      if (progress === null) {
        diagnostics.push(
          diagnostic(
            doc,
            body[0].line,
            'issue.progress.format',
            '当前进度必须写成「[文件路径通配] 当前进度为 ...」。',
          ),
        )
      } else {
        const scope = progress[1].trim()
        const issue = stepScopeIssue(scope)
        let matches = null
        if (issue !== null) {
          diagnostics.push(diagnostic(doc, body[0].line, 'issue.progress.glob', issue))
        } else if (files !== undefined) {
          matches = files.filter((file) => scopeMatches(scope, file)).length
          if (matches === 0) {
            diagnostics.push(
              diagnostic(doc, body[0].line, 'issue.progress.no-match', `当前进度的文件通配 ${scope} 没有命中任何项目文件。`),
            )
          }
        }
        entry.progress = {
          line: body[0].line,
          scope: issue === null ? scope : null,
          text: progress[2],
          matches,
        }
      }
    } else if (name === '关闭原因') {
      entry.reason = body.map((line) => line.text.trim()).join(' ')
    }
  }

  for (const required of REQUIRED_SECTIONS[kind]) {
    if (!seen.has(required)) {
      diagnostics.push(diagnostic(doc, 1, 'issue.section.missing', `缺少问题段落：${required}。`))
    }
  }

  return { diagnostics, entry }
}

/**
 * 按文档类型检查一个问题文件。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {'issue-open'|'issue-close'} kind - 文档类型。
 * @param {string} code - 文件名给出的 4 位编码。
 * @param {string[]} [files] - 项目文件；开启的问题用它检查进度通配是否命中。
 * @returns {object[]} 诊断。
 */
export function validateIssue(doc, text, kind, code, files) {
  return inspectIssue(doc, text, kind, code, files).diagnostics
}
