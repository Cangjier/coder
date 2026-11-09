/**
 * 插件自己的错误类型：带稳定 code，工具层据此决定返回什么。
 */
export class CoderError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {unknown} [detail]
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'CoderError'
    this.code = code
    this.detail = detail
  }
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string, detail?: unknown }}
 */
export function describeError(error) {
  if (error instanceof CoderError) {
    const info = { code: error.code, message: error.message }
    if (error.detail !== undefined) info.detail = error.detail
    return info
  }
  if (error instanceof Error) return { code: 'UNEXPECTED', message: error.message }
  return { code: 'UNEXPECTED', message: String(error) }
}
