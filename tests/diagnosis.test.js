/**
 * 诊断文档的行为测试：诊断码格式、作用范围、诊断方式、步骤格式、
 * 文件通配命中和运行时日志围栏。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import { inspectDiagnosis, scopeMatches } from '../src/diagnosis.js'
import { PLAN_GOAL, PLAN_GOAL_ARCHIVED, PLAN_TODO, PLAN_TODO_ARCHIVED } from './fixtures.js'

const DOC = '.coder/diagnosis/error.md'

const STATIC_OK = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [src/**/*.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
步骤2：查看 [src/**/*.js] 注册代码，如果工具未注册，则认定为 E0001，否则继续。
`

const RUNTIME_OK = `# W0001
作用范围：全局
诊断方式：运行时日志审查
步骤1：在 [src/a.js] 校验处，插入日志：
\`\`\`ts
console.log({ recorded, current })
\`\`\`
步骤2：查看日志，如果 recorded 与 current 不一致，则认定为 W0001，否则继续。
`

const FILE_OK = `# **
项目文件
`

const ARCHITECTURE_OK = `## 全局视角
说明。
\`\`\`mermaid
flowchart TB
  subgraph 层
    A[Host]
  end
\`\`\`
## 局部视角：扫描
说明。
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`

const FLOW_OK = `## 检查
\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`
`

const DATA_OK = `## 诊断
说明。
\`\`\`ts
export interface Diagnostic {
  doc: string
}
\`\`\`
`

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-diagnosis-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 写一棵文档树。
 * @param {Record<string, string>} files - 相对路径到内容。
 * @returns {string} 项目根目录。
 */
function writeTree(files) {
  const root = mkdtempSync(join(tempRoot, 'tree-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

/**
 * 写一棵最小合法文档树。
 * @param {string} errorText - error.md 正文。
 * @param {string} warnText - warn.md 正文。
 * @param {Record<string, string>} [extra] - 额外项目文件。
 * @returns {string} 项目根目录。
 */
function writeProject(errorText, warnText, extra = {}) {
  return writeTree({
    '.coder/design/file.md': FILE_OK,
    '.coder/design/architecture.md': ARCHITECTURE_OK,
    '.coder/design/flow.md': FLOW_OK,
    '.coder/design/data_structure.md': DATA_OK,
    '.coder/diagnosis/error.md': errorText,
    '.coder/diagnosis/warn.md': warnText,
    '.coder/plan/todo.md': PLAN_TODO,
    '.coder/plan/todo-archived.md': PLAN_TODO_ARCHIVED,
    '.coder/plan/goal.md': PLAN_GOAL,
    '.coder/plan/goal-archived.md': PLAN_GOAL_ARCHIVED,
    ...extra,
  })
}

/** 取某条规则的全部诊断。 */
function rules(result, rule) {
  return result.diagnostics.filter((item) => item.rule === rule)
}

describe('inspectDiagnosis 静态代码审查', () => {
  it('合法静态步骤解析出诊断方式、步骤和通配命中', () => {
    const result = inspectDiagnosis(DOC, STATIC_OK, 'error', [
      'src/a.js',
      'src/lib/b.js',
      'README.md',
    ])
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.codes.length, 1)
    assert.equal(result.codes[0].method, '静态代码审查')
    assert.equal(result.codes[0].steps.length, 2)
    assert.deepEqual(result.codes[0].steps.map((step) => step.kind), ['静态', '静态'])
    assert.equal(result.codes[0].steps[0].glob, 'src/**/*.js')
    assert.equal(result.codes[0].steps[0].matches, 2)
  })

  it('静态步骤支持不带方括号的文件通配', () => {
    const text = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 src/a.js 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.codes[0].steps[0].glob, 'src/a.js')
  })

  it('静态步骤缺少否则时格式错误', () => {
    const text = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.step.format').length, 1)
  })

  it('静态代码审查不允许插入日志或查看日志步骤', () => {
    const text = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：在 [src/a.js] 校验处，插入日志：
\`\`\`ts
console.log('x')
\`\`\`
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.step.format').length, 1)
  })
})

describe('inspectDiagnosis 运行时日志审查', () => {
  it('合法插入日志与查看日志步骤通过', () => {
    const result = inspectDiagnosis(DOC, RUNTIME_OK, 'warn', ['src/a.js'])
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.codes[0].method, '运行时日志审查')
    assert.deepEqual(result.codes[0].steps.map((step) => step.kind), ['插入日志', '查看日志'])
    assert.equal(result.codes[0].steps[0].log, true)
    assert.equal(result.codes[0].steps[1].log, false)
  })

  it('插入日志缺少 ts 围栏时报 log-missing', () => {
    const text = `# E0001
作用范围：全局
诊断方式：运行时日志审查
步骤1：在 [src/a.js] 校验处，插入日志：
步骤2：查看日志，如果 recorded 与 current 不一致，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.step.log-missing').length, 1)
  })

  it('日志围栏语言不是 ts 时报 log-lang', () => {
    const text = `# E0001
作用范围：全局
诊断方式：运行时日志审查
步骤1：在 [src/a.js] 校验处，插入日志：
\`\`\`json
{}
\`\`\`
步骤2：查看日志，如果 recorded 与 current 不一致，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.step.log-lang').length, 1)
  })

  it('日志围栏为空时报 log-empty', () => {
    const text = `# E0001
作用范围：全局
诊断方式：运行时日志审查
步骤1：在 [src/a.js] 校验处，插入日志：
\`\`\`ts
\`\`\`
步骤2：查看日志，如果 recorded 与 current 不一致，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.step.log-empty').length, 1)
  })

  it('运行时审查不允许静态步骤', () => {
    const text = `# E0001
作用范围：全局
诊断方式：运行时日志审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.step.format').length, 1)
  })

  it('查看日志缺少如果时格式错误', () => {
    const text = `# E0001
作用范围：全局
诊断方式：运行时日志审查
步骤1：查看日志 recorded 与 current 不一致。
`
    const result = inspectDiagnosis(DOC, text, 'error', [])
    assert.equal(rules(result, 'diagnosis.step.format').length, 1)
  })
})

describe('inspectDiagnosis 方法与编号', () => {
  it('缺少诊断方式时报 method.missing', () => {
    const text = `# E0001
作用范围：全局
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.method.missing').length, 1)
  })

  it('诊断方式值非法时报 method.value', () => {
    const text = `# E0001
作用范围：全局
诊断方式：人工检查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.method.value').length, 1)
  })

  it('多个诊断方式时报 method.multiple', () => {
    const text = `# E0001
作用范围：全局
诊断方式：静态代码审查
诊断方式：运行时日志审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.method.multiple').length, 1)
  })

  it('诊断方式写在步骤之后时报 method.order', () => {
    const text = `# E0001
作用范围：全局
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
诊断方式：静态代码审查
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.method.order').length, 1)
  })

  it('步骤跳号或重号时报 step.number', () => {
    const gap = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
步骤3：查看 [src/a.js] 注册代码，如果未注册，则认定为 E0001，否则继续。
`
    assert.equal(rules(inspectDiagnosis(DOC, gap, 'error', ['src/a.js']), 'diagnosis.step.number').length, 1)

    const duplicate = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
步骤1：查看 [src/a.js] 注册代码，如果未注册，则认定为 E0001，否则继续。
`
    assert.equal(
      rules(inspectDiagnosis(DOC, duplicate, 'error', ['src/a.js']), 'diagnosis.step.number').length,
      1,
    )
  })

  it('没有步骤时报 step.missing', () => {
    const text = `# E0001
作用范围：全局
诊断方式：静态代码审查
`
    const result = inspectDiagnosis(DOC, text, 'error')
    assert.equal(rules(result, 'diagnosis.step.missing').length, 1)
  })
})

describe('inspectDiagnosis 作用范围与步骤通配', () => {
  it('缺少作用范围、重复作用范围和作用范围晚写都会被诊断', () => {
    const missing = `# E0001
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    assert.equal(rules(inspectDiagnosis(DOC, missing, 'error', ['src/a.js']), 'diagnosis.scope.missing').length, 1)

    const multiple = `# E0001
作用范围：全局
作用范围：src/**
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    assert.equal(rules(inspectDiagnosis(DOC, multiple, 'error', ['src/a.js']), 'diagnosis.scope.multiple').length, 1)

    const late = `# E0001
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
作用范围：全局
`
    assert.equal(rules(inspectDiagnosis(DOC, late, 'error', ['src/a.js']), 'diagnosis.scope.order').length, 1)
  })

  it('非法作用范围和非法步骤通配都会被拒绝', () => {
    const scope = `# E0001
作用范围：../outside/**
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    assert.equal(rules(inspectDiagnosis(DOC, scope, 'error', ['src/a.js']), 'diagnosis.scope.value').length, 1)

    const step = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [../outside/**] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    assert.equal(rules(inspectDiagnosis(DOC, step, 'error', ['src/a.js']), 'diagnosis.step.glob').length, 1)
  })

  it('步骤通配没有命中项目文件时报 step.no-match', () => {
    const text = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [nope/**/*.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.step.no-match').length, 1)
    assert.equal(result.codes[0].steps[0].matches, 0)
  })
})

describe('inspectDiagnosis 文档结构', () => {
  it('正文行和二级标题都会被拒绝', () => {
    const text = `# E0001
作用范围：全局
诊断方式：静态代码审查
说明文字
## 诊断流程：静态
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const result = inspectDiagnosis(DOC, text, 'error', ['src/a.js'])
    assert.equal(rules(result, 'diagnosis.body').length, 1)
    assert.equal(rules(result, 'diagnosis.heading.level').length, 1)
  })

  it('错误前缀、4 位数字和重复诊断码都会被拒绝', () => {
    const wrongPrefix = inspectDiagnosis(
      '.coder/diagnosis/warn.md',
      '# E0001\n作用范围：全局\n诊断方式：静态代码审查\n步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。\n',
      'warn',
      ['src/a.js'],
    )
    assert.equal(rules(wrongPrefix, 'diagnosis.code.prefix').length, 1)

    const short = inspectDiagnosis(
      DOC,
      '# E001\n作用范围：全局\n诊断方式：静态代码审查\n步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E001，否则继续。\n',
      'error',
      ['src/a.js'],
    )
    assert.equal(rules(short, 'diagnosis.code.format').length, 1)

    const duplicate = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 注册代码，如果未注册，则认定为 E0001，否则继续。
`
    const duplicateResult = inspectDiagnosis(DOC, duplicate, 'error', ['src/a.js'])
    assert.equal(rules(duplicateResult, 'diagnosis.code.duplicate').length, 1)
    assert.equal(duplicateResult.codes.length, 1)
  })

  it('第一个诊断码之前的正文和围栏里的诊断码标题都会被拒绝', () => {
    const preamble = `说明文字
# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [src/a.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    assert.equal(rules(inspectDiagnosis(DOC, preamble, 'error', ['src/a.js']), 'diagnosis.preamble').length, 1)

    const fenced = `\`\`\`md
# E0001
\`\`\`
`
    const fencedResult = inspectDiagnosis(DOC, fenced, 'error')
    assert.equal(rules(fencedResult, 'diagnosis.no-code').length, 1)
    assert.equal(fencedResult.codes.length, 0)
  })
})

describe('scopeMatches', () => {
  it('全局匹配任何文件，通配按 glob 规则匹配', () => {
    assert.equal(scopeMatches('全局', 'src/a.js'), true)
    assert.equal(scopeMatches('src/**/*.js', 'src/a.js'), true)
    assert.equal(scopeMatches('src/**/*.js', 'src/lib/b.js'), true)
    assert.equal(scopeMatches('src/**/*.js', 'test/a.js'), false)
  })
})

describe('list 与诊断文档', () => {
  it('解析静态与运行时诊断文档并给出诊断方式和步骤数', async () => {
    const root = writeProject(STATIC_OK, RUNTIME_OK, {
      'src/a.js': 'export {}\n',
      'src/lib/b.js': 'export {}\n',
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.expected, 10)
    assert.equal(report.summary.codes, 2)
    assert.equal(report.diagnoses[0].method, '静态代码审查')
    assert.equal(report.diagnoses[0].steps.length, 2)
    assert.equal(report.diagnoses[1].method, '运行时日志审查')
    assert.match(report.text, /E0001 \[error\] 全局｜诊断方式 静态代码审查｜步骤 2/)
    assert.match(report.text, /W0001 \[warn\] 全局｜诊断方式 运行时日志审查｜步骤 2/)
  })

  it('步骤文件通配没有命中时 list 不通过', async () => {
    const errorText = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [nope/**/*.js] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
`
    const root = writeProject(errorText, RUNTIME_OK, { 'src/a.js': 'export {}\n' })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(report.diagnostics.some((item) => item.rule === 'diagnosis.step.no-match'), true)
    assert.equal(report.summary.codes, 2)
  })

  it('warn.md 里的 E 开头诊断码会被拒绝', async () => {
    const root = writeProject(STATIC_OK, STATIC_OK, { 'src/a.js': 'export {}\n' })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(report.diagnostics.some((item) => item.rule === 'diagnosis.code.prefix'), true)
  })
})
