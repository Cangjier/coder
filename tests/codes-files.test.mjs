import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { isCodesRel, readCodes, saveCodes, scanCodesFiles } from '../src/codes-files.mjs'
import { tempDir } from './helpers.mjs'

const ROW = (over = {}) => ({
  code: 'D001',
  check: 'runtime',
  enabled: true,
  severity: 'error',
  rule: '禁止直接使用 console。',
  detect: '运行期捕获 console 调用',
  targets: [],
  ...over,
})

test('扫描：只认 <任意>/docs/codes.jsonl，跳过依赖与输出目录', async () => {
  const root = await tempDir('coder-scan-')
  const write = async (rel) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), '', 'utf8')
  }
  await write('docs/codes.jsonl')
  await write('packages/a/docs/codes.jsonl')
  // 太深的目录不看（最多 4 层），免得巨仓库把页面拖死
  await write('packages/a/b/c/docs/codes.jsonl')
  await write('node_modules/pkg/docs/codes.jsonl')
  await write('.coder/runs/x/docs/codes.jsonl')
  await write('docs/nested/codes.jsonl')
  await write('docs/other.jsonl')

  assert.deepEqual(await scanCodesFiles(root), ['docs/codes.jsonl', 'packages/a/docs/codes.jsonl'])
})

test('读一份 codes.jsonl：行、校验问题、行号都带回来', async () => {
  const root = await tempDir('coder-read-')
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  const good = JSON.stringify(ROW())
  await fs.writeFile(path.join(root, 'docs', 'codes.jsonl'), `${good}\n{坏}\n`, 'utf8')

  const bad = await readCodes(root, 'docs/codes.jsonl')
  assert.equal(bad.status, 'bad')
  assert.equal(bad.rows.length, 1)
  assert.equal(bad.counts.total, 1)
  assert.equal(bad.problems[0].line, 2)

  await fs.writeFile(path.join(root, 'docs', 'codes.jsonl'), `${good}\n`, 'utf8')
  const ok = await readCodes(root, 'docs/codes.jsonl')
  assert.equal(ok.status, 'ok')
  assert.deepEqual(ok.rows[0].check, 'runtime')
  assert.equal('__line' in ok.rows[0], false)
})

test('保存：先校验后落盘，合法就原子写回、内容不变就不碰文件', async () => {
  const root = await tempDir('coder-save-')
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  const file = path.join(root, 'docs', 'codes.jsonl')

  const invalid = await saveCodes(root, 'docs/codes.jsonl', [ROW({ code: 'ZZZ' })])
  assert.equal(invalid.ok, false)
  assert.match(invalid.problems[0].message, /应形如/)
  assert.equal(await fs.stat(file).catch(() => null), null, '不合规时一个字节都不写')

  const saved = await saveCodes(root, 'docs/codes.jsonl', [ROW({ title: '旧字段' })])
  assert.equal(saved.ok, true)
  assert.equal(saved.changed, true)
  assert.deepEqual(saved.counts, { total: 1, debug: 1, quality: 0, static: 0, runtime: 1, disabled: 0 })
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /"check":"runtime"/)
  assert.ok(!text.includes('title'), '保存时把废弃字段清掉')

  const mtime = (await fs.stat(file)).mtimeMs
  const again = await saveCodes(root, 'docs/codes.jsonl', saved.rows)
  assert.equal(again.changed, false)
  assert.equal((await fs.stat(file)).mtimeMs, mtime)
})

test('位置守卫：只能是 docs/codes.jsonl，不许跳出工作区', () => {
  assert.equal(isCodesRel('docs/codes.jsonl'), true)
  assert.equal(isCodesRel('packages/a/docs/codes.jsonl'), true)
  assert.equal(isCodesRel('docs/codes.jsonl.bak'), false)
  assert.equal(isCodesRel('src/docs/codes.jsonl'), true)
  assert.equal(isCodesRel('../docs/codes.jsonl'), false)
  assert.equal(isCodesRel('/abs/docs/codes.jsonl'), false)
  assert.equal(isCodesRel('C:/x/docs/codes.jsonl'), false)
  assert.equal(isCodesRel('docs/rules.md'), false)
})
