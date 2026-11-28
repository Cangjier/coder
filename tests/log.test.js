/**
 * 日志文件的行为测试。
 *
 * 覆盖 logs/audit、logs/update、logs/usage 的日期序号文件名、标题、固定字段、
 * 编号条目、同日序号连续性，以及 list 的收录与 render 的排除。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import { inspectLog, isLogDoc, isRealDate, logKindOf, logMetaOf, validateLog } from '../src/log.js'
import { createRenderTool } from '../src/tools/render.js'

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

const AUDIT_OK = `# 2026-11-28-001

审计范围：src/**

审计结论：格式与覆盖检查通过

说明：本轮没有发现遗漏。
`

const UPDATE_OK = `# 2026-11-28-001

版本：0.1.0

更新内容：

1. 增加日志目录与检查。
2. 更新设计文档。
`

const USAGE_OK = `# 2026-11-28-002

使用场景：业务录入

使用反馈：字段太多，希望合并。

说明：下个版本评估。
`

const logger = { info: () => {}, warn: () => {}, error: () => {} }

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-log-'))
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

/** 在一条审计日志上跑一次校验。 */
function checkAudit(text, meta = { date: '2026-11-28', sequence: '001', stem: '2026-11-28-001' }) {
  return validateLog('.coder/logs/audit/2026-11-28-001.md', text, 'log-audit', meta)
}

/** 在一条产品更新日志上跑一次校验。 */
function checkUpdate(text) {
  return validateLog('.coder/logs/update/2026-11-28-001.md', text, 'log-update', {
    date: '2026-11-28',
    sequence: '001',
    stem: '2026-11-28-001',
  })
}

describe('日志文件名', () => {
  it('识别三类日志路径并取出日期与序号', () => {
    assert.equal(isLogDoc('logs/audit/2026-11-28-001.md'), true)
    assert.equal(isLogDoc('logs/update/2026-11-28-001.md'), true)
    assert.equal(isLogDoc('logs/usage/2026-11-28-001.md'), true)
    assert.equal(logKindOf('logs/audit/2026-11-28-001.md'), 'log-audit')
    assert.equal(logKindOf('logs/update/2026-11-28-001.md'), 'log-update')
    assert.equal(logKindOf('logs/usage/2026-11-28-001.md'), 'log-usage')
    assert.deepEqual(logMetaOf('logs/audit/2026-11-28-001.md'), {
      kind: 'audit',
      date: '2026-11-28',
      sequence: '001',
      stem: '2026-11-28-001',
    })
  })

  it('拒绝其他目录、错误扩展名与不合规的日期序号', () => {
    for (const relative of [
      'logs/audit/2026-11-28-1.md',
      'logs/audit/2026-11-28-001.txt',
      'logs/audit/README.md',
      'logs/other/2026-11-28-001.md',
      'logs/2026-11-28-001.md',
      'issues/open/2026-11-28-001.md',
    ]) {
      assert.equal(isLogDoc(relative), false, relative)
    }
    assert.equal(logMetaOf('logs/audit/README.md'), null)
  })

  it('日期必须是真实存在的日历日期', () => {
    assert.equal(isRealDate('2026-11-28'), true)
    assert.equal(isRealDate('2024-02-29'), true)
    assert.equal(isRealDate('2026-02-29'), false)
    assert.equal(isRealDate('2026-13-01'), false)
    assert.equal(isRealDate('2026-04-31'), false)
  })
})

describe('日志内容', () => {
  it('审计日志解析出范围与结论', () => {
    const result = inspectLog('.coder/logs/audit/2026-11-28-001.md', AUDIT_OK, 'log-audit', {
      date: '2026-11-28',
      sequence: '001',
      stem: '2026-11-28-001',
    })
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entry.kind, 'audit')
    assert.equal(result.entry.date, '2026-11-28')
    assert.equal(result.entry.sequence, '001')
    assert.equal(result.entry.scope, 'src/**')
    assert.equal(result.entry.conclusion, '格式与覆盖检查通过')
  })

  it('产品更新日志解析出版本与编号条目', () => {
    const result = inspectLog('.coder/logs/update/2026-11-28-001.md', UPDATE_OK, 'log-update', {
      date: '2026-11-28',
      sequence: '001',
      stem: '2026-11-28-001',
    })
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entry.version, '0.1.0')
    assert.equal(result.entry.items, 2)
  })

  it('使用报告日志解析出场景与反馈', () => {
    const result = inspectLog('.coder/logs/usage/2026-11-28-002.md', USAGE_OK, 'log-usage', {
      date: '2026-11-28',
      sequence: '002',
      stem: '2026-11-28-002',
    })
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entry.scenario, '业务录入')
    assert.equal(result.entry.feedback, '字段太多，希望合并。')
  })

  it('缺少标题、标题不匹配、额外标题与标题前正文都会报错', () => {
    assert.ok(checkAudit('审计范围：src/**\n').some((item) => item.rule === 'log.title.missing'))
    assert.ok(
      checkAudit(AUDIT_OK.replace('# 2026-11-28-001', '# 2026-11-28-002')).some(
        (item) => item.rule === 'log.title.format',
      ),
    )
    assert.ok(
      checkAudit(AUDIT_OK.replace('说明：', '## 备注\n说明：')).some((item) => item.rule === 'log.heading.extra'),
    )
    assert.ok(checkAudit(`前置说明\n${AUDIT_OK}`).some((item) => item.rule === 'log.preamble'))
  })

  it('字段缺失、顺序错误、重复、未知与空值都会报错', () => {
    assert.ok(checkAudit(AUDIT_OK.replace('审计结论：格式与覆盖检查通过\n', '')).some((item) => item.rule === 'log.field.missing'))
    const reordered = AUDIT_OK.replace(
      '审计范围：src/**\n\n审计结论：格式与覆盖检查通过',
      '审计结论：格式与覆盖检查通过\n\n审计范围：src/**',
    )
    assert.ok(checkAudit(reordered).some((item) => item.rule === 'log.field.order'))
    assert.ok(
      checkAudit(AUDIT_OK.replace('审计结论：', '审计结论：\n审计结论：')).some(
        (item) => item.rule === 'log.field.multiple',
      ),
    )
    assert.ok(checkAudit(AUDIT_OK.replace('说明：', '备注：')).some((item) => item.rule === 'log.field.unexpected'))
    assert.ok(checkAudit(AUDIT_OK.replace('说明：本轮没有发现遗漏。', '说明：')).some((item) => item.rule === 'log.field.empty'))
  })

  it('更新日志的更新内容必须是连续编号条目', () => {
    assert.ok(
      checkUpdate(UPDATE_OK.replace('更新内容：\n\n1. 增加日志目录与检查。\n2. 更新设计文档。', '更新内容：\n')).some(
        (item) => item.rule === 'log.item.missing',
      ),
    )
    assert.ok(
      checkUpdate(UPDATE_OK.replace('更新内容：', '更新内容：增加日志。')).some(
        (item) => item.rule === 'log.field.inline',
      ),
    )
    assert.ok(
      checkUpdate(UPDATE_OK.replace('2. 更新设计文档。', '3. 更新设计文档。')).some(
        (item) => item.rule === 'log.item.number',
      ),
    )
    assert.ok(checkUpdate(UPDATE_OK.replace('2. 更新设计文档。', '2.')).some((item) => item.rule === 'log.item.empty'))
  })

  it('正文只允许字段与编号条目，空文件会报错', () => {
    assert.ok(checkAudit(`${AUDIT_OK}\n补充一句。\n`).some((item) => item.rule === 'log.body'))
    assert.ok(checkAudit('').some((item) => item.rule === 'log.empty'))
  })

  it('文件名里的假日期与 000 序号会报错', () => {
    assert.ok(checkAudit(AUDIT_OK, { date: '2026-02-30', sequence: '001', stem: '2026-02-30-001' }).some((item) => item.rule === 'log.file.date'))
    assert.ok(checkAudit(AUDIT_OK, { date: '2026-11-28', sequence: '000', stem: '2026-11-28-000' }).some((item) => item.rule === 'log.file.sequence'))
  })
})

describe('list 与日志文件', () => {
  it('三类日志都作为可选文档被检查并计数', async () => {
    const root = writeTree({
      '.coder/logs/audit/2026-11-28-001.md': AUDIT_OK,
      '.coder/logs/update/2026-11-28-001.md': UPDATE_OK,
      '.coder/logs/usage/2026-11-28-001.md': USAGE_OK.replaceAll('2026-11-28-002', '2026-11-28-001'),
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.deepEqual(report.missing, [])
    assert.equal(report.summary.logs, 3)
    assert.equal(report.summary.auditLogs, 1)
    assert.equal(report.summary.updateLogs, 1)
    assert.equal(report.summary.usageLogs, 1)
    assert.equal(report.summary.optional, 3)
    assert.match(report.text, /日志 3/)
    assert.ok(report.documents.some((item) => item.path === '.coder/logs/audit/2026-11-28-001.md' && item.status === 'optional'))
    assert.equal(report.logs.audit[0].sequence, '001')
  })

  it('同一天序号必须从 001 连续，缺号时报 log.sequence.gap', async () => {
    const root = writeTree({
      '.coder/logs/audit/2026-11-28-001.md': AUDIT_OK,
      '.coder/logs/audit/2026-11-28-003.md': AUDIT_OK.replace('# 2026-11-28-001', '# 2026-11-28-003'),
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'log.sequence.gap').length, 1)
    assert.match(report.text, /缺少 002/)
  })

  it('只从 002 开始也算缺号', async () => {
    const root = writeTree({
      '.coder/logs/usage/2026-11-28-002.md': USAGE_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'log.sequence.gap').length, 1)
  })

  it('不同日期与不同类别的序号互不影响', async () => {
    const root = writeTree({
      '.coder/logs/audit/2026-11-28-001.md': AUDIT_OK,
      '.coder/logs/audit/2026-11-29-001.md': AUDIT_OK.replaceAll('2026-11-28', '2026-11-29'),
      '.coder/logs/update/2026-11-28-001.md': UPDATE_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(rules(report, 'log.sequence.gap').length, 0)
  })

  it('logs 下不在约定目录与命名里的文件是非法文档', async () => {
    const root = writeTree({
      '.coder/logs/audit/README.md': '说明',
      '.coder/logs/audit/2026-11-28-1.md': AUDIT_OK,
      '.coder/logs/other/2026-11-28-001.md': AUDIT_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.deepEqual(report.illegal.sort(), [
      '.coder/logs/audit/2026-11-28-1.md',
      '.coder/logs/audit/README.md',
      '.coder/logs/other/2026-11-28-001.md',
    ])
  })

  it('render 页面不收录日志条目', async () => {
    const root = writeTree({
      '.coder/logs/audit/2026-11-28-001.md': AUDIT_OK,
    })
    const result = await createRenderTool(logger).execute({ root }, { cwd: root })
    const html = readFileSync(result.output, 'utf8')
    assert.doesNotMatch(html, /审计结论/)
    assert.doesNotMatch(html, /2026-11-28-001/)
  })
})
