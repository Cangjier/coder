/**
 * update 的行为测试：tmp 源文件、未上锁替换、上锁两步、key/review、
 * 设计补充提交和设计调整分支。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import { createLockTool } from '../src/tools/lock.js'
import { createUpdateTool } from '../src/tools/update.js'

const FILE_OK = `# .git/**
git 目录
# tmp/**
update 源文件暂存目录
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
const UPDATES = [{ source: 'tmp/new-flow.md', target: '.coder/design/flow.md' }]

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-update-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * @param {string} root - 项目根目录。
 * @param {...string} args - git 参数。
 * @returns {string} stdout。
 */
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/**
 * 写一个带 git 初始提交的合法项目。
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
  writeFileSync(join(root, '.coder', 'diagnosis', 'error.md'), ERROR_OK)
  writeFileSync(join(root, '.coder', 'diagnosis', 'warn.md'), WARN_OK)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'coder@example.test')
  git(root, 'config', 'user.name', 'coder test')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  mkdirSync(join(root, 'tmp'))
  return root
}

/**
 * @param {string} root - 项目根目录。
 * @returns {string} 当前 flow.md。
 */
function flowOf(root) {
  return readFileSync(join(root, '.coder', 'design', 'flow.md'), 'utf8')
}

/**
 * @param {string} root - 项目根目录。
 * @returns {string} commit 数。
 */
function commitCount(root) {
  return git(root, 'rev-list', '--count', 'HEAD').trim()
}

describe('update 未上锁', () => {
  it('直接从 tmp 替换，返回未上锁与不推荐提示，不提交', async () => {
    const root = writeProject()
    writeFileSync(join(root, 'tmp', 'new-flow.md'), `${FLOW_OK}\n未上锁更新\n`)
    const before = commitCount(root)

    const result = await createUpdateTool(logger).execute(
      { root, updates: UPDATES },
      { cwd: root },
    )

    assert.equal(result.locked, false)
    assert.match(result.text, /未上锁/)
    assert.match(result.text, /不推荐/)
    assert.match(flowOf(root), /未上锁更新/)
    assert.equal(commitCount(root), before)
  })

  it('允许用 tmp 源文件替换诊断文档', async () => {
    const root = writeProject()
    const next = `${ERROR_OK}
# E0002
作用范围：全局
诊断方式：静态代码审查
步骤1：查看 [**] 更新后的诊断文档，如果缺少步骤，则认定为 E0002，否则继续。
`
    writeFileSync(join(root, 'tmp', 'new-error.md'), next)

    const result = await createUpdateTool(logger).execute(
      { root, updates: [{ source: 'tmp/new-error.md', target: '.coder/diagnosis/error.md' }] },
      { cwd: root },
    )

    assert.equal(result.locked, false)
    assert.equal(result.applied[0].target, '.coder/diagnosis/error.md')
    assert.match(readFileSync(join(root, '.coder', 'diagnosis', 'error.md'), 'utf8'), /E0002/)
    const report = await inspectDocs({ root })
    assert.equal(report.summary.codes, 3)
    assert.equal(report.diagnostics.length, 0)
  })

  it('拒绝 tmp 之外的源文件和非法目标', async () => {
    const root = writeProject()
    const tool = createUpdateTool(logger)
    await assert.rejects(
      () => tool.execute({ root, updates: [{ source: 'other/x.md', target: '.coder/design/flow.md' }] }, { cwd: root }),
      /tmp\//,
    )
    await assert.rejects(
      () => tool.execute({ root, updates: [{ source: 'tmp/x.md', target: '.coder/design/other.md' }] }, { cwd: root }),
      /target/,
    )
  })
})

describe('update 已上锁', () => {
  it('第一次只返回 key 和计划，第二次补充后才替换并提交', async () => {
    const root = writeProject()
    await createLockTool(logger).execute({ root, authorization: '授权补充' }, { cwd: root })
    writeFileSync(join(root, 'tmp', 'new-flow.md'), `${FLOW_OK}\n设计补充\n`)
    const before = commitCount(root)
    const branchBefore = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
    const tool = createUpdateTool(logger)

    const first = await tool.execute({ root, updates: UPDATES }, { cwd: root })
    assert.equal(first.locked, true)
    assert.equal(first.phase, 'review')
    assert.match(first.key, /^[0-9a-f]{64}$/)
    assert.match(first.text, /子代理/)
    assert.equal(flowOf(root), FLOW_OK)
    assert.equal(commitCount(root), before)

    await assert.rejects(
      () => tool.execute(
        { root, updates: UPDATES, key: first.key, decision: 'supplement', review: '授权补充', branch: 'nope' },
        { cwd: root },
      ),
      /不需要 branch/,
    )

    const second = await tool.execute(
      { root, updates: UPDATES, key: first.key, decision: 'supplement', review: '授权补充' },
      { cwd: root },
    )

    assert.equal(second.locked, true)
    assert.equal(second.decision, 'supplement')
    assert.equal(second.branch, branchBefore)
    assert.match(second.commit, /^[0-9a-f]{40}$/)
    assert.match(flowOf(root), /设计补充/)
    assert.equal(commitCount(root), String(Number(before) + 1))
    assert.match(git(root, 'log', '-1', '--format=%s'), /supplement/)

    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.lock.hashMatches, true)
    assert.equal(report.summary.locked, true)

    await assert.rejects(
      () => tool.execute({ root, updates: UPDATES, key: first.key, decision: 'supplement', review: '授权补充' }, { cwd: root }),
      /key 无效/,
    )
  })

  it('第一次和第二次之间源文件变化时拒绝', async () => {
    const root = writeProject()
    await createLockTool(logger).execute({ root, authorization: '授权' }, { cwd: root })
    writeFileSync(join(root, 'tmp', 'new-flow.md'), `${FLOW_OK}\n第一次\n`)
    const tool = createUpdateTool(logger)
    const first = await tool.execute({ root, updates: UPDATES }, { cwd: root })

    writeFileSync(join(root, 'tmp', 'new-flow.md'), `${FLOW_OK}\n第二次改\n`)
    await assert.rejects(
      () => tool.execute({ root, updates: UPDATES, key: first.key, decision: 'supplement', review: '授权' }, { cwd: root }),
      /内容发生变化/,
    )
    assert.equal(flowOf(root), FLOW_OK)
  })

  it('lock hash 不一致时 update 直接拒绝', async () => {
    const root = writeProject()
    await createLockTool(logger).execute({ root, authorization: '授权' }, { cwd: root })
    writeFileSync(join(root, 'tmp', 'new-flow.md'), `${FLOW_OK}\n更新\n`)
    writeFileSync(join(root, '.coder', 'design', 'flow.md'), `${FLOW_OK}\n直接改\n`)

    await assert.rejects(
      () => createUpdateTool(logger).execute({ root, updates: UPDATES }, { cwd: root }),
      /hash/,
    )
    assert.match(flowOf(root), /直接改/)
  })

  it('设计调整先 checkpoint 再新建分支', async () => {
    const root = writeProject()
    await createLockTool(logger).execute({ root, authorization: '授权调整' }, { cwd: root })
    writeFileSync(join(root, 'tmp', 'new-flow.md'), `${FLOW_OK}\n设计调整\n`)
    const tool = createUpdateTool(logger)

    const first = await tool.execute({ root, updates: UPDATES }, { cwd: root })

    await assert.rejects(
      () => tool.execute({ root, updates: UPDATES, key: first.key, decision: 'adjustment', review: '授权调整' }, { cwd: root }),
      /branch/,
    )
    git(root, 'branch', 'taken-branch')
    await assert.rejects(
      () => tool.execute(
        { root, updates: UPDATES, key: first.key, decision: 'adjustment', review: '授权调整', branch: 'taken-branch' },
        { cwd: root },
      ),
      /已经存在/,
    )

    const second = await tool.execute(
      {
        root,
        updates: UPDATES,
        key: first.key,
        decision: 'adjustment',
        review: '授权调整',
        branch: 'coder/design-test',
      },
      { cwd: root },
    )

    assert.equal(second.decision, 'adjustment')
    assert.equal(second.branch, 'coder/design-test')
    assert.match(second.checkpoint, /^[0-9a-f]{40}$/)
    assert.match(second.commit, /^[0-9a-f]{40}$/)
    assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), second.branch)
    assert.match(flowOf(root), /设计调整/)
    assert.match(git(root, 'log', '--all', '--format=%s'), /checkpoint before design adjustment/)
    assert.match(git(root, 'log', '--all', '--format=%s'), /adjustment/)

    const branches = git(root, 'branch', '--list').trim()
    assert.match(branches, /coder\/design-test/)

    const report = await inspectDocs({ root })
    assert.equal(report.lock.hashMatches, true)
  })
})
