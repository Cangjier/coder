/**
 * 工作区里的 `docs/codes.jsonl`：找出来、读、原子写回。
 *
 * 这是编辑页（左侧栏「诊断码」那个主界面页面）的 Host 一侧。页面在浏览器里，
 * 碰不到文件系统，读写都通过这里；和命令行工具用的是同一份 `codes-client.js`。
 *
 * 只认 `<任意>/docs/codes.jsonl` 这一种位置——和 coder_codes 落盘的位置一致。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { countsOf, normalizeRow, parseCodes, serializeCodes, validateRows } from './codes-client.js'

/** 编辑页能看到的文件名：和 src/codes.mjs 的 CODES_FILE 一致，这里单独写一份避免循环依赖。 */
export const CODES_FILE = 'codes.jsonl'

/** 目录名在这些里的一律不进（依赖、版本库、插件自己的输出）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.coder', 'dist', 'build', 'out', '.next', 'coverage'])

/** 往下找多深：`packages/a/docs` 是 3 层，留一点余量。 */
const MAX_DEPTH = 4

/** 一个工作区最多列出多少份，避免巨仓库把页面拖死。 */
const MAX_FILES = 50

/**
 * 找出工作区里所有 `**\/docs/codes.jsonl`（跳过依赖目录，最多 4 层）。
 *
 * @param {string} root
 * @returns {Promise<string[]>} 相对仓库根的 posix 路径，按字典序
 */
export async function scanCodesFiles(root) {
  const out = []
  const walk = async (dir, rel, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.name === 'docs') {
        const file = path.join(dir, entry.name, CODES_FILE)
        if (await isFile(file)) out.push(`${childRel}/${CODES_FILE}`)
        // docs 下面不会再嵌一个 docs：不再往下走。
        continue
      }
      await walk(path.join(dir, entry.name), childRel, depth + 1)
    }
  }
  await walk(root, '', 1)
  return out.sort()
}

/**
 * 读一份 codes.jsonl，连行号一起报出来（页面按行定位问题）。
 *
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<{ rel: string, status: 'ok'|'empty'|'bad', rows: Array<object>, counts: object, problems: Array<object> }>}
 */
export async function readCodes(root, rel) {
  const file = joinInside(root, rel)
  const text = await fs.readFile(file, 'utf8')
  const parsed = parseCodes(text)
  const problems = [...parsed.problems, ...validateRows(parsed.rows)]
  const rows = parsed.rows.map(stripLine)
  return {
    rel,
    status: problems.length > 0 ? 'bad' : rows.length > 0 ? 'ok' : 'empty',
    rows,
    counts: countsOf(rows),
    problems: problems.map((item) => ({
      line: item.line ?? null,
      index: Number.isInteger(item.index) ? item.index : -1,
      field: item.field ?? null,
      message: item.message,
    })),
  }
}

/**
 * 校验并写回一份 codes.jsonl。内容没变就不动文件（mtime 保持稳定）。
 *
 * 先校验后落盘：页面上的行不合规时一个字节都不写，问题原样返回。
 *
 * @param {string} root
 * @param {string} rel
 * @param {Array<object>} rows
 * @returns {Promise<{ ok: boolean, changed?: boolean, rows?: Array<object>, counts?: object, problems?: Array<object> }>}
 */
export async function saveCodes(root, rel, rows) {
  if (!Array.isArray(rows)) {
    return { ok: false, problems: [{ line: null, index: -1, field: null, message: 'rows 必须是数组' }] }
  }
  const normalized = rows.map((row) => normalizeRow(row))
  const problems = validateRows(normalized)
  if (problems.length > 0) {
    return {
      ok: false,
      problems: problems.map((item) => ({
        line: item.line ?? null,
        index: Number.isInteger(item.index) ? item.index : -1,
        field: item.field ?? null,
        message: item.message,
      })),
    }
  }
  const file = joinInside(root, rel)
  const text = serializeCodes(normalized)
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  const changed = current !== text
  if (changed) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(tmp, text, 'utf8')
      await fs.rename(tmp, file)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }
  return { ok: true, changed, rows: normalized, counts: countsOf(normalized) }
}

/**
 * 页面上允许出现的位置：必须是 `<某>/docs/codes.jsonl`，不许跳出工作区。
 *
 * @param {string} rel
 * @returns {boolean}
 */
export function isCodesRel(rel) {
  const text = String(rel ?? '').replace(/\\/g, '/')
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return false
  if (text.split('/').indexOf('..') >= 0) return false
  return /(^|\/)docs\/codes\.jsonl$/.test(text)
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string}
 */
function joinInside(root, rel) {
  if (!isCodesRel(rel)) throw new Error(`不是 docs/codes.jsonl 的位置：${rel}`)
  const file = path.resolve(root, ...rel.split('/'))
  const inside = path.relative(path.resolve(root), file)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`位置在工作区之外：${rel}`)
  }
  return file
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function isFile(file) {
  const stat = await fs.stat(file).catch(() => null)
  return Boolean(stat?.isFile())
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
