/**
 * codes.jsonl 的纯逻辑：解析、校验、序列化、作用范围。
 *
 * 同一段代码被三处使用：Node 侧读写仓库里的 codes.jsonl、编辑器 HTML（整段内联进页面）、
 * 单元测试。所以这里不 import 任何东西、不用顶层 await，内联时只去掉行首的 `export`。
 *
 * 约定：
 * - `code` 的前缀决定族（D = Debug，Q = Quality），`kind` 只是把前缀写下来的副本；
 *   两者不一致时算错误而不是悄悄改，否则文件内容和本次运行的判定会不一致。
 * - `check` 是检查类型：`static`（读代码就能判定）/ `runtime`（必须跑起来观察）。
 *   和族是两件事——族说的是这条规则管什么，check 说的是怎么证实它。
 * - `enabled` 为 false 的码留在文件里，但不参与诊断：不进提示词、不可能产生诊断。
 *   默认 true，所以老文件不需要补这个字段。
 * - `targets` 是这条码**涉及的对象**：class / interface / method 的名字（也可以写 `Type#member`）。
 *   空数组表示没限定；有名字时，代理只该在这些对象上取证。
 * - `fix` 是**解决思路**：这条规则被违反时怎么改才算满足它。生成时必填（代理不给就打回），
 *   读文件时可以为空 —— 老文件没有这个字段，不该因此打不开。
 */

/** 与 src/diagnostics.mjs 的 SEVERITIES 保持一致（有测试盯着）。 */
export const SEVERITIES = ['error', 'warning', 'info']

/** 检查类型：静态读代码 / 运行期观察。 */
export const CHECK_TYPES = ['static', 'runtime']

/** 输出时的字段顺序，固定下来 diff 才稳定。 */
export const FIELD_ORDER = ['code', 'kind', 'check', 'enabled', 'severity', 'rule', 'detect', 'fix', 'targets']

/** 曾经有过、现在已经去掉的字段：读进来就丢掉，不当作「用户手写的未知字段」保留。 */
export const REMOVED_FIELDS = ['title', 'include', 'exclude']

/** 涉及的对象：class / interface / method 的名字。 */
export const TARGET_FIELDS = ['targets']

/** 码的形态：D/Q + 2~4 位数字。 */
export const CODE_PATTERN = /^[DQ][0-9]{2,4}$/

/** 行数上限：超过这个数说明不是诊断码，是数据文件。 */
export const MAX_ROWS = 400

/**
 * @param {unknown} code
 * @returns {'debug'|'quality'|null}
 */
export function kindOfCode(code) {
  const text = String(code == null ? '' : code).trim().toUpperCase()
  const first = text.charAt(0)
  if (first === 'D') return 'debug'
  if (first === 'Q') return 'quality'
  return null
}

/**
 * 把「数组 / 逗号或换行分隔的字符串」读成对象列表。
 *
 * targets 可以是精确名字（`Session#append`），也可以是一句泛化的描述
 * （`所有 XxxService`）——所以这里只做切分、去首尾空白、去重，别的都不判断：
 * 机械判断不了「这句话指哪些类」，那是读代码的人（或代理）的事。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function targetsOf(value) {
  let items = []
  if (Array.isArray(value)) items = value
  else if (typeof value === 'string') items = value.split(/[,\n]/)
  else if (value === undefined || value === null) items = []
  else items = [value]

  const out = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const text = item.trim().replace(/\s*\n\s*/g, ' ')
    if (!text) continue
    if (out.indexOf(text) < 0) out.push(text)
  }
  return out
}

/**
 * 一条码的检查类型。写错或没写就按族给个默认：D 码靠运行、Q 码靠读代码。
 *
 * @param {unknown} value
 * @param {string} [kind]
 * @returns {'static'|'runtime'}
 */
export function checkOf(value, kind) {
  const text = String(value == null ? '' : value).trim().toLowerCase()
  if (CHECK_TYPES.indexOf(text) >= 0) return text
  return kind === 'quality' ? 'static' : 'runtime'
}

/**
 * 是否启用。没写就是启用——老文件不需要补字段。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function enabledOf(value) {
  if (value === false || value === 0) return false
  const text = String(value == null ? '' : value).trim().toLowerCase()
  return !(text === 'false' || text === 'no' || text === 'off' || text === '0')
}

/**
 * 把任意对象规整成一行码：必填字段转字符串，未知字段原样保留（手写的备注不该被吃掉）。
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeRow(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const code = String(source.code == null ? '' : source.code).trim()
  const declared = source.kind === 'quality' ? 'quality' : source.kind === 'debug' ? 'debug' : null
  const kind = declared || kindOfCode(code) || 'debug'
  const row = {
    code,
    kind,
    check: checkOf(source.check, kind),
    enabled: enabledOf(source.enabled),
    severity: String(source.severity == null ? '' : source.severity).trim() || 'warning',
    // 文档里的「- 必须…」连列表符号一起被抄下来时，去掉符号，只留那句话。
    rule: String(source.rule == null ? '' : source.rule).trim().replace(/^[-*+>]\s+/, ''),
    detect: String(source.detect == null ? '' : source.detect).trim(),
    // 解决思路：怎么改才算满足这条规则。老文件没有它，读进来就是空字符串。
    fix: String(source.fix == null ? '' : source.fix).trim(),
    targets: targetsOf(source.targets),
  }
  for (const key of Object.keys(source)) {
    if (FIELD_ORDER.indexOf(key) >= 0 || REMOVED_FIELDS.indexOf(key) >= 0) continue
    if (key.charAt(0) === '_' && key.charAt(1) === '_') continue
    row[key] = source[key]
  }
  return row
}

/**
 * 解析 JSONL 文本。坏行不丢：进 problems，其余照常返回。
 *
 * 每行会带一个 `__line`（只在本进程里有意义，序列化时丢掉），
 * 这样校验报错能直接指到文件行号，用户打开编辑器就能对上。
 *
 * @param {string} text
 * @returns {{ rows: Array<object>, problems: Array<object> }}
 */
export function parseCodes(text) {
  const rows = []
  const problems = []
  const lines = String(text == null ? '' : text).split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line) continue
    const lineNo = i + 1
    let value
    try {
      value = JSON.parse(line)
    } catch {
      problems.push({ line: lineNo, index: -1, field: null, message: `第 ${lineNo} 行不是合法 JSON` })
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push({ line: lineNo, index: -1, field: null, message: `第 ${lineNo} 行不是 JSON 对象` })
      continue
    }
    const row = normalizeRow(value)
    row.__line = lineNo
    rows.push(row)
  }
  return { rows, problems }
}

/**
 * 序列化：一行一个对象，字段顺序固定，空的 targets 也写出来（空数组 = 不限制）。
 *
 * @param {Array<object>} rows
 * @returns {string}
 */
export function serializeCodes(rows) {
  const lines = []
  for (const raw of rows || []) {
    const row = normalizeRow(raw)
    const out = {}
    for (const field of FIELD_ORDER) out[field] = row[field]
    for (const key of Object.keys(row)) {
      if (FIELD_ORDER.indexOf(key) >= 0) continue
      out[key] = row[key]
    }
    lines.push(JSON.stringify(out))
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/**
 * 校验整张表。返回空数组才算可以落盘 / 可以进提示词。
 *
 * targets 不校验形态：它可能是精确名字，也可能是一句泛化的描述，机械判断不了。
 *
 * @param {Array<object>} rows
 * @returns {Array<{ index: number, field: string | null, message: string }>}
 */
export function validateRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  const problems = []
  const push = (index, field, message) => problems.push({ index, field, message })

  if (list.length > MAX_ROWS) {
    push(-1, null, `诊断码 ${list.length} 条，超过上限 ${MAX_ROWS} 条`)
  }

  const seen = new Map()
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i] || {}
    const where = labelOf(row, i)
    const code = String(row.code == null ? '' : row.code).trim()
    const kind = kindOfCode(code)
    const declared = row.kind === 'quality' ? 'quality' : row.kind === 'debug' ? 'debug' : null

    if (!code) push(i, 'code', `${where}：code 为空`)
    else if (!CODE_PATTERN.test(code)) push(i, 'code', `${where}：code「${code}」应形如 D01 / Q002（D 或 Q + 2~4 位数字）`)
    else if (kind && declared && declared !== kind) push(i, 'kind', `${where}：code 是 ${code}，kind 应为 ${kind}`)

    if (SEVERITIES.indexOf(String(row.severity)) < 0) {
      push(i, 'severity', `${where}：severity「${row.severity}」只能是 ${SEVERITIES.join(' / ')}`)
    }
    if (!String(row.rule == null ? '' : row.rule).trim()) push(i, 'rule', `${where}：rule 为空`)
    if (!String(row.detect == null ? '' : row.detect).trim()) push(i, 'detect', `${where}：detect 为空`)

    if (code) {
      if (seen.has(code)) push(i, 'code', `${where}：码 ${code} 重复（和第 ${seen.get(code)} 条同一个码）`)
      else seen.set(code, i + 1)
    }
  }
  return problems
}

/**
 * @param {object} row
 * @param {number} index
 * @returns {string}
 */
function labelOf(row, index) {
  return row && row.__line ? `第 ${row.__line} 行` : `第 ${index + 1} 条`
}

/**
 * 给人看的一句话：这条码涉及哪些对象。
 *
 * @param {object} code
 * @returns {string}
 */
export function targetsLabelOf(code) {
  const targets = targetsOf(code && code.targets)
  return targets.length === 0 ? '全部代码' : targets.join(', ')
}

/**
 * Debug 在前、质量在后，同族按码排。
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareRows(a, b) {
  if (a.kind !== b.kind) return a.kind === 'debug' ? -1 : 1
  return String(a.code).localeCompare(String(b.code))
}

/**
 * @param {Array<object>} rows
 * @returns {{ total: number, debug: number, quality: number, static: number, runtime: number, disabled: number }}
 */
export function countsOf(rows) {
  const list = rows || []
  const count = (test) => list.filter(test).length
  return {
    total: list.length,
    debug: count((row) => row.kind === 'debug'),
    quality: count((row) => row.kind === 'quality'),
    static: count((row) => checkOf(row.check, row.kind) === 'static'),
    runtime: count((row) => checkOf(row.check, row.kind) === 'runtime'),
    disabled: count((row) => enabledOf(row.enabled) === false),
  }
}

/**
 * 批量移除未启用的码：`enabled: false` 的整条丢掉，其余原样保留（顺序不变）。
 *
 * 和「全部禁用」不一样：那个只改开关，这个是真的把条目从文件里删掉 ——
 * 所以页面让它先确认，而且只改内存，点保存才落盘。
 *
 * @param {Array<object> | null} rows
 * @returns {Array<object> | null}
 */
export function withoutDisabled(rows) {
  if (!Array.isArray(rows)) return rows
  return rows.filter((row) => enabledOf(row && row.enabled) !== false)
}

/**
 * 新增一行时给个空位上没人用的码。
 *
 * @param {Array<object>} rows
 * @param {'debug'|'quality'} kind
 * @returns {string}
 */
export function nextCode(rows, kind) {
  const prefix = kind === 'quality' ? 'Q' : 'D'
  let max = 0
  for (const row of rows || []) {
    const code = String(row.code == null ? '' : row.code).trim()
    if (!CODE_PATTERN.test(code) || code.charAt(0).toUpperCase() !== prefix) continue
    const value = Number(code.slice(1))
    if (value > max) max = value
  }
  // 码的习惯写法是 D001：补到 3 位，超过 999 自然变长。
  return prefix + String(max + 1).padStart(3, '0')
}
