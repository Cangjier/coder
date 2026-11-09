import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createTriageTool } from '../src/tools/triage.mjs'
import { tempDir } from './helpers.mjs'

/**
 * 造一次运行的目录。
 *
 * @param {string} root
 * @param {string} runId
 * @returns {Promise<string>}
 */
async function seedRun(root, runId) {
  const dir = path.join(root, '.coder', 'runs', runId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test('coder_triage 工具：把方案写进这次运行目录，空方案与不存在的运行都拒绝', async () => {
  const root = await tempDir('coder-triage-')
  const runId = '20260101-080000-aaaaaa'
  await seedRun(root, runId)
  const tool = createTriageTool()

  const saved = await tool.execute({
    action: 'submit',
    repo: root,
    runId,
    solutions: [
      { code: 'D001', title: '改成结构化日志', problem: '直接用了 console', fix: '换成 log()', files: ['src/a.mjs'], risk: 'low', confidence: 'high' },
    ],
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.count, 1)
  assert.match(saved.file, /solutions\.jsonl$/)

  const text = await fs.readFile(path.join(root, '.coder', 'runs', runId, 'solutions.jsonl'), 'utf8')
  assert.match(text, /结构化日志/)

  const empty = await tool.execute({ action: 'submit', repo: root, runId, solutions: [] })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'BAD_ARGS')

  const missing = await tool.execute({
    action: 'submit',
    repo: root,
    runId: '20260109-000000-zzzzzz',
    solutions: [{ title: 'x', fix: 'y' }],
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NO_RUN')

  const noRepo = await tool.execute({ action: 'submit', runId, solutions: [{ title: 'x' }] })
  assert.equal(noRepo.ok, false)
  assert.equal(noRepo.code, 'BAD_ARGS')
})
