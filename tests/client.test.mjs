import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { renderToString } from 'react-dom/server'

import { buildClient } from '../scripts/build-client.mjs'

const root = path.resolve(import.meta.dirname, '..')
const CLIENT = path.join(root, 'client.js')

/**
 * 按浏览器的样子加载 client.js：捕获模块表注册，返回插件工厂。
 *
 * @param {{ prefs?: object }} [seed] 预置的 localStorage 内容
 * @returns {Promise<{ def: { id: string, factory: Function }, factory: Function, store: Map<string, string> }>}
 */
async function loadBundle(seed = {}) {
  const text = await fs.readFile(CLIENT, 'utf8')
  let captured = null
  const store = new Map()
  if (seed.prefs) store.set('coder.page.v1', JSON.stringify(seed.prefs))
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured = definition
        },
      },
      localStorage: {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
      },
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(text, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load')
  // 宿主给的 require：react / react-dom 都用宿主那一份（hooks 与渲染器必须是同一个实例）。
  const require = (name) => {
    const mod = name === 'react-dom' ? ReactDOM : React
    return { __esModule: true, default: mod, ...mod }
  }
  return { def: captured, factory: () => captured.factory(require), store }
}

test('client.js 是构建产物，且和源码一致', async () => {
  const generated = await buildClient()
  assert.equal(await fs.readFile(CLIENT, 'utf8'), generated, 'client.js 落后了：跑 `npm run build:client`')
})

test('记住上次的工作区、文件、设计文档：读回预置的偏好，坏数据当没有，写回是 JSON', async () => {
  const prefs = {
    dir: 'C:/repo/a',
    files: { 'C:/repo/a': 'packages/x/docs/codes.jsonl' },
    design: { 'C:/repo/a': 'https://abc.feishu.cn/docx/xyz' },
    designMode: { 'C:/repo/a': 'home' },
    designDraft: { 'C:/repo/a': 'https://abc.feishu.cn/docx/draft' },
    designLast: { 'C:/repo/a': 'https://abc.feishu.cn/docx/seen' },
  }
  const loaded = await loadBundle({ prefs })
  const plugin = loaded.factory()
  const test = plugin.__test
  assert.ok(test, '插件对象上要挂测试用的纯函数')

  const read = test.readPrefs()
  // 跨 realm 的对象原型不一样，摊平成本 realm 的普通对象再比。
  assert.equal(read.dir, prefs.dir)
  assert.deepEqual({ ...read.files }, prefs.files)
  assert.deepEqual({ ...read.design }, prefs.design, '设计文档地址按工作区读回来')
  assert.deepEqual({ ...read.designMode }, prefs.designMode, '上次停在主页也记着')
  assert.deepEqual({ ...read.designDraft }, prefs.designDraft, '输入框里没载入的原文也记着')
  assert.deepEqual({ ...read.designLast }, prefs.designLast, '最后浏览到哪也记着')
  assert.equal('blockPopups' in read, false, '拦截弹窗那个开关已经不需要了')
  assert.equal(test.draftKeyOf('C:/repo/a', 'docs/codes.jsonl'), 'C:/repo/a::docs/codes.jsonl')

  const next = {
    dir: 'C:/repo/b',
    files: { 'C:/repo/b': 'docs/codes.jsonl' },
    design: { 'C:/repo/b': 'https://other.feishu.cn/docx/1' },
    designMode: {},
    designDraft: {},
    designLast: {},
  }
  test.writePrefs(next)
  assert.deepEqual(JSON.parse(loaded.store.get('coder.page.v1')), next)

  // 开局选谁：记着的优先，记着的不在了回落到默认工作区，再回落到第一份。
  const list = [{ path: 'C:/repo/a' }, { path: 'C:/repo/b' }]
  assert.equal(test.chooseWorkspace(list, 'C:/repo/b', 'C:/repo/a').path, 'C:/repo/b', '记着的优先')
  assert.equal(test.chooseWorkspace(list, 'C:/gone', 'C:/repo/a').path, 'C:/repo/a', '记着的没了用默认')
  assert.equal(test.chooseWorkspace(list, '', 'C:/gone').path, 'C:/repo/a', '默认也没了用第一份')
  assert.equal(test.chooseWorkspace([], 'C:/repo/a', 'C:/repo/a'), null, '空列表返回 null')

  const files = [{ rel: 'apps/x/docs/codes.jsonl' }, { rel: 'docs/codes.jsonl' }]
  assert.equal(
    test.chooseFile(files, undefined, 'docs/codes.jsonl', 'apps/x/docs/codes.jsonl').rel,
    'docs/codes.jsonl',
    '这个工作区记着的文件优先',
  )
  assert.equal(
    test.chooseFile(files, 'apps/x/docs/codes.jsonl', 'docs/codes.jsonl', '').rel,
    'apps/x/docs/codes.jsonl',
    '显式指定压过记忆',
  )
  assert.equal(test.chooseFile(files, 'gone/docs/codes.jsonl', undefined, '').rel, files[0].rel, '找不到就用第一份')
  assert.equal(test.chooseFile([], undefined, undefined, ''), null, '没有文件返回 null')

  // 坏数据不抛：当成没有偏好
  const broken = await loadBundle()
  broken.store.set('coder.page.v1', '{not json')
  const empty = broken.factory().__test.readPrefs()
  assert.equal(empty.dir, '')
  assert.deepEqual({ ...empty.files }, {})
  assert.deepEqual({ ...empty.design }, {})
  assert.deepEqual({ ...empty.designMode }, {})
  assert.deepEqual({ ...empty.designDraft }, {})
  assert.deepEqual({ ...empty.designLast }, {})

  // 半坏的数据：只认认识的模式、非字符串的草稿丢掉
  const partial = await loadBundle()
  partial.store.set(
    'coder.page.v1',
    JSON.stringify({
      designMode: { a: 'home', b: 'doc', c: 1 },
      designDraft: { a: ' text ', b: 42 },
      designLast: { a: 'https://x.feishu.cn/docx/1', b: 'javascript:alert(1)' },
    }),
  )
  const raw = partial.factory().__test.readPrefs()
  assert.deepEqual({ ...raw.designMode }, { a: 'home' }, '只认 home')
  assert.deepEqual({ ...raw.designDraft }, { a: ' text ' }, '只认非空字符串')
  assert.deepEqual({ ...raw.designLast }, { a: 'https://x.feishu.cn/docx/1' }, '只认 http(s)')
})

test('设计文档地址：没写协议补 https，只收 http(s)，飞书域名按后缀判断', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  assert.equal(
    test.designUrlOf('  https://abc.feishu.cn/docx/xyz?from=share  '),
    'https://abc.feishu.cn/docx/xyz?from=share',
    '去空白、查询串保留',
  )
  assert.equal(test.designUrlOf('abc.feishu.cn/docx/xyz'), 'https://abc.feishu.cn/docx/xyz', '没写协议就补 https')
  assert.equal(test.designUrlOf(''), '', '空字符串表示清掉这份设计文档')
  assert.equal(test.designUrlOf('   '), '')
  assert.equal(test.designUrlOf('javascript:alert(1)'), null, '别的协议不收')
  assert.equal(test.designUrlOf('ftp://x.feishu.cn/a'), null)
  assert.equal(test.designUrlOf('https://localhost/docx/1'), null, '没有域名不收')

  assert.equal(test.isFeishuUrl('https://abc.feishu.cn/docx/xyz'), true)
  assert.equal(test.isFeishuUrl('https://a.larksuite.com/docx/1'), true)
  assert.equal(test.isFeishuUrl('https://abc.larkoffice.com/wiki/1'), true)
  assert.equal(test.isFeishuUrl('https://feishu.cn.evil.com/docx/1'), false, '按域名后缀判断，不被前缀骗')
  assert.equal(test.isFeishuUrl('https://example.com/docx/1'), false)
  assert.equal(test.isFeishuUrl(''), false)

  // 「飞书文档主页」：有地址就用同一租户的主页，没有就 feishu.cn 的
  assert.equal(test.feishuHomeOf('https://abc.feishu.cn/docx/xyz'), 'https://abc.feishu.cn/drive/home/')
  assert.equal(
    test.feishuHomeOf('https://a.larksuite.com/wiki/1?from=share'),
    'https://a.larksuite.com/drive/home/',
    '主页不带原文档的查询串',
  )
  assert.equal(test.feishuHomeOf('https://example.com/doc'), 'https://www.feishu.cn/drive/home/', '不是飞书就回落到 feishu.cn')
  assert.equal(test.feishuHomeOf(''), 'https://www.feishu.cn/drive/home/')
  assert.equal(test.feishuHomeOf('javascript:alert(1)'), 'https://www.feishu.cn/drive/home/')

  // 「飞书文档主页」嵌哪一个：输入框里刚粘的优先，其次这个工作区已保存的，再其次公共主页
  assert.equal(
    test.designHomeTargetOf('https://a.feishu.cn/docx/1', 'https://b.feishu.cn/docx/2'),
    'https://b.feishu.cn/drive/home/',
    '还没载入的地址也算数',
  )
  assert.equal(test.designHomeTargetOf('https://a.feishu.cn/docx/1', ''), 'https://a.feishu.cn/drive/home/')
  assert.equal(test.designHomeTargetOf('', '随便写的'), 'https://www.feishu.cn/drive/home/')
})

test('批量启用/禁用只改 enabled，路径列表是一条一条的', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  const rows = [
    { code: 'D001', kind: 'debug', enabled: true, rule: 'a' },
    { code: 'Q001', kind: 'quality', enabled: false, rule: 'b' },
  ]
  const disabled = test.withAllEnabled(rows, false)
  assert.deepEqual(disabled.map((row) => row.enabled), [false, false])
  assert.deepEqual(disabled.map((row) => row.code), ['D001', 'Q001'])
  assert.equal(disabled[0].rule, 'a', '别的字段原样保留')
  assert.equal(rows[0].enabled, true, '不改原数组')
  assert.equal(test.withAllEnabled(null, true), null, '没有数据时原样返回')

  // 「移除未启用」是整条删掉，和只关开关的批量禁用不一样
  const mixed = [
    { code: 'D001', enabled: true },
    { code: 'Q001', enabled: false },
    { code: 'Q002', enabled: 'false' },
  ]
  assert.deepEqual([...test.withoutDisabled(mixed).map((row) => row.code)], ['D001'])
  assert.equal(mixed.length, 3, '不改原数组')
  assert.equal(test.withoutDisabled(null), null)

  // 输入框那一套：去首尾空白、去重；中间的空格留着（描述里需要）
  assert.deepEqual([...test.addTarget(['Session'], ' Session#append ')], ['Session', 'Session#append'])
  assert.deepEqual([...test.addTarget([], ' 所有 XxxService ')], ['所有 XxxService'])
  assert.deepEqual([...test.addTarget(['Session'], 'Session')], ['Session'], '重复的不加')
  assert.deepEqual([...test.addTarget(['Session'], '   ')], ['Session'], '空白不加')

  // 列表渲染：两个名字各一行，空列表显示占位文案
  const list = renderToString(
    React.createElement(test.TargetList, {
      value: ['Session', 'Session#append'],
      onChange() {},
      placeholder: 'Session#append',
      empty: 'No targets',
      addLabel: 'Add',
      removeLabel: 'Remove',
    }),
  )
  assert.match(list, /Session#append/)
  assert.match(list, /ant-list-item/)

  const emptyList = renderToString(
    React.createElement(test.TargetList, {
      value: [],
      onChange() {},
      placeholder: 'p',
      empty: 'No targets',
      addLabel: 'Add',
      removeLabel: 'Remove',
    }),
  )
  assert.match(emptyList, /No targets/)
})

test('导入：别人的 json / md 都能读，二进制文件说清楚读不了', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  const one = '{"code":"D001","check":"runtime","severity":"error","rule":"r","detect":"d"}'
  const jsonl = test.parseImported(`${one}\n${one.replace('D001', 'Q001')}\n`)
  assert.equal(jsonl.shape, 'json')
  assert.deepEqual([...jsonl.rows.map((row) => row.code)], ['D001', 'Q001'])

  const array = test.parseImported(`[${one}]`)
  assert.deepEqual([...array.rows.map((row) => row.code)], ['D001'])

  const wrapped = test.parseImported(`{"codes":[${one}],"notes":"x"}`)
  assert.deepEqual([...wrapped.rows.map((row) => row.code)], ['D001'])

  // 名字不一样、级别写中文、用 disabled 表示未启用、短编号、解决思路用中文键
  const foreign = test.parseImported(
    '{"id":"D1","description":"禁止直接使用 console。","level":"错误","disabled":true,"targets":"Session#append","解决思路":"换成 log()"}',
  )
  assert.equal(foreign.shape, 'json')
  const row = foreign.rows[0]
  assert.equal(row.code, 'D001', 'D1 补成 D001')
  assert.equal(row.kind, 'debug')
  assert.equal(row.severity, 'error')
  assert.equal(row.enabled, false, 'disabled:true 等于 enabled:false')
  assert.equal(row.rule, '禁止直接使用 console。')
  assert.equal(row.fix, '换成 log()', '中文键「解决思路」写进 fix')
  assert.deepEqual([...row.targets], ['Session#append'])

  // markdown：列表项逐条读成 Q 码
  const md = test.parseImported(
    ['# 规范', '', '- 必须使用结构化日志。', '* 禁止直接使用 console。', '', '```js', '- 这不是要求', '```'].join('\n'),
  )
  assert.equal(md.shape, 'text')
  assert.deepEqual([...md.rows.map((item) => item.rule)], ['必须使用结构化日志。', '禁止直接使用 console。'])
  assert.deepEqual([...md.rows.map((item) => item.code)], ['Q001', 'Q002'])
  assert.ok(md.rows.every((item) => item.check === 'static' && item.detect))

  // 二进制（docx / doc / pdf）读不出来
  const binary = test.parseImported('PK\u0000\u0003\u0004binary', '需求.docx')
  assert.equal(binary.shape, 'binary')
  assert.match(binary.problems[0].message, /二进制/)

  const empty = test.parseImported('   ')
  assert.equal(empty.row, undefined)
  assert.equal(empty.shape, 'empty')

  // 既不是 JSON 也没有条目
  assert.equal(test.parseImported('这是一段说明文字').shape, 'unknown')
})

test('client.js 可执行：注册左侧栏图标 + 主区域页面，页面用 antd 渲染', async () => {
  const { def, factory } = await loadBundle()
  assert.equal(def.id, 'coder')

  const plugin = factory()
  // 跨 realm 的数组原型不一样，展开成本 realm 的数组再比。
  assert.deepEqual([...plugin.inject], ['slots', 'locale'])

  const main = []
  const panellist = []
  const slots = {
    inject(key, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      if (options.name === 'main') main.push({ options, component })
      if (options.name === 'sidebar.panellist') panellist.push({ options, component })
      return () => {}
    },
  }
  const locale = {
    register: () => () => {},
    bind: () => (key) => key,
    subscribe: () => () => {},
  }
  const ctx = {
    // 真客户端里 slots 是 ctx 上的服务，同时也能 ctx.get('slots') 拿到。
    slots,
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return locale
      return undefined
    },
    effect(callback) {
      callback()
      return () => {}
    },
  }

  plugin.apply(ctx)

  assert.deepEqual(main.map((item) => item.options.key), ['coder'], '一个 app 一个页面')
  assert.deepEqual(panellist.map((item) => item.options.id), ['coder'], '左侧栏一项：Coder')
  assert.equal(panellist[0].options.order, 20)

  // 图标能画出来（接收 size / active）
  const icon = renderToString(React.createElement(panellist[0].component, { size: 18, active: true }))
  assert.match(icon, /<svg/)
  assert.match(icon, /<rect/)

  // 页面能挂载：首帧是加载态，但 app 名字、四个 Tab、设计页的工具条与画面容器都在 HTML 里。
  // 假 locale 把 key 原样返回，所以这里同时验证了「词典没命中时退回英文」。
  const html = renderToString(React.createElement(main[0].component, {}))
  assert.match(html, /ant-btn/, 'antd 的按钮要出现')
  assert.match(html, /Coder/, 'app 叫 Coder')
  assert.match(html, /ant-tabs/, '顶部是 Tab')
  assert.match(html, /Design/, '第一个 Tab 是设计')
  assert.match(html, /Codes/, '第二个 Tab 是诊断码')
  assert.match(html, /Reports/, '第三个 Tab 是诊断报告')
  assert.match(html, /Solutions/, '第四个 Tab 是解决方案')
  assert.ok(html.indexOf('Design') < html.indexOf('Codes'), '「设计」排在「诊断码」前面')
  // 默认停在设计页：地址输入框、画面 canvas、连接中的遮罩（别的 Tab 没激活就不渲染）。
  assert.match(html, /https:\/\/xxx\.feishu\.cn\/docx\//, '设计页有地址输入框的占位文案')
  assert.match(html, /<canvas/, '设计页用 canvas 画服务端推来的帧')
  assert.match(html, /Connecting to the headless browser/, '首帧是「连接中」')
  assert.match(html, /Feishu docs home/, '有「飞书文档主页」按钮')
  assert.doesNotMatch(html, /Block popups/, '拦截弹窗那个开关已经不需要了（弹窗由宿主侧消化）')
  assert.doesNotMatch(html, /Run coder_debug/, '诊断码那一页没被激活，按钮不在这一帧里')
  assert.doesNotMatch(html, /Diagnosis reports/, '报告不再是单独的一页')

  // 工作区只有一个选择器：Tab 栏右边那个。各页自己不再放（设计页这一帧里没有第二个）。
  const workspaceLabels = (html.match(/>Workspace</g) || []).length
  assert.equal(workspaceLabels, 1, '页面里只该有一个「工作区」标签')
  assert.match(html, /ant-tabs-extra-content[\s\S]{0,4000}?ant-select/, '工作区下拉就在 Tab 栏里')
})

test('画面坐标：canvas 的 CSS 坐标换成视图逻辑坐标，越界夹住', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test
  const rect = { left: 100, top: 50, width: 640, height: 400 }
  const view = { width: 1280, height: 800 }
  assert.deepEqual({ ...test.pointInViewport(rect, view, 100, 50) }, { x: 0, y: 0 }, '左上角')
  assert.deepEqual({ ...test.pointInViewport(rect, view, 420, 250) }, { x: 640, y: 400 }, '正中间')
  assert.deepEqual({ ...test.pointInViewport(rect, view, 740, 450) }, { x: 1280, y: 800 }, '右下角')
  assert.deepEqual({ ...test.pointInViewport(rect, view, 0, 0) }, { x: 0, y: 0 }, '框外夹到边界')
  assert.deepEqual({ ...test.pointInViewport(rect, view, 9999, 9999) }, { x: 1280, y: 800 })
})

test('编号胶囊是反色的：深底浅字（深色主题反过来），不依赖品牌色', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  const light = test.numberChipStyle({ colorText: 'rgba(0,0,0,0.88)', colorBgContainer: '#ffffff' })
  assert.equal(light.background, 'rgba(0,0,0,0.88)', '浅色主题：深底')
  assert.equal(light.color, '#ffffff', '浅色主题：浅字')
  assert.equal(light.fontWeight, 700, '编号加粗')

  const dark = test.numberChipStyle({ colorText: 'rgba(255,255,255,0.85)', colorBgContainer: '#141414' })
  assert.equal(dark.background, 'rgba(255,255,255,0.85)', '深色主题：浅底')
  assert.equal(dark.color, '#141414', '深色主题：深字')

  // 宿主品牌是墨色：编号不能跟着品牌色走，否则就是黑底黑字。
  assert.equal('colorPrimary' in light, false)
  assert.equal('colorPrimaryBg' in light, false)
})

test('解决方案两列：左边是码，右边只有选中那个码的方案，编号和勾选框都在', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  const data = {
    codes: [
      { code: 'D001', kind: 'debug', rule: '禁止直接使用 console。' },
      { code: 'Q002', kind: 'quality', rule: '日志要结构化。' },
    ],
    solutions: [
      { id: 2, code: 'Q002', title: '换结构化日志', problem: '第二条的问题', fix: '用 log()' },
      { id: 1, code: 'D001', title: '删掉 console', problem: '第一条的问题', fix: '删掉' },
      { id: 3, code: '', title: '没写码的方案', fix: '随便改' },
    ],
  }
  const groups = test.groupSolutionsByCode(data)
  assert.deepEqual([...groups.map((group) => group.code)], ['D001', 'Q002', '—'], '组按码排序，没写码的垫底')
  assert.equal(groups[0].rule, '禁止直接使用 console。')
  assert.deepEqual([...groups[1].rows.map((row) => row.id)], [2], '组内按编号')

  const token = {
    colorFillSecondary: 'rgba(0,0,0,0.06)',
    colorBorder: 'rgba(0,0,0,0.15)',
    colorBorderSecondary: 'rgba(0,0,0,0.06)',
    colorTextSecondary: 'rgba(0,0,0,0.6)',
    colorText: 'rgba(0,0,0,0.88)',
    colorPrimary: '#1677ff',
    colorPrimaryBg: '#e6f4ff',
    colorPrimaryBorder: '#91caff',
    colorFillQuaternary: 'rgba(0,0,0,0.02)',
  }
  const render = (activeCode, selected = []) =>
    renderToString(
      React.createElement(test.SolutionGroups, {
        groups,
        activeCode,
        onSelect() {},
        selected,
        onToggle() {},
        t: (key) => key,
        token,
      }),
    )

  const first = render('')
  assert.match(first, /D001/, '左边列出第一个码')
  assert.match(first, /Q002/, '左边列出第二个码')
  assert.match(first, /#1/, '右边显示方案编号')
  assert.match(first, /第一条的问题/, '右边是第一个码的方案')
  assert.doesNotMatch(first, /第二条的问题/, '没选中的码的方案不出现')
  assert.match(first, /ant-checkbox/, '有勾选框')

  const checked = render('D001', [1])
  assert.match(checked, /ant-checkbox-checked/, '勾选状态来自 selected')

  const second = render('Q002')
  assert.match(second, /#2/)
  assert.match(second, /第二条的问题/)
  assert.doesNotMatch(second, /第一条的问题/)
})

test('方案文本排版：空行分段、条目成行、长句按句攒段', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  const blocks = test.textBlocksOf('第一句问题。第二句补充。\n\n- 第一条改法\n- 第二条改法\n3. 第三条')
  assert.deepEqual(
    [...blocks.map((block) => block.kind)],
    ['p', 'li', 'li', 'li'],
    '短句成段，条目成行',
  )
  assert.equal(blocks[0].text, '第一句问题。第二句补充。', '同一行短句合成一段')
  assert.equal(blocks[1].text, '第一条改法', '去掉列表符号')

  const long = test.textBlocksOf(
    [
      '这里说明问题的背景，大概二十来个字，够拆一句话了。',
      '再补充一点细节说明为什么它是真的问题，也差不多这么长。',
      '接着讲会影响什么，同样是一整句话的长度。',
      '然后给出判断依据，还是二十多个字的一句话。',
      '最后一句收尾，说明下一步要看哪里。',
    ].join(''),
  )
  assert.ok(long.length >= 2, `长文本拆成多段，实际 ${long.length} 段`)
  assert.ok(long.every((block) => block.kind === 'p'))
  assert.ok(long.every((block) => block.text.length <= 160), '每段不会太长')

  assert.deepEqual([...test.textBlocksOf('')], [], '空文本没有块')
  assert.deepEqual([...test.textBlocksOf('   \n  ')], [])
})

test('中英词典的键完全一致（少一个键就会退回英文，页面上就中英混排了）', async () => {
  const { factory } = await loadBundle()
  const messages = factory().__test.CODER_MESSAGES
  const en = Object.keys(messages.en).sort()
  const zh = Object.keys(messages.zh).sort()
  const missing = en.filter((key) => !zh.includes(key))
  const extra = zh.filter((key) => !en.includes(key))
  assert.deepEqual(missing, [], `中文缺这些键：${missing.join(', ')}`)
  assert.deepEqual(extra, [], `中文多了这些键：${extra.join(', ')}`)
  for (const key of en) {
    assert.equal(typeof messages.en[key], 'string', `en.${key} 要是字符串`)
    assert.equal(typeof messages.zh[key], 'string', `zh.${key} 要是字符串`)
  }
})

test('解决方案的勾选：按「工作区 + 运行」分开记，坏了当没勾', async () => {
  const { factory, store } = await loadBundle()
  const test = factory().__test

  assert.equal(test.pickKeyOf('C:/repo', 'run-1'), 'C:/repo::run-1')
  assert.deepEqual({ ...test.readSolutionPicks() }, {}, '一开始没勾')

  test.writeSolutionPicks({ 'C:/repo::run-1': [1, 2] })
  assert.deepEqual(JSON.parse(store.get('coder.picks.v1')), { 'C:/repo::run-1': [1, 2] })
  assert.deepEqual([...test.readSolutionPicks()['C:/repo::run-1']], [1, 2])

  store.set('coder.picks.v1', '{坏数据')
  assert.deepEqual({ ...test.readSolutionPicks() }, {}, '坏 JSON 当成没勾')
  store.set('coder.picks.v1', JSON.stringify({ a: 'x', b: [1, 'y', 3] }))
  assert.deepEqual([...test.readSolutionPicks().b], [1, 3], '非数字的条目丢掉')
})

test('诊断报告按码分组：组按码排序，组内先严重后位置，规则原文来自码快照', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  const report = {
    codes: [{ code: 'D001', kind: 'debug', severity: 'error', rule: '禁止直接使用 console。' }],
    diagnostics: [
      { id: 1, code: 'Q001', severity: 'warning', file: 'b.mjs', line: 2 },
      { id: 2, code: 'D001', severity: 'warning', file: 'a.mjs', line: 9 },
      { id: 3, code: 'D001', severity: 'error', file: 'a.mjs', line: 4 },
      { id: 4, code: 'D001', severity: 'error', file: 'a.mjs', line: 1 },
    ],
  }
  const groups = test.groupByCode(report)
  assert.deepEqual([...groups.map((group) => group.code)], ['D001', 'Q001'], '组按码排序')
  assert.equal(groups[0].rule, '禁止直接使用 console。', '标题用码快照里的规则原文')
  assert.deepEqual([...groups[0].rows.map((row) => row.id)], [4, 3, 2], '组内先 error 再 warning，同级别按行列号')
  assert.equal(groups[1].rule, '', '没有快照就只显示码')
  assert.equal(groups[1].kind, 'debug')

  assert.deepEqual([...test.groupByCode(null)], [], '没有报告就是空')
  assert.deepEqual([...test.groupByCode({ diagnostics: [] })], [], '没有诊断就是空')
})

test('诊断报告两列：左边是码，右边只有选中那个码的诊断条目', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  const groups = [
    {
      code: 'D001',
      kind: 'debug',
      severity: 'error',
      rule: '禁止直接使用 console。',
      rows: [{ id: 1, severity: 'error', file: 'a.mjs', line: 3, message: '第一条', steps: ['跑一次'] }],
    },
    {
      code: 'Q002',
      kind: 'quality',
      severity: 'warning',
      rule: '日志要结构化。',
      rows: [{ id: 2, severity: 'warning', file: 'b.mjs', line: 9, message: '第二条' }],
    },
  ]
  const token = {
    colorFillSecondary: 'rgba(0,0,0,0.06)',
    colorBorder: 'rgba(0,0,0,0.15)',
    colorBorderSecondary: 'rgba(0,0,0,0.06)',
    colorTextSecondary: 'rgba(0,0,0,0.6)',
  }
  const render = (activeCode) =>
    renderToString(
      React.createElement(test.ReportGroups, { groups, activeCode, onSelect() {}, t: (key) => key, token }),
    )

  const first = render('')
  assert.match(first, /D001/, '左边列出第一个码')
  assert.match(first, /Q002/, '左边列出第二个码')
  assert.match(first, /#1/, '右边显示诊断的编号')
  assert.match(first, /第一条/, '右边是第一个码的诊断')
  assert.doesNotMatch(first, /第二条/, '没选中的码的诊断不出现在右边')

  const second = render('Q002')
  assert.match(second, /#2/, '换码之后编号跟着换')
  assert.match(second, /第二条/, '选第二个码时显示它的诊断')
  assert.doesNotMatch(second, /第一条/, '另一个码的诊断收起')
  assert.match(second, /日志要结构化。/, '标题带规则原文')
})

test('诊断报告的文案：占位符按名字替换，缺了不会被写成 undefined', async () => {
  const { factory } = await loadBundle()
  const test = factory().__test

  assert.equal(test.fill('区间 {base}..{head}（{files} 个文件）', { base: 'a', head: 'b', files: '3' }), '区间 a..b（3 个文件）')
  assert.equal(test.fill('提交 {head}（对比 {base}，{files} 个文件）', { head: 'b' }), '提交 b（对比 {base}，{files} 个文件）')
  assert.equal(test.fill('没有占位符', {}), '没有占位符')
  assert.equal(test.fill(undefined, { a: '1' }), '')
})

test('面板宽度 → 捕获 DPR：800 起，0.25 一档，最高 2', async () => {
  const { factory } = await loadBundle()
  const api = factory().__test
  assert.equal(api.designCaptureDpr(0), 1)
  assert.equal(api.designCaptureDpr(800), 1)
  assert.equal(api.designCaptureDpr(900), 1.25)
  assert.equal(api.designCaptureDpr(1100), 1.5)
  assert.equal(api.designCaptureDpr(1300), 1.75)
  assert.equal(api.designCaptureDpr(1600), 2)
  assert.equal(api.designCaptureDpr(3000), 2)
})
