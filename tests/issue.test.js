/**
 * 问题文档与 `create_issue` 的行为测试。
 *
 * 覆盖问题详情的固定段落、open.md / close.md 的进度与关闭原因、可选文件的
 * 状态、索引与详情文件的交叉检查，以及 create_issue 的编号与写入规则。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import {
  inspectIssueAll,
  inspectIssueClose,
  inspectIssueOpen,
  validateIssue,
} from '../src/issue.js'
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

const ISSUE_OK = `# 问题
列表漏报问题。

# 状态
开启

# 复现
1. 运行 list。
2. 观察缺少的诊断。

# 建议
补上检查。

# 提交源
用户
`

const OPEN_OK = `# 0001
[src/**] 当前进度为 正在定位。
`

const CLOSE_OK = `# 0001
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
 * 在临时目录里写一棵文档树；默认补齐十一份预期文档和一个项目文件。
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
    '.coder/plan/todo.md': '',
    '.coder/plan/todo-archived.md': '',
    '.coder/plan/goal.md': '',
    '.coder/plan/goal-archived.md': '',
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

describe('issue detail', () => {
  it('完整的详情通过并解析出状态', () => {
    const result = inspectIssueAll('.coder/issues/all/issue-0001.md', ISSUE_OK)
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.status, '开启')
  })

  it('复现与建议可以省略，也可以带（可选）后缀', () => {
    const minimal = `# 问题
问题描述。

# 状态
关闭

# 提交源
用户
`
    assert.deepEqual(inspectIssueAll('x.md', minimal).diagnostics, [])
    assert.equal(inspectIssueAll('x.md', minimal).status, '关闭')

    const marked = `# 问题
问题描述。

# 状态
开启

# 复现（可选）
没有复现步骤。

# 建议（可选）
没有建议。

# 提交源
用户
`
    assert.deepEqual(inspectIssueAll('x.md', marked).diagnostics, [])
  })

  it('缺少必填段落、状态非法或段落顺序错误时报错', () => {
    const missing = `# 问题
问题描述。
`
    const missingReport = inspectIssueAll('x.md', missing).diagnostics
    assert.ok(missingReport.some((item) => item.rule === 'issue.section.missing'))

    const badStatus = ISSUE_OK.replace('开启', '处理中')
    assert.ok(
      inspectIssueAll('x.md', badStatus).diagnostics.some((item) => item.rule === 'issue.status.value'),
    )

    const wrongOrder = `# 状态
开启

# 问题
问题描述。

# 提交源
用户
`
    assert.ok(
      inspectIssueAll('x.md', wrongOrder).diagnostics.some((item) => item.rule === 'issue.section.order'),
    )
  })

  it('未知段落、空段落和二级标题都会报错', () => {
    const text = `# 问题

# 状态
开启

# 备注
多余

# 提交源
用户

## 子标题
说明
`
    const report = inspectIssueAll('x.md', text).diagnostics
    assert.ok(report.some((item) => item.rule === 'issue.section.empty'))
    assert.ok(report.some((item) => item.rule === 'issue.section.unknown'))
    assert.ok(report.some((item) => item.rule === 'issue.heading.level'))
  })

  it('空详情与第一个标题之前的正文都会被诊断', () => {
    assert.ok(
      inspectIssueAll('x.md', '').diagnostics.some((item) => item.rule === 'issue.empty'),
    )
    assert.ok(
      inspectIssueAll('x.md', `前言\n${ISSUE_OK}`).diagnostics.some((item) => item.rule === 'issue.preamble'),
    )
  })
})

describe('issue indexes', () => {
  it('open.md 的进度行与通配命中通过', () => {
    const result = inspectIssueOpen('.coder/issues/open.md', OPEN_OK, ['src/main.ts'])
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0].code, '0001')
    assert.equal(result.entries[0].matches, 1)
  })

  it('open.md 拒绝编码、进度格式与通配问题', () => {
    assert.ok(
      inspectIssueOpen('x.md', '# 1\n[src/**] 当前进度为 进行中。\n').diagnostics.some(
        (item) => item.rule === 'issue.code.format',
      ),
    )
    assert.ok(
      inspectIssueOpen('x.md', '# 0001\n正在处理。\n').diagnostics.some(
        (item) => item.rule === 'issue.progress.format',
      ),
    )
    assert.ok(
      inspectIssueOpen('x.md', '# 0001\n[全局] 当前进度为 进行中。\n').diagnostics.some(
        (item) => item.rule === 'issue.progress.glob',
      ),
    )
    assert.ok(
      inspectIssueOpen('x.md', '# 0001\n[none/**] 当前进度为 进行中。\n', ['src/main.ts']).diagnostics.some(
        (item) => item.rule === 'issue.progress.no-match',
      ),
    )
  })

  it('open.md 拒绝重复编码和多行进度', () => {
    const duplicate = '# 0001\n[src/**] 当前进度为 进行中。\n\n# 0001\n[src/**] 当前进度为 仍进行中。\n'
    assert.ok(
      inspectIssueOpen('x.md', duplicate).diagnostics.some((item) => item.rule === 'issue.code.duplicate'),
    )
    const multi = '# 0001\n[src/**] 当前进度为 进行中。\n补充说明。\n'
    assert.ok(inspectIssueOpen('x.md', multi).diagnostics.some((item) => item.rule === 'issue.body'))
  })

  it('close.md 要求关闭原因且编码唯一', () => {
    assert.deepEqual(inspectIssueClose('x.md', CLOSE_OK).diagnostics, [])
    assert.equal(inspectIssueClose('x.md', CLOSE_OK).entries[0].reason, '已修复并验证。')
    assert.ok(
      inspectIssueClose('x.md', '# 0001\n').diagnostics.some((item) => item.rule === 'issue.reason.missing'),
    )
    assert.ok(
      inspectIssueClose('x.md', '# 0001\n原因一。\n# 0001\n原因二。\n').diagnostics.some(
        (item) => item.rule === 'issue.code.duplicate',
      ),
    )
  })

  it('空索引合法', () => {
    assert.deepEqual(validateIssue('x.md', '', 'issue-open'), [])
    assert.deepEqual(validateIssue('x.md', '', 'issue-close'), [])
  })
})

describe('issues in list', () => {
  it('存在的可选问题文档被检查但不产生缺失', async () => {
    const root = writeTree({
      '.coder/issues/all/issue-0001.md': ISSUE_OK,
      '.coder/issues/open.md': OPEN_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.deepEqual(report.missing, [])
    assert.equal(report.summary.expected, 11)
    assert.equal(report.summary.issues, 1)
    assert.equal(report.summary.openIssues, 1)
    assert.equal(report.summary.closedIssues, 0)
    assert.equal(report.summary.optional, 2)
    assert.match(report.text, /\[optional\] \.coder\/issues\/open\.md/)
  })

  it('缺少问题详情、状态冲突与非法问题文件都会报错', async () => {
    const root = writeTree({
      '.coder/issues/open.md': '# 0001\n[src/**] 当前进度为 进行中。\n',
      '.coder/issues/close.md': '# 0001\n已关闭。\n',
      '.coder/issues/all/notes.md': '说明',
    })
    const report = await inspectDocs({ root })
    assert.deepEqual(report.illegal, ['.coder/issues/all/notes.md'])
    assert.equal(rules(report, 'issue.file.missing').length, 2)
    assert.equal(rules(report, 'issue.status.conflict').length, 1)
  })

  it('详情文件的格式问题按文档报告', async () => {
    const root = writeTree({
      '.coder/issues/all/issue-0001.md': ISSUE_OK.replace('开启', '处理中'),
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'issue.status.value').length, 1)
    assert.equal(report.summary.issues, 1)
  })

  it('详情状态与索引不一致时报错', async () => {
    const root = writeTree({
      '.coder/issues/all/issue-0001.md': ISSUE_OK.replace('开启', '关闭'),
      '.coder/issues/open.md': OPEN_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'issue.status.mismatch').length, 1)
    assert.match(report.text, /issue\.status\.mismatch/)
  })
})

describe('create_issue', () => {
  it('创建问题详情并登记到 open.md', async () => {
    const root = writeTree({})
    const tool = createCreateIssueTool(logger)
    const result = await tool.execute(
      {
        root,
        problem: '列表漏报问题',
        source: '用户',
        scope: 'src/**',
        progress: '正在定位。',
      },
      { cwd: root },
    )

    assert.equal(result.ok, true)
    assert.equal(result.code, '0001')
    assert.equal(result.status, '开启')
    assert.equal(result.issue, '.coder/issues/all/issue-0001.md')
    assert.equal(result.index, '.coder/issues/open.md')

    const detail = readFileSync(join(root, '.coder/issues/all/issue-0001.md'), 'utf8')
    assert.match(detail, /^# 问题\n列表漏报问题\n\n# 状态\n开启\n/)
    assert.match(detail, /# 提交源\n用户\n$/)
    const open = readFileSync(join(root, '.coder/issues/open.md'), 'utf8')
    assert.equal(open, '# 0001\n[src/**] 当前进度为 正在定位。\n')

    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.issues, 1)
    assert.equal(report.summary.openIssues, 1)
  })

  it('编号取最大值加一，关闭状态写 close.md', async () => {
    const root = writeTree({})
    const tool = createCreateIssueTool(logger)
    const first = await tool.execute(
      { root, problem: '第一个问题', source: '用户', scope: 'src/**' },
      { cwd: root },
    )
    const second = await tool.execute(
      {
        root,
        problem: '第二个问题',
        source: '用户',
        status: '关闭',
        closeReason: '已确认重复。',
      },
      { cwd: root },
    )

    assert.equal(first.code, '0001')
    assert.equal(second.code, '0002')
    assert.equal(second.index, '.coder/issues/close.md')
    assert.ok(existsSync(join(root, '.coder/issues/all/issue-0002.md')))
    const close = readFileSync(join(root, '.coder/issues/close.md'), 'utf8')
    assert.equal(close, '# 0002\n已确认重复。\n')

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
      () => tool.execute({ root, problem: '问题', source: '用户', scope: '全局' }, { cwd: root }),
      /不能写全局/,
    )
    await assert.rejects(
      () => tool.execute({ root, problem: '# 标题\n问题', source: '用户' }, { cwd: root }),
      /Markdown 标题/,
    )

    await assert.rejects(
      () => tool.execute({ root: join(tempRoot, 'nope'), problem: '问题', source: '用户' }, {}),
      /项目根目录不存在/,
    )
    const bare = mkdtempSync(join(tempRoot, 'bare-'))
    await assert.rejects(
      () => tool.execute({ root: bare, problem: '问题', source: '用户' }, {}),
      /\.coder\/ 不存在/,
    )

    await createLockTool(logger).execute({ root, authorization: '授权' }, { cwd: root })
    await assert.rejects(
      () => tool.execute({ root, problem: '问题', source: '用户' }, { cwd: root }),
      /已上锁/,
    )
  })

  it('已有索引格式不合法时拒绝追加', async () => {
    const root = writeTree({
      '.coder/issues/open.md': '# 0001\n正在处理。\n',
    })
    const tool = createCreateIssueTool(logger)
    await assert.rejects(
      () => tool.execute({ root, problem: '问题', source: '用户' }, { cwd: root }),
      /格式不合法/,
    )
    assert.equal(existsSync(join(root, '.coder/issues/all/issue-0001.md')), false)
  })
})
