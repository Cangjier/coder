/**
 * 编辑页的 Host 一侧：`/coder/api` 下的接口。
 *
 * 页面是 DSH 里的一个主界面页面（左侧栏「诊断码」，浏览器里），不能碰文件系统；读写都走这里。
 * 路由挂在 `webServer` 上（本机同源），并且只允许落在**已登记的工作区**里的
 * `docs/codes.jsonl`——页面传什么都越不出这个范围。
 *
 * 接口：
 * - `GET  /coder/api/state`  工作区列表 + 默认目录；
 * - `GET  /coder/api/codes?dir=<工作区>`  列出并读出这个工作区里的每一份 codes.jsonl；
 * - `PUT  /coder/api/codes`  校验后原子写回一份 `{ dir, rel, rows }`；
 * - `POST /coder/api/collect`  在目标工作区开一个对话，让它把这条码涉及的
 *   class / interface / method 收集好，结果用 `coder_job` 回填；
 * - `POST /coder/api/debug`   在目标工作区开一个对话，让它跑一次 `coder_debug`；
 * - `GET  /coder/api/reports?dir=<工作区>`  这个工作区**最新**的一次诊断报告：摘要 + 诊断行 + 码快照；
 * - `POST /coder/api/investigate`  开一个对话排查最新报告、出方案（用 `coder_triage` 交回）；
 * - `GET  /coder/api/solutions?dir=<工作区>`  最新一次带方案的运行：`{runId, solutions}`；
 * - `POST /coder/api/fix`  把勾选的方案交给一个对话去真改；
 * - `GET  /coder/api/activity?dir=<工作区>`  页面开出去的排查/解决对话，`running` 说还在不在跑。
 *
 * 「开对话」的接口都把新会话登记在**目标工作区**下（`workspaceId`），
 * 所以它出现在左侧栏那个工作区里，而不是「未分组」。*/
import fs from 'node:fs/promises'
import path from 'node:path'

import { isCodesRel, readCodes, saveCodes, scanCodesFiles } from './codes-files.mjs'
import { readCodesOf, readLatest } from './reports.mjs'
import { readLatestSolutions, readSolutions } from './solutions.mjs'

/** 路由前缀；页面里也拼这个常量。 */
export const API_PREFIX = '/coder/api'

/** 请求体上限：一份 codes.jsonl 最多几 MB 已经到顶了。 */
const MAX_BODY = 4 * 1024 * 1024

/** 页面开出去的「排查 / 解决」对话：最近若干条，`/activity` 用它回显状态（只在内存里）。 */
const launches = []

/**
 * 挂上 `/coder/api` 路由。没有 `webServer`（非 Web profile）时返回一个空 disposer。
 *
 * @param {{ ctx: object, logger?: object, jobs?: object, browsers?: object }} input
 * @returns {() => void}
 */
const clientDebug = new Map()

export function registerCodesApi({ ctx, logger, jobs, browsers }) {
  const webServer = ctx.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('coder: 拿到了 webServer 但上面没有 register，诊断码编辑页接口没挂上')
    return () => {}
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      serve(ctx, jobs, browsers, req, res).catch((error) => {
        const status = error instanceof HttpError ? error.status : 500
        if (status >= 500) {
          logger?.warn?.(`coder: 诊断码接口出错：${error instanceof Error ? error.message : String(error)}`)
        }
        send(res, status, { ok: false, message: error instanceof Error ? error.message : String(error) })
      })
    },
  })
  logger?.info?.(`coder: 诊断码编辑页接口已挂上 ${API_PREFIX}`)
  return dispose
}

/**
 * @param {object} ctx
 * @param {object | undefined} jobs
 * @param {object | undefined} browsers
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function serve(ctx, jobs, browsers, req, res) {
  const url = new URL(String(req.url ?? '/'), 'http://coder.local')
  const route = url.pathname.slice(API_PREFIX.length) || '/'
  const method = String(req.method ?? 'GET').toUpperCase()

  if (route === '/state' && method === 'GET') {
    send(res, 200, { ok: true, ...(await stateOf(ctx)) })
    return
  }

  if (route === '/codes' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const rels = await scanCodesFiles(dir)
    const files = []
    for (const rel of rels) {
      try {
        files.push(await readCodes(dir, rel))
      } catch (error) {
        files.push({
          rel,
          status: 'bad',
          rows: [],
          counts: { total: 0, debug: 0, quality: 0, static: 0, runtime: 0, disabled: 0 },
          problems: [{ line: null, index: -1, field: null, message: `读不到：${error.message}` }],
        })
      }
    }
    send(res, 200, { ok: true, dir, files })
    return
  }

  if (route === '/codes' && (method === 'PUT' || method === 'POST')) {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const rel = String(body.rel ?? '')
    if (!isCodesRel(rel)) throw new HttpError(400, `只支持 <目录>/docs/codes.jsonl，收到：${rel}`)
    const saved = await saveCodes(dir, rel, body.rows)
    send(res, saved.ok ? 200 : 400, { ...saved, dir, rel })
    return
  }

  if (route === '/collect' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const rel = String(body.rel ?? '')
    if (!isCodesRel(rel)) throw new HttpError(400, `只支持 <目录>/docs/codes.jsonl，收到：${rel}`)
    const code = String(body.code ?? '').trim()
    if (!code) throw new HttpError(400, '缺少参数 code')
    if (!jobs) throw new HttpError(503, '插件没有任务表，搜集功能不可用')

    const file = await readCodes(dir, rel).catch((error) => {
      if (error?.code === 'ENOENT') throw new HttpError(404, `${rel} 还不存在，先跑一次 coder_codes`)
      throw error
    })
    const row = (file.rows || []).find((item) => item.code === code)
    if (!row) throw new HttpError(404, `${rel} 里没有 ${code}`)

    // 只开工，不等结果：那个对话跑完会用 coder_job 把 targets 回填到任务表里。
    const started = await startCollect({ ctx, jobs, dir, rel, code, rule: row.rule, detect: row.detect })
    send(res, 202, { ok: true, ...started })
    return
  }

  if (route === '/debug' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    // 开一个对话就返回：诊断本身跑几分钟，页面不该等着。
    const started = await startDebug({ ctx, dir })
    send(res, 202, { ok: true, ...started })
    return
  }

  if (route === '/reports' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const latest = await readLatest(dir)
    // 还没有运行过：不是错误，页面自己显示「还没有诊断报告」。
    send(res, 200, { ok: true, dir, ...(latest ?? { run: null, diagnostics: [], codes: [], truncated: false }) })
    return
  }

  if (route === '/activity' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    send(res, 200, { ok: true, dir, items: await activityOf(ctx, dir) })
    return
  }

  if (route === '/solutions' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const latest = await readLatestSolutions(dir)
    if (!latest) {
      send(res, 200, { ok: true, dir, runId: null, solutions: [], codes: [] })
      return
    }
    send(res, 200, { ok: true, dir, ...latest, codes: await readCodesOf(dir, latest.runId) })
    return
  }

  if (route === '/investigate' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const started = await startInvestigate({ ctx, dir })
    send(res, 202, { ok: true, ...started })
    return
  }

  if (route === '/fix' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const started = await startFix({ ctx, dir, runId: body.runId, ids: body.ids })
    send(res, 202, { ok: true, ...started })
    return
  }

  if (route === '/browser/open' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const state = await callBrowser(() =>
      manager.open(dir, String(body.url ?? ''), {
        width: body.width,
        height: body.height,
        cssWidth: body.cssWidth,
        cssHeight: body.cssHeight,
      }),
    )
    send(res, 200, { ok: true, dir, ...state })
    return
  }

  if (route === '/browser/client' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    clientDebug.set(dir, body)
    send(res, 200, { ok: true })
    return
  }

  if (route === '/browser/state' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const manager = requireBrowsers(browsers)
    send(res, 200, { ok: true, dir, ...manager.state(dir), client: clientDebug.get(dir) ?? null })
    return
  }

  if (route === '/browser/navigate' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    send(res, 200, { ok: true, dir, ...(await callBrowser(() => manager.navigate(dir, String(body.url ?? '')))) })
    return
  }

  if (route === '/browser/reload' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    send(res, 200, { ok: true, dir, ...(await callBrowser(() => manager.reload(dir))) })
    return
  }

  if (route === '/browser/input' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const result = await callBrowser(() => manager.input(dir, body.events))
    send(res, 200, { ok: true, dir, ...result })
    return
  }

  if (route === '/browser/frames' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const manager = requireBrowsers(browsers)
    streamBrowser(manager, dir, req, res)
    return
  }

  if (route === '/browser/cursor' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const cursor = await callBrowser(() => manager.cursorAt(dir, body.x, body.y))
    send(res, 200, { ok: true, dir, cursor })
    return
  }

  if (route === '/browser/viewport' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const state = await callBrowser(() => manager.setViewport(dir, body.width, body.height, body.cssWidth, body.cssHeight))
    send(res, 200, { ok: true, dir, ...state })
    return
  }

  if (route === '/browser/tabs' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const manager = requireBrowsers(browsers)
    const state = manager.state(dir)
    send(res, 200, { ok: true, dir, tabs: state.tabs ?? [], activeId: state.activeId ?? '', url: state.url ?? '' })
    return
  }

  if (route === '/browser/tabs/new' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const state = await callBrowser(() =>
      manager.newTab(dir, String(body.url ?? ''), {
        activate: body.activate !== false,
        width: body.width,
        height: body.height,
        cssWidth: body.cssWidth,
        cssHeight: body.cssHeight,
      }),
    )
    send(res, 200, { ok: true, dir, ...state })
    return
  }

  if (route === '/browser/tabs/activate' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const state = await callBrowser(() => manager.activateTab(dir, String(body.id ?? '')))
    send(res, 200, { ok: true, dir, ...state })
    return
  }

  if (route === '/browser/tabs/close' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const state = await callBrowser(() => manager.closeTab(dir, String(body.id ?? '')))
    send(res, 200, { ok: true, dir, ...state })
    return
  }

  if (route === '/capture/start' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    const result = await callBrowser(() => manager.startCapture(dir, { width: body.width, height: body.height }))
    send(res, 200, { ok: true, dir, ...result })
    return
  }

  if (route === '/capture/stop' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    await callBrowser(() => manager.stopCapture(dir))
    send(res, 200, { ok: true, dir })
    return
  }

  if (route === '/capture/answer' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    await callBrowser(() => manager.acceptAnswer(dir, { sdp: body.sdp, type: body.type }))
    send(res, 200, { ok: true, dir })
    return
  }

  if (route === '/capture/candidate' && method === 'POST') {
    const body = await readJson(req)
    const dir = await resolveWorkspace(ctx, body.dir)
    const manager = requireBrowsers(browsers)
    await callBrowser(() => manager.addCandidate(dir, body.candidate))
    send(res, 200, { ok: true, dir })
    return
  }

  if (route === '/capture/candidates' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const manager = requireBrowsers(browsers)
    send(res, 200, { ok: true, dir, ...manager.captureCandidates(dir, Number(url.searchParams.get('since') || 0)) })
    return
  }

  if (route === '/capture/state' && method === 'GET') {
    const dir = await resolveWorkspace(ctx, url.searchParams.get('dir'))
    const manager = requireBrowsers(browsers)
    send(res, 200, { ok: true, dir, ...manager.captureState(dir) })
    return
  }

  if (route === '/jobs' && method === 'GET') {
    if (!jobs) throw new HttpError(503, '插件没有任务表')
    const dir = url.searchParams.get('dir')
    const rel = url.searchParams.get('rel')
    const filter = {}
    if (dir) filter.dir = await resolveWorkspace(ctx, dir)
    if (rel) filter.rel = String(rel)
    send(res, 200, { ok: true, jobs: jobs.list(filter) })
    return
  }

  const jobMatch = route.match(/^\/jobs\/([A-Za-z0-9_-]+)(\/events)?$/)
  if (jobMatch && method === 'GET') {
    if (!jobs) throw new HttpError(503, '插件没有任务表')
    const job = jobs.get(jobMatch[1])
    if (!job) throw new HttpError(404, `没有这个任务：${jobMatch[1]}（可能已过期）`)
    if (!jobMatch[2]) {
      send(res, 200, { ok: true, job })
      return
    }
    // SSE：先推一次当前状态，任务结束再推一次然后关掉 —— 页面不用轮询。
    streamJob(jobs, job, req, res)
    return
  }

  throw new HttpError(404, `没有这个接口：${method} ${url.pathname}`)
}

/**
 * 一条任务的 SSE 通道：`data: <job JSON>`，任务结束后关闭。
 *
 * @param {object} jobs
 * @param {object} job
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function streamJob(jobs, job, req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const write = (value) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(value)}\n\n`)
  }
  write(job)
  if (job.status !== 'running') {
    res.end()
    return
  }

  const unsubscribe = jobs.subscribe(job.id, (finished) => {
    write(finished)
    res.end()
  })
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n')
  }, 20_000)
  keepAlive.unref?.()

  req.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

/**
 * 在目标工作区开一个对话，让它把这条码涉及的 class / interface / method 收集好，
 * **结果走 coder_job 回填到任务表** —— 不写文件：要不要保存由页面上的人决定。
 *
 * 走的是宿主自己的会话（`sessionController`），所以它出现在左侧栏里，是一个正常的对话，
 * 用的也是当前默认模型。这里只负责投递任务，不等结果。
 *
 * @param {{
 *   ctx: object, jobs: object, dir: string, rel: string, code: string,
 *   rule: string, detect: string,
 * }} input
 * @returns {Promise<{ jobId: string, sessionId: string }>}
 */
async function startCollect(input) {
  const { ctx, jobs } = input
  const controller = ctx.get?.('sessionController')
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new HttpError(503, '当前 profile 没有 sessionController，开不了工作区对话')
  }

  const sessionId = await openSession(ctx, controller, input.dir)

  const job = jobs.create({ dir: input.dir, rel: input.rel, code: input.code, sessionId })

  // 不设超时：那个对话要读多久的代码就让它读多久，页面等的是 `coder_job` 的回填，
  // 不是「多少秒内必须回」。任务只按 TTL 清理（见 src/jobs.mjs）。
  const lifetime = new AbortController()
  try {
    await controller.prompt(
      {
        requestId: `coder-collect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: collectPrompt({ ...input, jobId: job.id }) }],
      },
      lifetime.signal,
    )
  } catch (error) {
    jobs.finish(job.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw new HttpError(502, `投递任务失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { jobId: job.id, sessionId }
}

/**
 * 「发起排查」：在目标工作区开一个对话，让它逐条判断最新那次的诊断是真是假（先排误报），
 * 只对真实问题给出解决方案，最后用 `coder_triage` 把方案交回来（写进这次运行目录）。
 *
 * @param {{ ctx: object, dir: string }} input
 * @returns {Promise<{ sessionId: string, runId: string }>}
 */
async function startInvestigate(input) {
  const { ctx, dir } = input
  const latest = await readLatest(dir)
  const runId = String(latest?.run?.runId ?? '')
  if (!runId) throw new HttpError(400, '这个工作区还没有诊断报告，先点一次「发起诊断」')

  const controller = ctx.get?.('sessionController')
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new HttpError(503, '当前 profile 没有 sessionController，开不了工作区对话')
  }

  const sessionId = await openSession(ctx, controller, dir)
  const lifetime = new AbortController()
  try {
    await controller.prompt(
      {
        requestId: `coder-triage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: investigatePrompt({ dir, runId, diagnostics: latest.diagnostics.length }) }],
      },
      lifetime.signal,
    )
  } catch (error) {
    throw new HttpError(502, `投递任务失败：${error instanceof Error ? error.message : String(error)}`)
  }
  rememberLaunch({ kind: 'triage', dir, runId, sessionId })
  return { sessionId, runId }
}

/**
 * 「对勾选的发起正式解决」：在目标工作区开一个对话，把选中的方案交给它去改代码。
 *
 * @param {{ ctx: object, dir: string, runId?: unknown, ids?: unknown }} input
 * @returns {Promise<{ sessionId: string, runId: string, count: number }>}
 */
async function startFix(input) {
  const { ctx, dir } = input
  const wantedRun = String(input.runId ?? '').trim()
  const runId = wantedRun || String((await readLatestSolutions(dir))?.runId ?? '')
  if (!runId) throw new HttpError(400, '还没有解决方案：先在诊断报告页点「发起排查」')

  const all = await readSolutions(dir, runId)
  const wanted = Array.isArray(input.ids) ? input.ids.map((id) => Number(id)).filter(Number.isFinite) : []
  if (wanted.length === 0) throw new HttpError(400, '没有勾选任何方案')
  const picked = all.filter((item) => wanted.includes(Number(item.id)))
  if (picked.length === 0) throw new HttpError(400, `勾选的方案不在这份报告里：${wanted.join(', ')}`)

  const controller = ctx.get?.('sessionController')
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new HttpError(503, '当前 profile 没有 sessionController，开不了工作区对话')
  }

  const sessionId = await openSession(ctx, controller, dir)
  const lifetime = new AbortController()
  try {
    await controller.prompt(
      {
        requestId: `coder-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: fixPrompt({ dir, runId, solutions: picked }) }],
      },
      lifetime.signal,
    )
  } catch (error) {
    throw new HttpError(502, `投递任务失败：${error instanceof Error ? error.message : String(error)}`)
  }
  rememberLaunch({ kind: 'fix', dir, runId, sessionId })
  return { sessionId, runId, count: picked.length }
}

/**
 * 页面开出去、值得在页面上回显状态的那几次对话（排查 / 解决）：最近若干条，只看这个工作区。
 *
 * 每条都问一次宿主的会话状态，`running` 是 `判断结果`：true 还在跑、false 已经结束、
 * null 问不到（老 profile 没有 `sessionController.state`）。
 *
 * @param {object} ctx
 * @param {string} dir
 * @returns {Promise<Array<object>>}
 */
async function activityOf(ctx, dir) {
  const mine = launches.filter((item) => samePath(item.dir, dir)).slice(-8).reverse()
  const items = []
  for (const item of mine) {
    items.push({ ...item, running: await runningOf(ctx, item.sessionId) })
  }
  return items
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<boolean | null>}
 */
async function runningOf(ctx, sessionId) {
  const controller = ctx.get?.('sessionController')
  if (!controller || typeof controller.state !== 'function') return null
  try {
    const state = await controller.state({ sessionId })
    return Boolean(state?.running)
  } catch {
    return null
  }
}

/**
 * 记下「页面刚开出去的那个对话」，`/activity` 读它。
 *
 * 只在内存里：Host 重启后这里就空了，页面那边还留着自己的一份（localStorage），照样有提示。
 *
 * @param {{ kind: string, dir: string, runId?: string, sessionId: string }} input
 * @returns {void}
 */
function rememberLaunch(input) {
  launches.push({
    kind: String(input.kind ?? ''),
    dir: input.dir,
    runId: String(input.runId ?? ''),
    sessionId: String(input.sessionId ?? ''),
    at: Date.now(),
  })
  while (launches.length > 20) launches.shift()
}

/**
 * 交给那个对话的任务说明：逐条排查（先排误报），只对真实问题出方案，用 `coder_triage` 交回。
 *
 * @param {{ dir: string, runId: string, diagnostics: number }} input
 * @returns {string}
 */
function investigatePrompt(input) {
  return [
    `在这个工作区里排查最新一次诊断报告（工作区目录 ${input.dir}，这次运行 ${input.runId}）。`,
    '',
    '报告在 `.coder/runs/<runId>/`：',
    '- `diagnostics.jsonl` 是每条诊断（`id`、`code`、`file`、`line`、`message`、`steps`、`verification`、`repro`）；',
    '- `codes.jsonl` 是这次用的诊断码（每条码的 `rule` 是规范原文、`targets` 是涉及范围）。',
    '',
    '怎么做：',
    '1. 逐条核对，**先排除误报**：证据不足、`verification` 是 uncertain、代码与规则对不上、规则本身不适用于这段代码 —— 这些不要出现在方案里。',
    '2. 只对确认是真实问题的写解决方案：说清楚属于哪个码、问题是什么（引用文件:行）、怎么改（具体到文件/函数/做法）、涉及哪些文件、风险与把握。',
    '3. 做完**必须**调用工具 coder_triage 交方案：',
    `   {"action":"submit","repo":${JSON.stringify(input.dir)},"runId":${JSON.stringify(input.runId)},"solutions":[{"code":"D001","title":"一句话","problem":"为什么是真问题","fix":"怎么改","files":["src/a.mjs"],"risk":"low","confidence":"high"}]}`,
    '4. 一个真实问题都没有，就交空方案（`"solutions":[]` 会被拒），改为在回答里说明为什么全是误报。',
    '',
    '这一轮**不要改任何源文件**：只排查、出方案。改不改由用户在页面上勾选决定。',
  ].join('\n')
}

/**
 * 交给那个对话的任务说明：把勾选的方案真的改掉。
 *
 * @param {{ dir: string, runId: string, solutions: Array<object> }} input
 * @returns {string}
 */
function fixPrompt(input) {
  const lines = [
    `在这个工作区里正式解决下面 ${input.solutions.length} 个问题（工作区目录 ${input.dir}，来自运行 ${input.runId}）。`,
    '',
    '用户勾选的方案：',
  ]
  for (const item of input.solutions) {
    lines.push('')
    lines.push(`【#${item.id}${item.code ? ` ${item.code}` : ''}】${item.title}`)
    if (item.problem) lines.push(`- 问题：${item.problem}`)
    if (item.fix) lines.push(`- 方案：${item.fix}`)
    if (Array.isArray(item.files) && item.files.length > 0) lines.push(`- 涉及：${item.files.join('、')}`)
    const tags = [item.risk ? `风险 ${item.risk}` : '', item.confidence ? `把握 ${item.confidence}` : '']
    if (tags.filter(Boolean).length > 0) lines.push(`- ${tags.filter(Boolean).join(' · ')}`)
  }
  lines.push(
    '',
    '要求：',
    '1. 真的改代码，不要只写说明；按方案改，遇到方案不对就在回答里说明并按实际情况改。',
    '2. 改完跑相关的测试/构建确认，把它们的结果写出来。',
    '3. 不要动 `.coder/runs/` 里的历史报告，也不要改 `docs/codes.jsonl`。',
    '4. 最后逐条说：这个方案改了什么文件、为什么、验证结果。',
  )
  return lines.join('\n')
}

/**
 * 在目标工作区里开一个新对话，并把任务说明投给它。
 *
 * 新会话带上 `workspaceId`，所以它被登记在目标工作区下面（左侧栏那个分组里），
 * 而不是落到「未分组」。两者只能给一个（宿主会拒绝同时给 `workspaceId` 和 `cwd`）：
 * 给了 `workspaceId`，工作目录就是那个工作区的路径。
 *
 * @param {{ ctx: object, dir: string }} input
 * @returns {Promise<{ sessionId: string }>}
 */
async function startDebug(input) {
  const { ctx, dir } = input
  const controller = ctx.get?.('sessionController')
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new HttpError(503, '当前 profile 没有 sessionController，开不了工作区对话')
  }

  const sessionId = await openSession(ctx, controller, dir)
  const lifetime = new AbortController()
  try {
    await controller.prompt(
      {
        requestId: `coder-debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: debugPrompt({ dir }) }],
      },
      lifetime.signal,
    )
  } catch (error) {
    throw new HttpError(502, `投递任务失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { sessionId }
}

/**
 * 建一个会话：先把这个目录对应的 workspace 认出来（没有就登记一个），
 * 再把 `workspaceId` 交给 `sessionController.create`。
 *
 * 两者只能给一个（宿主会拒绝同时给）：给了 `workspaceId`，工作目录就是那个工作区的路径。
 * 认不出 workspace 时退回只带 `cwd`：对话仍然开在正确的目录里，只是会显示成「未分组」。
 *
 * @param {object} ctx
 * @param {object} controller
 * @param {string} dir
 * @returns {Promise<string>} 新会话的 id
 */
async function openSession(ctx, controller, dir) {
  const workspaceId = await workspaceIdFor(ctx, dir)
  const created = await controller.create(workspaceId ? { workspaceId } : { cwd: dir })
  const sessionId = String(created?.sessionId ?? '')
  if (!sessionId) throw new HttpError(502, '新建会话没有返回 sessionId')
  return sessionId
}

/**
 * 目录 → 已登记工作区的 id。
 *
 * 先问 `workspaceRegistry.resolveByPath`（同一路径下已有工作区时就是它）；
 * 没有登记过就让 `workspaceController.create` 登记一个 —— 它对这个目录是幂等的。
 * 两个服务都不在（非 Web profile / 老版本）就返回空串，调用方退回只带 `cwd`。
 *
 * @param {object} ctx
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function workspaceIdFor(ctx, dir) {
  const registry = ctx.get?.('workspaceRegistry')
  if (registry && typeof registry.resolveByPath === 'function') {
    try {
      const found = await registry.resolveByPath(dir)
      if (found?.id) return String(found.id)
    } catch {
      // 查不到就当没登记：下面会建一个
    }
  }

  const controller = ctx.get?.('workspaceController')
  if (controller && typeof controller.create === 'function') {
    try {
      const made = await controller.create({ path: dir })
      const id = made?.workspace?.workspaceId
      if (id) return String(id)
    } catch {
      // 登记不了就算了：对话照样能开，只是没有分组
    }
  }
  return ''
}

/**
 * 交给那个对话的任务说明：跑一次 `coder_debug`，然后用人话讲结论。
 *
 * @param {{ dir: string }} input
 * @returns {string}
 */
function debugPrompt(input) {
  return [
    `在这个工作区里跑一次代码诊断（工作区目录就是 ${input.dir}）。`,
    '',
    '怎么做：',
    `1. 调用工具 coder_debug：{"repo":${JSON.stringify(input.dir)}}。不传 change 就是整个仓库；它自己会找规范文档和 codes.jsonl。`,
    '2. 如果它说还没有 codes.jsonl，先调用 coder_codes 生成，再跑 coder_debug。',
    '3. 跑完把结论讲给我听：每条诊断是什么问题、为什么成立、严重程度、大概要改哪里。讲重点，别贴整个文件。',
    '',
    '除了 coder_debug 自己的产物（.coder/runs/<runId>/），不要改仓库里的文件。',
  ].join('\n')
}

/**
 * 交给那个对话的任务说明：**用 coder_job 交结果，不改任何文件**。
 *
 * @param {{ dir: string, rel: string, code: string, rule: string, detect: string, jobId: string }} input
 * @returns {string}
 */
function collectPrompt(input) {
  return [
    `在工作区里找出「诊断码 ${input.code}」涉及的 class / interface / method（这个工作区就是 ${input.dir}）。`,
    '',
    `诊断码 ${input.code}：`,
    `- rule：${input.rule}`,
    `- detect：${input.detect}`,
    '',
    '怎么做：',
    '1. 读这个工作区的代码，找出这条规则真正落在哪些 class / interface / method 上；只写你确实找到了定义的对象，别猜。',
    '2. 能写精确名字就写（`Type`、`Type#member`、`Type.member`）；只能看出范围的，写一句描述（例如「所有 XxxService」「带重试的 RPC 调用」）。不要写文件路径。',
    `3. 做完**必须**调用工具 coder_job 把结果交回去：{"action":"submit","jobId":"${input.jobId}","targets":["Session#append"]}。找不到相关对象就调 {"action":"fail","jobId":"${input.jobId}","message":"原因"}。`,
    '',
    '不要修改仓库里的任何文件（包括 codes.jsonl）：要不要保存由用户在页面上决定。',
  ].join('\n')
}

/**
 * 设计页的帧流：`data: {kind:"state"|"frame"|"closed", …}`，一条连接一直推。
 *
 * @param {object} browsers
 * @param {string} dir
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function streamBrowser(browsers, dir, req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const write = (value) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(value)}\n\n`)
  }
  const state = browsers.state(dir)
  if (!state || !state.running) {
    write({ kind: 'closed', running: false })
    res.end()
    return
  }
  // subscribe 会先推一次状态，然后每一帧 / 每次跳转都会推。
  const unsubscribe = browsers.subscribe(dir, write)
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n')
  }, 20_000)
  keepAlive.unref?.()

  req.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

/**
 * @param {object | undefined} browsers
 * @returns {object}
 */
function requireBrowsers(browsers) {
  if (!browsers || typeof browsers.open !== 'function') {
    throw new HttpError(503, '这个 profile 没有无头浏览器管理器，设计页的浏览器不可用')
  }
  return browsers
}

/**
 * 浏览器错误的 code → HTTP 状态码。
 *
 * @param {() => Promise<unknown>} run
 * @returns {Promise<any>}
 */
async function callBrowser(run) {
  try {
    return await run()
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : ''
    if (code === 'NO_BROWSER' || code === 'NO_WEBSOCKET') throw new HttpError(503, error.message)
    if (code === 'BAD_URL') throw new HttpError(400, error.message)
    if (code === 'NOT_OPEN') throw new HttpError(404, error.message)
    if (code) throw new HttpError(502, error.message)
    throw error
  }
}

/**
 * 工作区清单。页面用它做下拉框；`defaultDir` 是当前进程的默认工作目录。
 *
 * @param {object} ctx
 * @returns {Promise<{ defaultDir: string, workspaces: Array<{ id: string, title: string, path: string }> }>}
 */
async function stateOf(ctx) {
  const registry = ctx.get?.('workspaceRegistry')
  let list = []
  try {
    list = typeof registry?.list === 'function' ? registry.list() : []
  } catch {
    list = []
  }
  const workspaces = list.map((item) => ({
    id: String(item.id ?? ''),
    title: String(item.title ?? ''),
    path: String(item.path ?? ''),
  }))

  const working = ctx.get?.('workingDirectory')
  const defaultDir = String(working?.defaultDirectory ?? '')

  if (workspaces.length === 0 && defaultDir) {
    const stat = await fs.stat(defaultDir).catch(() => null)
    if (stat?.isDirectory()) {
      workspaces.push({ id: '', title: path.basename(defaultDir), path: defaultDir })
    }
  }
  return { defaultDir, workspaces }
}

/**
 * 页面给的目录必须是已登记的工作区（或默认工作目录），否则不认。
 *
 * @param {object} ctx
 * @param {unknown} raw
 * @returns {Promise<string>}
 */
async function resolveWorkspace(ctx, raw) {
  const wanted = typeof raw === 'string' ? raw.trim() : ''
  if (!wanted) throw new HttpError(400, '缺少参数 dir')
  const { defaultDir, workspaces } = await stateOf(ctx)
  const candidates = [...workspaces.map((item) => item.path), defaultDir].filter(Boolean)
  const hit = candidates.find((item) => samePath(item, wanted))
  if (!hit) throw new HttpError(403, `目录不在已登记的工作区里：${wanted}`)

  const real = await fs.realpath(hit).catch(() => null)
  if (!real) throw new HttpError(404, `目录不存在：${hit}`)
  return real
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  const left = path.resolve(String(a ?? ''))
  const right = path.resolve(String(b ?? ''))
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<object>}
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('不是对象')
    return value
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON 对象')
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function send(res, status, body) {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 带状态码的错误：只有它的 status 会写进响应，其他异常一律 500。 */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export { HttpError }
