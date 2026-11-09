/**
 * 诊断记录的解析、去重与渲染。
 *
 * 输出格式对齐 tsc：`path(line,col): severity CODE: message`
 */
import { oneLine } from './util.mjs'

export const SEVERITIES = ['error', 'warning', 'info']
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 }

/**
 * 解析运行期写出的 JSONL。坏行跳过，不影响其余。
 *
 * @param {string} text
 * @returns {{ entries: Array<object>, badLines: number }}
 */
export function parseDiagnostics(text) {
  const entries = []
  let badLines = 0
  let lineNo = 0
  for (const raw of String(text ?? '').split('\n')) {
    lineNo += 1
    const line = raw.trim()
    if (!line) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    const entry = normalizeEntry(value)
    if (entry) {
      entry.logLine = lineNo
      entries.push(entry)
    } else {
      badLines += 1
    }
  }
  return { entries, badLines }
}

/**
 * @param {unknown} value
 * @returns {object | null}
 */
export function normalizeEntry(value) {
  if (!value || typeof value !== 'object') return null
  const code = typeof value.code === 'string' ? value.code.trim() : ''
  if (!code) return null
  const file = typeof value.file === 'string' ? value.file.replace(/\\/g, '/') : ''
  const line = Number(value.line)
  const severity = SEVERITIES.includes(value.severity) ? value.severity : 'warning'
  const message = typeof value.message === 'string' ? value.message.trim() : ''
  const column = Number(value.column)
  return {
    code,
    severity,
    file,
    line: Number.isFinite(line) && line > 0 ? Math.trunc(line) : null,
    column: Number.isFinite(column) && column > 0 ? Math.trunc(column) : null,
    message: message || code,
    data: value.data && typeof value.data === 'object' ? value.data : undefined,
    at: typeof value.at === 'string' ? value.at : undefined,
  }
}

/**
 * 同码、同文件、同行、同消息视为一条；保留首次出现。
 *
 * @param {Array<object>} entries
 * @param {number} [max]
 * @returns {Array<object>}
 */
export function dedupeEntries(entries, max = 500) {
  const seen = new Set()
  const out = []
  for (const entry of entries) {
    const key = `${entry.code}\u0000${entry.file}\u0000${entry.line ?? ''}\u0000${entry.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
    if (out.length >= max) break
  }
  return out
}

/**
 * @param {Array<object>} entries
 * @returns {Array<object>}
 */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    if (rank !== 0) return rank
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return (a.line ?? 0) - (b.line ?? 0)
  })
}

const VERIFY_TEXT = { confirmed: '已确认', uncertain: '存疑' }
const REPRO_TEXT = { pass: '步骤可复现', fail: '步骤跑不通', rewritten: '步骤已改写', unknown: '步骤未执行' }

/**
 * tsc 风格的一行。带编号时以 `#N` 开头，方便在文本里引用。
 *
 * 有复现步骤再跟一行 `复现：…`；有复核结论再跟一行 `复核：…`——用户要的是「照着做一次」。
 *
 * @param {{ id?: number, file: string, line: number | null, column?: number | null, severity: string, code: string, message: string, steps?: string[], verification?: string, repro?: string, reproNote?: string }} entry
 * @returns {string}
 */
export function formatTs(entry) {
  const where = entry.line ? `${entry.file}(${entry.line}${entry.column ? `,${entry.column}` : ''})` : entry.file
  const prefix = entry.id ? `#${entry.id} ` : ''
  const out = [`${prefix}${where}: ${entry.severity} ${entry.code}: ${entry.message}`]

  const steps = Array.isArray(entry.steps) ? entry.steps.map((step) => String(step ?? '').trim()).filter(Boolean) : []
  if (steps.length > 0) out.push(`    复现：${steps.map((step, index) => `${index + 1}) ${step}`).join('；')}`)

  if (entry.verification) {
    const verdict = VERIFY_TEXT[entry.verification] ?? entry.verification
    const repro = entry.repro ? `，${REPRO_TEXT[entry.repro] ?? entry.repro}` : ''
    const note = entry.reproNote ? ` —— ${entry.reproNote}` : ''
    out.push(`    复核：${verdict}${repro}${note}`)
  }
  return out.join('\n')
}

/**
 * 解析质量运行期写出的质量指标日志。
 *
 * @param {string} text
 * @returns {{ entries: Array<object>, bad: number }}
 */
export function parseQuality(text) {
  const entries = []
  let bad = 0
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      bad += 1
      continue
    }
    if (!value || typeof value.code !== 'string' || !value.code.trim()) {
      bad += 1
      continue
    }
    const lineNo = Number(value.line)
    entries.push({
      code: value.code.trim(),
      severity: SEVERITIES.includes(value.severity) ? value.severity : 'warning',
      file: String(value.file ?? '').replace(/\\/g, '/'),
      line: Number.isFinite(lineNo) && lineNo > 0 ? Math.trunc(lineNo) : null,
      message: String(value.message ?? '').trim() || value.code.trim(),
      metric: typeof value.metric === 'string' ? value.metric : '',
      value: typeof value.value === 'number' ? value.value : null,
      unit: typeof value.unit === 'string' ? value.unit : '',
      threshold: typeof value.threshold === 'number' ? value.threshold : null,
      pass: typeof value.pass === 'boolean' ? value.pass : null,
    })
  }
  return { entries, bad }
}
