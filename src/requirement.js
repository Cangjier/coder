/**
 * `.coder/requirements/` 下需求文件的解析和确定性检查。
 *
 * 一个需求一个文件，状态由所在目录决定：
 *
 *   .coder/requirements/登记/requirement-0001.md            已登记，等待接受
 *   .coder/requirements/接受-待开发/requirement-0001.md     已接受，等待开发
 *   .coder/requirements/开发中/requirement-0001.md          开发中
 *   .coder/requirements/本版本已完成/requirement-0001.md    本版本已完成
 *   .coder/requirements/历史已完成/requirement-0001.md      历史版本已完成
 *   .coder/requirements/丢弃/requirement-0001.md            已丢弃
 *
 * 还没结束的需求文件：
 *
 *   # 需求
 *   需求描述
 *   # 背景
 *   为什么需要
 *   # 验收标准
 *   1. 第一条验收标准。
 *   2. 第二条验收标准。
 *   # 提交源
 *   用户
 *   # 当前进度
 *   [src/**] 当前进度为 已登记。
 *
 * 完成的需求用 `# 完成说明` 代替 `# 当前进度`，丢弃的需求用 `# 丢弃原因`：
 *
 *   # 完成说明
 *   已实现并验证。
 *
 * 段落顺序固定为 `需求 → 背景 → 验收标准 → 提交源 → 当前进度 / 完成说明 / 丢弃原因`：
 * `# 需求`、`# 验收标准`、`# 提交源` 与最后一个段落必填，`# 背景` 可选，标题也可以
 * 写成 `# 背景（可选）`。状态不写进文件：所在文件夹就是状态，出现 `# 状态` 会报错。
 *
 * 验收标准至少一条编号条目，从 `1.` 开始连续；还没结束的需求在 `# 当前进度`
 * 下只写一行 `[文件路径通配] 当前进度为 ...`。
 *
 * 六个目录都是可选的：`list` 只在文件存在时检查内容格式，没有文件不报缺失。
 * 编码固定 4 位数字；同一个编码不能同时出现在两个状态目录里。
 *
 * @module coder/requirement
 */

import { analyzeMarkdown } from './markdown.js'
import { scopeMatches, stepScopeIssue } from './scope.js'

/** 需求根目录，相对于 `.coder/`。 */
export const REQUIREMENT_DIR = 'requirements'

/** 六个状态目录，按工作流顺序排列。 */
export const REQUIREMENT_STATUSES = Object.freeze([
  Object.freeze({ folder: '登记', key: 'registered', phase: 'active' }),
  Object.freeze({ folder: '接受-待开发', key: 'accepted', phase: 'active' }),
  Object.freeze({ folder: '开发中', key: 'developing', phase: 'active' }),
  Object.freeze({ folder: '本版本已完成', key: 'current', phase: 'done' }),
  Object.freeze({ folder: '历史已完成', key: 'history', phase: 'done' }),
  Object.freeze({ folder: '丢弃', key: 'discarded', phase: 'discarded' }),
])

/** 状态目录名，按工作流顺序。 */
export const REQUIREMENT_FOLDERS = Object.freeze(REQUIREMENT_STATUSES.map((status) => status.folder))

/** 需求文件：`requirements/<状态>/requirement-NNNN.md`。 */
export const REQUIREMENT_FILE_PATTERN =
  /^requirements\/(登记|接受-待开发|开发中|本版本已完成|历史已完成|丢弃)\/requirement-(\d{4})\.md$/

/** 进度行：`[文件路径通配] 当前进度为 ...`。 */
const PROGRESS_PATTERN = /^\[([^\]\r\n]+)\]\s*当前进度为\s*(.+?)\s*$/

/** 验收标准条目：`1. ...`。 */
const CRITERIA_PATTERN = /^(\d+)\.\s+(\S.*)$/

/** 每种状态允许的段落，按固定顺序。 */
const SECTION_ORDER = Object.freeze({
  active: Object.freeze(['需求', '背景', '验收标准', '提交源', '当前进度']),
  done: Object.freeze(['需求', '背景', '验收标准', '提交源', '完成说明']),
  discarded: Object.freeze(['需求', '背景', '验收标准', '提交源', '丢弃原因']),
})

/** 每种状态必须出现的段落。 */
const REQUIRED_SECTIONS = Object.freeze({
  active: Object.freeze(['需求', '验收标准', '提交源', '当前进度']),
  done: Object.freeze(['需求', '验收标准', '提交源', '完成说明']),
  discarded: Object.freeze(['需求', '验收标准', '提交源', '丢弃原因']),
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
 * 根据 `.coder/` 相对路径取需求元信息。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {{folder: string, key: string, phase: 'active'|'done'|'discarded', code: string}|null} 元信息；不是需求文件时为 null。
 */
export function requirementMetaOf(relative) {
  const match = REQUIREMENT_FILE_PATTERN.exec(relative)
  if (match === null) return null
  const status = REQUIREMENT_STATUSES.find((item) => item.folder === match[1])
  if (status === undefined) return null
  return { folder: status.folder, key: status.key, phase: status.phase, code: match[2] }
}

/**
 * 判断一个相对路径是否是需求文件。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {boolean} 是否是需求文件。
 */
export function isRequirementDoc(relative) {
  return requirementMetaOf(relative) !== null
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
      return [diagnostic(doc, line, 'requirement.preamble', '第一个标题之前不能有正文；需求文件从标题开始。')]
    }
  }
  return []
}

/**
 * 检查一个需求文件的内容格式。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {{folder: string, key: string, phase: 'active'|'done'|'discarded', code: string}} meta - 文件名给出的状态与编码。
 * @param {string[]} [files] - 项目文件；还没结束的需求用它检查进度通配是否命中。
 * @returns {{diagnostics: object[], entry: object}} 诊断与需求条目。
 */
export function inspectRequirement(doc, text, meta, files) {
  const diagnostics = []
  const order = SECTION_ORDER[meta.phase]
  const entry = {
    doc,
    line: 1,
    code: meta.code,
    status: meta.folder,
    folder: meta.folder,
    key: meta.key,
    criteria: 0,
    progress: null,
    conclusion: null,
  }

  if (!/^\d{4}$/.test(meta.code)) {
    diagnostics.push(
      diagnostic(doc, 1, 'requirement.code.format', `需求编码必须是 4 位数字，例如 0001；收到：${meta.code}`),
    )
  }

  if (text.trim() === '') {
    diagnostics.push(
      diagnostic(doc, 1, 'requirement.empty', '需求文件是空的；写 # 需求、# 验收标准、# 提交源 与结尾段落。'),
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
    diagnostics.push(diagnostic(doc, 1, 'requirement.section.missing', '缺少 # 需求 与 # 提交源。'))
    return { diagnostics, entry }
  }

  diagnostics.push(...preambleDiagnostics(doc, analysis))

  const seen = new Map()
  let lastOrder = -1
  let criteriaItems = 0

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'requirement.heading.level', '需求文件只用 # 写需求段落。'),
      )
      continue
    }

    const name = sectionName(heading.text)
    if (name === '状态') {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'requirement.status.removed',
          '状态由所在文件夹决定：登记、接受-待开发、开发中、本版本已完成、历史已完成、丢弃；需求文件里不写 # 状态。',
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
          'requirement.section.unknown',
          `未知的需求段落：${name}；只允许 ${order.join(' / ')}。`,
        ),
      )
      continue
    }
    if (seen.has(name)) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'requirement.section.duplicate',
          `需求段落重复：${name}（第一次出现在第 ${seen.get(name)} 行）。`,
        ),
      )
    } else {
      seen.set(name, heading.line)
    }
    if (position < lastOrder) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'requirement.section.order', `需求段落的顺序必须是：${order.join(' → ')}。`),
      )
    }
    lastOrder = Math.max(lastOrder, position)

    const body = bodyLines(lines, heading, headings, index, masked)
    if (body.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'requirement.section.empty', `${name} 后面至少需要一行正文。`))
      continue
    }

    if (name === '验收标准') {
      let count = 0
      for (const line of body) {
        const item = CRITERIA_PATTERN.exec(line.text.trim())
        if (item === null) {
          diagnostics.push(
            diagnostic(doc, line.line, 'requirement.criteria.format', '验收标准必须写成 `N. 内容` 的编号条目。'),
          )
          continue
        }
        count += 1
        const number = Number(item[1])
        if (number !== count) {
          diagnostics.push(
            diagnostic(
              doc,
              line.line,
              'requirement.criteria.number',
              `验收标准编号必须连续：下一个应为 ${count}.，收到 ${number}.。`,
            ),
          )
        }
        criteriaItems += 1
      }
      if (count === 0) {
        diagnostics.push(
          diagnostic(doc, body[0].line, 'requirement.criteria.empty', '验收标准至少需要一个编号条目。'),
        )
      }
    } else if (name === '当前进度') {
      if (body.length > 1) {
        diagnostics.push(
          diagnostic(doc, body[1].line, 'requirement.progress.lines', '当前进度只写一行「[文件路径通配] 当前进度为 ...」。'),
        )
      }
      const progress = PROGRESS_PATTERN.exec(body[0].text.trim())
      if (progress === null) {
        diagnostics.push(
          diagnostic(
            doc,
            body[0].line,
            'requirement.progress.format',
            '当前进度必须写成「[文件路径通配] 当前进度为 ...」。',
          ),
        )
      } else {
        const scope = progress[1].trim()
        const issue = stepScopeIssue(scope)
        let matches = null
        if (issue !== null) {
          diagnostics.push(diagnostic(doc, body[0].line, 'requirement.progress.glob', issue))
        } else if (files !== undefined) {
          matches = files.filter((file) => scopeMatches(scope, file)).length
          if (matches === 0) {
            diagnostics.push(
              diagnostic(doc, body[0].line, 'requirement.progress.no-match', `当前进度的文件通配 ${scope} 没有命中任何项目文件。`),
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
    } else if (name === '完成说明' || name === '丢弃原因') {
      entry.conclusion = body.map((line) => line.text.trim()).join(' ')
    }
  }

  for (const required of REQUIRED_SECTIONS[meta.phase]) {
    if (!seen.has(required)) {
      diagnostics.push(diagnostic(doc, 1, 'requirement.section.missing', `缺少需求段落：${required}。`))
    }
  }

  entry.criteria = criteriaItems
  return { diagnostics, entry }
}

/**
 * 只返回需求文件的问题，便于单独测试。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {{folder: string, key: string, phase: 'active'|'done'|'discarded', code: string}} meta - 文件名给出的状态与编码。
 * @param {string[]} [files] - 项目文件；还没结束的需求用它检查进度通配是否命中。
 * @returns {object[]} 诊断。
 */
export function validateRequirement(doc, text, meta, files) {
  return inspectRequirement(doc, text, meta, files).diagnostics
}
