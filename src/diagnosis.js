/**
 * `.coder/diagnosis/error.md` 与 `.coder/diagnosis/warn.md` 的解析和确定性检查。
 *
 * 诊断文档用诊断码组织：
 *
 *   # E0001
 *   作用范围：全局
 *   诊断方式：静态代码审查
 *   步骤1：查看 [src/**] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
 *
 * 运行时诊断使用日志审查：
 *
 *   # E0002
 *   作用范围：全局
 *   诊断方式：运行时日志审查
 *   步骤1：在 [src/**] 校验处，插入日志：
 *   ```ts
 *   console.log({ recorded, current })
 *   ```
 *   步骤2：查看日志，如果 recorded 与 current 不一致，则认定为 E0002，否则继续。
 *
 * `error.md` 只放 E 开头的 5 位诊断码，`warn.md` 只放 W 开头的 5 位诊断码。
 * 数字部分固定 4 位，所以 `E0001` 合法，`E001`、`E00001`、`e0001` 都不合法。
 *
 * `list` 不解释自然语言，只做机械检查：编码、作用范围、诊断方式、步骤编号、
 * 步骤格式、文件通配命中，以及运行时插入日志的 ts 围栏。
 *
 * @module coder/diagnosis
 */

import { analyzeMarkdown } from './markdown.js'
import { scopeIssue, scopeMatches, stepScopeIssue } from './scope.js'

export { scopeMatches }

/** 两份诊断文档，相对于 `.coder/`。 */
export const DIAGNOSIS_DOCS = Object.freeze(['diagnosis/error.md', 'diagnosis/warn.md'])

/** 诊断码：E 或 W 加 4 位数字。 */
const CODE_PATTERN = /^([EW])(\d{4})$/

/** 作用范围行。 */
const SCOPE_PATTERN = /^\s*作用范围\s*[：:]\s*(.*?)\s*$/

/** 诊断方式行：静态代码审查 或 运行时日志审查。 */
const METHOD_PATTERN = /^诊断方式\s*[：:]\s*(静态代码审查|运行时日志审查)\s*$/

/** 诊断方式行的宽松识别，用于报告具体值错误。 */
const METHOD_LINE = /^诊断方式\s*[：:]/

/** 步骤行的宽松识别。 */
const STEP_LINE = /^步骤\s*/

/** 静态代码审查步骤：
 *  步骤N：查看 [文件通配] 代码位置描述，如果 ...，则 ...，否则 ...
 */
const STATIC_STEP_PATTERN =
  /^步骤\s*(\d+)\s*[：:]\s*查看\s+(?:\[([^\]\r\n]+)\]|(\S+))\s+(\S.*?)，如果\s*(.+?)，则\s*(.+?)，否则\s*(.+?)[。.]?\s*$/

/** 运行时插入日志步骤：
 *  步骤N：在 [文件通配] 代码位置描述，插入日志：
 */
const INSERT_STEP_PATTERN =
  /^步骤\s*(\d+)\s*[：:]\s*在\s+(?:\[([^\]\r\n]+)\]|(\S+))\s+(\S.*?)，插入日志[：:]\s*$/

/** 运行时查看日志步骤：
 *  步骤N：查看日志，如果 ...，则 ...，否则 ...
 */
const VIEW_STEP_PATTERN =
  /^步骤\s*(\d+)\s*[：:]\s*查看日志\s*[，,]\s*如果\s*(.+?)，则\s*(.+?)，否则\s*(.+?)[。.]?\s*$/

/** 插入日志只接受 ts/typescript 围栏。 */
const LOG_LANGS = new Set(['ts', 'typescript'])

/**
 * 把文档类型换算成诊断级别。
 *
 * @param {'diagnosis-error'|'diagnosis-warn'} kind - 诊断文档类型。
 * @returns {'error'|'warn'} 级别。
 */
export function diagnosisSeverity(kind) {
  return kind === 'diagnosis-warn' ? 'warn' : 'error'
}

/**
 * 构造一条诊断。诊断文档本身的问题一律按 error 处理。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {number} line - 1-based 行号。
 * @param {string} rule - 稳定规则代码。
 * @param {string} message - 给人看的原因。
 * @returns {{doc: string, line: number, rule: string, severity: 'error', message: string}} 诊断。
 */
function diagnostic(doc, line, rule, message) {
  return { doc, line, rule, severity: 'error', message }
}

/**
 * 去掉两边可能包着的一对反引号。
 *
 * @param {string} text - 原始值。
 * @returns {string} 去反引号后的值。
 */
function stripInlineCode(text) {
  const trimmed = text.trim()
  const match = /^`([^`]+)`$/.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

/**
 * 取诊断码标题所属段落的结束行。
 *
 * @param {{level: number, line: number}[]} headings - 全部标题。
 * @param {number} index - 当前标题下标。
 * @param {number} lineCount - 文档总行数。
 * @returns {number} 段落最后一行的 1-based 行号。
 */
function codeEnd(headings, index, lineCount) {
  for (let next = index + 1; next < headings.length; next += 1) {
    if (headings[next].level === 1) return headings[next].line - 1
  }
  return lineCount
}

/**
 * 取正则里方括号或裸通配的捕获值。
 *
 * @param {RegExpExecArray} match - 正则结果。
 * @param {number} bracketIndex - 方括号捕获下标。
 * @param {number} rawIndex - 裸通配捕获下标。
 * @returns {string} 通配值。
 */
function capturedGlob(match, bracketIndex, rawIndex) {
  return (match[bracketIndex] ?? match[rawIndex] ?? '').trim()
}

/**
 * 检查一份诊断文档。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {'error'|'warn'} severity - 文档级别。
 * @param {string[]} [files] - 项目文件（相对路径）。给出时检查通配是否命中。
 * @returns {{diagnostics: object[], codes: object[]}} 诊断与解析出的诊断码。
 */
export function inspectDiagnosis(doc, text, severity, files) {
  const diagnostics = []
  const codes = []

  // 诊断码描述的是源码里已经能识别的问题，源码还没写时留空是正常状态。
  if (text.trim() === '') return { diagnostics, codes }

  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }

  const { lines, headings, masked } = analysis
  const codeHeadings = headings.filter((heading) => heading.level === 1)

  if (codeHeadings.length === 0) {
    diagnostics.push(
      diagnostic(doc, 1, 'diagnosis.no-code', '文档里没有任何 # E0001 或 # W0001 诊断码。'),
    )
    return { diagnostics, codes }
  }

  const firstCodeLine = codeHeadings[0].line
  for (let line = 1; line < firstCodeLine; line += 1) {
    if (lines[line - 1].trim() !== '' && !masked[line - 1]) {
      diagnostics.push(
        diagnostic(doc, line, 'diagnosis.preamble', '第一个诊断码之前不能有正文；诊断文档从诊断码标题开始。'),
      )
      break
    }
  }

  const seenCodes = new Set()
  const expectedPrefix = severity === 'warn' ? 'W' : 'E'

  for (const heading of codeHeadings) {
    const end = codeEnd(headings, headings.indexOf(heading), lines.length)
    const inSection = (entry) => entry.line > heading.line && entry.line <= end
    const headingLines = new Set(
      headings.filter((entry) => entry.level >= 2 && inSection(entry)).map((entry) => entry.line),
    )

    for (const extra of headings.filter((entry) => entry.level >= 2 && inSection(entry))) {
      diagnostics.push(
        diagnostic(
          doc,
          extra.line,
          'diagnosis.heading.level',
          '诊断文档只用 # 写诊断码；作用范围、诊断方式和步骤都写成普通行。',
        ),
      )
    }

    const match = CODE_PATTERN.exec(heading.text.trim())
    if (match === null) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'diagnosis.code.format',
          `诊断码必须是 E 或 W 加 4 位数字，例如 E0001；收到：${heading.text}`,
        ),
      )
      continue
    }

    const code = heading.text.trim()
    if (match[1] !== expectedPrefix) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'diagnosis.code.prefix',
          `${severity === 'warn' ? 'warn.md' : 'error.md'} 的诊断码必须以 ${expectedPrefix} 开头；收到：${code}`,
        ),
      )
      continue
    }
    if (seenCodes.has(code)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'diagnosis.code.duplicate', `诊断码重复：${code}`),
      )
      continue
    }
    seenCodes.add(code)

    const fences = analysis.fences.filter(
      (fence) => fence.startLine > heading.line && fence.endLine <= end,
    )
    const fenceAt = new Map(fences.map((fence) => [fence.startLine, fence]))
    const fenceLines = new Set()
    for (const fence of fences) {
      for (let line = fence.startLine; line <= fence.endLine; line += 1) fenceLines.add(line)
    }
    const usedFences = new Set()

    const scopeLines = []
    const methodLines = []
    let method = null
    const steps = []
    let stepLines = 0

    for (let line = heading.line + 1; line <= end; line += 1) {
      if (fenceLines.has(line) || headingLines.has(line)) continue
      const raw = lines[line - 1]
      const trimmed = raw.trim()
      if (trimmed === '') continue

      const scopeMatch = SCOPE_PATTERN.exec(raw)
      if (scopeMatch !== null) {
        scopeLines.push({ line, value: stripInlineCode(scopeMatch[1]) })
        if (methodLines.length > 0 || stepLines > 0) {
          diagnostics.push(
            diagnostic(doc, line, 'diagnosis.scope.order', '作用范围必须写在诊断方式和步骤之前。'),
          )
        }
        continue
      }

      if (METHOD_PATTERN.test(trimmed)) {
        methodLines.push({ line, valid: true })
        if (method === null) method = METHOD_PATTERN.exec(trimmed)[1]
        if (stepLines > 0) {
          diagnostics.push(
            diagnostic(doc, line, 'diagnosis.method.order', '诊断方式必须写在步骤之前。'),
          )
        }
        if (methodLines.length > 1) {
          diagnostics.push(
            diagnostic(doc, line, 'diagnosis.method.multiple', '一个诊断码只能有一个诊断方式。'),
          )
        }
        continue
      }

      if (METHOD_LINE.test(trimmed)) {
        methodLines.push({ line, valid: false })
        diagnostics.push(
          diagnostic(
            doc,
            line,
            'diagnosis.method.value',
            '诊断方式必须是「诊断方式：静态代码审查」或「诊断方式：运行时日志审查」。',
          ),
        )
        continue
      }

      if (STEP_LINE.test(trimmed)) {
        stepLines += 1
        const staticMatch = STATIC_STEP_PATTERN.exec(trimmed)
        const insertMatch = INSERT_STEP_PATTERN.exec(trimmed)
        const viewMatch = VIEW_STEP_PATTERN.exec(trimmed)

        let step = null
        if (staticMatch !== null) {
          step = {
            kind: '静态',
            number: Number(staticMatch[1]),
            line,
            glob: capturedGlob(staticMatch, 2, 3),
          }
        } else if (insertMatch !== null) {
          step = {
            kind: '插入日志',
            number: Number(insertMatch[1]),
            line,
            glob: capturedGlob(insertMatch, 2, 3),
          }
        } else if (viewMatch !== null) {
          step = { kind: '查看日志', number: Number(viewMatch[1]), line, glob: null }
        }

        if (step === null) {
          diagnostics.push(
            diagnostic(
              doc,
              line,
              'diagnosis.step.format',
              '步骤格式不正确；请按诊断方式使用静态代码审查或运行时日志审查的步骤格式。',
            ),
          )
          continue
        }

        if (method === '静态代码审查' && step.kind !== '静态') {
          diagnostics.push(
            diagnostic(doc, line, 'diagnosis.step.format', '静态代码审查只能使用「查看 [文件通配] ...，如果 ...，则 ...，否则 ...」格式。'),
          )
          continue
        }
        if (method === '运行时日志审查' && step.kind === '静态') {
          diagnostics.push(
            diagnostic(
              doc,
              line,
              'diagnosis.step.format',
              '运行时日志审查只能使用「在 [文件通配] ...，插入日志：」或「查看日志，如果 ...」格式。',
            ),
          )
          continue
        }

        const expectedNumber = stepLines
        if (step.number !== expectedNumber) {
          diagnostics.push(
            diagnostic(
              doc,
              line,
              'diagnosis.step.number',
              `步骤编号必须连续：下一个应为 步骤${expectedNumber}，收到 步骤${step.number}。`,
            ),
          )
        }

        let matches = null
        if (step.glob !== null) {
          const issue = stepScopeIssue(step.glob)
          if (issue !== null) {
            diagnostics.push(diagnostic(doc, line, 'diagnosis.step.glob', issue))
          } else if (files !== undefined) {
            matches = files.filter((file) => scopeMatches(step.glob, file)).length
            if (matches === 0) {
              diagnostics.push(
                diagnostic(
                  doc,
                  line,
                  'diagnosis.step.no-match',
                  `步骤里的文件通配 ${step.glob} 没有命中任何项目文件。`,
                ),
              )
            }
          }
        }

        let hasLog = false
        if (step.kind === '插入日志') {
          let nextLine = -1
          for (let next = line + 1; next <= end; next += 1) {
            if (lines[next - 1].trim() !== '') {
              nextLine = next
              break
            }
          }
          const fence = nextLine === -1 ? undefined : fenceAt.get(nextLine)
          if (fence === undefined) {
            diagnostics.push(
              diagnostic(doc, line, 'diagnosis.step.log-missing', '插入日志步骤后面必须紧跟一个 ts 代码围栏。'),
            )
          } else {
            usedFences.add(fence)
            hasLog = LOG_LANGS.has(fence.lang)
            if (!LOG_LANGS.has(fence.lang)) {
              diagnostics.push(
                diagnostic(doc, fence.startLine, 'diagnosis.step.log-lang', '日志伪代码必须使用 ts 或 typescript 围栏。'),
              )
            } else if (fence.content.trim() === '') {
              diagnostics.push(
                diagnostic(doc, fence.startLine, 'diagnosis.step.log-empty', '日志伪代码不能为空。'),
              )
            }
          }
        }

        steps.push({ ...step, matches, log: hasLog })
        continue
      }

      diagnostics.push(
        diagnostic(
          doc,
          line,
          'diagnosis.body',
          '诊断码正文只允许作用范围、诊断方式和 步骤N： 行。',
        ),
      )
    }

    for (const fence of fences) {
      if (!usedFences.has(fence)) {
        diagnostics.push(
          diagnostic(
            doc,
            fence.startLine,
            'diagnosis.step.fence',
            '代码围栏必须紧跟在「步骤N：在 [文件通配] ...，插入日志：」之后。',
          ),
        )
      }
    }

    let scope = null
    let scopeKind = null
    let scopeLine = 0
    let scopeMatchesCount = null
    if (scopeLines.length === 0) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'diagnosis.scope.missing',
          '缺少「作用范围：全局」或「作用范围：<文件路径通配>」。',
        ),
      )
    } else {
      if (scopeLines.length > 1) {
        diagnostics.push(
          diagnostic(doc, scopeLines[1].line, 'diagnosis.scope.multiple', '一个诊断码只能有一个作用范围。'),
        )
      }
      scopeLine = scopeLines[0].line
      const value = scopeLines[0].value
      const issue = scopeIssue(value)
      if (issue !== null) {
        diagnostics.push(diagnostic(doc, scopeLine, 'diagnosis.scope.value', issue))
      } else {
        scope = value
        scopeKind = value === '全局' ? 'global' : 'glob'
        if (scopeKind === 'glob' && files !== undefined) {
          scopeMatchesCount = files.filter((file) => scopeMatches(value, file)).length
          if (scopeMatchesCount === 0) {
            diagnostics.push(
              diagnostic(
                doc,
                scopeLine,
                'diagnosis.scope.no-match',
                `作用范围 ${value} 没有命中任何项目文件；请修正通配或删除这个诊断码。`,
              ),
            )
          }
        }
      }
    }

    if (methodLines.length === 0) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'diagnosis.method.missing',
          '缺少「诊断方式：静态代码审查」或「诊断方式：运行时日志审查」。',
        ),
      )
    }

    if (stepLines === 0) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'diagnosis.step.missing', '诊断码至少需要一个 步骤N： 行。'),
      )
    }

    codes.push({
      doc,
      line: heading.line,
      code,
      severity,
      scope,
      scopeKind,
      method,
      steps,
      matches: scopeMatchesCount,
    })
  }

  return { diagnostics, codes }
}

/**
 * 只返回诊断文档的问题，便于单独测试。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {'error'|'warn'} severity - 文档级别。
 * @param {string[]} [files] - 项目文件（相对路径）。
 * @returns {object[]} 诊断。
 */
export function validateDiagnosis(doc, text, severity, files) {
  return inspectDiagnosis(doc, text, severity, files).diagnostics
}
