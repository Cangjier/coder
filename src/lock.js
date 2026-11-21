/**
 * `.coder/lock.md` 的格式、hash 与读写。
 *
 * 锁是软约束：它告诉 dsh「上锁期间修改 .coder 必须走 update」。真正能
 * 发现直接修改的是第 2 行的 hash：`list` 和 `update` 都会把记录的 hash
 * 与当前 `.coder/` 重新计算的结果比对。
 *
 * hash 口径（固化，不接受配置）：
 *
 * 1. 递归遍历 `.coder/` 下的所有普通文件，排除 `lock.md` 自身；
 * 2. 按相对路径排序，逐个计算文件内容的 sha256；
 * 3. 把各文件的 hex hash 直接拼接，再对拼接串计算 sha256。
 *
 * 路径本身不参与拼接；`.coder` 的文件名是固化的，内容才是要保护的对象。
 *
 * @module coder/lock
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 锁文件相对于 `.coder/` 的路径。 */
export const LOCK_RELATIVE = 'lock.md'

/** 锁文件相对于项目根目录的路径。 */
export const LOCK_PATH = `.coder/${LOCK_RELATIVE}`

/** 第一行的固定声明。 */
export const LOCK_DECLARATION = '.coder 被上锁，禁止直接修改文件，修改必须走 update。'

/** 第 2 行的前缀。 */
export const LOCK_HASH_PREFIX = 'sha256:'

/** 第 2 行的完整格式。 */
const LOCK_HASH_LINE = /^sha256:([0-9a-f]{64})$/

/**
 * 计算一段内容的 sha256 hex。
 *
 * @param {string|Buffer} value - 内容。
 * @returns {string} 64 位小写 hex。
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 递归收集 `.coder/` 下的普通文件。
 *
 * 不跟随符号链接；`lock.md` 自身不参与 hash。
 *
 * @param {string} dir - 当前目录。
 * @param {string} prefix - 相对 `.coder/` 的前缀。
 * @param {{relative: string, absolute: string}[]} files - 收集结果。
 * @returns {Promise<void>}
 */
async function collect(dir, prefix, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collect(absolute, relative, files)
    } else if (entry.isFile()) {
      if (relative === LOCK_RELATIVE) continue
      files.push({ relative, absolute })
    }
  }
}

/**
 * 计算整个 `.coder/` 的锁 hash。
 *
 * @param {string} docsRoot - `.coder/` 的绝对路径。
 * @returns {Promise<{hash: string, files: string[], fileHashes: string[]}>} hash 与参与计算的文件。
 * @throws {Error} 目录或文件不可读时。
 */
export async function hashCoder(docsRoot) {
  const files = []
  await collect(docsRoot, '', files)
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))

  const fileHashes = []
  for (const file of files) {
    const content = await fs.readFile(file.absolute)
    fileHashes.push(sha256Hex(content))
  }
  return {
    hash: sha256Hex(fileHashes.join('')),
    files: files.map((file) => file.relative),
    fileHashes,
  }
}

/**
 * 解析锁文件正文。
 *
 * 只做格式解析，不计算当前 hash；hash 是否匹配由调用方用 {@link hashCoder}
 * 比对。授权原文保留第 3 行起的全部内容（包括换行）。
 *
 * @param {string} text - 锁文件正文。
 * @returns {{declaration: string, declarationValid: boolean, hashLine: string, hash: string|null, hashValid: boolean, authorization: string, authorizationPresent: boolean}} 解析结果。
 */
export function parseLockFile(text) {
  const lines = text.split('\n')
  const declaration = lines[0] ?? ''
  const hashLine = lines[1] ?? ''
  const match = LOCK_HASH_LINE.exec(hashLine)
  const authorization = lines.slice(2).join('\n')
  return {
    declaration,
    declarationValid: declaration === LOCK_DECLARATION,
    hashLine,
    hash: match === null ? null : match[1],
    hashValid: match !== null,
    authorization,
    authorizationPresent: authorization.trim() !== '',
  }
}

/**
 * 拼出锁文件正文。
 *
 * @param {string} hash - 64 位 hex。
 * @param {string} authorization - 用户授权原文，原样保存。
 * @returns {string} 锁文件正文。
 */
export function formatLockFile(hash, authorization) {
  return `${LOCK_DECLARATION}\n${LOCK_HASH_PREFIX}${hash}\n${authorization}`
}

/**
 * 读取并解析锁文件。
 *
 * @param {string} docsRoot - `.coder/` 的绝对路径。
 * @returns {Promise<object|null>} 解析结果；没上锁时为 null。
 * @throws {Error} 文件存在但不可读时。
 */
export async function readLock(docsRoot) {
  const absolute = path.join(docsRoot, LOCK_RELATIVE)
  let text
  try {
    text = await fs.readFile(absolute, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  return { absolute, text, ...parseLockFile(text) }
}

/**
 * 新建锁文件。
 *
 * 使用 `wx` 标志：已经存在锁文件时抛 EEXIST，由调用方转成明确的错误。
 *
 * @param {string} docsRoot - `.coder/` 的绝对路径。
 * @param {string} hash - 当前 `.coder/` 的 hash。
 * @param {string} authorization - 用户授权原文。
 * @returns {Promise<string>} 锁文件绝对路径。
 */
export async function createLock(docsRoot, hash, authorization) {
  const absolute = path.join(docsRoot, LOCK_RELATIVE)
  await fs.writeFile(absolute, formatLockFile(hash, authorization), { encoding: 'utf8', flag: 'wx' })
  return absolute
}

/**
 * 用新 hash 重写锁文件，保留声明与授权原文。
 *
 * @param {object} lock - {@link readLock} 的结果。
 * @param {string} hash - 新的 `.coder/` hash。
 * @returns {Promise<void>}
 */
export async function rewriteLock(lock, hash) {
  await fs.writeFile(lock.absolute, formatLockFile(hash, lock.authorization), 'utf8')
}

/**
 * 删除锁文件。
 *
 * @param {string} docsRoot - `.coder/` 的绝对路径。
 * @returns {Promise<void>}
 */
export async function removeLock(docsRoot) {
  await fs.rm(path.join(docsRoot, LOCK_RELATIVE), { force: true })
}
