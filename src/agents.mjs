/**
 * 子代理：每一步都由一个独立代理完成，互不共享上下文。
 */
import { CoderError } from './errors.mjs'
import { agentOptionsOf } from './config.mjs'

/**
 * 日志前缀：`coder_codes triage` → `coder_codes`。
 *
 * @param {string} label
 * @returns {string}
 */
function toolOf(label) {
  return String(label ?? '').split(' ')[0] || 'coder'
}

/**
 * @param {object} result
 * @returns {{ stopReason: string, text: string, structured: unknown }}
 */
export function normalizeResult(result) {
  const blocks = Array.isArray(result?.output) ? result.output : []
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  let structured = result?.structured
  if (structured === undefined || structured === null) structured = parseJsonLoose(text)
  return { stopReason: result?.stopReason ?? 'unknown', text, structured }
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * @param {object} ctx
 * @param {object} config
 * @returns {{ subagents: object, provider: string, available: string[] }}
 */
export function requireSubagents(ctx, config) {
  const subagents = ctx.get ? ctx.get('subagents') : undefined
  if (!subagents || typeof subagents.startActivation !== 'function') {
    throw new CoderError('NO_SUBAGENTS', '当前 profile 没有 subagents 服务，coder_debug 无法起独立代理。')
  }
  let names = []
  try {
    names = typeof subagents.list === 'function' ? subagents.list() : []
  } catch {
    names = []
  }

  const configured = String(config.subagentProvider ?? 'auto')
  if (configured !== 'auto') {
    if (names.length > 0 && !names.includes(configured)) {
      throw new CoderError('NO_PROVIDER', `子代理 provider「${configured}」不可用；可用：${names.join(', ')}`)
    }
    return { subagents, provider: configured, available: names }
  }
  for (const candidate of ['spawn', 'local']) {
    if (names.includes(candidate)) return { subagents, provider: candidate, available: names }
  }
  if (names.length > 0) return { subagents, provider: names[0], available: names }
  return { subagents, provider: 'spawn', available: names }
}

/**
 * @param {{
 *   ctx: object, config: object, parent: object, cwd: string, prompt: string,
 *   label: string, schema?: object, signal?: AbortSignal, logger?: object,
 * }} options
 * @returns {Promise<{ childId: string, stopReason: string, text: string, structured: unknown }>}
 */
export async function callAgent(options) {
  const { ctx, config, parent, cwd, prompt, label, schema, signal, logger } = options
  const { subagents, provider } = requireSubagents(ctx, config)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.agentTimeoutMs)
  const forwardAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', forwardAbort, { once: true })
  }

  let activation = null
  try {
    activation = await subagents.startActivation({
      provider,
      label,
      request: {
        cwd,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: controller.signal,
        ...(schema ? { outputSchema: schema } : {}),
        ...(agentOptionsOf(config) ? { agentOptions: agentOptionsOf(config) } : {}),
      },
      signal: controller.signal,
      delivery: 'caller',
    })
  } catch (error) {
    clearTimeout(timeout)
    if (signal) signal.removeEventListener('abort', forwardAbort)
    throw new CoderError(
      'AGENT_START_FAILED',
      `无法启动子代理（${label}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    const result = await activation.result
    const normalized = normalizeResult(result)
    if (normalized.stopReason !== 'completed') {
      logger?.warn?.(`${toolOf(label)}: 子代理 ${label} 结束原因 ${normalized.stopReason}`)
    }
    return { childId: String(activation.childId ?? ''), ...normalized }
  } finally {
    clearTimeout(timeout)
    if (signal) signal.removeEventListener('abort', forwardAbort)
    try {
      await activation.dispose?.()
    } catch {
      // dispose 失败不影响结果。
    }
  }
}

/**
 * 一个步骤 = 一个独立代理 + 结构化输出校验（不合格带着问题重来一次）。
 *
 * 标签统一成 `<prefix> <name>`，一个前缀对应一个工具，日志和子代理列表里一眼能看出是哪一步。
 *
 * @param {{
 *   ctx: object, config: object, logger?: object, parent: object, repoDir: string,
 *   prefix?: string, name: string, prompt: string, schema?: object,
 *   validate: (structured: unknown) => string | null | Promise<string | null>,
 * }} options
 * @returns {Promise<{ childId: string, structured: any, attempts: number }>}
 */
export async function runStep(options) {
  const { ctx, config, logger, parent, repoDir, prefix = 'coder_debug', name, prompt, schema, validate } = options
  return callAgentChecked({
    ctx,
    config,
    logger,
    parent,
    cwd: repoDir,
    prompt,
    label: `${prefix} ${name}`,
    schema,
    validate,
  })
}

/**
 * 起子代理并校验结构化输出；不合格带着问题重来一次。
 *
 * @param {Parameters<typeof callAgent>[0] & { validate: (structured: unknown) => string | null | Promise<string | null> }} options
 * @returns {Promise<{ childId: string, structured: any, attempts: number }>}
 */
export async function callAgentChecked(options) {
  const { validate, logger, ...rest } = options
  let prompt = rest.prompt
  let lastProblem = '结构化输出为空'
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = await callAgent({ ...rest, prompt })
    if (outcome.structured && typeof outcome.structured === 'object') {
      const problem = await validate(outcome.structured)
      if (!problem) return { childId: outcome.childId, structured: outcome.structured, attempts: attempt }
      lastProblem = problem
    } else {
      lastProblem = '回复里没有可解析的 JSON 对象'
    }
    logger?.warn?.(`${toolOf(rest.label)}: ${rest.label} 第 ${attempt} 次输出不合格：${lastProblem}`)
    prompt = `${rest.prompt}\n\n## 上一次的输出不合格\n${lastProblem}\n请只返回符合要求的 JSON，不要解释。`
  }
  throw new CoderError('AGENT_INVALID', `${rest.label} 连续两次输出不合格：${lastProblem}`)
}
