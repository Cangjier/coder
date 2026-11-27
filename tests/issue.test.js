/**
 * 问题文件与 `create_issue` 的行为测试。
 *
 * 覆盖问题文件的固定段落、open/ 与 close/ 文件夹状态、当前进度与关闭原因、
 * 可选文件的检查，以及 create_issue 的编号与写入规则。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import { inspectIssue, validateIssue } from '../src/issue.js'
import { createCreateIssueTool } from '../src/tools/create-issue.js'
import { createLockTool } from '../src/tools/lock.js'

const FILE_OK = `# src/**
源代码目录
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
## 检查文档
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`

const DATA_OK = `# 数据结构
## 报告
\`\`\`ts
export interface Report {
  ok: boolean
}
\`\`\`
`

const ISSUE_OPEN_OK = `# 问题
列表漏报问题。

# 复现
1. 运行 list。
2. 观察缺少的诊断。

# 建议
补上检查。

# 提交源
用户

# 当前进度
[src/**] 当前进度为 正在定位。
`

const ISSUE_CLOSE_OK = `# 问题
列表漏报问题。

# 提交源
用户

# 关闭原因
已修复并验证。
`

const logger = { info: () => {}, warn: () => {}, error: () => {} }

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-issue-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 在临时目录里写一棵文档树；默认补齐七份预期文档和一个项目文件。
 *
 * @param {Record<string, string>} files - 相对于临时根的路径到内容。
 * @returns {string} 临时根目录。
 */
function writeTree(files) {
  const root = mkdtempSync(join(tempRoot, 'tree-'))
  const base = {
    '.coder/design/file.md': FILE_OK,
    '.coder/design/architecture.md': ARCHITECTURE_OK,
    '.coder/design/flow.md': FLOW_OK,
    '.coder/design/data_structure.md': DATA_OK,
    '.coder/design/modules.md': '',
    '.coder/diagnosis/error.md': '',
    '.coder/diagnosis/warn.md': '',
    'src/main.ts': 'export const value = 1\n',
    ...files,
  }
  for (const [relative, content] of Object.entries(base)) {
    const absolute = join(root, ...relative.split('/'))
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

/** 取出某条规则的全部诊断。 */
function rules(report, rule) {
  return report.diagnostics.filter((item) => item.rule === rule)
}

/**
 * 在开启的问题文件上跑一次校验。
 * @param {string} text - 文件正文。
 * @param {string} [code] - 文件名编码。
 * @param {string[]} [files] - 项目文件。
 * @returns {object[]} 诊断。
 */
function checkOpen(text, code = '0001', files = ['src/main.ts']) {
  return validateIssue('.coder/issues/open/issue-0001.md', text, 'issue-open', code, files)
}

describe('问题文件', () => {
  it('开启的问题解析出编码、状态与当前进度', () => {
    const result = inspectIssue(
      '.coder/issues/open/issue-0001.md',
      ISSUE_OPEN_OK,
      'issue-open',
      '0001',
      ['src/main.ts'],
    )
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entry.code, '0001')
    assert.equal(result.entry.status, '开启')
    assert.deepEqual(result.entry.progress, {
      line: 15,
      scope: 'src/**',
      text: '正在定位。',
      matches: 1,
    })
  })

  it('关闭的问题解析出关闭原因', () => {
    const result = inspectIssue(
      '.coder/issues/close/issue-0002.md',
      ISSUE_CLOSE_OK,
      'issue-close',
      '0002',
    )
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entry.status, '关闭')
    assert.equal(result.entry.reason, '已修复并验证。')
  })

  it('复现与建议可以省略，也可以带（可选）后缀', () => {
    assert.deepEqual(
      validateIssue(
        '.coder/issues/close/issue-0001.md',
        ISSUE_CLOSE_OK.replace('用户', '用户'),
        'issue-close',
        '0001',
      ),
      [],
    )
    const withSuffix = ISSUE_OPEN_OK.replace('# 复现', '# 复现（可选）').replace('# 建议', '# 建议（可选）')
    assert.deepEqual(checkOpen(withSuffix), [])
  })

  it('# 状态 由文件夹取代，写进文件会报错', () => {
    const text = ISSUE_OPEN_OK.replace('# 当前进度', '# 状态\n开启\n\n# 当前进度')
    assert.ok(checkOpen(text).some((item) => item.rule === 'issue.status.removed'))
  })

  it('缺少必填段落、段落顺序错误和空段落都会报错', () => {
    assert.ok(checkOpen(ISSUE_OPEN_OK.replace('# 提交源\n用户\n', '')).some((item) => item.rule === 'issue.section.missing'))
    assert.ok(checkOpen(ISSUE_OPEN_OK.replace(/# 当前进度\n.*\n/, '')).some((item) => item.rule === 'issue.section.missing'))
    const reordered = ISSUE_OPEN_OK.replace('# 问题\n列表漏报问题。', '# 提交源\n用户\n\n# 问题\n列表漏报问题。').replace('# 提交源\n用户\n\n# 当前进度', '# 当前进度')
    assert.ok(checkOpen(reordered).some((item) => item.rule === 'issue.section.order'))
    assert.ok(
      checkOpen(ISSUE_OPEN_OK.replace('# 建议\n补上检查。', '# 建议\n')).some((item) => item.rule === 'issue.section.empty'),
    )
  })

  it('未知段落、二级标题、空文件与第一个标题之前的正文都会报错', () => {
    assert.ok(checkOpen(ISSUE_OPEN_OK.replace('# 当前进度', '# 备注\n补充\n\n# 当前进度')).some((item) => item.rule === 'issue.section.unknown'))
    assert.ok(checkOpen(ISSUE_OPEN_OK.replace('# 复现', '## 复现')).some((item) => item.rule === 'issue.heading.level'))
    assert.ok(checkOpen('').some((item) => item.rule === 'issue.empty'))
    assert.ok(checkOpen(`说明\n${ISSUE_OPEN_OK}`).some((item) => item.rule === 'issue.preamble'))
  })

  it('当前进度必须是一行合法通配，且要命中项目文件', () => {
    assert.ok(checkOpen(ISSUE_OPEN_OK.replace('[src/**] 当前进度为 正在定位。', '正在定位。')).some((item) => item.rule === 'issue.progress.format'))
    assert.ok(checkOpen(ISSUE_OPEN_OK.replace('[src/**]', '[/src]')).some((item) => item.rule === 'issue.progress.glob'))
    assert.ok(checkOpen(ISSUE_OPEN_OK.replace('[src/**]', '[web/**]')).some((item) => item.rule === 'issue.progress.no-match'))
    assert.ok(checkOpen(`${ISSUE_OPEN_OK}[src/**] 当前进度为 又一行。\n`).some((item) => item.rule === 'issue.progress.lines'))
  })

  it('关闭原因至少一行正文，开启的问题不接受关闭原因', () => {
    const emptyReason = ISSUE_CLOSE_OK.replace('# 关闭原因\n已修复并验证。', '# 关闭原因\n')
    assert.ok(validateIssue('.coder/issues/close/issue-0001.md', emptyReason, 'issue-close', '0001').some((item) => item.rule === 'issue.section.empty'))
    const wrongSection = ISSUE_OPEN_OK.replace('# 当前进度', '# 关闭原因')
    assert.ok(checkOpen(wrongSection).some((item) => item.rule === 'issue.section.unknown'))
  })

  it('文件名编码必须是 4 位数字', () => {
    assert.ok(checkOpen(ISSUE_OPEN_OK, '1').some((item) => item.rule === 'issue.code.format'))
  })
})

describe('list 与问题文件', () => {
  it('存在的问题文件被检查但不产生缺失', async () => {
    const report = await inspectDocs({
      root: writeTree({
        '.coder/issues/open/issue-0001.md': ISSUE_OPEN_OK,
        '.coder/issues/close/issue-0002.md': ISSUE_CLOSE_OK,
      }),
    })
    assert.equal(report.ok, true)
    assert.deepEqual(report.missing, [])
    assert.equal(report.summary.expected, 7)
    assert.equal(report.summary.issues, 2)
    assert.equal(report.summary.openIssues, 1)
    assert.equal(report.summary.closedIssues, 1)
    assert.equal(report.summary.optional, 2)
    assert.match(report.text, /问题 2/)
    assert.doesNotMatch(report.text, /问题：/)
    assert.doesNotMatch(report.text, /0001 \[开启\]/)
  })

  it('同一编码同时出现在 open/ 与 close/ 时报冲突', async () => {
    const report = await inspectDocs({
      root: writeTree({
        '.coder/issues/open/issue-0001.md': ISSUE_OPEN_OK,
        '.coder/issues/close/issue-0001.md': ISSUE_CLOSE_OK,
      }),
    })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'issue.status.conflict').length, 1)
    assert.match(report.text, /同时出现在/)
  })

  it('issues 下不在白名单里的文件是非法文档', async () => {
    const report = await inspectDocs({
      root: writeTree({
        '.coder/issues/notes.md': '说明',
        '.coder/issues/all/issue-0001.md': ISSUE_OPEN_OK,
        '.coder/issues/open/issue-1.md': ISSUE_OPEN_OK,
      }),
    })
    assert.equal(report.ok, false)
    assert.deepEqual(report.illegal.sort(), [
      '.coder/issues/all/issue-0001.md',
      '.coder/issues/notes.md',
      '.coder/issues/open/issue-1.md',
    ])
  })

  it('进度通配没有命中项目文件时报错', async () => {
    const report = await inspectDocs({
      root: writeTree({
        '.coder/issues/open/issue-0001.md': ISSUE_OPEN_OK.replace('[src/**]', '[web/**]'),
      }),
    })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'issue.progress.no-match').length, 1)
  })

  it('文件格式问题按文档报告', async () => {
    const report = await inspectDocs({
      root: writeTree({
        '.coder/issues/open/issue-0001.md': ISSUE_OPEN_OK.replace('# 提交源', '# 状态'),
      }),
    })
    assert.equal(report.ok, false)
    assert.equal(report.summary.issues, 1)
    assert.ok(rules(report, 'issue.section.unknown').length > 0 || rules(report, 'issue.status.removed').length > 0)
  })
})

describe('create_issue', () => {
  it('创建开启的问题文件，写入 # 当前进度', async () => {
    const root = writeTree({})
    const result = await createCreateIssueTool(logger).execute(
      { root, problem: '列表漏报问题', source: 'list 检查时发现', scope: 'src/**', progress: '正在补检查' },
      { cwd: root },
    )

    assert.equal(result.ok, true)
    assert.equal(result.code, '0001')
    assert.equal(result.status, '开启')
    assert.equal(result.issue, '.coder/issues/open/issue-0001.md')
    assert.equal(result.issueDir, 'issues/open')
    const content = readFileSync(join(root, '.coder/issues/open/issue-0001.md'), 'utf8')
    assert.match(content, /# 问题\n列表漏报问题/)
    assert.match(content, /# 提交源\nlist 检查时发现/)
    assert.match(content, /# 当前进度\n\[src\/\*\*\] 当前进度为 正在补检查/)
    assert.doesNotMatch(content, /# 状态/)
    assert.equal(existsSync(join(root, '.coder/issues/open.md')), false)

    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.issues, 1)
    assert.equal(report.summary.openIssues, 1)
  })

  it('编号取两个文件夹的最大值加一，关闭状态写 close/', async () => {
    const root = writeTree({
      '.coder/issues/open/issue-0001.md': ISSUE_OPEN_OK,
    })
    const tool = createCreateIssueTool(logger)
    const result = await tool.execute(
      { root, problem: '第二个问题', source: '实施', status: '关闭', closeReason: '已修复' },
      { cwd: root },
    )

    assert.equal(result.code, '0002')
    assert.equal(result.issue, '.coder/issues/close/issue-0002.md')
    assert.equal(result.issueDir, 'issues/close')
    const content = readFileSync(join(root, '.coder/issues/close/issue-0002.md'), 'utf8')
    assert.match(content, /# 关闭原因\n已修复/)
    assert.doesNotMatch(content, /# 当前进度/)

    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.issues, 2)
    assert.equal(report.summary.openIssues, 1)
    assert.equal(report.summary.closedIssues, 1)
  })

  it('拒绝非法参数与已上锁的文档树', async () => {
    const root = writeTree({})
    const tool = createCreateIssueTool(logger)
    await assert.rejects(
      () => tool.execute({ root, problem: '', source: 'x' }, { cwd: root }),
      /problem/,
    )
    await assert.rejects(
      () => tool.execute({ root, problem: 'x', source: 'y', status: '处理中' }, { cwd: root }),
      /status/,
    )
    await assert.rejects(
      () => tool.execute({ root, problem: '# 标题', source: 'y' }, { cwd: root }),
      /标题行/,
    )

    await createLockTool(logger).execute({ root, authorization: '授权' }, { cwd: root })
    await assert.rejects(
      () => tool.execute({ root, problem: 'x', source: 'y' }, { cwd: root }),
      /已上锁/,
    )
  })
})
