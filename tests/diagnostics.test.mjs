import assert from 'node:assert/strict'
import test from 'node:test'

import { dedupeEntries, formatTs, parseDiagnostics, parseQuality, sortEntries } from '../src/diagnostics.mjs'

test('解析 JSONL：坏行跳过，行号保留，severity 非法降级为 warning', () => {
  const text = [
    '{"code":"D001","severity":"error","file":"a.ts","line":3,"message":"x"}',
    'not json',
    '{"code":"D002","severity":"warning","file":"b.ts","line":1,"message":"y"}',
    '{"file":"a.ts","line":1}',
    '{"code":"D003","severity":"nope","file":"a.ts","line":1}',
  ].join('\n')
  const { entries, badLines } = parseDiagnostics(text)
  assert.equal(entries.length, 3)
  assert.equal(badLines, 2, '不是 JSON、缺 code 都算坏行')
  assert.deepEqual(entries.map((item) => item.logLine), [1, 3, 5])
  assert.equal(entries[2].severity, 'warning', '不认识的 severity 降级')
})

test('去重保留首次出现，排序按严重度', () => {
  const entries = [
    { code: 'D1', file: 'a', line: 2, message: 'm', severity: 'info', logLine: 1 },
    { code: 'D1', file: 'a', line: 2, message: 'm', severity: 'info', logLine: 2 },
    { code: 'D2', file: 'b', line: 1, message: 'n', severity: 'error', logLine: 3 },
  ]
  const unique = dedupeEntries(entries)
  assert.equal(unique.length, 2)
  assert.equal(sortEntries(unique)[0].code, 'D2')
})

test('tsc 风格格式化：带编号、复现步骤、复核结论时各多一行', () => {
  assert.equal(
    formatTs({ file: 'src/a.ts', line: 12, column: 5, severity: 'error', code: 'D001', message: '禁止 X' }),
    'src/a.ts(12,5): error D001: 禁止 X',
  )
  assert.equal(
    formatTs({ file: 'src/a.ts', line: null, severity: 'warning', code: 'D002', message: 'Y' }),
    'src/a.ts: warning D002: Y',
  )
  assert.equal(
    formatTs({ id: 3, file: 'src/a.ts', line: 1, severity: 'error', code: 'D003', message: 'Z' }),
    '#3 src/a.ts(1): error D003: Z',
  )
  assert.equal(
    formatTs({
      id: 1,
      file: 'src/a.ts',
      line: 4,
      severity: 'error',
      code: 'D001',
      message: '直接用了 console',
      steps: ['在仓库根执行 npm start', '访问 GET /health'],
    }),
    '#1 src/a.ts(4): error D001: 直接用了 console\n    复现：1) 在仓库根执行 npm start；2) 访问 GET /health',
  )
  assert.equal(
    formatTs({ id: 2, file: 'src/a.ts', line: 4, severity: 'error', code: 'D001', message: 'x', steps: [] }),
    '#2 src/a.ts(4): error D001: x',
    '空数组不该留一个空行',
  )
  assert.equal(
    formatTs({
      id: 4,
      file: 'src/a.ts',
      line: 4,
      severity: 'error',
      code: 'D001',
      message: 'x',
      steps: ['在仓库根执行 node app.mjs'],
      verification: 'confirmed',
      repro: 'rewritten',
      reproNote: '原步骤里的 npm start 不存在，改成 node app.mjs 才跑通',
    }),
    '#4 src/a.ts(4): error D001: x\n' +
      '    复现：1) 在仓库根执行 node app.mjs\n' +
      '    复核：已确认，步骤已改写 —— 原步骤里的 npm start 不存在，改成 node app.mjs 才跑通',
  )
  assert.equal(
    formatTs({ id: 5, file: 'src/a.ts', line: 4, severity: 'error', code: 'D001', message: 'x', steps: [] }),
    '#5 src/a.ts(4): error D001: x',
    '没复核过就不要凭空多一行',
  )
})

test('解析质量指标日志：坏行跳过，阈值与通过标记保留', () => {
  const text = [
    '{"code":"Q001","severity":"warning","file":"src/a.ts","line":3,"metric":"calls","value":120,"unit":"次","threshold":100,"pass":false,"message":"调用次数超阈值"}',
    'oops',
    '{"code":"Q002","file":"src/b.ts","line":1,"metric":"ms","value":12}',
  ].join('\n')
  const { entries, bad } = parseQuality(text)
  assert.equal(entries.length, 2)
  assert.equal(bad, 1)
  assert.equal(entries[0].metric, 'calls')
  assert.equal(entries[0].threshold, 100)
  assert.equal(entries[0].pass, false)
  assert.equal(entries[1].threshold, null)
  assert.equal(entries[1].pass, null)
  assert.equal(entries[1].severity, 'warning')
})
