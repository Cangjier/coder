import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  isRunId,
  normalizeSolutions,
  readLatestSolutions,
  readSolutions,
  saveSolutions,
} from '../src/solutions.mjs'
import { tempDir } from './helpers.mjs'

/**
 * 造一次运行的目录（solutions.jsonl 由被测代码写）。
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

test('方案：字段裁空白、id 按顺序给、风险与把握有默认值，空的丢掉', () => {
  const { solutions, problems } = normalizeSolutions([
    { code: ' D001 ', title: '  改成 log()  ', problem: ' 直接 console ', fix: ' 用 log ', files: [' a.mjs ', ''], risk: 'LOW', confidence: 'HIGH' },
    { title: '', problem: '', fix: '' },
    '不是对象',
    { fix: '只有方案\n第二行' },
  ])
  assert.equal(solutions.length, 2, '空的那条与不是对象的被丢掉')
  assert.deepEqual(solutions.map((item) => item.id), [1, 2])
  assert.equal(solutions[0].code, 'D001')
  assert.equal(solutions[0].title, '改成 log()')
  assert.deepEqual([...solutions[0].files], ['a.mjs'], '文件去空白、去空串')
  assert.equal(solutions[0].risk, 'low', '大小写归一')
  assert.equal(solutions[0].confidence, 'high')
  assert.equal(solutions[1].title, '只有方案', '没标题就拿方案第一行当标题')
  assert.equal(solutions[1].risk, 'medium', '默认风险')
  assert.equal(problems.length, 2)
})

test('方案：写进运行目录、读回来；没有这次运行就报 RUN_NOT_FOUND', async () => {
  const root = await tempDir('coder-solutions-')
  await seedRun(root, '20260101-080000-aaaaaa')

  const saved = await saveSolutions(root, '20260101-080000-aaaaaa', [
    { code: 'D001', title: '改成结构化日志', problem: '直接用了 console', fix: '换成 log()', files: ['src/a.mjs'], risk: 'low', confidence: 'high' },
  ])
  assert.equal(saved.solutions.length, 1)
  const text = await fs.readFile(path.join(root, '.coder', 'runs', '20260101-080000-aaaaaa', 'solutions.jsonl'), 'utf8')
  assert.match(text, /"title":"改成结构化日志"/)
  assert.equal(text.trim().split('\n').length, 1, '一条一行')

  const read = await readSolutions(root, '20260101-080000-aaaaaa')
  assert.equal(read.length, 1)
  assert.equal(read[0].title, '改成结构化日志')
  assert.deepEqual([...read[0].files], ['src/a.mjs'])

  await assert.rejects(
    () => saveSolutions(root, '20260109-000000-zzzzzz', [{ title: 'x', fix: 'y' }]),
    { code: 'RUN_NOT_FOUND' },
  )
  await assert.rejects(() => saveSolutions(root, '..\\x', [{ title: 'x' }]), { code: 'RUN_NOT_FOUND' })
})

test('方案：只读最新一次有方案的运行；老数据缺 id 按位置补', async () => {
  const root = await tempDir('coder-solutions-')
  assert.equal(await readLatestSolutions(root), null, '什么都没有时是 null')

  await seedRun(root, '20260101-080000-aaaaaa')
  await saveSolutions(root, '20260101-080000-aaaaaa', [{ title: '旧的', fix: 'a' }])

  await seedRun(root, '20260102-090000-bbbbbb')
  const newer = path.join(root, '.coder', 'runs', '20260102-090000-bbbbbb')
  await fs.writeFile(
    path.join(newer, 'solutions.jsonl'),
    `${JSON.stringify({ title: '新的', fix: 'b' })}\n\n${JSON.stringify({ id: 7, title: '第二条', fix: 'c' })}\n`,
    'utf8',
  )

  const latest = await readLatestSolutions(root)
  assert.equal(latest.runId, '20260102-090000-bbbbbb')
  assert.deepEqual(latest.solutions.map((item) => item.id), [1, 7], '缺 id 的按位置补，已有的保留')

  // 最新那次没有方案文件时，回落到上一次有方案的
  await fs.rm(path.join(newer, 'solutions.jsonl'))
  const fallback = await readLatestSolutions(root)
  assert.equal(fallback.runId, '20260101-080000-aaaaaa')
})

test('方案：runId 只收字母数字和连字符', () => {
  assert.equal(isRunId('20260101-080000-aaaaaa'), true)
  assert.equal(isRunId('../x'), false)
  assert.equal(isRunId(''), false)
})
