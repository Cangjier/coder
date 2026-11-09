import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { API_PREFIX, registerCodesApi } from '../src/web.mjs'
import { createJobStore } from '../src/jobs.mjs'
import { createJobTool } from '../src/tools/job.mjs'
import { tempDir } from './helpers.mjs'

const ROW = {
  code: 'D001',
  check: 'runtime',
  enabled: true,
  severity: 'error',
  rule: '禁止直接使用 console。',
  detect: '运行期捕获 console 调用',
  targets: [],
}

/**
 * 假 ctx：webServer 把路由记下来，工作区表只有 temp 目录。
 *
 * @param {string} root
 * @param {{ jobs?: object, browsers?: object }} [options]
 * @returns {{ ctx: object, handler: Function }}
 */
function makeCtx(root, options = {}) {
  let handler = null
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            assert.equal(route.kind, 'prefix')
            assert.equal(route.path, API_PREFIX)
            handler = route.handler
            return () => {}
          },
        }
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: 'w1', title: 'demo', path: root }],
          resolveByPath: async (dir) => (path.resolve(dir) === path.resolve(root) ? { id: 'w1' } : undefined),
        }
      }
      if (name === 'workingDirectory') return { defaultDirectory: root }
      return undefined
    },
  }
  registerCodesApi({ ctx, logger: {}, jobs: options.jobs, browsers: options.browsers })
  return { ctx, handler }
}

/**
 * 走一次路由：请求体是可选的 JSON，响应体按 JSON 解回来。
 *
 * @param {Function} handler
 * @param {{ method?: string, url: string, body?: object }} input
 * @returns {Promise<{ status: number, body: any }>}
 */
function call(handler, { method = 'GET', url, body }) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      url,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    const res = {
      headersSent: false,
      writableEnded: false,
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status
      },
      end(text) {
        this.writableEnded = true
        try {
          resolve({ status: this.statusCode, body: JSON.parse(text) })
        } catch (error) {
          reject(error)
        }
      },
    }
    handler(req, res)
  })
}

/**
 * @param {string} root
 * @returns {Promise<void>}
 */
async function seed(root) {
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  await fs.writeFile(path.join(root, 'docs', 'codes.jsonl'), `${JSON.stringify(ROW)}\n`, 'utf8')
}

test('/coder/api/state：给出工作区清单与默认目录', async () => {
  const root = await tempDir('coder-api-')
  const { handler } = makeCtx(root)
  const { status, body } = await call(handler, { url: `${API_PREFIX}/state` })
  assert.equal(status, 200)
  assert.equal(body.defaultDir, root)
  assert.deepEqual(body.workspaces, [{ id: 'w1', title: 'demo', path: root }])
})

test('/coder/api/codes 读：列出并读出工作区里的 codes.jsonl', async () => {
  const root = await tempDir('coder-api-')
  await seed(root)
  const { handler } = makeCtx(root)

  const { status, body } = await call(handler, {
    url: `${API_PREFIX}/codes?dir=${encodeURIComponent(root)}`,
  })
  assert.equal(status, 200)
  assert.equal(body.files.length, 1)
  assert.equal(body.files[0].rel, 'docs/codes.jsonl')
  assert.equal(body.files[0].status, 'ok')
  assert.equal(body.files[0].rows[0].code, 'D001')
  assert.deepEqual(body.files[0].counts, { total: 1, debug: 1, quality: 0, static: 0, runtime: 1, disabled: 0 })
})

test('/coder/api/codes 写：合法就落盘，非法就 400 且一个字节都不写', async () => {
  const root = await tempDir('coder-api-')
  await seed(root)
  const before = await fs.readFile(path.join(root, 'docs', 'codes.jsonl'), 'utf8')
  const { handler } = makeCtx(root)

  const rejected = await call(handler, {
    method: 'PUT',
    url: `${API_PREFIX}/codes`,
    body: { dir: root, rel: 'docs/codes.jsonl', rows: [{ ...ROW, code: 'ZZZ' }] },
  })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.ok, false)
  assert.match(rejected.body.problems[0].message, /应形如/)
  assert.equal(await fs.readFile(path.join(root, 'docs', 'codes.jsonl'), 'utf8'), before)

  const saved = await call(handler, {
    method: 'PUT',
    url: `${API_PREFIX}/codes`,
    body: { dir: root, rel: 'docs/codes.jsonl', rows: [{ ...ROW, enabled: false }] },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.changed, true)
  assert.equal(saved.body.counts.disabled, 1)
  const text = await fs.readFile(path.join(root, 'docs', 'codes.jsonl'), 'utf8')
  assert.match(text, /"enabled":false/)
})

test('/coder/api/collect：只开工，返回 jobId；结果由对话用 coder_job 回填，接口不写文件', async () => {
  const root = await tempDir('coder-api-')
  await seed(root)
  const before = await fs.readFile(path.join(root, 'docs', 'codes.jsonl'), 'utf8')
  const jobs = createJobStore()

  const created = []
  const prompted = []
  let handler = null
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return { register: (route) => { handler = route.handler; return () => {} } }
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: 'w1', title: 'demo', path: root }],
          resolveByPath: async (dir) => (path.resolve(dir) === path.resolve(root) ? { id: 'w1' } : undefined),
        }
      }
      if (name === 'workingDirectory') return { defaultDirectory: root }
      if (name === 'sessionController') {
        return {
          create: async (request) => {
            created.push(request)
            return { sessionId: 'sess-1234' }
          },
          prompt: async (request, signal) => {
            prompted.push({ ...request, signal })
            return { accepted: true }
          },
        }
      }
      return undefined
    },
  }
  registerCodesApi({ ctx, logger: {}, jobs })

  const started = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/collect`,
    body: { dir: root, rel: 'docs/codes.jsonl', code: 'D001' },
  })
  assert.equal(started.status, 202, '只开工，不等结果')
  const jobId = started.body.jobId
  assert.match(jobId, /^job-/)
  assert.equal(started.body.sessionId, 'sess-1234')
  assert.deepEqual(
    created,
    [{ workspaceId: 'w1' }],
    '会话登记在目标工作区下（只给 workspaceId：宿主不允许同时给 cwd），否则左侧栏会显示成「未分组」',
  )

  const text = prompted[0].content[0].text
  assert.match(text, /D001/)
  assert.match(text, /coder_job/)
  assert.match(text, new RegExp(jobId))
  assert.match(text, /不要修改仓库里的任何文件/)
  assert.ok(
    prompted[0].signal && typeof prompted[0].signal.throwIfAborted === 'function',
    'prompt 必须带上生命周期信号，否则实现里会对 undefined 调 throwIfAborted',
  )

  const running = await call(handler, { url: `${API_PREFIX}/jobs/${jobId}` })
  assert.equal(running.status, 200)
  assert.equal(running.body.job.status, 'running')

  // 那个对话完成后调用 coder_job 工具，把结果交回服务端任务表
  const tool = createJobTool(jobs)
  const submitted = await tool.execute({ action: 'submit', jobId, targets: ['Session#append', '所有 XxxService'] })
  assert.equal(submitted.ok, true)

  const done = await call(handler, { url: `${API_PREFIX}/jobs/${jobId}` })
  assert.equal(done.status, 200)
  assert.equal(done.body.job.status, 'done')
  assert.deepEqual([...done.body.job.targets], ['Session#append', '所有 XxxService'])

  const listed = await call(handler, {
    url: `${API_PREFIX}/jobs?dir=${encodeURIComponent(root)}&rel=docs/codes.jsonl`,
  })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.jobs.map((item) => item.id), [jobId])

  assert.equal(
    await fs.readFile(path.join(root, 'docs', 'codes.jsonl'), 'utf8'),
    before,
    '接口不写文件：保不保存由页面决定',
  )

  const expired = await call(handler, { url: `${API_PREFIX}/jobs/job-nope` })
  assert.equal(expired.status, 404)

  const unknown = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/collect`,
    body: { dir: root, rel: 'docs/codes.jsonl', code: 'Q404' },
  })
  assert.equal(unknown.status, 404)
})

test('/coder/api/debug：在目标工作区开一个对话跑 coder_debug，立刻返回 sessionId', async () => {
  const root = await tempDir('coder-api-')
  await seed(root)
  const { created, prompted, handler } = debugHarness(root)

  const started = await call(handler, { method: 'POST', url: `${API_PREFIX}/debug`, body: { dir: root } })
  assert.equal(started.status, 202, '只开会话就返回，不等诊断跑完')
  assert.equal(started.body.sessionId, 'sess-dbg')
  assert.deepEqual(created, [{ workspaceId: 'w1' }], '会话登记在目标工作区下')

  const text = prompted[0].content[0].text
  assert.match(text, /coder_debug/)
  assert.ok(text.includes(await fs.realpath(root)), '任务说明里带着目标目录')
  assert.ok(prompted[0].signal, 'prompt 带着生命周期信号')
})

test('/coder/api/debug：认不出工作区时依次退回「登记一个」和「只带 cwd」', async () => {
  const root = await tempDir('coder-api-')

  // 1. 注册表查不到，但 workspaceController 能登记：用登记出来的 id。
  const registering = debugHarness(root, { resolveByPath: false, workspaceController: true })
  const made = await call(registering.handler, {
    method: 'POST',
    url: `${API_PREFIX}/debug`,
    body: { dir: root },
  })
  assert.equal(made.status, 202)
  assert.deepEqual(registering.created, [{ workspaceId: 'w9' }])

  // 2. 两个服务都没有：仍然开对话，只是没有分组。
  const bare = debugHarness(root, { resolveByPath: false, workspaceController: false })
  const fallback = await call(bare.handler, {
    method: 'POST',
    url: `${API_PREFIX}/debug`,
    body: { dir: root },
  })
  assert.equal(fallback.status, 202)
  assert.deepEqual(bare.created, [{ cwd: await fs.realpath(root) }])
})

test('/coder/api/debug：工作区之外的目录、没有 sessionController 都拒绝', async () => {
  const root = await tempDir('coder-api-')
  const { handler } = debugHarness(root)

  const outside = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/debug`,
    body: { dir: path.join(root, '..') },
  })
  assert.equal(outside.status, 403)

  const noSessions = makeCtx(root)
  const rejected = await call(noSessions.handler, {
    method: 'POST',
    url: `${API_PREFIX}/debug`,
    body: { dir: root },
  })
  assert.equal(rejected.status, 503)
  assert.match(rejected.body.message, /sessionController/)
})

/**
 * 带 sessionController 的假 ctx。
 *
 * @param {string} root
 * @param {{ resolveByPath?: boolean, workspaceController?: boolean }} [options]
 * @returns {{ created: object[], prompted: object[], handler: Function }}
 */
function debugHarness(root, options = {}) {
  const { resolveByPath = true, workspaceController = false } = options
  const created = []
  const prompted = []
  let running = true
  let handler = null
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return { register: (route) => { handler = route.handler; return () => {} } }
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: 'w1', title: 'demo', path: root }],
          ...(resolveByPath
            ? { resolveByPath: async (dir) => (path.resolve(dir) === path.resolve(root) ? { id: 'w1' } : undefined) }
            : {}),
        }
      }
      if (name === 'workspaceController') {
        return workspaceController
          ? { create: async (request) => ({ workspace: { workspaceId: 'w9', path: request.path }, created: true }) }
          : undefined
      }
      if (name === 'workingDirectory') return { defaultDirectory: root }
      if (name === 'sessionController') {
        return {
          create: async (request) => {
            created.push(request)
            return { sessionId: 'sess-dbg' }
          },
          prompt: async (request, signal) => {
            prompted.push({ ...request, signal })
            return { accepted: true }
          },
          state: async () => ({ running }),
        }
      }
      return undefined
    },
  }
  registerCodesApi({ ctx, logger: {} })
  return { created, prompted, handler, setRunning: (value) => { running = value } }
}

test('/coder/api/reports：只回最新一次的摘要、诊断行与码快照；没有运行过就是 run:null，工作区之外 403', async () => {
  const root = await tempDir('coder-api-')
  const { handler } = makeCtx(root)

  const empty = await call(handler, { url: `${API_PREFIX}/reports?dir=${encodeURIComponent(root)}` })
  assert.equal(empty.status, 200)
  assert.equal(empty.body.run, null, '还没有运行过不是错误')
  assert.deepEqual(empty.body.diagnostics, [])

  const oldDir = path.join(root, '.coder', 'runs', '20260101-080000-aaaaaa')
  const newDir = path.join(root, '.coder', 'runs', '20260102-090000-bbbbbb')
  await fs.mkdir(oldDir, { recursive: true })
  await fs.mkdir(newDir, { recursive: true })
  await fs.writeFile(
    path.join(oldDir, 'diagnostics.jsonl'),
    `${JSON.stringify({ id: 1, code: 'D001', severity: 'error', message: '旧的一次' })}\n`,
    'utf8',
  )
  await fs.writeFile(
    path.join(newDir, 'diagnostics.jsonl'),
    `${JSON.stringify({ id: 1, code: 'D001', severity: 'error', file: 'src/a.mjs', line: 7, message: '越界', steps: ['跑一次'] })}\n`,
    'utf8',
  )
  await fs.writeFile(
    path.join(newDir, 'summary.json'),
    JSON.stringify({ ok: true, change: { mode: 'all', head: 'abcdef123456', files: 2 }, verification: { status: 'done', checked: 1, confirmed: 1, uncertain: 0, dropped: 0 } }),
    'utf8',
  )
  await fs.writeFile(
    path.join(newDir, 'codes.jsonl'),
    `${JSON.stringify({ code: 'D001', kind: 'debug', severity: 'error', rule: '禁止直接使用 console。', targets: [] })}\n`,
    'utf8',
  )

  const latest = await call(handler, { url: `${API_PREFIX}/reports?dir=${encodeURIComponent(root)}` })
  assert.equal(latest.status, 200)
  assert.equal(latest.body.run.runId, '20260102-090000-bbbbbb', '只给最新那一次')
  assert.equal(latest.body.diagnostics.length, 1)
  assert.equal(latest.body.diagnostics[0].message, '越界')
  assert.equal(latest.body.codes[0].rule, '禁止直接使用 console。')
  assert.equal(latest.body.run.change.mode, 'all')

  const outside = await call(handler, {
    url: `${API_PREFIX}/reports?dir=${encodeURIComponent(path.join(root, '..'))}`,
  })
  assert.equal(outside.status, 403)

  const missing = await call(handler, { url: `${API_PREFIX}/reports` })
  assert.equal(missing.status, 400)
})

test('/coder/api/solutions + investigate + fix：读方案、发起排查、对勾选的发起解决', async () => {
  const root = await tempDir('coder-api-')
  const runId = '20260101-080000-aaaaaa'
  const runDir = path.join(root, '.coder', 'runs', runId)
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(
    path.join(runDir, 'diagnostics.jsonl'),
    `${JSON.stringify({ id: 1, code: 'D001', severity: 'error', file: 'a.mjs', line: 3, message: '用了 console' })}\n`,
    'utf8',
  )
  await fs.writeFile(
    path.join(runDir, 'codes.jsonl'),
    `${JSON.stringify({ code: 'D001', kind: 'debug', severity: 'error', rule: '禁止直接使用 console。', targets: [] })}\n`,
    'utf8',
  )
  await fs.writeFile(
    path.join(runDir, 'solutions.jsonl'),
    [
      JSON.stringify({ id: 1, code: 'D001', title: '方案一', problem: '问题一', fix: '改 A' }),
      JSON.stringify({ id: 2, code: 'D009', title: '方案二', problem: '问题二', fix: '改 B' }),
    ].join('\n') + '\n',
    'utf8',
  )

  const { created, prompted, handler } = debugHarness(root)

  const listed = await call(handler, { url: `${API_PREFIX}/solutions?dir=${encodeURIComponent(root)}` })
  assert.equal(listed.status, 200)
  assert.equal(listed.body.runId, runId)
  assert.deepEqual(
    [...listed.body.solutions.map((item) => item.id)],
    [1, 2],
  )
  assert.deepEqual(
    [...listed.body.codes.map((item) => item.code)],
    ['D001'],
    '带上这次运行的码快照，左边那列要显示规则原文',
  )

  const triage = await call(handler, { method: 'POST', url: `${API_PREFIX}/investigate`, body: { dir: root } })
  assert.equal(triage.status, 202)
  assert.equal(triage.body.runId, runId)
  const triageText = prompted[0].content[0].text
  assert.match(triageText, /coder_triage/, '要让它用工具交方案')
  assert.match(triageText, new RegExp(runId))
  assert.match(triageText, /先排除误报/)
  assert.match(triageText, /不要改任何源文件/, '这一轮只排查、出方案')

  const fixed = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/fix`,
    body: { dir: root, runId, ids: [2] },
  })
  assert.equal(fixed.status, 202)
  assert.equal(fixed.body.count, 1)
  const fixText = prompted[1].content[0].text
  assert.match(fixText, /方案二/)
  assert.doesNotMatch(fixText, /方案一/, '只交勾选的那个')
  assert.match(fixText, /真的改代码/)

  assert.equal(created.length, 2, '两次各开一个会话')
  assert.deepEqual(created[0], { workspaceId: 'w1' }, '会话登记在目标工作区下')

  const nothing = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/fix`,
    body: { dir: root, runId, ids: [] },
  })
  assert.equal(nothing.status, 400)
  assert.match(nothing.body.message, /没有勾选/)

  const unknown = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/fix`,
    body: { dir: root, runId, ids: [99] },
  })
  assert.equal(unknown.status, 400)
})

test('/coder/api/investigate：还没有诊断报告就 400，不白开对话', async () => {
  const root = await tempDir('coder-api-')
  const { created, handler } = debugHarness(root)

  const failed = await call(handler, { method: 'POST', url: `${API_PREFIX}/investigate`, body: { dir: root } })
  assert.equal(failed.status, 400)
  assert.match(failed.body.message, /还没有诊断报告/)
  assert.equal(created.length, 0)

  const noSolutions = await call(handler, { url: `${API_PREFIX}/solutions?dir=${encodeURIComponent(root)}` })
  assert.equal(noSolutions.status, 200)
  assert.equal(noSolutions.body.runId, null)
  assert.deepEqual(noSolutions.body.solutions, [])
})

test('/coder/api/activity：开出去的排查/解决对话会被记下，running 说还在不在跑', async () => {
  const root = await tempDir('coder-api-')
  const runId = '20260101-080000-aaaaaa'
  const runDir = path.join(root, '.coder', 'runs', runId)
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(
    path.join(runDir, 'diagnostics.jsonl'),
    `${JSON.stringify({ id: 1, code: 'D001', severity: 'error', message: 'x' })}\n`,
    'utf8',
  )
  await fs.writeFile(
    path.join(runDir, 'solutions.jsonl'),
    `${JSON.stringify({ id: 1, code: 'D001', title: '方案一', fix: '改 A' })}\n`,
    'utf8',
  )

  const harness = debugHarness(root)

  const empty = await call(harness.handler, { url: `${API_PREFIX}/activity?dir=${encodeURIComponent(root)}` })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body.items, [])

  await call(harness.handler, { method: 'POST', url: `${API_PREFIX}/investigate`, body: { dir: root } })
  await call(harness.handler, {
    method: 'POST',
    url: `${API_PREFIX}/fix`,
    body: { dir: root, runId, ids: [1] },
  })

  const listed = await call(harness.handler, { url: `${API_PREFIX}/activity?dir=${encodeURIComponent(root)}` })
  assert.equal(listed.status, 200)
  assert.deepEqual(
    [...listed.body.items.map((item) => item.kind)],
    ['fix', 'triage'],
    '最近的在最前',
  )
  assert.equal(listed.body.items[0].runId, runId)
  assert.equal(listed.body.items[0].running, true, '会话还在跑')
  assert.ok(listed.body.items[0].sessionId)
  assert.ok(listed.body.items[0].at)

  harness.setRunning(false)
  const done = await call(harness.handler, { url: `${API_PREFIX}/activity?dir=${encodeURIComponent(root)}` })
  assert.equal(done.body.items[0].running, false, '结束后就不是 running')
})

test('/coder/api/codes：工作区之外、非 codes.jsonl、缺参数、未知路由都按状态码拒绝', async () => {
  const root = await tempDir('coder-api-')
  await seed(root)
  const { handler } = makeCtx(root)

  const outside = await call(handler, {
    url: `${API_PREFIX}/codes?dir=${encodeURIComponent(path.join(root, '..'))}`,
  })
  assert.equal(outside.status, 403)
  assert.match(outside.body.message, /不在已登记的工作区/)

  const missing = await call(handler, { url: `${API_PREFIX}/codes` })
  assert.equal(missing.status, 400)

  const wrongRel = await call(handler, {
    method: 'PUT',
    url: `${API_PREFIX}/codes`,
    body: { dir: root, rel: 'src/app.mjs', rows: [] },
  })
  assert.equal(wrongRel.status, 400)
  assert.match(wrongRel.body.message, /docs\/codes\.jsonl/)

  const unknown = await call(handler, { url: `${API_PREFIX}/nope` })
  assert.equal(unknown.status, 404)
})

test('/coder/api/browser/*：打开、状态、导航、重载、输入；没有管理器 503、工作区之外 403', async () => {
  const root = await tempDir('coder-api-')
  const calls = []
  const state = { running: false, url: '', title: '', width: 1280, height: 800, seq: 0, frame: null }
  const view = (url) => ({ running: true, url, title: '', width: 1280, height: 800, seq: 0, frame: null })
  const browsers = {
    open: async (dir, url) => {
      calls.push(['open', dir, url])
      return view(url)
    },
    state: () => state,
    navigate: async (dir, url) => {
      calls.push(['navigate', dir, url])
      return view(url)
    },
    reload: async (dir) => {
      calls.push(['reload', dir])
      return view('https://a.feishu.cn/docx/1')
    },
    input: async (dir, events) => {
      calls.push(['input', dir, events])
      return { accepted: events.length }
    },
    subscribe: () => () => {},
  }
  const { handler } = makeCtx(root, { browsers })
  const real = await fs.realpath(root)

  const opened = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/open`,
    body: { dir: root, url: 'https://abc.feishu.cn/docx/1' },
  })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.running, true)
  assert.equal(opened.body.url, 'https://abc.feishu.cn/docx/1')
  assert.deepEqual(calls[0], ['open', real, 'https://abc.feishu.cn/docx/1'])

  const current = await call(handler, { url: `${API_PREFIX}/browser/state?dir=${encodeURIComponent(root)}` })
  assert.equal(current.status, 200)
  assert.equal(current.body.running, false)

  const navigated = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/navigate`,
    body: { dir: root, url: 'https://b.feishu.cn/docx/2' },
  })
  assert.equal(navigated.status, 200)
  assert.deepEqual(calls[1], ['navigate', real, 'https://b.feishu.cn/docx/2'])

  const reloaded = await call(handler, { method: 'POST', url: `${API_PREFIX}/browser/reload`, body: { dir: root } })
  assert.equal(reloaded.status, 200)
  assert.deepEqual(calls[2], ['reload', real])

  const typed = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/input`,
    body: { dir: root, events: [{ type: 'text', text: 'x' }] },
  })
  assert.equal(typed.status, 200)
  assert.equal(typed.body.accepted, 1)

  // 没有管理器：503（非 Web profile 的老情况）
  const bare = makeCtx(root)
  const denied = await call(bare.handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/open`,
    body: { dir: root, url: 'https://x.feishu.cn/' },
  })
  assert.equal(denied.status, 503)
  assert.match(denied.body.message, /无头浏览器/)

  // 浏览器错误按 code 映射状态码
  const badUrl = new Error('不是可导航的地址')
  badUrl.code = 'BAD_URL'
  const failing = makeCtx(root, {
    browsers: {
      ...browsers,
      open: async () => {
        throw badUrl
      },
    },
  })
  const rejected = await call(failing.handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/open`,
    body: { dir: root, url: 'file:///x' },
  })
  assert.equal(rejected.status, 400)

  const outside = await call(handler, {
    url: `${API_PREFIX}/browser/state?dir=${encodeURIComponent(path.join(root, '..'))}`,
  })
  assert.equal(outside.status, 403)
})

test('没有 webServer 的 profile：什么都不注册，也不抛异常', () => {
  const disposer = registerCodesApi({ ctx: { get: () => undefined }, logger: {} })
  assert.equal(typeof disposer, 'function')
  assert.doesNotThrow(() => disposer())
})

test('/coder/api/browser/tabs 与 /capture/*：多标签与捕获信令', async () => {
  const root = await tempDir('coder-tabs-')
  const calls = []
  const tabs = [{ id: 't1', url: 'https://a.feishu.cn/docx/1', title: 'A', active: true }]
  const view = (extra = {}) => ({
    running: true,
    url: tabs.find((tab) => tab.active)?.url ?? '',
    title: '',
    width: 800,
    height: 600,
    seq: 0,
    tabs: tabs.map((tab) => ({ ...tab })),
    activeId: tabs.find((tab) => tab.active)?.id ?? '',
    ...extra,
  })
  const browsers = {
    open: async () => view(),
    state: () => view(),
    subscribe: () => () => {},
    newTab: async (dir, url) => {
      calls.push(['newTab', dir, url])
      tabs.forEach((tab) => {
        tab.active = false
      })
      tabs.push({ id: 't2', url, title: 'B', active: true })
      return view()
    },
    activateTab: async (dir, id) => {
      calls.push(['activate', dir, id])
      tabs.forEach((tab) => {
        tab.active = tab.id === id
      })
      return view()
    },
    closeTab: async (dir, id) => {
      calls.push(['close', dir, id])
      const index = tabs.findIndex((tab) => tab.id === id)
      tabs.splice(index, 1)
      if (!tabs.some((tab) => tab.active) && tabs[0]) tabs[0].active = true
      return view()
    },
    startCapture: async (dir) => {
      calls.push(['startCapture', dir])
      return { offer: { sdp: 'v=0', type: 'offer' }, width: 800, height: 600 }
    },
    stopCapture: async (dir) => {
      calls.push(['stopCapture', dir])
      return true
    },
    acceptAnswer: async (dir, answer) => {
      calls.push(['answer', dir, answer.sdp])
    },
    addCandidate: async (dir, candidate) => {
      calls.push(['candidate', dir, candidate.candidate])
    },
    captureCandidates: () => ({ list: [{ candidate: 'c1' }], next: 1 }),
    captureState: () => ({ active: true, state: 'offered', width: 800, height: 600, offered: true }),
    cursorAt: async (dir, x, y) => {
      calls.push(['cursor', dir, x, y])
      return 'pointer'
    },
    setViewport: async (dir, width, height) => {
      calls.push(['viewport', dir, width, height])
      return view({ width, height })
    },
  }
  const { handler } = makeCtx(root, { browsers })

  const tabsList = await call(handler, { url: `${API_PREFIX}/browser/tabs?dir=${encodeURIComponent(root)}` })
  assert.equal(tabsList.status, 200)
  assert.equal(tabsList.body.tabs.length, 1)

  const created = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/tabs/new`,
    body: { dir: root, url: 'https://b.feishu.cn/' },
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.tabs.length, 2)
  assert.equal(created.body.url, 'https://b.feishu.cn/')

  const activated = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/tabs/activate`,
    body: { dir: root, id: 't1' },
  })
  assert.equal(activated.status, 200)
  assert.equal(activated.body.activeId, 't1')

  const closed = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/tabs/close`,
    body: { dir: root, id: 't2' },
  })
  assert.equal(closed.status, 200)
  assert.equal(closed.body.tabs.length, 1)

  const cursor = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/cursor`,
    body: { dir: root, x: 12, y: 34 },
  })
  assert.equal(cursor.status, 200)
  assert.equal(cursor.body.cursor, 'pointer')

  const sized = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/browser/viewport`,
    body: { dir: root, width: 1240, height: 780 },
  })
  assert.equal(sized.status, 200)
  assert.equal(sized.body.width, 1240)

  const started = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/capture/start`,
    body: { dir: root },
  })
  assert.equal(started.status, 200)
  assert.equal(started.body.offer.sdp, 'v=0')
  assert.equal(started.body.width, 800)
  assert.ok(calls.some((item) => item[0] === 'startCapture'))

  const answered = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/capture/answer`,
    body: { dir: root, sdp: 'v=0 answer', type: 'answer' },
  })
  assert.equal(answered.status, 200)
  assert.ok(calls.some((item) => item[0] === 'answer' && item[2] === 'v=0 answer'))

  const candidate = await call(handler, {
    method: 'POST',
    url: `${API_PREFIX}/capture/candidate`,
    body: { dir: root, candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } },
  })
  assert.equal(candidate.status, 200)

  const list = await call(handler, {
    url: `${API_PREFIX}/capture/candidates?dir=${encodeURIComponent(root)}&since=0`,
  })
  assert.equal(list.status, 200)
  assert.equal(list.body.list.length, 1)

  const stop = await call(handler, { method: 'POST', url: `${API_PREFIX}/capture/stop`, body: { dir: root } })
  assert.equal(stop.status, 200)
  assert.ok(calls.some((item) => item[0] === 'stopCapture'))

  // 没有管理器：503
  const bare = makeCtx(root)
  const denied = await call(bare.handler, {
    method: 'POST',
    url: `${API_PREFIX}/capture/start`,
    body: { dir: root },
  })
  assert.equal(denied.status, 503)
})
