import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runBuild, runLaunch } from '../src/runner.mjs'
import { exists } from '../src/util.mjs'
import { tempDir } from './helpers.mjs'

const cmd = (entry) => ({ type: 'cmd', entry, args: {} })
const write = (dir, name, text) => fs.writeFile(path.join(dir, name), text, 'utf8')
const made = (name) => `import { writeFileSync } from 'node:fs'\nwriteFileSync('${name}','1')\n`

test('构建：成功记录 ok，没有步骤就是跳过，失败记退出码而不是抛异常', async () => {
  const dir = await tempDir()
  const base = { cwd: dir, logDir: path.join(dir, 'build'), maxLogBytes: 4_096 }

  const ok = await runBuild({ ...base, steps: [cmd('node -v')], timeoutMs: 20_000 })
  assert.equal(ok.ok, true)
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.ran, 1)
  assert.ok(await exists(path.join(dir, 'build', 'stdout.log')))

  const skipped = await runBuild({ ...base, steps: [], timeoutMs: 1_000 })
  assert.equal(skipped.skipped, true)
  assert.equal(skipped.ok, true)

  await write(dir, 'fail.mjs', 'process.exit(3)\n')
  const failed = await runBuild({ ...base, steps: [cmd('node fail.mjs')], timeoutMs: 20_000, logDir: path.join(dir, 'b2') })
  assert.equal(failed.ok, false)
  assert.equal(failed.exitCode, 3)
})

test('构建步骤按顺序执行，一步失败就停', async () => {
  const dir = await tempDir()
  await write(dir, 'a.mjs', made('a.txt'))
  await write(dir, 'b.mjs', made('b.txt'))
  await write(dir, 'fail.mjs', 'process.exit(4)\n')
  await write(dir, 'after.mjs', made('after.txt'))
  const base = { cwd: dir, timeoutMs: 20_000, maxLogBytes: 4_096 }

  const ordered = await runBuild({ ...base, steps: [cmd('node a.mjs'), cmd('node b.mjs')], logDir: path.join(dir, 'build') })
  assert.equal(ordered.ok, true)
  assert.equal(ordered.ran, 2)
  assert.ok(await exists(path.join(dir, 'a.txt')))
  assert.ok(await exists(path.join(dir, 'b.txt')))
  assert.ok(await exists(path.join(dir, 'build', 'step-2', 'stdout.log')))

  const stopped = await runBuild({ ...base, steps: [cmd('node fail.mjs'), cmd('node after.mjs')], logDir: path.join(dir, 'b2') })
  assert.equal(stopped.ok, false)
  assert.equal(stopped.exitCode, 4)
  assert.equal(stopped.ran, 1)
  assert.equal(stopped.failedStep, 'node fail.mjs')
  assert.equal(await exists(path.join(dir, 'after.txt')), false, '后面那步不再跑')
})

test('launch：步骤按顺序跑完；超时会被杀掉并留下日志', async () => {
  const dir = await tempDir()
  await write(dir, 'prep.mjs', made('prep.txt'))
  await write(dir, 'app.mjs', made('app.txt'))
  const env = { CODER_LOG_DIR: path.join(dir, 'logs') }
  const base = { cwd: dir, maxLogBytes: 4_096, env }

  const ran = await runLaunch({
    ...base,
    steps: [cmd('node prep.mjs'), cmd('node app.mjs')],
    timeoutMs: 20_000,
    logDir: path.join(dir, 'run'),
  })
  assert.equal(ran.timedOut, false)
  assert.equal(ran.exitCode, 0)
  assert.equal(ran.steps.length, 2)
  assert.ok(await exists(path.join(dir, 'prep.txt')))
  assert.ok(await exists(path.join(dir, 'app.txt')))

  await write(dir, 'slow.mjs', 'setTimeout(() => {}, 60_000)\n')
  const started = Date.now()
  const killed = await runLaunch({
    ...base,
    steps: [cmd('node slow.mjs')],
    timeoutMs: 800,
    logDir: path.join(dir, 'run2'),
  })
  assert.equal(killed.timedOut, true)
  assert.ok(Date.now() - started < 20_000)
  assert.ok(await exists(path.join(dir, 'run2', 'stdout.log')))
})

test('dsh-plugin 步骤：调那个工具，{{worktree}} 已替换，失败算这一步失败', async () => {
  const dir = await tempDir()
  const calls = []
  const ok = await runBuild({
    steps: [{ type: 'dsh-plugin', entry: 'xl_build', args: { paths: ['{{worktree}}/src'], flat: true } }],
    cwd: dir,
    timeoutMs: 20_000,
    logDir: path.join(dir, 'build'),
    maxLogBytes: 4_096,
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { ok: true, text: `built ${args.paths[0]}` }
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'xl_build')
  assert.deepEqual(calls[0].args, { paths: [`${dir}/src`], flat: true })
  assert.match(await fs.readFile(path.join(dir, 'build', 'stdout.log'), 'utf8'), /built .*\/src/)

  const failed = await runBuild({
    steps: [{ type: 'dsh-plugin', entry: 'xl_build', args: {} }, cmd('node -v')],
    cwd: dir,
    timeoutMs: 20_000,
    logDir: path.join(dir, 'b2'),
    maxLogBytes: 4_096,
    callTool: async () => ({ ok: false, text: 'xl_build 报错' }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.ran, 1, '后面那步不再跑')
  assert.equal(failed.failedStep, 'xl_build')

  // 没有 tools 服务：不静默通过
  const noTools = await runBuild({
    steps: [{ type: 'dsh-plugin', entry: 'xl_build', args: {} }],
    cwd: dir,
    timeoutMs: 20_000,
    logDir: path.join(dir, 'b3'),
    maxLogBytes: 4_096,
  })
  assert.equal(noTools.ok, false)
  assert.match(await fs.readFile(path.join(dir, 'b3', 'stderr.log'), 'utf8'), /没有可用的 tools 服务/)
})
