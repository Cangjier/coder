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
      `Optional documents — ${DOCS_DIR}/design/module-NNNN.md, ${DOCS_DIR}/issues/open/issue-NNNN.md, ${DOCS_DIR}/issues/close/issue-NNNN.md, ${DOCS_DIR}/logs/audit/YYYY-MM-DD-NNN.md, ${DOCS_DIR}/logs/update/YYYY-MM-DD-NNN.md, ${DOCS_DIR}/logs/usage/YYYY-MM-DD-NNN.md, ${DOCS_DIR}/members/all.md, plan entry files, ${DOCS_DIR}/members/flow.md, and the optional ${DOCS_DIR}/manifest.json — are checked when present and are never reported as missing.`,
      'Each present Markdown document is diagnosed against the coder design format: file.md path headings and positive-only descriptions, architecture.md global and local views with Mermaid diagrams, flow.md scenarios with mermaid diagrams, and data_structure.md sections with TypeScript interface blocks. Diagnostics carry a stable rule code and a line number.',
      'The diagnosis documents use # E0001 / # W0001 headings: error.md accepts only E codes and warn.md only W codes, each followed by 4 digits. Either diagnosis document may be empty: that means no diagnosis code exists yet (no problem needing diagnosis has been found), is a valid state, and draws no diagnostic. Every code needs a 作用范围 line (全局 or a file path glob), one 诊断方式 line (静态代码审查 or 运行时日志审查), and 步骤N lines. Static steps must read 步骤N：查看 [glob] location，如果 ...，则 ...，否则 ...; runtime steps either insert a ts log block (步骤N：在 [glob] location，插入日志：) or read the log (步骤N：查看日志，如果 ...). list checks step formats, consecutive numbering, glob matches, and ts log fences; when a scope is a file glob it must match at least one project file.',
      'Plan entries are one file each: .coder/plan/todo/T0001.md (active todo), .coder/plan/todo/archived/T0001.md (archived todo), .coder/plan/goal/G0001.md (active goal), and .coder/plan/goal/archived/G0001.md (archived goal). The todo directory accepts only T codes and the goal directory only G codes, with 4 digits; the file holds exactly one # T0001 / # G0001 heading whose code must match the file name. Plan files are optional and are never reported as missing: an absent plan directory means no entries, while a plan file with an empty body or a second # heading is reported. A todo needs 任务范围 (全局 or a file path glob), 优先级 (P1/P2/P3), 完成预期 and 当前进度 sections; a goal needs 任务范围, 完成预期 and 关联ToDo. Numbered items must start at 1 and stay consecutive; 完成预期 items read 如果 ... 则 ...，否则 ...; 当前进度 items read [glob] description; 关联ToDo items are T codes. A code may not stay in both the active directory and archived/: completed tasks move to archived/.',
      'Modules extend the design documents: design/modules.md is the expected module index of # NNNN codes with a description each, and design/module-NNNN.md is an optional detail file with # 架构 (## 全局视角 required, ## 局部视角 optional), # 流程, # 数据结构, and an optional # 子模块 section. Every indexed module needs its detail file; every detail file must be indexed; submodules must point at existing modules. A module document reuses the architecture, flow, and data_structure checks.',
      'Issues are one file per problem: .coder/issues/open/issue-NNNN.md for an open issue and .coder/issues/close/issue-NNNN.md for a closed one, with a 4-digit file name. Status lives in the folder: an issue file never writes # 状态, and writing it is reported. An open issue file holds # 问题 (required), optional # 复现 and # 建议, # 提交源 (required), and # 当前进度 (required, one line [glob] 当前进度为 ...). A closed issue file holds # 问题, optional # 复现 and # 建议, # 提交源, and # 关闭原因 (required). Those sections must appear in that order, each with a non-empty body. Files are optional and are checked only when present; a code cannot appear in both open/ and close/. create_issue uses the maximum existing code plus one.',
      'Logs are one file per entry under three directories: logs/audit/ (audit log), logs/update/ (product release changelog), and logs/usage/ (business usage reports). The file name is YYYY-MM-DD-NNN.md with a real calendar date and a 3-digit sequence; within one directory and day the sequence must start at 001 and stay consecutive. The only heading is # YYYY-MM-DD-NNN and must match the file name; fields follow on plain lines. audit needs 审计范围 and 审计结论, update needs 版本 and 更新内容 followed by numbered items that start at 1 and stay consecutive, usage needs 使用场景 and 使用反馈; every kind accepts an optional 说明 last. Field order is fixed, values must be non-empty, and extra headings or body lines are reported. Logs are optional and are never reported as missing; render does not include them.',
      'manifest.json is optional configuration. It currently accepts one key, largeCodeFileBytes (a positive integer, default 20480): a source file whose extension is a code extension and whose size is greater than this threshold is reported as a hint, not an error, so ok stays true. The hint section lists the file, its size, and the threshold; .git, node_modules, dist, build, out, target, vendor, coverage, tmp and other artifact directories are skipped. Invalid JSON, an unknown key, or a non-positive value is a diagnostic.',
      'The readable text report prints counts only and does not enumerate every document path; only illegal and missing paths are listed, and plan, issue and log entries are counted rather than listed. The structured result still contains every document, plan, issue and log. Member documents are optional collaboration records. members/all.md starts with # 主对话 holding 身份 and 工作范围, then zero or more # 成员N sections, each holding 工作区名称, 身份, and 工作范围 in that order, with an optional 备注 last; values must be non-empty and a section body contains only those field lines. members/flow.md explains how the main conversation and members work together and reuses the flow.md rules: ## scenarios, each with a non-empty mermaid diagram.',
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
