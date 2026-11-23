/**
 * `.coder/` 文档树的扫描与格式诊断。
 *
 * 这里没有任何模型调用，也没有任何业务判断：给一个项目根目录，就把
 * `<root>/.coder/` 下的文件全部列出来，与预期集合比对，再按
 * `docs/design.md` 的格式约定逐份诊断。
 *
 * 四份设计文档、两份诊断文档和四份计划文档的规则都以「确定性」为前提，
 * 所以只做能够机械判定的检查：标题路径是否合法、同一路径是否重复、说明是否
 * 为空、是否有反向表述、视角是否有图、场景是否有 mermaid 图、数据结构是否用
 * ts interface 表达、诊断码与作用范围是否合法、步骤格式与编号、文件通配范围
 * 是否命中、计划编码与字段顺序、编号条目和关联 ToDo 是否合法。
 * 判不了的（例如图是否真的描述了代码、任务是否真的完成）不猜，也不报。
 *
 * 文档目录、预期文档和格式规则都是固化的，不接受配置。
 *
 * @module coder/docs
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { DIAGNOSIS_DOCS, diagnosisSeverity, inspectDiagnosis } from './diagnosis.js'
import { matchGlob } from './glob.js'
import { LOCK_DECLARATION, LOCK_RELATIVE, hashCoder, readLock } from './lock.js'
import { analyzeMarkdown } from './markdown.js'
import { PLAN_DOCS, inspectPlan, planKindOf } from './plan.js'

export { analyzeMarkdown }

/** 文档树目录，相对于项目根目录。固化，不提供配置。 */
export const DOCS_DIR = '.coder'

/** 预期文档，相对于文档树目录。固化，不提供配置。 */
export const EXPECTED_DOCS = Object.freeze([
  'design/file.md',
  'design/architecture.md',
  'design/flow.md',
  'design/data_structure.md',
  ...DIAGNOSIS_DOCS,
  ...PLAN_DOCS,
])

/** 会被当作 Markdown 诊断的扩展名。 */
const MARKDOWN_EXTENSION = /\.(md|markdown)$/i

/** 反向表述：行首这些词说明「只描述正向预期」被破坏了。 */
const NEGATION_START = /^(不要|禁止|不允许|不得|不能|勿|请勿|严禁|do not|don't|must not|never)/i

/** 反向表述：句中这些词也是高置信度的反向约束。 */
const NEGATION_ANY = /(禁止|不允许|不得)|\b(must not|should not|do not)\b/i

/** 扫描或读取失败时抛出的错；工具层把它变成一次明确的失败。 */
export class CoderError extends Error {
  /**
   * @param {string} message - 原因与改法。
   */
  constructor(message) {
    super(message)
    this.name = 'CoderError'
  }
}

/**
 * 根据文档路径推断它属于哪一类格式。
 *
 * 设计文档用 basename 判断；诊断文档和计划文档按完整相对路径判断，避免其他
 * 目录里同名的 error.md / warn.md / todo.md 被误认。
 *
 * @param {string} relative - 相对于文档树目录的路径。
 * @returns {'file'|'architecture'|'flow'|'data'|'diagnosis-error'|'diagnosis-warn'|'plan-todo'|'plan-todo-archived'|'plan-goal'|'plan-goal-archived'|'lock'|'generic'} 文档类型。
 */
export function kindOf(relative) {
  if (relative === 'diagnosis/error.md') return 'diagnosis-error'
  if (relative === 'diagnosis/warn.md') return 'diagnosis-warn'
  const planKind = planKindOf(relative)
  if (planKind !== null) return planKind
  const base = path.posix.basename(relative).toLowerCase()
  if (base === 'file.md') return 'file'
  if (base === 'architecture.md') return 'architecture'
  if (base === 'flow.md') return 'flow'
  if (base === 'data_structure.md') return 'data'
  if (base === 'lock.md') return 'lock'
  return 'generic'
}

/**
 * 构造一条诊断。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {number} line - 1-based 行号。
 * @param {string} rule - 稳定的规则代码。
 * @param {string} message - 给人看的原因。
 * @returns {{doc: string, line: number, rule: string, severity: 'error', message: string}} 诊断。
 */
function diagnostic(doc, line, rule, message) {
  return { doc, line, rule, severity: 'error', message }
}

/**
 * 去掉标题两边可能包着的一对反引号。
 *
 * @param {string} text - 标题文本。
 * @returns {string} 纯路径文本。
 */
function stripInlineCode(text) {
  const trimmed = text.trim()
  const match = /^`([^`]+)`$/.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

/**
 * 找某个标题所属段落的结束行。
 *
 * 段落一直延伸到下一个级别不高于 `maxLevel` 的标题之前；这样 `## L1` 的正文
 * 会包含它下面的 `### 模块`，而下一个 `##` 会开启新的层级。
 *
 * @param {{level: number, line: number}[]} headings - 全部标题。
 * @param {number} index - 当前标题在数组里的下标。
 * @param {number} lineCount - 文档总行数。
 * @param {number} maxLevel - 视为同级或更高的最大标题级别。
 * @returns {number} 段落最后一行的 1-based 行号。
 */
function sectionEnd(headings, index, lineCount, maxLevel) {
  for (let next = index + 1; next < headings.length; next += 1) {
    if (headings[next].level <= maxLevel) return headings[next].line - 1
  }
  return lineCount
}

/**
 * 取某个标题的「直属正文」行：直到下一个任意级别的标题之前。
 *
 * file.md 用这个规则——`# src` 的说明只算到 `## src/main.ts` 之前，
 * 不能拿子项的说明来顶替自己的说明。
 *
 * @param {string[]} lines - 文档全部行。
 * @param {{line: number}} heading - 当前标题。
 * @param {{line: number}[]} headings - 全部标题。
 * @param {number} index - 当前标题下标。
 * @returns {{text: string, line: number}[]} 直属正文行。
 */
function directBody(lines, heading, headings, index) {
  const nextLine = index + 1 < headings.length ? headings[index + 1].line : lines.length + 1
  const body = []
  for (let line = heading.line + 1; line < nextLine; line += 1) {
    body.push({ text: lines[line - 1], line })
  }
  return body
}

/**
 * 校验 file.md 里的一个标题路径。
 *
 * @param {string} raw - 标题里的路径文本。
 * @returns {{rule: string, message: string}|null} 问题；合法时为 null。
 */
function pathIssue(raw) {
  if (raw === '') {
    return { rule: 'file.path.empty', message: '标题后面缺少路径。' }
  }
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { rule: 'file.path.absolute', message: `路径必须相对于项目根目录，不能是绝对路径：${raw}` }
  }
  if (raw.includes('\\')) {
    return { rule: 'file.path.separator', message: `路径必须使用 / 分隔：${raw}` }
  }
  const segments = raw.split('/')
  if (segments.includes('..')) {
    return { rule: 'file.path.traversal', message: `路径不能包含 ..：${raw}` }
  }
  if (segments.includes('.')) {
    return { rule: 'file.path.dot-segment', message: `路径不能包含 . 路径段：${raw}` }
  }
  if (segments.includes('')) {
    return { rule: 'file.path.empty-segment', message: `路径不能以 / 结尾或包含空路径段：${raw}` }
  }
  return null
}

/**
 * 判断一个路径/通配是否指向 `.coder` 自身或它下面。
 *
 * @param {string} value - 路径文本。
 * @returns {boolean} 是否属于 `.coder`。
 */
function isCoderPath(value) {
  return value === DOCS_DIR || value.startsWith(`${DOCS_DIR}/`)
}

/**
 * 从 file.md 的标题里取出用于覆盖检查的路径/通配。
 *
 * 只取一级和二级标题；路径本身非法的标题已经由 {@link validateFile} 报过，
 * 这里跳过，避免同一条问题重复出现。`.coder` 自身不参与覆盖。
 *
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {{path: string, line: number, level: number}[]} 路径模式。
 */
function extractFilePatterns(analysis) {
  const patterns = []
  for (const heading of analysis.headings) {
    if (heading.level > 2) continue
    const raw = stripInlineCode(heading.text)
    if (isCoderPath(raw)) continue
    if (pathIssue(raw) !== null) continue
    patterns.push({ path: raw, line: heading.line, level: heading.level })
  }
  return patterns
}

/**
 * 检查 file.md 是否覆盖项目里的每个文件。
 *
 * `.coder` 自身及其内容不要求描述；其余文件必须至少被一个路径/通配匹配。
 * 目录不需要单独成条：`tmp/**` 已经同时表达目录和它下面的文件。
 *
 * @param {string} text - file.md 正文。
 * @param {string[]} files - 项目文件（相对路径，已排除 `.coder`）。
 * @returns {object[]} 诊断。
 */
export function fileCoverage(text, files) {
  const analysis = analyzeMarkdown(text)
  const patterns = extractFilePatterns(analysis)
  const doc = `${DOCS_DIR}/${EXPECTED_DOCS[0]}`
  const diagnostics = []

  for (const file of files) {
    if (file === DOCS_DIR || file.startsWith(`${DOCS_DIR}/`)) continue
    if (patterns.some((entry) => matchGlob(entry.path, file))) continue
    diagnostics.push(
      diagnostic(
        doc,
        1,
        'file.coverage.missing',
        `文件未被 file.md 描述：${file}。用类似 tmp/** 的通配表达覆盖它。`,
      ),
    )
  }

  return diagnostics
}

/**
 * 校验 file.md。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
function validateFile(doc, analysis) {
  const diagnostics = []
  const { lines, headings, masked } = analysis

  if (headings.length === 0) {
    diagnostics.push(diagnostic(doc, 1, 'file.no-heading', 'file.md 里没有任何 # 或 ## 标题。'))
    return diagnostics
  }

  const entries = []
  const seen = new Map()
  const levelOne = new Set()

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level > 2) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'file.heading.level', `标题级别为 ${heading.level}；file.md 只用 #（目录或独立文件）和 ##（目录下的文件）。`),
      )
    }
    const raw = stripInlineCode(heading.text)
    if (isCoderPath(raw)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'file.entry.coder', 'file.md 不能描述 .coder 自身或它下面的文件。'),
      )
      continue
    }
    const issue = pathIssue(raw)
    if (issue !== null) {
      diagnostics.push(diagnostic(doc, heading.line, issue.rule, issue.message))
    } else {
      if (seen.has(raw)) {
        diagnostics.push(diagnostic(doc, heading.line, 'file.path.duplicate', `路径重复：${raw}（第一次出现在第 ${seen.get(raw)} 行）。`))
      } else {
        seen.set(raw, heading.line)
      }
      if (heading.level === 1) levelOne.add(raw)
      entries.push({ heading, index, path: raw })
    }

    const body = directBody(lines, heading, headings, index)
    const outside = body.filter((line) => line.text.trim() !== '' && !masked[line.line - 1])
    if (outside.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'file.description.missing', `${raw} 后面至少需要一行非空说明。`))
    }
    for (const line of outside) {
      if (NEGATION_START.test(line.text.trim()) || NEGATION_ANY.test(line.text)) {
        diagnostics.push(
          diagnostic(doc, line.line, 'file.description.negated', '说明只描述正向预期；反向约束请改写成期望达到的状态。'),
        )
      }
    }
  }

  for (const entry of entries) {
    if (entry.heading.level !== 2) continue
    const slash = entry.path.indexOf('/')
    if (slash <= 0) {
      diagnostics.push(diagnostic(doc, entry.heading.line, 'file.path.parent', `二级标题必须是目录下的文件：${entry.path}`))
      continue
    }
    const parent = entry.path.slice(0, slash)
    if (!levelOne.has(parent)) {
      diagnostics.push(
        diagnostic(doc, entry.heading.line, 'file.parent.missing', `父路径 ${parent} 没有以一级标题出现过。`),
      )
    }
  }

  return diagnostics
}

/** 表达数据结构的围栏语言标记。 */
const DATA_LANGS = new Set(['ts', 'typescript'])

/** TypeScript interface 声明；只认 `interface Name` 后跟 `{`。 */
const INTERFACE_DECLARATION = /\binterface\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{}\n]*>)?\s*(?:extends\s+[^{}\n]+)?\{/g

/**
 * 校验 data_structure.md。
 *
 * 数据结构用 `## <名称>` 分段，每段用 ```ts 围栏写 TypeScript interface。
 * 只校验能够机械判定的部分：每段至少一个 ts 围栏、围栏非空、里面确实有
 * interface、interface 名称不重复。结构是否关键、字段是否完整无法机械判断。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
function validateData(doc, analysis) {
  const diagnostics = []
  const { lines, headings, fences } = analysis
  const sections = headings
    .map((heading, index) => ({ heading, index }))
    .filter((entry) => entry.heading.level === 2)

  if (sections.length === 0) {
    diagnostics.push(diagnostic(doc, 1, 'data.no-section', 'data_structure.md 里没有 ## 数据结构。'))
    return diagnostics
  }

  const blocks = fences.filter((fence) => DATA_LANGS.has(fence.lang))
  const seen = new Map()
  const owned = new Set()

  function checkBlock(block) {
    if (block.content.trim() === '') {
      diagnostics.push(diagnostic(doc, block.startLine, 'data.ts.empty', '```ts 代码块是空的。'))
      return
    }
    const names = [...block.content.matchAll(INTERFACE_DECLARATION)].map((match) => match[1])
    if (names.length === 0) {
      diagnostics.push(
        diagnostic(doc, block.startLine, 'data.interface.missing', '```ts 代码块里没有 interface 声明。'),
      )
      return
    }
    for (const name of names) {
      const first = seen.get(name)
      if (first === undefined) {
        seen.set(name, block.startLine)
      } else {
        diagnostics.push(
          diagnostic(
            doc,
            block.startLine,
            'data.interface.duplicate',
            `interface ${name} 重复定义（第一次出现在第 ${first} 行）。`,
          ),
        )
      }
    }
  }

  for (const { heading, index } of sections) {
    const end = sectionEnd(headings, index, lines.length, 2)
    const inSection = blocks.filter((block) => block.startLine > heading.line && block.endLine <= end)
    if (inSection.length === 0) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'data.section.no-ts', `数据结构 ${heading.text} 需要一个 \`\`\`ts 代码块。`),
      )
      continue
    }
    for (const block of inSection) {
      owned.add(block)
      checkBlock(block)
    }
  }

  for (const block of blocks) {
    if (!owned.has(block)) checkBlock(block)
  }

  return diagnostics
}

/** 全局视角的固定标题。 */
const GLOBAL_VIEW = '全局视角'

/** 局部视角的标题格式：`局部视角：<名称>`。 */
const LOCAL_VIEW = /^局部视角\s*[：:]\s*\S/

/**
 * 取某个视角段落里的 mermaid 围栏。
 *
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @param {number} headingLine - 视角标题所在行。
 * @param {number} endLine - 段落最后一行。
 * @returns {{startLine: number, endLine: number, lang: string, content: string}[]} 围栏。
 */
function mermaidFencesIn(analysis, headingLine, endLine) {
  return analysis.fences.filter(
    (fence) => fence.lang === 'mermaid' && fence.startLine > headingLine && fence.endLine <= endLine,
  )
}

/**
 * 取 Mermaid 正文里的第一条有效指令，跳过空行和 `%%` 注释。
 *
 * @param {string} content - 代码块正文。
 * @returns {string} 第一条有效行；没有时为空串。
 */
function firstDirective(content) {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('%%')) return trimmed
  }
  return ''
}

/**
 * 校验 architecture.md。
 *
 * 架构文档用多张 Mermaid 图表达：第一个 `## 视角` 必须是全局视角，后面是
 * 若干局部视角。每个视角需要一段说明和一张 `flowchart`/`graph` 图；全局
 * 视角还必须用 `subgraph` 表达分层。图是否真的描述了代码无法机械判断，
 * 这里只校验结构。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
function validateArchitecture(doc, analysis) {
  const diagnostics = []
  const { lines, headings } = analysis
  const views = headings
    .map((heading, index) => ({ heading, index }))
    .filter((entry) => entry.heading.level === 2)

  if (views.length === 0) {
    diagnostics.push(diagnostic(doc, 1, 'architecture.no-view', 'architecture.md 里没有 ## 视角。'))
    return diagnostics
  }

  const seen = new Map()
  const globals = []

  for (let position = 0; position < views.length; position += 1) {
    const { heading, index } = views[position]
    const name = heading.text.trim()
    const isGlobal = name === GLOBAL_VIEW
    const isLocal = LOCAL_VIEW.test(name)

    if (isGlobal) globals.push(heading)
    if (!isGlobal && !isLocal) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'architecture.view.kind', `视角标题必须是 ## ${GLOBAL_VIEW} 或 ## 局部视角：<名称>，收到：${name}`),
      )
    }
    if (seen.has(name)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'architecture.view.duplicate', `视角重复：${name}（第一次出现在第 ${seen.get(name)} 行）。`),
      )
    } else {
      seen.set(name, heading.line)
    }
    if (position === 0 && !isGlobal) {
      diagnostics.push(diagnostic(doc, heading.line, 'architecture.view.order', `${GLOBAL_VIEW} 必须是第一个 ## 视角。`))
    }

    const end = sectionEnd(headings, index, lines.length, 2)
    const body = []
    for (let line = heading.line + 1; line <= end; line += 1) {
      body.push({ text: lines[line - 1], line })
    }
    const outside = body.filter((line) => line.text.trim() !== '' && !analysis.masked[line.line - 1])
    if (outside.length === 0) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'architecture.view.description.missing', `视角 ${name} 需要一段说明。`),
      )
    }

    const diagrams = mermaidFencesIn(analysis, heading.line, end)
    if (diagrams.length === 0) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'architecture.view.diagram.missing', `视角 ${name} 需要一个 \`\`\`mermaid 图。`),
      )
      continue
    }
    for (const extra of diagrams.slice(1)) {
      diagnostics.push(
        diagnostic(doc, extra.startLine, 'architecture.view.diagram.multiple', `视角 ${name} 只能有一张图。`),
      )
    }

    const diagram = diagrams[0]
    if (diagram.content.trim() === '') {
      diagnostics.push(diagnostic(doc, diagram.startLine, 'architecture.diagram.empty', '架构图是空的。'))
      continue
    }
    if (!/^(flowchart|graph)\b/i.test(firstDirective(diagram.content))) {
      diagnostics.push(
        diagnostic(doc, diagram.startLine, 'architecture.diagram.type', '架构图必须以 flowchart 或 graph 开头。'),
      )
    }
    if (isGlobal && !/\bsubgraph\b/.test(diagram.content)) {
      diagnostics.push(
        diagnostic(doc, diagram.startLine, 'architecture.global.no-subgraph', '全局视角必须用 subgraph 表达分层。'),
      )
    }
  }

  if (globals.length === 0) {
    diagnostics.push(diagnostic(doc, 1, 'architecture.global.missing', `architecture.md 缺少 ## ${GLOBAL_VIEW}。`))
  } else {
    for (const extra of globals.slice(1)) {
      diagnostics.push(
        diagnostic(doc, extra.line, 'architecture.global.multiple', `architecture.md 只能有一个 ## ${GLOBAL_VIEW}。`),
      )
    }
  }
  if (!views.some((entry) => LOCAL_VIEW.test(entry.heading.text.trim()))) {
    diagnostics.push(diagnostic(doc, 1, 'architecture.local.missing', 'architecture.md 至少需要一个 ## 局部视角：<名称>。'))
  }

  return diagnostics
}

/**
 * 校验 flow.md。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
function validateFlow(doc, analysis) {
  const diagnostics = []
  const { lines, headings, fences } = analysis
  const scenarios = headings
    .map((heading, index) => ({ heading, index }))
    .filter((entry) => entry.heading.level === 2)

  if (scenarios.length === 0) {
    diagnostics.push(diagnostic(doc, 1, 'flow.no-scenario', 'flow.md 里没有 ## 场景。'))
    return diagnostics
  }

  for (const { heading, index } of scenarios) {
    const end = sectionEnd(headings, index, lines.length, 2)
    const body = []
    for (let line = heading.line + 1; line <= end; line += 1) {
      if (lines[line - 1].trim() !== '') body.push(line)
    }
    if (body.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'flow.scenario.empty', `场景 ${heading.text} 的正文是空的。`))
      continue
    }
    const diagrams = fences.filter(
      (fence) => fence.lang === 'mermaid' && fence.startLine > heading.line && fence.startLine <= end && fence.endLine <= end,
    )
    if (diagrams.length === 0) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'flow.scenario.no-diagram', `场景 ${heading.text} 缺少一个 \`\`\`mermaid 代码块。`),
      )
      continue
    }
    for (const diagram of diagrams) {
      if (diagram.content.trim() === '') {
        diagnostics.push(diagnostic(doc, diagram.startLine, 'flow.diagram.empty', 'mermaid 代码块是空的。'))
      }
    }
  }

  return diagnostics
}

/**
 * 诊断一份文档。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {'file'|'architecture'|'flow'|'data'|'diagnosis-error'|'diagnosis-warn'|'plan-todo'|'plan-todo-archived'|'plan-goal'|'plan-goal-archived'|'lock'|'generic'} kind - 文档类型。
 * @param {string[]} [files] - 项目文件；诊断文档用它检查文件通配范围。
 * @returns {object[]} 诊断。
 */
export function validateDocument(doc, text, kind, files) {
  if (kind === 'diagnosis-error' || kind === 'diagnosis-warn') {
    return inspectDiagnosis(doc, text, diagnosisSeverity(kind), files).diagnostics
  }
  if (kind.startsWith('plan-')) {
    return inspectPlan(doc, text, kind).diagnostics
  }

  const diagnostics = []
  if (text.trim() === '') {
    diagnostics.push(diagnostic(doc, 1, 'doc.empty', '文档是空的。'))
    return diagnostics
  }
  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }
  if (kind === 'file') diagnostics.push(...validateFile(doc, analysis))
  else if (kind === 'architecture') diagnostics.push(...validateArchitecture(doc, analysis))
  else if (kind === 'flow') diagnostics.push(...validateFlow(doc, analysis))
  else if (kind === 'data') diagnostics.push(...validateData(doc, analysis))
  return diagnostics
}

/**
 * 递归列出一个目录下的全部普通文件。
 *
 * 不跟随符号链接：文档树之外的路径不应该被这次只读检查带进来。
 *
 * @param {string} dir - 绝对目录。
 * @param {string} root - 文档树根目录，用于计算相对路径。
 * @returns {Promise<string[]>} 使用 `/` 分隔的相对路径，已排序。
 */
async function walk(dir, root) {
  const result = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await walk(absolute, root)))
    } else if (entry.isFile()) {
      result.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  return result
}

/**
 * 列出项目里除 `.coder` 外的全部普通文件。
 *
 * 只跳过项目根目录下的 `.coder`；其他目录（包括 `node_modules`、`.git`）
 * 都按“所有文件”的规则参与覆盖检查，需要时用 `node_modules/**` 之类的
 * 通配表达。符号链接不跟随。
 *
 * @param {string} root - 项目根目录。
 * @returns {Promise<string[]>} 使用 `/` 分隔的相对路径，已排序。
 */
async function walkProject(root) {
  const files = []
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (relative === DOCS_DIR) continue
        await visit(absolute)
      } else if (entry.isFile()) {
        if (relative === DOCS_DIR) continue
        files.push(relative)
      }
    }
  }
  await visit(root)
  return files
}

/**
 * 拼一个展示用路径。
 *
 * @param {string} relative - 相对路径；空串表示文档树根。
 * @returns {string} 例如 `.coder/design/file.md`。
 */
function displayPath(relative) {
  return relative === '' ? DOCS_DIR : `${DOCS_DIR}/${relative}`
}

/**
 * 把检查结果整理成一段可读文本。
 *
 * @param {object} report - `inspectDocs` 的结果。
 * @returns {string} 汇总文本。
 */
function formatReport(report) {
  const lines = [`Coder 文档检查：${report.docsRoot}`]
  if (!report.docsRootExists) lines.push(`（${DOCS_DIR}/ 不存在。）`)
  lines.push(
    `预期 ${report.summary.expected}｜找到 ${report.summary.found}｜非法 ${report.summary.illegal}｜缺失 ${report.summary.missing}｜诊断 ${report.summary.diagnostics}｜计划 ${report.summary.plans}${report.summary.locked ? '｜已上锁' : ''}`,
  )
  lines.push('')
  lines.push('文档：')
  for (const document of report.documents) {
    const marker =
      document.status === 'expected'
        ? '[ok]'
        : document.status === 'illegal'
          ? '[illegal]'
          : document.status === 'lock'
            ? '[lock]'
            : '[missing]'
    lines.push(`  ${marker} ${document.path}`)
  }
  if (report.diagnoses.length > 0) {
    lines.push('')
    lines.push('诊断码：')
    for (const item of report.diagnoses) {
      const scope =
        item.scopeKind === 'global'
          ? '全局'
          : item.scopeKind === 'glob'
            ? `${item.scope}（命中 ${item.matches ?? '未检查'} 个文件）`
            : '作用范围无效'
      const method = item.method ?? '诊断方式无效'
      lines.push(`  ${item.code} [${item.severity}] ${scope}｜诊断方式 ${method}｜步骤 ${item.steps.length}`)
    }
  }
  if (report.plans.length > 0) {
    lines.push('')
    lines.push('计划：')
    for (const item of report.plans) {
      const scope = item.scope ?? '任务范围无效'
      const priority = item.priority === null ? '' : `｜${item.priority}`
      const todos = item.kind === 'goal' ? `｜关联 ToDo ${item.todos}` : `｜进度 ${item.progress}`
      lines.push(
        `  ${item.code} [${item.archived ? '归档' : '进行中'}] ${item.kind}${priority}｜${scope}｜完成预期 ${item.expected}${todos}`,
      )
    }
  }
  if (report.diagnostics.length > 0) {
    lines.push('')
    lines.push('诊断：')
    for (const item of report.diagnostics) {
      lines.push(`  ${item.doc}:${item.line} [${item.rule}] ${item.message}`)
    }
  }
  if (report.ok) {
    lines.push('')
    lines.push('所有文档齐全且格式正确。')
  }
  return lines.join('\n')
}

/**
 * 检查一个项目的 `.coder/` 文档树。
 *
 * @param {object} options - 选项。
 * @param {string} options.root - 项目根目录（绝对路径或可解析的相对路径）。
 * @returns {Promise<object>} 结构化报告，带 `text` 汇总。
 * @throws {CoderError} 根目录不存在或不可读时。
 */
export async function inspectDocs({ root }) {
  const absoluteRoot = path.resolve(root)
  const rootStat = await fs.stat(absoluteRoot).catch(() => null)
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new CoderError(`项目根目录不存在或不是目录：${absoluteRoot}`)
  }

  const docsRoot = path.resolve(absoluteRoot, DOCS_DIR)
  const diagnostics = []
  const diagnoses = []
  const plans = []
  let docsRootExists = false
  let discovered = []
  let projectFiles = null
  let allFiles = null

  const docsRootStat = await fs.stat(docsRoot).catch((error) => {
    if (error && error.code === 'ENOENT') return null
    throw new CoderError(`无法读取 ${docsRoot}：${error instanceof Error ? error.message : String(error)}`)
  })

  if (docsRootStat !== null) {
    if (!docsRootStat.isDirectory()) {
      diagnostics.push(diagnostic(DOCS_DIR, 1, 'docsRoot.not-directory', `${DOCS_DIR} 不是目录。`))
    } else {
      docsRootExists = true
      discovered = await walk(docsRoot, docsRoot)
    }
  }

  const expectedSet = new Set(EXPECTED_DOCS)
  const discoveredSet = new Set(discovered)
  const documents = []

  for (const relative of EXPECTED_DOCS) {
    const exists = discoveredSet.has(relative)
    documents.push({
      path: displayPath(relative),
      relative,
      absolute: path.join(docsRoot, ...relative.split('/')),
      status: exists ? 'expected' : 'missing',
      exists,
      kind: kindOf(relative),
    })
  }

  for (const relative of discovered) {
    if (expectedSet.has(relative) || relative === LOCK_RELATIVE) continue
    documents.push({
      path: displayPath(relative),
      relative,
      absolute: path.join(docsRoot, ...relative.split('/')),
      status: 'illegal',
      exists: true,
      kind: kindOf(relative),
    })
  }

  const hasLock = discovered.includes(LOCK_RELATIVE)
  if (hasLock) {
    documents.push({
      path: displayPath(LOCK_RELATIVE),
      relative: LOCK_RELATIVE,
      absolute: path.join(docsRoot, LOCK_RELATIVE),
      status: 'lock',
      exists: true,
      kind: 'lock',
    })
  }

  async function ensureProjectFiles() {
    if (projectFiles === null) {
      try {
        projectFiles = await walkProject(absoluteRoot)
      } catch (error) {
        throw new CoderError(
          `无法列出 ${absoluteRoot} 的文件：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return projectFiles
  }

  async function ensureAllFiles() {
    if (allFiles === null) {
      const project = await ensureProjectFiles()
      const docs = discovered.map((relative) => `${DOCS_DIR}/${relative}`)
      allFiles = [...new Set([...project, ...docs])].sort((a, b) => a.localeCompare(b))
    }
    return allFiles
  }

  for (const relative of discovered) {
    if (!MARKDOWN_EXTENSION.test(relative) || relative === LOCK_RELATIVE) continue
    const doc = displayPath(relative)
    const absolute = path.join(docsRoot, ...relative.split('/'))
    const text = await fs.readFile(absolute, 'utf8').catch((error) => {
      diagnostics.push(
        diagnostic(doc, 1, 'doc.unreadable', `无法读取文件：${error instanceof Error ? error.message : String(error)}`),
      )
      return null
    })
    if (text === null) continue
    const kind = kindOf(relative)
    if (kind === 'diagnosis-error' || kind === 'diagnosis-warn') {
      const result = inspectDiagnosis(doc, text, diagnosisSeverity(kind), await ensureAllFiles())
      diagnostics.push(...result.diagnostics)
      diagnoses.push(...result.codes)
    } else if (kind.startsWith('plan-')) {
      const result = inspectPlan(doc, text, kind)
      diagnostics.push(...result.diagnostics)
      plans.push(...result.entries)
    } else {
      diagnostics.push(...validateDocument(doc, text, kind))
    }
    if (kind === 'file' && relative === EXPECTED_DOCS[0]) {
      diagnostics.push(...fileCoverage(text, await ensureProjectFiles()))
    }
  }

  const planRank = (entry) => (entry.kind === 'todo' ? 0 : 2) + (entry.archived ? 1 : 0)
  plans.sort((a, b) => planRank(a) - planRank(b) || a.line - b.line)

  const planCodes = new Map()
  for (const entry of plans) {
    const key = `${entry.kind}:${entry.code}`
    const previous = planCodes.get(key)
    if (previous === undefined) {
      planCodes.set(key, entry)
    } else if (previous.archived !== entry.archived) {
      diagnostics.push(
        diagnostic(
          entry.doc,
          entry.line,
          'plan.code.archived-duplicate',
          `${entry.code} 同时出现在 ${previous.doc} 与 ${entry.doc}；完成的任务只保留在归档文档中。`,
        ),
      )
    }
  }

  let lock = hasLock
    ? {
        present: true,
        path: displayPath(LOCK_RELATIVE),
        declarationValid: false,
        hash: null,
        hashMatches: null,
        currentHash: null,
        authorizationLength: 0,
      }
    : null
  if (hasLock) {
    const doc = displayPath(LOCK_RELATIVE)
    let parsed = null
    try {
      parsed = await readLock(docsRoot)
    } catch (error) {
      diagnostics.push(
        diagnostic(doc, 1, 'doc.unreadable', `无法读取文件：${error instanceof Error ? error.message : String(error)}`),
      )
    }
    if (parsed !== null) {
      let hashMatches = null
      let currentHash = null
      if (parsed.hashValid) {
        try {
          currentHash = (await hashCoder(docsRoot)).hash
          hashMatches = currentHash === parsed.hash
        } catch (error) {
          diagnostics.push(
            diagnostic(
              doc,
              2,
              'lock.hash.unreadable',
              `无法重新计算 .coder 的 hash：${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      }
      if (!parsed.declarationValid) {
        diagnostics.push(diagnostic(doc, 1, 'lock.declaration', `第一行必须是固定声明：${LOCK_DECLARATION}`))
      }
      if (!parsed.hashValid) {
        diagnostics.push(diagnostic(doc, 2, 'lock.hash.invalid', '第二行必须是 sha256:<64 位小写 hex>。'))
      }
      if (!parsed.authorizationPresent) {
        diagnostics.push(diagnostic(doc, 3, 'lock.authorization.missing', '第三行起缺少用户授权原文。'))
      }
      if (parsed.hashValid && hashMatches === false) {
        diagnostics.push(
          diagnostic(doc, 2, 'lock.hash.mismatch', 'lock.md 记录的 hash 与当前 .coder 的内容不一致；请自查哪些文件被直接修改。'),
        )
      }
      lock = {
        present: true,
        path: doc,
        declarationValid: parsed.declarationValid,
        hash: parsed.hash,
        hashMatches,
        currentHash,
        authorizationLength: parsed.authorization.length,
      }
    }
  }

  const illegal = documents.filter((document) => document.status === 'illegal').map((document) => document.path)
  const missing = documents.filter((document) => document.status === 'missing').map((document) => document.path)
  const summary = {
    expected: EXPECTED_DOCS.length,
    found: EXPECTED_DOCS.length - missing.length,
    illegal: illegal.length,
    missing: missing.length,
    diagnostics: diagnostics.length,
    codes: diagnoses.length,
    plans: plans.length,
    locked: lock !== null,
  }
  const ok = illegal.length === 0 && missing.length === 0 && diagnostics.length === 0

  const report = {
    ok,
    root: absoluteRoot,
    docsRoot,
    docsRootExists,
    documents,
    illegal,
    missing,
    diagnostics,
    diagnoses,
    plans,
    lock,
    summary,
  }
  report.text = formatReport(report)
  return report
}
