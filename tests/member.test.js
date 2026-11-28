/**
 * 成员文档的行为测试。
 *
 * 覆盖 members/all.md 的主对话、成员编号与字段，members/flow.md 的场景与
 * Mermaid 图，可选文档状态，以及 render 对成员文档的收录。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import {
  MEMBERS_ALL,
  MEMBERS_FLOW,
  inspectMembersAll,
  inspectMembersFlow,
  isMemberDoc,
  memberKindOf,
} from '../src/member.js'
import { renderDesign } from '../src/render.js'

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

const MEMBERS_ALL_OK = `# 主对话
身份：开发
工作范围：插件设计与实现

# 成员1
工作区名称：coder
身份：验证
工作范围：部署后的只读验证
备注：Linux 成员，SSH 用户 root

# 成员2
工作区名称：coder
身份：验证
工作范围：Windows 成员的只读验证
`

const MEMBERS_FLOW_OK = `# 成员流程
## 分派任务
主对话用 call_member 分派任务。
\`\`\`mermaid
flowchart TD
  A[主对话] --> B[成员执行]
\`\`\`
`

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-member-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 写一棵文档树；默认补齐七份预期文档和一个项目文件。
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
function rules(diagnostics, rule) {
  return diagnostics.filter((item) => item.rule === rule)
}

describe('members/all.md', () => {
  it('主对话与成员字段齐全时通过并解析出条目', () => {
    const result = inspectMembersAll('.coder/members/all.md', MEMBERS_ALL_OK)
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.main.identity, '开发')
    assert.equal(result.main.scope, '插件设计与实现')
    assert.deepEqual(
      result.members.map((entry) => [entry.number, entry.workspace, entry.identity, entry.scope, entry.note]),
      [
        [1, 'coder', '验证', '部署后的只读验证', 'Linux 成员，SSH 用户 root'],
        [2, 'coder', '验证', 'Windows 成员的只读验证', null],
      ],
    )
  })

  it('只有主对话、没有成员时通过', () => {
    const text = `# 主对话
身份：开发
工作范围：实现
`
    const result = inspectMembersAll('x.md', text)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.members, [])
  })

  it('空文件和缺少主对话时报错', () => {
    assert.ok(rules(inspectMembersAll('x.md', '').diagnostics, 'members.empty').length === 1)
    const onlyMember = `# 成员1
工作区名称：coder
身份：验证
工作范围：验证
`
    assert.ok(rules(inspectMembersAll('x.md', onlyMember).diagnostics, 'members.main.missing').length === 1)
  })

  it('主对话必须是第一个一级标题且只能出现一次', () => {
    const wrongOrder = `# 成员1
工作区名称：coder
身份：验证
工作范围：验证
# 主对话
身份：开发
工作范围：实现
`
    assert.ok(rules(inspectMembersAll('x.md', wrongOrder).diagnostics, 'members.main.order').length === 1)

    const duplicate = `# 主对话
身份：开发
工作范围：实现
# 主对话
身份：另一个
工作范围：另一个
`
    assert.ok(rules(inspectMembersAll('x.md', duplicate).diagnostics, 'members.main.duplicate').length === 1)
  })

  it('成员编号与标题格式会被检查', () => {
    const duplicate = `# 主对话
身份：开发
工作范围：实现
# 成员1
工作区名称：coder
身份：验证
工作范围：验证
# 成员1
工作区名称：coder
身份：验证
工作范围：验证
`
    assert.ok(rules(inspectMembersAll('x.md', duplicate).diagnostics, 'members.member.duplicate').length === 1)

    const format = `# 主对话
身份：开发
工作范围：实现
# 成员
工作区名称：coder
身份：验证
工作范围：验证
`
    assert.ok(rules(inspectMembersAll('x.md', format).diagnostics, 'members.member.format').length === 1)

    const unknown = `# 主对话
身份：开发
工作范围：实现
# 其他
说明
`
    assert.ok(rules(inspectMembersAll('x.md', unknown).diagnostics, 'members.section.unknown').length === 1)
  })

  it('必填字段、空值、重复、顺序与不支持的字段都会被检查', () => {
    const missing = `# 主对话
身份：开发
`
    assert.ok(rules(inspectMembersAll('x.md', missing).diagnostics, 'members.field.missing').length === 1)

    const empty = `# 主对话
身份：开发
工作范围：
`
    assert.ok(rules(inspectMembersAll('x.md', empty).diagnostics, 'members.field.empty').length === 1)

    const duplicate = `# 主对话
身份：开发
身份：另一个
工作范围：实现
`
    assert.ok(rules(inspectMembersAll('x.md', duplicate).diagnostics, 'members.field.duplicate').length === 1)

    const order = `# 主对话
工作范围：实现
身份：开发
`
    assert.ok(rules(inspectMembersAll('x.md', order).diagnostics, 'members.field.order').length === 1)

    const unexpected = `# 主对话
工作区名称：coder
身份：开发
工作范围：实现
`
    assert.ok(rules(inspectMembersAll('x.md', unexpected).diagnostics, 'members.field.unexpected').length === 1)

    const body = `# 主对话
身份：开发
工作范围：实现
补充：无
`
    assert.ok(rules(inspectMembersAll('x.md', body).diagnostics, 'members.body').length === 1)
  })

  it('成员备注可选、写在最后，空值或重复仍会报错', () => {
    const withNote = `# 主对话
身份：开发
工作范围：实现
# 成员1
工作区名称：coder
身份：验证
工作范围：验证
备注：Linux 成员
`
    const result = inspectMembersAll('x.md', withNote)
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.members[0].note, 'Linux 成员')

    const withoutNote = withNote.replace('备注：Linux 成员\n', '')
    assert.deepEqual(inspectMembersAll('x.md', withoutNote).diagnostics, [])

    const empty = withNote.replace('备注：Linux 成员', '备注：')
    assert.ok(rules(inspectMembersAll('x.md', empty).diagnostics, 'members.field.empty').length === 1)

    const duplicate = withNote.replace('备注：Linux 成员', '备注：Linux 成员\n备注：Windows 成员')
    assert.ok(rules(inspectMembersAll('x.md', duplicate).diagnostics, 'members.field.duplicate').length === 1)

    const order = `# 主对话
身份：开发
工作范围：实现
# 成员1
工作区名称：coder
身份：验证
备注：提前
工作范围：验证
`
    assert.ok(rules(inspectMembersAll('x.md', order).diagnostics, 'members.field.order').length === 1)

    const mainNote = `# 主对话
身份：开发
工作范围：实现
备注：主对话没有备注
`
    assert.ok(rules(inspectMembersAll('x.md', mainNote).diagnostics, 'members.field.unexpected').length === 1)
  })

  it('前导正文、二级标题和未闭合围栏都会被诊断', () => {
    const preamble = `前言
# 主对话
身份：开发
工作范围：实现
`
    assert.ok(rules(inspectMembersAll('x.md', preamble).diagnostics, 'members.preamble').length === 1)

    const heading = `# 主对话
身份：开发
工作范围：实现
## 细节
说明
`
    assert.ok(rules(inspectMembersAll('x.md', heading).diagnostics, 'members.heading.level').length === 1)

    const unclosed = `# 主对话
身份：开发
工作范围：实现
\`\`\`mermaid
flowchart TD
`
    assert.ok(rules(inspectMembersAll('x.md', unclosed).diagnostics, 'markdown.unclosed-fence').length === 1)
  })

  it('接受半角冒号', () => {
    const text = `# 主对话
身份: 开发
工作范围: 实现
`
    assert.deepEqual(inspectMembersAll('x.md', text).diagnostics, [])
  })
})

describe('members/flow.md', () => {
  it('场景和 Mermaid 图齐全时通过', () => {
    assert.deepEqual(inspectMembersFlow('.coder/members/flow.md', MEMBERS_FLOW_OK).diagnostics, [])
  })

  it('缺少场景或缺少 Mermaid 图时报错', () => {
    assert.ok(rules(inspectMembersFlow('x.md', '').diagnostics, 'flow.no-scenario').length === 1)
    assert.ok(
      rules(inspectMembersFlow('x.md', '## 分派任务\n只有说明。\n').diagnostics, 'flow.scenario.no-diagram').length === 1,
    )
  })

  it('空的 Mermaid 图和未闭合围栏都会被诊断', () => {
    const empty = `## 分派任务
\`\`\`mermaid
\`\`\`
`
    assert.ok(rules(inspectMembersFlow('x.md', empty).diagnostics, 'flow.diagram.empty').length === 1)

    const unclosed = `## 分派任务
\`\`\`mermaid
flowchart TD
`
    assert.ok(rules(inspectMembersFlow('x.md', unclosed).diagnostics, 'markdown.unclosed-fence').length === 1)
  })
})

describe('member document kinds', () => {
  it('识别两个固定的成员文档路径', () => {
    assert.equal(memberKindOf(MEMBERS_ALL), 'members-all')
    assert.equal(memberKindOf(MEMBERS_FLOW), 'members-flow')
    assert.equal(memberKindOf('design/flow.md'), null)
    assert.equal(isMemberDoc(MEMBERS_ALL), true)
    assert.equal(isMemberDoc(MEMBERS_FLOW), true)
    assert.equal(isMemberDoc('members/other.md'), false)
  })
})

describe('members in list', () => {
  it('成员文档是可选文档，存在时检查且不报缺失', async () => {
    const root = writeTree({
      '.coder/members/all.md': MEMBERS_ALL_OK,
      '.coder/members/flow.md': MEMBERS_FLOW_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.expected, 7)
    assert.equal(report.summary.found, 7)
    assert.equal(report.summary.optional, 2)
    assert.deepEqual(report.illegal, [])
    assert.deepEqual(report.missing, [])
    assert.deepEqual(report.diagnostics, [])
    const statuses = new Map(report.documents.map((document) => [document.path, document.status]))
    assert.equal(statuses.get('.coder/members/all.md'), 'optional')
    assert.equal(statuses.get('.coder/members/flow.md'), 'optional')
    assert.match(report.text, /可选 2/)
    assert.doesNotMatch(report.text, /文档：\n  \[/)
  })

  it('只有主对话、没有成员时也是合法可选文档', async () => {
    const root = writeTree({
      '.coder/members/all.md': '# 主对话\n身份：开发\n工作范围：实现\n',
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.optional, 1)
    assert.deepEqual(report.missing, [])
    assert.deepEqual(report.diagnostics, [])
  })

  it('只存在其中一个时不要求另一个', async () => {
    const root = writeTree({ '.coder/members/all.md': MEMBERS_ALL_OK })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.optional, 1)
    assert.deepEqual(report.missing, [])
  })

  it('内容不合法时报诊断但不报非法文档', async () => {
    const root = writeTree({ '.coder/members/all.md': '# 成员1\n工作区名称：coder\n' })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, false)
    assert.deepEqual(report.illegal, [])
    assert.deepEqual(report.missing, [])
    assert.ok(rules(report.diagnostics, 'members.main.missing').length >= 1)
    assert.ok(rules(report.diagnostics, 'members.field.missing').length >= 1)
  })
})

describe('render members', () => {
  it('存在的成员文档进入页面', async () => {
    const root = writeTree({
      '.coder/members/all.md': MEMBERS_ALL_OK,
      '.coder/members/flow.md': MEMBERS_FLOW_OK,
    })
    const result = await renderDesign({ root })
    assert.equal(result.healthy, true)
    assert.match(result.text, /成员 2/)
    const html = readFileSync(result.output, 'utf8')
    assert.match(html, /\.coder\/members\/all\.md/)
    assert.match(html, /\.coder\/members\/flow\.md/)
    assert.match(html, /身份：开发/)
    assert.match(html, /备注：Linux 成员，SSH 用户 root/)
    assert.match(html, /成员流程/)
    assert.match(html, /href="#members-all"/)
    assert.match(html, /href="#members-flow"/)
  })

  it('没有成员文档时不生成成员区块', async () => {
    const root = writeTree({})
    const result = await renderDesign({ root })
    assert.equal(result.healthy, true)
    assert.match(result.text, /成员 0/)
    const html = readFileSync(result.output, 'utf8')
    assert.doesNotMatch(html, /\.coder\/members\//)
    assert.equal(existsSync(join(root, '.coder', 'members')), false)
  })
})
