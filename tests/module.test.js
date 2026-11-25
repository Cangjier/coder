/**
 * 模块索引与模块详情的行为测试。
 *
 * 覆盖 modules.md 的编码与说明、module-NNNN.md 的架构/流程/数据结构/子模块
 * 分段、可选的局部视角、索引与详情文件的交叉检查，以及 render 对模块文档的
 * 收录。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { inspectDocs } from '../src/docs.js'
import { inspectModule, inspectModules, validateModule } from '../src/module.js'
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

const MODULES_OK = `# 0001
文档检查模块

# 0002
工具模块
`

const MODULE_OK = `# 架构
## 全局视角
模块的全局结构。
\`\`\`mermaid
flowchart TB
  subgraph 层
    A[扫描]
    B[诊断]
  end
  A --> B
\`\`\`

# 流程
## 检查模块
模块如何检查。
\`\`\`mermaid
flowchart TD
  A[读取] --> B[诊断]
\`\`\`

# 数据结构
## 模块条目
模块的条目结构。
\`\`\`ts
export interface ModuleEntry {
  code: string
}
\`\`\`
`

const MODULE_WITH_SUBMODULE = `${MODULE_OK}
# 子模块
## 0002
子模块说明。
`

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-module-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 写一棵文档树；默认补齐十一份预期文档和一个项目文件。
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

describe('modules.md', () => {
  it('空索引合法', () => {
    assert.deepEqual(inspectModules('.coder/design/modules.md', '').diagnostics, [])
  })

  it('多个模块编码与说明通过', () => {
    const result = inspectModules('.coder/design/modules.md', MODULES_OK)
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(
      result.entries.map((entry) => entry.code),
      ['0001', '0002'],
    )
  })

  it('拒绝非法编码、重复编码和缺少说明', () => {
    assert.ok(
      inspectModules('x.md', '# 1\n说明\n').diagnostics.some((item) => item.rule === 'modules.code.format'),
    )
    assert.ok(
      inspectModules('x.md', '# 0001\n一\n# 0001\n二\n').diagnostics.some(
        (item) => item.rule === 'modules.code.duplicate',
      ),
    )
    assert.ok(
      inspectModules('x.md', '# 0001\n').diagnostics.some((item) => item.rule === 'modules.description.missing'),
    )
    assert.ok(
      inspectModules('x.md', '# 0001\n说明\n## 细节\n多余\n').diagnostics.some(
        (item) => item.rule === 'modules.heading.level',
      ),
    )
    assert.ok(
      inspectModules('x.md', `前言\n${MODULES_OK}`).diagnostics.some((item) => item.rule === 'module.preamble'),
    )
  })
})

describe('module-NNNN.md', () => {
  it('架构、流程、数据结构齐全时通过，局部视角可选', () => {
    const result = inspectModule('.coder/design/module-0001.md', MODULE_OK, '0001')
    assert.deepEqual(result.diagnostics, [])
    assert.deepEqual(result.submodules, [])
  })

  it('带子模块时解析出引用', () => {
    const result = inspectModule('.coder/design/module-0001.md', MODULE_WITH_SUBMODULE, '0001')
    assert.deepEqual(result.diagnostics, [])
    assert.equal(result.submodules.length, 1)
    assert.equal(result.submodules[0].code, '0002')
  })

  it('空文件、缺少一级段落和未知段落都会报错', () => {
    assert.ok(inspectModule('x.md', '', '0001').diagnostics.some((item) => item.rule === 'module.empty'))
    const missing = inspectModule('x.md', '# 架构\n## 全局视角\n说明\n', '0001').diagnostics
    assert.ok(missing.some((item) => item.rule === 'module.section.missing'))
    const unknown = inspectModule('x.md', `${MODULE_OK}\n# 备注\n多余\n`, '0001').diagnostics
    assert.ok(unknown.some((item) => item.rule === 'module.section.unknown'))
  })

  it('一级段落重复或顺序错误都会报错', () => {
    const duplicate = inspectModule(
      'x.md',
      `${MODULE_OK}\n# 架构\n## 全局视角\n说明\n`,
      '0001',
    ).diagnostics
    assert.ok(duplicate.some((item) => item.rule === 'module.section.duplicate'))

    const wrongOrder = `# 流程
## 检查
\`\`\`mermaid
flowchart TD
  A --> B
\`\`\`
# 架构
## 全局视角
说明
\`\`\`mermaid
flowchart TB
  subgraph 层
    A[Host]
  end
\`\`\`
# 数据结构
## 条目
\`\`\`ts
export interface Entry {
  code: string
}
\`\`\`
`
    assert.ok(
      inspectModule('x.md', wrongOrder, '0001').diagnostics.some((item) => item.rule === 'module.section.order'),
    )
  })

  it('复用架构、流程与数据结构的检查规则', () => {
    const noSubgraph = inspectModule(
      'x.md',
      MODULE_OK.replace('subgraph 层\n    A[扫描]\n    B[诊断]\n  end', 'A[扫描] --> B[诊断]'),
      '0001',
    ).diagnostics
    assert.ok(noSubgraph.some((item) => item.rule === 'architecture.global.no-subgraph'))

    const noDiagram = inspectModule(
      'x.md',
      MODULE_OK.replace(
        '模块如何检查。\n```mermaid\nflowchart TD\n  A[读取] --> B[诊断]\n```',
        '模块如何检查。',
      ),
      '0001',
    ).diagnostics
    assert.ok(noDiagram.some((item) => item.rule === 'flow.scenario.no-diagram'))

    const noInterface = inspectModule(
      'x.md',
      MODULE_OK.replace(
        '```ts\nexport interface ModuleEntry {\n  code: string\n}\n```',
        '```ts\nexport type ModuleEntry = string\n```',
      ),
      '0001',
    ).diagnostics
    assert.ok(noInterface.some((item) => item.rule === 'data.interface.missing'))
  })

  it('子模块编码、自引用、重复与说明都会被检查', () => {
    const format = inspectModule('x.md', `${MODULE_OK}\n# 子模块\n## 2\n说明\n`, '0001').diagnostics
    assert.ok(format.some((item) => item.rule === 'module.submodule.format'))

    const self = inspectModule('x.md', `${MODULE_OK}\n# 子模块\n## 0001\n自己\n`, '0001').diagnostics
    assert.ok(self.some((item) => item.rule === 'module.submodule.self'))

    const duplicate = inspectModule(
      'x.md',
      `${MODULE_OK}\n# 子模块\n## 0002\n一\n## 0002\n二\n`,
      '0001',
    ).diagnostics
    assert.ok(duplicate.some((item) => item.rule === 'module.submodule.duplicate'))

    const noDescription = inspectModule('x.md', `${MODULE_OK}\n# 子模块\n## 0002\n`, '0001').diagnostics
    assert.ok(noDescription.some((item) => item.rule === 'module.submodule.description'))

    const empty = inspectModule('x.md', `${MODULE_OK}\n# 子模块\n`, '0001').diagnostics
    assert.ok(empty.some((item) => item.rule === 'module.submodule.empty'))
  })
})

describe('modules in list', () => {
  it('索引与详情文件成对时通过，详情文件是可选状态', async () => {
    const root = writeTree({
      '.coder/design/modules.md': MODULES_OK,
      '.coder/design/module-0001.md': MODULE_OK,
      '.coder/design/module-0002.md': MODULE_OK,
    })
    const report = await inspectDocs({ root })
    assert.equal(report.ok, true)
    assert.equal(report.summary.expected, 11)
    assert.equal(report.summary.modules, 2)
    assert.equal(report.summary.moduleFiles, 2)
    assert.equal(report.summary.optional, 2)
    assert.match(report.text, /\[optional\] \.coder\/design\/module-0001\.md/)
  })

  it('索引登记但缺少详情、详情未登记、子模块缺失都会报错', async () => {
    const root = writeTree({
      '.coder/design/modules.md': MODULES_OK,
      '.coder/design/module-0001.md': MODULE_WITH_SUBMODULE,
    })
    const report = await inspectDocs({ root })
    assert.equal(rules(report, 'module.file.missing').length, 1)
    assert.equal(rules(report, 'module.submodule.missing').length, 1)

    const orphanRoot = writeTree({
      '.coder/design/module-0001.md': MODULE_OK,
    })
    const orphan = await inspectDocs({ root: orphanRoot })
    assert.equal(rules(orphan, 'module.index.missing').length, 1)
  })

  it('非法模块文件仍然报为非法文档', async () => {
    const root = writeTree({
      '.coder/design/module-1.md': MODULE_OK,
    })
    const report = await inspectDocs({ root })
    assert.deepEqual(report.illegal, ['.coder/design/module-1.md'])
  })
})

describe('render modules', () => {
  it('模块索引与存在的模块详情进入页面', async () => {
    const root = writeTree({
      '.coder/design/modules.md': MODULES_OK,
      '.coder/design/module-0001.md': MODULE_OK,
      '.coder/design/module-0002.md': MODULE_OK,
    })
    const result = await renderDesign({ root })
    const html = readFileSync(result.output, 'utf8')
    assert.match(html, /\.coder\/design\/modules\.md/)
    assert.match(html, /\.coder\/design\/module-0001\.md/)
    assert.match(html, /\.coder\/design\/module-0002\.md/)
    assert.match(html, /ModuleEntry/)
    assert.equal(result.healthy, true)
  })
})
