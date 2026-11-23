/**
 * `list` 工具定义。
 *
 * 这个工具只有一个动作：把项目里的 `.coder/` 文档树读一遍并如实报告。
 * 没有 guide、没有 status、没有写入——需要知道的都在描述和返回结果里。
 *
 * @module coder/tools/list
 */

import { CoderError, DOCS_DIR, EXPECTED_DOCS, inspectDocs } from '../docs.js'
import { resolveRoot } from './root.js'

/**
 * 构造 `list` 工具。
 *
 * @param {object} logger - 插件 logger。
 * @returns {object} 可以直接交给 `ctx.tools.register` 的工具定义。
 */
export function createListTool(logger) {
  const expected = EXPECTED_DOCS.map((doc) => `${DOCS_DIR}/${doc}`).join(', ')
  return {
    name: 'list',
    description: [
      `List every document under the project's ${DOCS_DIR}/ documentation tree and check it.`,
      `Expected documents are ${expected}. ${DOCS_DIR}/lock.md is also whitelisted, is reported with status lock, and is not rendered; any other file under ${DOCS_DIR}/ is reported as illegal, and an expected document that is absent is reported as missing.`,
      'Each present Markdown document is diagnosed against the coder design format: file.md path headings and positive-only descriptions, architecture.md global and local views with Mermaid diagrams, flow.md scenarios with mermaid diagrams, and data_structure.md sections with TypeScript interface blocks. Diagnostics carry a stable rule code and a line number.',
      'The diagnosis documents use # E0001 / # W0001 headings: error.md accepts only E codes and warn.md only W codes, each followed by 4 digits. Either diagnosis document may be empty: that means no diagnosis code exists yet (no problem needing diagnosis has been found), is a valid state, and draws no diagnostic. Every code needs a 作用范围 line (全局 or a file path glob), one 诊断方式 line (静态代码审查 or 运行时日志审查), and 步骤N lines. Static steps must read 步骤N：查看 [glob] location，如果 ...，则 ...，否则 ...; runtime steps either insert a ts log block (步骤N：在 [glob] location，插入日志：) or read the log (步骤N：查看日志，如果 ...). list checks step formats, consecutive numbering, glob matches, and ts log fences; when a scope is a file glob it must match at least one project file.',
      'The plan documents use # T0001 / # G0001 headings: todo.md and todo-archived.md accept T codes, goal.md and goal-archived.md accept G codes. A todo needs 任务范围 (全局 or a file path glob), 优先级 (P1/P2/P3), 完成预期 and 当前进度 sections; a goal needs 任务范围, 完成预期 and 关联ToDo. Numbered items must start at 1 and stay consecutive; 完成预期 items read 如果 ... 则 ...，否则 ...; 当前进度 items read [glob] description; 关联ToDo items are T codes. Empty plan documents are valid. A code may not stay in both the active and archived document; completed tasks belong only to the archived file.',
      'file.md paths support globs: * matches within one segment, ** matches zero or more segments, and tmp/** expresses the directory and its files at once. Every project file except .coder/ and its contents must be matched by at least one file.md path or glob. Describing .coder/ itself or any path under it in file.md is an error.',
      'When .coder/lock.md exists, list parses its fixed declaration and hash line and recomputes the hash over every .coder file except lock.md; a mismatch is reported as lock.hash.mismatch so the direct edit can be investigated. The lock is a soft constraint: list only detects changes, it does not block writes.',
      'Read-only and deterministic: it never writes, never calls a model, and returns the same report for the same tree. Use it before and after editing .coder/ documents to know exactly what is wrong.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Project root that contains the .coder/ docs directory. Defaults to the session working directory; the result always reports the absolute path that was used.',
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
    isConcurrencySafe: () => true,

    /**
     * @param {{root?: string}} args - 工具参数。
     * @param {object} context - 工具执行上下文。
     * @returns {Promise<object>} 结构化报告。
     */
    async execute(args, context) {
      const root = resolveRoot(args, context)
      try {
        const report = await inspectDocs({ root })
        logger.info(
          `coder: list found ${report.summary.found}/${report.summary.expected} expected docs, ${report.summary.illegal} illegal, ${report.summary.missing} missing, ${report.summary.diagnostics} diagnostics, ${report.summary.plans} plans`,
        )
        return report
      } catch (error) {
        if (error instanceof CoderError) throw error
        throw new CoderError(
          `检查 ${root} 下的 ${DOCS_DIR}/ 失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}
