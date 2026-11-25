/**
 * `render` 工具定义。
 *
 * 把 `.coder/` 的预期文档（设计、诊断与计划）、存在的模块详情和存在的成员
 * 文档渲染成一个 HTML 页面，默认写到 `dist/.coder/design.html`。工具只写这
 * 一个文件，不改文档。
 *
 * @module coder/tools/render
 */

import { CoderError } from '../docs.js'
import { renderDesign } from '../render.js'
import { resolveRoot } from './root.js'

/**
 * 构造 `render` 工具。
 *
 * @param {object} logger - 插件 logger。
 * @returns {object} 可以直接交给 `ctx.tools.register` 的工具定义。
 */
export function createRenderTool(logger) {
  return {
    name: 'render',
    description: [
      'Render the .coder/ design, diagnosis, and plan Markdown documents into one design.html page.',
      'By default the page is written to dist/.coder/design.html; pass "out" to choose another output directory. The file name is always design.html.',
      'The page embeds the expected documents, every present design/module-NNNN.md, and every present members/all.md or members/flow.md: file.md becomes a collapsible tree table with indentation guides, architecture.md and flow.md become Markdown with Mermaid diagrams, data_structure.md becomes Markdown with TypeScript blocks, modules.md and module detail files become Markdown, member documents become Markdown, error.md / warn.md become Markdown diagnosis-code catalogues, and plan/todo.md, todo-archived.md, goal.md, and goal-archived.md become Markdown plan catalogues. Issue documents are implementation records and are not rendered. The left sidebar is a table of contents. The page shows no extra status or hint copy. Markdown is rendered with marked and Mermaid diagrams with mermaid, both loaded from jsDelivr in the browser; without the CDN the page falls back to the Markdown source.',
      'Read-only with respect to the documents: it writes only the HTML page. The output is deterministic for the same documents; it returns the absolute output path, the byte size, and the current document status.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Project root that contains the .coder/ docs directory. Defaults to the session working directory; the result always reports the absolute path that was used.',
        },
        out: {
          type: 'string',
          description:
            'Output directory, relative to root or absolute. Defaults to dist/.coder. The file written inside it is always design.html.',
        },
      },
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
     * @param {{root?: string, out?: string}} args - 工具参数。
     * @param {object} context - 工具执行上下文。
     * @returns {Promise<object>} 渲染结果。
     */
    async execute(args, context) {
      const root = resolveRoot(args, context)
      const out = args?.out === undefined || args?.out === null ? undefined : args.out
      try {
        const result = await renderDesign({ root, outDir: out })
        logger.info(`coder: rendered ${result.output} (${result.bytes} bytes)`)
        return result
      } catch (error) {
        if (error instanceof CoderError) throw error
        throw new CoderError(
          `渲染 ${root} 的设计文档失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}
