/**
 * `.coder/plan/` 下计划条目的解析和确定性检查。
 *
 * 每个计划条目是一个独立文件，文件名就是编码：
 *
 *   .coder/plan/todo/T0001.md              进行中的待办
 *   .coder/plan/todo/archived/T0001.md     已归档的待办
 *   .coder/plan/goal/G0001.md              进行中的目标
 *   .coder/plan/goal/archived/G0001.md     已归档的目标
 *
 * 文件里只有一个编码标题，字段与编号条目跟在标题后面：
 *
 *   # T0001
 *
 *   任务范围：src/**
 *   优先级：P1
 *   完成预期：
 *   1. 如果缺少格式校验，则 list 报告 plan.* 诊断，否则通过。
 *   当前进度：
 *   1. [src/**] 解析与校验已实现。
 *
 * goal 文件把 `优先级` 与 `当前进度` 换成 `关联ToDo`：
 *
 *   # G0001
 *
 *   任务范围：src/**
 *   完成预期：
 *   1. 如果计划文件格式错误，则 list 报错，否则通过。
 *   关联ToDo：
 *   1. T0001
 *
 * todo 目录只放 T 编码，goal 目录只放 G 编码；数字部分固定 4 位。文件名决定
 * 条目落在哪个目录，标题里的编码必须与文件名一致。完成的任务从 active 目录
 * 移到 `archived/` 目录；同一个编码不能同时留在两边。
 *
 * `list` 只做机械检查：文件名与编码、字段顺序与重复、编号、完成预期句式、
 * 进度条目的文件通配、关联 ToDo 编码。任务是否真的完成、进度描述是否属实
 * 无法机械判断，不猜也不报。
 *
 * @module coder/plan
 */

import { scopeIssue, stepScopeIssue } from './scope.js'

/** `plan/todo/T0001.md`、`plan/todo/archived/T0001.md` 等。 */
const PLAN_PATH_PATTERN = /^plan\/(todo|goal)\/(archived\/)?([TG])(\d{4})\.md$/

/** 每种计划文档的类型、归档状态与编码前缀。 */
const PLAN_META = Object.freeze({
  'plan-todo': { type: 'todo', archived: false, prefix: 'T' },
  'plan-todo-archived': { type: 'todo', archived: true, prefix: 'T' },
  'plan-goal': { type: 'goal', archived: false, prefix: 'G' },
  'plan-goal-archived': { type: 'goal', archived: true, prefix: 'G' },
})

/** `# T0001` 或 `# G0001`。 */
const CODE_PATTERN = /^([TG])(\d{4})$/

/** ATX 标题。 */
const HEADING_PATTERN = /^(#{1,6})\s+(.*?)\s*$/

/** 字段行；值允许写在冒号后面，便于报告具体错误。 */
const FIELD_PATTERN = /^(任务范围|优先级|完成预期|当前进度|关联ToDo)\s*[：:]\s*(.*?)\s*$/

/** 编号条目：`1. ...`。 */
const ITEM_PATTERN = /^(\d+)\.\s+(.*)$/

/** 完成预期：`如果 ... 则 ...，否则 ...`；`则` 前允许一个逗号。 */
const EXPECT_PATTERN = /^如果\s*(.+?)\s*[，,]?\s*则\s*(.+?)\s*[，,]\s*否则\s*(.+)$/

/** 当前进度：`[文件通配] 说明`。 */
const PROGRESS_PATTERN = /^\[([^\]\r\n]+)\]\s+(\S.*)$/

/** 关联 ToDo：只认 T 加 4 位数字。 */
const TODO_REF_PATTERN = /^T\d{4}$/

/** 每个字段允许出现在哪些文档。 */
const FIELD_ORDER = Object.freeze({
  todo: Object.freeze(['任务范围', '优先级', '完成预期', '当前进度']),
  goal: Object.freeze(['任务范围', '完成预期', '关联ToDo']),
})

/** 段落的错误规则名。 */
const SECTION_RULES = Object.freeze({
  完成预期: 'expected',
  当前进度: 'progress',
  关联ToDo: 'todo',
})

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
 * 去掉值两边可能包着的一对反引号。
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
 * 根据 `.coder/` 相对路径取计划条目的元信息。
 *
 * 文件名决定类型与归档状态：`plan/todo/T0001.md` 是进行中的 todo，
 * `plan/todo/archived/T0001.md` 是已归档的 todo。目录与编码前缀不一致时
 * 仍然返回元信息，交给 `inspectPlan` 报编码前缀错误，避免把整个文件当成
 * 未知文档。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {{kind: string, type: 'todo'|'goal', archived: boolean, prefix: 'T'|'G', code: string}|null} 元信息；不是计划文件时为 null。
 */
export function planMetaOf(relative) {
  const match = PLAN_PATH_PATTERN.exec(relative)
  if (match === null) return null
  const [, type, archivedDir, prefix, digits] = match
  const archived = archivedDir !== undefined
  return {
    kind: archived ? `plan-${type}-archived` : `plan-${type}`,
    type,
    archived,
    prefix,
    code: `${prefix}${digits}`,
  }
}

/**
 * 根据 `.coder/` 相对路径取计划文档类型。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {string|null} 计划文档类型；不是计划文件时为 null。
 */
export function planKindOf(relative) {
  return planMetaOf(relative)?.kind ?? null
}

/**
 * 取标题所属段落的结束行；计划文件只认一级标题作为编码边界。
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
 * 校验一条完成预期。
 *
 * @param {string} body - 去掉 `N. ` 之后的文本。
 * @returns {boolean} 是否符合「如果 ... 则 ...，否则 ...」。
 */
function isExpectation(body) {
  const normalized = body.replace(/[。.]\s*$/, '')
  return EXPECT_PATTERN.test(normalized)
}

/**
 * 解析并检查一份计划文件。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {string} kind - `PLAN_META` 里的文档类型。
 * @param {string|null} [code] - 文件名给出的编码；为 null 时不检查文件名与标题是否一致。
 * @returns {{diagnostics: object[], entries: object[]}} 诊断与计划条目。
 */
export function inspectPlan(doc, text, kind, code = null) {
  const meta = PLAN_META[kind]
  const diagnostics = []
  const entries = []

  if (text.trim() === '') {
    diagnostics.push(
      diagnostic(
        doc,
        1,
        'plan.no-code',
        `计划文件是空的；每个计划文件都要有一个 ${meta.prefix} 加 4 位数字的编码标题。`,
      ),
    )
    return { diagnostics, entries }
  }

  const lines = text.split(/\r?\n/)
  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING_PATTERN.exec(lines[index].trim())
    if (match !== null) {
      headings.push({ level: match[1].length, text: match[2].trim(), line: index + 1 })
    }
  }

  const first = headings.find((heading) => heading.level === 1)
  if (first === undefined) {
    diagnostics.push(
      diagnostic(doc, 1, 'plan.no-code', '计划文件里没有任何 # T0001 或 # G0001 编码标题。'),
    )
    return { diagnostics, entries }
  }

  for (let line = 1; line < first.line; line += 1) {
    if (lines[line - 1].trim() !== '') {
      diagnostics.push(
        diagnostic(doc, line, 'plan.preamble', '第一个计划编码之前不能有正文；计划文件从编码标题开始。'),
      )
      break
    }
  }

  for (const heading of headings) {
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'plan.heading.level', '计划文件只用 # 写编码；字段和条目都写成普通行。'),
      )
    } else if (heading !== first) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'plan.code.multiple',
          '每个计划文件只放一个编码；第二个 # 标题不能出现在这里，新的条目应写成单独的 T####.md 或 G####.md。',
        ),
      )
    }
  }

  const codeMatch = CODE_PATTERN.exec(first.text)
  if (codeMatch === null) {
    diagnostics.push(
      diagnostic(
        doc,
        first.line,
        'plan.code.format',
        `计划编码必须是 T 或 G 加 4 位数字，例如 T0001；收到：${first.text}`,
      ),
    )
    return { diagnostics, entries }
  }
  if (codeMatch[1] !== meta.prefix) {
    diagnostics.push(
      diagnostic(
        doc,
        first.line,
        'plan.code.prefix',
        `${doc} 只能放 ${meta.prefix} 开头的编码；收到：${first.text}`,
      ),
    )
    return { diagnostics, entries }
  }
  if (code !== null && first.text !== code) {
    diagnostics.push(
      diagnostic(
        doc,
        first.line,
        'plan.file.code',
        `文件名编码 ${code} 与标题编码 ${first.text} 不一致；文件名就是条目编码。`,
      ),
    )
    return { diagnostics, entries }
  }

  const order = FIELD_ORDER[meta.type]
  const end = codeEnd(headings, headings.indexOf(first), lines.length)
  const headingLines = new Set(headings.filter((heading) => heading.level > 1).map((heading) => heading.line))
  const fields = new Map()
  const items = new Map()
  const sectionCounts = new Map()
  let currentField = null
  let lastOrder = -1
  let scope = null
  let priority = null

  for (let line = first.line + 1; line <= end; line += 1) {
    if (headingLines.has(line)) continue
    const raw = lines[line - 1].trim()
    if (raw === '') continue

    const fieldMatch = FIELD_PATTERN.exec(raw)
    if (fieldMatch !== null) {
      const field = fieldMatch[1]
      const value = fieldMatch[2]
      const index = order.indexOf(field)
      if (index === -1) {
        diagnostics.push(
          diagnostic(doc, line, 'plan.field.unexpected', `${meta.type} 文件不支持字段：${field}`),
        )
        currentField = null
        continue
      }
      if (fields.has(field)) {
        diagnostics.push(
          diagnostic(doc, line, 'plan.field.multiple', `字段重复：${field}（第一次出现在第 ${fields.get(field).line} 行）。`),
        )
      } else {
        fields.set(field, { line, value })
      }
      if (index < lastOrder) {
        diagnostics.push(
          diagnostic(doc, line, 'plan.field.order', `字段顺序必须是：${order.join(' → ')}；${field} 的位置不对。`),
        )
      }
      lastOrder = Math.max(lastOrder, index)
      currentField = field
      sectionCounts.set(field, 0)

      if (field === '任务范围') {
        const normalized = stripInlineCode(value)
        if (normalized === '') {
          diagnostics.push(diagnostic(doc, line, 'plan.scope.empty', '任务范围不能为空。'))
        } else {
          const issue = scopeIssue(normalized)
          if (issue !== null) diagnostics.push(diagnostic(doc, line, 'plan.scope.value', issue))
          else scope = normalized
        }
      } else if (field === '优先级') {
        if (value !== 'P1' && value !== 'P2' && value !== 'P3') {
          diagnostics.push(diagnostic(doc, line, 'plan.priority.value', `优先级必须是 P1、P2 或 P3；收到：${value}`))
        } else {
          priority = value
        }
      } else if (value !== '') {
        diagnostics.push(
          diagnostic(doc, line, 'plan.field.inline', `${field} 的值必须写在后续的编号条目里，不能写在同一行。`),
        )
      }
      continue
    }

    const itemMatch = ITEM_PATTERN.exec(raw)
    if (itemMatch === null) {
      diagnostics.push(
        diagnostic(doc, line, 'plan.body', '编码正文只允许字段行和 `N. ...` 编号条目。'),
      )
      continue
    }
    if (currentField === null || !SECTION_RULES[currentField]) {
      diagnostics.push(
        diagnostic(doc, line, 'plan.body', `编号条目必须写在「${order.join(' → ')}」字段之后。`),
      )
      continue
    }

    const section = SECTION_RULES[currentField]
    const number = Number(itemMatch[1])
    const body = itemMatch[2].trim()
    const count = (sectionCounts.get(currentField) ?? 0) + 1
    sectionCounts.set(currentField, count)

    if (number !== count) {
      diagnostics.push(
        diagnostic(
          doc,
          line,
          `plan.${section}.number`,
          `编号必须连续：下一个应为 ${count}.，收到 ${number}.。`,
        ),
      )
    }

    if (currentField === '完成预期') {
      if (!isExpectation(body)) {
        diagnostics.push(
          diagnostic(
            doc,
            line,
            'plan.expected.format',
            '完成预期必须写成「如果 ... 则 ...，否则 ...」。',
          ),
        )
      } else {
        if (!items.has(currentField)) items.set(currentField, [])
        items.get(currentField).push({ number, line, text: body })
      }
    } else if (currentField === '当前进度') {
      const progress = PROGRESS_PATTERN.exec(body)
      if (progress === null) {
        diagnostics.push(
          diagnostic(doc, line, 'plan.progress.format', '当前进度必须写成「[文件路径通配] 说明」。'),
        )
      } else {
        const issue = stepScopeIssue(progress[1].trim())
        if (issue !== null) {
          diagnostics.push(diagnostic(doc, line, 'plan.progress.glob', issue))
        } else {
          if (!items.has(currentField)) items.set(currentField, [])
          items.get(currentField).push({ number, line, scope: progress[1].trim(), text: progress[2] })
        }
      }
    } else if (currentField === '关联ToDo') {
      if (!TODO_REF_PATTERN.test(body)) {
        diagnostics.push(
          diagnostic(doc, line, 'plan.todo.format', '关联ToDo 必须是 T 加 4 位数字，例如 T0001。'),
        )
      } else {
        if (!items.has(currentField)) items.set(currentField, [])
        items.get(currentField).push({ number, line, code: body })
      }
    }
  }

  for (const field of order) {
    if (!fields.has(field)) {
      diagnostics.push(diagnostic(doc, first.line, 'plan.field.missing', `缺少字段：${field}。`))
    } else if (SECTION_RULES[field] && (sectionCounts.get(field) ?? 0) === 0) {
      diagnostics.push(
        diagnostic(
          doc,
          fields.get(field).line,
          `plan.${SECTION_RULES[field]}.empty`,
          `${field} 下面至少需要一个编号条目。`,
        ),
      )
    }
  }

  entries.push({
    doc,
    line: first.line,
    code: first.text,
    kind: meta.type,
    archived: meta.archived,
    scope,
    priority,
    expected: items.has('完成预期') ? items.get('完成预期').length : 0,
    progress: items.has('当前进度') ? items.get('当前进度').length : 0,
    todos: items.has('关联ToDo') ? items.get('关联ToDo').length : 0,
  })

  return { diagnostics, entries }
}

/**
 * 只返回计划文件的问题，便于单独测试。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文件正文。
 * @param {string} kind - `PLAN_META` 里的文档类型。
 * @param {string|null} [code] - 文件名给出的编码。
 * @returns {object[]} 诊断。
 */
export function validatePlan(doc, text, kind, code = null) {
  return inspectPlan(doc, text, kind, code).diagnostics
}
