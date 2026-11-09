/**
 * 扫描 **\/docs/*.md。
 *
 * 从提交的文件树里读，而不是从工作区——这样扫描结果与本次诊断的提交严格一致，
 * dryRun 也不需要建临时工作区。
 */
import { lsTree, readBlobText } from './git.mjs'
import { sha256 } from './util.mjs'

const SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '.coder',
  '.codeverify',
  '.next',
  '.venv',
  '__pycache__',
])

/**
 * @param {string} file
 * @returns {boolean}
 */
export function isDocPath(file) {
  const parts = file.split('/')
  if (parts.length < 2) return false
  if (parts[parts.length - 2] !== 'docs') return false
  return /\.md$/i.test(parts[parts.length - 1])
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function underSkipped(file) {
  return file.split('/').some((segment) => SKIP_SEGMENTS.has(segment))
}

/**
 * @param {Array<{ path: string, sha: string }>} entries
 * @returns {string}
 */
export function docsHash(entries) {
  return sha256(entries.map((entry) => `${entry.path}:${entry.sha}`).sort().join('\n'))
}

/**
 * @param {string} repo
 * @param {string} rev
 * @param {{ maxDocs?: number }} [options]
 * @returns {Promise<{ docs: Array<{ path: string, sha: string, bytes: number }>, total: number, truncated: boolean, hash: string }>}
 */
export async function listDocs(repo, rev, options = {}) {
  const maxDocs = options.maxDocs ?? 60
  const entries = await lsTree(repo, rev)
  const docs = entries
    .filter((entry) => entry.type === 'blob' && isDocPath(entry.path) && !underSkipped(entry.path))
    .sort((a, b) => a.path.localeCompare(b.path))

  const hash = docsHash(docs)
  const truncated = docs.length > maxDocs
  return {
    docs: docs.slice(0, maxDocs).map((entry) => ({ path: entry.path, sha: entry.sha, bytes: Number(entry.size) || 0 })),
    total: docs.length,
    truncated,
    hash,
  }
}

/**
 * 取文档开头若干字符，给筛选代理判断「是不是规范性文档」。
 *
 * @param {string} repo
 * @param {string} rev
 * @param {string} file
 * @param {number} chars
 * @returns {Promise<string>}
 */
export async function docExcerpt(repo, rev, file, chars) {
  const text = await readBlobText(repo, rev, file, chars * 2)
  return text.slice(0, chars)
}

/**
 * 提交里的顶层目录名：生成诊断码时给代理看，方便它填 targets。
 *
 * @param {string} repo
 * @param {string} rev
 * @param {{ max?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function topDirs(repo, rev, options = {}) {
  const max = options.max ?? 40
  const entries = await lsTree(repo, rev)
  const dirs = new Set()
  for (const entry of entries) {
    const slash = entry.path.indexOf('/')
    if (slash <= 0) continue
    const name = entry.path.slice(0, slash)
    if (SKIP_SEGMENTS.has(name)) continue
    dirs.add(name)
  }
  return [...dirs].sort().slice(0, max)
}
