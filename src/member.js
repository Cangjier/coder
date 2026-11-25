/**
 * `.coder/members/all.md` 与 `.coder/members/flow.md` 的解析和检查。
 *
 * 成员名册 `all.md` 用一级标题分节，记录主对话与每个成员的身份和工作范围：
 *
 *   # 主对话
 *   身份：开发
 *   工作范围：插件设计与实现
 *
 *   # 成员1
 *   工作区名称：coder
 *   身份：验证
 *   工作范围：部署后的只读验证
 *
 * `# 主对话` 必须存在且是第一个一级标题；其余一级标题写成 `# 成员N`，
 * N 是正整数，同一份文档里不能重复。成员可以为零：只有 `# 主对话` 也是
 * 合法状态。字段按固定顺序出现，值不能为空；一节的正文只放字段行，不写其他内容。
 *
 * 成员流程 `flow.md` 沿用 `design/flow.md` 的规则：用 `## <场景>` 分段，
 * 每个场景至少一段非空说明和一张非空的 `mermaid` 图。
 *
 * 两个文件都是可选的：`list` 只在文件存在时检查内容格式，文件不存在不报缺失。
 *
 * @module coder/member
 */

import { validateFlow } from './design.js'
import { analyzeMarkdown } from './markdown.js'

/** 成员名册，相对于 `.coder/`。 */
export const MEMBERS_ALL = 'members/all.md'

/** 成员流程，相对于 `.coder/`。 */
export const MEMBERS_FLOW = 'members/flow.md'

/** 主对话的固定一级标题。 */
const MAIN_HEADING = '主对话'

/** 成员标题：`成员` 加正整数，不接受前导零。 */
const MEMBER_HEADING = /^成员([1-9]\d*)$/

/** 字段行：`字段：值`，全角或半角冒号都接受。 */
const FIELD_PATTERN = /^(工作区名称|身份|工作范围)\s*[：:]\s*(.*?)\s*$/

/** 主对话允许且必填的字段，按固定顺序。 */
const MAIN_FIELDS = Object.freeze(['身份', '工作范围'])

/** 成员允许且必填的字段，按固定顺序。 */
const MEMBER_FIELDS = Object.freeze(['工作区名称', '身份', '工作范围'])

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
 * 根据 `.coder/` 相对路径判断成员文档类型。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {'members-all'|'members-flow'|null} 文档类型；不是成员文档时为 null。
 */
export function memberKindOf(relative) {
  if (relative === MEMBERS_ALL) return 'members-all'
  if (relative === MEMBERS_FLOW) return 'members-flow'
  return null
}

/**
 * 判断一个相对路径是否是成员文档。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {boolean} 是否是成员文档。
 */
export function isMemberDoc(relative) {
  return memberKindOf(relative) !== null
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
      return [diagnostic(doc, line, 'members.preamble', '第一个标题之前不能有正文；成员文档从一级标题开始。')]
    }
  }
  return []
}

/**
 * 解析一节里的字段行。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 整份文档的解析结果。
 * @param {{line: number}} heading - 当前一级标题。
 * @param {number} index - 当前标题在全部标题里的下标。
 * @param {readonly string[]} allowedFields - 这一节允许且必填的字段，按顺序。
 * @param {string} label - 给人看的节名。
 * @returns {{diagnostics: object[], fields: Record<string, string>}} 诊断与字段值。
 */
function parseSection(doc, analysis, heading, index, allowedFields, label) {
  const diagnostics = []
  const fields = {}
  const seen = new Map()
  let lastOrder = -1

  const body = bodyLines(analysis.lines, heading, analysis.headings, index, analysis.masked)
  for (const line of body) {
    const match = FIELD_PATTERN.exec(line.text.trim())
    if (match === null) {
      diagnostics.push(
        diagnostic(doc, line.line, 'members.body', `${label} 的正文只写字段行：${allowedFields.join(' / ')}。`),
      )
      continue
    }

    const field = match[1]
    const value = match[2].trim()
    const order = allowedFields.indexOf(field)
    if (order === -1) {
      diagnostics.push(
        diagnostic(
          doc,
          line.line,
          'members.field.unexpected',
          `${label} 不支持字段：${field}；只允许 ${allowedFields.join(' / ')}。`,
        ),
      )
      continue
    }
    if (seen.has(field)) {
      diagnostics.push(
        diagnostic(
          doc,
          line.line,
          'members.field.duplicate',
          `字段重复：${field}（第一次出现在第 ${seen.get(field)} 行）。`,
        ),
      )
      continue
    }
    seen.set(field, line.line)

    if (value === '') {
      diagnostics.push(diagnostic(doc, line.line, 'members.field.empty', `${field} 的值不能为空。`))
    }
    if (order < lastOrder) {
      diagnostics.push(
        diagnostic(doc, line.line, 'members.field.order', `字段顺序必须是：${allowedFields.join(' → ')}。`),
      )
    }
    lastOrder = Math.max(lastOrder, order)
    fields[field] = value
  }

  for (const field of allowedFields) {
    if (!seen.has(field)) {
      diagnostics.push(diagnostic(doc, heading.line, 'members.field.missing', `${label} 缺少字段：${field}。`))
    }
  }

  return { diagnostics, fields }
}

/**
 * 检查 `members/all.md` 的内容格式。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @returns {{diagnostics: object[], main: object|null, members: object[]}} 诊断、主对话与成员条目。
 */
export function inspectMembersAll(doc, text) {
  const diagnostics = []
  const members = []
  let main = null

  if (text.trim() === '') {
    diagnostics.push(diagnostic(doc, 1, 'members.empty', '成员文档是空的。'))
    return { diagnostics, main, members }
  }

  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }

  const { headings } = analysis
  if (!headings.some((heading) => heading.level === 1)) {
    diagnostics.push(diagnostic(doc, 1, 'members.main.missing', '缺少 # 主对话。'))
    return { diagnostics, main, members }
  }

  diagnostics.push(...preambleDiagnostics(doc, analysis))

  let mainSeen = false
  let firstSection = true
  const usedNumbers = new Set()

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'members.heading.level', '成员文档只用 # 写主对话与成员；字段写成普通行。'),
      )
      continue
    }

    const name = heading.text.trim()
    const isFirst = firstSection
    firstSection = false

    if (name === MAIN_HEADING) {
      if (mainSeen) {
        diagnostics.push(diagnostic(doc, heading.line, 'members.main.duplicate', '主对话只能出现一次。'))
        continue
      }
      if (!isFirst) {
        diagnostics.push(diagnostic(doc, heading.line, 'members.main.order', '主对话必须是第一个一级标题。'))
      }
      const parsed = parseSection(doc, analysis, heading, index, MAIN_FIELDS, MAIN_HEADING)
      diagnostics.push(...parsed.diagnostics)
      mainSeen = true
      main = {
        doc,
        line: heading.line,
        identity: parsed.fields['身份'] ?? null,
        scope: parsed.fields['工作范围'] ?? null,
      }
      continue
    }

    const match = MEMBER_HEADING.exec(name)
    if (match !== null) {
      const number = Number(match[1])
      if (usedNumbers.has(number)) {
        diagnostics.push(diagnostic(doc, heading.line, 'members.member.duplicate', `成员编号重复：${number}`))
        continue
      }
      usedNumbers.add(number)
      const parsed = parseSection(doc, analysis, heading, index, MEMBER_FIELDS, `成员${number}`)
      diagnostics.push(...parsed.diagnostics)
      members.push({
        doc,
        line: heading.line,
        number,
        workspace: parsed.fields['工作区名称'] ?? null,
        identity: parsed.fields['身份'] ?? null,
        scope: parsed.fields['工作范围'] ?? null,
      })
      continue
    }

    if (name.startsWith('成员')) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'members.member.format',
          `成员标题必须是 # 成员N（N 从 1 开始）；收到：${name}`,
        ),
      )
    } else {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'members.section.unknown',
          `未知的成员段落：${name}；只允许 # 主对话 与 # 成员N。`,
        ),
      )
    }
  }

  if (!mainSeen) {
    diagnostics.push(diagnostic(doc, 1, 'members.main.missing', '缺少 # 主对话。'))
  }

  members.sort((a, b) => a.number - b.number)
  return { diagnostics, main, members }
}

/**
 * 检查 `members/flow.md` 的内容格式。
 *
 * 沿用 `design/flow.md` 的场景规则：每个 `## <场景>` 至少一段说明和一张
 * 非空的 `mermaid` 图。`# 成员流程` 这类一级标题不参与检查。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @returns {{diagnostics: object[]}} 诊断。
 */
export function inspectMembersFlow(doc, text) {
  const diagnostics = []
  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }
  diagnostics.push(...validateFlow(doc, analysis))
  return { diagnostics }
}

/**
 * 按文档类型检查一份成员文档。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {'members-all'|'members-flow'} kind - 文档类型。
 * @returns {object[]} 诊断。
 */
export function validateMember(doc, text, kind) {
  if (kind === 'members-flow') return inspectMembersFlow(doc, text).diagnostics
  return inspectMembersAll(doc, text).diagnostics
}
