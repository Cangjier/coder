/**
 * 文件路径通配的校验与匹配。
 *
 * `file.md`、诊断码作用范围、诊断步骤与 plan 文档共用同一套写法：
 *
 *   *    一个路径段内的任意字符（不跨 `/`）
 *   **   整个路径段，匹配零层或多层目录
 *   ?    一个路径段内的一个字符
 *
 * 通配相对于项目根目录，使用 `/` 分隔，不能是绝对路径，不能包含
 * `.`、`..` 或空路径段。`全局` 只在允许作用范围的地方出现。
 *
 * @module coder/scope
 */

import { matchGlob } from './glob.js'

/** 全局作用范围的固定写法。 */
export const GLOBAL_SCOPE = '全局'

/** 文件路径通配里不允许出现的路径写法。 */
const ABSOLUTE_PATH = /^[\\/]|^[A-Za-z]:[\\/]/

/**
 * 校验一个作用范围：`全局` 或合法的文件路径通配。
 *
 * @param {string} value - 作用范围。
 * @returns {string|null} 问题；合法时为 null。
 */
export function scopeIssue(value) {
  if (value === GLOBAL_SCOPE) return null
  if (value === '') return '文件通配不能为空。'
  if (ABSOLUTE_PATH.test(value)) return `文件通配必须相对于项目根目录：${value}`
  if (value.includes('\\')) return `文件通配必须使用 / 分隔：${value}`
  if (value.includes('[') || value.includes(']')) return `文件通配不能包含方括号：${value}`
  const segments = value.split('/')
  if (segments.includes('..')) return `文件通配不能包含 ..：${value}`
  if (segments.includes('.')) return `文件通配不能包含 . 路径段：${value}`
  if (segments.includes('')) return `文件通配不能以 / 结尾或包含空路径段：${value}`
  return null
}

/**
 * 校验步骤或进度条目里的文件通配；这些位置指向具体文件，不能写全局。
 *
 * @param {string} value - 文件路径通配。
 * @returns {string|null} 问题；合法时为 null。
 */
export function stepScopeIssue(value) {
  if (value === GLOBAL_SCOPE) return '这里必须指定文件路径通配，不能写全局。'
  return scopeIssue(value)
}

/**
 * 判断某个文件是否落在作用范围内。
 *
 * @param {string} scope - 作用范围。
 * @param {string} file - 项目文件，相对路径。
 * @returns {boolean} 是否匹配。
 */
export function scopeMatches(scope, file) {
  if (scope === GLOBAL_SCOPE) return true
  return matchGlob(scope, file)
}
