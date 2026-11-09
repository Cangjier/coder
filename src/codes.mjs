/**
 * 仓库里的 codes.jsonl：位置、读取、写回。
 *
 * 文件就在规范文档同目录（`**\/docs/codes.jsonl`），是「诊断码」的持久化位置。
 * 一旦它存在，就说明这份代码表由用户维护：插件只读——不改写、不覆盖；
 * 只有「本次真的生成了诊断码」（没有现成的，或者显式 force）才往仓库里写东西。
 *
 * 要改它用左侧栏的「诊断码」页（见 src/web.mjs 与 client.js），不再往仓库里放编辑页。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { countsOf, parseCodes, serializeCodes, validateRows } from './codes-client.js'

export const CODES_FILE = 'codes.jsonl'

/**
 * 文档所在目录（posix、无尾斜杠）。
 *
 * @param {string} docPath
 * @returns {string}
 */
export function codesDirOf(docPath) {
  const dir = path.posix.dirname(String(docPath ?? ''))
  return dir === '.' || dir === '' ? '' : dir
}

/**
 * @param {string} docPath
 * @returns {string}
 */
export function codesRelOf(docPath) {
  const dir = codesDirOf(docPath)
  return dir ? `${dir}/${CODES_FILE}` : CODES_FILE
}

/**
 * 规范文档同目录下的 codes.jsonl 绝对路径。
 *
 * @param {string} repo
 * @param {string} docPath
 * @returns {string}
 */
export function codesPathFor(repo, docPath) {
  const dir = codesDirOf(docPath)
  return dir ? path.join(repo, ...dir.split('/'), CODES_FILE) : path.join(repo, CODES_FILE)
}

/**
 * 插件自己写进 docs 目录的文件（含写入过程中的临时文件）。
 *
 * 指纹要忽略它们：写 codes.jsonl 是插件的行为，不是「源仓库被改了」。
 *
 * @param {string} rel
 * @returns {boolean}
 */
export function isCoderArtifact(rel) {
  const parts = String(rel ?? '').replace(/\\/g, '/').split('/')
  if (parts.length < 2) return false
  if (parts[parts.length - 2] !== 'docs') return false
  const name = parts[parts.length - 1]
  return name === CODES_FILE || name.startsWith(`${CODES_FILE}.`)
}

/**
 * 读一份 codes.jsonl。
 *
 * `ok` 才能直接复用；`empty` 当成「没有」；`bad` 必须让用户改——因为这份文件是人的输入，
 * 悄悄修好或悄悄覆盖都会让文件和本次运行的判定不一致。
 *
 * @param {string} file
 * @returns {Promise<{ status: 'absent'|'empty'|'bad'|'ok', rows: Array<object>, problems: Array<object> }>}
 */
export async function readCodesFile(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', rows: [], problems: [] }
    throw error
  }
  if (!text.trim()) return { status: 'empty', rows: [], problems: [] }

  const parsed = parseCodes(text)
  const problems = [...parsed.problems, ...validateRows(parsed.rows)]
  if (problems.length > 0) return { status: 'bad', rows: parsed.rows, problems }
  return { status: 'ok', rows: parsed.rows.map(stripLine), problems: [] }
}

/**
 * 写回 codes.jsonl（原子替换；内容没变就不动文件，指纹和 mtime 都保持稳定）。
 *
 * @param {string} file
 * @param {Array<object>} rows
 * @returns {Promise<{ changed: boolean, codes: { total: number, debug: number, quality: number, static: number, runtime: number, disabled: number } }>}
 */
export async function writeCodesFile(file, rows) {
  const changed = await writeIfChanged(file, serializeCodes(rows))
  return { changed, codes: countsOf(rows) }
}

/**
 * @param {string} file
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function writeIfChanged(file, text) {
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current === text) return false
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return true
}

/**
 * @param {object} row
 * @returns {object}
 */
function stripLine(row) {
  if (!row || !('__line' in row)) return row
  const copy = { ...row }
  delete copy.__line
  return copy
}
