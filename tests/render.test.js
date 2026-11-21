/**
 * HTML 渲染的行为测试：默认路径、覆盖路径、文档内容嵌入、缺失文档和确定性。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { renderDesign } from '../src/render.js'
import { createLockTool } from '../src/tools/lock.js'

const FILE_OK = `# src
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
## 诊断
诊断条目。
\`\`\`ts
export interface Diagnostic {
  doc: string
  line: number
}
\`\`\`
`

let tempRoot

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coder-render-'))
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
  writeFileSync(join(root, '.coder', 'design', 'file.md'), FILE_OK)
  writeFileSync(join(root, '.coder', 'design', 'architecture.md'), ARCHITECTURE_OK)
  writeFileSync(join(root, '.coder', 'design', 'flow.md'), FLOW_OK)
  writeFileSync(join(root, '.coder', 'design', 'data_structure.md'), DATA_OK)
  return root
}

describe('renderDesign', () => {
  it('默认写到 dist/.coder/design.html 并内嵌文档', async () => {
    const root = writeProject()
    const result = await renderDesign({ root })
    assert.equal(result.ok, true)
    assert.equal(result.output, join(root, 'dist', '.coder', 'design.html'))
    assert.equal(result.healthy, true)
    assert.equal(result.summary.found, 4)
    assert.ok(existsSync(result.output))

    const html = readFileSync(result.output, 'utf8')
    assert.match(html, /<title>Coder Design<\/title>/)
    assert.match(html, /marked@15/)
    assert.match(html, /mermaid@11/)
    assert.match(html, /flowchart TB/)
    assert.match(html, /"docs"/)
    assert.match(html, /file-tree/)
    assert.match(html, /tree-toggle/)
    assert.match(html, /tree-guide/)
    assert.match(html, /scrollTo/)
    assert.match(html, /nav-title/)
    assert.match(html, /目录/)
    assert.doesNotMatch(html, /side-note|class="status"|class="footer"|class="subtitle"/)
    assert.match(html, /\.coder\/design\/file\.md/)
    assert.match(html, /\.coder\/design\/data_structure\.md/)
    assert.match(html, /interface Diagnostic/)
  })

  it('同样的文档生成同样的 HTML', async () => {
    const first = writeProject('same-a')
    const second = writeProject('same-b')
    const firstResult = await renderDesign({ root: first })
    const secondResult = await renderDesign({ root: second })
    assert.equal(readFileSync(firstResult.output, 'utf8'), readFileSync(secondResult.output, 'utf8'))
  })

  it('out 参数改变输出目录', async () => {
    const root = writeProject()
    const result = await renderDesign({ root, outDir: 'build/docs' })
    assert.equal(result.output, join(root, 'build', 'docs', 'design.html'))
    assert.ok(existsSync(result.output))
  })

  it('缺失文档时仍然生成页面并标记缺失', async () => {
    const root = writeProject()
    rmSync(join(root, '.coder', 'design', 'flow.md'))
    const result = await renderDesign({ root })
    assert.equal(result.ok, true)
    assert.equal(result.healthy, false)
    assert.deepEqual(result.missing, ['.coder/design/flow.md'])
    const html = readFileSync(result.output, 'utf8')
    assert.match(html, /"present":false/)
    assert.match(html, /doc-missing/)
  })

  it('lock.md 不渲染，也不进入页面数据', async () => {
    const root = writeProject()
    await createLockTool({ info: () => {}, error: () => {} }).execute(
      { root, authorization: '渲染时忽略锁' },
      { cwd: root },
    )
    const result = await renderDesign({ root })
    const html = readFileSync(result.output, 'utf8')
    assert.equal(result.healthy, true)
    assert.equal(result.summary.locked, true)
    assert.doesNotMatch(html, /lock\.md/)
  })

  it('root 不存在时抛错', async () => {
    await assert.rejects(() => renderDesign({ root: join(tempRoot, 'nope') }), /项目根目录不存在/)
  })
})
