/**
 * 设计文档的结构检查：architecture.md、flow.md 与 data_structure.md。
 *
 * 这些检查只回答「结构是否符合约定」，不判断图是否真的描述了代码：
 *
 * - architecture.md 用若干 `## 视角` 表达架构，第一个必须是全局视角；
 * - flow.md 用若干 `## 场景` 表达流程，每个场景至少一张 mermaid 图；
 * - data_structure.md 用若干 `## 结构` 分段，每段至少一个 ts interface。
 *
 * `module-NNNN.md` 里的 `# 架构`、`# 流程`、`# 数据结构` 复用同一套检查，
 * 只是局部视角在模块文档里是可选的。
 *
 * 这里没有任何模型调用；判不了的（例如图是否准确、字段是否完整）不猜也不报。
 *
 * @module coder/design
 */

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
 * @param {ReturnType<import('./markdown.js').analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
export function validateData(doc, analysis) {
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
 * @param {ReturnType<import('./markdown.js').analyzeMarkdown>} analysis - 解析结果。
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
 * @param {ReturnType<import('./markdown.js').analyzeMarkdown>} analysis - 解析结果。
 * @param {{requireLocal?: boolean}} [options] - `requireLocal` 为 false 时允许没有局部视角，供模块文档使用。
 * @returns {object[]} 诊断。
 */
export function validateArchitecture(doc, analysis, options = {}) {
  const requireLocal = options.requireLocal !== false
  const diagnostics = []
  const { lines, headings } = analysis
  const views = headings
    .map((heading, index) => ({ heading, index }))
    .filter((entry) => entry.heading.level === 2)

  if (views.length === 0) {
    diagnostics.push(diagnostic(doc, 1, 'architecture.no-view', '没有 ## 视角。'))
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
    diagnostics.push(diagnostic(doc, 1, 'architecture.global.missing', `缺少 ## ${GLOBAL_VIEW}。`))
  } else {
    for (const extra of globals.slice(1)) {
      diagnostics.push(
        diagnostic(doc, extra.line, 'architecture.global.multiple', `只能有一个 ## ${GLOBAL_VIEW}。`),
      )
    }
  }
  if (requireLocal && !views.some((entry) => LOCAL_VIEW.test(entry.heading.text.trim()))) {
    diagnostics.push(diagnostic(doc, 1, 'architecture.local.missing', '至少需要一个 ## 局部视角：<名称>。'))
  }

  return diagnostics
}

/**
 * 校验 flow.md。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<import('./markdown.js').analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
export function validateFlow(doc, analysis) {
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
