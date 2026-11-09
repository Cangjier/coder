import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { docsHash, isDocPath, listDocs } from '../src/docs.mjs'
import { makeRepo } from './helpers.mjs'

test('文档扫描：只认 **/docs/*.md，跳过依赖目录，hash 覆盖全部内容，maxDocs 只截断列表', async () => {
  assert.equal(isDocPath('docs/a.md'), true)
  assert.equal(isDocPath('packages/x/docs/a.md'), true)
  assert.equal(isDocPath('docs/a.txt'), false)
  assert.equal(isDocPath('docs/sub/a.md'), false)
  assert.equal(isDocPath('a.md'), false)

  const { dir, run, head } = await makeRepo()
  const first = await listDocs(dir, head)
  assert.deepEqual(first.docs.map((item) => item.path), ['docs/guide.md', 'docs/rules.md'])
  assert.equal(first.total, 2)
  assert.equal(first.truncated, false)

  // 同一份提交：hash 稳定
  const second = await listDocs(dir, head)
  assert.equal(first.hash, second.hash)

  // maxDocs 只截断列表，不影响缓存键
  const limited = await listDocs(dir, head, { maxDocs: 1 })
  assert.equal(limited.docs.length, 1)
  assert.equal(limited.total, 2)
  assert.equal(limited.truncated, true)
  assert.equal(limited.hash, first.hash, '截断不应改变缓存键')

  // 文档变了：hash 跟着变
  await fs.writeFile(path.join(dir, 'docs', 'rules.md'), '# 新规则\n- 禁止 X。\n', 'utf8')
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'docs'])
  const third = await listDocs(dir, run(['rev-parse', 'HEAD']).trim())
  assert.notEqual(first.hash, third.hash)

  // docsHash 对路径与内容都敏感
  const a = docsHash([{ path: 'docs/a.md', sha: '1' }])
  assert.notEqual(a, docsHash([{ path: 'docs/a.md', sha: '2' }]))
  assert.notEqual(a, docsHash([{ path: 'docs/b.md', sha: '1' }]))
})
