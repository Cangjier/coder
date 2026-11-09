/**
 * 服务端无头浏览器：一个 Chrome 进程，每个工作区一个 target。
 *
 * 为什么要有它：跨域 iframe 里的 `window.open` / `target="_blank"` 父页面既拦不住、也读不到当前 URL。
 * 把浏览搬到宿主这一侧之后：
 * - `window.open` 会变成一个新 target，宿主拿得到它的 URL —— 直接让主 target 导航过去，就是「内部跳转」；
 * - `Page.frameNavigated` 让宿主知道每一跳的 URL，页面重进时按它恢复；
 * - 页面看到的是一帧帧 JPEG（`Page.startScreencast`），输入反过来用 `Input.*` 投递。
 *
 * 零依赖：Chrome 用系统装的（`findBrowserExecutable`），CDP 走 WebSocket ——
 * 宿主进程的 Node 24 自带 `WebSocket`，不引任何包。
 */
import { execFileSync, spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 视图尺寸（逻辑像素）：页面按它画 canvas，坐标也按它换算。 */
export const VIEWPORT = { width: 1280, height: 800 }

/** 浏览器启动最多等这么久。 */
const START_TIMEOUT_MS = 20_000

/** 帧最多这么频繁地推一次（毫秒）——再快页面也画不过来，只会白费带宽。 */
const FRAME_INTERVAL_MS = 33

/** 新 target 出现之后，等它拿到真实 URL 的最长时间。 */
const POPUP_WAIT_MS = 5_000

/** 找不到浏览器时的提示。 */
const NO_BROWSER =
  '没找到可用的 Chrome / Edge。装一个 Chrome，或者把它的可执行文件路径配到 config.browserPath（或环境变量 CODER_BROWSER）。'

/**
 * 带错误码的浏览器错误：接口层按 code 决定 HTTP 状态码。
 */
export class BrowserError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'BROWSER') {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

/* ------------------------------------------------------------------ *
 * 纯逻辑（不碰进程，单测直接用）
 * ------------------------------------------------------------------ */

/**
 * 系统里可能装着 Chrome / Edge 的地方。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string[]}
 */
export function browserCandidates(env = process.env, platform = process.platform) {
  const out = []
  const push = (value) => {
    if (value && out.indexOf(value) < 0) out.push(value)
  }
  push(env.CODER_BROWSER)
  push(env.CHROME_PATH)
  const home = env.USERPROFILE || env.HOME || ''
  if (home) {
    push(path.join(home, '.coder', 'chrome-for-testing', 'chrome-win64', 'chrome.exe'))
    push(path.join(home, '.coder', 'chrome-for-testing', 'chrome-linux64', 'chrome'))
  }
  if (platform === 'win32') {
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)
    for (const root of roots) {
      push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
        if (dir) push(path.join(dir, name))
      }
    }
  }
  return out
}

/**
 * 找第一个真实存在的浏览器可执行文件。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string | null}
 */
export function findBrowserExecutable(env = process.env, platform = process.platform) {
  for (const candidate of browserCandidates(env, platform)) {
    try {
      if (candidate && fsSync.existsSync(candidate)) return candidate
    } catch {
      // 换个候选
    }
  }
  return null
}

/**
 * 解析 Chrome 写下的 `DevToolsActivePort`：第一行端口，第二行浏览器级 WebSocket 路径。
 *
 * @param {unknown} text
 * @returns {{ port: number, path: string } | null}
 */
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) return null
  const port = Number(lines[0])
  if (!Number.isInteger(port) || port <= 0) return null
  if (!lines[1].startsWith('/')) return null
  return { port, path: lines[1] }
}

/**
 * 只允许 http(s)：页面上粘进来的地址不能变成 `file:` / `javascript:` 之类的加载器。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNavigableUrl(value) {
  try {
    const url = new URL(String(value ?? ''))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 特殊键 → `windowsVirtualKeyCode`。可打印字符不走这里（用 `Input.insertText`）。 */
const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  Insert: 45,
  ' ': 32,
}

/**
 * 修饰键位标记（CDP 的 modifiers 位域）。
 *
 * @param {{ alt?: boolean, ctrl?: boolean, meta?: boolean, shift?: boolean }} [modifiers]
 * @returns {number}
 */
export function modifierBits(modifiers = {}) {
  let bits = 0
  if (modifiers.alt) bits |= 1
  if (modifiers.ctrl) bits |= 2
  if (modifiers.meta) bits |= 4
  if (modifiers.shift) bits |= 8
  return bits
}

/**
 * 一个特殊键的 `Input.dispatchKeyEvent` 参数（按下 / 抬起各一条）。
 *
 * @param {string} key
 * @param {{ alt?: boolean, ctrl?: boolean, meta?: boolean, shift?: boolean }} [modifiers]
 * @returns {{ down: object, up: object } | null}
 */
export function keyParamsOf(key, modifiers = {}) {
  const code = KEY_CODES[key]
  if (!code) return null
  const bits = modifierBits(modifiers)
  const base = {
    key,
    code: key === ' ' ? 'Space' : key,
    windowsVirtualKeyCode: code,
    nativeVirtualKeyCode: code,
    modifiers: bits,
  }
  return {
    down: { type: 'rawKeyDown', ...base },
    up: { type: 'keyUp', ...base },
  }
}

/**
 * 页面发来的输入事件：校验、夹取坐标、丢掉不认识的。
 *
 * 坐标是**逻辑视图坐标**（0..width / 0..height），页面负责把 canvas 上的点击换算好。
 *
 * @param {unknown} raw
 * @param {{ width: number, height: number }} [viewport]
 * @returns {Array<object>}
 */
export function normalizeEvents(raw, viewport = VIEWPORT) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out = []
  const clampX = (value) => Math.max(0, Math.min(viewport.width, Math.round(value)))
  const clampY = (value) => Math.max(0, Math.min(viewport.height, Math.round(value)))

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'mouse') {
      const action = ['click', 'down', 'move', 'up'].indexOf(item.action) >= 0 ? item.action : 'click'
      const x = Number(item.x)
      const y = Number(item.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const button = ['left', 'right', 'middle'].indexOf(item.button) >= 0 ? item.button : 'left'
      const clickCount = Number.isFinite(Number(item.clickCount)) ? Math.min(3, Math.max(1, Math.round(Number(item.clickCount)))) : 1
      const held = Number.isFinite(Number(item.buttons)) ? Math.max(0, Math.min(7, Math.round(Number(item.buttons)))) : 0
      const bit = button === 'left' ? 1 : button === 'right' ? 2 : 4
      out.push({
        type: 'mouse',
        action,
        x: clampX(x),
        y: clampY(y),
        button,
        clickCount,
        // 按下 / 点击时按住这个键；松开与普通悬停都算没按键。
        buttons: action === 'move' ? held : action === 'up' ? 0 : bit,
      })
      continue
    }
    if (item.type === 'wheel') {
      const x = Number(item.x)
      const y = Number(item.y)
      const deltaX = Number(item.deltaX) || 0
      const deltaY = Number(item.deltaY) || 0
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      out.push({
        type: 'wheel',
        x: clampX(x),
        y: clampY(y),
        deltaX: Math.max(-4000, Math.min(4000, deltaX)),
        deltaY: Math.max(-4000, Math.min(4000, deltaY)),
      })
      continue
    }
    if (item.type === 'text') {
      const text = String(item.text ?? '')
      if (!text) continue
      out.push({ type: 'text', text: text.slice(0, 4000) })
      continue
    }
    if (item.type === 'key') {
      const key = String(item.key ?? '')
      if (!keyParamsOf(key)) continue
      const modifiers = item.modifiers && typeof item.modifiers === 'object' ? item.modifiers : {}
      out.push({
        type: 'key',
        key,
        modifiers: {
          alt: modifiers.alt === true,
          ctrl: modifiers.ctrl === true,
          meta: modifiers.meta === true,
          shift: modifiers.shift === true,
        },
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * CDP 连接
 * ------------------------------------------------------------------ */

/**
 * 起一个 headless Chrome 并连上它的浏览器级 CDP WebSocket。
 *
 * @param {{
 *   executable: string, profileDir: string, viewport: { width: number, height: number }, logger?: object,
 * }} options
 * @returns {Promise<{ send: Function, on: Function, close: Function, pid: number | undefined }>}
 */
export async function connectBrowser({ executable, profileDir, viewport = VIEWPORT, logger, extension }) {
  if (typeof WebSocket !== 'function') {
    throw new BrowserError('当前 Node 没有全局 WebSocket（需要 Node 22+），无法连接无头浏览器。', 'NO_WEBSOCKET')
  }
  await fs.mkdir(profileDir, { recursive: true })
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  await fs.rm(portFile, { force: true }).catch(() => {})

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    ...(extension
      ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
      : ['--disable-extensions']),
    '--disable-background-networking',
    '--use-fake-ui-for-media-stream',
    // 对端是我们自己的本机页面：允许暴露内网/回环候选，避免 mDNS 解析把 WebRTC 卡在 checking。
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    // 弹窗不拦：我们要它真的变成 target，读出 URL 再让主画面导航过去。
    '--disable-popup-blocking',
    '--mute-audio',
    '--hide-crash-restore-bubble',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${viewport.width},${viewport.height}`,
    'about:blank',
  ]

  let stderr = ''
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2000)
  })

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let exitInfo = null
  exited.then((value) => {
    exitInfo = value
  })

  let activePort = null
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exitInfo) {
      throw new BrowserError(
        `无头浏览器启动失败（退出码 ${exitInfo.code ?? exitInfo.signal}）：${stderr.trim() || '没有更多信息'}`,
        'BROWSER_EXIT',
      )
    }
    const text = await fs.readFile(portFile, 'utf8').catch(() => null)
    if (text) {
      activePort = parseDevToolsActivePort(text)
      if (activePort) break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!activePort) {
    child.kill()
    throw new BrowserError(`无头浏览器在 ${START_TIMEOUT_MS / 1000} 秒内没有就绪：${stderr.trim() || '没有更多信息'}`)
  }

  const socket = new WebSocket(`ws://127.0.0.1:${activePort.port}${activePort.path}`)
  const pending = new Map()
  const handlers = new Map()
  const closeListeners = new Set()
  let nextId = 0
  let closed = false
  let closeReason = ''

  const failAll = (message) => {
    for (const [, waiter] of pending) {
      try {
        waiter.reject(new BrowserError(message, 'CDP_CLOSED'))
      } catch {
        // 已经结束
      }
    }
    pending.clear()
  }

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserError('连不上 CDP WebSocket（20 秒超时）')), 20_000)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.onerror = (event) => {
      clearTimeout(timer)
      reject(new BrowserError(`CDP WebSocket 出错：${event?.message ?? '未知原因'}`))
    }
  })

  socket.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new BrowserError(`${waiter.method}：${message.error.message}`, 'CDP_ERROR'))
      else waiter.resolve(message.result)
      return
    }
    if (!message.method) return
    const list = handlers.get(message.method)
    if (!list) return
    for (const handler of list) {
      try {
        handler(message.params ?? {}, message.sessionId)
      } catch (error) {
        logger?.warn?.(`coder: 处理 CDP 事件 ${message.method} 出错：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  socket.onclose = () => {
    closed = true
    closeReason = closeReason || '浏览器已关闭'
    failAll(closeReason)
    for (const listener of [...closeListeners]) {
      try {
        listener(closeReason)
      } catch {
        // 监听器坏了不影响关闭
      }
    }
    closeListeners.clear()
  }

  const send = (method, params = {}, sessionId) => {
    if (closed) return Promise.reject(new BrowserError(`CDP 连接已关闭：${closeReason}`, 'CDP_CLOSED'))
    const id = (nextId += 1)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        pending.delete(id)
        reject(new BrowserError(`发送 ${method} 失败：${error instanceof Error ? error.message : String(error)}`))
      }
    })
  }

  const on = (method, handler) => {
    const list = handlers.get(method) ?? []
    list.push(handler)
    handlers.set(method, list)
    return () => {
      const current = handlers.get(method) ?? []
      handlers.set(
        method,
        current.filter((item) => item !== handler),
      )
    }
  }

  /**
   * 浏览器自己断开时通知一次（进程崩了、被杀了）。
   *
   * @param {(reason: string) => void} listener
   * @returns {() => void}
   */
  const onClose = (listener) => {
    closeListeners.add(listener)
    return () => closeListeners.delete(listener)
  }

  try {
    await opened
  } catch (error) {
    child.kill()
    throw error
  }

  const close = async () => {
    closeReason = '插件正在关闭无头浏览器'
    if (!closed) {
      await send('Browser.close').catch(() => {})
    }
    try {
      socket.close()
    } catch {
      // 已经关了
    }
    const forced = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出
      }
    }, 2_000)
    forced.unref?.()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
    clearTimeout(forced)
    closed = true
    failAll(closeReason)
  }

  return { send, on, onClose, close, pid: child.pid }
}

/* ------------------------------------------------------------------ *
 * 管理器
 * ------------------------------------------------------------------ */

/**
 * 在**目标标签页自己**里启动「自捕获 + WebRTC」的脚本。
 *
 * 用 `Runtime.evaluate`（带 `userGesture: true`）注入；offer / ICE / 状态通过
 * `Runtime.addBinding('__coderCapture')` 回传给宿主；宿主再用 evaluate 把 answer 与
 * 对端候选写回来。这样不需要扩展、不需要标签选择器，也不会抓错标签。
 */
const CAPTURE_SCRIPT = `(async () => {
  if (window.__coderCapturePc) { try { window.__coderCapturePc.close() } catch (error) {} }
  if (window.__coderCaptureStream) { try { window.__coderCaptureStream.getTracks().forEach((track) => track.stop()) } catch (error) {} }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, preferCurrentTab: true, audio: false })
  window.__coderCaptureStream = stream
  const track = stream.getVideoTracks()[0]
  const settings = track.getSettings()
  const pc = new RTCPeerConnection({ iceServers: [] })
  window.__coderCapturePc = pc
  window.__coderCaptureAccept = async (answer) => { await pc.setRemoteDescription(answer) }
  window.__coderCaptureAddCandidate = async (candidate) => { if (candidate) await pc.addIceCandidate(candidate).catch(() => {}) }
  window.__coderCaptureStop = () => {
    try { pc.close() } catch (error) {}
    try { stream.getTracks().forEach((track) => track.stop()) } catch (error) {}
    window.__coderCapturePc = null
    window.__coderCaptureStream = null
  }
  track.onended = () => __coderCapture(JSON.stringify({ kind: 'ended' }))
  pc.onicecandidate = (event) => {
    __coderCapture(JSON.stringify({ kind: 'candidate', candidate: event.candidate ? event.candidate.toJSON() : null }))
  }
  pc.onconnectionstatechange = () => __coderCapture(JSON.stringify({ kind: 'state', state: pc.connectionState }))
  pc.addTrack(track, stream)
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  __coderCapture(JSON.stringify({
    kind: 'offer',
    sdp: pc.localDescription.sdp,
    type: pc.localDescription.type,
    width: settings.width || 0,
    height: settings.height || 0,
  }))
  return 'ok'
})()`

/** 停掉当前标签页里的捕获（切标签 / 关闭时用）。 */
const CAPTURE_STOP_SCRIPT = `(() => {
  if (window.__coderCaptureStop) {
    try { window.__coderCaptureStop() } catch (error) {}
  }
  return true
})()`

/**
 * 一个进程里只有一个无头浏览器；每个工作区是一个会话，会话里可以有多个标签页。
 * 当前标签页的画面通过 getDisplayMedia 自捕获 + WebRTC 送给页面，输入走 CDP。
 *
 * @param {{
 *   logger?: object,
 *   executable?: string | null,
 *   profileDir?: string,
 *   viewport?: { width: number, height: number },
 *   idleMs?: number,
 *   connect?: typeof connectBrowser,
 * }} [options]
 * @returns {object}
 */
export function createBrowserManager(options = {}) {
  const logger = options.logger
  const viewport = options.viewport ?? VIEWPORT
  const profileDir = options.profileDir ?? path.join(os.homedir(), '.coder', 'browser-profile')
  const idleMs = Number.isFinite(options.idleMs) ? options.idleMs : 30 * 60_000
  const maxTabs = Number.isFinite(options.maxTabs) ? Math.max(1, options.maxTabs) : 8
  const scaleLevel = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1.5
  const documentZoom = Number.isFinite(options.zoom) && options.zoom > 0 ? options.zoom : 1.5
  let chromeOffset = null
  const connect = options.connect ?? connectBrowser
  const executableOf = () => (options.executable === undefined ? findBrowserExecutable() : options.executable)

  /** dir → 会话；会话里 tabs: targetId → tab */
  const sessions = new Map()
  /** 自己刚创建的 target：targetCreated 事件里要跳过 */
  const creating = new Set()
  let browser = null
  let starting = null
  let sweepTimer = null

  /**
   * 确保浏览器进程在跑。
   *
   * @returns {Promise<object>}
   */
  async function ensureBrowser() {
    if (browser) return browser
    if (starting) return starting
    starting = (async () => {
      const executable = executableOf()
      if (!executable) throw new BrowserError(NO_BROWSER, 'NO_BROWSER')
      logger?.info?.(`coder: 启动无头浏览器 ${executable}`)
      const connection = await connect({ executable, profileDir, viewport, logger, extension: options.extension })
      browser = connection
      connection.onClose?.((reason) => {
        if (browser !== connection) return
        browser = null
        for (const session of sessions.values()) {
          broadcast(session, { kind: 'closed', running: false, reason })
          session.subscribers.clear()
          session.tabs.clear()
        }
        sessions.clear()
        logger?.warn?.(`coder: 无头浏览器已关闭：${reason}`)
      })
      wireBrowserEvents()
      connection.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
      const timer = setInterval(sweep, 60_000)
      timer.unref?.()
      sweepTimer = timer
      return connection
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  /**
   * @param {string} dir
   * @param {string} url
   * @returns {object}
   */
  function newSession(dir) {
    return {
      dir,
      tabs: new Map(),
      activeId: '',
      subscribers: new Set(),
      frame: null,
      frameTimer: null,
      seq: 0,
      width: viewport.width,
      height: viewport.height,
      zoom: 1,
      scale: 1,
      logicalWidth: viewport.width,
      logicalHeight: viewport.height,
      lastTouch: Date.now(),
    }
  }

  /** 浏览器级事件。 */
  function wireBrowserEvents() {
    const cdp = browser
    if (!cdp) return

    cdp.on('Target.targetCreated', (params) => {
      const info = params.targetInfo ?? {}
      if (info.type !== 'page') return
      if (creating.has(info.targetId)) return
      if (knownTarget(info.targetId)) return
      // 启动时的 about:blank 不是弹窗；等它拿到真实地址再收编
      if (!isNavigableUrl(info.url)) return
      adoptPopup(info)
    })
    cdp.on('Target.targetInfoChanged', (params) => {
      const info = params.targetInfo ?? {}
      if (info.type !== 'page') return
      const hit = findByTarget(info.targetId)
      if (hit) {
        hit.tab.url = String(info.url ?? hit.tab.url)
        hit.tab.title = String(info.title ?? hit.tab.title)
        if (hit.session.activeId === hit.tab.targetId) {
          broadcast(hit.session, stateMessage(hit.session))
        }
        return
      }
      if (creating.has(info.targetId)) return
      if (!isNavigableUrl(info.url)) return
      adoptPopup(info)
    })
    cdp.on('Target.targetDestroyed', (params) => {
      const hit = findByTarget(params.targetId)
      if (!hit) return
      hit.session.tabs.delete(params.targetId)
      if (hit.session.activeId === params.targetId) {
        const next = hit.session.tabs.values().next().value
        hit.session.activeId = next ? next.targetId : ''
        if (next) activateTab(hit.session, next.targetId).catch(() => {})
      }
      broadcast(hit.session, stateMessage(hit.session))
    })

    cdp.on('Page.screencastFrame', (params, sessionId) => {
      const hit = byCdp(sessionId)
      if (!hit) return
      cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {})
      if (hit.tab.targetId !== hit.session.activeId) return
      const meta = params.metadata ?? {}
      hit.session.frame = {
        image: String(params.data ?? ''),
        width: Number(meta.deviceWidth) || viewport.width,
        height: Number(meta.deviceHeight) || viewport.height,
      }
      scheduleFrame(hit.session)
    })

    cdp.on('Page.frameNavigated', (params, sessionId) => {
      const hit = byCdp(sessionId)
      if (!hit) return
      const frame = params.frame ?? {}
      if (frame.parentId) return
      const nextUrl = String(frame.url ?? '')
      if (nextUrl === 'about:blank' && (hit.tab.pendingUrl || (hit.tab.url && hit.tab.url !== 'about:blank'))) return
      hit.tab.url = nextUrl || hit.tab.url
      if (hit.tab.pendingUrl && hit.tab.pendingUrl === nextUrl) hit.tab.pendingUrl = ''
      hit.tab.capture = null
      hit.session.lastTouch = Date.now()
      if (hit.tab.targetId === hit.session.activeId) broadcast(hit.session, stateMessage(hit.session))
      readTitle(hit.session, hit.tab)
    })

    cdp.on('Page.navigatedWithinDocument', (params, sessionId) => {
      const hit = byCdp(sessionId)
      if (!hit) return
      hit.tab.url = String(params.url ?? hit.tab.url)
      hit.tab.pendingUrl = ''
      hit.tab.capture = null
      if (hit.tab.targetId === hit.session.activeId) broadcast(hit.session, stateMessage(hit.session))
      readTitle(hit.session, hit.tab)
    })

    cdp.on('Page.loadEventFired', (_params, sessionId) => {
      const hit = byCdp(sessionId)
      if (!hit) return
      readTitle(hit.session, hit.tab)
      if (documentZoom > 1 && browser) {
        browser
          .send(
            'Runtime.evaluate',
            { expression: `document.documentElement.style.zoom = ${JSON.stringify(String(documentZoom))}`, returnByValue: true },
            sessionId,
          )
          .catch(() => {})
      }
    })

    cdp.on('Runtime.bindingCalled', (params, sessionId) => {
      const hit = byCdp(sessionId)
      if (!hit || params.name !== '__coderCapture') return
      let payload = null
      try {
        payload = JSON.parse(String(params.payload ?? '{}'))
      } catch {
        return
      }
      if (payload.kind === 'offer') {
        hit.tab.capture = {
          offer: { sdp: String(payload.sdp ?? ''), type: String(payload.type ?? 'offer') },
          candidates: [],
          state: 'offered',
          width: Number(payload.width) || 0,
          height: Number(payload.height) || 0,
        }
        return
      }
      if (!hit.tab.capture) return
      if (payload.kind === 'candidate' && payload.candidate) {
        hit.tab.capture.candidates.push(payload.candidate)
        return
      }
      if (payload.kind === 'state') {
        hit.tab.capture.state = String(payload.state ?? '')
        return
      }
      if (payload.kind === 'ended') {
        hit.tab.capture.state = 'ended'
      }
    })
  }

  /**
   * 弹窗 / `target=_blank`：收编成这个会话里的一个新标签页（而不是跳出去）。
   *
   * @param {object} info
   * @returns {void}
   */
  function adoptPopup(info) {
    const opener = info.openerId ? findByTarget(String(info.openerId)) : null
    const session = opener?.session ?? lastTouchedSession()
    if (!session) {
      browser?.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
      return
    }
    attachTab(session, String(info.targetId), { activate: true }).catch((error) => {
      logger?.warn?.(`coder: 收编新标签失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 把一个 target 挂成标签页。
   *
   * @param {object} session
   * @param {string} targetId
   * @param {{ activate?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function attachTab(session, targetId, { activate = true } = {}) {
    if (session.tabs.has(targetId)) return session.tabs.get(targetId)
    const cdp = await ensureBrowser()
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const cdpSessionId = String(attached.sessionId)
    await cdp.send('Page.enable', {}, cdpSessionId)
    await cdp.send('Runtime.enable', {}, cdpSessionId)
    await cdp.send('Runtime.addBinding', { name: '__coderCapture' }, cdpSessionId).catch(() => {})
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, cdpSessionId).catch(() => {})
    if (documentZoom > 1) {
      await cdp
        .send(
          'Runtime.evaluate',
          { expression: `document.documentElement.style.zoom = ${JSON.stringify(String(documentZoom))}`, returnByValue: true },
          cdpSessionId,
        )
        .catch(() => {})
      await cdp
        .send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: `(() => {
  const ZOOM = ${JSON.stringify(String(documentZoom))};
  const apply = () => {
    try {
      const root = document.documentElement;
      if (root) { root.style.zoom = ZOOM; return true; }
    } catch (error) {}
    return false;
  };
  if (!apply()) {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
    window.addEventListener('load', apply, { once: true });
  }
})();` },
          cdpSessionId,
        )
        .catch(() => {})
    }
    const info = await cdp.send('Target.getTargetInfo', { targetId }).catch(() => null)
    const tab = {
      targetId,
      cdpSessionId,
      url: String(info?.targetInfo?.url ?? ''),
      title: String(info?.targetInfo?.title ?? ''),
      capture: null,
      pendingUrl: '',
      screencasting: false,
      lastActive: Date.now(),
    }
    session.tabs.set(targetId, tab)
    if (activate) await activateTab(session, targetId)
    session.lastTouch = Date.now()
    await trimTabs(session)
    return tab
  }

  /**
   * 量一次窗口外框和内容区的差（标题栏/标签栏/边框）。同一个 Chrome 构建下是固定值。
   *
   * @param {object} cdp
   * @returns {Promise<{ width: number, height: number }>}
   */
  async function measureChrome(cdp) {
    if (chromeOffset) return chromeOffset
    try {
      const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })
      const targetId = String(created.targetId)
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      const windowInfo = await cdp.send('Browser.getWindowForTarget', { targetId }).catch(() => null)
      if (!windowInfo?.windowId) {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
        chromeOffset = { width: 0, height: 0 }
        return chromeOffset
      }
      await cdp
        .send('Browser.setWindowBounds', {
          windowId: windowInfo.windowId,
          bounds: { width: 1000, height: 800, windowState: 'normal' },
        })
        .catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 250))
      const measured = await cdp
        .send(
          'Runtime.evaluate',
          { expression: 'JSON.stringify([innerWidth, innerHeight])', returnByValue: true },
          attached.sessionId,
        )
        .catch(() => null)
      const [cssW, cssH] = JSON.parse(measured?.result?.value ?? '[]')
      chromeOffset = {
        width: Math.max(0, 1000 - (Number(cssW) || 1000)),
        height: Math.max(0, 800 - (Number(cssH) || 800)),
      }
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
      return chromeOffset
    } catch {
      chromeOffset = { width: 0, height: 0 }
      return chromeOffset
    }
  }

  /**
   * 标签页上限：超出时关掉最久没用过的**非当前**标签，避免标签越开越多把内存吃满。
   *
   * @param {object} session
   * @returns {Promise<void>}
   */
  async function trimTabs(session) {
    while (session.tabs.size > maxTabs) {
      let oldest = null
      for (const tab of session.tabs.values()) {
        if (tab.targetId === session.activeId) continue
        if (!oldest || tab.lastActive < oldest.lastActive) oldest = tab
      }
      if (!oldest) break
      session.tabs.delete(oldest.targetId)
      if (browser) await browser.send('Target.closeTarget', { targetId: oldest.targetId }).catch(() => {})
      broadcast(session, stateMessage(session))
    }
  }

  /**
   * 切到某个标签页：停掉旧标签的捕获与画面流，激活新标签。
   *
   * @param {object} session
   * @param {string} targetId
   * @returns {Promise<void>}
   */
  async function activateTab(session, targetId) {
    const cdp = await ensureBrowser()
    const previous = session.activeId && session.activeId !== targetId ? session.tabs.get(session.activeId) : null
    if (previous) {
      if (previous.screencasting) {
        await cdp.send('Page.stopScreencast', {}, previous.cdpSessionId).catch(() => {})
        previous.screencasting = false
      }
      if (previous.capture) {
        await cdp.send('Runtime.evaluate', { expression: CAPTURE_STOP_SCRIPT, returnByValue: true }, previous.cdpSessionId).catch(() => {})
        previous.capture = null
      }
    }
    session.activeId = targetId
    session.frame = null
    const active = session.tabs.get(targetId)
    if (active) active.lastActive = Date.now()
    session.seq += 1
    const tab = session.tabs.get(targetId)
    if (!tab) return
    await cdp.send('Target.activateTarget', { targetId }).catch(() => {})
    if (!tab.screencasting) {
      await cdp
        .send(
          'Page.startScreencast',
          {
            format: 'jpeg',
            quality: 92,
            maxWidth: session.width,
            maxHeight: session.height,
            everyNthFrame: 1,
          },
          tab.cdpSessionId,
        )
        .catch(() => {})
      tab.screencasting = true
    }
    broadcast(session, stateMessage(session))
    readTitle(session, tab)
  }

  /**
   * @param {string} dir
   * @param {string} url
   * @param {{ activate?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function newTab(dir, url, { activate = true, width, height, cssWidth, cssHeight } = {}) {
    if (!isNavigableUrl(url)) throw new BrowserError(`不是可导航的 http(s) 地址：${url}`, 'BAD_URL')
    const cdp = await ensureBrowser()
    let session = sessions.get(dir)
    if (!session) {
      session = newSession(dir)
      sessions.set(dir, session)
    }
    const targetWidth = Math.round(Number(width) || 0)
    const targetHeight = Math.round(Number(height) || 0)
    const logicalWidth = Math.round(Number(cssWidth) || targetWidth)
    const logicalHeight = Math.round(Number(cssHeight) || targetHeight)
    const created = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    const targetId = String(created.targetId)
    creating.add(targetId)
    try {
      const tab = await attachTab(session, targetId, { activate })
      if (targetWidth > 0 && targetHeight > 0) {
        session.logicalWidth = logicalWidth
        session.logicalHeight = logicalHeight
        const chrome = await measureChrome(cdp)
        const windowInfo = await cdp.send('Browser.getWindowForTarget', { targetId }).catch(() => null)
        if (windowInfo?.windowId != null) {
          await cdp
            .send('Browser.setWindowBounds', {
              windowId: windowInfo.windowId,
              bounds: {
                width: targetWidth + chrome.width,
                height: targetHeight + chrome.height,
                windowState: 'normal',
              },
            })
            .catch(() => {})
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      tab.url = url
      tab.pendingUrl = url
      await cdp.send('Page.navigate', { url }, tab.cdpSessionId)
      if (targetWidth > 0 && targetHeight > 0) {
        await new Promise((resolve) => setTimeout(resolve, 700))
        const measured = await cdp
          .send(
            'Runtime.evaluate',
            { expression: 'JSON.stringify([innerWidth, innerHeight])', returnByValue: true },
            tab.cdpSessionId,
          )
          .catch(() => null)
        try {
          const [cssW, cssH] = JSON.parse(measured?.result?.value ?? '[]')
          if (cssW > 0 && cssH > 0) {
            session.width = Math.round(cssW)
            session.height = Math.round(cssH)
          }
        } catch {
          session.width = targetWidth
          session.height = targetHeight
        }
        await cdp
          .send(
            'Page.startScreencast',
            { format: 'jpeg', quality: 92, maxWidth: targetWidth, maxHeight: targetHeight, everyNthFrame: 1 },
            tab.cdpSessionId,
          )
          .catch(() => {})
        tab.screencasting = true
      }
      broadcast(session, stateMessage(session))
      return stateOf(session)
    } catch (error) {
      session.tabs.delete(targetId)
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
      throw error
    } finally {
      creating.delete(targetId)
    }
  }

  /**
   * 打开（或复用）一个工作区的浏览器：没有标签就开一个，有标签就让当前标签导航过去。
   *
   * @param {string} dir
   * @param {string} url
   * @returns {Promise<object>}
   */
  async function open(dir, url, size = {}) {
    if (!isNavigableUrl(url)) throw new BrowserError(`不是可导航的 http(s) 地址：${url}`, 'BAD_URL')
    const session = sessions.get(dir)
    if (!session || session.tabs.size === 0) return newTab(dir, url, { activate: true, ...size })
    session.lastTouch = Date.now()
    if (url && url !== activeTab(session)?.url) await navigate(dir, url)
    return stateOf(session)
  }

  /**
   * @param {string} dir
   * @param {string} targetId
   * @returns {Promise<object>}
   */
  async function activateTabById(dir, targetId) {
    const session = sessions.get(dir)
    if (!session) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    if (!session.tabs.has(targetId)) throw new BrowserError(`没有这个标签页：${targetId}`, 'NO_TAB')
    await activateTab(session, targetId)
    return stateOf(session)
  }

  /**
   * @param {string} dir
   * @param {string} targetId
   * @returns {Promise<object>}
   */
  async function closeTabById(dir, targetId) {
    const session = sessions.get(dir)
    if (!session) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    const tab = session.tabs.get(targetId)
    if (!tab) throw new BrowserError(`没有这个标签页：${targetId}`, 'NO_TAB')
    const cdp = await ensureBrowser()
    session.tabs.delete(targetId)
    if (session.activeId === targetId) {
      const next = session.tabs.values().next().value
      session.activeId = next ? next.targetId : ''
      if (next) await activateTab(session, next.targetId)
    }
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    broadcast(session, stateMessage(session))
    return stateOf(session)
  }

  /**
   * @param {object} session
   * @returns {object | undefined}
   */
  function activeTab(session) {
    return session.tabs.get(session.activeId)
  }

  /**
   * @param {object} session
   * @returns {object}
   */
  function stateMessage(session) {
    const tab = activeTab(session)
    return {
      kind: 'state',
      running: true,
      url: tab?.url ?? '',
      title: tab?.title ?? '',
      width: session.width,
      height: session.height,
      deviceWidth: Math.round(session.width * (session.dpr || 1)),
      deviceHeight: Math.round(session.height * (session.dpr || 1)),
      logicalWidth: session.logicalWidth,
      logicalHeight: session.logicalHeight,
      activeId: session.activeId,
      tabs: tabsOf(session),
    }
  }

  /**
   * @param {object} session
   * @returns {Array<object>}
   */
  function tabsOf(session) {
    return [...session.tabs.values()].map((tab) => ({
      id: tab.targetId,
      url: tab.url,
      title: tab.title,
      active: tab.targetId === session.activeId,
    }))
  }

  /**
   * @param {object} session
   * @returns {object}
   */
  function stateOf(session) {
    const tab = activeTab(session)
    return {
      running: true,
      url: tab?.url ?? '',
      title: tab?.title ?? '',
      width: session.width,
      height: session.height,
      deviceWidth: Math.round(session.width * (session.dpr || 1)),
      deviceHeight: Math.round(session.height * (session.dpr || 1)),
      logicalWidth: session.logicalWidth,
      logicalHeight: session.logicalHeight,
      seq: session.seq,
      activeId: session.activeId,
      tabs: tabsOf(session),
      frame: session.frame ? { ...session.frame } : null,
    }
  }

  /**
   * @param {object} session
   * @param {object} message
   * @returns {void}
   */
  function broadcast(session, message) {
    for (const listener of [...session.subscribers]) {
      try {
        listener(message)
      } catch {
        // 一个订阅者坏掉不影响别人
      }
    }
  }

  /**
   * @param {object} session
   * @returns {void}
   */
  function scheduleFrame(session) {
    if (session.frameTimer) return
    session.frameTimer = setTimeout(() => {
      session.frameTimer = null
      const frame = session.frame
      if (!frame) return
      session.seq += 1
      broadcast(session, {
        kind: 'frame',
        url: activeTab(session)?.url ?? '',
        title: activeTab(session)?.title ?? '',
        width: frame.width,
        height: frame.height,
        seq: session.seq,
        image: frame.image,
      })
    }, FRAME_INTERVAL_MS)
    session.frameTimer.unref?.()
  }

  /**
   * @param {object} session
   * @param {object} tab
   * @returns {void}
   */
  function readTitle(session, tab) {
    const cdp = browser
    if (!cdp || !tab) return
    cdp
      .send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, tab.cdpSessionId)
      .then((value) => {
        const title = String(value?.result?.value ?? '')
        if (title && title !== tab.title) {
          tab.title = title
          if (tab.targetId === session.activeId) broadcast(session, stateMessage(session))
        }
      })
      .catch(() => {})
  }

  /**
   * @param {string} dir
   * @returns {object}
   */
  function state(dir) {
    const session = sessions.get(dir)
    return session
      ? stateOf(session)
      : {
          running: false,
          url: '',
          title: '',
          width: viewport.width,
          height: viewport.height,
          seq: 0,
          activeId: '',
          tabs: [],
          frame: null,
        }
  }

  /**
   * @param {string} dir
   * @param {(message: object) => void} listener
   * @returns {() => void}
   */
  function subscribe(dir, listener) {
    const session = sessions.get(dir)
    if (!session) return () => {}
    session.subscribers.add(listener)
    session.lastTouch = Date.now()
    listener({ ...stateMessage(session), frame: session.frame ? { ...session.frame } : null })
    return () => {
      session.subscribers.delete(listener)
    }
  }

  /**
   * @param {string} dir
   * @param {string} url
   * @returns {Promise<object>}
   */
  async function navigate(dir, url) {
    const session = sessions.get(dir)
    if (!session) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    if (!isNavigableUrl(url)) throw new BrowserError(`不是可导航的 http(s) 地址：${url}`, 'BAD_URL')
    const tab = activeTab(session)
    if (!tab) throw new BrowserError('没有标签页', 'NO_TAB')
    if (!browser) throw new BrowserError('浏览器已关闭', 'CDP_CLOSED')
    tab.url = url
    tab.pendingUrl = url
    tab.capture = null
    session.lastTouch = Date.now()
    await browser.send('Page.navigate', { url }, tab.cdpSessionId)
    broadcast(session, stateMessage(session))
    return stateOf(session)
  }

  /**
   * @param {string} dir
   * @returns {Promise<object>}
   */
  async function reload(dir) {
    const session = sessions.get(dir)
    if (!session) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    const tab = activeTab(session)
    if (!tab) throw new BrowserError('没有标签页', 'NO_TAB')
    if (!browser) throw new BrowserError('浏览器已关闭', 'CDP_CLOSED')
    tab.capture = null
    session.lastTouch = Date.now()
    await browser.send('Page.reload', { ignoreCache: false }, tab.cdpSessionId)
    return stateOf(session)
  }

  /**
   * @param {string} dir
   * @param {unknown} events
   * @returns {Promise<object>}
   */
  async function input(dir, events) {
    const session = sessions.get(dir)
    if (!session) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    const tab = activeTab(session)
    if (!tab) throw new BrowserError('没有标签页', 'NO_TAB')
    if (!browser) throw new BrowserError('浏览器已关闭', 'CDP_CLOSED')
    const list = normalizeEvents(events, { width: session.width, height: session.height })
    session.lastTouch = Date.now()
    for (const event of list) {
      if (event.type === 'mouse') {
        const base = { x: event.x, y: event.y, button: event.button, buttons: event.buttons, clickCount: event.clickCount }
        if (event.action === 'click' || event.action === 'down') {
          await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, tab.cdpSessionId)
        }
        if (event.action === 'click' || event.action === 'up') {
          await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 }, tab.cdpSessionId)
        }
        if (event.action === 'move') {
          await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base }, tab.cdpSessionId)
        }
        continue
      }
      if (event.type === 'wheel') {
        await browser.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, button: 'none', buttons: 0 },
          tab.cdpSessionId,
        )
        continue
      }
      if (event.type === 'text') {
        await browser.send('Input.insertText', { text: event.text }, tab.cdpSessionId)
        continue
      }
      if (event.type === 'key') {
        const params = keyParamsOf(event.key, event.modifiers)
        if (!params) continue
        await browser.send('Input.dispatchKeyEvent', params.down, tab.cdpSessionId)
        await browser.send('Input.dispatchKeyEvent', params.up, tab.cdpSessionId)
      }
    }
    return { accepted: list.length }
  }

  /**
   * 在当前标签页里启动「自捕获 + WebRTC」，返回 offer（页面据此建 PC）。
   *
   * @param {string} dir
   * @returns {Promise<{ offer: object, width: number, height: number }>}
   */
  async function startCapture(dir, options = {}) {
    const session = sessions.get(dir)
    if (!session) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    const tab = activeTab(session)
    if (!tab) throw new BrowserError('没有标签页', 'NO_TAB')
    const cdp = await ensureBrowser()
    if (!browser) throw new BrowserError('浏览器已关闭', 'CDP_CLOSED')
    // 面板越宽，捕获像素越多：headless 的标签捕获是 800×600 CSS，设备像素比决定实际像素。
    const wanted = Number(options.width) || 0
    const dpr = wanted > 800 ? Math.min(2, Math.max(1, Math.round((wanted / 800) * 4) / 4)) : 1
    tab.capture = null
    try {
      await cdp.send('Runtime.evaluate', { expression: CAPTURE_STOP_SCRIPT, returnByValue: true }, tab.cdpSessionId)
    } catch {
      // 上个页面可能已经没了
    }
    const evaluated = await cdp.send(
      'Runtime.evaluate',
      { expression: CAPTURE_SCRIPT, awaitPromise: true, userGesture: true, returnByValue: true },
      tab.cdpSessionId,
    )
    if (evaluated?.exceptionDetails) {
      throw new BrowserError(`标签页拒绝共享：${evaluated.exceptionDetails.text ?? '未知原因'}`, 'CAPTURE_DENIED')
    }
    const deadline = Date.now() + 6_000
    while (Date.now() < deadline) {
      if (tab.capture?.offer) {
        // 逻辑视口固定 800×600（headless 捕获的 CSS 尺寸），DPR 放大实际像素。
        session.width = 800
        session.height = 600
        await cdp
          .send(
            'Emulation.setDeviceMetricsOverride',
            { width: 800, height: 600, deviceScaleFactor: dpr, mobile: false },
            tab.cdpSessionId,
          )
          .catch(() => {})
        broadcast(session, stateMessage(session))
        return { offer: tab.capture.offer, width: 800, height: 600, dpr }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new BrowserError('标签页没有给出 WebRTC offer（捕获可能被拒绝）', 'CAPTURE_FAILED')
  }

  /**
   * @param {string} dir
   * @returns {Promise<boolean>}
   */
  async function stopCapture(dir) {
    const session = sessions.get(dir)
    const tab = session ? activeTab(session) : null
    if (!tab || !browser) return false
    tab.capture = null
    await browser
      .send('Runtime.evaluate', { expression: CAPTURE_STOP_SCRIPT, returnByValue: true }, tab.cdpSessionId)
      .catch(() => {})
    // 不再用 Emulation 覆盖视口：视口由窗口决定。
    return true
  }

  /**
   * @param {string} dir
   * @param {{ sdp: string, type: string }} answer
   * @returns {Promise<void>}
   */
  async function acceptAnswer(dir, answer) {
    const session = sessions.get(dir)
    const tab = session ? activeTab(session) : null
    if (!tab || !browser) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    if (!answer || typeof answer.sdp !== 'string' || !answer.sdp) {
      throw new BrowserError('answer 缺少 sdp', 'BAD_ANSWER')
    }
    const expression = `window.__coderCaptureAccept ? window.__coderCaptureAccept(${JSON.stringify({
      sdp: answer.sdp,
      type: answer.type === 'answer' ? 'answer' : String(answer.type ?? 'answer'),
    })}) : null`
    await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, tab.cdpSessionId)
  }

  /**
   * @param {string} dir
   * @param {object} candidate
   * @returns {Promise<void>}
   */
  async function addCandidate(dir, candidate) {
    const session = sessions.get(dir)
    const tab = session ? activeTab(session) : null
    if (!tab || !browser) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    if (!candidate || typeof candidate.candidate !== 'string') return
    const expression = `window.__coderCaptureAddCandidate ? window.__coderCaptureAddCandidate(${JSON.stringify({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
      usernameFragment: candidate.usernameFragment ?? null,
    })}) : null`
    await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, tab.cdpSessionId)
  }

  /**
   * 标签页侧收集到的 ICE 候选（页面轮询取走）。
   *
   * @param {string} dir
   * @param {number} since
   * @returns {{ list: Array<object>, next: number }}
   */
  function captureCandidates(dir, since = 0) {
    const session = sessions.get(dir)
    const tab = session ? activeTab(session) : null
    const list = tab?.capture?.candidates ?? []
    return { list: list.slice(since), next: list.length }
  }

  /**
   * 读远程页面上某一点的光标形状（`pointer` / `text` / `grab` …）。
   *
   * @param {string} dir
   * @param {number} x
   * @param {number} y
   * @returns {Promise<string>}
   */
  async function cursorAt(dir, x, y) {
    const session = sessions.get(dir)
    const tab = session ? activeTab(session) : null
    if (!tab || !browser) return 'default'
    const pointX = Math.max(0, Math.min(session.width, Math.round(Number(x) || 0)))
    const pointY = Math.max(0, Math.min(session.height, Math.round(Number(y) || 0)))
    const expression = `(() => {
      const element = document.elementFromPoint(${pointX}, ${pointY})
      if (!element) return 'default'
      const style = getComputedStyle(element)
      return style.cursor || 'default'
    })()`
    const result = await browser
      .send('Runtime.evaluate', { expression, returnByValue: true }, tab.cdpSessionId)
      .catch(() => null)
    return String(result?.result?.value ?? 'default')
  }

  /**
   * 把当前标签页的视口改成面板尺寸（宽高随面板走；帧流与输入坐标都用这个尺寸）。
   *
   * @param {string} dir
   * @param {number} width
   * @param {number} height
   * @returns {Promise<object>}
   */
  async function setViewport(dir, width, height, cssWidth, cssHeight) {
    const session = sessions.get(dir)
    if (!session) throw new BrowserError('这个工作区还没有打开浏览器', 'NOT_OPEN')
    const logicalWidth = Math.min(2560, Math.max(320, Math.round(Number(cssWidth) || Number(width) || 0)))
    const logicalHeight = Math.min(1600, Math.max(240, Math.round(Number(cssHeight) || Number(height) || 0)))
    session.logicalWidth = logicalWidth
    session.logicalHeight = logicalHeight
    const tab = activeTab(session)
    if (tab && browser) {
      // 只读取当前内容尺寸，不再改窗口：窗口在打开时定一次，之后保持不动。
      const measured = await browser
        .send(
          'Runtime.evaluate',
          { expression: 'JSON.stringify([innerWidth, innerHeight])', returnByValue: true },
          tab.cdpSessionId,
        )
        .catch(() => null)
      try {
        const [cssW, cssH] = JSON.parse(measured?.result?.value ?? '[]')
        if (cssW > 0 && cssH > 0) {
          session.width = Math.round(cssW)
          session.height = Math.round(cssH)
        } else {
          session.width = logicalWidth
          session.height = logicalHeight
        }
      } catch {
        session.width = logicalWidth
        session.height = logicalHeight
      }
    } else {
      session.width = logicalWidth
      session.height = logicalHeight
    }
    broadcast(session, stateMessage(session))
    return stateOf(session)
  }

  /**
   * @param {string} dir
   * @returns {object}
   */
  function captureState(dir) {
    const session = sessions.get(dir)
    const tab = session ? activeTab(session) : null
    const capture = tab?.capture ?? null
    return {
      active: Boolean(capture),
      state: capture?.state ?? 'idle',
      width: capture?.width ?? 0,
      height: capture?.height ?? 0,
      offered: Boolean(capture?.offer),
    }
  }

  /**
   * @param {string} dir
   * @returns {Promise<boolean>}
   */
  async function close(dir) {
    const session = sessions.get(dir)
    if (!session) return false
    sessions.delete(dir)
    if (session.frameTimer) clearTimeout(session.frameTimer)
    if (browser) {
      for (const tab of session.tabs.values()) {
        await browser.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {})
      }
    }
    broadcast(session, { kind: 'closed', running: false })
    session.subscribers.clear()
    session.tabs.clear()
    return true
  }

  /**
   * 空闲清理：没有订阅者、且超过 idleMs 没动过的会话关掉；一个会话都不剩时把浏览器也停掉。
   *
   * @returns {void}
   */
  function sweep() {
    const now = Date.now()
    for (const [dir, session] of sessions) {
      if (now - session.lastTouch > idleMs && session.subscribers.size === 0) {
        close(dir).catch(() => {})
      }
    }
    if (sessions.size === 0 && browser) {
      const current = browser
      browser = null
      if (sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
      current.close().catch(() => {})
    }
  }

  /**
   * 关掉浏览器与全部会话。
   *
   * @returns {Promise<void>}
   */
  async function dispose() {
    if (sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
    for (const session of sessions.values()) {
      if (session.frameTimer) clearTimeout(session.frameTimer)
      session.subscribers.clear()
      session.tabs.clear()
    }
    sessions.clear()
    if (browser) {
      const current = browser
      browser = null
      await current.close().catch(() => {})
    }
  }

  /**
   * @param {string} dir
   * @returns {object | undefined}
   */
  function lastTouchedSession() {
    let best = null
    for (const session of sessions.values()) {
      if (!best || session.lastTouch > best.lastTouch) best = session
    }
    return best ?? undefined
  }

  /**
   * @param {string} cdpSessionId
   * @returns {{ session: object, tab: object } | null}
   */
  function byCdp(cdpSessionId) {
    for (const session of sessions.values()) {
      for (const tab of session.tabs.values()) {
        if (tab.cdpSessionId === cdpSessionId) return { session, tab }
      }
    }
    return null
  }

  /**
   * @param {string} targetId
   * @returns {{ session: object, tab: object } | null}
   */
  function findByTarget(targetId) {
    for (const session of sessions.values()) {
      const tab = session.tabs.get(targetId)
      if (tab) return { session, tab }
    }
    return null
  }

  /**
   * @param {string} targetId
   * @returns {boolean}
   */
  function knownTarget(targetId) {
    return Boolean(findByTarget(targetId))
  }

  return {
    open,
    close,
    dispose,
    input,
    navigate,
    reload,
    state,
    subscribe,
    newTab,
    activateTab: activateTabById,
    closeTab: closeTabById,
    startCapture,
    stopCapture,
    acceptAnswer,
    addCandidate,
    captureCandidates,
    captureState,
    setViewport,
    cursorAt,
    /** 测试用：当前会话表 */
    sessions,
  }
}
