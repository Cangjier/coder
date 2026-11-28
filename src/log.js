/**
 * `.coder/logs/` 下日志条目的解析和确定性检查。
 *
 * 日志分三类，各自一个目录，一个条目一个文件，文件名用日期序号：
 *
 *   .coder/logs/audit/2026-11-28-001.md     审计日志
 *   .coder/logs/update/2026-11-28-001.md    产品更新日志
 *   .coder/logs/usage/2026-11-28-001.md     使用报告日志
 *
 * 文件名由 `YYYY-MM-DD` 与三位序号组成，日期必须是真实存在的日期，同一天
 * 的序号从 001 开始连续。文件里只有一个与文件名一致的一级标题，字段跟在
 * 标题后面：
 *
 *   # 2026-11-28-001
 *
 *   审计范围：src/**
 *   审计结论：格式与交叉引用通过
 *   说明：可选的补充
 *
 *   # 2026-11-28-001
 *
 *   版本：0.1.0
 *   更新内容：
 *   1. 增加日志目录与检查
 *
 *   # 2026-11-28-001
 *
 *   使用场景：业务录入
 *   使用反馈：字段太多
 *
 * 三类日志共用「说明」作为可选补充字段；产品更新日志用 `版本` 与编号条目
 * `更新内容` 代替另外两类的字段。字段顺序固定，值不能为空。
 *
 * `list` 只做机械检查：日期是否真实、序号是否连续、标题与文件名是否一致、
 * 字段顺序与必填、编号是否连续。日志内容是否属实无法机械判断，不猜也不报。
 *
 * @module coder/log
 */

import { analyzeMarkdown } from './markdown.js'

/** 日志目录，相对于 `.coder/`。 */
export const LOG_DIR = 'logs'

/** 审计日志目录，相对于 `.coder/`。 */
export const LOG_AUDIT_DIR = 'logs/audit'

/** 产品更新日志目录，相对于 `.coder/`。 */
export const LOG_UPDATE_DIR = 'logs/update'

/** 使用报告日志目录，相对于 `.coder/`。 */
export const LOG_USAGE_DIR = 'logs/usage'

/** 日志文件：`logs/<audit|update|usage>/YYYY-MM-DD-NNN.md`。 */
export const LOG_FILE_PATTERN = /^logs\/(audit|update|usage)\/(\d{4}-\d{2}-\d{2})-(\d{3})\.md$/

/** 每种日志的类型、标题与字段顺序。 */
const LOG_META = Object.freeze({
  'log-audit': Object.freeze({
    type: 'audit',
    label: '审计日志',
    fields: Object.freeze(['审计范围', '审计结论', '说明']),
    lists: false,
  }),
  'log-update': Object.freeze({
    type: 'update',
    label: '产品更新日志',
    fields: Object.freeze(['版本', '更新内容', '说明']),
    lists: true,
  }),
  'log-usage': Object.freeze({
    type: 'usage',
    label: '使用报告日志',
    fields: Object.freeze(['使用场景', '使用反馈', '说明']),
    lists: false,
  }),
})

/** 每种日志必填的字段。 */
const REQUIRED_FIELDS = Object.freeze({
  'log-audit': Object.freeze(['审计范围', '审计结论']),
  'log-update': Object.freeze(['版本', '更新内容']),
  'log-usage': Object.freeze(['使用场景', '使用反馈']),
})

/** 字段行；字段名不能以空白或冒号开头。 */
const FIELD_PATTERN = /^([^\s：:][^：:]*?)\s*[：:]\s*(.*?)\s*$/

/** 编号条目：`1. ...`。 */
const ITEM_PATTERN = /^(\d+)\.\s*(.*)$/

/**
 * 构造一条诊断。
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
 * 判断 `YYYY-MM-DD` 是否是真实存在的日期。
 *
 * @param {string} value - 日期文本。
 * @returns {boolean} 是否合法。
 */
export function isRealDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/**
 * 根据 `.coder/` 相对路径判断日志文档类型。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {'log-audit'|'log-update'|'log-usage'|null} 文档类型；不是日志文件时为 null。
 */
export function logKindOf(relative) {
  const match = LOG_FILE_PATTERN.exec(relative)
  if (match === null) return null
  return `log-${match[1]}`
}

/**
 * 判断一个相对路径是否是日志文件。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {boolean} 是否是日志文件。
 */
export function isLogDoc(relative) {
  return logKindOf(relative) !== null
}

/**
 * 从日志文件路径里取日期与序号。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {{kind: 'audit'|'update'|'usage', date: string, sequence: string, stem: string}|null} 元信息；不是日志文件时为 null。
 */
export function logMetaOf(relative) {
  const match = LOG_FILE_PATTERN.exec(relative)
  if (match === null) return null
  return {
    kind: match[1],
    date: match[2],
    sequence: match[3],
    stem: `${match[2]}-${match[3]}`,
  }
}

/**
 * 检查一个日志文件的内容格式。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {'log-audit'|'log-update'|'log-usage'} kind - 文档类型。
 * @param {{date: string, sequence: string, stem: string}} meta - 文件名给出的日期与序号。
 * @returns {{diagnostics: object[], entry: object|null}} 诊断与日志条目。
 */
export function inspectLog(doc, text, kind, meta) {
  const info = LOG_META[kind]
  const order = info.fields
  const required = REQUIRED_FIELDS[kind]
  const diagnostics = []
  const values = new Map()
  const items = new Map()

  if (!isRealDate(meta.date)) {
    diagnostics.push(
      diagnostic(doc, 1, 'log.file.date', `文件名里的日期必须是真实存在的 YYYY-MM-DD；收到：${meta.date}`),
    )
  }
  if (Number(meta.sequence) === 0) {
    diagnostics.push(diagnostic(doc, 1, 'log.file.sequence', '序号必须从 001 开始，不能是 000。'))
  }

  if (text.trim() === '') {
    diagnostics.push(
      diagnostic(
        doc,
        1,
        'log.empty',
        `${info.label}文件是空的；写一个与文件名一致的标题和固定字段：${required.join('、')}。`,
      ),
    )
    return { diagnostics, entry: null }
  }

  const analysis = analyzeMarkdown(text)
  const lines = analysis.lines
  const headings = analysis.headings

  const first = headings.find((heading) => heading.level === 1)
  if (first === undefined) {
    diagnostics.push(
      diagnostic(doc, 1, 'log.title.missing', `缺少一级标题；标题必须与文件名一致：# ${meta.stem}`),
    )
    return { diagnostics, entry: null }
  }

  for (let line = 1; line < first.line; line += 1) {
    if (lines[line - 1].trim() !== '' && !analysis.masked[line - 1]) {
      diagnostics.push(diagnostic(doc, line, 'log.preamble', '第一个标题之前不能有正文；日志从标题开始。'))
      break
    }
  }

  if (first.text !== meta.stem) {
    diagnostics.push(
      diagnostic(
        doc,
        first.line,
        'log.title.format',
        `标题必须与文件名一致：# ${meta.stem}；收到：${first.text}`,
      ),
    )
  }

  for (const heading of headings) {
    if (heading === first) continue
    diagnostics.push(
      diagnostic(
        doc,
        heading.line,
        'log.heading.extra',
        '日志文件只有一个标题，字段和编号条目写成普通行。',
      ),
    )
  }

  const headingLines = new Set(headings.map((heading) => heading.line))
  let currentField = null
  let lastOrder = -1

  for (let line = first.line + 1; line <= lines.length; line += 1) {
    if (headingLines.has(line) || analysis.masked[line - 1]) continue
    const raw = lines[line - 1].trim()
    if (raw === '') continue

    const itemFirst = ITEM_PATTERN.exec(raw)
    if (itemFirst !== null) {
      if (currentField !== '更新内容') {
        diagnostics.push(diagnostic(doc, line, 'log.item.unexpected', '编号条目只能写在「更新内容」字段下面。'))
        continue
      }
      const number = Number(itemFirst[1])
      const body = itemFirst[2].trim()
      const count = (items.get('更新内容') ?? 0) + 1
      items.set('更新内容', count)
      if (number !== count) {
        diagnostics.push(
          diagnostic(doc, line, 'log.item.number', `编号必须连续：下一个应为 ${count}.，收到 ${number}.。`),
        )
      }
      if (body === '') {
        diagnostics.push(diagnostic(doc, line, 'log.item.empty', '编号条目不能为空。'))
      }
      continue
    }

    const fieldMatch = FIELD_PATTERN.exec(raw)
    if (fieldMatch !== null) {
      const field = fieldMatch[1].trim()
      const value = fieldMatch[2].trim()
      const index = order.indexOf(field)
      if (index === -1) {
        diagnostics.push(diagnostic(doc, line, 'log.field.unexpected', `${info.label}不支持字段：${field}`))
        currentField = null
        continue
      }
      if (values.has(field)) {
        diagnostics.push(
          diagnostic(
            doc,
            line,
            'log.field.multiple',
            `字段重复：${field}（第一次出现在第 ${values.get(field).line} 行）。`,
          ),
        )
      } else {
        values.set(field, { line, value })
      }
      if (index < lastOrder) {
        diagnostics.push(
          diagnostic(doc, line, 'log.field.order', `字段顺序必须是：${order.join(' → ')}；${field} 的位置不对。`),
        )
      }
      lastOrder = Math.max(lastOrder, index)
      currentField = field
      items.set(field, items.get(field) ?? 0)
      if (field === '更新内容') {
        if (value !== '') {
          diagnostics.push(
            diagnostic(doc, line, 'log.field.inline', '更新内容的值必须写成后续的编号条目，不能写在同一行。'),
          )
        }
      } else if (value === '') {
        diagnostics.push(diagnostic(doc, line, 'log.field.empty', `${field} 不能为空。`))
      }
      continue
    }

    diagnostics.push(
      diagnostic(doc, line, 'log.body', '正文只允许字段行和 `N. ...` 编号条目。'),
    )
  }

  for (const field of required) {
    if (!values.has(field)) {
      diagnostics.push(diagnostic(doc, first.line, 'log.field.missing', `缺少字段：${field}。`))
    } else if (field === '更新内容' && (items.get(field) ?? 0) === 0) {
      diagnostics.push(
        diagnostic(doc, values.get(field).line, 'log.item.missing', '更新内容下面至少需要一个编号条目。'),
      )
    }
  }

  const entry = {
    doc,
    line: first.line,
    kind: info.type,
    date: meta.date,
    sequence: meta.sequence,
    version: values.get('版本')?.value ?? null,
    scope: values.get('审计范围')?.value ?? null,
    conclusion: values.get('审计结论')?.value ?? null,
    scenario: values.get('使用场景')?.value ?? null,
    feedback: values.get('使用反馈')?.value ?? null,
    items: items.get('更新内容') ?? 0,
  }

  return { diagnostics, entry }
}

/**
 * 只返回日志文件的问题，便于单独测试。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {'log-audit'|'log-update'|'log-usage'} kind - 文档类型。
 * @param {{date: string, sequence: string, stem: string}} meta - 文件名给出的日期与序号。
 * @returns {object[]} 诊断。
 */
export function validateLog(doc, text, kind, meta) {
  return inspectLog(doc, text, kind, meta).diagnostics
}
