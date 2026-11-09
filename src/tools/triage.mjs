/**
 * `coder_triage`：那个「发起排查」的对话把方案交回主机的工具。
 *
 * 为什么不让它自己写文件：格式、编号、字段长度都由这里统一收口 —— 对话只负责判断真假、
 * 写清楚怎么改；落盘是机械动作（`src/solutions.mjs`）。
 *
 * 写到 `<repo>/.coder/runs/<runId>/solutions.jsonl`，页面「解决方案」Tab 读的就是这份。
 */
import { saveSolutions } from '../solutions.mjs'

/**
 * @returns {object}
 */
export function createTriageTool() {
  return {
    name: 'coder_triage',
    description: [
      'Submit the solutions for the latest diagnosis report, after triaging which diagnostics are real problems.',
      'The page starts that triage as a conversation; the conversation reads <repo>/.coder/runs/<runId>/ and must call this tool with the solutions',
      'it believes in. Each solution names the diagnostic code, what the problem is, how to fix it, and which files it touches.',
      'This tool only records them (it writes solutions.jsonl inside the run directory); it never changes source code.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'repo', 'runId'],
      properties: {
        action: {
          type: 'string',
          enum: ['submit'],
          description: 'submit records the solutions for one run.',
        },
        repo: {
          type: 'string',
          description: 'Repository root the run belongs to, e.g. "C:/work/app".',
        },
        runId: {
          type: 'string',
          description: 'The run id from the task you were given, e.g. "20261107-231500-2d188e".',
        },
        solutions: {
          type: 'array',
          description: 'The solutions, in the order they should be shown. Real problems only — drop the false positives instead of listing them.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'fix'],
            properties: {
              code: { type: 'string', description: 'The diagnostic code this solves, e.g. "D001".' },
              title: { type: 'string', description: 'One line: what the fix does.' },
              problem: { type: 'string', description: 'Why this is a real problem (evidence from the run).' },
              fix: { type: 'string', description: 'How to fix it: concrete steps, files, functions.' },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files the fix touches.',
              },
              risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How risky the change is.' },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'How sure you are that this is a real problem.',
              },
            },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (!value || value.ok === false) return `coder_triage 失败：${value?.message ?? '未知错误'}`
        return `coder_triage：已记下 ${value.count} 个方案（${value.runId} → ${value.file}）`
      },
    },
    timeoutMs: 30_000,

    /**
     * @param {object} args
     * @returns {Promise<object>}
     */
    async execute(args) {
      const repo = String(args?.repo ?? '').trim()
      const runId = String(args?.runId ?? '').trim()
      if (!repo) return { ok: false, code: 'BAD_ARGS', message: '缺少参数 repo' }
      if (!runId) return { ok: false, code: 'BAD_ARGS', message: '缺少参数 runId' }

      const saved = await saveSolutions(repo, runId, args?.solutions).catch((error) => {
        if (error?.code === 'RUN_NOT_FOUND') return null
        throw error
      })
      if (!saved) return { ok: false, code: 'NO_RUN', message: `找不到这次运行：${runId}（先跑一次 coder_debug）` }
      if (saved.solutions.length === 0) {
        return {
          ok: false,
          code: 'BAD_ARGS',
          message: saved.problems[0] ?? 'solutions 不能为空：每个方案至少要有 title 或 fix',
        }
      }
      return {
        ok: true,
        runId: saved.runId,
        count: saved.solutions.length,
        file: saved.file,
        problems: saved.problems,
      }
    },
  }
}
