/**
 * 构建 / 启动步骤的规范形状：`{ type: "cmd" | "dsh-plugin", entry, input? }[]`。
 *
 * - `cmd`：在工作区里跑一条 shell 命令；
 * - `dsh-plugin`：让 DSH 调用名为 `entry` 的**工具**（插件），`input` 是它的入参（JSON 字符串）。
 *   这就是「用 xl_build 来 build」的那种约定：不是拼一条命令，而是指名道姓地调那个工具。
 *
 * 字符串是简写，等于一条 `cmd`。`entry` 与 `input` 里的 `{{worktree}}` 会在执行前换成工作区绝对路径。
 */
import { CoderError } from './errors.mjs'

export const STEP_TYPES = ['cmd', 'dsh-plugin']
export const WORKTREE_TOKEN = '{{worktree}}'

/**
 * 工具入参：直接就是 JSON 对象（`{"paths":["src"]}`），不是一段字符串。
 *
 * 仍然接受 JSON 字符串——那是旧写法，也有人在配置里写不出对象——但内部一律当对象用。
 *
 * @param {unknown} input
 * @param {string} where
 * @returns {{ input?: object, args: object }}
 */
function parseInput(input, where) {
  if (input === undefined || input === null) return { args: {} }

  let parsed
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return { args: {} }
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new CoderError('BAD_ARGS', `${where} 的 input 必须是 JSON 对象：${text}（${error.message}）`)
    }
  } else {
    parsed = input
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CoderError('BAD_ARGS', `${where} 的 input 必须是 JSON 对象，例如 {"paths":["src"]}`)
  }
  if (Object.keys(parsed).length === 0) return { args: {} }
  return { input: parsed, args: parsed }
}

/**
 * @param {unknown} item
 * @param {string} where
 * @returns {{ type: string, entry: string, input?: object, args: object } | null}
 */
function normalizeStep(item, where) {
  if (typeof item === 'string') {
    const entry = item.trim()
    return entry ? { type: 'cmd', entry, args: {} } : null
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new CoderError('BAD_ARGS', `${where} 应为 {type, entry} 对象，收到：${JSON.stringify(item)}`)
  }

  const type = item.type === undefined || item.type === null ? 'cmd' : String(item.type)
  if (!STEP_TYPES.includes(type)) {
    throw new CoderError('BAD_ARGS', `${where} 的 type 只接受 ${STEP_TYPES.join(' / ')}，收到：${type}`)
  }

  const entry = String(item.entry ?? '').trim()
  if (!entry) throw new CoderError('BAD_ARGS', `${where} 缺 entry`)

  const { input, args } = parseInput(item.input, where)
  if (type === 'cmd' && input) {
    throw new CoderError('BAD_ARGS', `${where} 是 cmd，不需要 input；命令本身写在 entry 里`)
  }

  return { type, entry, args, ...(input ? { input } : {}) }
}

/**
 * 解析 `build` / `launch`：数组、字符串简写都认，逐项校验。
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {Array<{ type: string, entry: string, input?: string, args: Record<string, unknown> }>}
 */
export function parseProgram(value, label) {
  if (value === undefined || value === null) return []
  const raw = Array.isArray(value) ? value : [value]
  const steps = []
  raw.forEach((item, index) => {
    const step = normalizeStep(item, `${label} 第 ${index + 1} 项`)
    if (step) steps.push(step)
  })
  return steps
}

/**
 * 提示词 / 报告里的写法：每一步是什么类型、谁会被执行。
 *
 * @param {Array<{ type: string, entry: string, input?: object }>} steps
 * @returns {string[]}
 */
export function describeProgram(steps) {
  return (Array.isArray(steps) ? steps : []).map((step, index) => {
    if (step.type === 'dsh-plugin') {
      const input = step.input && Object.keys(step.input).length > 0 ? ` ${JSON.stringify(step.input)}` : ''
      return `${index + 1}. [DSH 工具] ${step.entry}${input}`
    }
    return `${index + 1}. [命令] ${step.entry}`
  })
}

/**
 * 执行前把 `{{worktree}}` 换成工作区路径。
 *
 * @param {string} text
 * @param {string} worktree
 * @returns {string}
 */
export function withWorktree(text, worktree) {
  const value = String(text ?? '')
  if (!value.includes(WORKTREE_TOKEN)) return value
  return value.split(WORKTREE_TOKEN).join(worktree)
}
