/**
 * 文档扫描与格式诊断的行为测试。
 *
 * 这一层只测 `src/docs.js` 的公开行为：给一棵真的目录树，报告必须与
 * `docs/design.md` 的格式约定一致。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { DOCS_DIR, EXPECTED_DOCS, fileCoverage, inspectDocs, validateDocument } from '../src/docs.js'

const FILE_OK = `# src
源代码目录
## src/main.ts
功能入口
# docs
文档目录
# tmp
临时文件目录
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
flowchart TD
  A[读取 .coder/] --> B[诊断格式]
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
诊断条目。
\`\`\`ts
export interface Diagnostic {
  doc: string
  line: number
}
\`\`\`
## 检查报告
检查结果。
\`\`\`ts
export interface Report {
  ok: boolean
  diagnostics: Diagnostic[]
}
\`\`\`
`

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-docs-'))
})

after(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * 在临时目录里写一棵文档树。
 * @param {Record<string, string>} files - 相对于临时根的路径到内容。
 * @returns {string} 临时根目录。
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
 * 写一份默认齐全且合法的文档树。
 * @returns {string} 临时根目录。
 */
function writeValidTree() {
  return writeTree({
    '.coder/design/file.md': FILE_OK,
    '.coder/design/architecture.md': ARCHITECTURE_OK,
    '.coder/design/flow.md': FLOW_OK,
    '.coder/design/data_structure.md': DATA_OK,
    '.coder/diagnosis/error.md': ERROR_OK,
    '.coder/diagnosis/warn.md': WARN_OK,
  })
}

/**
 * 跑一次检查。
 * @param {string} root - 项目根目录。
 * @returns {Promise<object>} 报告。
 */
function inspect(root) {
  return inspectDocs({ root })
}

/** 取出某条规则的全部诊断。 */
function rules(report, rule) {
  return report.diagnostics.filter((item) => item.rule === rule)
}

describe('inspectDocs', () => {
  it('齐全且合法的文档树返回 ok:true', async () => {
    const report = await inspect(writeValidTree())
    assert.equal(report.ok, true)
    assert.equal(report.docsRootExists, true)
    assert.deepEqual(report.illegal, [])
    assert.deepEqual(report.missing, [])
    assert.deepEqual(report.diagnostics, [])
    assert.equal(report.summary.expected, 6)
    assert.equal(report.summary.found, 6)
    assert.match(report.text, /所有文档齐全且格式正确/)
  })

  it('把预期之外的文档标为非法文档', async () => {
    const report = await inspect(
      writeTree({
        '.coder/design/file.md': FILE_OK,
        '.coder/design/architecture.md': ARCHITECTURE_OK,
        '.coder/design/flow.md': FLOW_OK,
        '.coder/design/data_structure.md': DATA_OK,
        '.coder/diagnosis/error.md': ERROR_OK,
        '.coder/diagnosis/warn.md': WARN_OK,
        '.coder/design/extra.md': '# extra\n多余文档\n',
        '.coder/design/notes.txt': 'not markdown',
      }),
    )
    assert.equal(report.ok, false)
    assert.deepEqual(report.illegal, ['.coder/design/extra.md', '.coder/design/notes.txt'])
    const statuses = new Map(report.documents.map((document) => [document.path, document.status]))
    assert.equal(statuses.get('.coder/design/extra.md'), 'illegal')
    assert.equal(statuses.get('.coder/design/notes.txt'), 'illegal')
    assert.equal(report.diagnostics.length, 0)
  })

  it('列出缺失的预期文档', async () => {
    const root = writeTree({
      '.coder/design/file.md': FILE_OK,
      '.coder/design/architecture.md': ARCHITECTURE_OK,
      '.coder/design/data_structure.md': DATA_OK,
      '.coder/diagnosis/error.md': ERROR_OK,
      '.coder/diagnosis/warn.md': WARN_OK,
    })
    const report = await inspect(root)
    assert.equal(report.ok, false)
    assert.deepEqual(report.missing, ['.coder/design/flow.md'])
    const missing = report.documents.find((document) => document.status === 'missing')
    assert.equal(missing.path, '.coder/design/flow.md')
  })

  it('docs 目录不存在时把全部预期文档列为缺失', async () => {
    const root = mkdtempSync(join(tempRoot, 'empty-'))
    const report = await inspect(root)
    assert.equal(report.docsRootExists, false)
    assert.equal(report.missing.length, 6)
    assert.equal(report.ok, false)
    assert.match(report.text, /不存在/)
  })

  it('root 不存在时抛错', async () => {
    await assert.rejects(
      () => inspect(join(tempRoot, 'does-not-exist')),
      /项目根目录不存在/,
    )
  })

  it('检查项目文件是否被 file.md 覆盖', async () => {
    const root = writeTree({
      '.coder/design/file.md': '# README.md\n项目说明\n',
      '.coder/design/architecture.md': ARCHITECTURE_OK,
      '.coder/design/flow.md': FLOW_OK,
      '.coder/design/data_structure.md': DATA_OK,
      '.coder/diagnosis/error.md': ERROR_OK,
      '.coder/diagnosis/warn.md': WARN_OK,
      'README.md': '# hello\n',
      'extra.txt': 'x',
    })
    const report = await inspect(root)
    assert.ok(
      report.diagnostics.some(
        (item) => item.rule === 'file.coverage.missing' && /extra\.txt/.test(item.message),
      ),
    )
    assert.equal(report.diagnostics.filter((item) => item.rule === 'file.coverage.missing').length, 1)
  })
})

describe('file.md 覆盖检查', () => {
  it('通配覆盖所有文件时没有诊断', () => {
    const text = `# src/**
源码目录
# README.md
说明
# tmp/**
临时目录及文件
`
    const files = ['src/main.ts', 'src/lib/a.ts', 'README.md', 'tmp/a.txt', 'tmp/cache/b.bin']
    assert.deepEqual(fileCoverage(text, files), [])
  })

  it('未覆盖的文件逐条报出', () => {
    const text = `# src/**
源码目录
`
    const report = fileCoverage(text, ['src/main.ts', 'README.md', 'tmp/a.txt'])
    assert.equal(report.length, 2)
    assert.ok(report.every((item) => item.rule === 'file.coverage.missing'))
    const messages = report.map((item) => item.message).join('\n')
    assert.match(messages, /README\.md/)
    assert.match(messages, /tmp\/a\.txt/)
  })

  it('tmp/** 同时覆盖目录和文件', () => {
    assert.deepEqual(fileCoverage('# tmp/**\n临时目录及文件\n', ['tmp/a.txt', 'tmp/cache/b.bin']), [])
  })

  it('只写 tmp 不覆盖它下面的文件', () => {
    const report = fileCoverage('# tmp\n临时目录\n', ['tmp/a.txt'])
    assert.equal(report.length, 1)
    assert.equal(report[0].rule, 'file.coverage.missing')
  })

  it('.coder 自身及其内容不要求描述', () => {
    const files = ['.coder/design/file.md', '.coder/design/architecture.md', 'README.md']
    assert.deepEqual(fileCoverage('# README.md\n说明\n', files), [])
  })
})

describe('file.md 诊断', () => {
  it('拒绝绝对路径、重复路径、空说明和反向表述', () => {
    const text = `# /src
源码
# src
源码
# src
源码
# docs
不要依赖外部网络
`
    const report = validateDocument('.coder/design/file.md', text, 'file')
    assert.ok(report.some((item) => item.rule === 'file.path.absolute'))
    assert.ok(report.some((item) => item.rule === 'file.path.duplicate'))
    assert.ok(report.some((item) => item.rule === 'file.description.negated'))
  })

  it('路径非法时仍然诊断它的说明', () => {
    const report = validateDocument('.coder/design/file.md', '# /src\n不要依赖外部网络\n', 'file')
    assert.ok(report.some((item) => item.rule === 'file.path.absolute'))
    assert.ok(report.some((item) => item.rule === 'file.description.negated'))
  })

  it('标题后没有直属说明时报错', () => {
    const text = `# src
## src/main.ts
功能入口
`
    const report = validateDocument('.coder/design/file.md', text, 'file')
    assert.ok(report.some((item) => item.rule === 'file.description.missing'))
  })

  it('二级标题的父路径必须先以一级标题出现', () => {
    const text = `# src
源码
## lib/util.ts
工具
`
    const report = validateDocument('.coder/design/file.md', text, 'file')
    assert.ok(report.some((item) => item.rule === 'file.parent.missing'))
  })

  it('拒绝三级标题和 .. 路径', () => {
    const text = `# src
源码
### src/main.ts
入口
# ../outside
外部
`
    const report = validateDocument('.coder/design/file.md', text, 'file')
    assert.ok(report.some((item) => item.rule === 'file.heading.level'))
    assert.ok(report.some((item) => item.rule === 'file.path.traversal'))
  })

  it('描述 .coder 时报错', () => {
    const text = `# .coder
自我文档
## .coder/design/file.md
定义
`
    const report = validateDocument('.coder/design/file.md', text, 'file')
    assert.equal(report.filter((item) => item.rule === 'file.entry.coder').length, 2)
  })
})

describe('architecture.md 诊断', () => {
  it('多视角架构图通过', () => {
    const report = validateDocument('.coder/design/architecture.md', ARCHITECTURE_OK, 'architecture')
    assert.deepEqual(report, [])
  })

  it('缺少视角时报错', () => {
    const report = validateDocument('.coder/design/architecture.md', '# 架构\n', 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.no-view'))
  })

  it('缺少全局视角时报错', () => {
    const text = `## 局部视角：扫描
说明
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.global.missing'))
  })

  it('全局视角不是第一个时报错', () => {
    const text = `## 局部视角：扫描
说明
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
## 全局视角
说明
\`\`\`mermaid
flowchart TB
  subgraph 宿主层
    A[Host]
  end
\`\`\`
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.view.order'))
  })

  it('缺少局部视角时报错', () => {
    const text = `## 全局视角
说明
\`\`\`mermaid
flowchart TB
  subgraph 宿主层
    A[Host]
  end
\`\`\`
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.local.missing'))
  })

  it('视角没有说明时报错', () => {
    const text = `## 全局视角
\`\`\`mermaid
flowchart TB
  subgraph 宿主层
    A[Host]
  end
\`\`\`
## 局部视角：扫描
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.view.description.missing'))
  })

  it('视角缺少图时报错', () => {
    const text = `## 全局视角
说明
## 局部视角：扫描
说明
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.view.diagram.missing'))
  })

  it('全局视角缺少 subgraph 时报错', () => {
    const text = `## 全局视角
说明
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
## 局部视角：扫描
说明
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.global.no-subgraph'))
  })

  it('图类型不是 flowchart/graph 时报错', () => {
    const text = `## 全局视角
说明
\`\`\`mermaid
flowchart TB
  subgraph 宿主层
    A[Host]
  end
\`\`\`
## 局部视角：扫描
说明
\`\`\`mermaid
sequenceDiagram
  A->>B: 请求
\`\`\`
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.diagram.type'))
  })

  it('一个视角多张图时报错', () => {
    const text = `## 全局视角
说明
\`\`\`mermaid
flowchart TB
  subgraph 宿主层
    A[Host]
  end
\`\`\`
## 局部视角：扫描
说明
\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
\`\`\`mermaid
flowchart LR
  B --> C
\`\`\`
`
    const report = validateDocument('.coder/design/architecture.md', text, 'architecture')
    assert.ok(report.some((item) => item.rule === 'architecture.view.diagram.multiple'))
  })
})

describe('flow.md 诊断', () => {
  it('缺少场景时报错', () => {
    const report = validateDocument('.coder/design/flow.md', '# 流程\n', 'flow')
    assert.ok(report.some((item) => item.rule === 'flow.no-scenario'))
  })

  it('场景缺少 mermaid 图时报错', () => {
    const text = `## 检查文档
先读文件。
`
    const report = validateDocument('.coder/design/flow.md', text, 'flow')
    assert.ok(report.some((item) => item.rule === 'flow.scenario.no-diagram'))
  })

  it('空的 mermaid 代码块和未闭合围栏都会被诊断', () => {
    const empty = `## 检查文档
\`\`\`mermaid
\`\`\`
`
    const emptyReport = validateDocument('.coder/design/flow.md', empty, 'flow')
    assert.ok(emptyReport.some((item) => item.rule === 'flow.diagram.empty'))

    const unclosed = `## 检查文档
\`\`\`mermaid
flowchart TD
`
    const unclosedReport = validateDocument('.coder/design/flow.md', unclosed, 'flow')
    assert.ok(unclosedReport.some((item) => item.rule === 'markdown.unclosed-fence'))
  })
})

describe('data_structure.md 诊断', () => {
  it('关键结构用 ts interface 表达时通过', () => {
    const report = validateDocument('.coder/design/data_structure.md', DATA_OK, 'data')
    assert.deepEqual(report, [])
  })

  it('没有分段时报错', () => {
    const report = validateDocument('.coder/design/data_structure.md', '# 数据结构\n说明\n', 'data')
    assert.ok(report.some((item) => item.rule === 'data.no-section'))
  })

  it('分段缺少 ts 围栏时报错', () => {
    const text = `## 诊断
说明
\`\`\`json
{}
\`\`\`
`
    const report = validateDocument('.coder/design/data_structure.md', text, 'data')
    assert.ok(report.some((item) => item.rule === 'data.section.no-ts'))
  })

  it('空的 ts 围栏时报错', () => {
    const text = `## 诊断
\`\`\`ts
\`\`\`
`
    const report = validateDocument('.coder/design/data_structure.md', text, 'data')
    assert.ok(report.some((item) => item.rule === 'data.ts.empty'))
  })

  it('ts 围栏里没有 interface 时报错', () => {
    const text = `## 诊断
\`\`\`ts
export type Severity = 'error'
\`\`\`
`
    const report = validateDocument('.coder/design/data_structure.md', text, 'data')
    assert.ok(report.some((item) => item.rule === 'data.interface.missing'))
  })

  it('interface 重名时报错', () => {
    const text = `## 诊断
\`\`\`ts
export interface Diagnostic {
  doc: string
}
\`\`\`
## 报告
\`\`\`ts
export interface Diagnostic {
  line: number
}
\`\`\`
`
    const report = validateDocument('.coder/design/data_structure.md', text, 'data')
    assert.ok(report.some((item) => item.rule === 'data.interface.duplicate'))
  })

  it('接受 typescript 语言标记', () => {
    const text = `## 诊断
\`\`\`typescript
export interface Diagnostic {
  doc: string
}
\`\`\`
`
    const report = validateDocument('.coder/design/data_structure.md', text, 'data')
    assert.deepEqual(report, [])
  })
})

describe('fixed document set', () => {
  it('文档目录与预期文档是固化的', () => {
    assert.equal(DOCS_DIR, '.coder')
    assert.deepEqual([...EXPECTED_DOCS], [
    'design/file.md',
    'design/architecture.md',
    'design/flow.md',
    'design/data_structure.md',
    'diagnosis/error.md',
    'diagnosis/warn.md',
  ])
  })
})
