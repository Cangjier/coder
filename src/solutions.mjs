/**
 * 「解决方案」的数据层：`<repo>/.coder/runs/<runId>/solutions.jsonl`。
 *
 * 谁写：那个「发起排查」的对话，通过 `coder_triage` 工具交回方案，主机校验后落盘
 * （对话自己不碰文件）。谁读：左侧栏 Coder 的「解决方案」Tab，最新一次运行的那份。
 *
 * 每条方案一行 JSON：报告里用「第 N 条」指代，`id` 从 1 开始按落盘顺序给。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 一次最多收这么多条方案。 */
const MAX_SOLUTIONS = 200

/** 单个字段的长度上限（字符数）—— 再长就不适合在页面里读了。 */
const LIMITS = { code: 40, title: 200, problem: 4000, fix: 4000, file: 300 }

const RISKS = ['low', 'medium', 'high']
const CONFIDENCES = ['high', 'medium', 'low']

/**
 * runId 只允许字母、数字和连字符（要拼进路径）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRunId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(String(value ?? ''))
}

/**
 * 收下并校验一批方案：字段裁掉空白与长度，`id` 按顺序重排。
 *
 * @param {unknown} raw
 * @returns {{ solutions: Array<object>, problems: Array<string> }}
 */
export function normalizeSolutions(raw) {
  const problems = []
  const list = Array.isArray(raw) ? raw : []
  const solutions = []
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== 'object') {
      problems.push(`第 ${index + 1} 条不是对象，跳过`)
      continue
    }
    const title = clip(item.title, LIMITS.title)
    const problem = clip(item.problem, LIMITS.problem)
    const fix = clip(item.fix, LIMITS.fix)
    if (!title && !problem && !fix) {
      problems.push(`第 ${index + 1} 条既没有 title 也没有 problem/fix，跳过`)
      continue
    }
    const files = Array.isArray(item.files)
      ? item.files.map((file) => clip(file, LIMITS.file)).filter(Boolean).slice(0, 50)
      : []
    solutions.push({
      id: solutions.length + 1,
      code: clip(item.code, LIMITS.code),
      title: title || firstLine(problem || fix),
      problem,
      fix,
      files,
      risk: pick(item.risk, RISKS, 'medium'),
      confidence: pick(item.confidence, CONFIDENCES, 'medium'),
    })
    if (solutions.length >= MAX_SOLUTIONS) {
      problems.push(`超过 ${MAX_SOLUTIONS} 条，后面的丢掉了`)
      break
    }
  }
  return { solutions, problems }
}

/**
 * 把一批方案写到 `<repo>/.coder/runs/<runId>/solutions.jsonl`（先写临时文件再改名）。
 *
 * @param {string} dir 仓库根目录
 * @param {string} runId
 * @param {unknown} raw
 * @returns {Promise<{ runId: string, solutions: Array<object>, problems: Array<string>, file: string }>}
 */
export async function saveSolutions(dir, runId, raw) {
  if (!isRunId(runId)) throw notFound(`runId 不合法：${runId}`)
  const runDir = path.join(dir, '.coder', 'runs', String(runId))
  const stat = await fs.stat(runDir).catch(() => null)
  if (!stat?.isDirectory()) throw notFound(`找不到这次运行：${runId}`)

  const { solutions, problems } = normalizeSolutions(raw)
  const file = path.join(runDir, 'solutions.jsonl')
  const text = solutions.map((solution) => JSON.stringify(solution)).join('\n')
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text ? `${text}\n` : '', 'utf8')
  await fs.rename(tmp, file)
  return { runId: String(runId), solutions, problems, file }
}

/**
 * 最新一次带方案的运行：`{ runId, solutions }`；一次都没有就是 null。
 *
 * 「最新」= 运行目录名最大的那个（名字里带时间）。
 *
 * @param {string} dir 仓库根目录
 * @returns {Promise<{ runId: string, solutions: Array<object> } | null>}
 */
export async function readLatestSolutions(dir) {
  const root = path.join(dir, '.coder', 'runs')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isRunId(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const runId of candidates) {
    const file = path.join(root, runId, 'solutions.jsonl')
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    const solutions = []
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim()
      if (!value) continue
      try {
        const parsed = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) solutions.push(parsed)
      } catch {
        // 坏行跳过
      }
    }
    return { runId, solutions: withIds(solutions) }
  }
  return null
}

/**
 * 读某一次运行的方案（页面「对勾选的发起正式解决」要用）。
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {Promise<Array<object>>}
 */
export async function readSolutions(dir, runId) {
  if (!isRunId(runId)) return []
  const file = path.join(dir, '.coder', 'runs', String(runId), 'solutions.jsonl')
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return []
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed)
    } catch {
      // 坏行跳过
    }
  }
  return withIds(rows)
}

/**
 * 缺 id 的行按位置补一个（老文件/手写文件也认）。
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
function withIds(rows) {
  return rows.map((row, index) => ({ ...row, id: Number.isFinite(row.id) ? Number(row.id) : index + 1 }))
}

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function clip(value, limit) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, limit)
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, LIMITS.title)
}

/**
 * @param {unknown} value
 * @param {Array<string>} allowed
 * @param {string} fallback
 * @returns {string}
 */
function pick(value, allowed, fallback) {
  const text = String(value ?? '').trim().toLowerCase()
  return allowed.includes(text) ? text : fallback
}

/**
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function notFound(message) {
  const error = new Error(message)
  error.code = 'RUN_NOT_FOUND'
  return error
}
