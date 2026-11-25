/**
 * `.coder/issues/` 下问题文档的解析和确定性检查。
 *
 * 问题详情放在 `issues/all/issue-NNNN.md`：
 *
 *   # 问题
 *   问题描述
 *   # 状态
 *   开启
 *   # 复现
 *   复现步骤
 *   # 建议
 *   处理建议
 *   # 提交源
 *   提交来源
 *
 * `# 问题`、`# 状态`、`# 提交源` 必填；`# 复现` 与 `# 建议` 可选，标题也
 * 可以写成 `# 复现（可选）`、`# 建议（可选）`。状态只能是 `开启` 或 `关闭`。
 *
 * 进度索引放在 `issues/open.md`，每条是一级标题编码加一行进度：
 *
 *   # 0001
 *   [src/**] 当前进度为 正在处理。
 *
 * 关闭索引放在 `issues/close.md`，每条是一级标题编码加关闭原因：
 *
 *   # 0001
 *   已修复并验证。
 *
 * 三个文件都是可选的：`list` 只在文件存在时检查内容格式，文件不存在不报缺失。
 * 编码固定 4 位数字；同一份索引里编码不能重复，同一个编码不能同时出现在
 * open.md 与 close.md。开启的问题只应出现在 open.md，关闭的问题只应出现在
 * close.md；索引引用的编码必须在 `issues/all/` 下有对应文件。
 *
 * @module coder/issue
 */

import { analyzeMarkdown } from './markdown.js'
import { scopeMatches, stepScopeIssue } from './scope.js'

/** 进度索引，相对于 `.coder/`。 */
export const ISSUE_OPEN = 'issues/open.md'

/** 关闭索引，相对于 `.coder/`。 */
export const ISSUE_CLOSE = 'issues/close.md'

/** 问题详情目录，相对于 `.coder/`。 */
export const ISSUE_ALL_DIR = 'issues/all'

/** 问题详情文件：`issues/all/issue-NNNN.md`。 */
export const ISSUE_FILE_PATTERN = /^issues\/all\/issue-(\d{4})\.md$/

/** 问题编码：固定 4 位数字。 */
const ISSUE_CODE_PATTERN = /^\d{4}$/

/** 进度行：`[文件路径通配] 当前进度为 ...`。 */
const PROGRESS_PATTERN = /^\[([^\]\r\n]+)\]\s*当前进度为\s*(.+?)\s*$/

/** 问题详情里允许的一级标题，按固定顺序。 */
const SECTION_ORDER = Object.freeze(['问题', '状态', '复现', '建议', '提交源'])

/** 问题详情里必填的一级标题。 */
const REQUIRED_SECTIONS = Object.freeze(['问题', '状态', '提交源'])

/** 状态只允许这两种。 */
const STATUS_VALUES = new Set(['开启', '关闭'])

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
 * @returns {'issue-all'|'issue-open'|'issue-close'|null} 文档类型；不是问题文档时为 null。
 */
export function issueKindOf(relative) {
  if (relative === ISSUE_OPEN) return 'issue-open'
  if (relative === ISSUE_CLOSE) return 'issue-close'
  if (ISSUE_FILE_PATTERN.test(relative)) return 'issue-all'
  return null
}

/**
 * 判断一个相对路径是否是问题文档。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {boolean} 是否是问题文档。
 */
export function isIssueDoc(relative) {
  return issueKindOf(relative) !== null
}

/**
 * 从问题详情路径里取 4 位编码。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {string|null} 编码；不是问题详情文件时为 null。
 */
export function issueNumber(relative) {
  const match = ISSUE_FILE_PATTERN.exec(relative)
  return match === null ? null : match[1]
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
      return [diagnostic(doc, line, 'issue.preamble', '第一个标题之前不能有正文；问题文档从标题开始。')]
    }
  }
  return []
}

/**
 * 检查 `issues/all/issue-NNNN.md` 的内容格式。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @returns {{diagnostics: object[], status: string|null}} 诊断与解析出的状态。
 */
export function inspectIssueAll(doc, text) {
  const diagnostics = []
  let status = null

  if (text.trim() === '') {
    diagnostics.push(diagnostic(doc, 1, 'issue.empty', '问题文档是空的。'))
    return { diagnostics, status }
  }

  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }

  const { lines, headings, masked } = analysis
  if (!headings.some((heading) => heading.level === 1)) {
    diagnostics.push(diagnostic(doc, 1, 'issue.section.missing', '缺少 # 问题、# 状态 与 # 提交源。'))
    return { diagnostics, status }
  }

  diagnostics.push(...preambleDiagnostics(doc, analysis))

  const seen = new Map()
  let lastOrder = -1

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.heading.level', '问题文档只用 # 写 问题 / 状态 / 复现 / 建议 / 提交源。'),
      )
      continue
    }

    const name = sectionName(heading.text)
    const order = SECTION_ORDER.indexOf(name)
    if (order === -1) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'issue.section.unknown',
          `未知的问题段落：${name}；只允许 ${SECTION_ORDER.join(' / ')}。`,
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
    if (order < lastOrder) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.section.order', `问题段落的顺序必须是：${SECTION_ORDER.join(' → ')}。`),
      )
    }
    lastOrder = Math.max(lastOrder, order)

    const body = bodyLines(lines, heading, headings, index, masked)
    if (body.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'issue.section.empty', `${name} 后面至少需要一行正文。`))
      continue
    }
    if (name === '状态') {
      const value = body[0].text.trim()
      if (STATUS_VALUES.has(value)) status = value
      else diagnostics.push(diagnostic(doc, body[0].line, 'issue.status.value', '状态只能是 开启 或 关闭。'))
    }
  }

  for (const required of REQUIRED_SECTIONS) {
    if (!seen.has(required)) {
      diagnostics.push(diagnostic(doc, 1, 'issue.section.missing', `缺少问题段落：${required}。`))
    }
  }

  return { diagnostics, status }
}

/**
 * 检查 `issues/open.md` 的内容格式。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {string[]} [files] - 项目文件；给出时检查进度通配是否命中。
 * @returns {{diagnostics: object[], entries: object[]}} 诊断与进度条目。
 */
export function inspectIssueOpen(doc, text, files) {
  const diagnostics = []
  const entries = []

  if (text.trim() === '') return { diagnostics, entries }

  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }

  const { lines, headings, masked } = analysis
  diagnostics.push(...preambleDiagnostics(doc, analysis))

  const seen = new Set()

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.heading.level', '进度索引只用 # 写 4 位问题编码。'),
      )
      continue
    }

    const code = heading.text.trim()
    if (!ISSUE_CODE_PATTERN.test(code)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.code.format', `问题编码必须是 4 位数字，例如 0001；收到：${code}`),
      )
      continue
    }
    if (seen.has(code)) {
      diagnostics.push(diagnostic(doc, heading.line, 'issue.code.duplicate', `问题编码重复：${code}`))
      continue
    }
    seen.add(code)

    const body = bodyLines(lines, heading, headings, index, masked)
    if (body.length === 0) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.progress.missing', `${code} 后面需要一行「[文件路径通配] 当前进度为 ...」。`),
      )
      continue
    }
    if (body.length > 1) {
      diagnostics.push(diagnostic(doc, body[1].line, 'issue.body', '每个问题编码只写一行当前进度。'))
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
      entries.push({ doc, line: heading.line, code, scope: null, text: null, matches: null })
      continue
    }

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
    entries.push({ doc, line: heading.line, code, scope: issue === null ? scope : null, text: progress[2], matches })
  }

  return { diagnostics, entries }
}

/**
 * 检查 `issues/close.md` 的内容格式。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @returns {{diagnostics: object[], entries: object[]}} 诊断与关闭条目。
 */
export function inspectIssueClose(doc, text) {
  const diagnostics = []
  const entries = []

  if (text.trim() === '') return { diagnostics, entries }

  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }

  const { lines, headings, masked } = analysis
  diagnostics.push(...preambleDiagnostics(doc, analysis))

  const seen = new Set()

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.heading.level', '关闭索引只用 # 写 4 位问题编码。'),
      )
      continue
    }

    const code = heading.text.trim()
    if (!ISSUE_CODE_PATTERN.test(code)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'issue.code.format', `问题编码必须是 4 位数字，例如 0001；收到：${code}`),
      )
      continue
    }
    if (seen.has(code)) {
      diagnostics.push(diagnostic(doc, heading.line, 'issue.code.duplicate', `问题编码重复：${code}`))
      continue
    }
    seen.add(code)

    const body = bodyLines(lines, heading, headings, index, masked)
    if (body.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'issue.reason.missing', `${code} 后面需要关闭原因。`))
      continue
    }
    entries.push({
      doc,
      line: heading.line,
      code,
      reason: body.map((line) => line.text.trim()).join(' '),
    })
  }

  return { diagnostics, entries }
}

/**
 * 按文档类型检查一个问题文档。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {'issue-all'|'issue-open'|'issue-close'} kind - 文档类型。
 * @param {string[]} [files] - 项目文件；进度索引用它检查通配命中。
 * @returns {object[]} 诊断。
 */
export function validateIssue(doc, text, kind, files) {
  if (kind === 'issue-open') return inspectIssueOpen(doc, text, files).diagnostics
  if (kind === 'issue-close') return inspectIssueClose(doc, text).diagnostics
  return inspectIssueAll(doc, text).diagnostics
}
