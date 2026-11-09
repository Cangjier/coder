/**
 * 读 `coder_debug` 留下的诊断报告（`<repo>/.coder/runs/<runId>/`）。
 *
 * 页面「诊断报告」用的就是这里：只读，按运行目录里已经落盘的东西说话 ——
 * `summary.json`（这次运行的范围、复核结论、计数，有就读）、`diagnostics.jsonl`（诊断行）、
 * `codes.jsonl`（这次用的码快照，页面拿它给诊断分组）。页面只看最新的一次。
 *
 * runId 是 `<YYYYMMDD>-<HHMMSS>-<随机>`，时间就藏在名字里，"最新" 就是这个名字最大的那个。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** 一次最多回这么多条诊断：再多也不适合在页面里读。 */
const MAX_DIAGNOSTICS = 2000

/**
 * runId 只允许字母、数字和连字符，且不能以连字符开头 —— 它要拼进路径，不能有 `..` 或分隔符。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRunId(value) {
  const text = String(value ?? '')
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(text)
}

/**
 * 最新的那次运行：摘要 + 诊断行 + 这次用的码（页面拿它把诊断按码归类）。
 *
 * 「最新」= `runId` 字典序最大的那个目录（名字就是 `<YYYYMMDD>-<HHMMSS>-<随机>`）。
 * 一次都没有时返回 null。
 *
 * @param {string} dir 仓库根目录
 * @returns {Promise<{ run: object, diagnostics: Array<object>, codes: Array<object>, truncated: boolean } | null>}
 */
export async function readLatest(dir) {
  const root = path.join(dir, '.coder', 'runs')
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const candidates = entries
    .filter((entry) => entry.isDirectory() && isRunId(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const runId of candidates) {
    const found = await readRun(dir, runId).catch(() => null)
    if (found) return found
  }
  return null
}

/**
 * 读一次运行：摘要 + 诊断行 + 码快照。
 *
 * @param {string} dir 仓库根目录
 * @param {string} runId
 * @returns {Promise<{ run: object, diagnostics: Array<object>, codes: Array<object>, truncated: boolean }>}
 */
export async function readRun(dir, runId) {
  if (!isRunId(runId)) throw notFound(`runId 不合法：${runId}`)
  const runDir = path.join(dir, '.coder', 'runs', String(runId))
  const summary = await readJson(path.join(runDir, 'summary.json'))
  const lines = await readJsonl(path.join(runDir, 'diagnostics.jsonl'))
  if (!summary && lines.length === 0) throw notFound(`找不到这次运行：${runId}`)
  const codes = await readCodes(path.join(runDir, 'codes.jsonl'))
  return {
    run: describe(String(runId), summary, lines),
    diagnostics: lines.slice(0, MAX_DIAGNOSTICS),
    codes,
    truncated: lines.length > MAX_DIAGNOSTICS,
  }
}

/**
 * 某一次运行的码快照（页面「解决方案」拿它给方案分组时显示规则原文）。
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {Promise<Array<object>>}
 */
export async function readCodesOf(dir, runId) {
  if (!isRunId(runId)) return []
  return readCodes(path.join(dir, '.coder', 'runs', String(runId), 'codes.jsonl'))
}

/**
 * 这次运行用的码快照（码 → 规则原文、级别、涉及范围），页面用它做分组标题。
 *
 * @param {string} file
 * @returns {Promise<Array<object>>}
 */
async function readCodes(file) {
  const rows = await readJsonl(file)
  return rows.map((row) => ({
    code: String(row.code ?? ''),
    kind: row.kind === 'quality' ? 'quality' : 'debug',
    severity: row.severity ?? 'warning',
    enabled: row.enabled !== false,
    rule: String(row.rule ?? ''),
    targets: Array.isArray(row.targets) ? row.targets.map((item) => String(item)) : [],
  }))
}

/**
 * 一条运行的概要：时间从 runId 里读，计数从诊断行里数。
 *
 * @param {string} runId
 * @param {object | null} summary
 * @param {Array<object>} lines
 * @returns {object}
 */
function describe(runId, summary, lines) {
  const counts = { error: 0, warning: 0, info: 0 }
  const codes = new Set()
  for (const line of lines) {
    counts[line.severity] = (counts[line.severity] ?? 0) + 1
    if (line.code) codes.add(String(line.code))
  }
  return {
    runId,
    startedAt: startedAtOf(runId),
    // 没有 summary 的老运行：只有诊断行能说的话
    status: summary?.status ?? null,
    ok: summary?.ok ?? null,
    error: summary?.error ?? null,
    change: summary?.change ?? null,
    doc: summary?.doc ?? null,
    codes: summary?.codes ?? null,
    activeCodes: summary?.activeCodes ?? null,
    verification: summary?.verification ?? null,
    diagnostics: lines.length,
    counts,
    codesHit: codes.size,
    hasSummary: Boolean(summary),
  }
}

/**
 * `20261105-234412-4b4521` → `2026-11-05 23:44:12`（本地时间）。
 *
 * @param {string} runId
 * @returns {string | null}
 */
function startedAtOf(runId) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(runId)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

/**
 * @param {string} file
 * @returns {Promise<object | null>}
 */
async function readJson(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 逐行读 JSONL；坏行跳过（一份报告里有一行坏了不该让整页打不开）。
 *
 * @param {string} file
 * @returns {Promise<Array<object>>}
 */
async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => null)
  if (text === null) return []
  const rows = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) rows.push(value)
    } catch {
      // 坏行跳过
    }
  }
  return rows
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
