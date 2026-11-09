/**
 * 工具的注册入口。
 *
 * - `coder_codes`：文档 → 诊断码（docs/codes.jsonl + 编辑页）；
 * - `coder_debug`：诊断码 → 静态审查 + 两套并行运行期检查；
 * - `coder_job`：把「让 DSH 搜集 targets」的结果交回服务端任务表；
 * - `coder_triage`：把「发起排查」得出的解决方案写进这次运行目录（solutions.jsonl）。
 *
 * 注册失败只报错不抛：别的工具照样能用。
 */
import { createCodesTool } from './codes.mjs'
import { createDebugTool } from './debug.mjs'
import { createJobTool } from './job.mjs'
import { createTriageTool } from './triage.mjs'

/**
 * @param {object} ctx
 * @param {object} toolsCtx
 * @param {object} config
 * @param {object} logger
 * @param {object} [jobs] `createJobStore()` 的返回值；没有就跳过 coder_job
 * @returns {{ registered: string[], failed: Array<{ name: string, error: string }> }}
 */
export function registerTools(ctx, toolsCtx, config, logger, jobs) {
  const factories = [
    { name: 'coder_codes', create: () => createCodesTool(ctx, config, logger) },
    { name: 'coder_debug', create: () => createDebugTool(ctx, config, logger) },
    ...(jobs ? [{ name: 'coder_job', create: () => createJobTool(jobs) }] : []),
    { name: 'coder_triage', create: () => createTriageTool() },
  ]

  const registered = []
  const failed = []
  for (const factory of factories) {
    try {
      const definition = factory.create()
      toolsCtx.tools.register(definition)
      registered.push(definition.name)
      logger?.info?.(`coder: 已注册工具 ${definition.name}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ name: factory.name, error: message })
      logger?.error?.(`coder: 注册工具 ${factory.name} 失败：${message}`)
    }
  }
  return { registered, failed }
}
