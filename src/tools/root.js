/**
 * 两个工具共用的项目根目录解析。
 *
 * 显式 `root` 优先；否则用会话工作目录。不把进程工作目录放在会话目录之前：
 * 桌面版的进程目录是 profile 目录，不是用户的项目目录。
 *
 * @module coder/tools/root
 */

import path from 'node:path'

/**
 * 定下这次操作的项目根目录。
 *
 * @param {{root?: unknown}} args - 工具参数。
 * @param {object} context - 工具执行上下文。
 * @returns {string} 绝对路径形式的项目根目录。
 */
export function resolveRoot(args, context) {
  const explicit = args?.root
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim())
  const sessionCwd = context?.agent?.session?.header?.cwd
  if (typeof sessionCwd === 'string' && sessionCwd.trim() !== '') return path.resolve(sessionCwd.trim())
  const cwd = context?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return path.resolve(cwd.trim())
  return process.cwd()
}
