import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  BrowserError,
  browserCandidates,
  createBrowserManager,
  findBrowserExecutable,
  isNavigableUrl,
  keyParamsOf,
  modifierBits,
  normalizeEvents,
  parseDevToolsActivePort,
} from '../src/browser.mjs'
import { tempDir } from './helpers.mjs'

test('DevToolsActivePort：两行（端口 + 浏览器级 ws 路径），坏数据不认', () => {
  assert.deepEqual(parseDevToolsActivePort('61707\n/devtools/browser/abc-123\n'), {
    port: 61707,
    path: '/devtools/browser/abc-123',
  })
  assert.equal(parseDevToolsActivePort(''), null)
  assert.equal(parseDevToolsActivePort('61707'), null)
  assert.equal(parseDevToolsActivePort('abc\n/devtools/browser/x'), null)
  assert.equal(parseDevToolsActivePort('61707\nnot-a-path'), null)
  assert.equal(parseDevToolsActivePort('0\n/devtools/browser/x'), null)
})

test('只允许 http(s)：file / javascript / 乱码都不导航', () => {
  assert.equal(isNavigableUrl('https://abc.feishu.cn/docx/1'), true)
  assert.equal(isNavigableUrl('http://127.0.0.1:8080/'), true)
  assert.equal(isNavigableUrl('HTTPS://ABC.FEISHU.CN/x'), true)
  assert.equal(isNavigableUrl('file:///C:/Windows/win.ini'), false)
  assert.equal(isNavigableUrl('javascript:alert(1)'), false)
  assert.equal(isNavigableUrl('data:text/html,x'), false)
  assert.equal(isNavigableUrl('abc.feishu.cn/docx/1'), false)
  assert.equal(isNavigableUrl(''), false)
})

test('输入事件：坐标夹到视图内、按钮与按键只认认识的，文本截断', () => {
  const view = { width: 100, height: 50 }
  const list = normalizeEvents(
    [
      { type: 'mouse', action: 'click', x: -5, y: 999, button: 'left', clickCount: 2 },
      { type: 'mouse', action: 'move', x: 50, y: 25, buttons: 1 },
      { type: 'wheel', x: 10, y: 10, deltaX: 9999, deltaY: -9999 },
      { type: 'text', text: '你好' },
      { type: 'text', text: '' },
      { type: 'key', key: 'Enter', modifiers: { shift: true } },
      { type: 'key', key: 'Z' },
      { type: 'unknown' },
      { type: 'mouse', x: 'a', y: 2 },
    ],
    view,
  )
  assert.deepEqual(
    list.map((item) => item.type),
    ['mouse', 'mouse', 'wheel', 'text', 'key'],
  )
  assert.deepEqual({ ...list[0] }, { type: 'mouse', action: 'click', x: 0, y: 50, button: 'left', clickCount: 2, buttons: 1 })
  assert.equal(list[1].buttons, 1, '拖动时按住左键')
  assert.equal(list[2].deltaX, 4000, '滚轮增量夹住')
  assert.equal(list[2].deltaY, -4000)
  assert.equal(list[3].text, '你好')
  assert.equal(list[4].key, 'Enter')
  assert.equal(list[4].modifiers.shift, true)

  const long = normalizeEvents([{ type: 'text', text: 'x'.repeat(9000) }], view)
  assert.equal(long[0].text.length, 4000)
  assert.deepEqual(normalizeEvents(null, view), [])
  assert.deepEqual(normalizeEvents([{ type: 'key', key: '?' }], view), [], '问号走 insertText，不走键事件')
})

test('键事件：特殊键有虚拟键码，修饰键按位或', () => {
  const enter = keyParamsOf('Enter')
  assert.equal(enter.down.type, 'rawKeyDown')
  assert.equal(enter.down.windowsVirtualKeyCode, 13)
  assert.equal(enter.up.type, 'keyUp')
  assert.equal(keyParamsOf(' ').down.code, 'Space')
  assert.equal(keyParamsOf('F1'), null)

  assert.equal(modifierBits({ ctrl: true }), 2)
  assert.equal(modifierBits({ shift: true, alt: true }), 9)
  assert.equal(keyParamsOf('ArrowDown', { ctrl: true }).down.modifiers, 2)
})

test('浏览器候选：环境变量优先，Windows 的安装路径都在列表里', () => {
  const env = { CODER_BROWSER: 'C:/custom/chrome.exe', ProgramFiles: 'C:/PF', LOCALAPPDATA: 'C:/LA' }
  const candidates = browserCandidates(env, 'win32')
  assert.equal(candidates[0], 'C:/custom/chrome.exe')
  assert.ok(candidates.some((item) => item.endsWith('Google\\Chrome\\Application\\chrome.exe')))
  assert.ok(candidates.some((item) => item.endsWith('Microsoft\\Edge\\Application\\msedge.exe')))

  // 存在性用真文件：本测试文件自己就是存在的
  assert.equal(findBrowserExecutable({ CODER_BROWSER: import.meta.filename }, 'win32'), import.meta.filename)
  assert.equal(findBrowserExecutable({ CODER_BROWSER: 'C:/definitely/not/here.exe' }, 'win32'), null)
})

/**
 * 假 CDP：记录每一条命令，能手动触发事件。
 *
 * @returns {{ send: Function, on: Function, onClose: Function, close: Function, emit: Function, commands: object[] }}
 */
function fakeConnection() {
  const commands = []
  const handlers = new Map()
  const closeListeners = new Set()
  const sessionIds = new Map()
  const send = async (method, params = {}, sessionId) => {
    commands.push({ method, params, sessionId })
    if (method === 'Target.createTarget') return { targetId: 't1' }
    if (method === 'Target.attachToTarget') {
      if (!sessionIds.has(params.targetId)) sessionIds.set(params.targetId, `s${sessionIds.size + 1}`)
      return { sessionId: sessionIds.get(params.targetId) }
    }
    if (method === 'Target.getTargetInfo') {
      const url = params.targetId === 'pop-1' ? 'https://example.com/popup' : 'about:blank'
      return { targetInfo: { type: 'page', url, targetId: params.targetId } }
    }
    if (method === 'Runtime.evaluate') return { result: { value: '示例页面' } }
    return {}
  }
  const on = (method, handler) => {
    const list = handlers.get(method) ?? []
    list.push(handler)
    handlers.set(method, list)
    return () => {}
  }
  const emit = (method, params, sessionId) => {
    for (const handler of handlers.get(method) ?? []) handler(params, sessionId)
  }
  return {
    send,
    on,
    emit,
    commands,
    onClose: (listener) => {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close: async () => {
      for (const listener of closeListeners) listener('测试关闭')
    },
  }
}

test('管理器：打开 → 导航 → 输入 → 帧 → 弹窗内部消化 → 关闭', async () => {
  const fake = fakeConnection()
  const manager = createBrowserManager({
    executable: 'C:/fake/chrome.exe',
    profileDir: 'C:/fake/profile',
    viewport: { width: 800, height: 600 },
    connect: async () => fake,
  })

  const opened = await manager.open('/repo', 'https://abc.feishu.cn/docx/1')
  assert.equal(opened.running, true)
  assert.equal(opened.url, 'https://abc.feishu.cn/docx/1')
  const methods = fake.commands.map((item) => item.method)
  for (const expected of [
    'Target.createTarget',
    'Target.attachToTarget',
    'Page.enable',
    'Runtime.enable',
    'Page.startScreencast',
    'Page.navigate',
  ]) {
    assert.ok(methods.includes(expected), `缺少 ${expected}`)
  }
  const navigate = fake.commands.find((item) => item.method === 'Page.navigate')
  assert.equal(navigate.sessionId, 's1')
  assert.equal(navigate.params.url, 'https://abc.feishu.cn/docx/1')

  // 再 open 一次同一个目录：复用，不新建 target
  await manager.open('/repo', 'https://abc.feishu.cn/docx/1')
  assert.equal(fake.commands.filter((item) => item.method === 'Target.createTarget').length, 1)

  // 帧：先 ack，再广播（等节流窗口过去）
  const received = []
  const off = manager.subscribe('/repo', (message) => received.push(message))
  assert.equal(received[0].kind, 'state', '订阅先收到状态')
  fake.emit(
    'Page.screencastFrame',
    { data: 'BASE64JPEG', metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 'frame-1' },
    's1',
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.ok(fake.commands.some((item) => item.method === 'Page.screencastFrameAck'))
  const frame = received.find((item) => item.kind === 'frame')
  assert.ok(frame, '应该收到一帧')
  assert.equal(frame.image, 'BASE64JPEG')
  assert.equal(manager.state('/repo').width, 800)

  // 页面内导航：宿主跟着更新 URL
  fake.emit('Page.frameNavigated', { frame: { url: 'https://abc.feishu.cn/docx/2', parentId: undefined } }, 's1')
  assert.equal(manager.state('/repo').url, 'https://abc.feishu.cn/docx/2')

  // 输入：点击 / 滚轮 / 文本 / 特殊键
  await manager.input('/repo', [
    { type: 'mouse', action: 'click', x: 10, y: 20 },
    { type: 'wheel', x: 10, y: 20, deltaY: 120 },
    { type: 'text', text: '你好' },
    { type: 'key', key: 'Enter' },
  ])
  const inputs = fake.commands.filter((item) => item.method.startsWith('Input.'))
  assert.deepEqual(
    inputs.map((item) => item.params.type ?? 'insertText'),
    ['mousePressed', 'mouseReleased', 'mouseWheel', 'insertText', 'rawKeyDown', 'keyUp'],
  )
  assert.equal(inputs[3].method, 'Input.insertText')
  assert.equal(inputs[3].params.text, '你好')

  // 弹窗 / target=_blank：收编成同一会话里的第二个标签页，并切过去
  fake.emit('Target.targetCreated', { targetInfo: { type: 'page', targetId: 'pop-1', url: 'https://example.com/popup' } })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const tabs = manager.state('/repo').tabs
  assert.equal(tabs.length, 2, '弹窗变成了第二个标签页')
  assert.equal(manager.state('/repo').activeId, 'pop-1', '新标签页被激活')
  assert.equal(manager.state('/repo').url, 'https://example.com/popup')
  assert.ok(
    !fake.commands.some((item) => item.method === 'Target.closeTarget' && item.params.targetId === 'pop-1'),
    '不关掉它',
  )
  // 之后的输入走新标签页的会话
  await manager.input('/repo', [{ type: 'text', text: 'x' }])
  const lastInsert = fake.commands.filter((item) => item.method === 'Input.insertText').pop()
  assert.equal(lastInsert.sessionId, 's2')

  // 关闭
  assert.equal(await manager.close('/repo'), true)
  assert.equal(manager.state('/repo').running, false)
  off()
})

test('管理器：帧节流、空闲清理、浏览器断开时清会话', async () => {
  const fake = fakeConnection()
  const manager = createBrowserManager({
    executable: 'C:/fake/chrome.exe',
    profileDir: 'C:/fake/profile',
    idleMs: 60_000,
    connect: async () => fake,
  })
  await manager.open('/a', 'https://a.feishu.cn/docx/1')
  const frames = []
  manager.subscribe('/a', (message) => {
    if (message.kind === 'frame') frames.push(message)
  })
  for (let i = 0; i < 3; i += 1) {
    fake.emit(
      'Page.screencastFrame',
      { data: `F${i}`, metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: `sess-${i}` },
      's1',
    )
  }
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(frames.length, 1, '80ms 内的多帧合成一次推送，取最后一帧')
  assert.equal(frames[0].image, 'F2')

  fake.close()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(manager.state('/a').running, false, '浏览器断了，会话也没了')
  await manager.dispose()
})

test('管理器：没有可执行文件时报 NO_BROWSER；不认识的 URL 报 BAD_URL', async () => {
  const manager = createBrowserManager({ executable: null, connect: async () => fakeConnection() })
  await assert.rejects(() => manager.open('/x', 'https://a.feishu.cn/docx/1'), (error) => {
    assert.ok(error instanceof BrowserError)
    assert.equal(error.code, 'NO_BROWSER')
    return true
  })
  const withBrowser = createBrowserManager({ executable: 'C:/fake/chrome.exe', connect: async () => fakeConnection() })
  await assert.rejects(() => withBrowser.open('/x', 'file:///etc/passwd'), (error) => error.code === 'BAD_URL')
  await assert.rejects(() => withBrowser.navigate('/nope', 'https://a.feishu.cn/'), (error) => error.code === 'NOT_OPEN')
  await withBrowser.dispose()
})

test('真浏览器：起一个 headless Chrome，打开本地页面拿到 URL 与帧，弹窗回到主视图', { skip: findBrowserExecutable() ? false : '本机没有 Chrome/Edge' }, async () => {
  const page = [
    '<!doctype html><title>coder-headless</title>',
    '<style>body{margin:0;font:16px sans-serif}button{position:absolute;left:40px;top:40px;font-size:24px;padding:12px 24px}</style>',
    '<button id="b">open a new doc</button>',
    "<script>document.getElementById('b').onclick = () => window.open('/popup-target', '_blank')</script>",
  ].join('')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (req.url === '/popup-target') {
      res.end('<!doctype html><title>coder-popup</title><h1>popup</h1>')
      return
    }
    res.end(page)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const profileDir = await tempDir('coder-browser-profile-')
  const manager = createBrowserManager({
    executable: findBrowserExecutable(),
    profileDir,
    viewport: { width: 800, height: 600 },
    idleMs: 120_000,
  })

  try {
    const opened = await manager.open('/repo', `http://127.0.0.1:${port}/`)
    assert.equal(opened.running, true)
    const frame = await new Promise((resolve) => {
      let timer = null
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        off()
        resolve(value)
      }
      let off = () => {}
      off = manager.subscribe('/repo', (message) => {
        if (message.image || message.frame?.image) finish(message)
      })
      timer = setTimeout(() => finish(null), 15_000)
    })
    assert.ok(frame, '应该拿到一帧画面')
    const image = frame.image ?? frame.frame.image
    assert.ok(image.length > 100, '帧是 base64 JPEG')
    const state = manager.state('/repo')
    assert.match(state.url, new RegExp(`127\\.0\\.0\\.1:${port}`))

    // 标题由 load 之后的一次 evaluate 补上：给它一点时间。
    let title = ''
    for (let i = 0; i < 40 && title !== 'coder-headless'; i += 1) {
      title = manager.state('/repo').title
      if (title !== 'coder-headless') await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(title, 'coder-headless', '标题也读得到')

    await manager.input('/repo', [{ type: 'wheel', x: 100, y: 100, deltaY: 50 }])

    // 点「打开新文档」：window.open 变成一个新 target，宿主读出 URL 后让主视图导航过去。
    await manager.input('/repo', [{ type: 'mouse', action: 'click', x: 120, y: 60, clickCount: 1 }])
    let popupUrl = ''
    for (let i = 0; i < 60 && !popupUrl.endsWith('/popup-target'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      popupUrl = manager.state('/repo').url
    }
    assert.match(popupUrl, /\/popup-target$/, '弹窗在同一个视图里打开，而不是另开窗口')

    await manager.reload('/repo')
  } finally {
    await manager.dispose()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('管理器：标签页新建 / 切换 / 关闭，捕获走绑定事件', async () => {
  const commands = []
  const handlers = new Map()
  const closeHandlers = new Set()
  const sessionIds = new Map()
  let created = 0
  const fake = {
    commands,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    emit(event, params, sessionId) {
      for (const fn of handlers.get(event) ?? []) fn(params, sessionId)
    },
    async send(method, params = {}, sessionId) {
      commands.push({ method, params, sessionId })
      if (method === 'Page.captureScreenshot') return { data: 'STILL' }
      if (method === 'Browser.getWindowForTarget') return { windowId: 7 }
      if (method === 'Target.createTarget') {
        created += 1
        return { targetId: `t${created}` }
      }
      if (method === 'Target.attachToTarget') {
        if (!sessionIds.has(params.targetId)) sessionIds.set(params.targetId, `s${sessionIds.size + 1}`)
        return { sessionId: sessionIds.get(params.targetId) }
      }
      if (method === 'Target.getTargetInfo') {
        const url = params.targetId === 't2' ? 'https://b.test/' : 'https://a.test/'
        return { targetInfo: { type: 'page', url, targetId: params.targetId } }
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '')
        if (expression.includes('elementFromPoint')) return { result: { value: 'pointer' } }
        if (expression.includes('getDisplayMedia')) {
          setTimeout(() => {
            fake.emit(
              'Runtime.bindingCalled',
              {
                name: '__coderCapture',
                payload: JSON.stringify({ kind: 'offer', sdp: 'v=0 offer', type: 'offer', width: 800, height: 600 }),
              },
              sessionId,
            )
            fake.emit(
              'Runtime.bindingCalled',
              {
                name: '__coderCapture',
                payload: JSON.stringify({
                  kind: 'candidate',
                  candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host', sdpMid: '0', sdpMLineIndex: 0 },
                }),
              },
              sessionId,
            )
          }, 0)
          return { result: { value: 'ok' } }
        }
        return { result: { value: '示例' } }
      }
      return {}
    },
    onClose(fn) {
      closeHandlers.add(fn)
    },
    async close() {},
  }
  const manager = createBrowserManager({
    executable: 'C:/fake/chrome.exe',
    profileDir: 'C:/fake/profile',
    viewport: { width: 1280, height: 800 },
    connect: async () => fake,
  })

  const first = await manager.open('/repo', 'https://a.test/')
  assert.equal(first.tabs.length, 1)
  const capture = await manager.startCapture('/repo')
  assert.equal(capture.offer.sdp, 'v=0 offer')
  assert.equal(capture.width, 800)
  assert.equal(manager.state('/repo').width, 800, '视口跟着捕获尺寸走')
  await manager.acceptAnswer('/repo', { sdp: 'v=0 answer', type: 'answer' })
  await manager.addCandidate('/repo', {
    candidate: 'candidate:1 1 udp 1 1.2.3.4 1 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
  })
  assert.equal(manager.captureCandidates('/repo').list.length, 1)
  assert.equal(manager.captureState('/repo').active, true)

  const second = await manager.newTab('/repo', 'https://b.test/')
  assert.equal(second.tabs.length, 2)
  assert.equal(second.url, 'https://b.test/')
  const back = await manager.activateTab('/repo', first.tabs[0].id)
  assert.equal(back.activeId, first.tabs[0].id)
  assert.equal(back.url, 'https://a.test/')
  const closed = await manager.closeTab('/repo', second.tabs[1].id)
  assert.equal(closed.tabs.length, 1)

  const cursor = await manager.cursorAt('/repo', 12, 34)
  assert.equal(cursor, 'pointer', '光标形状来自远程页面')

  const sized = await manager.setViewport('/repo', 1240, 780)
  assert.equal(sized.width, 1240, '视口跟面板走')
  assert.equal(sized.height, 780)
  assert.ok(sized.width === 1240, '视口回退到面板尺寸')

  await manager.stopCapture('/repo')
  assert.equal(manager.captureState('/repo').active, false)
  assert.ok(
    commands.some((item) => String(item.params.expression ?? '').includes('__coderCaptureAccept')),
    'answer 写回页面',
  )
  assert.ok(
    commands.some((item) => String(item.params.expression ?? '').includes('__coderCaptureAddCandidate')),
    '对端候选写回页面',
  )
})

test('管理器：标签页有上限，超出时关最久没用的非当前标签', async () => {
  const commands = []
  const sessionIds = new Map()
  let created = 0
  const fake = {
    commands,
    on() {},
    onClose() {},
    async send(method, params = {}, sessionId) {
      commands.push({ method, params, sessionId })
      if (method === 'Target.createTarget') {
        created += 1
        return { targetId: `t${created}` }
      }
      if (method === 'Target.attachToTarget') {
        if (!sessionIds.has(params.targetId)) sessionIds.set(params.targetId, `s${sessionIds.size + 1}`)
        return { sessionId: sessionIds.get(params.targetId) }
      }
      if (method === 'Target.getTargetInfo') {
        return { targetInfo: { type: 'page', url: 'about:blank', targetId: params.targetId } }
      }
      return {}
    },
    async close() {},
  }
  const manager = createBrowserManager({
    executable: 'C:/fake/chrome.exe',
    profileDir: 'C:/fake/profile',
    maxTabs: 3,
    connect: async () => fake,
  })

  const first = await manager.open('/repo', 'https://a.test/')
  await manager.newTab('/repo', 'https://b.test/')
  await manager.newTab('/repo', 'https://c.test/')
  const fourth = await manager.newTab('/repo', 'https://d.test/')

  assert.equal(fourth.tabs.length, 3, '最多 3 个标签')
  assert.ok(
    !fourth.tabs.some((tab) => tab.url === 'https://a.test/'),
    '最久没用的非当前标签被关掉',
  )
  assert.equal(fourth.url, 'https://d.test/')
  assert.ok(
    commands.some(
      (item) => item.method === 'Target.closeTarget' && item.params.targetId === first.tabs[0].id,
    ),
    '真的调了 closeTarget',
  )
})
