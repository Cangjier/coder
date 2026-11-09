import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  compareRows,
  countsOf,
  kindOfCode,
  nextCode,
  normalizeRow,
  parseCodes,
  targetsLabelOf,
  targetsOf,
  serializeCodes,
  validateRows,
  withoutDisabled,
} from '../src/codes-client.js'
import { codesPathFor, CODES_FILE, isCoderArtifact, readCodesFile, writeCodesFile } from '../src/codes.mjs'
import { SEVERITIES } from '../src/diagnostics.mjs'
import { formatValue } from '../src/tools/debug.mjs'
import { tempDir } from './helpers.mjs'

const row = (over = {}) => ({
  code: 'D001',
  severity: 'error',
  rule: '禁止直接使用 console。',
  detect: '运行期捕获 console 调用',
  ...over,
})

test('解析 → 校验 → 序列化：字段顺序固定，check / enabled 有默认值，title 被丢掉', () => {
  const text = `${JSON.stringify({
    code: 'Q001',
    kind: 'quality',
    title: '旧字段',
    severity: 'warning',
    rule: 'r',
    detect: 'd',
  })}\n{oops}\n`
  const parsed = parseCodes(text)
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.problems.length, 1)
  assert.equal(parsed.problems[0].line, 2)
  assert.match(parsed.problems[0].message, /第 2 行/)
  assert.equal(parsed.rows[0].__line, 1)
  assert.equal(parsed.rows[0].check, 'static', 'Q 码没写 check 时默认 static')
  assert.equal(parsed.rows[0].enabled, true, '没写 enabled 就是启用')
  assert.equal('title' in parsed.rows[0], false, 'title 已经移除，不再当作未知字段保留')
  assert.equal(validateRows(parsed.rows).length, 0)

  const written = serializeCodes(parsed.rows)
  assert.equal(
    written,
    '{"code":"Q001","kind":"quality","check":"static","enabled":true,"severity":"warning","rule":"r","detect":"d","fix":"","targets":[]}\n',
  )
  assert.deepEqual(parseCodes(written).rows[0].code, 'Q001')
  assert.ok(!written.includes('__line'), '__line 只是解析期元数据')
})

test('check / enabled 的读写：写错就退回默认，false 才是未启用', () => {
  assert.equal(normalizeRow(row({ check: 'runtime' })).check, 'runtime')
  assert.equal(normalizeRow(row({ code: 'Q002', check: 'STATIC' })).check, 'static')
  assert.equal(normalizeRow(row({ code: 'Q002' })).check, 'static', 'Q 码默认静态')
  assert.equal(normalizeRow(row({ check: '乱写' })).check, 'runtime', 'D 码默认运行期')

  assert.equal(normalizeRow(row({ enabled: false })).enabled, false)
  assert.equal(normalizeRow(row({ enabled: 'false' })).enabled, false)
  assert.equal(normalizeRow(row({ enabled: 'no' })).enabled, false)
  assert.equal(normalizeRow(row({})).enabled, true)
  assert.equal(normalizeRow(row({ enabled: true })).enabled, true)

  const counts = countsOf([
    normalizeRow(row()),
    normalizeRow(row({ code: 'Q001' })),
    normalizeRow(row({ code: 'Q002', check: 'runtime', enabled: false })),
  ])
  assert.deepEqual(counts, { total: 3, debug: 1, quality: 2, static: 1, runtime: 2, disabled: 1 })
})

test('fix 是解决思路：去空白、排进固定字段顺序，老文件没有它就是空字符串', () => {
  assert.equal(normalizeRow(row({ fix: '  把 console 换成 log()  ' })).fix, '把 console 换成 log()')
  assert.equal(normalizeRow(row({ fix: 42 })).fix, '42', '别的类型转成字符串')
  assert.equal(normalizeRow(row()).fix, '', '老文件没有 fix，读进来是空字符串')
  assert.equal(validateRows([row({ fix: '' })]).length, 0, 'fix 为空不算错：老文件不该因此打不开')

  const text = serializeCodes([normalizeRow(row({ fix: '把 console 换成 log()' }))])
  assert.match(text, /"fix":"把 console 换成 log\(\)"/)
  assert.ok(text.indexOf('"detect"') < text.indexOf('"fix"'), 'fix 排在 detect 后面')
  assert.ok(text.indexOf('"fix"') < text.indexOf('"targets"'), 'targets 仍在最后')
})

test('移除未启用：只丢 enabled:false 的整条，别的原样留着', () => {
  const rows = [
    normalizeRow(row({ code: 'D001' })),
    normalizeRow(row({ code: 'D002', enabled: false })),
    normalizeRow(row({ code: 'Q001' })),
    normalizeRow(row({ code: 'Q002', enabled: 'false' })),
  ]
  const kept = withoutDisabled(rows)
  assert.deepEqual(kept.map((item) => item.code), ['D001', 'Q001'], '顺序不变，未启用的整条没了')
  assert.equal(rows.length, 4, '不改原数组')
  assert.deepEqual(withoutDisabled([]), [])
  assert.equal(withoutDisabled(null), null, '不是数组就原样返回')
})

test('kind 由 code 前缀决定；写错 kind、重复码、缺字段都算问题；未知字段保留', () => {
  assert.equal(kindOfCode('D007'), 'debug')
  assert.equal(kindOfCode('Q12'), 'quality')
  assert.equal(kindOfCode('X1'), null)

  const problems = validateRows([
    row({ code: 'D001', kind: 'quality' }),
    row({ code: 'D001' }),
    row({ code: 'D002', severity: 'fatal' }),
    row({ code: 'D003', rule: '' }),
    row({ code: 'ZZZ' }),
  ])
  const text = problems.map((item) => item.message).join('\n')
  assert.match(text, /kind 应为 debug/)
  assert.match(text, /码 D001 重复/)
  assert.match(text, /rule 为空/)
  assert.match(text, /severity「fatal」/)
  assert.match(text, /应形如 D01 \/ Q002/)
  assert.equal(problems[0].index, 0)
  assert.equal(problems[0].field, 'kind')

  // 手写备注原样保留；文档里的列表符号不该跟着 rule 一起抄进来
  const withExtra = normalizeRow(row({ note: '手写备注', include: ['src'] }))
  assert.equal(withExtra.note, '手写备注')
  assert.ok(serializeCodes([withExtra]).includes('"note":"手写备注"'))
  assert.equal(normalizeRow(row({ rule: '- 必须使用结构化日志。' })).rule, '必须使用结构化日志。')
  assert.equal(normalizeRow(row({ rule: '* 禁止硬编码端口。' })).rule, '禁止硬编码端口。')

  const sorted = [
    normalizeRow(row({ code: 'Q002' })),
    normalizeRow(row({ code: 'D010' })),
    normalizeRow(row({ code: 'Q001' })),
  ].sort(compareRows)
  assert.deepEqual(sorted.map((item) => item.code), ['D010', 'Q001', 'Q002'])
  assert.equal(nextCode(sorted, 'debug'), 'D011')
  assert.equal(nextCode(sorted, 'quality'), 'Q003')
  assert.deepEqual([...SEVERITIES].sort(), ['error', 'info', 'warning'])
})

test('targets：精确名字和泛化描述都收，按语义理解，不做机械匹配', () => {
  assert.deepEqual(targetsOf('Session#append, parseDiagnostics\nSession'), ['Session#append', 'parseDiagnostics', 'Session'])
  assert.deepEqual(targetsOf(['Session#append', 'Session#append']), ['Session#append'])
  assert.deepEqual(targetsOf(undefined), [])
  assert.deepEqual(
    targetsOf(['所有 XxxService', '  带重试的 RPC 调用  ']),
    ['所有 XxxService', '带重试的 RPC 调用'],
    '中间的空格与中文描述原样保留',
  )

  // 形态不校验：描述、路径、带空格都只是「字符串」，机械判断不了它指哪些类
  assert.equal(validateRows([row({ targets: ['所有 XxxService'] })]).length, 0)
  assert.equal(validateRows([row({ targets: ['src/legacy'] })]).length, 0)

  const code = normalizeRow(row({ targets: ['Session', 'Session#append'] }))
  assert.equal(targetsLabelOf(code), 'Session, Session#append')
  assert.equal(targetsLabelOf(normalizeRow(row())), '全部代码')
})

test('codes.jsonl 的四种状态；插件自己的文件不算源仓库改动', async () => {
  const dir = await tempDir('coder-codes-')
  const file = path.join(dir, CODES_FILE)

  assert.equal((await readCodesFile(file)).status, 'absent')

  await fs.writeFile(file, '  \n\n', 'utf8')
  assert.equal((await readCodesFile(file)).status, 'empty')

  await fs.writeFile(file, '{nope}\n', 'utf8')
  const bad = await readCodesFile(file)
  assert.equal(bad.status, 'bad')
  assert.equal(bad.problems[0].line, 1)

  await writeCodesFile(file, [normalizeRow(row()), normalizeRow(row({ code: 'Q001' }))])
  const ok = await readCodesFile(file)
  assert.equal(ok.status, 'ok')
  assert.deepEqual(ok.rows.map((item) => item.code), ['D001', 'Q001'])
  assert.equal('__line' in ok.rows[0], false)

  // 内容没变就不碰文件
  const before = await fs.stat(file)
  const next = await writeCodesFile(file, ok.rows)
  assert.equal(next.changed, false)
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs)
  assert.equal(next.codes.total, 2)

  assert.equal(isCoderArtifact('docs/codes.jsonl'), true)
  assert.equal(isCoderArtifact('packages/a/docs/codes.jsonl'), true)
  assert.equal(isCoderArtifact('docs/codes.jsonl.123.456.tmp'), true)
  assert.equal(isCoderArtifact('docs/rules.md'), false)
  assert.equal(isCoderArtifact('src/codes.jsonl'), false, '只认 docs 目录下的')
  assert.equal(isCoderArtifact('docs/nested/codes.jsonl'), false)
  assert.equal(
    isCoderArtifact('docs/codes-editor.html'),
    false,
    '编辑页不再由插件生成，旧仓库里剩的那份就是普通文件了',
  )
})

test('codes.jsonl 的位置跟着规范文档走', () => {
  assert.equal(CODES_FILE, 'codes.jsonl')
  assert.equal(codesPathFor('C:/repo', 'docs/rules.md'), path.join('C:/repo', 'docs', 'codes.jsonl'))
  assert.equal(codesPathFor('/repo', 'packages/a/docs/x.md'), path.join('/repo', 'packages', 'a', 'docs', 'codes.jsonl'))
  assert.equal(codesPathFor('/repo', 'rules.md'), path.join('/repo', 'codes.jsonl'))
})

test('渲染：构建与运行也说清楚（命令 / DSH 工具）', () => {
  const text = formatValue({
    ok: true,
    status: 'done',
    diagnostics: 0,
    codes: 0,
    counts: {},
    sources: {},
    build: {
      ok: true,
      skipped: false,
      exitCode: 0,
      ran: 1,
      steps: [{ index: 0, type: 'dsh-plugin', entry: 'xl_build', exitCode: 0, timedOut: false }],
    },
    run: { exitCode: 0, timedOut: false, durationMs: 1_500 },
    warnings: [],
  })
  assert.match(text, /构建：成功（DSH:xl_build）/)
  assert.match(text, /运行：退出码 0，1\.5s/)

  const failed = formatValue({
    ok: true,
    status: 'done',
    diagnostics: 0,
    codes: 0,
    counts: {},
    sources: {},
    build: { ok: false, skipped: false, failedStep: 'node fail.mjs', steps: [] },
    warnings: [],
  })
  assert.match(failed, /构建：失败于「node fail\.mjs」/)

  const skipped = formatValue({
    ok: true,
    status: 'done',
    diagnostics: 0,
    codes: 0,
    counts: {},
    sources: {},
    build: { ok: true, skipped: true, steps: [] },
    warnings: [],
  })
  assert.match(skipped, /构建：跳过/)
})
