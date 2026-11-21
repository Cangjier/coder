/**
 * `update` 用到的少量 git 操作。
 *
 * 插件没有第三方依赖，直接用 `git` 命令；所有操作都以项目根目录为 cwd。
 * git 在这里只做「保底」：提交失败就返回错误，工作区里的文件已经写好，
 * 由 git 和 dsh 的 fs 沙盒兜底，不做复杂回滚。
 *
 * @module coder/git
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CoderError } from './docs.js'

/**
 * 运行一条 git 命令。
 *
 * @param {string} root - 项目根目录。
 * @param {string[]} args - git 参数。
 * @param {{allowFailure?: boolean}} [options] - allowFailure 为 true 时非零退出也返回结果。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null}>} 执行结果。
 */
export async function runGit(root, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const ok = error === null
        if (!ok && options.allowFailure !== true) {
          const detail = (stderr || stdout || error?.message || '').trim()
          reject(
            new CoderError(
              `git ${args.join(' ')} 失败${detail === '' ? '' : `：${detail}`}`,
            ),
          )
          return
        }
        resolve({
          ok,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        })
      },
    )
  })
}

/**
 * 确认 `root` 就是 git 仓库根目录。
 *
 * @param {string} root - 项目根目录。
 * @returns {Promise<void>}
 * @throws {CoderError} 不是 git 仓库或根目录不一致时。
 */
export async function assertRepoRoot(root) {
  const result = await runGit(root, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (!result.ok) {
    throw new CoderError(`update 需要 git 仓库，但 ${root} 不是 git 仓库：${result.stderr.trim()}`)
  }
  const top = result.stdout.trim()
  let realRoot
  let realTop
  try {
    realRoot = await fs.realpath(root)
    realTop = await fs.realpath(top)
  } catch {
    realRoot = path.resolve(root)
    realTop = path.resolve(top)
  }
  if (realRoot !== realTop) {
    throw new CoderError(`项目根目录必须是 git 仓库根目录：项目根 ${realRoot}，git 根 ${realTop}`)
  }
}

/**
 * 取当前 HEAD 的 commit。
 *
 * @param {string} root - 项目根目录。
 * @returns {Promise<string>} commit hash。
 */
export async function headCommit(root) {
  return (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim()
}

/**
 * 取当前分支名。
 *
 * @param {string} root - 项目根目录。
 * @returns {Promise<string>} 分支名；detached HEAD 时为 HEAD。
 */
export async function currentBranch(root) {
  return (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
}

/**
 * 只提交指定路径。
 *
 * @param {string} root - 项目根目录。
 * @param {string[]} paths - 相对项目根目录的路径。
 * @param {string} message - commit message。
 * @returns {Promise<string|null>} commit hash；没有变化时为 null。
 */
export async function commitPaths(root, paths, message) {
  if (paths.length === 0) return null
  await runGit(root, ['add', '-A', '--', ...paths])
  const diff = await runGit(root, ['diff', '--cached', '--quiet', '--', ...paths], { allowFailure: true })
  if (diff.ok) return null
  await runGit(root, ['commit', '-m', message, '--', ...paths])
  return headCommit(root)
}

/**
 * 提交当前工作区的全部变化，作为分支前的 checkpoint。
 *
 * @param {string} root - 项目根目录。
 * @param {string} message - commit message。
 * @returns {Promise<string|null>} commit hash；工作区干净时为 null。
 */
export async function checkpointAll(root, message) {
  const status = await runGit(root, ['status', '--porcelain'])
  if (status.stdout.trim() === '') return null
  await runGit(root, ['add', '-A'])
  await runGit(root, ['commit', '-m', message])
  return headCommit(root)
}

/**
 * 校验一个可以新建的分支名。
 *
 * @param {string} root - 项目根目录。
 * @param {string} branch - 分支名。
 * @returns {Promise<void>}
 * @throws {CoderError} 分支名不合法或已经存在时。
 */
export async function validateNewBranch(root, branch) {
  const valid = await runGit(root, ['check-ref-format', '--branch', branch], { allowFailure: true })
  if (!valid.ok) throw new CoderError(`分支名不合法：${branch}`)
  const exists = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowFailure: true,
  })
  if (exists.ok) throw new CoderError(`分支已经存在：${branch}`)
}

/**
 * 新建并切换到分支。
 *
 * @param {string} root - 项目根目录。
 * @param {string} branch - 分支名。
 * @returns {Promise<void>}
 */
export async function createBranch(root, branch) {
  await runGit(root, ['checkout', '-b', branch])
}
