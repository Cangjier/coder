/**
 * 一个够用的 Markdown 结构扫描器。
 *
 * 只承认 ATX 标题（`#` 到 `######`）和反引号/波浪号围栏。围栏里的 `#`
 * 不是标题；扫描 mermaid、ts 和诊断步骤时都依赖这一点。
 *
 * 这里不引入 Markdown 解析库：coder 只关心标题、围栏和行号，宁愿让规则
 * 保持可预测，也不让第三方解析器的细节影响诊断结果。
 *
 * @module coder/markdown
 */

/**
 * 把一个 Markdown 文本切成标题、围栏和行。
 *
 * @param {string} text - 文档正文。
 * @returns {{lines: string[], headings: {level: number, text: string, line: number}[], fences: {startLine: number, endLine: number, lang: string, content: string}[], masked: boolean[], unclosed: {startLine: number, lang: string}|null}} 解析结果。
 */
export function analyzeMarkdown(text) {
  const lines = text.split(/\r?\n/)
  const headings = []
  const fences = []
  const masked = new Array(lines.length).fill(false)
  let open = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    if (open !== null) {
      masked[index] = true
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)
      if (close !== null && close[1][0] === open.char && close[1].length >= open.length) {
        fences.push({
          startLine: open.startLine,
          endLine: index + 1,
          lang: open.lang,
          content: open.content.join('\n'),
        })
        open = null
      } else {
        open.content.push(line)
      }
      continue
    }

    const fenceOpen = /^\s*(`{3,}|~{3,})\s*([^\s`]*)?\s*$/.exec(line)
    if (fenceOpen !== null) {
      masked[index] = true
      open = {
        char: fenceOpen[1][0],
        length: fenceOpen[1].length,
        lang: (fenceOpen[2] ?? '').toLowerCase(),
        startLine: index + 1,
        content: [],
      }
      continue
    }

    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line)
    if (heading !== null && heading[2].trim() !== '') {
      headings.push({ level: heading[1].length, text: heading[2].trim(), line: index + 1 })
    }
  }

  return {
    lines,
    headings,
    fences,
    masked,
    unclosed: open === null ? null : { startLine: open.startLine, lang: open.lang },
  }
}
