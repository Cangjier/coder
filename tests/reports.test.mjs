import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { isRunId, readLatest, readRun } from '../src/reports.mjs'
import { tempDir } from './helpers.mjs'

/**
 * 一条诊断行（字段照 flow.mjs 写出来的那样）。
 *
 * @param {number} id
 * @param {string} code
 * @param {string} severity
 * @param {object} [extra]
 * @returns {object}
 */
function row(id, code, severity, extra = {}) {
  return {
    id,
    code,
    severity,
    file: 'src/a.mjs',
    line: id,
    column: null,
    message: `第 ${id} 条`,
    source: 'static',
    steps: ['跑一次'],
    ...extra,
  }
}

/**
 * 造一次运行。
 *
 * @param {string} root
 * @param {string} runId
 * @param {{ summary?: object, lines?: Array<object>, codes?: Array<object>, raw?: string }} input
 * @returns {Promise<string>}
 */
async function seedRun(root, runId, input = {}) {
  const dir = path.join(root, '.coder', 'runs', runId)
  await fs.mkdir(dir, { recursive: true })
  if (input.raw !== undefined) {
    await fs.writeFile(path.join(dir, 'diagnostics.jsonl'), input.raw, 'utf8')
  } else if (input.lines) {
    await fs.writeFile(
      path.join(dir, 'diagnostics.jsonl'),
      `${input.lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    )
  }
  if (input.codes) {
    await fs.writeFile(
      path.join(dir, 'codes.jsonl'),
      `${input.codes.map((item) => JSON.stringify(item)).join('\n')}\n`,
      'utf8',
    )
  }
  if (input.summary) {
    await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(input.summary), 'utf8')
  }
  return dir
}

test('报告：只看最新那一次；没有 .coder/runs 就是 null，空目录不算', async () => {
  const root = await tempDir('coder-reports-')
  assert.equal(await readLatest(root), null, '还没有运行过')

  await seedRun(root, '20260101-080000-aaaaaa', { lines: [row(1, 'D001', 'error')] })
  await seedRun(root, '20260102-090000-bbbbbb', {
    lines: [row(1, 'Q001', 'info'), row(2, 'Q001', 'warning')],
    summary: {
      ok: true,
      change: { mode: 'all', base: null, head: 'abcdef123456', files: 12 },
      verification: { status: 'done', checked: 2, confirmed: 1, uncertain: 1, dropped: 0, rewritten: 0 },
    },
    codes: [{ code: 'Q001', kind: 'quality', severity: 'warning', rule: '必须使用结构化日志。', targets: [] }],
  })
  // 既没有摘要也没有诊断：不算一次运行
  await fs.mkdir(path.join(root, '.coder', 'runs', '20260103-100000-cccccc'), { recursive: true })

  const latest = await readLatest(root)
  assert.equal(latest.run.runId, '20260102-090000-bbbbbb', '名字最大的就是最新的')
  assert.equal(latest.run.startedAt, '2026-01-02 09:00:00')
  assert.deepEqual(latest.run.counts, { error: 0, warning: 1, info: 1 })
  assert.equal(latest.diagnostics.length, 2)
  assert.equal(latest.codes.length, 1, '带上这次用的码快照（页面拿它分组）')
  assert.equal(latest.codes[0].rule, '必须使用结构化日志。')
  assert.equal(latest.run.change.mode, 'all')
  assert.equal(latest.run.verification.confirmed, 1)
})

test('报告：读一次运行给出摘要与诊断行；坏行跳过，找不到的报 RUN_NOT_FOUND', async () => {
  const root = await tempDir('coder-reports-')
  await seedRun(root, '20260101-080000-aaaaaa', {
    raw: `${JSON.stringify(row(1, 'D001', 'error'))}\n坏行不是 JSON\n\n${JSON.stringify(row(2, 'Q001', 'warning'))}\n`,
    summary: { ok: true, change: { mode: 'range', base: '111111', head: '222222', files: 3 } },
  })

  const { run, diagnostics } = await readRun(root, '20260101-080000-aaaaaa')
  assert.equal(run.runId, '20260101-080000-aaaaaa')
  assert.equal(run.change.mode, 'range')
  assert.equal(diagnostics.length, 2, '坏行跳过，其余照读')
  assert.equal(diagnostics[0].code, 'D001')
  assert.deepEqual(diagnostics[0].steps, ['跑一次'])

  await assert.rejects(() => readRun(root, '20260109-000000-zzzzzz'), { code: 'RUN_NOT_FOUND' })
  await assert.rejects(() => readRun(root, '..\\..\\etc'), { code: 'RUN_NOT_FOUND' })
})

test('报告：runId 只收字母数字和连字符，不能拼出路径', () => {
  assert.equal(isRunId('20260101-080000-aaaaaa'), true)
  assert.equal(isRunId('abc'), true)
  assert.equal(isRunId('../x'), false)
  assert.equal(isRunId('a/b'), false)
  assert.equal(isRunId('a\\b'), false)
  assert.equal(isRunId('-lead'), false)
  assert.equal(isRunId(''), false)
  assert.equal(isRunId('x'.repeat(80)), false)
})
