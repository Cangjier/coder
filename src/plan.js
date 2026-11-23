/**
 * `.coder/plan/` 下计划文档的解析和确定性检查。
 *
 * 计划文档用编码组织：
 *
 *   # T0001
 *   任务范围：src/**
 *   优先级：P1
 *   完成预期：
 *   1. 如果缺少格式校验，则 list 报告 plan.* 诊断，否则通过。
 *   当前进度：
 *   1. [src/**] 解析与校验已实现。
 *
 * goal 文档把 `优先级` 与 `当前进度` 换成 `关联ToDo`：
 *
 *   # G0001
 *   任务范围：src/**
 *   完成预期：
 *   1. 如果计划文档格式错误，则 list 报错，否则通过。
 *   关联ToDo：
 *   1. T0001
 *
 * todo.md / todo-archived.md 只放 T 开头的编码，goal.md / goal-archived.md
 * 只放 G 开头的编码。数字部分固定 4 位。完成的任务从 active 文档移到
 * archived 文档；同一个编码不能同时留在两边。
 *
 * `list` 只做机械检查：编码、字段顺序与重复、编号、完成预期句式、进度条目
 * 的文件通配、关联 ToDo 编码。计划是否真的完成、进度描述是否属实无法机械
 * 判断，不猜也不报。
 *
 * @module coder/plan
 */

import { scopeIssue, stepScopeIssue } from './scope.js'

/** 四份计划文档，相对于 `.coder/`。 */
export const PLAN_DOCS = Object.freeze([
  'plan/todo.md',
  'plan/todo-archived.md',
  'plan/goal.md',
  'plan/goal-archived.md',
])

/** 文档路径到文档类型的固定映射。 */
export const PLAN_KINDS = Object.freeze({
  'plan/todo.md': 'plan-todo',
  'plan/todo-archived.md': 'plan-todo-archived',
  'plan/goal.md': 'plan-goal',
  'plan/goal-archived.md': 'plan-goal-archived',
})

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
 * 根据 `.coder/` 相对路径取计划文档类型。
 *
 * @param {string} relative - 相对于 `.coder/` 的路径。
 * @returns {string|null} 计划文档类型；不是计划文档时为 null。
 */
export function planKindOf(relative) {
  return PLAN_KINDS[relative] ?? null
}

/**
 * 取标题所属段落的结束行；计划文档只认一级标题作为编码边界。
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
 * 解析并检查一份计划文档。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {string} kind - `PLAN_KINDS` 里的文档类型。
 * @returns {{diagnostics: object[], entries: object[]}} 诊断与计划条目。
 */
export function inspectPlan(doc, text, kind) {
  const meta = PLAN_META[kind]
  const diagnostics = []
  const entries = []

  if (text.trim() === '') return { diagnostics, entries }

  const lines = text.split(/\r?\n/)
  const headings = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING_PATTERN.exec(lines[index].trim())
    if (match !== null) {
      headings.push({ level: match[1].length, text: match[2].trim(), line: index + 1 })
    }
  }

  if (headings.length === 0) {
    diagnostics.push(
      diagnostic(doc, 1, 'plan.no-code', '计划文档里没有任何 # T0001 或 # G0001 编码。'),
    )
    return { diagnostics, entries }
  }

  const firstCodeLine = headings.find((heading) => heading.level === 1)?.line ?? lines.length + 1
  for (let line = 1; line < firstCodeLine; line += 1) {
    if (lines[line - 1].trim() !== '') {
      diagnostics.push(
        diagnostic(doc, line, 'plan.preamble', '第一个计划编码之前不能有正文；计划文档从编码标题开始。'),
      )
      break
    }
  }

  const order = FIELD_ORDER[meta.type]
  const headingLines = new Set(headings.filter((heading) => heading.level > 1).map((heading) => heading.line))
  const seenCodes = new Set()

  for (let headingIndex = 0; headingIndex < headings.length; headingIndex += 1) {
    const heading = headings[headingIndex]
    if (heading.level !== 1) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'plan.heading.level', '计划文档只用 # 写编码；字段和条目都写成普通行。'),
      )
      continue
    }

    const end = codeEnd(headings, headingIndex, lines.length)
    const codeMatch = CODE_PATTERN.exec(heading.text)
    if (codeMatch === null) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'plan.code.format',
          `计划编码必须是 T 或 G 加 4 位数字，例如 T0001；收到：${heading.text}`,
        ),
      )
      continue
    }

    const code = heading.text
    if (codeMatch[1] !== meta.prefix) {
      diagnostics.push(
        diagnostic(
          doc,
          heading.line,
          'plan.code.prefix',
          `${doc} 只能放 ${meta.prefix} 开头的编码；收到：${code}`,
        ),
      )
      continue
    }
    if (seenCodes.has(code)) {
      diagnostics.push(diagnostic(doc, heading.line, 'plan.code.duplicate', `计划编码重复：${code}`))
      continue
    }
    seenCodes.add(code)

    const fields = new Map()
    const items = new Map()
    const sectionCounts = new Map()
    let currentField = null
    let lastOrder = -1
    let scope = null
    let priority = null

    for (let line = heading.line + 1; line <= end; line += 1) {
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
            diagnostic(doc, line, 'plan.field.unexpected', `${meta.type} 文档不支持字段：${field}`),
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
        diagnostics.push(diagnostic(doc, heading.line, 'plan.field.missing', `缺少字段：${field}。`))
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
      line: heading.line,
      code,
      kind: meta.type,
      archived: meta.archived,
      scope,
      priority,
      expected: items.has('完成预期') ? items.get('完成预期').length : 0,
      progress: items.has('当前进度') ? items.get('当前进度').length : 0,
      todos: items.has('关联ToDo') ? items.get('关联ToDo').length : 0,
    })
  }

  return { diagnostics, entries }
}

/**
 * 只返回计划文档的问题，便于单独测试。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {string} kind - `PLAN_KINDS` 里的文档类型。
 * @returns {object[]} 诊断。
 */
export function validatePlan(doc, text, kind) {
  return inspectPlan(doc, text, kind).diagnostics
}
