/**
 * lock / unlock 与 lock.md hash 的行为测试。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import { LOCK_DECLARATION, LOCK_HASH_PREFIX } from '../src/lock.js'
import { createLockTool, createUnlockTool } from '../src/tools/lock.js'
import { MODULES_EMPTY, PLAN_GOAL, PLAN_GOAL_ARCHIVED, PLAN_TODO, PLAN_TODO_ARCHIVED } from './fixtures.js'

const FILE_OK = `# src/**
源码目录
# tmp/**
暂存目录
`

const ARCHITECTURE_OK = `# 架构
## 全局视角
说明。
\`\`\`mermaid
flowchart TB
  subgraph 宿主层
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

const FLOW_OK = `# 流程
## 检查
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

const DATA_OK = `# 数据结构
## 诊断
说明。
\`\`\`ts
export interface Diagnostic {
  doc: string
}
\`\`\`
`

const logger = { info: () => {}, warn: () => {}, error: () => {} }

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-lock-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 写一个合法的项目。
 * @param {string} [label] - 目录前缀。
 * @returns {string} 项目根目录。
 */
function writeProject(label = 'project') {
  const root = mkdtempSync(join(tempRoot, `${label}-`))
  mkdirSync(join(root, '.coder', 'design'), { recursive: true })
  mkdirSync(join(root, '.coder', 'diagnosis'), { recursive: true })
  writeFileSync(join(root, '.coder', 'design', 'file.md'), FILE_OK)
  writeFileSync(join(root, '.coder', 'design', 'architecture.md'), ARCHITECTURE_OK)
  writeFileSync(join(root, '.coder', 'design', 'flow.md'), FLOW_OK)
  writeFileSync(join(root, '.coder', 'design', 'data_structure.md'), DATA_OK)
  writeFileSync(join(root, '.coder', 'design', 'modules.md'), MODULES_EMPTY)
  writeFileSync(join(root, '.coder', 'diagnosis', 'error.md'), ERROR_OK)
  writeFileSync(join(root, '.coder', 'diagnosis', 'warn.md'), WARN_OK)
  mkdirSync(join(root, '.coder', 'plan', 'todo', 'archived'), { recursive: true })
  mkdirSync(join(root, '.coder', 'plan', 'goal', 'archived'), { recursive: true })
  writeFileSync(join(root, '.coder', 'plan', 'todo', 'T0001.md'), PLAN_TODO)
  writeFileSync(join(root, '.coder', 'plan', 'todo', 'archived', 'T0002.md'), PLAN_TODO_ARCHIVED)
  writeFileSync(join(root, '.coder', 'plan', 'goal', 'G0001.md'), PLAN_GOAL)
  writeFileSync(join(root, '.coder', 'plan', 'goal', 'archived', 'G0002.md'), PLAN_GOAL_ARCHIVED)
  return root
}

/**
 * @param {string} root - 项目根目录。
 * @returns {Promise<object>} 报告。
 */
function inspect(root) {
  return inspectDocs({ root })
}

describe('lock / unlock', () => {
  it('lock 写入固定声明、hash 和授权原文，list 标为 lock 且 hash 匹配', async () => {
    const root = writeProject()
    const tool = createLockTool(logger)
    const authorization = '用户授权：锁定 .coder\n第二行也保留'
    const result = await tool.execute({ root, authorization }, { cwd: root })

    assert.equal(result.locked, true)
    assert.equal(result.files.length, 11)
    const lockText = readFileSync(join(root, '.coder', 'lock.md'), 'utf8')
    const lines = lockText.split('\n')
    assert.equal(lines[0], LOCK_DECLARATION)
    assert.match(lines[1], /^sha256:[0-9a-f]{64}$/)
    assert.equal(lines.slice(2).join('\n'), authorization)
    assert.ok(lockText.startsWith(`${LOCK_DECLARATION}\n${LOCK_HASH_PREFIX}`))

    const report = await inspect(root)
    assert.equal(report.ok, true)
    assert.equal(report.summary.locked, true)
    assert.equal(report.lock.hashMatches, true)
    assert.equal(report.lock.declarationValid, true)
    assert.deepEqual(report.illegal, [])
    assert.ok(report.documents.some((document) => document.status === 'lock'))
    assert.match(report.text, /已上锁/)
    assert.match(report.text, /\[lock\] \.coder\/lock\.md/)
  })

  it('已经上锁时再次 lock 失败', async () => {
    const root = writeProject()
    const tool = createLockTool(logger)
    await tool.execute({ root, authorization: '第一次' }, { cwd: root })
    await assert.rejects(() => tool.execute({ root, authorization: '第二次' }, { cwd: root }), /已经上锁/)
  })

  it('lock 拒绝空授权原文', async () => {
    const root = writeProject()
    const tool = createLockTool(logger)
    await assert.rejects(() => tool.execute({ root, authorization: '   ' }, { cwd: root }), /不能为空/)
  })

  it('直接修改 .coder 后 list 报 lock.hash.mismatch', async () => {
    const root = writeProject()
    await createLockTool(logger).execute({ root, authorization: '授权' }, { cwd: root })
    writeFileSync(join(root, '.coder', 'design', 'flow.md'), `${FLOW_OK}\n直接修改\n`)

    const report = await inspect(root)
    assert.equal(report.ok, false)
    assert.equal(report.lock.hashMatches, false)
    assert.ok(report.diagnostics.some((item) => item.rule === 'lock.hash.mismatch'))
    assert.equal(report.diagnostics.find((item) => item.rule === 'lock.hash.mismatch').line, 2)
  })

  it('unlock 要求授权原文一致；hash 不一致时仍然解锁并报告', async () => {
    const root = writeProject()
    const lock = createLockTool(logger)
    const unlock = createUnlockTool(logger)
    await lock.execute({ root, authorization: '授权原文' }, { cwd: root })
    writeFileSync(join(root, '.coder', 'design', 'flow.md'), `${FLOW_OK}\n直接修改\n`)

    await assert.rejects(
      () => unlock.execute({ root, authorization: '错误原文' }, { cwd: root }),
      /授权原文不一致/,
    )
    assert.ok(existsSync(join(root, '.coder', 'lock.md')))

    const result = await unlock.execute({ root, authorization: '授权原文' }, { cwd: root })
    assert.equal(result.locked, false)
    assert.equal(result.hashMatches, false)
    assert.equal(existsSync(join(root, '.coder', 'lock.md')), false)
    assert.match(result.text, /自查/)

    const report = await inspect(root)
    assert.equal(report.summary.locked, false)
    assert.equal(report.lock, null)
    assert.equal(report.ok, true)
  })

  it('lock.md 格式错误时逐项报诊断', async () => {
    const root = writeProject()
    writeFileSync(join(root, '.coder', 'lock.md'), '错误声明\n不是-hash')
    const report = await inspect(root)
    const rules = new Set(report.diagnostics.map((item) => item.rule))
    assert.ok(rules.has('lock.declaration'))
    assert.ok(rules.has('lock.hash.invalid'))
    assert.ok(rules.has('lock.authorization.missing'))
    assert.equal(report.summary.locked, true)
    assert.equal(report.lock.hashMatches, null)
    assert.equal(report.lock.authorizationLength, 0)
  })

  it('没有锁时 unlock 失败', async () => {
    const root = writeProject()
    await assert.rejects(
      () => createUnlockTool(logger).execute({ root, authorization: '授权' }, { cwd: root }),
      /没有上锁/,
    )
  })
})
