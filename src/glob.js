/**
 * 一个够用的 glob 匹配器。
 *
 * 只支持 file.md 里实际会用到的子集：
 *
 *   *    一个路径段内的任意字符（不跨 `/`）
 *   **   整个路径段，匹配零层或多层目录
 *   ?    一个路径段内的一个字符
 *   其余字符按字面量匹配
 *
 * `tmp/**` 同时匹配目录 `tmp` 本身和它下面的所有文件，所以 file.md 里
 * 不需要再单独写 `tmp`。
 *
 * 不支持 `[]`、`{}` 和转义；这些字符在路径里按字面量处理。
 *
 * @module coder/glob
 */

/**
 * 匹配一个路径段。
 *
 * @param {string} pattern - 段模式。
 * @param {string} segment - 实际路径段。
 * @returns {boolean} 是否匹配。
 */
function matchSegment(pattern, segment) {
  let source = '^'
  for (const character of pattern) {
    if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  source += '$'
  return new RegExp(source).test(segment)
}

/**
 * 递归匹配路径段。
 *
 * @param {string[]} patternSegments - 模式段。
 * @param {number} patternIndex - 当前模式段下标。
 * @param {string[]} pathSegments - 路径段。
 * @param {number} pathIndex - 当前路径段下标。
 * @returns {boolean} 是否匹配。
 */
function matchSegments(patternSegments, patternIndex, pathSegments, pathIndex) {
  if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length

  const patternSegment = patternSegments[patternIndex]
  if (patternSegment === '**') {
    if (patternIndex === patternSegments.length - 1) return true
    for (let next = pathIndex; next <= pathSegments.length; next += 1) {
      if (matchSegments(patternSegments, patternIndex + 1, pathSegments, next)) return true
    }
    return false
  }

  if (pathIndex === pathSegments.length) return false
  if (!matchSegment(patternSegment, pathSegments[pathIndex])) return false
  return matchSegments(patternSegments, patternIndex + 1, pathSegments, pathIndex + 1)
}

/**
 * 用一个 glob 匹配一个相对路径。
 *
 * 路径和模式都使用 `/` 分隔，且都不以 `/` 开头。
 *
 * @param {string} pattern - glob 模式，例如 `tmp/**`。
 * @param {string} filePath - 相对路径，例如 `tmp/cache/a.bin`。
 * @returns {boolean} 是否匹配。
 */
export function matchGlob(pattern, filePath) {
  if (typeof pattern !== 'string' || typeof filePath !== 'string') return false
  if (pattern === '') return false
  return matchSegments(pattern.split('/'), 0, filePath.split('/'), 0)
}
