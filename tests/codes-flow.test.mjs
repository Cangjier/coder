import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../src/config.mjs'
import { runCodesFlow } from '../src/codes-flow.mjs'
import { createCodesTool } from '../src/tools/codes.mjs'
import { registerTools } from '../src/tools/index.mjs'
import { scratchRoot } from '../src/git.mjs'
import { makeFakeContext, makeRepo, standardHandlers } from './helpers.mjs'

const config = normalizeConfig({ agentTimeoutMs: 60_000, cleanup: true })

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

/** @param {string} file @param {string} code */
async function writeOneCode(file, code) {
  const row = { code, check: 'static', severity: 'info', rule: `${code} 的规则。`, detect: '读代码' }
  await fs.writeFile(file, `${JSON.stringify(row)}\n`, 'utf8')
}

test('coder_codes action:"targets"：只改那一条的 targets，写回文件', async () => {
  const { dir, head } = await makeRepo()
  const { ctx, exec } = makeFakeContext(standardHandlers())
  const tool = createCodesTool(ctx, config, ctx.logger)

  const first = await tool.execute({ repo: dir, change: { ref: head } }, exec)
  assert.equal(first.ok, true)
  const file = path.join(dir, 'docs', 'codes.jsonl')
  const before = await readLines(file)
  const target = before[0].code
  const other = before[1].code

  const written = await tool.execute(
    { action: 'targets', repo: dir, code: target, targets: ['Session#append', ' parseDiagnostics '] },
    exec,
  )
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.deepEqual([...written.targets], ['Session#append', 'parseDiagnostics'])

  const stored = await readLines(file)
  const updated = stored.find((row) => row.code === target)
  assert.deepEqual([...updated.targets], ['Session#append', 'parseDiagnostics'])
  assert.equal(stored.find((row) => row.code === other).targets.length, 0, '别的码不动')

  const missing = await tool.execute({ action: 'targets', repo: dir, code: 'Q404', targets: ['X'] }, exec)
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NO_CODE')
})

test('coder_codes：生成 → 复用 → force，复用只读，渲染与 D→Q 顺序都对', async () => {
  const { dir, head } = await makeRepo()
  const { ctx, exec, calls } = makeFakeContext(standardHandlers())
  const tool = createCodesTool(ctx, config, ctx.logger)
  const codeCalls = () => calls.filter((call) => call.name.startsWith('codes-')).length
  const docCalls = () => calls.filter((call) => call.name === 'triage' || call.name === 'select').length

  const first = await tool.execute({ repo: dir, change: { ref: head } }, exec)
  assert.equal(first.ok, true)
  assert.equal(first.action, 'run')
  assert.equal(first.file, 'docs/codes.jsonl')
  assert.equal(first.reused, false)
  assert.deepEqual(first.counts, { total: 2, debug: 1, quality: 1, disabled: 0 })
  assert.equal(codeCalls(), 2, '两族各起一个代理')
  assert.equal(docCalls(), 2, '第一次：筛一遍文档、选一份')

  // 写进文件的就是最终形状：check / enabled 都在，没有 title
  const stored = await readLines(path.join(dir, 'docs', 'codes.jsonl'))
  assert.deepEqual(stored.map((row) => row.code), ['D001', 'Q001'])
  assert.deepEqual(
    stored.map((row) => [row.check, row.enabled]),
    [['runtime', true], ['static', true]],
    'D 码默认 runtime，Q 码默认 static，默认都启用',
  )
  assert.ok(!('title' in stored[0]), 'title 已经移除')
  assert.ok(
    stored.every((row) => typeof row.fix === 'string' && row.fix.length > 0),
    '每条码都带解决思路',
  )
  assert.equal(stored[0].fix, '把那一行 console 调用换成 log()，所有输出都走它。')

  // 先 D 后 Q：Q 拿得到 D 的规则原文
  const debugCall = calls.find((call) => call.name === 'codes-debug')
  const qualityCall = calls.find((call) => call.name === 'codes-quality')
  assert.ok(calls.indexOf(qualityCall) > calls.indexOf(debugCall), 'Q 在 D 之后')
  assert.doesNotMatch(debugCall.prompt, /Debug 码已经覆盖/, 'D 不需要看另一族')
  assert.match(qualityCall.prompt, /Debug 码已经覆盖下面这些规则/)
  assert.match(qualityCall.prompt, /禁止直接使用 console/)
  assert.match(debugCall.prompt, /fix 写解决思路/, '提示词里要求每条码写解决思路')
  assert.match(debugCall.prompt, /"fix":"解决思路…"/, '返回结构里也点出 fix')

  const runText = tool.output.render({}, first)[0].text
  assert.match(runText, /coder_codes done：诊断码 2 条（Debug 1 \/ Quality 1），本次生成 docs\/codes\.jsonl/)
  assert.match(runText, /D001 {2}error {2,}Runtime/)

  const second = await tool.execute({ repo: dir, change: { ref: head } }, exec)
  assert.equal(second.ok, true)
  assert.equal(second.reused, true)
  assert.equal(codeCalls(), 2, '复用不再起生成代理')
  assert.equal(docCalls(), 2, '复用连文档筛选和选择都不做')

  // 复用就是只读：codes.jsonl 一个字都不改
  const codesFile = path.join(dir, 'docs', 'codes.jsonl')
  const written = await fs.readFile(codesFile, 'utf8')
  const mtime = (await fs.stat(codesFile)).mtimeMs
  const before = await fs.readdir(path.join(dir, 'docs'))
  const reused = await tool.execute({ repo: dir, change: { ref: head } }, exec)
  assert.equal(await fs.readFile(codesFile, 'utf8'), written, 'codes.jsonl 一个字都不改')
  assert.deepEqual(await fs.readdir(path.join(dir, 'docs')), before, '不新建任何文件')
  assert.equal((await fs.stat(codesFile)).mtimeMs, mtime, '连 mtime 都不动')
  assert.deepEqual(before.sort(), ['codes.jsonl', 'guide.md', 'rules.md'], '仓库里只有 codes.jsonl，没有编辑页')

  const forced = await tool.execute({ repo: dir, change: { ref: head }, force: true }, exec)
  assert.equal(forced.ok, true)
  assert.equal(forced.reused, false)
  assert.equal(codeCalls(), 4, 'force 才重新生成')
  assert.equal(docCalls(), 4, 'force 也重新走一遍文档')
  assert.equal(forced.codes.length, 2)
  assert.ok(!('editor' in forced), '不再往仓库里写编辑页')

  const shown = await tool.execute({ action: 'show', repo: dir }, exec)
  assert.equal(shown.ok, true)
  assert.equal(shown.files.length, 1)
  assert.equal(shown.files[0].path, 'docs/codes.jsonl')
  assert.equal(shown.files[0].source, 'working-tree')
  assert.equal(shown.files[0].status, 'ok')
  assert.deepEqual(shown.files[0].codes.map((code) => code.code), ['D001', 'Q001'])
  const showText = tool.output.render({}, shown)[0].text
  assert.match(showText, /找到 1 份 codes\.jsonl/)
  assert.match(showText, /docs\/codes\.jsonl（工作区，2 条，ok）/)
})

test('现成的 codes.jsonl 直接复用：一个子代理都不起，来源文档不猜也不编', async () => {
  const first = await makeRepo()
  await writeOneCode(path.join(first.dir, 'docs', 'codes.jsonl'), 'D009')

  const one = makeFakeContext(standardHandlers())
  const result = await runCodesFlow({
    ctx: one.ctx,
    config,
    logger: one.ctx.logger,
    parent: one.exec.agent,
    repo: first.dir,
    head: first.head,
  })
  assert.equal(result.reused, true)
  assert.equal(result.rel, 'docs/codes.jsonl')
  assert.equal(result.counts.total, 1)
  assert.equal(result.codes[0].code, 'D009')
  assert.deepEqual(one.calls, [], '现成的文件就是答案：不筛文档、不选文档、不出码')
  assert.equal(result.doc.path, null, 'docs 下有两份 Markdown，判断不出来源就不猜')
  assert.match(result.doc.reason, /没有重新选文档/)

  // 同目录恰好只有一份 Markdown 时，来源文档记得下来
  const dir = first.dir
  await fs.rm(path.join(dir, 'docs', 'guide.md'))
  first.run(['add', '-A'])
  first.run(['commit', '-q', '-m', 'drop guide'])
  const rev = first.run(['rev-parse', 'HEAD']).trim()
  assert.notEqual(rev, first.head)

  const two = makeFakeContext(standardHandlers())
  const single = await runCodesFlow({
    ctx: two.ctx,
    config,
    logger: two.ctx.logger,
    parent: two.exec.agent,
    repo: dir,
    head: rev,
  })
  assert.equal(single.reused, true)
  assert.deepEqual(two.calls, [])
  assert.equal(single.doc.path, 'docs/rules.md')
})

test('多份 codes.jsonl：选文档后用它旁边那份；选中旁边没有时报错而不是新建', async () => {
  // ① 多份 + 选中的文档旁边有：用那一份
  const first = await makeRepo()
  await fs.mkdir(path.join(first.dir, 'packages', 'a', 'docs'), { recursive: true })
  await fs.writeFile(path.join(first.dir, 'packages', 'a', 'docs', 'a.md'), '# a\n', 'utf8')
  await writeOneCode(path.join(first.dir, 'packages', 'a', 'docs', 'codes.jsonl'), 'Q008')
  await writeOneCode(path.join(first.dir, 'docs', 'codes.jsonl'), 'D009')
  first.run(['add', '-A'])
  first.run(['commit', '-q', '-m', 'two codes files'])
  const two = first.run(['rev-parse', 'HEAD']).trim()

  const a = makeFakeContext(standardHandlers())
  const picked = await runCodesFlow({
    ctx: a.ctx,
    config,
    logger: a.ctx.logger,
    parent: a.exec.agent,
    repo: first.dir,
    head: two,
  })
  assert.ok(
    picked.warnings.some((warning) => warning.includes('2 份 codes.jsonl')),
    '多份时要说明为什么还得选文档',
  )
  assert.equal(picked.reused, true)
  assert.equal(picked.rel, 'docs/codes.jsonl', '选中的文档在 docs/ 下，就用它旁边那份')
  assert.equal(picked.codes[0].code, 'D009')
  assert.equal(a.calls.filter((call) => call.name === 'select').length, 1, '只有多份时才需要选文档')

  // ② 多份 + 选中的文档旁边没有：报 CODES_AMBIGUOUS，不新建第三份
  const second = await makeRepo()
  for (const name of ['a', 'b']) {
    await fs.mkdir(path.join(second.dir, 'packages', name, 'docs'), { recursive: true })
    await fs.writeFile(path.join(second.dir, 'packages', name, 'docs', `${name}.md`), `# ${name}\n`, 'utf8')
    await writeOneCode(path.join(second.dir, 'packages', name, 'docs', 'codes.jsonl'), `Q00${name === 'a' ? 1 : 2}`)
  }
  second.run(['add', '-A'])
  second.run(['commit', '-q', '-m', 'codes in two packages'])
  const rev = second.run(['rev-parse', 'HEAD']).trim()

  const b = makeFakeContext(standardHandlers())
  const tool = createCodesTool(b.ctx, config, b.ctx.logger)
  const failed = await tool.execute({ repo: second.dir, change: { ref: rev } }, b.exec)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'CODES_AMBIGUOUS')
  assert.match(failed.message, /不会替你新建/)
  assert.ok(!(await fs.stat(path.join(second.dir, 'docs', 'codes.jsonl')).catch(() => null)), '不该冒出第三份')
})

test('独立运行时自己建工作区、跑完删掉', async () => {
  const { dir, run, head } = await makeRepo()
  const { ctx, exec, parent } = makeFakeContext(standardHandlers())
  const before = new Set(await fs.readdir(scratchRoot()).catch(() => []))

  const result = await runCodesFlow({ ctx, config, logger: ctx.logger, parent, repo: dir, head })
  assert.equal(result.ok, true)
  assert.equal(result.rel, 'docs/codes.jsonl')
  assert.equal(result.reused, false)
  assert.equal(result.counts.total, 2)
  assert.equal(result.doc.path, 'docs/rules.md')

  const worktrees = run(['worktree', 'list', '--porcelain'])
  assert.ok(!worktrees.includes('codes-'), '临时工作区应已从 git 里摘掉')
  const after = await fs.readdir(scratchRoot()).catch(() => [])
  // 只看这个工具自己的目录：别的用例会同时往同一个临时根里写 <runId>/
  const added = after.filter((name) => !before.has(name) && name.startsWith('codes-'))
  assert.deepEqual(added, [], '临时目录应已删除')
  assert.ok(await fs.stat(path.join(dir, 'docs', 'codes.jsonl')), '结果留在仓库的 docs 里')
})

test('规则重复的质量码被丢掉；两个工具都注册了', async () => {
  const { dir, head } = await makeRepo()
  const handlers = standardHandlers()
  handlers['codes-quality'] = () => ({
    codes: [
      // 同一句规则，换个说法：算重复
      { code: 'Q001', severity: 'warning', rule: '禁止直接使用 console。', detect: 'x', fix: '换成 log()' },
      { code: 'Q002', severity: 'warning', rule: '单个函数不应超过 50 行。', detect: 'y', fix: '拆函数' },
    ],
  })
  const { ctx, exec } = makeFakeContext(handlers)
  const tool = createCodesTool(ctx, config, ctx.logger)

  const value = await tool.execute({ repo: dir, change: { ref: head } }, exec)
  assert.equal(value.ok, true)
  assert.deepEqual(value.counts, { total: 2, debug: 1, quality: 1, disabled: 0 })
  assert.deepEqual(value.codes.map((code) => code.code), ['D001', 'Q002'])
  assert.ok(
    value.warnings.some((warning) => warning.includes('Q001→D001')),
    '丢弃原因要写出来',
  )

  const registered = []
  const toolsCtx = { tools: { register: (definition) => registered.push(definition) } }
  const outcome = registerTools(ctx, toolsCtx, config, ctx.logger)
  assert.deepEqual(outcome.failed, [])
  assert.deepEqual(outcome.registered.sort(), ['coder_codes', 'coder_debug', 'coder_triage'])
  const codes = registered.find((definition) => definition.name === 'coder_codes')
  assert.deepEqual(codes.parameters.properties.action.enum, ['run', 'show', 'targets'])
  assert.equal(codes.parameters.properties.force.type, 'boolean')
  assert.ok(codes.description.includes('codes.jsonl'))
  assert.match(codes.description, /check/, '工具说明里要提到检查类型')
  assert.equal(typeof codes.output.render, 'function')
  const debug = registered.find((definition) => definition.name === 'coder_debug')
  assert.ok(debug.description.includes('coder_codes'), 'debug 里应说明诊断码来自 coder_codes')
})

test('诊断码必须带解决思路：没写就带着问题重来一次，两次都没有就让这次失败', async () => {
  const { dir, head } = await makeRepo()
  const handlers = standardHandlers()
  handlers['codes-debug'] = () => ({
    codes: [
      {
        code: 'D001',
        check: 'runtime',
        severity: 'error',
        rule: '禁止直接使用 console。',
        detect: '运行期观察 console 调用',
      },
    ],
  })
  const fake = makeFakeContext(handlers)
  const tool = createCodesTool(fake.ctx, config, fake.ctx.logger)

  const failed = await tool.execute({ repo: dir, change: { ref: head } }, fake.exec)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'AGENT_INVALID', '两次都没写 fix 才算失败')
  assert.match(failed.message, /fix（解决思路）/)
  const debugCalls = fake.calls.filter((call) => call.name === 'codes-debug')
  assert.equal(debugCalls.length, 2, '打回重来一次')
  assert.match(debugCalls[1].prompt, /上一次的输出不合格/)
  assert.equal(
    await fs.stat(path.join(dir, 'docs', 'codes.jsonl')).catch(() => null),
    null,
    '没写成的文件一个字节都不落盘',
  )
})

test('坏文件原样报错；show 也能读提交里的版本', async () => {
  const { dir, run, head } = await makeRepo()
  const { ctx, exec } = makeFakeContext(standardHandlers())
  const tool = createCodesTool(ctx, config, ctx.logger)

  // ① 坏 JSON：直接报行号，show 把问题列出来
  await fs.writeFile(path.join(dir, 'docs', 'codes.jsonl'), '{oops}\n', 'utf8')
  const failed = await tool.execute({ repo: dir, change: { ref: head } }, exec)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'BAD_CODES_FILE')
  assert.match(failed.message, /第 1 行/)

  const shown = await tool.execute({ action: 'show', repo: dir }, exec)
  assert.equal(shown.files[0].status, 'bad')
  assert.match(shown.files[0].problems.join('\n'), /第 1 行/)

  // ② 只有提交里有：工作区那份删掉也能读
  await writeOneCode(path.join(dir, 'docs', 'codes.jsonl'), 'D001')
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'add codes'])
  const committed = run(['rev-parse', 'HEAD']).trim()
  assert.notEqual(committed, head)
  await fs.rm(path.join(dir, 'docs', 'codes.jsonl'))

  const fromCommit = await tool.execute({ action: 'show', repo: dir }, exec)
  assert.equal(fromCommit.files.length, 1)
  assert.equal(fromCommit.files[0].source, 'commit')
  assert.equal(fromCommit.files[0].codes[0].code, 'D001')
})
