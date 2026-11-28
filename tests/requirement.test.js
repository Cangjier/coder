/**
 * 需求文件与 `create_requirement` 的行为测试。
 *
 * 覆盖六个状态目录、段落顺序、验收标准编号、当前进度、完成说明与丢弃原因，
 * 以及 create_requirement 的默认登记、跨目录编号与写入规则。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import {
  REQUIREMENT_FOLDERS,
  inspectRequirement,
  isRequirementDoc,
  requirementMetaOf,
  validateRequirement,
} from '../src/requirement.js'
import { createCreateRequirementTool } from '../src/tools/create-requirement.js'
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

const ACTIVE_OK = `# 需求
支持需求登记与状态流转。

# 背景
现在需求散落在对话里。

# 验收标准

1. 能在登记目录创建需求。
2. 能按文件夹区分状态。

# 提交源
用户

# 当前进度
[src/**] 当前进度为 已登记，等待处理。
`

const DONE_OK = `# 需求
支持需求登记与状态流转。

# 验收标准

1. 能在登记目录创建需求。

# 提交源
用户

# 完成说明
已实现并验证。
`

const DISCARDED_OK = `# 需求
支持需求登记与状态流转。

# 验收标准

1. 能在登记目录创建需求。

# 提交源
用户

# 丢弃原因
用例不足。
`

const logger = { info: () => {}, warn: () => {}, error: () => {} }

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-requirement-'))
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

/** 在一条“登记”需求上跑一次校验。 */
function checkActive(text, meta = { folder: '登记', key: 'registered', phase: 'active', code: '0001' }, files = ['src/main.ts']) {
  return validateRequirement('.coder/requirements/登记/requirement-0001.md', text, meta, files)
}

describe('需求文件名', () => {
  it('识别六个状态目录并取回元信息', () => {
    const expected = [
      ['登记', 'registered', 'active'],
      ['接受-待开发', 'accepted', 'active'],
      ['开发中', 'developing', 'active'],
      ['本版本已完成', 'current', 'done'],
      ['历史已完成', 'history', 'done'],
      ['丢弃', 'discarded', 'discarded'],
    ]
    for (const [folder, key, phase] of expected) {
      const relative = `requirements/${folder}/requirement-0001.md`
      assert.equal(isRequirementDoc(relative), true, relative)
      assert.deepEqual(requirementMetaOf(relative), { folder, key, phase, code: '0001' })
    }
    assert.deepEqual(REQUIREMENT_FOLDERS, expected.map(([folder]) => folder))
  })

  it('拒绝其他目录与不合规的文件名', () => {
    for (const relative of [
      'requirements/登记/requirement-1.md',
      'requirements/登记/requirement-0001.txt',
      'requirements/登记/需求-0001.md',
      'requirements/已登记/requirement-0001.md',
      'requirements/requirement-0001.md',
    ]) {
      assert.equal(isRequirementDoc(relative), false, relative)
      assert.equal(requirementMetaOf(relative), null, relative)
    }
  })
})

describe('需求内容', () => {
  it('登记中的需求解析出验收标准与当前进度', () => {
    const result = inspectRequirement(
      '.coder/requirements/登记/requirement-0001.md',
      ACTIVE_OK,
      { folder: '登记', key: 'registered', phase: 'active', code: '0001' },
      ['src/main.ts'],
    )
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entry.status, '登记')
    assert.equal(result.entry.criteria, 2)
    assert.deepEqual(result.entry.progress, {
      line: 16,
      scope: 'src/**',
      text: '已登记，等待处理。',
      matches: 1,
    })
    assert.equal(result.entry.conclusion, null)
  })

  it('本版本已完成与历史已完成使用完成说明', () => {
    for (const folder of ['本版本已完成', '历史已完成']) {
      const result = inspectRequirement(
        `.coder/requirements/${folder}/requirement-0001.md`,
        DONE_OK,
        { folder, key: folder === '丢弃' ? 'discarded' : 'current', phase: 'done', code: '0001' },
        ['src/main.ts'],
      )
      assert.deepEqual(result.diagnostics, [], folder)
      assert.equal(result.entry.conclusion, '已实现并验证。')
      assert.equal(result.entry.progress, null)
    }
  })

  it('丢弃使用丢弃原因', () => {
    const result = inspectRequirement(
      '.coder/requirements/丢弃/requirement-0001.md',
      DISCARDED_OK,
      { folder: '丢弃', key: 'discarded', phase: 'discarded', code: '0001' },
      ['src/main.ts'],
    )
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.entry.conclusion, '用例不足。')
  })

  it('缺少段落、未知段落、重复、顺序错误与空段落都会报错', () => {
    assert.ok(checkActive(ACTIVE_OK.replace('# 提交源\n用户\n', '')).some((item) => item.rule === 'requirement.section.missing'))
    assert.ok(checkActive(ACTIVE_OK.replace('# 背景', '# 备注')).some((item) => item.rule === 'requirement.section.unknown'))
    assert.ok(
      checkActive(ACTIVE_OK.replace('# 提交源', '# 需求\n重复\n\n# 提交源')).some(
        (item) => item.rule === 'requirement.section.duplicate',
      ),
    )
    const reordered = ACTIVE_OK.replace('# 背景\n现在需求散落在对话里。\n\n# 验收标准', '# 验收标准').replace(
      '# 提交源',
      '# 背景\n现在需求散落在对话里。\n\n# 提交源',
    )
    assert.ok(checkActive(reordered).some((item) => item.rule === 'requirement.section.order'))
    assert.ok(checkActive(ACTIVE_OK.replace('# 背景\n现在需求散落在对话里。', '# 背景\n')).some((item) => item.rule === 'requirement.section.empty'))
  })

  it('# 状态 由文件夹取代，二级标题与标题前正文会报错', () => {
    assert.ok(checkActive(ACTIVE_OK.replace('# 当前进度', '# 状态\n登记\n\n# 当前进度')).some((item) => item.rule === 'requirement.status.removed'))
    assert.ok(checkActive(ACTIVE_OK.replace('# 背景', '## 背景')).some((item) => item.rule === 'requirement.heading.level'))
    assert.ok(checkActive(`说明\n${ACTIVE_OK}`).some((item) => item.rule === 'requirement.preamble'))
    assert.ok(checkActive('').some((item) => item.rule === 'requirement.empty'))
  })

  it('验收标准必须是连续编号条目', () => {
    assert.ok(
      checkActive(ACTIVE_OK.replace('1. 能在登记目录创建需求。', '能在登记目录创建需求。')).some(
        (item) => item.rule === 'requirement.criteria.format',
      ),
    )
    assert.ok(
      checkActive(ACTIVE_OK.replace('2. 能按文件夹区分状态。', '3. 能按文件夹区分状态。')).some(
        (item) => item.rule === 'requirement.criteria.number',
      ),
    )
    assert.ok(
      checkActive(ACTIVE_OK.replace('1. 能在登记目录创建需求。\n2. 能按文件夹区分状态。', '只有一句。')).some(
        (item) => item.rule === 'requirement.criteria.empty' || item.rule === 'requirement.criteria.format',
      ),
    )
  })

  it('当前进度必须是一行合法通配，且要命中项目文件', () => {
    assert.ok(checkActive(ACTIVE_OK.replace('[src/**] 当前进度为 已登记，等待处理。', '已登记。')).some((item) => item.rule === 'requirement.progress.format'))
    assert.ok(checkActive(ACTIVE_OK.replace('[src/**]', '[/src]')).some((item) => item.rule === 'requirement.progress.glob'))
    assert.ok(checkActive(ACTIVE_OK.replace('[src/**]', '[web/**]')).some((item) => item.rule === 'requirement.progress.no-match'))
    assert.ok(checkActive(`${ACTIVE_OK}[src/**] 当前进度为 又一行。\n`).some((item) => item.rule === 'requirement.progress.lines'))
  })

  it('完成说明与丢弃原因至少一行正文，状态不符的结尾段落会报错', () => {
    for (const [text, meta] of [
      [DONE_OK.replace('# 完成说明\n已实现并验证。', '# 完成说明\n'), { folder: '本版本已完成', key: 'current', phase: 'done', code: '0001' }],
      [DISCARDED_OK.replace('# 丢弃原因\n用例不足。', '# 丢弃原因\n'), { folder: '丢弃', key: 'discarded', phase: 'discarded', code: '0001' }],
    ]) {
      assert.ok(
        validateRequirement(`.coder/requirements/${meta.folder}/requirement-0001.md`, text, meta).some(
          (item) => item.rule === 'requirement.section.empty',
        ),
      )
    }
    assert.ok(
      checkActive(ACTIVE_OK.replace('# 当前进度', '# 完成说明')).some(
        (item) => item.rule === 'requirement.section.unknown',
      ),
    )
  })
})

describe('list 与需求文件', () => {
  it('六个状态的需求都作为可选文档被检查并计数', async () => {
    const root = writeTree({
      '.coder/requirements/登记/requirement-0001.md': ACTIVE_OK,
      '.coder/requirements/接受-待开发/requirement-0002.md': ACTIVE_OK.replaceAll('0001', '0002').replace('已登记，等待处理。', '已接受，等待开发。'),
      '.coder/requirements/开发中/requirement-0003.md': ACTIVE_OK.replaceAll('0001', '0003').replace('已登记，等待处理。', '正在开发。'),
      '.coder/requirements/本版本已完成/requirement-0004.md': DONE_OK,
      '.coder/requirements/历史已完成/requirement-0005.md': DONE_OK,
      '.coder/requirements/丢弃/requirement-0006.md': DISCARDED_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.deepEqual(report.missing, [])
    assert.equal(report.summary.requirements, 6)
    assert.equal(report.summary.registeredRequirements, 1)
    assert.equal(report.summary.acceptedRequirements, 1)
    assert.equal(report.summary.developingRequirements, 1)
    assert.equal(report.summary.currentRequirements, 1)
    assert.equal(report.summary.historyRequirements, 1)
    assert.equal(report.summary.discardedRequirements, 1)
    assert.equal(report.summary.optional, 6)
    assert.match(report.text, /需求 6/)
    assert.match(report.text, /可选 6/)
  })

  it('同一个编码出现在两个状态目录时报冲突', async () => {
    const root = writeTree({
      '.coder/requirements/登记/requirement-0001.md': ACTIVE_OK,
      '.coder/requirements/开发中/requirement-0001.md': ACTIVE_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'requirement.status.conflict').length, 1)
    assert.match(report.text, /同时出现在/)
  })

  it('requirements 下不在六个目录与命名规则里的文件是非法文档', async () => {
    const root = writeTree({
      '.coder/requirements/登记/README.md': '说明',
      '.coder/requirements/登记/requirement-1.md': ACTIVE_OK,
      '.coder/requirements/待定/requirement-0001.md': ACTIVE_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.deepEqual(report.illegal.sort(), [
      '.coder/requirements/待定/requirement-0001.md',
      '.coder/requirements/登记/README.md',
      '.coder/requirements/登记/requirement-1.md',
    ])
  })

  it('进度通配没有命中项目文件时报错', async () => {
    const root = writeTree({
      '.coder/requirements/登记/requirement-0001.md': ACTIVE_OK.replace('[src/**]', '[web/**]'),
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.equal(rules(report, 'requirement.progress.no-match').length, 1)
  })
})

describe('create_requirement', () => {
  it('默认写入登记目录，并生成验收标准与当前进度', async () => {
    const root = writeTree({})
    const result = await createCreateRequirementTool(logger).execute(
      {
        root,
        requirement: '支持需求登记与状态流转',
        source: '用户',
        acceptance: ['能在登记目录创建需求', '能按文件夹区分状态'],
      },
      { cwd: root },
    )

    assert.equal(result.ok, true)
    assert.equal(result.code, '0001')
    assert.equal(result.status, '登记')
    assert.equal(result.requirement, '.coder/requirements/登记/requirement-0001.md')
    assert.equal(result.requirementDir, 'requirements/登记')
    const content = readFileSync(join(root, result.requirement), 'utf8')
    assert.match(content, /# 需求\n支持需求登记与状态流转/)
    assert.match(content, /# 验收标准\n\n1\. 能在登记目录创建需求\n2\. 能按文件夹区分状态/)
    assert.match(content, /# 提交源\n用户/)
    assert.match(content, /# 当前进度\n\[\*\*\] 当前进度为 已登记，等待处理。/)
    assert.doesNotMatch(content, /# 状态/)

    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.requirements, 1)
    assert.equal(report.summary.registeredRequirements, 1)
  })

  it('编号跨六个目录取最大值加一，完成与丢弃写对应结尾', async () => {
    const root = writeTree({
      '.coder/requirements/登记/requirement-0003.md': ACTIVE_OK.replaceAll('0001', '0003'),
    })
    const tool = createCreateRequirementTool(logger)

    const done = await tool.execute(
      {
        root,
        requirement: '已完成的需求',
        source: '实施',
        acceptance: ['已经实现'],
        status: '本版本已完成',
        completion: '已实现并验证。',
      },
      { cwd: root },
    )
    assert.equal(done.code, '0004')
    assert.equal(done.requirement, '.coder/requirements/本版本已完成/requirement-0004.md')
    const doneContent = readFileSync(join(root, done.requirement), 'utf8')
    assert.match(doneContent, /# 完成说明\n已实现并验证。/)
    assert.doesNotMatch(doneContent, /# 当前进度/)

    const discarded = await tool.execute(
      {
        root,
        requirement: '被丢弃的需求',
        source: '实施',
        acceptance: ['不再需要'],
        status: '丢弃',
      },
      { cwd: root },
    )
    assert.equal(discarded.code, '0005')
    const discardedContent = readFileSync(join(root, discarded.requirement), 'utf8')
    assert.match(discardedContent, /# 丢弃原因\n已丢弃。/)
    assert.doesNotMatch(discardedContent, /# 当前进度/)

    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.requirements, 3)
    assert.equal(report.summary.currentRequirements, 1)
    assert.equal(report.summary.discardedRequirements, 1)
  })

  it('拒绝非法参数、标题行与已上锁的文档树', async () => {
    const root = writeTree({})
    const tool = createCreateRequirementTool(logger)
    await assert.rejects(() => tool.execute({ root, requirement: '', source: 'x', acceptance: ['y'] }, { cwd: root }), /requirement/)
    await assert.rejects(() => tool.execute({ root, requirement: 'x', source: 'y', acceptance: [] }, { cwd: root }), /acceptance/)
    await assert.rejects(
      () => tool.execute({ root, requirement: 'x', source: 'y', acceptance: ['z'], status: '待定' }, { cwd: root }),
      /status/,
    )
    await assert.rejects(
      () => tool.execute({ root, requirement: '# 标题', source: 'y', acceptance: ['z'] }, { cwd: root }),
      /标题行/,
    )
    await assert.rejects(
      () =>
        tool.execute(
          { root, requirement: 'x', source: 'y', acceptance: ['z'], status: '本版本已完成', completion: 'a\nb' },
          { cwd: root },
        ),
      /completion/,
    )

    await createLockTool(logger).execute({ root, authorization: '授权' }, { cwd: root })
    await assert.rejects(
      () => tool.execute({ root, requirement: 'x', source: 'y', acceptance: ['z'] }, { cwd: root }),
      /已上锁/,
    )
  })
})
