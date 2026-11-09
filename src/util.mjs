import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * @param {string | Buffer} value
 * @returns {string}
 */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * @param {Date} [date]
 * @returns {string}
 */
export function makeRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

/** @returns {string} */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} target
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, target)
}

/**
 * 一行一个 JSON，空数组写成空文件。
 *
 * @param {string} target
 * @param {Array<object>} rows
 * @returns {Promise<void>}
 */
export async function writeJsonl(target, rows) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const text = rows.map((row) => JSON.stringify(row)).join('\n')
  await fs.writeFile(target, text ? `${text}\n` : '', 'utf8')
}

/**
 * @param {string} target
 * @returns {Promise<Array<object>>}
 */
export async function readJsonl(target) {
  const text = await fs.readFile(target, 'utf8').catch(() => '')
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 坏行跳过：交付文件已经被上游校验过一遍，这里只防手改。
    }
  }
  return rows
}

/**
 * @param {string} target
 * @returns {Promise<any>}
 */
export async function readJson(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'))
}

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function oneLine(value, max = 400) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1_000)).padStart(2, '0')}s`
}
