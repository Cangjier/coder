/**
 * `.coder/design/modules.md` 与 `.coder/design/module-NNNN.md` 的解析和检查。
 *
 * 模块索引 `modules.md` 用 4 位编码组织，每个编码后面是模块说明：
 *
 *   # 0001
 *   文档检查：扫描 .coder 文档树并逐份诊断。
 *
 * 模块详情 `module-NNNN.md` 把 `architecture.md`、`flow.md`、`data_structure.md`
 * 的结构收进一份文档：
 *
 *   # 架构
 *   ## 全局视角
 *   ## 局部视角：...        （可选）
 *   # 流程
 *   ## ...
 *   # 数据结构
 *   ## ...
 *   # 子模块                 （可选）
 *   ## 0002
 *   子模块说明
 *
 * `# 架构`、`# 流程`、`# 数据结构` 必填，`# 子模块` 可选。模块是设计文档的
 * 枝干/叶子：`design/architecture.md` 是顶层设计，模块文档把复杂部分拆开。
 *
 * `modules.md` 是预期文档；`module-NNNN.md` 是可选的模块详情文件，`list` 只在
 * 它存在时检查。索引里的每个编码都要有对应的模块文件，存在的模块文件也必须
 * 出现在索引里；子模块编码同样要指向存在的模块。
 *
 * @module coder/module
 */

import { validateArchitecture, validateData, validateFlow } from './design.js'
import { analyzeMarkdown } from './markdown.js'

/** 模块索引，相对于 `.coder/`。 */
export const MODULES_DOC = 'design/modules.md'

/** 模块详情文件：`design/module-NNNN.md`。 */
export const MODULE_FILE_PATTERN = /^design\/module-(\d{4})\.md$/

/** 模块编码：固定 4 位数字。 */
const MODULE_CODE_PATTERN = /^\d{4}$/

/** 模块详情允许的一级标题，按固定顺序。 */
const SECTION_ORDER = Object.freeze(['架构', '流程', '数据结构', '子模块'])

/** 模块详情必填的一级标题。 */
const REQUIRED_SECTIONS = Object.freeze(['架构', '流程', '数据结构'])

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
 * 根据 `.coder/` 相对路径判断模块文档类型。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {'modules'|`module-${string}`|null} `modules`、`module-NNNN`，或 null。
 */
export function moduleKindOf(relative) {
  if (relative === MODULES_DOC) return 'modules'
  const match = MODULE_FILE_PATTERN.exec(relative)
  return match === null ? null : `module-${match[1]}`
}

/**
 * 判断一个相对路径是否是模块文档。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {boolean} 是否是模块文档。
 */
export function isModuleDoc(relative) {
  return moduleKindOf(relative) !== null
}

/**
 * 判断一个相对路径是否是可选的模块详情文件。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {boolean} 是否是 `design/module-NNNN.md`。
 */
export function isOptionalModuleDoc(relative) {
  return MODULE_FILE_PATTERN.test(relative)
}

/**
 * 从模块详情路径里取 4 位编码。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {string|null} 编码；不是模块详情文件时为 null。
 */
export function moduleNumber(relative) {
  const match = MODULE_FILE_PATTERN.exec(relative)
  return match === null ? null : match[1]
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
      return [diagnostic(doc, line, 'module.preamble', '第一个标题之前不能有正文；模块文档从标题开始。')]
    }
  }
  return []
}

/**
 * 检查 `design/modules.md`。
 *
 * 空文件合法：表示还没有需要拆分的模块。非空时只用一级标题写 4 位模块编码，
 * 每个编码后面至少一行模块说明。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @returns {{diagnostics: object[], entries: object[]}} 诊断与模块条目。
 */
export function inspectModules(doc, text) {
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
  if (!headings.some((heading) => heading.level === 1)) {
    diagnostics.push(diagnostic(doc, 1, 'modules.no-code', '模块索引里没有任何 # 0001 编码。'))
    return { diagnostics, entries }
  }

  diagnostics.push(...preambleDiagnostics(doc, analysis))

  const seen = new Set()

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'modules.heading.level', '模块索引只用 # 写 4 位模块编码；模块说明写成普通行。'),
      )
      continue
    }

    const code = heading.text.trim()
    if (!MODULE_CODE_PATTERN.test(code)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'modules.code.format', `模块编码必须是 4 位数字，例如 0001；收到：${code}`),
      )
      continue
    }
    if (seen.has(code)) {
      diagnostics.push(diagnostic(doc, heading.line, 'modules.code.duplicate', `模块编码重复：${code}`))
      continue
    }
    seen.add(code)

    const body = bodyLines(lines, heading, headings, index, masked)
    if (body.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'modules.description.missing', `模块 ${code} 后面至少需要一行说明。`))
      continue
    }
    entries.push({
      doc,
      line: heading.line,
      code,
      description: body.map((line) => line.text.trim()).join(' '),
    })
  }

  return { diagnostics, entries }
}

/**
 * 把一段行区间重新解析成独立的 Markdown，供设计文档检查器复用。
 *
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 整个模块文档的解析结果。
 * @param {number} startLine - 区间起始行（含）。
 * @param {number} endLine - 区间结束行（含）。
 * @returns {ReturnType<typeof analyzeMarkdown>} 区间自己的解析结果。
 */
function sliceAnalysis(analysis, startLine, endLine) {
  return analyzeMarkdown(analysis.lines.slice(startLine - 1, endLine).join('\n'))
}

/**
 * 把区间内的诊断行号换算回整个文档。
 *
 * @param {object[]} diagnostics - 区间内的诊断。
 * @param {number} offset - 区间起始行之前有多少行。
 * @returns {object[]} 换算后的诊断。
 */
function shiftLines(diagnostics, offset) {
  if (offset === 0) return diagnostics
  return diagnostics.map((item) => ({ ...item, line: item.line + offset }))
}

/**
 * 检查一份 `design/module-NNNN.md`。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {string} code - 模块自己的 4 位编码。
 * @returns {{diagnostics: object[], submodules: object[]}} 诊断与子模块引用。
 */
export function inspectModule(doc, text, code) {
  const diagnostics = []
  const submodules = []

  if (text.trim() === '') {
    diagnostics.push(diagnostic(doc, 1, 'module.empty', '模块文档是空的。'))
    return { diagnostics, submodules }
  }

  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }

  const { lines, headings, masked } = analysis
  const firstLevel = headings.filter((heading) => heading.level === 1)

  if (firstLevel.length === 0) {
    for (const required of REQUIRED_SECTIONS) {
      diagnostics.push(diagnostic(doc, 1, 'module.section.missing', `缺少一级段落：# ${required}。`))
    }
    return { diagnostics, submodules }
  }

  diagnostics.push(...preambleDiagnostics(doc, analysis))

  const sections = []
  const seen = new Map()
  let lastOrder = -1

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level !== 1) continue

    const name = heading.text.trim()
    const order = SECTION_ORDER.indexOf(name)
    if (order === -1) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'module.section.unknown',
          `未知的模块段落：${name}；只允许 ${SECTION_ORDER.join(' / ')}。`,
        ),
      )
      continue
    }
    if (seen.has(name)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'module.section.duplicate', `模块段落重复：${name}（第一次出现在第 ${seen.get(name)} 行）。`),
      )
      continue
    }
    seen.set(name, heading.line)
    if (order < lastOrder) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'module.section.order', `模块段落的顺序必须是：${SECTION_ORDER.join(' → ')}。`),
      )
    }
    lastOrder = Math.max(lastOrder, order)

    const position = firstLevel.indexOf(heading)
    const next = position + 1 < firstLevel.length ? firstLevel[position + 1].line : lines.length + 1
    sections.push({ name, heading, end: next - 1 })
  }

  for (const required of REQUIRED_SECTIONS) {
    if (!seen.has(required)) {
      diagnostics.push(diagnostic(doc, 1, 'module.section.missing', `缺少一级段落：# ${required}。`))
    }
  }

  for (const section of sections) {
    if (section.name === '子模块') {
      const entries = headings.filter(
        (heading) => heading.level === 2 && heading.line > section.heading.line && heading.line <= section.end,
      )
      if (entries.length === 0) {
        diagnostics.push(
          diagnostic(doc, section.heading.line, 'module.submodule.empty', '# 子模块 下面至少需要一个 ## 0001 子模块。'),
        )
        continue
      }
      const codes = new Set()
      for (const heading of entries) {
        const headingIndex = headings.indexOf(heading)
        const subCode = heading.text.trim()
        if (!MODULE_CODE_PATTERN.test(subCode)) {
          diagnostics.push(
            diagnostic(doc, heading.line, 'module.submodule.format', `子模块编码必须是 4 位数字，例如 0002；收到：${subCode}`),
          )
          continue
        }
        if (subCode === code) {
          diagnostics.push(diagnostic(doc, heading.line, 'module.submodule.self', `子模块不能引用模块自己：${subCode}`))
          continue
        }
        if (codes.has(subCode)) {
          diagnostics.push(diagnostic(doc, heading.line, 'module.submodule.duplicate', `子模块编码重复：${subCode}`))
          continue
        }
        codes.add(subCode)
        const body = bodyLines(lines, heading, headings, headingIndex, masked)
        if (body.length === 0) {
          diagnostics.push(
            diagnostic(doc, heading.line, 'module.submodule.description', `子模块 ${subCode} 后面至少需要一行说明。`),
          )
          continue
        }
        submodules.push({
          doc,
          line: heading.line,
          code: subCode,
          description: body.map((line) => line.text.trim()).join(' '),
        })
      }
      continue
    }

    const sliced = sliceAnalysis(analysis, section.heading.line, section.end)
    const offset = section.heading.line - 1
    if (section.name === '架构') {
      diagnostics.push(...shiftLines(validateArchitecture(doc, sliced, { requireLocal: false }), offset))
    } else if (section.name === '流程') {
      diagnostics.push(...shiftLines(validateFlow(doc, sliced), offset))
    } else if (section.name === '数据结构') {
      diagnostics.push(...shiftLines(validateData(doc, sliced), offset))
    }
  }

  return { diagnostics, submodules }
}

/**
 * 按文档类型检查一份模块文档。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {string} kind - `modules` 或 `module-NNNN`。
 * @param {string} [code] - 模块详情自己的编码。
 * @returns {object[]} 诊断。
 */
export function validateModule(doc, text, kind, code) {
  if (kind === 'modules') return inspectModules(doc, text).diagnostics
  return inspectModule(doc, text, code ?? '').diagnostics
}
