/**
 * 计划文档的格式检查：todo / goal 的编码、字段、编号、完成预期、
 * 当前进度、关联 ToDo，以及 active 与 archived 的归档一致性。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs, validateDocument } from '../src/docs.js'
import { inspectPlan, validatePlan } from '../src/plan.js'
import { MODULES_EMPTY, PLAN_GOAL, PLAN_GOAL_ARCHIVED, PLAN_TODO, PLAN_TODO_ARCHIVED } from './fixtures.js'

const TODO = PLAN_TODO
const GOAL = PLAN_GOAL

const FILE_OK = `# src
源代码目录
# tmp/**
暂存目录
`

const ARCHITECTURE_OK = `# 架构
## 全局视角
全局说明。
\`\`\`mermaid
flowchart TB
  subgraph 宿主层
    A[Host]
  end
\`\`\`
## 局部视角：扫描
局部说明。
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`

const FLOW_OK = `# 流程
## 检查
\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`
`

const DATA_OK = `# 数据结构
## 诊断
说明。
\`\`\`ts
export interface Diagnostic {
  doc: string
}
\`\`\`
`

const ERROR_OK = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [**] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`

const WARN_OK = `# W0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [**] 入口代码，如果缺少导出，则认定为 W0001，否则继续。
`

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-plan-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 在某份计划文档上跑一次校验。
 * @param {string} text - 文档正文。
 * @param {string} [kind] - 文档类型。
 * @param {string} [doc] - 展示用路径。
 * @returns {object[]} 诊断。
 */
function check(text, kind = 'plan-todo', doc = '.coder/plan/todo.md') {
  return validatePlan(doc, text, kind)
}

/**
 * 找某条规则。
 * @param {object[]} diagnostics - 诊断。
 * @param {string} rule - 规则代码。
 * @returns {object|undefined} 第一条。
 */
function ruleOf(diagnostics, rule) {
  return diagnostics.find((item) => item.rule === rule)
}

/**
 * 写一棵完整的合法项目。
 * @param {Record<string, string>} [overrides] - 覆盖指定文档。
 * @returns {string} 项目根目录。
 */
function writeProject(overrides = {}) {
  const root = mkdtempSync(join(tempRoot, 'tree-'))
  const files = {
    '.coder/design/file.md': FILE_OK,
    '.coder/design/architecture.md': ARCHITECTURE_OK,
    '.coder/design/flow.md': FLOW_OK,
    '.coder/design/data_structure.md': DATA_OK,
    '.coder/design/modules.md': MODULES_EMPTY,
    '.coder/diagnosis/error.md': ERROR_OK,
    '.coder/diagnosis/warn.md': WARN_OK,
    '.coder/plan/todo.md': PLAN_TODO,
    '.coder/plan/todo-archived.md': PLAN_TODO_ARCHIVED,
    '.coder/plan/goal.md': PLAN_GOAL,
    '.coder/plan/goal-archived.md': PLAN_GOAL_ARCHIVED,
    ...overrides,
  }
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

describe('todo 文档', () => {
  it('合法 todo 解析出编码、范围、优先级、条目数与进度', () => {
    const result = inspectPlan('.coder/plan/todo.md', TODO, 'plan-todo')
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entries.length, 1)
    assert.deepEqual(
      {
        code: result.entries[0].code,
        kind: result.entries[0].kind,
        archived: result.entries[0].archived,
        scope: result.entries[0].scope,
        priority: result.entries[0].priority,
        expected: result.entries[0].expected,
        progress: result.entries[0].progress,
      },
      {
        code: 'T0001',
        kind: 'todo',
        archived: false,
        scope: 'src/**',
        priority: 'P1',
        expected: 2,
        progress: 1,
      },
    )
  })

  it('空文档合法；非空但没有编码时报错', () => {
    assert.deepEqual(check(''), [])
    assert.ok(ruleOf(check('只有正文\n'), 'plan.no-code'))
  })

  it('编码前缀、格式和重复都会报错', () => {
    assert.ok(ruleOf(check(TODO.replace('# T0001', '# G0001')), 'plan.code.prefix'))
    assert.ok(ruleOf(check(TODO.replace('# T0001', '# T001')), 'plan.code.format'))
    assert.ok(ruleOf(check(`${TODO}\n${TODO}`), 'plan.code.duplicate'))
  })

  it('编码标题之前有正文时报错', () => {
    assert.ok(ruleOf(check(`说明\n${TODO}`), 'plan.preamble'))
  })

  it('二级标题和未知正文都会报错', () => {
    assert.ok(ruleOf(check(TODO.replace('任务范围：src/**', '## 范围\n任务范围：src/**')), 'plan.heading.level'))
    assert.ok(ruleOf(check(TODO.replace('优先级：P1', '优先级：P1\n额外说明')), 'plan.body'))
  })

  it('缺少字段、字段重复、顺序错误和行内值都会报错', () => {
    assert.ok(ruleOf(check(TODO.replace('优先级：P1\n', '')), 'plan.field.missing'))
    assert.ok(ruleOf(check(TODO.replace('优先级：P1', '优先级：P1\n优先级：P2')), 'plan.field.multiple'))
    const reordered = TODO.replace('优先级：P1\n\n完成预期：', '完成预期：\n\n1. 如果 a，则 b，否则 c。\n\n优先级：P1\n\n完成预期：')
    assert.ok(ruleOf(check(reordered), 'plan.field.order'))
    assert.ok(ruleOf(check(TODO.replace('优先级：P1', '优先级：P1\n当前进度：已实现')), 'plan.field.inline'))
  })

  it('优先级必须是 P1、P2 或 P3', () => {
    assert.ok(ruleOf(check(TODO.replace('优先级：P1', '优先级：P4')), 'plan.priority.value'))
    assert.ok(ruleOf(check(TODO.replace('优先级：P1', '优先级：')), 'plan.priority.value'))
  })

  it('任务范围必须合法', () => {
    assert.ok(ruleOf(check(TODO.replace('任务范围：src/**', '任务范围：')), 'plan.scope.empty'))
    assert.ok(ruleOf(check(TODO.replace('任务范围：src/**', '任务范围：/src')), 'plan.scope.value'))
    assert.ok(ruleOf(check(TODO.replace('任务范围：src/**', '任务范围：src/../x')), 'plan.scope.value'))
    assert.deepEqual(check(TODO.replace('任务范围：src/**', '任务范围：全局')), [])
  })

  it('完成预期必须使用「如果 ... 则 ...，否则 ...」，编号必须连续', () => {
    assert.ok(ruleOf(check(TODO.replace('1. 如果计划文档缺少字段', '1. 计划文档缺少字段')), 'plan.expected.format'))
    assert.ok(ruleOf(check(TODO.replace('2. 如果编号不连续', '3. 如果编号不连续')), 'plan.expected.number'))
    const emptyExpected = `# T0001
任务范围：src/**
优先级：P1
完成预期：
当前进度：
1. [src/**] 进行中
`
    assert.ok(ruleOf(check(emptyExpected), 'plan.expected.empty'))
  })

  it('当前进度必须有合法文件通配和说明，编号必须连续', () => {
    assert.ok(ruleOf(check(TODO.replace('1. [src/**] 解析与校验已实现。', '1. 解析与校验已实现。')), 'plan.progress.format'))
    assert.ok(ruleOf(check(TODO.replace('[src/**]', '[/src]')), 'plan.progress.glob'))
    assert.ok(ruleOf(check(TODO.replace('1. [src/**] 解析与校验已实现。', '2. [src/**] 解析与校验已实现。')), 'plan.progress.number'))
    assert.ok(ruleOf(check(TODO.replace(/\n\n当前进度：[\s\S]*$/, '\n\n当前进度：')), 'plan.progress.empty'))
  })
})

describe('goal 文档', () => {
  it('合法 goal 解析出编码、范围与关联 ToDo 数', () => {
    const result = inspectPlan('.coder/plan/goal.md', GOAL, 'plan-goal')
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entries[0].code, 'G0001')
    assert.equal(result.entries[0].kind, 'goal')
    assert.equal(result.entries[0].scope, 'src/**')
    assert.equal(result.entries[0].todos, 1)
  })

  it('goal 不接受优先级字段', () => {
    assert.ok(ruleOf(check(GOAL.replace('完成预期：', '优先级：P1\n\n完成预期：'), 'plan-goal', '.coder/plan/goal.md'), 'plan.field.unexpected'))
  })

  it('关联 ToDo 必须是 T 加 4 位数字，编号必须连续', () => {
    assert.ok(ruleOf(check(GOAL.replace('1. T0001', '1. X0001'), 'plan-goal', '.coder/plan/goal.md'), 'plan.todo.format'))
    assert.ok(ruleOf(check(GOAL.replace('1. T0001', '2. T0001'), 'plan-goal', '.coder/plan/goal.md'), 'plan.todo.number'))
    assert.ok(ruleOf(check(GOAL.replace('1. T0001', ''), 'plan-goal', '.coder/plan/goal.md'), 'plan.todo.empty'))
  })

  it('goal 文档拒绝 T 编码', () => {
    assert.ok(ruleOf(check(GOAL.replace('# G0001', '# T0001'), 'plan-goal', '.coder/plan/goal.md'), 'plan.code.prefix'))
  })
})

describe('list 与计划文档', () => {
  it('完整文档树解析四份计划并输出计划汇总', async () => {
    const report = await inspectDocs({ root: writeProject() })
    assert.equal(report.ok, true)
    assert.equal(report.summary.expected, 11)
    assert.equal(report.summary.plans, 4)
    assert.equal(report.plans.length, 4)
    assert.match(report.text, /计划：/)
    assert.match(report.text, /T0001 \[进行中\] todo｜P1｜src\/\*\*｜完成预期 2｜进度 1/)
    assert.match(report.text, /G0002 \[归档\] goal｜src\/\*\*｜完成预期 1｜关联 ToDo 1/)
  })

  it('active 计划文档为空时仍然合法', async () => {
    const report = await inspectDocs({
      root: writeProject({
        '.coder/plan/todo.md': '',
        '.coder/plan/goal.md': '',
      }),
    })
    assert.equal(report.ok, true)
    assert.equal(report.summary.plans, 2)
    assert.match(report.text, /T0002 \[归档\]/)
  })

  it('同一编码同时留在 active 与 archived 时报错', async () => {
    const report = await inspectDocs({
      root: writeProject({
        '.coder/plan/todo-archived.md': PLAN_TODO_ARCHIVED.replace('# T0002', '# T0001'),
      }),
    })
    assert.equal(report.ok, false)
    assert.ok(ruleOf(report.diagnostics, 'plan.code.archived-duplicate'))
    assert.match(report.text, /同时出现在/)
  })

  it('通过 validateDocument 走计划格式分支', () => {
    const report = validateDocument('.coder/plan/todo.md', TODO.replace('优先级：P1', '优先级：P9'), 'plan-todo')
    assert.ok(ruleOf(report, 'plan.priority.value'))
  })
})
