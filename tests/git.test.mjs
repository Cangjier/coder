import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { fingerprint, resolveChange, treeFiles } from '../src/git.mjs'
import { isCoderArtifact } from '../src/codes.mjs'
import { makeRepo } from './helpers.mjs'

test('范围解析：commit / all / range 三种模式，根提交与空区间都报错', async () => {
  const { dir, head, base } = await makeRepo()

  const commit = await resolveChange(dir, { mode: 'commit', ref: 'HEAD' })
  assert.equal(commit.head, head)
  assert.equal(commit.base, base)
  assert.equal(commit.mode, 'commit')

  // 整仓模式：没有基线，head 是 HEAD（或指定的那个提交）
  const all = await resolveChange(dir)
  assert.equal(all.mode, 'all')
  assert.equal(all.base, null, '整仓模式没有「父提交」这个概念')
  assert.equal(all.head, head)
  assert.equal(all.ref, 'HEAD')
  const atBase = await resolveChange(dir, { mode: 'all', ref: base })
  assert.equal(atBase.base, null)
  assert.equal(atBase.head, base)

  // 整仓模式列出全部文件，而不是差集；没有增删改状态
  const files = await treeFiles(dir, atBase.head)
  assert.deepEqual(
    files.map((item) => item.path).sort(),
    ['app.mjs', 'docs/guide.md', 'docs/rules.md', 'node_modules/pkg/docs/x.md', 'src/a.mjs', 'srcx/b.mjs'],
    '整仓模式列出全部文件',
  )
  assert.ok(files.every((item) => item.status === 'all'), '整仓模式没有增删改状态')

  const range = await resolveChange(dir, { mode: 'range', from: base, to: head })
  assert.equal(range.base, base)
  assert.equal(range.head, head)
  assert.equal(range.ref, `${base}..${head}`)

  // 点名的提交是根提交时，没有父提交可当基线
  const first = execFileSync('git', ['-C', dir, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim()
  await assert.rejects(() => resolveChange(dir, { mode: 'commit', ref: first }), /整仓模式/)
  await assert.rejects(() => resolveChange(dir, { mode: 'range', from: head, to: head }), /没有改动/)
  await assert.rejects(() => resolveChange(dir, { mode: 'uncommitted' }), /只接受 commit \/ range \/ all/)
})

test('指纹：工作区改动会变，排除 .coder 与插件写进 docs 的文件', async () => {
  const { dir } = await makeRepo()

  // ① 工作区改动
  const before = await fingerprint(dir)
  await fs.writeFile(path.join(dir, 'src', 'a.mjs'), 'export const value = 3\n', 'utf8')
  assert.notEqual(await fingerprint(dir), before)

  // ② 排除插件自己的输出目录
  const excluded = { exclude: ['.coder'] }
  const clean = await fingerprint(dir, excluded)
  await fs.mkdir(path.join(dir, '.coder', 'runs'), { recursive: true })
  await fs.writeFile(path.join(dir, '.coder', 'runs', 'x.json'), '{}\n', 'utf8')
  assert.equal(await fingerprint(dir, excluded), clean)

  // ③ 跳过插件写进 docs 的 codes.jsonl（含写入中的临时文件），其他改动照样看得见
  const options = { exclude: ['.coder'], skip: isCoderArtifact }
  await fs.writeFile(path.join(dir, 'docs', 'codes.jsonl'), '{}\n', 'utf8')
  await fs.writeFile(path.join(dir, 'docs', 'codes.jsonl.1.2.tmp'), '{}\n', 'utf8')
  assert.equal(await fingerprint(dir, options), clean, '这是插件自己的文件')
  await fs.writeFile(path.join(dir, 'docs', 'rules.md'), '# 改了\n', 'utf8')
  assert.notEqual(await fingerprint(dir, options), clean, '别的改动不能被一起跳过')

  // 编辑页已经不由插件生成：仓库里剩的那份是普通文件，改了也算源仓库变了
  const beforePage = await fingerprint(dir, options)
  await fs.writeFile(path.join(dir, 'docs', 'codes-editor.html'), '<!doctype html>\n', 'utf8')
  assert.notEqual(await fingerprint(dir, options), beforePage)
})
