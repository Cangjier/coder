import assert from 'node:assert/strict'
import test from 'node:test'

import { renderHtml } from '../src/report.mjs'

const state = {
  runId: '20261103-000000-abcdef',
  input: { repo: 'C:/x', build: 'node -v', launch: 'node app.mjs' },
  change: { mode: 'commit', base: 'aaaaaaaaaaaa', head: 'bbbbbbbbbbbb', files: [{ status: 'M', path: 'app.mjs' }] },
  docs: { selected: { path: 'docs/rules.md', reason: '唯一候选' } },
  codeCache: { file: 'docs/codes.jsonl', reused: true },
  lanes: { debug: { started: 0, ended: 12_000 }, quality: { started: 0, ended: 8_000 } },
  codes: [
    {
      code: 'D001',
      kind: 'debug',
      check: 'runtime',
      enabled: true,
      severity: 'error',
      rule: '禁止 console。',
      detect: '…',
      targets: [],
    },
    {
      code: 'Q001',
      kind: 'quality',
      check: 'static',
      enabled: false,
      severity: 'warning',
      rule: '不超过 30 行。',
      detect: '…',
      targets: ['Session#append'],
    },
  ],
  lines: [
    {
      id: 1,
      code: 'D001',
      kind: 'debug',
      severity: 'error',
      file: 'src/app.mjs',
      line: 4,
      column: 11,
      message: '直接使用了 <script>alert(1)</script>',
      source: 'runtime',
      verdict: 'violation',
      steps: ['在仓库根执行 node app.mjs', '访问 GET /health 触发 run()'],
    },
    {
      id: 2,
      code: 'Q001',
      kind: 'quality',
      severity: 'warning',
      file: 'src/app.mjs',
      line: 7,
      message: '调用次数超阈值',
      source: 'quality-runtime',
      metric: 'calls',
      value: 120,
      unit: '次',
      threshold: 100,
      pass: false,
      steps: ['在仓库根执行 node app.mjs', '看 quality.jsonl 里 Q001 的 value'],
    },
  ],
  warnings: ['质量运行期跳过了 1 条'],
  error: null,
}

test('HTML 列出全部诊断与诊断码，并做转义', () => {
  const html = renderHtml(state)
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /charset="utf-8"/)
  assert.match(html, /诊断（2）/)
  assert.match(html, /诊断码（2）/)
  assert.match(html, /src\/app\.mjs:4:11/)
  assert.match(html, /calls=120次/)
  assert.match(html, /阈值 100/)
  assert.match(html, /未达标/)
  assert.match(html, /复用/)
  assert.match(html, /docs\/codes\.jsonl/)
  assert.match(html, /<th>涉及<\/th>/)
  assert.match(html, /<th>检查<\/th>/)
  assert.match(html, /<span class="kind">Runtime<\/span>/, '检查类型上报告')
  assert.match(html, /<span class="kind">Static<\/span>/)
  assert.match(html, /<span class="vt vt-warn">未启用<\/span>/, '未启用的码标出来')
  assert.match(html, /其中 1 条未启用/)
  assert.match(html, /1 条 Debug \/ 1 条 Quality/)
  assert.doesNotMatch(html, /<th>标题<\/th>/, 'title 已经移除，报告里不再有标题列')
  assert.match(html, /<td class="rule">Session#append<\/td>/, '有 targets 的码显示涉及的对象')
  assert.match(html, /全部代码/, '没写 targets 时写全部代码')
  assert.match(html, /质量运行期跳过了 1 条/)
  assert.match(html, /<th>#<\/th>/)
  assert.match(html, /id="d1"/)
  assert.match(html, /#1</)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /并行时间线：Debug 0\.0s → 12\.0s（12\.0s） · Quality 0\.0s → 8\.0s（8\.0s）/)
})

test('每条诊断下面挂复现步骤，且照样转义', () => {
  const html = renderHtml(state)
  assert.equal((html.match(/复现步骤/g) ?? []).length, 2, '两条诊断两份步骤')
  assert.match(html, /<ol><li>在仓库根执行 node app\.mjs<\/li><li>访问 GET \/health 触发 run\(\)<\/li><\/ol>/)
  assert.match(html, /<li>看 quality\.jsonl 里 Q001 的 value<\/li>/)

  // 步骤里的标签同样要转义
  const unsafe = renderHtml({
    ...state,
    lines: [{ ...state.lines[0], steps: ['打开 <b>x</b> 这一行'] }],
  })
  assert.match(unsafe, /&lt;b&gt;x&lt;\/b&gt;/)
  assert.doesNotMatch(unsafe, /<b>x<\/b>/)

  // 没有步骤的诊断不给空壳
  const bare = renderHtml({ ...state, lines: [{ ...state.lines[0], steps: [] }], codes: [] })
  assert.doesNotMatch(bare, /复现步骤/)
})

test('复核结论与已排除的误报都上报告', () => {
  const verified = [
    { ...state.lines[0], verification: 'confirmed', repro: 'rewritten', reproNote: '步骤里的 npm start 不存在，改成 node app.mjs 才跑通' },
    { ...state.lines[1], verification: 'uncertain', repro: 'unknown', reproNote: '需要外部支付网关，没法执行' },
  ]
  const html = renderHtml({
    ...state,
    lines: verified,
    rejected: [
      {
        code: 'D002',
        kind: 'debug',
        severity: 'error',
        file: 'src/app.mjs',
        line: 9,
        source: 'static',
        message: '疑似空 catch',
        reason: 'catch 里有一行 log()，不是空 catch',
      },
    ],
    verification: { status: 'done', checked: 3, confirmed: 1, uncertain: 1, dropped: 1, rewritten: 1, durationMs: 12_300 },
  })

  assert.match(html, /已确认/)
  assert.match(html, /步骤已改写/)
  assert.match(html, /存疑/)
  assert.match(html, /步骤未执行/)
  assert.match(html, /步骤里的 npm start 不存在/)
  assert.match(html, /已排除（复核判定误报：1）/)
  assert.match(html, /catch 里有一行 log\(\)，不是空 catch/)
  assert.match(html, /复核<\/dt><dd>3 条 → 确认 1 · 存疑 1 · 排除误报 1 · 改写步骤 1（12\.3s）/)
})

test('复核没跑完时报告里说明这些诊断没复核过', () => {
  const html = renderHtml({
    ...state,
    verification: { status: 'failed', checked: 0, confirmed: 0, uncertain: 0, dropped: 0, rewritten: 0, message: '子代理连续两次输出不合格' },
    rejected: [],
  })
  assert.match(html, /没有完成：子代理连续两次输出不合格/)
})

test('没有诊断时给出空状态，不产出空表格', () => {
  const html = renderHtml({ ...state, lines: [], codes: [] })
  assert.match(html, /本次没有产生任何诊断/)
  assert.match(html, /没有诊断码/)
})
