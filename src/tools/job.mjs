/**
 * `coder_job`：让那个被开出来的对话把「搜集结果」交回服务，而不是写文件。
 *
 * 页面点「让 DSH 搜集」时先建一条任务（见 src/jobs.mjs），把 jobId 写进提示词；
 * 对话做完调这个工具提交 `targets`，任务表收到后立刻通知正在等的页面
 * （SSE 推送 / 下次回来查一次）。这样：
 * - 页面不用轮询；
 * - 用户中途离开也没关系，结果留在服务端，回来还能取；
 * - 文件不被偷偷改动，保不保存由人决定。
 */
import { targetsOf } from '../codes-client.js'

/**
 * @param {object} jobs `createJobStore()` 的返回值
 * @returns {object}
 */
export function createJobTool(jobs) {
  return {
    name: 'coder_job',
    description: [
      'Report the result of one "collect targets" job started from the Diagnostic codes page.',
      'A job is created when the page asks DSH to collect the classes / interfaces / methods one code is about;',
      'the conversation that does the work must call this tool when it is done, otherwise the page never receives the result.',
      'submit writes the targets into the job (the page fills them into the editor; nothing is saved to disk).',
      'fail records why there is no result, so the page can show that reason instead of waiting.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'jobId'],
      properties: {
        action: {
          type: 'string',
          enum: ['submit', 'fail'],
          description: 'submit reports the collected targets; fail reports that there is no result.',
        },
        jobId: {
          type: 'string',
          description: 'The job id from the task you were given, e.g. "job-abc123".',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'submit: class / interface / method names, or a plain-language description. Exact names first; describe when you can only bound the area.',
        },
        message: {
          type: 'string',
          description: 'fail: why no targets could be collected.',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (!value || value.ok === false) return `coder_job 失败：${value?.message ?? '未知错误'}`
        if (value.status === 'done') return `coder_job：已提交，任务 ${value.jobId} 完成（${value.count} 项）`
        return `coder_job：任务 ${value.jobId} 记为失败`
      },
    },
    timeoutMs: 30_000,

    /**
     * @param {object} args
     * @returns {Promise<object>}
     */
    async execute(args) {
      const action = String(args?.action ?? '')
      const jobId = String(args?.jobId ?? '').trim()
      if (!jobId) return { ok: false, code: 'BAD_ARGS', message: '缺少参数 jobId' }
      const job = jobs.get(jobId)
      if (!job) return { ok: false, code: 'NO_JOB', message: `没有这个任务：${jobId}（可能已过期，请让用户重新点一次搜集）` }

      if (action === 'submit') {
        const targets = targetsOf(args?.targets)
        if (targets.length === 0) return { ok: false, code: 'BAD_ARGS', message: 'targets 不能为空' }
        const finished = jobs.finish(jobId, { status: 'done', targets })
        return { ok: true, jobId, status: finished?.status ?? 'done', count: targets.length }
      }
      if (action === 'fail') {
        const message = String(args?.message ?? '').trim() || '对话没有给出结果'
        jobs.finish(jobId, { status: 'failed', error: message })
        return { ok: true, jobId, status: 'failed', message }
      }
      return { ok: false, code: 'BAD_ARGS', message: `未知 action：${action}` }
    },
  }
}
