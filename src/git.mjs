/**
 * git 机械动作。只读源仓库：所有改动都发生在临时 worktree 里。
 *
 * 三种范围：commit（对父提交）、range（区间）、all（整个仓库）。
 * 都不接受未提交改动——诊断的输入必须是一个确定的提交；整仓模式取的是 HEAD 的完整文件树。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CoderError } from './errors.mjs'
import { sha256 } from './util.mjs'

const MAX_BUFFER = 64 * 1024 * 1024

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, timeoutMs?: number, allowFailure?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number }>}
 */
export function git(repo, args, options = {}) {
  const { env, timeoutMs = 120_000, allowFailure = false } = options
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error && !allowFailure) {
          const reason = String(stderr || '').trim() || error.message
          reject(new CoderError('GIT_FAILED', `git ${args.join(' ')} 失败：${reason}`))
          return
        }
        resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), code: error?.code ?? 0 })
      },
    )
  })
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function resolveRepo(dir) {
  const absolute = path.resolve(dir)
  const stat = await fs.stat(absolute).catch(() => null)
  if (!stat?.isDirectory()) throw new CoderError('BAD_REPO', `代码目录不存在或不是目录：${absolute}`)
  const result = await git(absolute, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (!result.ok || !result.stdout.trim()) {
    throw new CoderError('NOT_A_REPO', `${absolute} 不是 git 仓库`)
  }
  return path.resolve(result.stdout.trim())
}

/**
 * @param {string} repo
 * @param {string} rev
 * @returns {Promise<string>}
 */
export async function revParse(repo, rev) {
  const result = await git(repo, ['rev-parse', '--verify', `${rev}^{commit}`], { allowFailure: true })
  if (!result.ok || !result.stdout.trim()) throw new CoderError('BAD_REV', `无法解析提交：${rev}`)
  return result.stdout.trim()
}

/**
 * 解析要诊断的范围。
 *
 * - `commit`：一个提交对它的父提交；
 * - `range`：一段提交区间；
 * - `all`：整个仓库（`head` 的完整文件树），没有基线，`base` 为 null。
 *
 * @param {string} repo
 * @param {{ mode?: string, ref?: string, from?: string, to?: string }} spec
 * @returns {Promise<{ mode: string, base: string | null, head: string, ref: string }>}
 */
export async function resolveChange(repo, spec = {}) {
  const mode = spec.mode || 'all'

  if (mode === 'all') {
    const ref = spec.ref || 'HEAD'
    const head = await revParse(repo, ref)
    return { mode, base: null, head, ref }
  }

  if (mode === 'commit') {
    const ref = spec.ref || 'HEAD'
    const head = await revParse(repo, ref)
    const parent = await git(repo, ['rev-parse', '--verify', `${head}^`], { allowFailure: true })
    if (!parent.ok) {
      throw new CoderError(
        'BAD_REV',
        `${ref} 是根提交，没有父提交可作为基线；不传 change（整仓模式）可以对整个仓库做诊断`,
      )
    }
    return { mode, base: parent.stdout.trim(), head, ref }
  }

  if (mode === 'range') {
    if (!spec.from) throw new CoderError('BAD_CHANGE', 'change.mode=range 需要 change.from')
    const base = await revParse(repo, spec.from)
    const head = await revParse(repo, spec.to || 'HEAD')
    if (base === head) throw new CoderError('NO_CHANGES', `范围 ${spec.from}..${spec.to || 'HEAD'} 没有改动`)
    return { mode, base, head, ref: `${spec.from}..${spec.to || 'HEAD'}` }
  }

  throw new CoderError(
    'BAD_CHANGE',
    `change.mode 只接受 commit / range / all，收到：${mode}。未提交改动不再支持：不传 change 就是整仓模式（读 HEAD 的完整文件树）。`,
  )
}

/**
 * 源仓库指纹：HEAD + 分支 + status（排除插件自己的输出目录，以及插件写进 docs 的文件）。
 *
 * @param {string} repo
 * @param {{ exclude?: string[], skip?: (rel: string) => boolean }} [options]
 * @returns {Promise<string>}
 */
export async function fingerprint(repo, options = {}) {
  const exclude = (options.exclude ?? []).map((prefix) => prefix.replace(/\\/g, '/').replace(/^\.\//, ''))
  const skip = typeof options.skip === 'function' ? options.skip : () => false
  const head = (await git(repo, ['rev-parse', 'HEAD'], { allowFailure: true })).stdout.trim()
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })).stdout.trim()
  const status = (await git(repo, ['status', '--porcelain=v1'], { allowFailure: true })).stdout
  const kept = status
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const rest = unquote(line.slice(3))
      const paths = rest.includes(' -> ') ? rest.split(' -> ') : [rest]
      return !paths.some((item) => exclude.some((prefix) => item.replace(/\\/g, '/').startsWith(prefix)) || skip(item))
    })
    .join('\n')
  return sha256(`${head}\0${branch}\0${kept}`)
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const text = value.trim()
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(.)/g, '$1')
  return text
}

/**
 * @param {string} repo
 * @param {string} target
 * @returns {string | null}
 */
export function relativeInside(repo, target) {
  const rel = path.relative(repo, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}

/**
 * @param {string} repo
 * @param {string} dir
 * @param {string} branch
 * @param {string} commit
 * @returns {Promise<void>}
 */
export async function addWorktree(repo, dir, branch, commit) {
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await git(repo, ['-c', 'core.hooksPath=', 'worktree', 'add', '-b', branch, dir, commit], { timeoutMs: 300_000 })
}

/**
 * @param {string} repo
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function removeWorktree(repo, dir) {
  await git(repo, ['worktree', 'remove', '--force', dir], { allowFailure: true })
  await git(repo, ['worktree', 'prune'], { allowFailure: true })
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}

/**
 * @param {string} dir
 * @param {string} message
 * @returns {Promise<string | null>}
 */
export async function commitAll(dir, message) {
  await git(dir, ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'add', '-A'])
  const status = (await git(dir, ['status', '--porcelain=v1'])).stdout.trim()
  if (!status) return null
  await git(dir, [
    '-c', 'core.hooksPath=',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '--no-gpg-sign', '-m', message,
  ])
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

/**
 * 把源仓库里被 gitignore 的依赖目录链进工作区。
 *
 * @param {string} sourceRepo
 * @param {string} worktree
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
export async function linkSharedDirs(sourceRepo, worktree, names) {
  const linked = []
  for (const name of names) {
    if (!name || /[\\/]/.test(name) || name === '..') continue
    const source = path.join(sourceRepo, name)
    const target = path.join(worktree, name)
    const stat = await fs.stat(source).catch(() => null)
    if (!stat?.isDirectory()) continue
    if (await fs.stat(target).catch(() => null)) continue
    try {
      await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(name)
    } catch {
      // 链不上就算了，构建失败会作为诊断出现。
    }
  }
  return linked
}

/**
 * 整个仓库的文件清单：整仓模式的「范围」。没有改动状态，status 一律是 `all`。
 *
 * @param {string} repo
 * @param {string} rev
 * @returns {Promise<Array<{ status: string, path: string }>>}
 */
export async function treeFiles(repo, rev) {
  const entries = await lsTree(repo, rev)
  return entries.filter((entry) => entry.type === 'blob').map((entry) => ({ status: 'all', path: entry.path }))
}

/**
 * @param {string} repo
 * @param {string} base
 * @param {string} head
 * @returns {Promise<Array<{ status: string, path: string }>>}
 */
export async function changedFiles(repo, base, head) {
  const result = await git(repo, ['diff', '--name-status', '--find-renames', base, head])
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t')
      return { status, path: rest[rest.length - 1] }
    })
}

/**
 * @param {string} repo
 * @param {string} base
 * @param {string} head
 * @param {number} [maxBytes]
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function patchText(repo, base, head, maxBytes = 4 * 1024 * 1024) {
  const result = await git(repo, ['diff', '--no-color', base, head], { timeoutMs: 300_000 })
  const bytes = Buffer.byteLength(result.stdout, 'utf8')
  if (bytes <= maxBytes) return { text: result.stdout, truncated: false }
  return { text: `${result.stdout.slice(0, maxBytes)}\n\n[补丁超过 ${maxBytes} 字节，已截断]\n`, truncated: true }
}

/**
 * 列出某个提交的完整文件树。
 *
 * @param {string} repo
 * @param {string} rev
 * @returns {Promise<Array<{ mode: string, type: string, sha: string, path: string }>>}
 */
export async function lsTree(repo, rev) {
  const result = await git(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', rev])
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t')
      if (tab < 0) return null
      const [mode, type, sha, size] = record.slice(0, tab).split(/\s+/)
      return { mode, type, sha, size: Number(size) || 0, path: record.slice(tab + 1) }
    })
    .filter(Boolean)
}

/**
 * 读某个提交里的文件内容（截断到 maxChars）。
 *
 * @param {string} repo
 * @param {string} rev
 * @param {string} file
 * @param {number} maxChars
 * @returns {Promise<string>}
 */
export async function readBlobText(repo, rev, file, maxChars = 20_000) {
  const result = await git(repo, ['show', `${rev}:${file}`], { allowFailure: true, timeoutMs: 60_000 })
  if (!result.ok) return ''
  return result.stdout.slice(0, maxChars)
}

/**
 * 读某个提交里的文件，并区分「文件不存在」与「文件为空」。
 *
 * @param {string} repo
 * @param {string} rev
 * @param {string} file
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function readBlob(repo, rev, file) {
  const result = await git(repo, ['show', `${rev}:${file}`], { allowFailure: true, timeoutMs: 60_000 })
  return { ok: result.ok, text: result.ok ? result.stdout : '' }
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function isClean(dir) {
  const status = await git(dir, ['status', '--porcelain=v1'], { allowFailure: true })
  return !status.stdout.trim()
}

/**
 * @returns {string}
 */
export function scratchRoot() {
  return path.join(os.tmpdir(), 'coder-debug')
}
