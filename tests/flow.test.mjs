import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test, { describe } from 'node:test'

import { normalizeConfig } from '../src/config.mjs'
import { reportFlow, runFlow, statusFlow } from '../src/flow.mjs'
import { reviewPrompt } from '../src/prompts.mjs'
import { makeFakeContext, makeRepo, standardHandlers, verifyItemsOf } from './helpers.mjs'

const config = normalizeConfig({
  cleanup: true,
  runTimeoutMs: 20_000,
  buildTimeoutMs: 60_000,
  agentTimeoutMs: 60_000,
})

const args = (repo, head) => ({ repo, change: { mode: 'commit', ref: head }, launch: 'node app.mjs' })

/** 假代理给出的复现步骤：每条诊断都必须有，缺了会被打回重试。 */
const STEPS = ['在仓库根执行 node app.mjs', '看 stdout 与 $CODER_LOG_DIR 下的日志']

/**
 * @param {string} file
 * @returns {Promise<Array<object>>}
 */
async function readLines(file) {
  const text = await fs.readFile(file, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// 每个用例都是一个真仓库 + 真 git + 真进程，单跑 5~8s；用例之间互不共享目录，
// 所以按 4 路并发跑：git 进程是等待居多，并发把总时长压到四分之一左右。
describe('coder_debug 流程', { concurrency: 4 }, () => {
  test('完整链路：两个 JSONL，D 与 Q 并行，临时目录清理，status / report 读同一份', async () => {
    const { dir, run, head } = await makeRepo()

    const events = []
    const handlers = standardHandlers()
    const timed = (name, fn, delay = 120) => async (input) => {
      const start = Date.now()
      await new Promise((resolve) => setTimeout(resolve, delay))
      const result = await fn(input)
      events.push({ name, start, end: Date.now() })
      return result
    }
    handlers['codes-debug'] = timed('codes-debug', handlers['codes-debug'], 200)
    handlers['codes-quality'] = timed('codes-quality', handlers['codes-quality'], 200)
    handlers['review-debug'] = timed('review-debug', handlers['review-debug'], 40)

    // 用闸门代替「谁跑得慢」：质量审查被卡住，直到 Debug 线真的开始插桩 ——
    // 这样「两条线互不等待」是结构上的事实，不受机器负载影响。
    // 这个兜底只是防死锁，给得足够宽：并发跑起来时 instrument 之前要建工作区，慢一点是正常的。
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const safety = setTimeout(() => release(), 60_000)
    let qualityReviewDone = false
    let instrumentWhileReviewBlocked = false

    const reviewQuality = handlers['review-quality']
    handlers['review-quality'] = async (input) => {
      await gate
      const result = await reviewQuality(input)
      qualityReviewDone = true
      return result
    }
    const instrument = handlers.instrument
    handlers.instrument = async (input) => {
      const start = Date.now()
      instrumentWhileReviewBlocked = !qualityReviewDone
      release()
      const result = await instrument(input)
      events.push({ name: 'instrument', start, end: Date.now() })
      return result
    }
    handlers.quality = timed('quality', handlers.quality)

    const { ctx, exec, calls } = makeFakeContext(handlers)
    const summary = await runFlow({ ctx, config, logger: ctx.logger, exec, args: args(dir, head) })
    clearTimeout(safety)

    assert.equal(summary.ok, true)
    assert.equal(summary.status, 'done')
    assert.equal(summary.codes, 2)
    assert.equal(summary.debugCodes, 1)
    assert.equal(summary.qualityCodes, 1)
    assert.equal(summary.diagnostics, 3)
    assert.deepEqual(summary.sources, { runtime: 1, static: 1, 'quality-runtime': 1 })
    assert.equal(summary.cleanup.tempRemoved, true)

    const codes = await readLines(summary.files.codes)
    assert.equal(codes.length, 2)
    assert.deepEqual(
      codes.map((row) => [row.code, row.kind, row.check, row.enabled]),
      [['D001', 'debug', 'runtime', true], ['Q001', 'quality', 'static', true]],
      '快照里带检查类型与启用状态，没有 title',
    )

    const lines = await readLines(summary.files.diagnostics)
    assert.equal(lines.length, 3)
    assert.deepEqual(lines.map((item) => item.id), [1, 2, 3], '诊断按输出顺序编号，便于文本索引')
    const runtime = lines.find((item) => item.source === 'runtime')
    const staticLine = lines.find((item) => item.source === 'static')
    const quality = lines.find((item) => item.source === 'quality-runtime')
    assert.equal(runtime.code, 'D001')
    assert.equal(runtime.verdict, 'violation')
    assert.equal(staticLine.code, 'Q001')
    assert.equal(staticLine.kind, 'quality')
    assert.equal(quality.metric, 'calls')
    assert.equal(quality.value, 120)
    assert.equal(quality.pass, false)

    // 每一条诊断都要有能照着做的复现步骤，三个来源都一样
    for (const line of lines) {
      assert.ok(Array.isArray(line.steps) && line.steps.length > 0, `#${line.id}（${line.source}）缺复现步骤`)
      assert.ok(line.steps.every((step) => typeof step === 'string' && step.trim()))
    }
    assert.deepEqual(runtime.steps, ['在仓库根执行 node app.mjs', '看 stdout 里没有经过 log() 的那一行'])
    assert.deepEqual(staticLine.steps, ['打开 src/a.mjs:1', '看 run() 从第 1 行到第 60 行'])
    assert.deepEqual(quality.steps, ['在仓库根执行 node app.mjs', '看 quality.jsonl 里 Q001 的 value'])

    // 出完诊断记录之后过一遍复核：这一轮全部判成「确实存在、步骤能跑通」
    assert.equal(summary.verification.status, 'done')
    assert.equal(summary.verification.checked, 3)
    assert.equal(summary.verification.confirmed, 3)
    assert.equal(summary.verification.dropped, 0)
    for (const line of lines) {
      assert.equal(line.verification, 'confirmed', `#${line.id} 应该经过复核`)
      assert.equal(line.repro, 'pass')
      assert.ok(line.reproNote, '复核要留下它做了什么')
    }
    const stepNames = calls.map((call) => call.name)
    assert.equal(stepNames[stepNames.length - 1], 'verify', '复核是最后一个节点')
    assert.ok(stepNames.indexOf('verify') > stepNames.indexOf('integrate'))

    // 两个 JSONL + 一个只读 HTML 视图 + 一份运行摘要（页面「诊断报告」读它）
    const runDir = path.dirname(summary.files.codes)
    assert.deepEqual(
      (await fs.readdir(runDir)).sort(),
      ['codes.jsonl', 'diagnostics.html', 'diagnostics.jsonl', 'summary.json'],
    )
    const onDisk = JSON.parse(await fs.readFile(path.join(runDir, 'summary.json'), 'utf8'))
    assert.equal(onDisk.runId, summary.runId)
    assert.equal(onDisk.counts.error + onDisk.counts.warning + onDisk.counts.info, summary.diagnostics)
    assert.equal(onDisk.verification.status, 'done')

    const html = await fs.readFile(summary.files.html, 'utf8')
    assert.match(html, /<!doctype html>/)
    assert.match(html, /D001/)
    assert.match(html, /app\.mjs:1/)
    assert.equal((html.match(/复现步骤/g) ?? []).length, 3, '每条诊断下面都挂一份复现步骤')
    assert.match(html, /<li>在仓库根执行 node app\.mjs<\/li>/)
    assert.match(html, /1 条 Debug \/ 1 条 Quality/)

    // 出码是两族共用的前置：先 D 后 Q（Q 拿 D 当输入，避免把同一条规则再出一遍）
    const codesDebug = events.find((item) => item.name === 'codes-debug')
    const codesQuality = events.find((item) => item.name === 'codes-quality')
    assert.ok(codesDebug && codesQuality, '两族各起一个生成代理')
    assert.ok(codesQuality.start >= codesDebug.end, '质量码应在 Debug 码之后生成，把 D 当输入')

    // 之后两条线同时起跑：Debug 线在质量线还卡着的时候就已经插桩了
    const instrumentEvent = events.find((item) => item.name === 'instrument')
    assert.ok(instrumentEvent, 'Debug 线走到了插桩')
    assert.equal(instrumentWhileReviewBlocked, true, 'Debug 线不应等质量线审查完')
    const debugLane = summary.lanes?.debug
    const qualityLane = summary.lanes?.quality
    assert.ok(debugLane && qualityLane, '两条线都应有计时')
    assert.ok(debugLane.started < qualityLane.ended && qualityLane.started < debugLane.ended, '两条线应在时间上重叠')
    assert.equal(run(['rev-parse', 'HEAD']).trim(), head, '源仓库 HEAD 不应改变')

    // status 与 report 读的是刚写下的那两个 JSONL
    const listed = await statusFlow({ args: { repo: dir }, config })
    assert.equal(listed.ok, true)
    const runEntry = listed.runs.find((item) => item.runId === summary.runId)
    assert.deepEqual({ codes: runEntry.codes, diagnostics: runEntry.diagnostics }, { codes: 2, diagnostics: 3 })
    const report = await reportFlow({ args: { repo: dir, runId: summary.runId }, config })
    assert.equal(report.diagnostics.length, 3)
  })

  test('静态线索运行期没确认就保留为 static 行；缺复现步骤会被打回重试', async () => {
    const { dir, head } = await makeRepo()
    const handlers = standardHandlers()
    const prompts = []
    let attempt = 0
    handlers['review-debug'] = (input) => {
      prompts.push(input.prompt)
      attempt += 1
      return {
        findings: [
          {
            code: 'D001',
            file: 'src/a.mjs',
            line: 1,
            severity: 'error',
            message: '静态怀疑这里直接使用了 console',
            confidence: 'medium',
            // 第一次漏了复现步骤，第二次照要求给出来
            ...(attempt === 1 ? {} : { steps: STEPS }),
          },
        ],
        notes: '',
      }
    }
    handlers['review-quality'] = () => ({ findings: [], notes: '' })
    const { ctx, exec } = makeFakeContext(handlers)

    const summary = await runFlow({ ctx, config, logger: ctx.logger, exec, args: args(dir, head) })
    assert.equal(summary.ok, true)
    assert.equal(attempt, 2, '缺 steps 应被打回一次')
    assert.match(prompts[1], /复现步骤/, '重试时要告诉代理缺的是什么')

    const lines = await readLines(summary.files.diagnostics)
    const staticLine = lines.find((item) => item.source === 'static' && item.file === 'src/a.mjs')
    assert.ok(staticLine, '未被运行期确认的静态结论必须保留')
    assert.equal(staticLine.code, 'D001')
    assert.equal(staticLine.confidence, 'medium')
    assert.deepEqual(staticLine.steps, STEPS)
  })

  test('质量指标：计划外的也带复现步骤；verdict=pass 的运行期观察点不进诊断', async () => {
    const { dir, run } = await makeRepo()
    // 这一版程序吐出两条指标，但质量代理只计划了 Q001 的插桩：Q002 没有计划可依。
    await fs.writeFile(
      path.join(dir, 'app.mjs'),
      [
        "import fs from 'node:fs'",
        'const dir = process.env.CODER_LOG_DIR',
        'const metric = (code, value) =>',
        '  fs.appendFileSync(dir + "/quality.jsonl", JSON.stringify({ code, severity: "warning", file: "app.mjs", line: 1, metric: "calls", value, threshold: 100, pass: false, message: code + " 超阈值" }) + "\\n")',
        'metric("Q001", 120)',
        'metric("Q002", 130)',
        'const diag = { code: "D001", severity: "error", file: "app.mjs", line: 1, message: "直接使用了 console" }',
        'fs.appendFileSync(dir + "/diagnostics.jsonl", JSON.stringify(diag) + "\\n")',
        '',
      ].join('\n'),
      'utf8',
    )
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'two metrics'])
    const rev = run(['rev-parse', 'HEAD']).trim()

    const handlers = standardHandlers()
    handlers['codes-quality'] = () => ({
      codes: [
        { code: 'Q001', check: 'runtime', severity: 'warning', rule: '调用次数不超过 100。', detect: '数调用', fix: '把重复调用合并成一次。' },
        { code: 'Q002', check: 'runtime', severity: 'warning', rule: '另一条不超过 100。', detect: '数调用', fix: '缓存结果，别每次都重算。' },
      ],
    })
    handlers['review-quality'] = () => ({ findings: [], notes: '' })
    handlers.quality = () => ({
      applicable: true,
      sites: [
        {
          code: 'Q001',
          file: 'app.mjs',
          line: 1,
          metric: 'calls',
          note: '统计 Q001',
          steps: ['在仓库根执行 node app.mjs', '看 quality.jsonl 里 Q001 的 value'],
        },
      ],
      skipped: [],
      notes: '',
    })
    // 运行期说「这个观察点通过了」：它不该出现在诊断记录里
    handlers.integrate = () => ({
      diagnostics: [
        {
          code: 'D001',
          severity: 'error',
          file: 'app.mjs',
          line: 1,
          message: '观察点通过',
          verdict: 'pass',
          evidence: 'logs/diagnostics.jsonl:1',
          steps: STEPS,
        },
      ],
      summary: '一个通过，两条指标',
    })
    const { ctx, exec } = makeFakeContext(handlers)

    const summary = await runFlow({ ctx, config, logger: ctx.logger, exec, args: args(dir, rev) })
    assert.equal(summary.ok, true)
    const lines = await readLines(summary.files.diagnostics)
    assert.equal(lines.filter((item) => item.source === 'runtime').length, 0, 'pass 不写进诊断')

    const planned = lines.find((item) => item.code === 'Q001' && item.source === 'quality-runtime')
    const unplanned = lines.find((item) => item.code === 'Q002' && item.source === 'quality-runtime')
    assert.ok(planned && unplanned, '两条指标都是诊断')
    assert.deepEqual(planned.steps, ['在仓库根执行 node app.mjs', '看 quality.jsonl 里 Q001 的 value'])
    assert.deepEqual(
      unplanned.steps,
      ['在仓库根执行 node app.mjs', '看 logs/quality.jsonl 里 Q002 这一行（metric / value / threshold）'],
      '没有插桩计划时退到这次运行真实的入口与日志位置，而不是留空',
    )
  })

  test('整合代理越界行号、编造证据都会被打回', async () => {
    const { dir, head } = await makeRepo()
    const diag = (over) => ({
      code: 'D001',
      severity: 'error',
      file: 'app.mjs',
      line: 1,
      message: 'x',
      verdict: 'violation',
      evidence: 'logs/diagnostics.jsonl:1',
      steps: STEPS,
      ...over,
    })

    // ① 行号必须落在原始提交里（每个步骤只有两次机会：一次重试）
    let lines = 0
    const first = standardHandlers()
    first.integrate = () => {
      lines += 1
      return { diagnostics: [diag({ line: lines === 1 ? 9999 : 1 })], summary: 'ok' }
    }
    const a = makeFakeContext(first)
    const lineRun = await runFlow({ ctx: a.ctx, config, logger: a.ctx.logger, exec: a.exec, args: args(dir, head) })
    assert.equal(lineRun.ok, true)
    assert.equal(lines, 2, '越界行号打回一次')

    // ② 证据必须指向日志里真实存在的行（这次复用上一轮写下的 codes.jsonl）
    let evidence = 0
    const second = standardHandlers()
    second.integrate = () => {
      evidence += 1
      return {
        diagnostics: [diag({ evidence: evidence === 1 ? 'logs/diagnostics.jsonl:99' : 'logs/diagnostics.jsonl:1' })],
        summary: 'ok',
      }
    }
    const b = makeFakeContext(second)
    const evidenceRun = await runFlow({ ctx: b.ctx, config, logger: b.ctx.logger, exec: b.exec, args: args(dir, head) })
    assert.equal(evidenceRun.ok, true)
    assert.equal(evidence, 2, '编造证据打回一次')
    assert.equal(evidenceRun.codeCache.reused, true)
  })

  test('诊断码复用：生成一次之后复用不再起代理；手改过的文件原样生效', async () => {
    const { dir, head } = await makeRepo()
    const { ctx, exec, calls } = makeFakeContext(standardHandlers())

    const first = await runFlow({ ctx, config, logger: ctx.logger, exec, args: args(dir, head) })
    assert.equal(first.ok, true)
    assert.equal(first.codeCache.reused, false)
    assert.equal(first.codesFile, 'docs/codes.jsonl')
    const codeCalls = () => calls.filter((call) => call.name.startsWith('codes-')).length
    const docCalls = () => calls.filter((call) => call.name === 'triage' || call.name === 'select').length
    assert.deepEqual([codeCalls(), docCalls()], [2, 2], '第一次要筛文档、选文档、出两族码')

    const file = path.join(dir, 'docs', 'codes.jsonl')
    const written = await fs.readFile(file, 'utf8')
    assert.equal(written, written.trimEnd() + '\n', '每行一个对象，末尾一个换行')
    assert.deepEqual((await readLines(file)).map((row) => row.code), ['D001', 'Q001'])

    const second = await runFlow({ ctx, config, logger: ctx.logger, exec, args: args(dir, head) })
    assert.equal(second.ok, true)
    assert.equal(second.codeCache.reused, true)
    assert.deepEqual([codeCalls(), docCalls()], [2, 2], '复用不再调生成代理，也不筛文档')
    assert.equal(second.codes, first.codes)
    assert.equal(await fs.readFile(file, 'utf8'), written, '复用不覆盖文件内容')

    // 换成手写的一份（只有 Q 码、其中一条未启用）：原样生效，文件不被改写
    const handWritten = [
      { code: 'Q009', check: 'runtime', enabled: true, severity: 'info', rule: '手写规则原文。', detect: '读代码判断', targets: ['Session'] },
      { code: 'Q010', check: 'static', enabled: false, severity: 'info', rule: '未启用的那条。', detect: '读代码判断', targets: [] },
    ]
    await fs.writeFile(file, `${handWritten.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')

    // 手写码没有运行期指标可观测：这一族应被安静跳过。
    const handlers = standardHandlers()
    handlers['review-quality'] = () => ({ findings: [], notes: '' })
    handlers.quality = () => ({ applicable: false, sites: [], skipped: [], notes: '手写码不观测' })
    const hand = makeFakeContext(handlers)
    const third = await runFlow({
      ctx: hand.ctx,
      config,
      logger: hand.ctx.logger,
      exec: hand.exec,
      args: args(dir, head),
    })
    assert.equal(third.ok, true)
    assert.equal(third.codeCache.reused, true)
    assert.equal(third.codes, 2, '文件里两条都留着')
    assert.equal(third.activeCodes, 1, '未启用的那条不进诊断')
    assert.equal(third.disabledCodes, 1)
    assert.equal(third.debugCodes, 0)
    assert.equal(third.qualityCodes, 2)
    assert.deepEqual(
      hand.calls.filter((call) => call.name.startsWith('review-') || call.name === 'quality').map((call) => call.name),
      ['review-quality', 'quality'],
      'Debug 线一条码都没有，不该起任何代理',
    )
    assert.equal(await fs.readFile(file, 'utf8'), `${handWritten.map((row) => JSON.stringify(row)).join('\n')}\n`, '复用不改写文件')
  })

  test('codes.jsonl 有坏行时报错；是空文件时重新生成', async () => {
    const bad = await makeRepo()
    await fs.writeFile(path.join(bad.dir, 'docs', 'codes.jsonl'), '{不是 JSON}\n', 'utf8')
    const badRun = makeFakeContext(standardHandlers())
    const failed = await runFlow({
      ctx: badRun.ctx,
      config,
      logger: badRun.ctx.logger,
      exec: badRun.exec,
      args: args(bad.dir, bad.head),
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'BAD_CODES_FILE')
    assert.match(failed.error.message, /第 1 行/)

    const empty = await makeRepo()
    await fs.writeFile(path.join(empty.dir, 'docs', 'codes.jsonl'), '\n\n', 'utf8')
    const emptyRun = makeFakeContext(standardHandlers())
    const summary = await runFlow({
      ctx: emptyRun.ctx,
      config,
      logger: emptyRun.ctx.logger,
      exec: emptyRun.exec,
      args: args(empty.dir, empty.head),
    })
    assert.equal(summary.ok, true)
    assert.equal(summary.codeCache.reused, false)
    assert.ok(summary.warnings.some((item) => item.includes('空文件')))
    assert.equal((await readLines(path.join(empty.dir, 'docs', 'codes.jsonl'))).length, 2)
  })

  test('targets 只进提示词、不做机械打回；复核跑不完只警告，不丢结果', async () => {
    const { dir, head } = await makeRepo()
    const handlers = standardHandlers()
    const prompts = []
    handlers['codes-debug'] = () => ({
      codes: [
        {
          code: 'D001',
          check: 'runtime',
          severity: 'error',
          rule: '禁止 console。',
          detect: 'console 调用',
          fix: '换成 log()',
          targets: ['所有用到 console 的地方'],
        },
      ],
    })
    const review = () => {
      prompts.push(1)
      return {
        findings: [
          {
            code: 'D001',
            file: 'app.mjs',
            line: 1,
            severity: 'error',
            message: '静态发现',
            confidence: 'high',
            steps: STEPS,
          },
        ],
        notes: '',
      }
    }
    handlers['review-debug'] = review
    handlers.integrate = () => ({
      diagnostics: [
        {
          code: 'D001',
          severity: 'error',
          file: 'src/a.mjs',
          line: 1,
          message: '运行期发现',
          verdict: 'violation',
          evidence: 'logs/diagnostics.jsonl:1',
          steps: STEPS,
        },
      ],
      summary: 'ok',
    })
    // 复核一条都没回答：软节点，只警告
    handlers.verify = () => ({ checks: [] })
    const { ctx, exec } = makeFakeContext(handlers)

    const summary = await runFlow({ ctx, config, logger: ctx.logger, exec, args: args(dir, head) })
    assert.equal(summary.ok, true, '复核是软节点：它失败不该让整次诊断失败')
    assert.equal(prompts.length, 1, 'targets 不做机械匹配：一条就够，不会因为「文件里没出现」被打回')
    assert.equal(summary.verification.status, 'failed')
    assert.ok(summary.warnings.some((item) => item.includes('复核没有完成')))

    const lines = await readLines(summary.files.diagnostics)
    const d001 = lines.filter((item) => item.code === 'D001')
    assert.equal(d001.length, 2, '静态一条 + 运行期一条，都留着')
    assert.deepEqual([...new Set(d001.map((item) => item.file))].sort(), ['app.mjs', 'src/a.mjs'])
    assert.ok(lines.every((item) => item.verification === undefined), '没复核过就不要假装复核过')
  })

  test('不传 change 时对全仓库诊断；传了才按改动范围（提示词层面）', async () => {
    const { dir, head } = await makeRepo()

    const whole = makeFakeContext(standardHandlers())
    const wholeRun = await runFlow({
      ctx: whole.ctx,
      config,
      logger: whole.ctx.logger,
      exec: whole.exec,
      args: { repo: dir, launch: 'node app.mjs' },
    })
    assert.equal(wholeRun.ok, true)
    assert.equal(wholeRun.change.mode, 'all')
    assert.equal(wholeRun.change.base, null, '整仓模式没有基线')
    assert.equal(wholeRun.change.head, head)
    assert.equal(wholeRun.change.files, 6, '范围是 HEAD 的完整文件树，不是差集')
    assert.equal(wholeRun.diagnostics, 3, '整仓模式照样跑完整条链路')

    const wholeReview = whole.calls.find((call) => call.name === 'review-debug')
    assert.match(wholeReview.prompt, /整个仓库/)
    assert.match(wholeReview.prompt, /完整文件树/)
    assert.match(wholeReview.prompt, /只读地审查整个仓库/)
    assert.doesNotMatch(wholeReview.prompt, /本次范围：提交 [0-9a-f]{8}（对比父提交/, '整仓模式不该把自己说成一次改动')
    assert.doesNotMatch(wholeReview.prompt, /- M src\/a\.mjs/, '整仓模式没有改动文件清单')

    // 提交/区间模式的提示词：一段范围渲染，不必再跑一遍整条链路
    const scoped = reviewPrompt({
      worktree: dir,
      codes: [],
      kind: 'debug',
      scope: { mode: 'commit', base: 'aaaaaaaa', head: 'bbbbbbbb', files: [{ status: 'M', path: 'src/a.mjs' }] },
    })
    assert.match(scoped, /改动 1 个文件/)
    assert.match(scoped, /- M src\/a\.mjs/)
    assert.doesNotMatch(scoped, /整个仓库/)
  })

  test('build / launch 是 {type,entry} 步骤：cmd 起子进程，dsh-plugin 让 DSH 调工具', async () => {
    const { dir, head } = await makeRepo()
    const handlers = standardHandlers()
    // 构建用 DSH 工具（xl_build），启动用命令：两条路径都要真的走到
    handlers['tool:xl_build'] = (args) => ({ built: args.paths })
    const { ctx, exec, calls, toolCalls } = makeFakeContext(handlers)

    const summary = await runFlow({
      ctx,
      config,
      logger: ctx.logger,
      exec,
      args: {
        repo: dir,
        change: { mode: 'commit', ref: head },
        build: [{ type: 'dsh-plugin', entry: 'xl_build', input: { paths: ['{{worktree}}/src'] } }],
        launch: [{ type: 'cmd', entry: 'node app.mjs' }],
      },
    })

    assert.equal(summary.ok, true)
    assert.equal(summary.diagnostics, 3, '构建与启动都成功了')
    assert.ok(!summary.warnings.some((item) => item.includes('构建失败')))
    assert.ok(toolCalls.length >= 1, '构建调了 DSH 工具')
    assert.equal(toolCalls[0].name, 'xl_build')
    assert.match(toolCalls[0].args.paths[0], /src$/, '{{worktree}} 被换成了本次工作区')
    assert.equal(summary.build.ok, true)
    assert.equal(summary.build.steps[0].type, 'dsh-plugin')

    assert.match(calls.find((call) => call.name === 'instrument').prompt, /\[DSH 工具\] xl_build/)
    assert.match(calls.find((call) => call.name === 'quality').prompt, /\[命令\] node app\.mjs/, '启动步骤进质量线提示词')
    assert.match(calls.find((call) => call.name === 'verify').prompt, /\[命令\] node app\.mjs/)
  })

  test('dsh-plugin 构建失败：不运行，诊断码没有运行期结论；launch 至少要一步', async () => {
    const { dir, head } = await makeRepo()
    const handlers = standardHandlers()
    const { ctx, exec, toolCalls } = makeFakeContext(handlers)
    // 让工具调用失败
    ctx.get('tools').execute = async (input) => {
      const call = input.calls[0]
      toolCalls.push({ name: call.name, args: JSON.parse(call.arguments) })
      return { results: [{ isError: true, content: [{ type: 'text', text: 'xl_build 报错' }] }] }
    }

    const summary = await runFlow({
      ctx,
      config,
      logger: ctx.logger,
      exec,
      args: {
        repo: dir,
        change: { mode: 'commit', ref: head },
        build: [{ type: 'dsh-plugin', entry: 'xl_build', input: {} }],
        launch: [{ type: 'cmd', entry: 'node app.mjs' }],
      },
    })

    assert.equal(summary.ok, true, '构建失败不是整次运行失败')
    assert.equal(summary.build.ok, false)
    assert.equal(summary.build.failedStep, 'xl_build')
    assert.ok(summary.warnings.some((item) => item.includes('构建失败')))
    assert.equal(summary.diagnostics, 2, '只剩静态那两条，运行期没有结论')

    await assert.rejects(
      () =>
        runFlow({
          ctx,
          config,
          logger: ctx.logger,
          exec,
          args: { repo: dir, change: { mode: 'commit', ref: head }, launch: [] },
        }),
      /缺少参数 launch/,
    )
  })

  test('复核：误报剔出交付物并重新编号，跑不通的步骤换成实测过的', async () => {
    const { dir, head } = await makeRepo()
    const handlers = standardHandlers()
    const fixed = ['在仓库根执行 node app.mjs', '看 stdout 里直接打印的 port=3000']
    handlers.verify = ({ prompt }) => ({
      checks: verifyItemsOf(prompt).map((item) => {
        if (item.source === 'static') {
          return { id: item.id, repro: 'pass', verdict: 'false-positive', note: '这条规则只管 src，这里其实是别的目录的代码' }
        }
        if (item.source === 'runtime') {
          return {
            id: item.id,
            repro: 'fail',
            verdict: 'confirmed',
            note: '步骤写的 npm start 仓库里没有，改成 node app.mjs 后能复现',
            steps: fixed,
          }
        }
        return { id: item.id, repro: 'pass', verdict: 'confirmed', note: '按步骤走了一遍，现象对得上' }
      }),
    })
    const { ctx, exec } = makeFakeContext(handlers)

    const summary = await runFlow({ ctx, config, logger: ctx.logger, exec, args: args(dir, head) })
    assert.equal(summary.ok, true)
    assert.equal(summary.verification.status, 'done')
    assert.equal(summary.verification.checked, 3)
    assert.equal(summary.verification.dropped, 1)
    assert.equal(summary.verification.confirmed, 2)
    assert.equal(summary.verification.rewritten, 1)

    assert.equal(summary.rejected.length, 1)
    assert.equal(summary.rejected[0].code, 'Q001')
    assert.match(summary.rejected[0].reason, /只管 src/)
    assert.ok(summary.warnings.some((item) => item.includes('复核排除了 1 条误报')))
    assert.ok(summary.warnings.some((item) => item.includes('步骤跑不通')))

    const lines = await readLines(summary.files.diagnostics)
    assert.equal(lines.length, 2, '被排除的那条不再出现在交付物里')
    assert.ok(!lines.some((item) => item.source === 'static'))
    assert.deepEqual(lines.map((item) => item.id), [1, 2], '排掉之后重新编号')

    const runtime = lines.find((item) => item.source === 'runtime')
    assert.deepEqual(runtime.steps, fixed, '换掉的正是代理实测过的步骤')
    assert.equal(runtime.repro, 'rewritten')
    assert.match(runtime.reproNote, /npm start/)

    const html = await fs.readFile(summary.files.html, 'utf8')
    assert.match(html, /已排除（复核判定误报：1）/)
    assert.match(html, /这条规则只管 src/)
    assert.match(html, /复核<\/dt><dd>3 条 → 确认 2 · 存疑 0 · 排除误报 1 · 改写步骤 1/)
    assert.match(html, /步骤已改写/)
  })
})
