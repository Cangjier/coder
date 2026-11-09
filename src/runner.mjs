/**
 * 步骤执行：`cmd` 起子进程，`dsh-plugin` 交给调用方注入的 callTool 去调 DSH 工具。
 *
 * 编译与运行都是「一串步骤」：超时杀进程树，日志头尾截断，每一步各留一份日志。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { withWorktree } from './program.mjs'
import { nowIso } from './util.mjs'

class Capture {
  /**
   * @param {number} limit
   */
  constructor(limit) {
    this.limit = limit
    this.head = Buffer.alloc(0)
    this.tail = Buffer.alloc(0)
    this.bytes = 0
  }

  /**
   * @param {Buffer} chunk
   */
  push(chunk) {
    this.bytes += chunk.length
    if (this.head.length < this.limit) {
      const room = this.limit - this.head.length
      this.head = Buffer.concat([this.head, chunk.subarray(0, room)])
      chunk = chunk.subarray(Math.min(room, chunk.length))
    }
    if (chunk.length) {
      this.tail = Buffer.concat([this.tail, chunk])
      if (this.tail.length > this.limit) this.tail = this.tail.subarray(this.tail.length - this.limit)
    }
  }

  /** @returns {string} */
  text() {
    if (this.tail.length === 0) return this.head.toString('utf8')
    const head = this.head.toString('utf8')
    const tail = this.tail.toString('utf8')
    const dropped = this.bytes - this.head.length - this.tail.length
    return dropped > 0 ? `${head}\n...[已截断 ${dropped} 字节]...\n${tail}` : head + tail
  }
}

/**
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已退出。
    }
  }
}

/**
 * 每一步的日志：stdout / stderr / process.json，形状对 cmd 与 dsh-plugin 都一样。
 *
 * @param {object} result
 * @param {string} logDir
 * @returns {Promise<object>}
 */
async function writeLogs(result, logDir) {
  try {
    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(path.join(logDir, 'stdout.log'), result.stdoutText ?? '', 'utf8')
    await fs.writeFile(path.join(logDir, 'stderr.log'), result.stderrText ?? '', 'utf8')
    await fs.writeFile(
      path.join(logDir, 'process.json'),
      JSON.stringify({ ...result, stdoutText: undefined, stderrText: undefined }, null, 2),
      'utf8',
    )
    result.logs = {
      dir: logDir,
      stdout: path.join(logDir, 'stdout.log'),
      stderr: path.join(logDir, 'stderr.log'),
    }
  } catch (error) {
    result.logError = error instanceof Error ? error.message : String(error)
  }
  return result
}

/**
 * 跑一条 shell 命令。
 *
 * @param {{
 *   file: string, args?: string[], cwd: string, env?: Record<string, string>,
 *   timeoutMs: number, shell?: boolean, logDir: string, maxLogBytes: number,
 * }} options
 * @returns {Promise<object>}
 */
export function runProcess(options) {
  const { file, args = [], cwd, env, timeoutMs, shell = false, logDir, maxLogBytes } = options
  return new Promise((resolve) => {
    const startedAt = nowIso()
    const started = Date.now()
    const stdout = new Capture(maxLogBytes)
    const stderr = new Capture(maxLogBytes)
    let settled = false
    let timedOut = false
    let timer = null
    let graceTimer = null

    const child = spawn(file, args, {
      cwd,
      env: env ?? process.env,
      shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    const finish = async (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      const code = typeof exitCode === 'number' ? exitCode : null
      const result = {
        type: 'cmd',
        command: shell ? file : [file, ...args].join(' '),
        cwd,
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        startedAt,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutText: stdout.text(),
        stderrText: stderr.text(),
      }
      resolve(await writeLogs(result, logDir))
    }

    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      stderr.push(Buffer.from(`\n[启动失败] ${error.message}\n`))
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))

    timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      graceTimer = setTimeout(() => finish(null, 'SIGKILL'), 5_000)
    }, timeoutMs)
  })
}

/**
 * 执行一步 DSH 工具调用：`entry` 是工具名，`input` 是它的入参。
 *
 * 工具由调用方注入的 callTool 真正执行（它拿着 tools 服务与发起调用的 agent），
 * 这里只负责把结果整理成和 cmd 一样的形状，好让上层一视同仁地判断成败、写日志。
 *
 * @param {{ step: { type: string, entry: string, input?: string, args?: object }, cwd: string,
 *           timeoutMs: number, logDir: string, maxLogBytes: number, callTool?: Function }} options
 * @returns {Promise<object>}
 */
async function runToolStep(options) {
  const { step, cwd, timeoutMs, logDir, maxLogBytes, callTool } = options
  const startedAt = nowIso()
  const started = Date.now()
  const name = withWorktree(step.entry, cwd)
  const args = substituteArgs(step.args ?? {}, cwd)
  const shown = `${name} ${JSON.stringify(args)}`.trim()

  let outcome
  try {
    if (typeof callTool !== 'function') {
      throw new Error('当前 profile 没有可用的 tools 服务，dsh-plugin 步骤无法调用 DSH 工具')
    }
    outcome = await callTool(name, args, { timeoutMs })
  } catch (error) {
    outcome = { ok: false, text: `[调用失败] ${error instanceof Error ? error.message : String(error)}` }
  }

  const text = String(outcome?.text ?? '')
  const cut = text.length > maxLogBytes ? `${text.slice(0, maxLogBytes)}\n...[已截断]` : text
  const result = {
    type: 'dsh-plugin',
    command: shown,
    cwd,
    ok: Boolean(outcome?.ok),
    exitCode: outcome?.ok ? 0 : 1,
    signal: null,
    timedOut: Boolean(outcome?.timedOut),
    durationMs: Date.now() - started,
    startedAt,
    stdoutBytes: Buffer.byteLength(cut),
    stderrBytes: 0,
    stdoutText: cut,
    stderrText: outcome?.ok ? '' : `[工具 ${name} 未成功]\n${cut}`,
  }
  return writeLogs(result, logDir)
}

/**
 * @param {unknown} value
 * @param {string} worktree
 * @returns {unknown}
 */
function substituteArgs(value, worktree) {
  if (typeof value === 'string') return withWorktree(value, worktree)
  if (Array.isArray(value)) return value.map((item) => substituteArgs(item, worktree))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteArgs(item, worktree)]))
  }
  return value
}

/**
 * 执行一步，不分类型。
 *
 * @param {{ step: object, cwd: string, env?: Record<string, string>, timeoutMs: number,
 *           logDir: string, maxLogBytes: number, callTool?: Function }} options
 * @returns {Promise<object>}
 */
function runStep(options) {
  const { step, cwd, env, timeoutMs, logDir, maxLogBytes, callTool } = options
  if (step.type === 'dsh-plugin') {
    return runToolStep({ step, cwd, timeoutMs, logDir, maxLogBytes, callTool })
  }
  return runProcess({
    file: step.entry,
    args: [],
    cwd,
    ...(env ? { env } : {}),
    timeoutMs,
    shell: true,
    logDir,
    maxLogBytes,
  })
}

/**
 * 依次跑一遍 build 步骤：一步失败就停在那里。
 *
 * @param {{ steps?: Array<object>, cwd: string, timeoutMs: number, logDir: string,
 *           maxLogBytes: number, callTool?: Function }} options
 * @returns {Promise<object>}
 */
export async function runBuild(options) {
  const { steps = [], cwd, timeoutMs, logDir, maxLogBytes, callTool } = options
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: true, skipped: true, exitCode: 0, durationMs: 0, logs: null, ran: 0, steps: [] }
  }

  const started = Date.now()
  const done = []
  let last = null
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const stepLogDir = steps.length === 1 ? logDir : path.join(logDir, `step-${index + 1}`)
    const result = await runStep({ step, cwd, timeoutMs, logDir: stepLogDir, maxLogBytes, callTool })
    done.push({ index, type: step.type, entry: step.entry, exitCode: result.exitCode, timedOut: result.timedOut })
    last = result
    if (!result.ok) {
      return {
        ok: false,
        skipped: false,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
        logs: result.logs,
        stdoutText: result.stdoutText,
        stderrText: result.stderrText,
        ran: done.length,
        steps: done,
        failedStep: step.entry,
      }
    }
  }

  return {
    ok: true,
    skipped: false,
    exitCode: last?.exitCode ?? 0,
    timedOut: false,
    durationMs: Date.now() - started,
    logs: last?.logs ?? null,
    stdoutText: last?.stdoutText,
    stderrText: last?.stderrText,
    ran: done.length,
    steps: done,
  }
}

/**
 * 依次跑一遍 launch 步骤，共享一个运行预算；最后一步通常是长驻程序，到点杀掉。
 *
 * @param {{ steps?: Array<object>, cwd: string, timeoutMs: number, logDir: string,
 *           maxLogBytes: number, env: Record<string, string>, callTool?: Function }} options
 * @returns {Promise<object>}
 */
export async function runLaunch(options) {
  const { steps = [], cwd, timeoutMs, logDir, maxLogBytes, env, callTool } = options
  const started = Date.now()
  if (!Array.isArray(steps) || steps.length === 0) {
    return { command: '', cwd, ok: false, exitCode: null, signal: null, timedOut: false, durationMs: 0, skipped: true, steps: [] }
  }

  const deadline = started + timeoutMs
  const done = []
  let last = null
  for (let index = 0; index < steps.length; index += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      last = { ...(last ?? {}), ok: false, exitCode: null, timedOut: true }
      break
    }
    const step = steps[index]
    const stepLogDir = steps.length === 1 ? logDir : path.join(logDir, `step-${index + 1}`)
    last = await runStep({
      step,
      cwd,
      env: { ...process.env, ...env },
      timeoutMs: remaining,
      logDir: stepLogDir,
      maxLogBytes,
      callTool,
    })
    done.push({ index, type: step.type, entry: step.entry, exitCode: last.exitCode, timedOut: last.timedOut })
    if (last.timedOut) break
  }

  return { ...(last ?? { exitCode: null, signal: null }), durationMs: Date.now() - started, skipped: false, steps: done }
}
