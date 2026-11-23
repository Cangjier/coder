/**
 * 插件装配与 `list` 工具的端到端行为。
 *
 * 用一个假的 `tools` 服务挂载插件，再用真的临时目录跑工具，证明的是行为：
 * 插件不提供配置；注册 `list`；工具按会话工作目录找到文档树。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import * as plugin from '../index.js'
import { apply, name as pluginName } from '../index.js'
import { PLAN_GOAL, PLAN_GOAL_ARCHIVED, PLAN_TODO, PLAN_TODO_ARCHIVED } from './fixtures.js'

const FILE_OK = `# src
源代码目录
## src/main.ts
功能入口
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

const FLOW_OK = `## 检查文档
\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`
`

const ERROR_OK = `# E0001
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [**] 入口代码，如果缺少导出，则认定为 E0001，否则继续。
步骤2：查看 [**] 注册代码，如果工具未注册，则认定为 E0001，否则继续。
`

const WARN_OK = `# W0001
作用范围：全局
诊断方式：运行时日志审查
步骤1：在 [**] 检查点，插入日志：
\`\`\`ts
console.log('warn')
\`\`\`
步骤2：查看日志，如果出现警告，则认定为 W0001，否则继续。
`

const DATA_OK = `## 诊断
\`\`\`ts
export interface Diagnostic {
  doc: string
}
\`\`\`
`

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-plugin-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 挂载插件并取回注册到的工具。
 * @returns {{tools: Map<string, object>, logs: object[]}} 注册结果与日志。
 */
function mount() {
  const tools = new Map()
  const logs = []
  const ctx = {
    logs,
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
    },
    inject(names, callback) {
      if (!names.includes('tools')) throw new Error('这个假上下文只提供 tools')
      return callback({
        ...ctx,
        tools: {
          register(definition) {
            if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`)
            tools.set(definition.name, definition)
            return () => tools.delete(definition.name)
          },
        },
      })
    },
  }
  apply(ctx)
  return { tools, logs }
}

/**
 * 写一棵最小合法文档树。
 * @returns {string} 项目根目录。
 */
function writeProject() {
  const root = mkdtempSync(join(tempRoot, 'project-'))
  mkdirSync(join(root, '.coder', 'design'), { recursive: true })
  mkdirSync(join(root, '.coder', 'diagnosis'), { recursive: true })
  writeFileSync(join(root, '.coder', 'design', 'file.md'), FILE_OK)
  writeFileSync(join(root, '.coder', 'design', 'architecture.md'), ARCHITECTURE_OK)
  writeFileSync(join(root, '.coder', 'design', 'flow.md'), FLOW_OK)
  writeFileSync(join(root, '.coder', 'design', 'data_structure.md'), DATA_OK)
  writeFileSync(join(root, '.coder', 'diagnosis', 'error.md'), ERROR_OK)
  writeFileSync(join(root, '.coder', 'diagnosis', 'warn.md'), WARN_OK)
  mkdirSync(join(root, '.coder', 'plan'), { recursive: true })
  writeFileSync(join(root, '.coder', 'plan', 'todo.md'), PLAN_TODO)
  writeFileSync(join(root, '.coder', 'plan', 'todo-archived.md'), PLAN_TODO_ARCHIVED)
  writeFileSync(join(root, '.coder', 'plan', 'goal.md'), PLAN_GOAL)
  writeFileSync(join(root, '.coder', 'plan', 'goal-archived.md'), PLAN_GOAL_ARCHIVED)
  return root
}

describe('plugin wiring', () => {
  it('插件名与工具名符合设计', () => {
    assert.equal(pluginName, 'coder')
    const { tools } = mount()
    assert.deepEqual([...tools.keys()], ['list', 'render', 'lock', 'unlock', 'update'])
    const definition = tools.get('list')
    assert.equal(definition.name, 'list')
    assert.equal(definition.parameters.type, 'object')
    assert.deepEqual(Object.keys(definition.parameters.properties), ['root'])
    const render = tools.get('render')
    assert.equal(render.name, 'render')
    assert.deepEqual(Object.keys(render.parameters.properties), ['root', 'out'])
    for (const name of ['lock', 'unlock']) {
      const tool = tools.get(name)
      assert.deepEqual(Object.keys(tool.parameters.properties), ['root', 'authorization'])
    }
    const update = tools.get('update')
    assert.deepEqual(Object.keys(update.parameters.properties), ['root', 'updates', 'key', 'decision', 'review', 'branch'])
  })

  it('不导出 Config，文档集合固化', () => {
    assert.equal(plugin.Config, undefined)
  })

  it('注册失败时只记日志', () => {
    const logs = []
    const ctx = {
      logger: {
        info: (message) => logs.push({ level: 'info', message }),
        error: (message) => logs.push({ level: 'error', message }),
      },
      inject(names, callback) {
        return callback({
          tools: {
            register() {
              throw new Error('duplicate tool: list')
            },
          },
        })
      },
    }
    apply(ctx)
    assert.ok(logs.some((log) => log.level === 'error' && /注册工具 list 失败/.test(log.message)))
  })
})

describe('list tool', () => {
  it('默认用会话工作目录并返回 ok:true', async () => {
    const root = writeProject()
    const { tools } = mount()
    const tool = tools.get('list')
    const report = await tool.execute({}, { agent: { session: { header: { cwd: root } } } })
    assert.equal(report.ok, true)
    assert.equal(report.root, root)
    assert.equal(report.docsRoot, join(root, '.coder'))
    assert.equal(report.summary.found, 10)
    assert.match(report.text, /所有文档齐全且格式正确/)
  })

  it('root 参数优先于会话工作目录', async () => {
    const root = writeProject()
    const { tools } = mount()
    const tool = tools.get('list')
    const report = await tool.execute({ root }, { agent: { session: { header: { cwd: tempRoot } } } })
    assert.equal(report.root, root)
    assert.equal(report.ok, true)
  })

  it('报告非法与缺失文档', async () => {
    const root = writeProject()
    writeFileSync(join(root, '.coder', 'design', 'extra.md'), '# extra\n多余\n')
    rmSync(join(root, '.coder', 'design', 'flow.md'))
    const { tools } = mount()
    const tool = tools.get('list')
    const report = await tool.execute({ root })
    assert.equal(report.ok, false)
    assert.deepEqual(report.illegal, ['.coder/design/extra.md'])
    assert.deepEqual(report.missing, ['.coder/design/flow.md'])
    assert.match(report.text, /\[illegal\] \.coder\/design\/extra\.md/)
    assert.match(report.text, /\[missing\] \.coder\/design\/flow\.md/)
  })

  it('root 不存在时作为工具失败抛出', async () => {
    const { tools } = mount()
    const tool = tools.get('list')
    await assert.rejects(() => tool.execute({ root: join(tempRoot, 'nope') }), /项目根目录不存在/)
  })
})

describe('render tool', () => {
  it('默认写到 dist/.coder/design.html', async () => {
    const root = writeProject()
    const { tools } = mount()
    const tool = tools.get('render')
    const result = await tool.execute({ root }, {})
    assert.equal(result.ok, true)
    assert.equal(result.output, join(root, 'dist', '.coder', 'design.html'))
    assert.equal(result.healthy, true)
    assert.ok(existsSync(result.output))
  })

  it('out 参数改变输出目录', async () => {
    const root = writeProject()
    const { tools } = mount()
    const tool = tools.get('render')
    const result = await tool.execute({ root, out: 'build' }, {})
    assert.equal(result.output, join(root, 'build', 'design.html'))
    assert.ok(existsSync(result.output))
  })

  it('root 不存在时作为工具失败抛出', async () => {
    const { tools } = mount()
    const tool = tools.get('render')
    await assert.rejects(() => tool.execute({ root: join(tempRoot, 'nope') }, {}), /项目根目录不存在/)
  })
})
