/**
 * coder 编辑页的 React 组件（antd 6）。
 *
 * 这一段由 `scripts/build-client.mjs` 用 esbuild 打包进 `client.js`：`react` 保持 external
 * （用宿主那一份，hooks 才能工作），antd / react-dom / 图标都打进同一个文件，浏览器里
 * 一个 `require('react')` 就够，不需要别的模块表条目。
 *
 * 数据全部走同一个源上的 `/coder/api`（见 src/web.mjs），页面不碰文件系统。
 */
import * as ReactNS from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Empty,
  Flex,
  Form,
  Input,
  List,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
  theme as antdTheme,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  ExportOutlined,
  FileTextOutlined,
  HomeOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons'

import {
  CHECK_TYPES,
  CODE_PATTERN,
  MAX_ROWS,
  SEVERITIES,
  checkOf,
  countsOf,
  enabledOf,
  kindOfCode,
  normalizeRow,
  nextCode,
  serializeCodes,
  targetsOf,
  validateRows,
  withoutDisabled,
} from '../codes-client.js'

/** 宿主给的是 CommonJS 还是 ESM 命名空间都认。 */
const React = ReactNS.default && ReactNS.default.createElement ? ReactNS.default : ReactNS
const { useCallback, useEffect, useMemo, useRef, useState } = React

/** Host 一侧的接口前缀（和 src/web.mjs 的 API_PREFIX 一致）。 */
const CODER_API = '/coder/api'

/** 页面用到的界面文案。 */
const CODER_MESSAGES = {
  en: {
    nav: 'Coder',
    title: 'Coder',
    tabDesign: 'Design',
    tabCodes: 'Codes',
    tabReports: 'Reports',
    workspace: 'Workspace',
    file: 'File',
    reload: 'Reload',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard',
    designPlaceholder: 'https://xxx.feishu.cn/docx/…',
    designLoad: 'Load',
    designOpen: 'Open in new window',
    designNewTab: 'New tab',
    designCloseTab: 'Close tab',
    designCaptureFailed: 'Screen capture failed',
    designNow: 'Now showing',
    designConnecting: 'Connecting to the headless browser…',
    designOpening: 'Opening the page…',
    designFailed: 'The browser failed',
    designDisconnected: 'The browser session ended',
    designReconnect: 'Reconnect',
    designTypeHint: 'Click the page once, then type — the IME works.',
    designType: 'Page keyboard input',
    designHome: 'Feishu docs home',
    designBack: 'Back to the design document',
    designSaved: 'Remembered this design document for this workspace.',
    designCleared: 'Cleared the design document for this workspace.',
    designInvalid: 'That is not a web address — it should look like https://xxx.feishu.cn/docx/…',
    designNotFeishu: 'Not a Feishu address — it will still be loaded here.',
    designEmbedHint: 'The page is a real Chrome running on the host: log in to Feishu inside it once.',
    add: 'New code',
    total: 'codes',
    debug: 'Debug',
    quality: 'Quality',
    static: 'Static',
    runtime: 'Runtime',
    disabled: 'disabled',
    empty: 'No docs/codes.jsonl in this workspace yet. Run coder_codes once and it appears here.',
    noWorkspace: 'No workspace yet. Open one first.',
    loadFailed: 'Could not load',
    saved: 'Saved',
    dirty: 'Unsaved changes',
    clean: 'Everything saved',
    rule: 'rule — the requirement, quoted from the document',
    detect: 'detect — how to check it',
    fix: 'fix — the idea for solving it',
    targets: 'targets — what it is about: exact names or a description',
    targetAdd: 'Add',
    targetEmpty: 'No targets — every place counts',
    clearAll: 'Clear all',
    clearAllConfirm: 'Clear every code in this file? Save to apply.',
    importFile: 'Import',
    imported: 'Imported {count} codes (replaced {before}). Save to apply.',
    importedText: 'Read {count} requirements out of the text as quality codes (check: static). Review before saving.',
    importFailed: 'Could not import',
    importEmpty: 'No codes in that file',
    collect: 'Collect with DSH',
    collectRunning: 'Collecting — the result lands in targets when it is done; you can leave this page.',
    collectDone: 'Collected {count} items and filled targets in — not saved yet.',
    collectEmpty: 'the conversation returned no targets',
    collectLost: 'The push connection dropped. The job is kept on the server; come back and it is picked up again.',
    collectExpired: 'That collect job is gone (the Host restarted, or it is over an hour old). Run it again.',
    collectFailed: 'Could not collect',
    runDebug: 'Run coder_debug',
    debugStarted: 'Started a diagnosis conversation in {workspace} (session {id}). It sits under that workspace in the sidebar.',
    debugFailed: 'Could not start the diagnosis',
    investigate: 'Triage report',
    investigateStarted: 'Started a triage conversation in {workspace} (session {id}). It drops false positives and proposes solutions; they land in the Solutions tab.',
    investigateFailed: 'Could not start the triage',
    launchTriageRunning: 'Triage is running in this workspace (session {id}, started {time}). Solutions land in the Solutions tab.',
    launchTriageDone: 'The last triage finished (session {id}). Reload the report, then check the Solutions tab.',
    launchTriageStarted: 'Triage started (session {id}).',
    launchFixRunning: 'The fix conversation is running in this workspace (session {id}, started {time}).',
    launchFixDone: 'The last fix conversation finished (session {id}).',
    launchFixStarted: 'Fix started (session {id}).',
    reports: 'Reports',
    reportsRefresh: 'Reload report',
    reportsEmpty: 'No diagnosis report in this workspace yet. Run "Run coder_debug" once and it lands here.',
    reportClean: 'no diagnostics',
    reportNoDiagnostics: 'This run found nothing to report.',
    reportGrouped: '{groups} codes · {diagnostics} diagnostics',
    reportCount: '{count}',
    reportScopeAll: 'whole repo at {head} ({files} files)',
    reportScopeRange: 'range {base}..{head} ({files} files)',
    reportScopeCommit: 'commit {head} vs {base} ({files} files)',
    reportVerify: 'review: {checked} checked → {confirmed} confirmed · {uncertain} uncertain · {dropped} dropped',
    reportVerifyFailed: 'review did not finish: {message}',
    reportConfirmed: 'confirmed',
    reportUncertain: 'uncertain',
    reportSteps: 'Steps',
    reportRepro: 'repro',
    tabSolutions: 'Solutions',
    solutionsEmpty: 'No solutions yet. Open the Reports tab and press "Triage report" first.',
    solutionsRefresh: 'Reload solutions',
    solutionsSelected: '{count} selected',
    solutionsSelectAll: 'Select all',
    solutionsClear: 'Clear',
    solutionsApply: 'Fix selected',
    solutionsStarted: 'Started a fix conversation in {workspace} for {count} solutions (session {id}).',
    solutionsFailed: 'Could not start the fix',
    solutionsNone: 'Nothing selected',
    solutionRisk: 'risk',
    solutionConfidence: 'confidence',
    solutionFiles: 'touches',
    solutionProblem: 'Problem',
    solutionFix: 'Fix',
    enabled: 'enabled',
    issues: 'to fix',
    check: 'check',
    severity: 'severity',
    code: 'code',
    list: 'Codes',
    moveUp: 'Move up',
    moveDown: 'Move down',
    remove: 'Delete this code',
    removeConfirm: 'Delete this code?',
    pickCode: 'Pick a code on the left.',
    detail: 'Details',
    enableAll: 'Enable all',
    disableAll: 'Disable all',
    removeDisabled: 'Remove disabled',
    removeDisabledConfirm: 'Remove all {count} disabled codes? Save to apply.',
    removedDisabled: 'Removed {count} disabled codes. Save to apply.',
    draftRestored: 'Restored the unsaved draft you left when you moved away from this page. Save or discard to clear it.',
  },
  zh: {
    nav: 'Coder',
    title: 'Coder',
    tabDesign: '设计',
    tabCodes: '诊断码',
    tabReports: '诊断报告',
    workspace: '工作区',
    file: '文件',
    reload: '重新载入',
    save: '保存',
    saving: '保存中…',
    discard: '放弃修改',
    designPlaceholder: 'https://xxx.feishu.cn/docx/…',
    designLoad: '载入',
    designOpen: '新窗口打开',
    designNewTab: '新标签页',
    designCloseTab: '关闭标签页',
    designCaptureFailed: '投屏失败',
    designNow: '当前页面',
    designConnecting: '正在连接无头浏览器…',
    designOpening: '正在打开页面…',
    designFailed: '无头浏览器出错',
    designDisconnected: '浏览器会话结束了',
    designReconnect: '重新连接',
    designTypeHint: '先点一下画面再打字（中文输入法可用）。',
    designType: '页面键盘输入',
    designHome: '飞书文档主页',
    designBack: '回到设计文档',
    designSaved: '已记住这个工作区的设计文档地址。',
    designCleared: '已清掉这个工作区的设计文档地址。',
    designInvalid: '这不是网页地址：应该形如 https://xxx.feishu.cn/docx/…',
    designNotFeishu: '这不是飞书地址，不过照样会在这里载入。',
    designEmbedHint: '画面是宿主上的真实 Chrome：第一次用要在这里登录一次飞书。',
    add: '新增一条',
    total: '条码',
    debug: 'Debug',
    quality: 'Quality',
    static: 'Static',
    runtime: 'Runtime',
    disabled: '未启用',
    empty: '这个工作区里还没有 docs/codes.jsonl。先跑一次 coder_codes，它就会出现在这里。',
    noWorkspace: '还没有工作区：先打开一个工作区。',
    loadFailed: '读取失败',
    saved: '已保存',
    dirty: '有未保存的修改',
    clean: '没有改动',
    rule: 'rule — 规范文档里的原文',
    detect: 'detect — 怎么检查它',
    fix: 'fix — 解决思路：怎么改才算满足它',
    targets: '涉及 — 精确名字或一句描述',
    targetAdd: '添加',
    targetEmpty: '没写就表示不限，任何位置都算',
    clearAll: '全部清空',
    clearAllConfirm: '清空这份文件的全部诊断码？保存后生效。',
    importFile: '导入',
    imported: '导入了 {count} 条（替换原有 {before} 条），保存后生效。',
    importedText: '从文本里认出了 {count} 条要求，按 Q 码导入（检查方式默认「读代码」）；保存前先核对。',
    importFailed: '导入失败',
    importEmpty: '那个文件里没有可用的诊断码',
    collect: '让 DSH 搜集',
    collectDone: '搜集到 {count} 项，已填进 targets（还没保存）。',
    collectRunning: '正在搜集 —— 完成后结果会自己填进 targets；这期间你可以离开这个页面。',
    collectLost: '推送断了。任务还留在服务端，回到这里会自动再取一次。',
    collectExpired: '那条搜集任务已经没了（Host 重启过，或者已经超过 1 小时），需要重新点一次。',
    collectEmpty: '那个对话没有给出可用的 targets',
    collectFailed: '搜集失败',
    runDebug: '发起诊断',
    debugStarted: '已在「{workspace}」里发起诊断对话（会话 {id}），左侧栏那个工作区下面能看到它。',
    debugFailed: '发起诊断失败',
    investigate: '发起排查',
    investigateStarted: '已在「{workspace}」里发起排查对话（会话 {id}）：先排误报，再给真实问题的方案，方案会出现在「解决方案」页。',
    investigateFailed: '发起排查失败',
    launchTriageRunning: '这个工作区的排查还在跑（会话 {id}，{time} 发起）—— 方案会出现在「解决方案」页。',
    launchTriageDone: '上次排查已经结束（会话 {id}）：点「重新载入报告」，然后去「解决方案」页看方案。',
    launchTriageStarted: '已发起排查（会话 {id}）。',
    launchFixRunning: '这个工作区的解决还在跑（会话 {id}，{time} 发起）。',
    launchFixDone: '上次解决对话已经结束（会话 {id}）。',
    launchFixStarted: '已发起解决（会话 {id}）。',
    reports: '诊断报告',
    reportsRefresh: '重新载入报告',
    reportsEmpty: '这个工作区还没有诊断报告。点一次「发起诊断」，跑完就出现在这里。',
    reportClean: '没有诊断',
    reportNoDiagnostics: '这次运行没有需要报告的诊断。',
    reportGrouped: '{groups} 个码 · {diagnostics} 条诊断',
    reportCount: '{count}',
    reportScopeAll: '整个仓库（提交 {head} 的完整文件树，{files} 个文件）',
    reportScopeRange: '区间 {base}..{head}（{files} 个文件）',
    reportScopeCommit: '提交 {head}（对比 {base}，{files} 个文件）',
    reportVerify: '复核 {checked} 条 → 确认 {confirmed} · 存疑 {uncertain} · 排除误报 {dropped}',
    reportVerifyFailed: '复核没有完成：{message}',
    reportConfirmed: '已确认',
    reportUncertain: '存疑',
    reportSteps: '复现步骤',
    reportRepro: '复现',
    tabSolutions: '解决方案',
    solutionsEmpty: '还没有解决方案。先到「诊断报告」页点「发起排查」。',
    solutionsRefresh: '重新载入方案',
    solutionsSelected: '已勾选 {count} 个',
    solutionsSelectAll: '全选',
    solutionsClear: '清空勾选',
    solutionsApply: '对勾选的发起正式解决',
    solutionsStarted: '已在「{workspace}」里发起解决对话，处理 {count} 个方案（会话 {id}）。',
    solutionsFailed: '发起解决失败',
    solutionsNone: '一个都没勾选',
    solutionRisk: '风险',
    solutionConfidence: '把握',
    solutionFiles: '涉及',
    solutionProblem: '问题',
    solutionFix: '方案',
    enabled: '启用',
    issues: '处待修正',
    check: '检查',
    severity: '级别',
    code: '码',
    list: '诊断码',
    moveUp: '上移',
    moveDown: '下移',
    remove: '删除这条',
    removeConfirm: '删除这条码？',
    pickCode: '在左边挑一条码。',
    detail: '详情',
    enableAll: '全部启用',
    disableAll: '全部禁用',
    removeDisabled: '移除未启用',
    removeDisabledConfirm: '移除全部 {count} 条未启用的码？保存后生效。',
    removedDisabled: '已移除 {count} 条未启用的码，保存后生效。',
    draftRestored: '已恢复上次离开本页时的未保存草稿；保存或放弃后它就没了。',
  },
}
CODER_MESSAGES['zh-Hans-CN'] = CODER_MESSAGES.zh
CODER_MESSAGES['zh-Hant'] = CODER_MESSAGES.zh

/** 等宽字体：码、路径、规则原文都用它。 */
const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace'

/**
 * 编号胶囊的样式：**反色**胶囊（浅色主题深底浅字，深色主题浅底深字）。
 *
 * 不用 `colorPrimary` / `colorPrimaryBg`：宿主的品牌色是墨色，由它推导出来的底也是深色，
 * 编号就会变成黑底黑字、完全看不清。
 *
 * @param {object} token
 * @returns {object}
 */
function numberChipStyle(token) {
  return {
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: 700,
    color: token.colorBgContainer,
    background: token.colorText,
    borderRadius: 6,
    padding: '0 6px',
    lineHeight: '20px',
  }
}

/**
 * 把 `{name}` 占位符换成值；没给的就原样留着（翻译里少一个占位符不会变成 undefined）。
 *
 * @param {string} text
 * @param {Record<string, string>} values
 * @returns {string}
 */
function fill(text, values) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  )
}

/**
 * 会话 id 的短写法：`session-<uuid>` 先去掉前缀再取 8 位 ——
 * 直接 `slice(0, 8)` 永远是 "session-"，看不出是哪次。
 *
 * @param {unknown} sessionId
 * @returns {string}
 */
function shortSessionOf(sessionId) {
  const text = String(sessionId ?? '')
  const bare = text.startsWith('session-') ? text.slice('session-'.length) : text
  return bare.slice(0, 8)
}

/** 记住「上次看的是哪个工作区、哪个文件」的钥匙：只存路径，不存内容。 */
const PREFS_KEY = 'coder.page.v1'

/** 解决方案页勾选了哪些（按「工作区 + 运行」分开记）。 */
const PICKS_KEY = 'coder.picks.v1'

/** 页面开出去的「排查 / 解决」对话：Host 重启后仍在，回来至少有提示。 */
const LAUNCH_KEY = 'coder.launches.v1'

/**
 * 读回最近开出去的对话（坏了当没有）。
 *
 * @returns {Array<{ kind: string, dir: string, runId: string, sessionId: string, at: number }>}
 */
function readLaunches() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(LAUNCH_KEY)
    if (!raw) return []
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item) => item && typeof item === 'object' && item.sessionId)
  } catch {
    return []
  }
}

/**
 * 记一次「页面开出去的对话」：同一个会话只留一条，最多 20 条。
 *
 * @param {{ kind: string, dir: string, runId?: string, sessionId: string }} input
 * @returns {void}
 */
function rememberLaunch(input) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const sessionId = String(input.sessionId ?? '')
    if (!sessionId) return
    const list = readLaunches().filter((item) => item.sessionId !== sessionId)
    list.push({
      kind: String(input.kind ?? ''),
      dir: String(input.dir ?? ''),
      runId: String(input.runId ?? ''),
      sessionId,
      at: Date.now(),
    })
    window.localStorage.setItem(LAUNCH_KEY, JSON.stringify(list.slice(-20)))
  } catch {
    // 存不下就算了：提示只是锦上添花
  }
}

/**
 * 把 Host 回的状态与本地记的合并：Host 知道的以它为准（`running` 才有值）。
 *
 * @param {Array<object> | null | undefined} hostItems
 * @param {string} kind
 * @param {string} dir
 * @returns {Array<object>}
 */
function mergeLaunches(hostItems, kind, dir) {
  const byId = new Map()
  for (const item of readLaunches()) {
    if (item.kind !== kind || item.dir !== dir) continue
    byId.set(item.sessionId, { ...item, running: null })
  }
  for (const item of Array.isArray(hostItems) ? hostItems : []) {
    if (item.kind !== kind) continue
    byId.set(item.sessionId, { ...item, running: item.running ?? null })
  }
  return [...byId.values()].sort((left, right) => Number(right.at ?? 0) - Number(left.at ?? 0))
}

/**
 * 启动时间给提示用（HH:MM）。
 *
 * @param {unknown} at
 * @returns {string}
 */
function clockOf(at) {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 一条「页面开出去的对话」（排查 / 解决）的状态文案。
 *
 * @param {object | null} launch
 * @param {'triage'|'fix'} kind
 * @param {(key: string) => string} t
 * @returns {string}
 */
function launchTextOf(launch, kind, t) {
  if (!launch) return ''
  const id = shortSessionOf(launch.sessionId)
  const triage = kind === 'triage'
  if (launch.running === true) {
    return fill(t(triage ? 'launchTriageRunning' : 'launchFixRunning'), { id, time: clockOf(launch.at) })
  }
  if (launch.running === false) {
    return fill(t(triage ? 'launchTriageDone' : 'launchFixDone'), { id })
  }
  return fill(t(triage ? 'launchTriageStarted' : 'launchFixStarted'), { id })
}

/**
 * 勾选的存储键：一次运行一组。
 *
 * @param {string} dir
 * @param {string} runId
 * @returns {string}
 */
function pickKeyOf(dir, runId) {
  return `${dir}::${runId}`
}

/**
 * 读回勾选过哪些方案（坏了就当没勾）。
 *
 * @returns {Record<string, number[]>}
 */
function readSolutionPicks() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(PICKS_KEY)
    if (!raw) return {}
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const picks = {}
    for (const [key, list] of Object.entries(value)) {
      if (!Array.isArray(list)) continue
      picks[key] = list.map((id) => Number(id)).filter(Number.isFinite)
    }
    return picks
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, number[]>} picks
 * @returns {void}
 */
function writeSolutionPicks(picks) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(PICKS_KEY, JSON.stringify(picks))
  } catch {
    // 存不下就算了：勾选只是页面状态
  }
}


/** 还没取回结果的搜集任务：人离开页面、连接断了也不丢，下次回来接着取。 */
const JOB_KEY = 'coder.job.v1'

/**
 * 还没取回结果的搜集任务（localStorage）。连接断了或人离开页面时，回来用它继续取。
 *
 * @returns {{ id: string, dir: string, rel: string, code: string } | null}
 */
function readJob() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(JOB_KEY)
    if (!raw) return null
    const value = JSON.parse(raw)
    if (!value?.id || !value?.dir || !value?.rel) return null
    return { id: String(value.id), dir: String(value.dir), rel: String(value.rel), code: String(value.code ?? '') }
  } catch {
    return null
  }
}

/**
 * @param {{ id: string, dir: string, rel: string, code: string } | null} job
 * @returns {void}
 */
function writeJob(job) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    if (!job) window.localStorage.removeItem(JOB_KEY)
    else window.localStorage.setItem(JOB_KEY, JSON.stringify(job))
  } catch {
    // 存不下只是不能跨页面恢复，不影响本次
  }
}

/**
 * 一份草稿的 key：工作区 + 文件。同一份文件在一个 entry 生命周期里只有一份草稿。
 *
 * @param {string} dir
 * @param {string} rel
 * @returns {string}
 */
function draftKeyOf(dir, rel) {
  return dir && rel ? `${dir}::${rel}` : ''
}

/**
 * 读上次的选择。存 localStorage 是为了刷新页面、重启 DSH 之后还认；
 * 读坏了就当没有（值都是路径，拿不到就回退到默认工作区）。
 *
 * `design` 是「每个工作区各自的设计文档地址」：飞书文档是私人链接，只留在浏览器里。
 * `designMode` 记「上次停在设计文档还是飞书文档主页」，`designDraft` 记输入框里还没载入的原文 ——
 * 三者都是按工作区分开的，所以离开再回来、刷新、重启都接着上次。
 *
 * @returns {{
 *   dir: string,
 *   files: Record<string, string>,
 *   design: Record<string, string>,
 *   designMode: Record<string, string>,
 *   designDraft: Record<string, string>,
 *   designLast: Record<string, string>,
 * }}
 */
function readPrefs() {
  const empty = { dir: '', files: {}, design: {}, designMode: {}, designDraft: {}, designLast: {} }
  try {
    if (typeof window === 'undefined' || !window.localStorage) return empty
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return empty
    const value = JSON.parse(raw)
    const files = {}
    if (value && typeof value.files === 'object' && value.files) {
      for (const [key, rel] of Object.entries(value.files)) {
        if (typeof rel === 'string' && rel) files[key] = rel
      }
    }
    const design = {}
    if (value && typeof value.design === 'object' && value.design) {
      for (const [key, url] of Object.entries(value.design)) {
        // 只认 http(s)：老数据里万一混进别的协议，读的时候就丢掉。
        if (typeof url === 'string' && designUrlOf(url)) design[key] = designUrlOf(url)
      }
    }
    const designMode = {}
    if (value && typeof value.designMode === 'object' && value.designMode) {
      for (const [key, mode] of Object.entries(value.designMode)) {
        if (mode === 'home') designMode[key] = 'home'
      }
    }
    const designDraft = {}
    if (value && typeof value.designDraft === 'object' && value.designDraft) {
      for (const [key, text] of Object.entries(value.designDraft)) {
        if (typeof text === 'string' && text.trim()) designDraft[key] = text
      }
    }
    const designLast = {}
    if (value && typeof value.designLast === 'object' && value.designLast) {
      for (const [key, last] of Object.entries(value.designLast)) {
        if (typeof last === 'string' && /^https?:\/\//i.test(last)) designLast[key] = last
      }
    }
    return {
      dir: typeof value?.dir === 'string' ? value.dir : '',
      files,
      design,
      designMode,
      designDraft,
      designLast,
    }
  } catch {
    return empty
  }
}

/**
 * @param {object} prefs
 * @returns {void}
 */
function writePrefs(prefs) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        dir: prefs.dir,
        files: prefs.files,
        design: prefs.design ?? {},
        designMode: prefs.designMode ?? {},
        designDraft: prefs.designDraft ?? {},
        designLast: prefs.designLast ?? {},
      }),
    )
  } catch {
    // 存不下就只是没有记忆，不影响编辑。
  }
}

/**
 * 把输入框里的文字读成一个设计文档地址。
 *
 * 允许只写 `xxx.feishu.cn/docx/…`：补上 `https://`。空字符串表示「清掉这份设计文档」；
 * 认不出来（别的协议、没有域名）返回 `null`，由页面报错、不覆盖原来的地址。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function designUrlOf(value) {
  const text = String(value == null ? '' : value).trim()
  if (!text) return ''
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  const match = candidate.match(/^(https?):\/\/([^/?#\s]+)([^#\s]*)$/i)
  if (!match) return null
  const authority = match[2]
  const host = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '')
  if (!host || host.indexOf('.') < 0) return null
  return `${match[1].toLowerCase()}://${authority}${match[3]}`
}

/** 飞书 / Lark 的域名（含私有化部署常见的子域）。 */
const FEISHU_HOST = /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com|feishu\.net)$/i

/**
 * 这个地址是不是飞书文档。只是提示用 —— 不是飞书地址也照样载入。
 *
 * @param {unknown} url
 * @returns {boolean}
 */
function isFeishuUrl(url) {
  const match = String(url == null ? '' : url).match(/^https?:\/\/([^/?#]+)/i)
  if (!match) return false
  const host = match[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '')
  return FEISHU_HOST.test(host)
}

/** 飞书云文档主页：手上还没有地址时用它。 */
const FEISHU_HOME = 'https://www.feishu.cn/drive/home/'

/**
 * 云文档主页地址：手上有飞书文档地址就用**同一个租户**的主页，否则回落到 feishu.cn。
 *
 * 主页是「去飞书里找/选一份文档」的入口：打开它、挑一份、复制链接、再粘回上面那个输入框。
 *
 * @param {unknown} url
 * @returns {string}
 */
function feishuHomeOf(url) {
  const match = String(url == null ? '' : url).match(/^(https?):\/\/([^/?#]+)/i)
  if (match) {
    const host = match[2].replace(/^[^@]*@/, '').replace(/:\d+$/, '')
    if (FEISHU_HOST.test(host)) return `${match[1].toLowerCase()}://${host}/drive/home/`
  }
  return FEISHU_HOME
}

/**
 * 「飞书文档主页」该嵌哪一个：输入框里刚粘的那一个优先（还没载入也算），
 * 其次看这个工作区已保存的地址；都认不出来就用 feishu.cn 的公共主页。
 *
 * @param {string} url 这个工作区已保存的设计文档地址
 * @param {string} draft 输入框里的原文
 * @returns {string}
 */
/**
 * 面板宽度 → 捕获用的设备像素比：800 起，0.25 一档，最高 2。
 *
 * @param {number} width
 * @returns {number}
 */
function designCaptureDpr(width) {
  const value = Number(width) || 0
  if (value <= 800) return 1
  return Math.min(2, Math.max(1, Math.round((value / 800) * 4) / 4))
}

function designHomeTargetOf(url, draft) {
  return feishuHomeOf(designUrlOf(draft) || url || '')
}

/**
 * 开局选哪个工作区：记着的 → 默认工作区 → 第一份。
 *
 * @param {Array<{ path: string }>} list
 * @param {string} remembered
 * @param {string} defaultDir
 * @returns {{ path: string } | null}
 */
function chooseWorkspace(list, remembered, defaultDir) {
  return (
    list.find((item) => item.path === remembered) ||
    list.find((item) => item.path === defaultDir) ||
    list[0] ||
    null
  )
}

/**
 * 选哪份 codes.jsonl：显式指定 → 这个工作区记着的 → 当前这份 → 第一份。
 *
 * @param {Array<{ rel: string }>} list
 * @param {string | undefined} preferRel
 * @param {string | undefined} rememberedRel
 * @param {string} currentRel
 * @returns {{ rel: string } | null}
 */
function chooseFile(list, preferRel, rememberedRel, currentRel) {
  const wanted = preferRel === undefined ? rememberedRel ?? currentRel : preferRel
  return list.find((file) => file.rel === wanted) || list[0] || null
}

/**
 * 跟随宿主主题：暗色与否，以及品牌色（直接读宿主写在 body 上的令牌）。
 *
 * @returns {{ dark: boolean, brand: string }}
 */
function useHostTheme() {
  const read = useCallback(() => {
    const body = typeof document === 'undefined' ? null : document.body
    if (!body) return { dark: false, brand: '' }
    let brand = ''
    try {
      brand = getComputedStyle(body).getPropertyValue('--dsw-alias-brand-primary').trim()
    } catch {
      brand = ''
    }
    return { dark: body.hasAttribute('data-ds-dark-theme'), brand }
  }, [])

  const [state, setState] = useState(read)

  useEffect(() => {
    const body = typeof document === 'undefined' ? null : document.body
    if (!body || typeof MutationObserver !== 'function') return undefined
    const observer = new MutationObserver(() => setState(read()))
    observer.observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style', 'class'] })
    return () => observer.disconnect()
  }, [read])

  return state
}

/**
 * 从各种「不是 codes.jsonl」的文件里读出诊断码。
 *
 * 三条路，按顺序试：
 * 1. JSON / JSONL / `{codes:[…]}`：字段名不一定是我们的写法，交给 `coerceRow` 认别名；
 * 2. markdown / 纯文本：把 `- …`、`* …`、`1. …` 这类要求条目逐条读成码；
 * 3. 二进制（docx / doc / pdf / 图片…）：读不出来，直接说清楚。
 *
 * @param {string} text
 * @param {string} [name] 原始文件名，只用于提示
 * @returns {{ rows: Array<object>, problems: Array<object>, shape: 'json'|'text'|'binary'|'empty'|'unknown' }}
 */
function parseImported(text, name) {
  const raw = String(text ?? '')
  const trimmed = raw.trim()
  if (!trimmed) {
    return {
      rows: [],
      problems: [{ line: null, index: -1, field: null, message: '文件是空的' }],
      shape: 'empty',
    }
  }
  if (raw.indexOf('\u0000') >= 0 || (raw.match(/\uFFFD/g) || []).length > raw.length / 20) {
    return {
      rows: [],
      problems: [
        {
          line: null,
          index: -1,
          field: null,
          message: `${name || '这个文件'} 是二进制（docx / doc / pdf / 图片之类），先导出成文本或 markdown 再导入`,
        },
      ],
      shape: 'binary',
    }
  }

  const json = importedJson(trimmed)
  if (json) return json

  const lines = requirementLines(trimmed)
  if (lines.length > 0) {
    let rows = []
    for (const line of lines.slice(0, MAX_ROWS)) {
      rows = [...rows, coerceRow({ rule: line }, rows)]
    }
    return { rows, problems: [], shape: 'text' }
  }

  return {
    rows: [],
    problems: [
      {
        line: null,
        index: -1,
        field: null,
        message: `${name || '这个文件'} 里没有认出可用的诊断码（既不是 JSON，也没有「- 要求」这类条目）`,
      },
    ],
    shape: 'unknown',
  }
}

/**
 * 按 JSON 读：整份 JSON、`{codes:[…]}`、或者一行一个对象。
 *
 * @param {string} text
 * @returns {{ rows: Array<object>, problems: Array<object>, shape: 'json' } | null}
 */
function importedJson(text) {
  const asList = (value) => {
    if (Array.isArray(value)) return value
    if (value && Array.isArray(value.codes)) return value.codes
    if (value && typeof value === 'object') return [value]
    return []
  }

  if (text.charAt(0) === '[' || text.charAt(0) === '{') {
    try {
      const list = asList(JSON.parse(text))
      if (list.length > 0) return buildRows(list)
    } catch {
      // 不是整份 JSON：下面按 JSONL 再试
    }
  }

  const items = []
  for (const line of text.split('\n')) {
    const row = line.trim()
    if (!row) continue
    try {
      const value = JSON.parse(row)
      if (value && typeof value === 'object') items.push(...asList(value))
    } catch {
      return null
    }
  }
  return items.length > 0 ? buildRows(items) : null
}

/**
 * 把任意形状的对象列表改成我们的行：认不出的字段就留着，缺的补齐。
 *
 * @param {Array<unknown>} items
 * @returns {{ rows: Array<object>, problems: Array<object>, shape: 'json' }}
 */
function buildRows(items) {
  let rows = []
  for (const item of items.slice(0, MAX_ROWS)) {
    if (typeof item === 'string') rows = [...rows, coerceRow({ rule: item }, rows)]
    else if (item && typeof item === 'object') rows = [...rows, coerceRow(item, rows)]
  }
  return { rows, problems: [], shape: 'json' }
}

/** 各个字段可能叫什么。 */
const FIELD_ALIASES = {
  code: ['code', 'id', 'key', 'no', '编号', '码'],
  rule: ['rule', 'requirement', 'description', 'desc', 'message', 'text', 'title', '规则', '要求', '内容', '说明'],
  detect: ['detect', 'how', 'checkHow', 'method', 'verification', '检查', '检查方法', '怎么检查'],
  fix: ['fix', 'idea', 'solution', 'remedy', 'approach', 'advice', '解决思路', '修复思路', '修法', '怎么改', '建议'],
  check: ['check', 'checkType', 'type', '检查类型'],
  severity: ['severity', 'level', 'priority', '级别', '严重程度'],
  targets: ['targets', 'target', 'symbols', 'objects', '涉及', '对象'],
  enabled: ['enabled', 'active', '启用'],
  disabled: ['disabled', 'off'],
}

/**
 * 按别名取一个值；空字符串算没写。
 *
 * @param {object} raw
 * @param {string[]} keys
 * @returns {unknown}
 */
function pickField(raw, keys) {
  for (const key of keys) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && !value.trim()) continue
    return value
  }
  return undefined
}

/**
 * 把各种写法收成一行码：`id`/`编号`、`description`、`level: 错误`、`disabled: true` 这些都能认。
 *
 * @param {object} raw
 * @param {Array<object>} [existing] 已经收下的行，用来给没写码的条目续号
 * @returns {object}
 */
function coerceRow(raw, existing) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const rawCode = String(pickField(source, FIELD_ALIASES.code) ?? '').trim().toUpperCase()
  // 允许 `D1` / `Q7` 这种短编号：补成 D001 / Q007。
  const padded = rawCode.replace(/^([DQ])(\d{1,2})$/, (_, prefix, digits) => prefix + String(Number(digits)).padStart(3, '0'))
  const guessedKind = kindOfCode(padded) || 'quality'
  const code = CODE_PATTERN.test(padded) ? padded : nextCode(existing || [], guessedKind)
  const kind = kindOfCode(code) || 'debug'

  const rawSeverity = String(pickField(source, FIELD_ALIASES.severity) ?? '').trim().toLowerCase()
  const severity =
    /error|error|fatal|high|错误|严重|高/.test(rawSeverity)
      ? 'error'
      : /warn|medium|警告|中/.test(rawSeverity)
        ? 'warning'
        : /info|low|提示|建议|低/.test(rawSeverity)
          ? 'info'
          : 'warning'

  const rawCheck = String(pickField(source, FIELD_ALIASES.check) ?? '').trim().toLowerCase()
  const check =
    /static|静态|读代码/.test(rawCheck)
      ? 'static'
      : /runtime|动态|运行/.test(rawCheck)
        ? 'runtime'
        : kind === 'quality'
          ? 'static'
          : 'runtime'

  const rawTargets = pickField(source, FIELD_ALIASES.targets)
  const targets = Array.isArray(rawTargets)
    ? targetsOf(rawTargets)
    : targetsOf(String(rawTargets ?? ''))

  let enabled
  const disabledValue = pickField(source, FIELD_ALIASES.disabled)
  if (disabledValue !== undefined) enabled = !enabledOf(disabledValue)
  else enabled = enabledOf(pickField(source, FIELD_ALIASES.enabled))

  const row = normalizeRow({
    ...source,
    code,
    kind,
    check,
    enabled,
    severity,
    rule: String(pickField(source, FIELD_ALIASES.rule) ?? '').trim(),
    detect: String(pickField(source, FIELD_ALIASES.detect) ?? '').trim(),
    fix: String(pickField(source, FIELD_ALIASES.fix) ?? '').trim(),
    targets,
  })
  if (!row.detect) row.detect = '读代码判断它是否做到'
  if (!row.rule) row.rule = row.detect
  return row
}

/**
 * 从 markdown / 纯文本里挑「要求条目」：列表项、编号项，跳过标题、代码块、引用与空行。
 *
 * @param {string} text
 * @returns {string[]}
 */
function requirementLines(text) {
  const out = []
  let fenced = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('>')) continue
    const bullet = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/)
    const body = bullet ? bullet[1].trim() : ''
    if (body.length < 4) continue
    if (out.indexOf(body) >= 0) continue
    out.push(body)
    if (out.length >= MAX_ROWS) break
  }
  return out
}

/**
 * 往对象列表里加一条：去首尾空白、去重。中间的空格保留 ——
 * targets 可以是一句「所有 XxxService」这样的描述。
 *
 * @param {string[]} items 已有的名字
 * @param {string} draft 输入框里的原文
 * @returns {string[]} 新列表（什么都没加时原样返回）
 */
function addTarget(items, draft) {
  const next = String(draft || '').trim()
  if (!next || items.includes(next)) return items
  return [...items, next]
}

/**
 * 批量启用/禁用：只改 `enabled`，其它字段原样保留。
 *
 * @param {Array<object> | null} list
 * @param {boolean} value
 * @returns {Array<object> | null}
 */
function withAllEnabled(list, value) {
  return Array.isArray(list) ? list.map((row) => ({ ...row, enabled: value })) : list
}

/**
 * 一条 targets 列表：一行一个名字，行尾删，下面一个输入框加一条。
 *
 * 名字是 class / interface / method，写成 `Type`、`Type#member` 或 `Type.member`。
 *
 * @param {{
 *   value: unknown,
 *   onChange: (value: string[]) => void,
 *   placeholder: string,
 *   empty: string,
 *   addLabel: string,
 *   removeLabel: string,
 * }} props
 * @returns {object}
 */
function TargetList({ value, onChange, placeholder, empty, addLabel, removeLabel }) {
  const items = targetsOf(value)
  const [draft, setDraft] = useState('')

  function add() {
    const next = addTarget(items, draft)
    if (next !== items) onChange(next)
    setDraft('')
  }

  return (
    <div>
      <List
        size="small"
        bordered
        dataSource={items}
        locale={{ emptyText: <span style={{ opacity: 0.6 }}>{empty}</span> }}
        renderItem={(item, index) => (
          <List.Item
            style={{ padding: '2px 4px 2px 10px' }}
            actions={[
              <Button
                key="remove"
                size="small"
                type="text"
                icon={<CloseOutlined />}
                aria-label={removeLabel}
                onClick={() => onChange(items.filter((_, at) => at !== index))}
              />,
            ]}
          >
            <Typography.Text style={{ fontFamily: MONO, fontSize: 12.5 }}>{item}</Typography.Text>
          </List.Item>
        )}
      />
      <Space.Compact style={{ width: '100%', marginTop: 6 }}>
        <Input
          size="small"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={add}
        />
        <Button
          size="small"
          icon={<PlusOutlined />}
          aria-label={addLabel}
          onClick={add}
          disabled={!draft.trim()}
        />
      </Space.Compact>
    </div>
  )
}


/**
 * canvas 上的一个点 → 无头浏览器的逻辑坐标（0..width / 0..height）。
 *
 * @param {{ left: number, top: number, width: number, height: number }} rect
 * @param {{ width: number, height: number }} viewport
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ x: number, y: number }}
 */
function pointInViewport(rect, viewport, clientX, clientY) {
  const x = ((clientX - rect.left) / rect.width) * viewport.width
  const y = ((clientY - rect.top) / rect.height) * viewport.height
  return {
    x: Math.max(0, Math.min(viewport.width, Math.round(x))),
    y: Math.max(0, Math.min(viewport.height, Math.round(y))),
  }
}

/** 直接投递的键（可打印字符走输入法 / insertText）。 */
const KEY_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
])

/**
 * 「设计」那一页：一个内置浏览器。
 *
 * - 每个工作区是一个会话，会话里可以有多个标签页（新建 / 切换 / 关闭）；
 * - 当前标签页的画面来自**它自己的 `getDisplayMedia` 自捕获**（`preferCurrentTab`），
 *   通过 WebRTC 送到这里，用 `<video>` 显示；失败时回退到宿主的 JPEG 帧流（canvas）；
 * - 点击 / 滚轮 / 键盘仍然经 `/coder/api/browser/input` 投给 CDP；
 * - 地址只记在这台机器的浏览器里（`localStorage["coder.page.v1"]`，按工作区分开）。
 *
 * @param {{
 *   t: (key: string) => string,
 *   subscribeLocale: (fn: () => void) => () => void,
 *   prefs: object,
 *   onDir: (fn: (dir: string) => void) => () => void,
 * }} env
 * @returns {Function}
 */
function createDesignPage(env) {
  const t = env.t

  return function CoderDesignPane() {
    const { token } = antdTheme.useToken()
    const [phase, setPhase] = useState('loading')
    const [workspaces, setWorkspaces] = useState([])
    const [dir, setDir] = useState('')
    const [draft, setDraft] = useState('')
    const [tabs, setTabs] = useState([])
    const [activeId, setActiveId] = useState('')
    const [live, setLive] = useState({
      running: false,
      url: '',
      title: '',
      width: 1280,
      height: 800,
      deviceWidth: 0,
      deviceHeight: 0,
      logicalWidth: 0,
      logicalHeight: 0,
    })
    const [conn, setConn] = useState('idle')
    const [frame, setFrame] = useState(null)
    // off | starting | on | failed
    const [capture, setCapture] = useState('off')
    const [reloadKey, setReloadKey] = useState(0)
    const [notice, setNotice] = useState(null)
    const [box, setBox] = useState({ width: 0, height: 0 })
    const [, setLocaleTick] = useState(0)

    const canvasRef = useRef(null)
    const videoRef = useRef(null)
    const boxRef = useRef(null)
    const typeRef = useRef(null)
    const sourceRef = useRef(null)
    const queueRef = useRef([])
    const flushRef = useRef(null)
    const composingRef = useRef(false)
    const clickRef = useRef({ at: 0, x: 0, y: 0, count: 1 })
    const hoverRef = useRef(0)
    const drawSeqRef = useRef(0)
    const endedRef = useRef(false)
    const retryRef = useRef(null)
    const dirRef = useRef('')
    const viewRef = useRef({ width: 1280, height: 800 })
    const pcRef = useRef(null)
    const pollRef = useRef(null)
    const captureRef = useRef(capture)
    const lastUrlRef = useRef('')
    const startingRef = useRef(false)
    const captureDprRef = useRef(1)
    const cursorRef = useRef(0)
    const sentRef = useRef(null)
    const lastActiveRef = useRef('')
    dirRef.current = dir
    captureRef.current = capture

    useEffect(() => env.subscribeLocale(() => setLocaleTick((value) => value + 1)), [])

    useEffect(() => env.onDir((next) => setDir(next)), [env])

    useEffect(() => {
      let alive = true
      ;(async () => {
        try {
          const data = await request('GET', `${CODER_API}/state`)
          if (!alive) return
          const list = Array.isArray(data.workspaces) ? data.workspaces : []
          setWorkspaces(list)
          setPhase('ready')
          const next = chooseWorkspace(list, env.prefs.dir, data.defaultDir)
          if (next) setDir(next.path)
        } catch (error) {
          if (!alive) return
          setPhase('error')
          setNotice({ kind: 'error', text: error.message })
        }
      })()
      return () => {
        alive = false
      }
    }, [env])

    /**
     * 这个工作区一进来该打开哪个地址：上次浏览的 → 上次载入的设计文档 → 飞书文档主页。
     *
     * @returns {string}
     */
    function preferredUrl() {
      const saved = (env.prefs.design && env.prefs.design[dir]) || ''
      const last = (env.prefs.designLast && env.prefs.designLast[dir]) || ''
      if (last) return last
      return saved || designHomeTargetOf('', '')
    }

    /**
     * @param {string} next
     * @returns {void}
     */
    function rememberLast(next) {
      if (!dir || !/^https?:\/\//i.test(next)) return
      if (!env.prefs.designLast) env.prefs.designLast = {}
      if (env.prefs.designLast[dir] === next) return
      env.prefs.designLast[dir] = next
      writePrefs(env.prefs)
    }

    /**
     * @param {object} state
     * @returns {void}
     */
    function applyState(state) {
      const nextTabs = Array.isArray(state?.tabs) ? state.tabs : []
      const url = String(state?.url ?? '')
      setTabs(nextTabs)
      const nextActive = String(state?.activeId ?? '')
      setActiveId(nextActive)
      if (nextActive && lastActiveRef.current !== nextActive) {
        lastActiveRef.current = nextActive
        setDraft(url)
      }
      setLive({
        running: Boolean(state?.running),
        url,
        title: String(state?.title ?? ''),
        width: Number(state?.width) || 1280,
        height: Number(state?.height) || 800,
        deviceWidth: Number(state?.deviceWidth) || Number(state?.width) || 1280,
        deviceHeight: Number(state?.deviceHeight) || Number(state?.height) || 800,
        logicalWidth: Number(state?.logicalWidth) || Number(state?.width) || 1280,
        logicalHeight: Number(state?.logicalHeight) || Number(state?.height) || 800,
      })
      if (state?.frame?.image) paintFrame({ ...state.frame, seq: Number(state?.seq) || 0 })
      rememberLast(url)
      lastUrlRef.current = url
    }

    useEffect(() => {
      if (!dir) return
      const saved =
        (env.prefs.designDraft && env.prefs.designDraft[dir]) ||
        (env.prefs.design && env.prefs.design[dir]) ||
        ''
      lastActiveRef.current = ''
      setDraft(saved)
    }, [dir])

    // 连上（或复用）这个工作区的浏览器。
    useEffect(() => {
      if (!dir || box.width <= 0 || box.height <= 0) return undefined
      let alive = true
      endedRef.current = false
      setConn('connecting')
      ;(async () => {
        try {
          const state = await request('GET', `${CODER_API}/browser/state?dir=${encodeURIComponent(dir)}`)
          if (!alive) return
          if (state.running && Array.isArray(state.tabs) && state.tabs.length > 0) {
            applyState(state)
            setConn('live')
            return
          }
          const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
const opened = await request('POST', `${CODER_API}/browser/open`, {
            dir,
            url: preferredUrl(),
            width: Math.round(box.width * dpr),
            height: Math.round(box.height * dpr),
            cssWidth: Math.round(box.width),
            cssHeight: Math.round(box.height),
          })
          if (!alive) return
          applyState(opened)
          setConn('live')
        } catch (error) {
          if (!alive) return
          setConn('error')
          setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
        }
      })()
      return () => {
        alive = false
      }
    }, [dir, reloadKey, box.width > 0, box.height > 0])

    // 帧流（回退画面）：一条 SSE，一次连接一直推。
    useEffect(() => {
      if (!dir || conn !== 'live') return undefined
      const source = new EventSource(`${CODER_API}/browser/frames?dir=${encodeURIComponent(dir)}`)
      sourceRef.current = source
      source.onmessage = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.kind === 'state') {
          applyState(message)
          if (message.frame?.image) paintFrame({ ...message.frame, seq: Number(message.seq) || 0 })
          return
        }
        if (message.kind === 'frame') {
          paintFrame(message)
          return
        }
        if (message.kind === 'closed') {
          endedRef.current = true
          setConn('closed')
        }
      }
      source.onerror = () => {
        try {
          source.close()
        } catch {
          // 已经关了
        }
        if (endedRef.current) return
        if (sourceRef.current !== source) return
        sourceRef.current = null
        if (!retryRef.current) {
          retryRef.current = setTimeout(() => {
            retryRef.current = null
            setReloadKey((value) => value + 1)
          }, 1_000)
        }
      }
      return () => {
        try {
          source.close()
        } catch {
          // 已经关了
        }
        if (sourceRef.current === source) sourceRef.current = null
      }
    }, [dir, conn])

    // 面板多大，浏览器视口就多大：帧按这个尺寸出，canvas 1:1 填满面板，没有 letterbox。
    useEffect(() => {
      if (!dir || conn !== 'live' || box.width <= 0 || box.height <= 0) return undefined
      const parent = boxRef.current?.parentElement
      const maxWidth = Math.min(2560, Math.round(parent?.clientWidth || box.width))
      const maxHeight = Math.min(1600, Math.round(parent?.clientHeight || box.height))
      const cssWidth = Math.max(320, Math.min(maxWidth, Math.round(box.width)))
      const cssHeight = Math.max(240, Math.min(maxHeight, Math.round(box.height)))
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
      const width = Math.round(cssWidth * dpr)
      const height = Math.round(cssHeight * dpr)
      // 窗口边框/滚动条会让物理尺寸差几十像素，允许 32px 误差，避免反复重建。
      if (Math.abs(width - live.deviceWidth) <= 32 && Math.abs(height - live.deviceHeight) <= 32) return undefined
      const timer = setTimeout(() => {
        sentRef.current = { width, height, cssWidth, cssHeight }
        request('POST', `${CODER_API}/browser/viewport`, { dir, width, height, cssWidth, cssHeight })
          .then((state) => applyState(state))
          .catch(() => {})
      }, 200)
      return () => clearTimeout(timer)
    }, [dir, conn, box.width, box.height, live.width, live.height])

    // 画面：回退帧直接画到 canvas 上，不走 React state。
    function paintFrame(message) {
      const canvas = canvasRef.current
      if (!canvas || !message?.image) return
      const seq = Number(message.seq) || 0
      if (seq && seq <= drawSeqRef.current) return
      const width = Number(message.width) || viewRef.current.width
      const height = Number(message.height) || viewRef.current.height
      // 检查：太小或者是旧视口的离谱尺寸，直接丢掉，避免画成左上角一小块
      if (!(width > 50) || !(height > 50)) return
      const expectedWidth = Math.round(box.width * (window.devicePixelRatio || 1))
      const expectedHeight = Math.round(box.height * (window.devicePixelRatio || 1))
      const oversized = expectedWidth > 0 && (width > expectedWidth * 1.2 || height > expectedHeight * 1.2)
      if (oversized) {
        // 帧比显示物理像素还大：多半是上一次 viewport 报错了，丢掉并重新同步一次。
        const sent = sentRef.current
        if (sent && dirRef.current) {
          request('POST', `${CODER_API}/browser/viewport`, { dir: dirRef.current, ...sent }).catch(() => {})
        }
        return
      }
      if (expectedWidth > 0 && (width > expectedWidth * 1.2 || width < expectedWidth / 3)) return
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const paint = (source) => {
        if (seq && seq <= drawSeqRef.current) {
          source.close?.()
          return
        }
        drawSeqRef.current = Math.max(drawSeqRef.current, seq)
        const context = canvas.getContext('2d')
        if (context) context.drawImage(source, 0, 0, canvas.width, canvas.height)
        source.close?.()
        setFrame({ width, height, seq })
      }
      try {
        const binary = atob(message.image)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        if (typeof createImageBitmap === 'function') {
          createImageBitmap(blob)
            .then(paint)
            .catch(() => {})
        } else {
          const image = new Image()
          const url = URL.createObjectURL(blob)
          image.onload = () => {
            paint(image)
            URL.revokeObjectURL(url)
          }
          image.src = url
        }
      } catch {
        // 一帧坏了就等下一帧
      }
    }

    /**
     * @returns {void}
     */
    function closePc() {
      if (pollRef.current) {
        clearTimeout(pollRef.current)
        pollRef.current = null
      }
      const pc = pcRef.current
      pcRef.current = null
      if (pc) {
        try {
          pc.close()
        } catch {
          // 已经关了
        }
      }
    }

    /**
     * 让宿主在当前标签页里启动自捕获，然后在这里建 PC、收流。
     *
     * @returns {Promise<void>}
     */
    async function startCapture(options = {}) {
      const silent = Boolean(options.silent)
      if (!dir || startingRef.current) return
      startingRef.current = true
      if (!silent) setCapture('starting')
      try {
        const info = await request('POST', `${CODER_API}/capture/start`, {
          dir,
          width: Math.round(boxRef.current?.clientWidth || 0),
          height: Math.round(boxRef.current?.clientHeight || 0),
        })
        captureDprRef.current = Number(info?.dpr) || captureDprRef.current
        const offer = info?.offer
        if (!offer?.sdp) throw new Error('no offer')
        closePc()
        const pc = new RTCPeerConnection({ iceServers: [] })
        pcRef.current = pc
        pc.ontrack = (event) => {
          const stream = event.streams && event.streams[0]
          const video = videoRef.current
          if (stream && video) {
            video.srcObject = stream
            video.play().catch(() => {})
          }
          setCapture('on')
        }
        pc.onicecandidate = (event) => {
          if (!event.candidate) return
          request('POST', `${CODER_API}/capture/candidate`, {
            dir,
            candidate: event.candidate.toJSON(),
          }).catch(() => {})
        }
        pc.onconnectionstatechange = () => {
          if (pcRef.current !== pc) return
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            setCapture('failed')
          }
        }
        await pc.setRemoteDescription(offer)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await request('POST', `${CODER_API}/capture/answer`, { dir, sdp: answer.sdp, type: answer.type })
        let since = 0
        const poll = async () => {
          if (pcRef.current !== pc) return
          try {
            const data = await request(
              'GET',
              `${CODER_API}/capture/candidates?dir=${encodeURIComponent(dir)}&since=${since}`,
            )
            since = Number(data.next) || since
            for (const candidate of data.list ?? []) {
              await pc.addIceCandidate(candidate).catch(() => {})
            }
          } catch {
            // 下一轮再试
          }
          if (pcRef.current === pc) pollRef.current = setTimeout(poll, 250)
        }
        poll()
      } catch (error) {
        setCapture('failed')
        setNotice({ kind: 'error', text: `${t('designCaptureFailed')}：${error.message}` })
      } finally {
        startingRef.current = false
      }
    }

    /**
     * 标签页切换。
     *
     * @param {string} id
     * @returns {Promise<void>}
     */
    async function switchTab(id) {
      if (!dir || !id || id === activeId) return
      try {
        closePc()
        setCapture('starting')
        const state = await request('POST', `${CODER_API}/browser/tabs/activate`, { dir, id })
        applyState(state)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async function newTab() {
      if (!dir) return
      try {
        closePc()
        setCapture('starting')
        const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
const state = await request('POST', `${CODER_API}/browser/tabs/new`, {
            dir,
            url: designHomeTargetOf('', ''),
            width: Math.round(box.width * dpr),
            height: Math.round(box.height * dpr),
            cssWidth: Math.round(box.width),
            cssHeight: Math.round(box.height),
          })
        applyState(state)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
      }
    }

    /**
     * @param {string} id
     * @param {object} event
     * @returns {Promise<void>}
     */
    async function closeTab(id, event) {
      if (event) event.stopPropagation()
      if (!dir) return
      try {
        closePc()
        setCapture('starting')
        const state = await request('POST', `${CODER_API}/browser/tabs/close`, { dir, id })
        applyState(state)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async function load() {
      if (!dir) return
      const next = designUrlOf(draft)
      if (next === null) {
        setNotice({ kind: 'error', text: t('designInvalid') })
        return
      }
      if (!env.prefs.design) env.prefs.design = {}
      if (next) env.prefs.design[dir] = next
      else delete env.prefs.design[dir]
      if (!env.prefs.designDraft) env.prefs.designDraft = {}
      delete env.prefs.designDraft[dir]
      writePrefs(env.prefs)
      setDraft(next)
      if (!next) {
        setNotice({ kind: 'success', text: t('designCleared') })
        return
      }
      try {
        closePc()
        setCapture('starting')
        const state = await request('POST', `${CODER_API}/browser/navigate`, { dir, url: next })
        applyState(state)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async function showHome() {
      if (!dir) return
      try {
        closePc()
        setCapture('starting')
        const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
        const state = await request('POST', `${CODER_API}/browser/tabs/new`, {
          dir,
          url: designHomeTargetOf(draft, ''),
          width: Math.round(box.width * dpr),
          height: Math.round(box.height * dpr),
          cssWidth: Math.round(box.width),
          cssHeight: Math.round(box.height),
        })
        applyState(state)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async function backToDoc() {
      const saved = (env.prefs.design && env.prefs.design[dir]) || ''
      if (!dir || !saved) return
      try {
        closePc()
        setCapture('starting')
        const state = await request('POST', `${CODER_API}/browser/navigate`, { dir, url: saved })
        applyState(state)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
      }
    }

    /**
     * @returns {Promise<void>}
     */
    async function reload() {
      if (!dir) return
      try {
        closePc()
        setCapture('starting')
        const state = await request('POST', `${CODER_API}/browser/reload`, { dir })
        applyState(state)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('designFailed')}：${error.message}` })
      }
    }

    /**
     * @returns {void}
     */
    function openExternal() {
      const target = live.url || designUrlOf(draft) || ''
      if (!target) return
      window.open(target, '_blank', 'noopener,noreferrer')
    }

    /**
     * @returns {void}
     */
    function rememberDraft() {
      if (!dir) return
      if (!env.prefs.designDraft) env.prefs.designDraft = {}
      const text = String(draft || '').trim()
      const saved = (env.prefs.design && env.prefs.design[dir]) || ''
      if (text && text !== saved) env.prefs.designDraft[dir] = draft
      else delete env.prefs.designDraft[dir]
      writePrefs(env.prefs)
    }

    // 容器尺寸：画面按比例缩放。
    useEffect(() => {
      const element = boxRef.current
      if (!element) return undefined
      const update = () => setBox({ width: element.clientWidth, height: element.clientHeight })
      update()
      if (typeof ResizeObserver !== 'function') return undefined
      const observer = new ResizeObserver(update)
      observer.observe(element)
      return () => observer.disconnect()
    }, [dir, phase])

    // 调试：把关键尺寸报给宿主（/browser/state 里能看到 client）。
    useEffect(() => {
      if (!dir) return undefined
      const timer = setInterval(() => {
        const canvas = canvasRef.current
        request('POST', `${CODER_API}/browser/client`, {
          dir,
          box: [Math.round(box.width), Math.round(box.height)],
          dpr: window.devicePixelRatio || 1,
          live: [Math.round(live.width), Math.round(live.height)],
          display: [Math.round(display.width), Math.round(display.height)],
          canvas: canvas ? [canvas.width, canvas.height] : null,
          frame: frame ? [frame.width, frame.height] : null,
          sent: sentRef.current,
          viewport: [window.innerWidth, window.innerHeight],
        }).catch(() => {})
      }, 1000)
      return () => clearInterval(timer)
    }, [dir, box.width, box.height, live.width, live.height, frame])

    // 重新回到页面时，state/帧可能已经过期：重连一次，强制重新拿 state。
    useEffect(() => {
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return
        const element = boxRef.current
        if (!element) return
        setBox({ width: element.clientWidth, height: element.clientHeight })
        setReloadKey((value) => value + 1)
      }
      window.addEventListener('focus', onVisible)
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        window.removeEventListener('focus', onVisible)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }, [])

    useEffect(
      () => () => {
        if (flushRef.current) clearTimeout(flushRef.current)
        if (retryRef.current) clearTimeout(retryRef.current)
        closePc()
        if (dirRef.current) {
          // 捕获已弃用
        }
      },
      [],
    )

    const captureOn = capture === 'on'
    const viewWidth = live.width || 1280
    const viewHeight = live.height || 800
    const scale = box.width > 0 && box.height > 0 ? Math.min(box.width / viewWidth, box.height / viewHeight) : 0
    const display = {
      width: scale > 0 ? Math.max(1, Math.floor(viewWidth * scale)) : 0,
      height: scale > 0 ? Math.max(1, Math.floor(viewHeight * scale)) : 0,
    }
    viewRef.current = { width: viewWidth, height: viewHeight }

    /**
     * 远程页面的光标形状：只认标准关键字，避免把 url(...) 之类塞进本地样式。
     *
     * @param {string} value
     * @returns {string}
     */
    function normalizeCursor(value) {
      const cursor = String(value || '').trim()
      const allowed = new Set([
        'auto',
        'default',
        'none',
        'context-menu',
        'help',
        'pointer',
        'progress',
        'wait',
        'cell',
        'crosshair',
        'text',
        'vertical-text',
        'alias',
        'copy',
        'move',
        'no-drop',
        'not-allowed',
        'grab',
        'grabbing',
        'e-resize',
        'n-resize',
        'ne-resize',
        'nw-resize',
        's-resize',
        'se-resize',
        'sw-resize',
        'w-resize',
        'ew-resize',
        'ns-resize',
        'nesw-resize',
        'nwse-resize',
        'col-resize',
        'row-resize',
        'all-scroll',
        'zoom-in',
        'zoom-out',
      ])
      return allowed.has(cursor) ? cursor : 'default'
    }

    /**
     * 把远程光标形状贴到本地画面（textarea 在最上层，两个都设）。
     *
     * @param {string} value
     * @returns {void}
     */
    function applyCursor(value) {
      const cursor = normalizeCursor(value)
      if (typeRef.current) typeRef.current.style.cursor = cursor
      if (canvasRef.current) canvasRef.current.style.cursor = cursor
    }

    /**
     * 画面上的一点 → 浏览器视图坐标（考虑视频的 letterbox）。
     *
     * @param {{ clientX: number, clientY: number }} event
     * @returns {{ x: number, y: number } | null}
     */
    function pointOf(event) {
      let rect = null
      let vw = viewWidth
      let vh = viewHeight
      if (captureOn && videoRef.current) {
        const box = videoRef.current.getBoundingClientRect()
        if (!box.width || !box.height) return null
        const fit = Math.min(box.width / vw, box.height / vh)
        const width = vw * fit
        const height = vh * fit
        rect = { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height }
      } else if (canvasRef.current) {
        rect = canvasRef.current.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
      } else {
        return null
      }
      // 点在画面外的留白上：不算页面里的点击（否则会被夹到页面边缘）。
      if (
        event.clientX < rect.left ||
        event.clientX > rect.left + rect.width ||
        event.clientY < rect.top ||
        event.clientY > rect.top + rect.height
      ) {
        return null
      }
      return pointInViewport(rect, { width: vw, height: vh }, event.clientX, event.clientY)
    }

    /**
     * @param {Array<object>} events
     * @returns {void}
     */
    function send(events) {
      if (!events || events.length === 0) return
      queueRef.current.push(...events)
      if (flushRef.current) return
      flushRef.current = setTimeout(() => {
        flushRef.current = null
        const batch = queueRef.current
        queueRef.current = []
        if (batch.length === 0 || !dirRef.current) return
        request('POST', `${CODER_API}/browser/input`, { dir: dirRef.current, events: batch }).catch(() => {})
      }, 12)
    }

    /**
     * @param {object} event
     * @returns {void}
     */
    function onPointerDown(event) {
      const point = pointOf(event)
      if (!point) return
      try {
        typeRef.current?.focus({ preventScroll: true })
      } catch {
        // 聚焦不了不影响点击
      }
      const now = Date.now()
      const last = clickRef.current
      const near = now - last.at < 400 && Math.abs(point.x - last.x) < 6 && Math.abs(point.y - last.y) < 6
      const clickCount = near ? 2 : 1
      clickRef.current = { at: now, x: point.x, y: point.y, count: clickCount }
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // 指针捕获失败不影响点击
        }
      }
      send([{ type: 'mouse', action: 'down', x: point.x, y: point.y, button: 'left', clickCount }])
    }

    /**
     * @param {object} event
     * @returns {void}
     */
    function onPointerMove(event) {
      const point = pointOf(event)
      if (!point) return
      const held = event.buttons ? 1 : 0
      const now = Date.now()
      if (!held && now - hoverRef.current < 60) return
      hoverRef.current = now
      send([{ type: 'mouse', action: 'move', x: point.x, y: point.y, buttons: held, button: 'left' }])
      if (!dirRef.current || now - cursorRef.current < 120) return
      cursorRef.current = now
      request('POST', `${CODER_API}/browser/cursor`, {
        dir: dirRef.current,
        x: point.x,
        y: point.y,
      })
        .then((data) => applyCursor(data.cursor))
        .catch(() => {})
    }

    /**
     * @param {object} event
     * @returns {void}
     */
    function onPointerUp(event) {
      const point = pointOf(event)
      if (!point) return
      send([{ type: 'mouse', action: 'up', x: point.x, y: point.y, button: 'left', clickCount: clickRef.current.count }])
    }

    useEffect(() => {
      if (!dir || conn !== 'live') return undefined
      const element = boxRef.current
      if (!element) return undefined
      const handler = (event) => {
        event.preventDefault()
        const point = pointOf(event)
        if (!point) return
        const size = viewRef.current
        const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1
        send([{ type: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX * factor, deltaY: event.deltaY * factor }])
      }
      element.addEventListener('wheel', handler, { passive: false })
      return () => element.removeEventListener('wheel', handler)
    }, [dir, conn, captureOn])

    /**
     * @param {object} event
     * @returns {void}
     */
    function onContextMenu(event) {
      event.preventDefault()
      const point = pointOf(event)
      if (!point) return
      send([{ type: 'mouse', action: 'click', x: point.x, y: point.y, button: 'right', clickCount: 1 }])
    }

    /**
     * @param {object} event
     * @returns {void}
     */
    function onKeyDown(event) {
      if (event.isComposing || composingRef.current) return
      const single = event.key.length === 1
      const printable = single && !event.ctrlKey && !event.metaKey && !event.altKey
      if (printable) return
      const special = KEY_KEYS.has(event.key)
      if (!special && !event.ctrlKey && !event.metaKey && !event.altKey) return
      event.preventDefault()
      send([
        {
          type: 'key',
          key: event.key,
          modifiers: { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey },
        },
      ])
    }

    /**
     * @param {object} event
     * @returns {void}
     */
    function onInput(event) {
      const value = event.target.value
      event.target.value = ''
      if (!value || composingRef.current) return
      send([{ type: 'text', text: value }])
    }

    /**
     * @param {object} event
     * @returns {void}
     */
    function onCompositionEnd(event) {
      composingRef.current = false
      if (event.data) send([{ type: 'text', text: event.data }])
      if (typeRef.current) typeRef.current.value = ''
    }

    /**
     * @param {object} event
     * @returns {void}
     */
    function onPaste(event) {
      const text = event.clipboardData?.getData('text') ?? ''
      if (!text) return
      event.preventDefault()
      send([{ type: 'text', text }])
    }

    const busy = phase === 'loading'
    const noWorkspace = phase === 'ready' && workspaces.length === 0
    const connected = conn === 'live'
    const hasMedia = (captureOn || Boolean(frame)) && box.width > 0 && display.width >= 50

    return (
      <div
        style={{
          height: '100%',
          width: '100%',
          maxWidth: '100%',
          minHeight: 0,
          minWidth: 0,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgLayout,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 18px 0',
            overflowX: 'auto',
            flex: '0 0 auto',
          }}
        >
          {tabs.map((tab) => {
            const active = tab.active || tab.id === activeId
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                onClick={() => switchTab(tab.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  maxWidth: 220,
                  padding: '2px 4px 2px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: active ? token.colorBgContainer : token.colorFillQuaternary,
                  border: `1px solid ${active ? token.colorBorder : 'transparent'}`,
                  flex: '0 0 auto',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {tab.title || tab.url || t('designNewTab')}
                </span>
                <Button
                  size="small"
                  type="text"
                  aria-label={t('designCloseTab')}
                  icon={<CloseOutlined style={{ fontSize: 11 }} />}
                  onClick={(event) => closeTab(tab.id, event)}
                />
              </div>
            )
          })}
          <Button size="small" type="text" icon={<PlusOutlined />} aria-label={t('designNewTab')} onClick={newTab} />
        </div>

        <Flex vertical gap={6} style={{ padding: '6px 18px 8px' }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              size="small"
              style={{ width: '100%' }}
              value={draft}
              spellCheck={false}
              allowClear
              placeholder={t('designPlaceholder')}
              aria-label={t('tabDesign')}
              disabled={!dir || busy}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={rememberDraft}
              onPressEnter={load}
            />
            <Button size="small" type="primary" disabled={!dir || busy} onClick={load}>
              {t('designLoad')}
            </Button>
            <Button size="small" icon={<HomeOutlined />} aria-label={t('designHome')} disabled={!dir} onClick={showHome} />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              aria-label={t('reload')}
              disabled={!connected}
              onClick={reload}
            />
            <Button
              size="small"
              icon={<ExportOutlined />}
              aria-label={t('designOpen')}
              disabled={!live.url}
              onClick={openExternal}
            />
          </Space.Compact>
          {notice ? (
            <Alert
              type={notice.kind === 'success' ? 'success' : notice.kind === 'info' ? 'info' : 'error'}
              showIcon
              closable
              onClose={() => setNotice(null)}
              title={notice.text}
            />
          ) : null}
        </Flex>

        <div style={{ flex: 1, minHeight: 0, padding: '0 18px 14px', display: 'flex' }}>
          {noWorkspace ? (
            <Card
              size="small"
              style={{ flex: 1, minHeight: 0, display: 'flex' }}
              styles={{ body: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' } }}
            >
              <Empty description={t('noWorkspace')} />
            </Card>
          ) : (
            <div
              ref={boxRef}
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                borderRadius: 10,
                background: token.colorFillQuaternary,
              }}
            >
              <video
                ref={videoRef}
                muted
                autoPlay
                playsInline
                style={{
                  display: captureOn ? 'block' : 'none',
                  width: display.width || 0,
                  height: display.height || 0,
                  objectFit: 'fill',
                  background: '#000',
                  borderRadius: 8,
                  boxShadow: '0 1px 6px rgba(0, 0, 0, 0.18)',
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={onContextMenu}
              />
              <canvas
                ref={canvasRef}
                aria-label={t('tabDesign')}
                style={{
                  display: captureOn ? 'none' : 'block',
                  width: display.width || '100%',
                  height: display.height || '100%',
                  background: token.colorBgContainer,
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={onContextMenu}
              />
              <textarea
                ref={typeRef}
                aria-label={t('designType')}
                autoComplete="off"
                spellCheck={false}
                style={{
                  position: 'absolute',
                  inset: 0,
                  opacity: 0,
                  resize: 'none',
                  border: 'none',
                  padding: 0,
                  margin: 0,
                  pointerEvents: 'auto',
                  cursor: 'default',
                }}
                onKeyDown={onKeyDown}
                onInput={onInput}
                onPaste={onPaste}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onContextMenu={onContextMenu}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={onCompositionEnd}
              />
              {!hasMedia && !endedRef.current ? (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    background: token.colorBgContainer,
                    opacity: 0.94,
                  }}
                >
                  {conn === 'error' ? (
                    <>
                      <Typography.Text type="danger" style={{ fontSize: 13 }}>
                        {t('designFailed')}
                      </Typography.Text>
                      <Button size="small" onClick={() => setReloadKey((value) => value + 1)}>
                        {t('designReconnect')}
                      </Button>
                    </>
                  ) : (
                    capture === 'failed' ? (
                      <>
                        <Typography.Text type="danger" style={{ fontSize: 13 }}>
                          {t('designCaptureFailed')}
                        </Typography.Text>
                        <Button size="small" hidden onClick={() => {}}>
                          {t('designReconnect')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Spin />
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {connected ? t('designOpening') : t('designConnecting')}
                        </Typography.Text>
                      </>
                    )
                  )}
                </div>
              ) : null}
              {endedRef.current ? (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    background: token.colorBgContainer,
                    opacity: 0.94,
                  }}
                >
                  <Typography.Text type="danger" style={{ fontSize: 13 }}>
                    {t('designDisconnected')}
                  </Typography.Text>
                  <Button size="small" onClick={() => setReloadKey((value) => value + 1)}>
                    {t('designReconnect')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    )
  }
}

/**
 * 一页：工作区 → codes.jsonl → 左边列表 / 右边表单 → 保存。
 *
 * @param {{ t: (key: string) => string, subscribeLocale: (fn: () => void) => () => void }} env
 * @returns {Function}
 */
function createPage(env) {
  const t = env.t

  return function CoderCodesPage() {
    const { token } = antdTheme.useToken()
    const [phase, setPhase] = useState('loading')
    const [workspaces, setWorkspaces] = useState([])
    const [dir, setDir] = useState('')
    const [files, setFiles] = useState([])
    const [activeRel, setActiveRel] = useState('')
    const [rows, setRows] = useState(null)
    const [original, setOriginal] = useState('')
    const [selected, setSelected] = useState(0)
    const [notice, setNotice] = useState(null)
    const [saving, setSaving] = useState(false)
    const [collecting, setCollecting] = useState(false)
    const [debugging, setDebugging] = useState(false)
    const [restored, setRestored] = useState(false)
    const [, setLocaleTick] = useState(0)
    const activeRef = useRef('')
    const dirRef = useRef('')
    const importRef = useRef(null)
    const jobSourceRef = useRef(null)
    // 每一帧都把「现在的编辑状态」放进 ref：离开页面时用它存草稿。
    const live = useRef({ rows: null, original: '', selected: 0 })
    live.current = { rows, original, selected }

    useEffect(() => env.subscribeLocale(() => setLocaleTick((value) => value + 1)), [])

    /**
     * 把当前这份未保存的改动存进 entry 级草稿（内容没变就清掉）。
     *
     * @param {string} [key] 目标 key，默认是「当前工作区 + 当前文件」
     * @returns {void}
     */
    const persistDraft = useCallback(
      (key) => {
        const target = key || draftKeyOf(dirRef.current, activeRef.current)
        if (!target) return
        const { rows: current, original: base, selected: at } = live.current
        if (!Array.isArray(current) || serializeCodes(current) === base) {
          env.drafts.delete(target)
          return
        }
        env.drafts.set(target, {
          rows: current.map((row) => ({ ...row })),
          original: base,
          selected: at,
        })
      },
      [env],
    )

    // 离开这个页面（切到对话、切到别的面板）时留下草稿；entry 还在，回来就能接着改。
    useEffect(() => () => persistDraft(), [persistDraft])

    // 在别的 Tab 换了工作区：先把手上的改动留成草稿，再跟过去。
    useEffect(
      () =>
        env.onDir((next) => {
          persistDraft()
          setDir(next)
          setNotice(null)
        }),
      [env, persistDraft],
    )

      const pick = useCallback(
      (file) => {
        activeRef.current = file ? file.rel : ''
        setActiveRel(activeRef.current)
        // 记住这个工作区上次看的是哪份文件，下次进来直接回到它。
        if (file && dirRef.current) {
          env.prefs.files[dirRef.current] = file.rel
          writePrefs(env.prefs)
        }
        const key = file ? draftKeyOf(dirRef.current, file.rel) : ''
        const draft = key ? env.drafts.get(key) : null
        if (file && draft) {
          setRows(draft.rows.map((row) => ({ ...row })))
          setOriginal(draft.original)
          setSelected(Math.max(0, Math.min(draft.selected || 0, draft.rows.length - 1)))
          setRestored(true)
          return
        }
        setRows(file ? file.rows.map((row) => ({ ...row })) : null)
        setOriginal(file ? serializeCodes(file.rows) : '')
        setSelected(0)
        setRestored(false)
      },
      [env],
    )

    const loadCodes = useCallback(
      async (targetDir, preferRel, options = {}) => {
        setNotice(null)
        dirRef.current = targetDir
        try {
          const data = await request('GET', `${CODER_API}/codes?dir=${encodeURIComponent(targetDir)}`)
          const list = Array.isArray(data.files) ? data.files : []
          setFiles(list)
          const chosen = chooseFile(
            list,
            preferRel,
            env.prefs.files[targetDir],
            activeRef.current,
          )
          // 「重新载入」= 从磁盘重读：丢掉这份文件的草稿，不拿它覆盖磁盘内容。
          if (options.dropDraft && chosen) env.drafts.delete(draftKeyOf(targetDir, chosen.rel))
          pick(chosen)
          setPhase('ready')
        } catch (error) {
          setFiles([])
          pick(null)
          setPhase('error')
          setNotice({ kind: 'error', text: error.message })
        }
      },
      [env, pick],
    )

    useEffect(() => {
      let alive = true
      ;(async () => {
        try {
          const data = await request('GET', `${CODER_API}/state`)
          if (!alive) return
          const list = Array.isArray(data.workspaces) ? data.workspaces : []
          setWorkspaces(list)
          if (list.length === 0) {
            setPhase('ready')
            return
          }
          // 上次选的工作区还在就用它，否则回到默认工作区、再否则第一份。
          const next = chooseWorkspace(list, env.prefs.dir, data.defaultDir)
          if (next) setDir(next.path)
        } catch (error) {
          if (!alive) return
          setPhase('error')
          setNotice({ kind: 'error', text: error.message })
        }
      })()
      return () => {
        alive = false
      }
    }, [env])

    useEffect(() => {
      if (dir) loadCodes(dir)
    }, [dir, loadCodes])

    const problems = useMemo(() => (Array.isArray(rows) ? validateRows(rows) : []), [rows])
    const dirty = useMemo(
      () => (Array.isArray(rows) ? serializeCodes(rows) !== original : false),
      [rows, original],
    )
    const counts = useMemo(
      () =>
        Array.isArray(rows)
          ? countsOf(rows)
          : { total: 0, debug: 0, quality: 0, static: 0, runtime: 0, disabled: 0 },
      [rows],
    )
    const issuesByRow = useMemo(() => {
      const map = new Map()
      for (const problem of problems) {
        if (!Number.isInteger(problem.index) || problem.index < 0) continue
        const list = map.get(problem.index) || []
        list.push(problem.message)
        map.set(problem.index, list)
      }
      return map
    }, [problems])

    const current = Array.isArray(rows) && rows[selected] ? rows[selected] : null
    const currentIssues = issuesByRow.get(selected) || []

    function patch(index, changes) {
      setRows((list) =>
        Array.isArray(list) ? list.map((row, at) => (at === index ? { ...row, ...changes } : row)) : list,
      )
    }

    function patchCode(index, code) {
      const kind = kindOfCode(code)
      patch(index, kind ? { code, kind } : { code })
    }

    function addRow() {
      setRows((list) => {
        if (!Array.isArray(list)) return list
        const last = list[list.length - 1]
        const kind = last && last.kind === 'quality' ? 'quality' : 'debug'
        const next = [...list, normalizeRow({ code: nextCode(list, kind), kind, severity: 'warning' })]
        setSelected(next.length - 1)
        return next
      })
    }

    function removeRow(index) {
      setRows((list) => {
        if (!Array.isArray(list)) return list
        const next = list.filter((_, at) => at !== index)
        setSelected((at) => Math.max(0, Math.min(at, next.length - 1)))
        return next
      })
    }

    function moveRow(index, delta) {
      setRows((list) => {
        if (!Array.isArray(list)) return list
        const to = index + delta
        if (to < 0 || to >= list.length) return list
        const next = list.slice()
        const [row] = next.splice(index, 1)
        next.splice(to, 0, row)
        setSelected(to)
        return next
      })
    }

    /**
     * 批量启用/禁用当前文件的全部码（只改 `enabled`，不动别的字段）。
     *
     * @param {boolean} value
     * @returns {void}
     */
    function setAllEnabled(value) {
      setRows((list) => withAllEnabled(list, value))
    }

    /**
     * 移除全部未启用的码：整条删掉（和「全部禁用」不一样，那个只关开关），
     * 只改内存，点「保存」才落盘。
     *
     * @returns {void}
     */
    function removeDisabled() {
      if (!Array.isArray(rows)) return
      const next = withoutDisabled(rows)
      const removed = rows.length - next.length
      if (removed === 0) return
      setRows(next)
      setSelected((at) => Math.min(at, Math.max(0, next.length - 1)))
      setNotice({ kind: 'success', text: t('removedDisabled').replace('{count}', String(removed)) })
    }

    async function save() {
      if (!Array.isArray(rows) || saving) return
      setSaving(true)
      setNotice(null)
      try {
        const data = await request('PUT', `${CODER_API}/codes`, { dir, rel: activeRef.current, rows })
        const nextRows = (Array.isArray(data.rows) ? data.rows : rows).map((row) => ({ ...row }))
        setRows(nextRows)
        setOriginal(serializeCodes(nextRows))
        setFiles((list) =>
          list.map((file) =>
            file.rel === activeRef.current
              ? { ...file, rows: nextRows, counts: data.counts, problems: [], status: 'ok' }
              : file,
          ),
        )
        // 落盘了就不再有草稿。
        env.drafts.delete(draftKeyOf(dir, activeRef.current))
        setRestored(false)
        setNotice({ kind: 'success', text: t('saved') })
      } catch (error) {
        setNotice({ kind: 'error', text: error.message })
      } finally {
        setSaving(false)
      }
    }

    function discard() {
      env.drafts.delete(draftKeyOf(dir, activeRef.current))
      pick(files.find((file) => file.rel === activeRef.current) || null)
      setNotice(null)
    }

    /**
     * 「让 DSH 搜集」：接口在目标工作区里跑一个对话，**把结果当成返回值交回来**；
     * 这里只把它填进 targets 输入框 —— 变成未保存的改动，保不保存由人决定。
     *
     * @param {object} row
     * @returns {Promise<void>}
     */
    async function collect(row) {
      if (collecting || !row?.code || !activeRel) return
      setCollecting(true)
      setNotice(null)
      try {
        const data = await request('POST', `${CODER_API}/collect`, {
          dir,
          rel: activeRel,
          code: row.code,
        })
        const jobId = String(data?.jobId ?? '')
        if (!jobId) throw new Error(t('collectEmpty'))
        // 记下来：就算这个页面被关掉，回来还能凭 jobId 把结果取回。
        writeJob({ id: jobId, dir, rel: activeRel, code: row.code })
        setNotice({ kind: 'info', text: t('collectRunning') })
        watchJob(jobId, row.code)
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('collectFailed')}：${error.message}` })
      } finally {
        setCollecting(false)
      }
    }

    /**
     * 「发起诊断」：在目标工作区里开一个对话，让它跑一次 coder_debug。
     *
     * 接口只负责开会话、投递任务，然后立刻返回 —— 诊断要跑几分钟，页面不等它；
     * 那个对话出现在左侧栏的**目标工作区**下面。
     *
     * @returns {Promise<void>}
     */
    async function runDebug() {
      if (debugging || !dir) return
      setDebugging(true)
      setNotice(null)
      try {
        const data = await request('POST', `${CODER_API}/debug`, { dir })
        const sessionId = String(data?.sessionId ?? '')
        const title = workspaces.find((item) => item.path === dir)?.title || dir
        setNotice({
          kind: 'success',
          text: t('debugStarted')
            .replace('{workspace}', title)
            .replace('{id}', shortSessionOf(sessionId)),
        })
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('debugFailed')}：${error.message}` })
      } finally {
        setDebugging(false)
      }
    }

    /**
     * 把一次搜集的结果填回编辑器：只改 targets，变成未保存的改动 —— 保不保存由人决定。
     *
     * @param {string} code
     * @param {string[]} targets
     * @returns {void}
     */
    function applyTargets(code, targets) {
      const list = Array.isArray(live.current.rows) ? live.current.rows : []
      const at = list.findIndex((item) => item.code === code)
      patch(at >= 0 ? at : live.current.selected, { targets })
      setNotice({ kind: 'success', text: t('collectDone').replace('{count}', String(targets.length)) })
    }

    /**
     * 订阅一条任务：先推当前状态，结束再推一次 —— 不轮询。
     *
     * @param {string} jobId
     * @param {string} code
     * @returns {void}
     */
    function watchJob(jobId, code) {
      closeJobSource()
      if (typeof EventSource === 'undefined') {
        // 没有 SSE 就退一步：查一次（这不是轮询，只在没有推送能力时用）。
        request('GET', `${CODER_API}/jobs/${encodeURIComponent(jobId)}`)
          .then((data) => settleJob(data?.job, code))
          .catch((error) => setNotice({ kind: 'error', text: `${t('collectFailed')}：${error.message}` }))
        return
      }
      const source = new EventSource(`${CODER_API}/jobs/${encodeURIComponent(jobId)}/events`)
      jobSourceRef.current = source
      source.onmessage = (event) => {
        let job
        try {
          job = JSON.parse(event.data)
        } catch {
          return
        }
        settleJob(job, code)
      }
      source.onerror = () => {
        closeJobSource()
        setNotice({ kind: 'error', text: t('collectLost') })
      }
    }

    /**
     * 任务有结果了：填进去、关闭推送、清掉本地记录。
     *
     * @param {object | undefined} job
     * @param {string} code
     * @returns {void}
     */
    function settleJob(job, code) {
      if (!job || job.status === 'running') return
      closeJobSource()
      writeJob(null)
      if (job.status === 'done') {
        const targets = targetsOf(job.targets)
        if (targets.length === 0) {
          setNotice({ kind: 'error', text: `${t('collectFailed')}：${t('collectEmpty')}` })
          return
        }
        applyTargets(job.code || code, targets)
        return
      }
      setNotice({ kind: 'error', text: `${t('collectFailed')}：${job.error || t('collectEmpty')}` })
    }

    /** 关掉当前的推送连接（如果有）。 */
    function closeJobSource() {
      const source = jobSourceRef.current
      jobSourceRef.current = null
      if (source) {
        try {
          source.close()
        } catch {
          // 已经关了
        }
      }
    }

    // 回到这个页面、或者刷新之后：上次那条任务还在的话，把结果取回来。
    useEffect(() => {
      if (!dir || !activeRel) return
      const pending = readJob()
      if (!pending || pending.dir !== dir || pending.rel !== activeRel) return
      let alive = true
      request('GET', `${CODER_API}/jobs/${encodeURIComponent(pending.id)}`)
        .then((data) => {
          if (!alive) return
          const job = data?.job
          if (!job) {
            writeJob(null)
            return
          }
          if (job.status === 'running') {
            setNotice({ kind: 'info', text: t('collectRunning') })
            watchJob(pending.id, pending.code)
            return
          }
          settleJob(job, pending.code)
        })
        .catch(() => {
          if (!alive) return
          writeJob(null)
          setNotice({ kind: 'info', text: t('collectExpired') })
        })
      return () => {
        alive = false
      }
    }, [dir, activeRel])

    // 离开页面时断开推送（任务本身留在服务端，回来还能取）。
    useEffect(() => () => closeJobSource(), [])

    /** 清空这份文件的全部码（要点保存才落盘）。 */
    function clearAll() {
      setRows([])
      setSelected(0)
      setNotice(null)
    }

    /**
     * 导入一个文件：JSONL、JSON 数组、或 `{ codes: [...] }` 都认，文件类型不限。
     *
     * 导入是「整份替换」：读进来的行成为当前内容，保存后才写回磁盘。
     *
     * @param {object} event
     * @returns {Promise<void>}
     */
    async function importFile(event) {
      const picked = event?.target?.files?.[0]
      if (event?.target) event.target.value = ''
      if (!picked) return
      setNotice(null)
      try {
        const text = await picked.text()
        const parsed = parseImported(text, picked.name)
        if (parsed.rows.length === 0) {
          const reason = parsed.problems[0]?.message ?? t('importEmpty')
          setNotice({ kind: 'error', text: `${t('importFailed')}：${reason}` })
          return
        }
        const before = Array.isArray(rows) ? rows.length : 0
        setRows(parsed.rows)
        setSelected(0)
        const template = parsed.shape === 'text' ? t('importedText') : t('imported')
        setNotice({
          kind: 'success',
          text: template
            .replace('{count}', String(parsed.rows.length))
            .replace('{before}', String(before)),
        })
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('importFailed')}：${error.message}` })
      }
    }

    const busy = phase === 'loading'
    const noWorkspace = phase === 'ready' && workspaces.length === 0
    const emptyFile = !busy && Array.isArray(rows) && rows.length === 0

    return (
      <div
        style={{
          height: '100%',
          width: '100%',
          maxWidth: '100%',
          minHeight: 0,
          minWidth: 0,
          overflowX: 'hidden',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgLayout,
        }}
      >
        <Flex vertical gap={10} style={{ padding: '12px 22px 10px' }}>
          <Space size={10} wrap>
            {files.length > 1 ? (
              <Space size={6}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('file')}
                </Typography.Text>
                <Select
                  size="small"
                  style={{ width: 200 }}
                  value={activeRel || undefined}
                  onChange={(value) => {
                    const file = files.find((item) => item.rel === value)
                    // 换文件前把当前文件的改动留成草稿，切回来还能接着改。
                    if (file) persistDraft()
                    if (file) pick(file)
                    setNotice(null)
                  }}
                  options={files.map((item) => ({
                    value: item.rel,
                    label: `${item.rel}（${(item.counts && item.counts.total) || 0}）`,
                  }))}
                />
              </Space>
            ) : null}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => loadCodes(dir, undefined, { dropDraft: true })}
              disabled={!dir || busy}
            >
              {t('reload')}
            </Button>
            <Button
              size="small"
              onClick={() => setAllEnabled(true)}
              disabled={!Array.isArray(rows) || rows.length === 0 || counts.disabled === 0}
            >
              {t('enableAll')}
            </Button>
            <Button
              size="small"
              onClick={() => setAllEnabled(false)}
              disabled={!Array.isArray(rows) || rows.length === 0 || counts.disabled === counts.total}
            >
              {t('disableAll')}
            </Button>
            <Popconfirm
              title={t('removeDisabledConfirm').replace('{count}', String(counts.disabled))}
              okButtonProps={{ danger: true }}
              onConfirm={removeDisabled}
            >
              <Button
                size="small"
                danger
                disabled={!Array.isArray(rows) || counts.disabled === 0}
              >
                {t('removeDisabled')}
              </Button>
            </Popconfirm>
            <Popconfirm
              title={t('clearAllConfirm')}
              okButtonProps={{ danger: true }}
              onConfirm={clearAll}
            >
              <Button
                size="small"
                danger
                disabled={!Array.isArray(rows) || rows.length === 0}
              >
                {t('clearAll')}
              </Button>
            </Popconfirm>
            <Button size="small" onClick={() => importRef.current?.click()}>
              {t('importFile')}
            </Button>
            {/* 不设 accept：导入的文件默认是「任意文件」，认不出内容时给提示。 */}
            <input
              ref={importRef}
              type="file"
              style={{ display: 'none' }}
              onChange={importFile}
            />
            <Button
              size="small"
              icon={<ExperimentOutlined />}
              loading={debugging}
              disabled={!dir}
              onClick={runDebug}
            >
              {t('runDebug')}
            </Button>
          </Space>
        </Flex>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '0 22px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {restored && dirty ? (
            <Alert
              type="info"
              showIcon
              closable
              onClose={() => setRestored(false)}
              title={t('draftRestored')}
            />
          ) : null}

          {notice ? (
            <Alert
              type={notice.kind === 'success' ? 'success' : notice.kind === 'info' ? 'info' : 'error'}
              showIcon
              closable
              onClose={() => setNotice(null)}
              title={notice.text}
            />
          ) : null}

          {problems.length > 0 ? (
            <Alert
              type="error"
              showIcon
              title={`${problems.length} ${t('issues')}`}
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {problems.slice(0, 3).map((problem, index) => (
                    <li key={index}>{problem.message}</li>
                  ))}
                </ul>
              }
            />
          ) : null}

          {noWorkspace ? (
            <Card size="small">
              <Empty description={t('noWorkspace')} />
          </Card>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 320,
              minWidth: 0,
              display: 'grid',
              gridTemplateColumns: 'minmax(260px, 320px) minmax(0, 1fr)',
              gap: 12,
              alignItems: 'stretch',
            }}
          >
            <Card
              size="small"
              title={
                <Space size={8}>
                  <span>{t('list')}</span>
                  <Tag>{counts.total}</Tag>
                </Space>
              }
              extra={
                <Button
                  size="small"
                  type="text"
                  icon={<PlusOutlined />}
                  aria-label={t('add')}
                  onClick={addRow}
                  disabled={!Array.isArray(rows)}
                />
              }
              style={{
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
              styles={{
                body: { flex: 1, minHeight: 0, padding: 0, overflowY: 'auto' },
              }}
            >
              {busy ? (
                <Flex align="center" justify="center" style={{ padding: 40 }}>
                  <Spin />
                </Flex>
              ) : !Array.isArray(rows) || rows.length === 0 ? (
                <Empty
                  style={{ padding: '28px 12px' }}
                  description={
                    <span style={{ fontSize: 12.5, color: token.colorTextSecondary }}>
                      {phase === 'error' ? t('loadFailed') : t('empty')}
                    </span>
                  }
                />
              ) : (
                <List
                  size="small"
                  dataSource={rows}
                  rowKey={(row, index) => `${row.code}-${index}`}
                  renderItem={(row, index) => {
                    const on = enabledOf(row.enabled) !== false
                    const bad = (issuesByRow.get(index) || []).length > 0
                    return (
                      <List.Item
                        onClick={() => setSelected(index)}
                        style={{
                          cursor: 'pointer',
                          padding: '8px 12px',
                          background: index === selected ? token.colorFillSecondary : 'transparent',
                          borderLeft: `2px solid ${index === selected ? token.colorPrimary : 'transparent'}`,
                          opacity: on ? 1 : 0.55,
                          alignItems: 'flex-start',
                        }}
                      >
                        <Flex vertical gap={2} style={{ width: '100%' }}>
                          <Space size={6}>
                            <Typography.Text strong style={{ fontFamily: MONO }}>
                              {row.code || '—'}
                            </Typography.Text>
                            <Tag color={row.kind === 'quality' ? 'blue' : 'green'} style={{ marginInlineEnd: 0 }}>
                              {row.kind === 'quality' ? t('quality') : t('debug')}
                            </Tag>
                            {on ? null : (
                              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                {t('disabled')}
                              </Tag>
                            )}
                            {bad ? <Tag color="red">!</Tag> : null}
                          </Space>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 11.5, fontFamily: MONO }}
                            ellipsis
                          >
                            {row.severity} · {checkOf(row.check, row.kind)} · {row.rule || '—'}
                          </Typography.Text>
                          {row.fix ? (
                            <Typography.Text
                              type="secondary"
                              style={{ fontSize: 11.5, opacity: 0.8 }}
                              ellipsis
                            >
                              ↳ {row.fix}
                            </Typography.Text>
                          ) : null}
                        </Flex>
                      </List.Item>
                    )
                  }}
                />
              )}
            </Card>

            <Card
              size="small"
              title={
                <Space size={8}>
                  <span>{current ? current.code || t('detail') : t('detail')}</span>
                  {currentIssues.length > 0 ? (
                    <Tag color="red">
                      {currentIssues.length} {t('issues')}
                    </Tag>
                  ) : null}
                </Space>
              }
              style={{
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
              styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 14 } }}
            >
              {current ? (
                <Form layout="vertical" size="small" requiredMark={false}>
                  <Flex gap={10} wrap>
                    <Form.Item label={t('code')} style={{ marginBottom: 10 }}>
                      <Input
                        value={current.code}
                        spellCheck={false}
                        placeholder="D001"
                        style={{ width: 110, fontFamily: MONO }}
                        onChange={(event) => patchCode(selected, event.target.value)}
                      />
                    </Form.Item>
                    <Form.Item label={t('check')} style={{ marginBottom: 10 }}>
                      <Segmented
                        size="small"
                        value={checkOf(current.check, current.kind)}
                        options={CHECK_TYPES.map((value) => ({
                          value,
                          label: value === 'static' ? t('static') : t('runtime'),
                        }))}
                        onChange={(value) => patch(selected, { check: value })}
                      />
                    </Form.Item>
                    <Form.Item label={t('severity')} style={{ marginBottom: 10 }}>
                      <Select
                        size="small"
                        style={{ width: 120 }}
                        value={current.severity}
                        options={SEVERITIES.map((value) => ({ value, label: value }))}
                        onChange={(value) => patch(selected, { severity: value })}
                      />
                    </Form.Item>
                    <Form.Item label={t('enabled')} style={{ marginBottom: 10 }}>
                      <Switch
                        size="small"
                        checked={enabledOf(current.enabled) !== false}
                        aria-label={t('enabled')}
                        onChange={(value) => patch(selected, { enabled: value })}
                      />
                    </Form.Item>
                    <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                      <Space size={4}>
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowUpOutlined />}
                          aria-label={t('moveUp')}
                          disabled={selected === 0}
                          onClick={() => moveRow(selected, -1)}
                        />
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowDownOutlined />}
                          aria-label={t('moveDown')}
                          disabled={!Array.isArray(rows) || selected >= rows.length - 1}
                          onClick={() => moveRow(selected, 1)}
                        />
                        <Popconfirm
                          title={t('removeConfirm')}
                          okButtonProps={{ danger: true }}
                          onConfirm={() => removeRow(selected)}
                        >
                          <Button
                            size="small"
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            aria-label={t('remove')}
                          />
                        </Popconfirm>
                      </Space>
                    </div>
                  </Flex>

                  <Form.Item label={t('rule')} style={{ marginBottom: 10 }}>
                    <Input.TextArea
                      value={current.rule}
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      style={{ fontFamily: MONO }}
                      onChange={(event) => patch(selected, { rule: event.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label={t('detect')} style={{ marginBottom: 10 }}>
                    <Input.TextArea
                      value={current.detect}
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      style={{ fontFamily: MONO }}
                      onChange={(event) => patch(selected, { detect: event.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label={t('fix')} style={{ marginBottom: 10 }}>
                    <Input.TextArea
                      value={current.fix ?? ''}
                      autoSize={{ minRows: 2, maxRows: 8 }}
                      onChange={(event) => patch(selected, { fix: event.target.value })}
                    />
                  </Form.Item>
                  <Form.Item
                    label={
                      <Flex align="center" gap={8}>
                        <span>{t('targets')}</span>
                        <Button
                          size="small"
                          type="link"
                          style={{ padding: 0, height: 'auto' }}
                          onClick={() => collect(current)}
                          disabled={!activeRel || !current?.code}
                          loading={collecting}
                        >
                          {t('collect')}
                        </Button>
                      </Flex>
                    }
                    style={{ marginBottom: 10 }}
                  >
                    <TargetList
                      value={current.targets}
                      placeholder="Session#append, parseDiagnostics"
                      empty={t('targetEmpty')}
                      addLabel={t('targetAdd')}
                      removeLabel={t('remove')}
                      onChange={(value) => patch(selected, { targets: value })}
                    />
                  </Form.Item>

                  {currentIssues.length > 0 ? (
                    <Alert
                      type="warning"
                      showIcon
                      title={currentIssues.map((text) => (
                        <div key={text}>{text}</div>
                      ))}
                    />
                  ) : null}
                </Form>
              ) : (
                <Empty
                  style={{ padding: '40px 12px' }}
                  description={<span style={{ color: token.colorTextSecondary }}>{t('pickCode')}</span>}
                />
              )}
            </Card>
          </div>
        )}
        </div>

        {busy || emptyFile ? null : (
          <Flex
            align="center"
            justify="space-between"
            gap={12}
            wrap
            style={{
              flex: 'none',
              padding: '10px 22px',
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
            }}
          >
            <Space size={8}>
              <Tag color={dirty ? 'orange' : 'green'} style={{ marginInlineEnd: 0 }}>
                {dirty ? t('dirty') : t('clean')}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {counts.total} {t('total')} · {t('debug')} {counts.debug} · {t('quality')} {counts.quality} ·{' '}
                {t('static')} {counts.static} · {t('runtime')} {counts.runtime}
                {counts.disabled > 0 ? ` · ${t('disabled')} ${counts.disabled}` : ''}
              </Typography.Text>
            </Space>
            <Space size={8}>
              <Button size="small" icon={<UndoOutlined />} disabled={!dirty} onClick={discard}>
                {t('discard')}
              </Button>
              <Button
                size="small"
                type="primary"
                loading={saving}
                disabled={!dirty || problems.length > 0}
                onClick={save}
              >
                {t('save')}
              </Button>
            </Space>
          </Flex>
        )}
      </div>
    )
  }
}

/**
 * 「诊断报告」那一页：只读 `<repo>/.coder/runs/` 里**最新**的一次运行。
 *
 * 按诊断码分类：一个码一段，标题是码 + 这条码的规则原文（来自运行目录里的 `codes.jsonl` 快照），
 * 下面挂它命中的每一条诊断 —— 文件:行、message、复现步骤、复核备注。
 *
 * 工作区与「诊断码」页共用同一个记忆（`localStorage["coder.page.v1"]`），切 Tab 回来还是同一个仓库。
 *
 * @param {{ t: (key: string) => string, subscribeLocale: (fn: () => void) => () => void, prefs: object }} env
 * @returns {Function}
 */
function createReportsPage(env) {
  const t = env.t

  return function CoderReportsPane() {
    const { token } = antdTheme.useToken()
    const [phase, setPhase] = useState('loading')
    const [workspaces, setWorkspaces] = useState([])
    const [dir, setDir] = useState('')
    const [report, setReport] = useState(null)
    const [activeCode, setActiveCode] = useState('')
    const [loading, setLoading] = useState(false)
    const [triaging, setTriaging] = useState(false)
    const [activity, setActivity] = useState([])
    const [launchClosed, setLaunchClosed] = useState('')
    const [notice, setNotice] = useState(null)
    const [tick, setTick] = useState(0)
    const [, setLocaleTick] = useState(0)

    useEffect(() => env.subscribeLocale(() => setLocaleTick((value) => value + 1)), [])

    // 别的 Tab 换了工作区，这一页跟着换（四个 Tab 共用同一份记忆）。
    useEffect(() => env.onDir((next) => setDir(next)), [env])

    // 页面开出去的那几次对话（排查），用来在页面上回显「还在跑 / 已结束」。
    useEffect(() => {
      if (!dir) return undefined
      let alive = true
      request('GET', `${CODER_API}/activity?dir=${encodeURIComponent(dir)}`)
        .then((value) => {
          if (alive) setActivity(Array.isArray(value?.items) ? value.items : [])
        })
        .catch(() => {
          if (alive) setActivity([])
        })
      return () => {
        alive = false
      }
    }, [dir, tick])

    // 开局：读工作区清单，选一个（记着的优先，其次默认，最后第一份）。
    useEffect(() => {
      let alive = true
      request('GET', `${CODER_API}/state`)
        .then((data) => {
          if (!alive) return
          const list = Array.isArray(data?.workspaces) ? data.workspaces : []
          setWorkspaces(list)
          setPhase('ready')
          const chosen = chooseWorkspace(list, env.prefs.dir, data?.defaultDir)
          if (chosen) {
            setDir(chosen.path)
            env.prefs.dir = chosen.path
            writePrefs(env.prefs)
          }
        })
        .catch((error) => {
          if (!alive) return
          setPhase('ready')
          setNotice({ kind: 'error', text: `${t('loadFailed')}：${error.message}` })
        })
      return () => {
        alive = false
      }
    }, [])

    // 最新那次报告（刷新按钮把 tick 加一，重新读）。
    useEffect(() => {
      if (!dir) return undefined
      let alive = true
      setLoading(true)
      request('GET', `${CODER_API}/reports?dir=${encodeURIComponent(dir)}`)
        .then((data) => {
          if (!alive) return
          setReport(
            data?.run
              ? {
                  run: data.run,
                  diagnostics: Array.isArray(data.diagnostics) ? data.diagnostics : [],
                  codes: Array.isArray(data.codes) ? data.codes : [],
                }
              : null,
          )
        })
        .catch((error) => {
          if (!alive) return
          setReport(null)
          setNotice({ kind: 'error', text: `${t('loadFailed')}：${error.message}` })
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
      return () => {
        alive = false
      }
    }, [dir, tick])

    const groups = useMemo(() => groupByCode(report), [report])
    // 选中的码；换了报告以后原来选的码没了就退回第一个。
    const activeGroup = groups.find((group) => group.code === activeCode) ?? groups[0] ?? null
    // 最近一次「发起排查」：还在跑 / 已结束，回来都看得到。
    const triageLaunch =
      mergeLaunches(activity, 'triage', dir).find((item) => item.sessionId !== launchClosed) ?? null

    /**
     * 「发起排查」：在目标工作区开一个对话，让它逐条核对最新那次诊断、先排误报，
     * 只对真实问题出解决方案（用 `coder_triage` 交回来，落在运行目录的 solutions.jsonl）。
     *
     * @returns {Promise<void>}
     */
    async function startTriage() {
      if (!dir || triaging) return
      setTriaging(true)
      setNotice(null)
      try {
        const value = await request('POST', `${CODER_API}/investigate`, { dir })
        rememberLaunch({ kind: 'triage', dir, runId: report?.run?.runId, sessionId: value?.sessionId })
        setLaunchClosed('')
        const title = workspaces.find((item) => item.path === dir)?.title || dir
        setNotice({
          kind: 'success',
          text: fill(t('investigateStarted'), {
            workspace: title,
            id: shortSessionOf(value?.sessionId),
          }),
        })
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('investigateFailed')}：${error.message}` })
      } finally {
        setTriaging(false)
      }
    }

    /**
     * 这次运行的范围（整仓 / 区间 / 单提交）。
     *
     * @param {object | null} change
     * @returns {string}
     */
    function scopeTextOf(change) {
      if (!change) return ''
      const head = String(change.head ?? '').slice(0, 12)
      const files = String(change.files ?? 0)
      if (change.mode === 'all') return fill(t('reportScopeAll'), { head, files })
      const base = String(change.base ?? '').slice(0, 12)
      if (change.mode === 'range') return fill(t('reportScopeRange'), { base, head, files })
      return fill(t('reportScopeCommit'), { base, head, files })
    }

    /**
     * 复核结论那一行。
     *
     * @param {object | null} info
     * @returns {string}
     */
    function verifyTextOf(info) {
      if (!info || info.status === 'skipped') return ''
      if (info.status === 'failed') return fill(t('reportVerifyFailed'), { message: info.message ?? '?' })
      return fill(t('reportVerify'), {
        checked: String(info.checked ?? 0),
        confirmed: String(info.confirmed ?? 0),
        uncertain: String(info.uncertain ?? 0),
        dropped: String(info.dropped ?? 0),
      })
    }

    const noWorkspace = phase === 'ready' && workspaces.length === 0

    return (
      <div
        style={{
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgLayout,
        }}
      >
        <Flex gap={10} align="center" wrap style={{ padding: '10px 22px 0' }}>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={!dir}
            onClick={() => setTick((value) => value + 1)}
          >
            {t('reportsRefresh')}
          </Button>
          <Button
            size="small"
            type="primary"
            loading={triaging}
            disabled={!dir || !report}
            onClick={startTriage}
          >
            {t('investigate')}
          </Button>
        </Flex>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '10px 22px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {notice ? (
            <Alert type="error" showIcon closable onClose={() => setNotice(null)} title={notice.text} />
          ) : null}

          {triageLaunch ? (
            <Alert
              type="info"
              showIcon
              closable
              onClose={() => setLaunchClosed(triageLaunch.sessionId)}
              title={launchTextOf(triageLaunch, 'triage', t)}
            />
          ) : null}

          {phase === 'loading' || (loading && !report) ? (
            <Flex justify="center" style={{ padding: 40 }}>
              <Spin />
            </Flex>
          ) : noWorkspace ? (
            <Card size="small">
              <Empty description={t('noWorkspace')} />
            </Card>
          ) : !report ? (
            <Card size="small">
              <Empty description={t('reportsEmpty')} />
            </Card>
          ) : (
            <>
              <Card size="small">
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <Typography.Text code style={{ fontSize: 12.5 }}>
                      {report.run.runId}
                    </Typography.Text>
                    {report.run.counts.error > 0 ? (
                      <Tag color="error" style={{ marginInlineEnd: 0 }}>
                        {report.run.counts.error}
                      </Tag>
                    ) : null}
                    {report.run.counts.warning > 0 ? (
                      <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                        {report.run.counts.warning}
                      </Tag>
                    ) : null}
                    {report.run.counts.info > 0 ? (
                      <Tag style={{ marginInlineEnd: 0 }}>{report.run.counts.info}</Tag>
                    ) : null}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {fill(t('reportGrouped'), {
                        groups: String(groups.length),
                        diagnostics: String(report.diagnostics.length),
                      })}
                    </Typography.Text>
                  </Space>
                  {scopeTextOf(report.run.change) ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {scopeTextOf(report.run.change)}
                    </Typography.Text>
                  ) : null}
                  {verifyTextOf(report.run.verification) ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {verifyTextOf(report.run.verification)}
                    </Typography.Text>
                  ) : null}
                  {report.run.error ? (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {typeof report.run.error === 'string' ? report.run.error : (report.run.error.message ?? '')}
                    </Typography.Text>
                  ) : null}
                </Space>
              </Card>

              {groups.length === 0 ? (
                <Card size="small">
                  <Empty description={t('reportNoDiagnostics')} />
                </Card>
              ) : (
                <ReportGroups
                  groups={groups}
                  activeCode={activeCode}
                  onSelect={setActiveCode}
                  t={t}
                  token={token}
                />
              )}

            </>
          )}
        </div>
      </div>
    )
  }
}

/**
 * 「解决方案」那一页：读最新一次运行目录里的 `solutions.jsonl`（「发起排查」那个对话交回来的）。
 *
 * 左边一列是诊断码（带方案条数和规则原文），右边是选中那个码的全部方案；
 * 每条一个勾选框，勾上的交给「对勾选的发起正式解决」—— 在目标工作区开一个对话去真的改代码。
 * 勾选记在 localStorage（按「工作区 + 运行」分开），换 Tab、刷新都还在。
 *
 * @param {{ t: (key: string) => string, subscribeLocale: (fn: () => void) => () => void, prefs: object }} env
 * @returns {Function}
 */
function createSolutionsPage(env) {
  const t = env.t

  return function CoderSolutionsPane() {
    const { token } = antdTheme.useToken()
    const [phase, setPhase] = useState('loading')
    const [workspaces, setWorkspaces] = useState([])
    const [dir, setDir] = useState('')
    const [data, setData] = useState(null)
    const [activeCode, setActiveCode] = useState('')
    const [loading, setLoading] = useState(false)
    const [applying, setApplying] = useState(false)
    const [activity, setActivity] = useState([])
    const [launchClosed, setLaunchClosed] = useState('')
    const [notice, setNotice] = useState(null)
    const [selected, setSelected] = useState([])
    const [tick, setTick] = useState(0)
    const [, setLocaleTick] = useState(0)

    useEffect(() => env.subscribeLocale(() => setLocaleTick((value) => value + 1)), [])

    // 别的 Tab 换了工作区，这一页跟着换（四个 Tab 共用同一份记忆）。
    useEffect(() => env.onDir((next) => setDir(next)), [env])

    // 开局：读工作区清单，选一个（记着的优先）。
    useEffect(() => {
      let alive = true
      request('GET', `${CODER_API}/state`)
        .then((value) => {
          if (!alive) return
          const list = Array.isArray(value?.workspaces) ? value.workspaces : []
          setWorkspaces(list)
          setPhase('ready')
          const chosen = chooseWorkspace(list, env.prefs.dir, value?.defaultDir)
          if (chosen) {
            setDir(chosen.path)
            env.prefs.dir = chosen.path
            writePrefs(env.prefs)
          }
        })
        .catch((error) => {
          if (!alive) return
          setPhase('ready')
          setNotice({ kind: 'error', text: `${t('loadFailed')}：${error.message}` })
        })
      return () => {
        alive = false
      }
    }, [])

    // 页面开出去的那几次对话（解决），用来回显「还在跑 / 已结束」。
    useEffect(() => {
      if (!dir) return undefined
      let alive = true
      request('GET', `${CODER_API}/activity?dir=${encodeURIComponent(dir)}`)
        .then((value) => {
          if (alive) setActivity(Array.isArray(value?.items) ? value.items : [])
        })
        .catch(() => {
          if (alive) setActivity([])
        })
      return () => {
        alive = false
      }
    }, [dir, tick])

    // 这个工作区最新一次运行的方案。
    useEffect(() => {
      if (!dir) return undefined
      let alive = true
      setLoading(true)
      request('GET', `${CODER_API}/solutions?dir=${encodeURIComponent(dir)}`)
        .then((value) => {
          if (!alive) return
          const solutions = Array.isArray(value?.solutions) ? value.solutions : []
          const runId = String(value?.runId ?? '')
          const codes = Array.isArray(value?.codes) ? value.codes : []
          setData(runId ? { runId, solutions, codes } : null)
          // 恢复上次的勾选，并且只保留这次真的还在的条目。
          const saved = readSolutionPicks()[pickKeyOf(dir, runId)] ?? []
          setSelected(solutions.map((item) => Number(item.id)).filter((id) => saved.includes(id)))
        })
        .catch((error) => {
          if (!alive) return
          setData(null)
          setNotice({ kind: 'error', text: `${t('loadFailed')}：${error.message}` })
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
      return () => {
        alive = false
      }
    }, [dir, tick])

    // 勾选变化就记下来（按「工作区 + 运行」各记各的）。
    useEffect(() => {
      if (!dir || !data?.runId) return
      const picks = readSolutionPicks()
      picks[pickKeyOf(dir, data.runId)] = selected
      writeSolutionPicks(picks)
    }, [selected, dir, data])

    /**
     * @param {number} id
     * @returns {void}
     */
    function toggle(id) {
      setSelected((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]))
    }

    /**
     * 「对勾选的发起正式解决」：在目标工作区开一个对话去改代码。
     *
     * @returns {Promise<void>}
     */
    async function applySelected() {
      if (!dir || !data?.runId || selected.length === 0 || applying) return
      setApplying(true)
      setNotice(null)
      try {
        const value = await request('POST', `${CODER_API}/fix`, {
          dir,
          runId: data.runId,
          ids: selected,
        })
        rememberLaunch({ kind: 'fix', dir, runId: data.runId, sessionId: value?.sessionId })
        setLaunchClosed('')
        const title = workspaces.find((item) => item.path === dir)?.title || dir
        setNotice({
          kind: 'success',
          text: fill(t('solutionsStarted'), {
            workspace: title,
            count: String(value?.count ?? selected.length),
            id: shortSessionOf(value?.sessionId),
          }),
        })
      } catch (error) {
        setNotice({ kind: 'error', text: `${t('solutionsFailed')}：${error.message}` })
      } finally {
        setApplying(false)
      }
    }

    const groups = useMemo(() => groupSolutionsByCode(data), [data])
    const activeGroup = groups.find((group) => group.code === activeCode) ?? groups[0] ?? null
    const noWorkspace = phase === 'ready' && workspaces.length === 0
    // 最近一次「发起正式解决」：还在跑 / 已结束，回来都看得到。
    const fixLaunch = mergeLaunches(activity, 'fix', dir).find((item) => item.sessionId !== launchClosed) ?? null

    return (
      <div
        style={{
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgLayout,
        }}
      >
        <Flex gap={10} align="center" wrap style={{ padding: '10px 22px 0' }}>
          {data?.runId ? (
            <Typography.Text code style={{ fontSize: 12 }}>
              {data.runId}
            </Typography.Text>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {fill(t('solutionsSelected'), { count: String(selected.length) })}
          </Typography.Text>
          <Button
            size="small"
            disabled={groups.length === 0}
            onClick={() => setSelected(data?.solutions?.map((item) => Number(item.id)) ?? [])}
          >
            {t('solutionsSelectAll')}
          </Button>
          <Button size="small" disabled={selected.length === 0} onClick={() => setSelected([])}>
            {t('solutionsClear')}
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={!dir}
            onClick={() => setTick((value) => value + 1)}
          >
            {t('solutionsRefresh')}
          </Button>
          <Button
            size="small"
            type="primary"
            loading={applying}
            disabled={selected.length === 0}
            onClick={applySelected}
          >
            {t('solutionsApply')}
          </Button>
        </Flex>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '10px 22px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {notice ? (
            <Alert
              type={notice.kind === 'success' ? 'success' : notice.kind === 'info' ? 'info' : 'error'}
              showIcon
              closable
              onClose={() => setNotice(null)}
              title={notice.text}
            />
          ) : null}

          {fixLaunch ? (
            <Alert
              type="info"
              showIcon
              closable
              onClose={() => setLaunchClosed(fixLaunch.sessionId)}
              title={launchTextOf(fixLaunch, 'fix', t)}
            />
          ) : null}

          {phase === 'loading' || (loading && !data) ? (
            <Flex justify="center" style={{ padding: 40 }}>
              <Spin />
            </Flex>
          ) : noWorkspace ? (
            <Card size="small">
              <Empty description={t('noWorkspace')} />
            </Card>
          ) : groups.length === 0 ? (
            <Card size="small">
              <Empty description={t('solutionsEmpty')} />
            </Card>
          ) : (
            <SolutionGroups
              groups={groups}
              activeCode={activeCode}
              onSelect={setActiveCode}
              selected={selected}
              onToggle={toggle}
              t={t}
              token={token}
            />
          )}
        </div>
      </div>
    )
  }
}

/**
 * 解决方案主体：左边一列是诊断码，右边是选中那个码的全部方案（每条一个勾选框）。
 *
 * @param {{
 *   groups: Array<object>,
 *   activeCode: string,
 *   onSelect: (code: string) => void,
 *   selected: number[],
 *   onToggle: (id: number) => void,
 *   t: (key: string) => string,
 *   token: object,
 * }} props
 * @returns {object}
 */
function SolutionGroups({ groups, activeCode, onSelect, selected, onToggle, t, token }) {
  const activeGroup = groups.find((group) => group.code === activeCode) ?? groups[0] ?? null

  return (
    <div
      style={{
        flex: 1,
        minHeight: 260,
        display: 'grid',
        gridTemplateColumns: 'minmax(200px, 280px) minmax(0, 1fr)',
        gap: 12,
        alignItems: 'stretch',
      }}
    >
      {/* 左边：诊断码。一行一个码，右边是它有几个方案。 */}
      <Card
        size="small"
        style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, minHeight: 0, padding: 8, overflowY: 'auto' } }}
      >
        {groups.map((group) => {
          const active = activeGroup?.code === group.code
          return (
            <div
              key={group.code}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(group.code)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect(group.code)
              }}
              style={{
                padding: '7px 9px',
                marginBottom: 4,
                borderRadius: 8,
                cursor: 'pointer',
                background: active ? token.colorFillSecondary : 'transparent',
                border: `1px solid ${active ? token.colorBorder : 'transparent'}`,
              }}
            >
              <Space size={6} wrap>
                <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{group.code}</span>
                <Tag style={{ marginInlineEnd: 0 }}>
                  {group.kind === 'quality' ? t('quality') : t('debug')}
                </Tag>
                <Tag color="success" style={{ marginInlineEnd: 0 }}>
                  {group.rows.length}
                </Tag>
              </Space>
              {group.rule ? (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: token.colorTextSecondary,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {group.rule}
                </div>
              ) : null}
            </div>
          )
        })}
      </Card>

      {/* 右边：这个码下的全部方案。 */}
      <Card
        size="small"
        title={
          activeGroup ? (
            <Space size={8} wrap>
              <span style={{ fontFamily: MONO, fontSize: 13 }}>{activeGroup.code}</span>
              <Tag style={{ marginInlineEnd: 0 }}>
                {activeGroup.kind === 'quality' ? t('quality') : t('debug')}
              </Tag>
              {activeGroup.rule ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {activeGroup.rule}
                </Typography.Text>
              ) : null}
            </Space>
          ) : null
        }
        extra={
          activeGroup ? (
            <Tag color="success" style={{ marginInlineEnd: 0 }}>
              {fill(t('reportCount'), { count: String(activeGroup.rows.length) })}
            </Tag>
          ) : null
        }
        style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, minHeight: 0, padding: '10px 14px 12px', overflowY: 'auto' } }}
      >
        {activeGroup.rows.map((item, index) => {
          const id = Number(item.id)
          const checked = selected.includes(id)
          return (
            <div
              key={id}
              style={{
                padding: '12px',
                marginBottom: index === activeGroup.rows.length - 1 ? 0 : 10,
                borderRadius: 10,
                border: `1px solid ${checked ? token.colorTextQuaternary : token.colorBorderSecondary}`,
                background: checked ? token.colorFillSecondary : token.colorFillQuaternary,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Checkbox checked={checked} aria-label={`#${id}`} onChange={() => onToggle(id)} />
                <span style={numberChipStyle(token)}>{`#${id}`}</span>
                {item.code ? <Tag style={{ marginInlineEnd: 0 }}>{item.code}</Tag> : null}
                <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.5 }}>{item.title}</span>
              </div>

              <Space size={4} wrap style={{ marginTop: 6, marginLeft: 26 }}>
                {item.risk ? (
                  <Tag
                    color={item.risk === 'high' ? 'error' : item.risk === 'medium' ? 'warning' : 'default'}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {`${t('solutionRisk')} ${item.risk}`}
                  </Tag>
                ) : null}
                {item.confidence ? (
                  <Tag color={item.confidence === 'high' ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
                    {`${t('solutionConfidence')} ${item.confidence}`}
                  </Tag>
                ) : null}
              </Space>

              {item.problem ? (
                <div style={{ marginTop: 8, marginLeft: 26 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('solutionProblem')}
                  </Typography.Text>
                  <TextBlocks text={item.problem} token={token} />
                </div>
              ) : null}
              {item.fix ? (
                <div style={{ marginTop: 8, marginLeft: 26 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('solutionFix')}
                  </Typography.Text>
                  <TextBlocks text={item.fix} token={token} highlight />
                </div>
              ) : null}
              {Array.isArray(item.files) && item.files.length > 0 ? (
                <div style={{ marginTop: 8, marginLeft: 26 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('solutionFiles')}
                  </Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                    {item.files.map((file, fileIndex) => (
                      <Typography.Text key={fileIndex} code style={{ fontSize: 12 }}>
                        {file}
                      </Typography.Text>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </Card>
    </div>
  )
}

/**
 * 把一段模型写的文字排成好读的样子：
 * 空行分段；`-`/`*`/数字编号开头的行当条目；其余按句子攒成段落（一段大约 80 字）。
 *
 * @param {string} text
 * @returns {Array<{ kind: 'p'|'li', text: string }>}
 */
function textBlocksOf(text) {
  const raw = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
  if (!raw) return []

  const blocks = []
  let paragraph = ''
  const flush = () => {
    const value = paragraph.trim()
    if (value) blocks.push({ kind: 'p', text: value })
    paragraph = ''
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }
    const item = /^(?:[-*•·]|\d+[.)、])\s*(.+)$/.exec(trimmed)
    if (item) {
      flush()
      blocks.push({ kind: 'li', text: item[1].trim() })
      continue
    }
    if (trimmed.length <= 60) {
      paragraph = paragraph ? `${paragraph}${trimmed}` : trimmed
      flush()
      continue
    }
    const sentences = trimmed.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [trimmed]
    for (const sentence of sentences) {
      const piece = sentence.trim()
      if (!piece) continue
      paragraph = paragraph ? `${paragraph}${piece}` : piece
      if (paragraph.length >= 80) flush()
    }
  }
  flush()
  return blocks
}

/**
 * 段落 / 条目混排的输出。
 *
 * @param {{ text: string, token: object, highlight?: boolean }} props
 * @returns {object}
 */
function TextBlocks({ text, token, highlight }) {
  const blocks = textBlocksOf(text)
  if (blocks.length === 0) return null

  const nodes = []
  let list = []
  const flushList = (key) => {
    if (list.length === 0) return
    nodes.push(
      <ul key={`ul-${key}`} style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
        {list.map((entry, index) => (
          <li key={index} style={{ marginBottom: 2 }}>
            {entry}
          </li>
        ))}
      </ul>,
    )
    list = []
  }

  blocks.forEach((block, index) => {
    if (block.kind === 'li') {
      list.push(block.text)
      return
    }
    flushList(index)
    nodes.push(
      <p
        key={`p-${index}`}
        style={{
          margin: '4px 0 0',
          fontSize: 13,
          lineHeight: 1.75,
          color: highlight ? token.colorText : token.colorTextSecondary,
        }}
      >
        {block.text}
      </p>,
    )
  })
  flushList('end')

  return <div>{nodes}</div>
}

/**
 * 报告主体：左边一列是诊断码（一行一个，带命中条数），右边是选中那个码的全部诊断条目。
 *
 * @param {{
 *   groups: Array<object>,
 *   activeCode: string,
 *   onSelect: (code: string) => void,
 *   t: (key: string) => string,
 *   token: object,
 * }} props
 * @returns {object}
 */
function ReportGroups({ groups, activeCode, onSelect, t, token }) {
  const activeGroup = groups.find((group) => group.code === activeCode) ?? groups[0] ?? null

  return (
    <div
      style={{
        flex: 1,
        minHeight: 260,
        display: 'grid',
        gridTemplateColumns: 'minmax(200px, 280px) minmax(0, 1fr)',
        gap: 12,
        alignItems: 'stretch',
      }}
    >
      {/* 左边：诊断码。一行一个码，右边是它命中的条数。 */}
      <Card
        size="small"
        style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, minHeight: 0, padding: 8, overflowY: 'auto' } }}
      >
        {groups.map((group) => {
          const active = activeGroup?.code === group.code
          return (
            <div
              key={group.code}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(group.code)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect(group.code)
              }}
              style={{
                padding: '7px 9px',
                marginBottom: 4,
                borderRadius: 8,
                cursor: 'pointer',
                background: active ? token.colorFillSecondary : 'transparent',
                border: `1px solid ${active ? token.colorBorder : 'transparent'}`,
              }}
            >
              <Space size={6} wrap>
                <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{group.code}</span>
                <Tag style={{ marginInlineEnd: 0 }}>
                  {group.kind === 'quality' ? t('quality') : t('debug')}
                </Tag>
                <Tag
                  color={
                    group.severity === 'error'
                      ? 'error'
                      : group.severity === 'warning'
                        ? 'warning'
                        : 'default'
                  }
                  style={{ marginInlineEnd: 0 }}
                >
                  {group.rows.length}
                </Tag>
              </Space>
              {group.rule ? (
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: token.colorTextSecondary,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {group.rule}
                </div>
              ) : null}
            </div>
          )
        })}
      </Card>

      {/* 右边：这个码下的全部诊断条目。 */}
      <Card
        size="small"
        title={
          activeGroup ? (
            <Space size={8} wrap>
              <span style={{ fontFamily: MONO, fontSize: 13 }}>{activeGroup.code}</span>
              <Tag style={{ marginInlineEnd: 0 }}>
                {activeGroup.kind === 'quality' ? t('quality') : t('debug')}
              </Tag>
              {activeGroup.rule ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {activeGroup.rule}
                </Typography.Text>
              ) : null}
            </Space>
          ) : null
        }
        extra={
          activeGroup ? (
            <Tag
              color={
                activeGroup.severity === 'error'
                  ? 'error'
                  : activeGroup.severity === 'warning'
                    ? 'warning'
                    : 'default'
              }
              style={{ marginInlineEnd: 0 }}
            >
              {fill(t('reportCount'), { count: String(activeGroup.rows.length) })}
            </Tag>
          ) : null
        }
        style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, minHeight: 0, padding: '4px 14px 12px', overflowY: 'auto' } }}
      >
        {activeGroup.rows.map((row, index) => (
          <div
            key={row.id ?? `${activeGroup.code}-${index}`}
            style={
              index === 0
                ? { padding: '8px 0' }
                : { padding: '10px 0', borderTop: `1px solid ${token.colorBorderSecondary}` }
            }
          >
            <Space size={6} wrap>
              {/* 这条诊断在本次运行里的编号（diagnostics.jsonl 的 id，报告里用「第 N 条」指代它）。 */}
              <span style={numberChipStyle(token)}>{`#${row.id ?? index + 1}`}</span>
              <Tag
                color={row.severity === 'error' ? 'error' : row.severity === 'warning' ? 'warning' : 'default'}
                style={{ marginInlineEnd: 0 }}
              >
                {row.severity}
              </Tag>
              {row.file ? (
                <Typography.Text code style={{ fontSize: 12 }}>
                  {row.file}
                  {row.line ? `:${row.line}` : ''}
                  {row.column ? `:${row.column}` : ''}
                </Typography.Text>
              ) : null}
              {row.verification ? (
                <Tag
                  color={row.verification === 'confirmed' ? 'success' : 'warning'}
                  style={{ marginInlineEnd: 0 }}
                >
                  {row.verification === 'confirmed' ? t('reportConfirmed') : t('reportUncertain')}
                </Tag>
              ) : null}
            </Space>
            <div
              style={{
                marginTop: 8,
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1.7,
                color: token.colorText,
              }}
            >
              {row.message}
            </div>
            {Array.isArray(row.steps) && row.steps.length > 0 ? (
              <ol
                style={{
                  margin: '6px 0 0',
                  paddingLeft: 18,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  color: token.colorTextSecondary,
                }}
              >
                {row.steps.map((step, stepIndex) => (
                  <li key={stepIndex}>{step}</li>
                ))}
              </ol>
            ) : null}
            {row.reproNote ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.reproNote}
              </Typography.Text>
            ) : null}
          </div>
        ))}
      </Card>
                    </div>
  )
}

/**
 * 把方案按**诊断码**分组：组按码排序，组内按编号；组标题的规则原文来自这次的 `codes.jsonl` 快照。
 *
 * @param {{ solutions?: Array<object>, codes?: Array<object> } | null} data
 * @returns {Array<{ code: string, kind: string, rule: string, rows: Array<object> }>}
 */
function groupSolutionsByCode(data) {
  if (!data) return []
  const known = new Map()
  for (const item of data.codes ?? []) known.set(String(item.code ?? ''), item)

  const groups = new Map()
  for (const solution of data.solutions ?? []) {
    const code = String(solution?.code ?? '').trim() || '—'
    const list = groups.get(code) ?? []
    list.push(solution)
    groups.set(code, list)
  }

  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([code, rows]) => {
      const meta = known.get(code)
      return {
        code,
        kind: meta?.kind === 'quality' ? 'quality' : 'debug',
        rule: String(meta?.rule ?? ''),
        rows: [...rows].sort((left, right) => Number(left.id ?? 0) - Number(right.id ?? 0)),
      }
    })
}

/**
 * 把一次运行的诊断按**诊断码**分组：组按码排序，组内先按级别、再按文件与行号。
 *
 * 组的标题用运行目录里 `codes.jsonl` 快照的规则原文（没有快照就只显示码）。
 *
 * @param {{ diagnostics?: Array<object>, codes?: Array<object> } | null} report
 * @returns {Array<{ code: string, kind: string, severity: string, rule: string, rows: Array<object> }>}
 */
function groupByCode(report) {
  if (!report) return []
  const known = new Map()
  for (const item of report.codes ?? []) known.set(String(item.code ?? ''), item)

  const groups = new Map()
  for (const row of report.diagnostics ?? []) {
    const code = String(row?.code ?? '')
    if (!code) continue
    const list = groups.get(code) ?? []
    list.push(row)
    groups.set(code, list)
  }

  const rank = { error: 0, warning: 1, info: 2 }
  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([code, rows]) => {
      const meta = known.get(code)
      const severity = meta?.severity ?? rows[0]?.severity ?? 'warning'
      return {
        code,
        kind: meta?.kind === 'quality' ? 'quality' : 'debug',
        severity,
        rule: String(meta?.rule ?? ''),
        rows: [...rows].sort(
          (left, right) =>
            (rank[left.severity] ?? 9) - (rank[right.severity] ?? 9) ||
            String(left.file ?? '').localeCompare(String(right.file ?? '')) ||
            Number(left.line ?? 0) - Number(right.line ?? 0),
        ),
      }
    })
}


/**
 * 左侧栏那一栏的图标。
 *
 * @param {{ size?: number, active?: boolean }} props
 * @returns {object}
 */
function CoderIcon(props) {
  const size = Number(props && props.size) > 0 ? Number(props.size) : 18
  const accent = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
  return React.createElement(
    'svg',
    { viewBox: '0 0 20 20', width: size, height: size, 'aria-hidden': true, fill: 'none', focusable: 'false' },
    React.createElement('rect', {
      x: 3.5,
      y: 2.5,
      width: 13,
      height: 15,
      rx: 2.5,
      stroke: accent,
      strokeWidth: 1.4,
    }),
    React.createElement('path', {
      d: 'M7 7.5h6M7 10.5h6M7 13.5h3.5',
      stroke: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
    }),
  )
}


/**
 * 包一层主题：跟随宿主的亮/暗与品牌色。两页共用同一套主题。
 *
 * @param {Function} Page
 * @returns {Function}
 */
function withTheme(Page) {
  return function CoderShell(props) {
    const host = useHostTheme()
    // 宿主的品牌色偏黑（按钮就是墨色）。antd 会拿它推导「选中项背景」，
    // 黑色品牌色推出来是 #404040，再配黑字就看不清了 —— 这里显式改成中性底色。
    const { themeConfig, css } = useMemo(() => {
      const algorithm = host.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm
      const token = {
        ...(host.brand ? { colorPrimary: host.brand } : {}),
        borderRadius: 8,
        fontSize: 13,
      }
      let design = null
      try {
        design = antdTheme.getDesignToken({ algorithm, token })
      } catch {
        design = null
      }
      const selected = design ? design.colorFillSecondary : 'rgba(0, 0, 0, 0.06)'
      const hover = design ? design.colorFillTertiary : 'rgba(0, 0, 0, 0.04)'
      const text = design ? design.colorText : 'inherit'
      // 下拉是 portal 到 body 的，宿主的全局样式也会命中里头的 [role="option"][aria-selected]，
      // 把选中行涂成深底白字、和 antd 自己的黑字叠在一起就看不清了。这里只针对
      // .ant-select-dropdown 里的选中/悬停行钉死颜色（主题色也算好，亮暗都对）。
      const css = `
.ant-select-dropdown .ant-select-item-option-selected:not(.ant-select-item-option-disabled),
.ant-select-dropdown .ant-select-item-option-selected:not(.ant-select-item-option-disabled):hover {
  background: ${selected} !important;
  color: ${text} !important;
  font-weight: 600;
}
.ant-select-dropdown .ant-select-item-option-active:not(.ant-select-item-option-disabled),
.ant-select-dropdown .ant-select-item-option:not(.ant-select-item-option-selected):hover {
  background: ${hover} !important;
  color: ${text} !important;
}
/* 顶部的两个 Tab 撑满整页：Tab 栏固定高度，下面那一页自己滚。 */
.coder-tabs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.coder-tabs > .ant-tabs-nav {
  flex: 0 0 auto;
  margin: 0;
  padding: 6px 22px 0;
}
/* antd 6 是 body-holder / body，旧版是 content-holder / content：两套都兜住。 */
.coder-tabs > .ant-tabs-body-holder,
.coder-tabs > .ant-tabs-content-holder {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.coder-tabs > .ant-tabs-body-holder > .ant-tabs-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.coder-tabs .ant-tabs-content {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
}
.coder-tabs .ant-tabs-tabpane {
  height: 100%;
  min-height: 0;
}
`
      return {
        css,
        themeConfig: {
          algorithm,
          token,
          components: {
            Select: {
              optionSelectedBg: selected,
              optionSelectedColor: text,
              optionSelectedFontWeight: 600,
              optionActiveBg: hover,
            },
          },
        },
      }
    }, [host.dark, host.brand])
    return (
      <ConfigProvider theme={themeConfig}>
        <style>{css}</style>
        <Page {...props} />
      </ConfigProvider>
    )
  }
}

/**
 * 整个 app：顶部一行 Tab（设计 / 诊断码 / 诊断报告 / 解决方案）＋ 右侧**唯一**的工作区选择，
 * 下面是对应那一页。
 *
 * 工作区只有这一处可选：换一次，四个 Tab 都跟着换（它们自己不再放选择器）。
 *
 * @param {{ t: (key: string) => string, subscribeLocale: (fn: () => void) => () => void, drafts: Map, prefs: object, selectDir: Function, onDir: Function }} env
 * @returns {Function}
 */
function createApp(env) {
  const t = env.t
  const Design = createDesignPage(env)
  const Codes = createPage(env)
  const Reports = createReportsPage(env)
  const Solutions = createSolutionsPage(env)

  return function CoderApp() {
    const { token } = antdTheme.useToken()
    const [tab, setTab] = useState('design')
    const [workspaces, setWorkspaces] = useState([])
    const [dir, setDir] = useState('')
    const [ready, setReady] = useState(false)
    const [, setLocaleTick] = useState(0)

    useEffect(() => env.subscribeLocale(() => setLocaleTick((value) => value + 1)), [])

    // 工作区清单只在这里读一次：Tab 栏那个选择器是四个页面共用的。
    useEffect(() => {
      let alive = true
      request('GET', `${CODER_API}/state`)
        .then((data) => {
          if (!alive) return
          const list = Array.isArray(data.workspaces) ? data.workspaces : []
          setWorkspaces(list)
          setReady(true)
          const chosen = chooseWorkspace(list, env.prefs.dir, data.defaultDir)
          if (chosen) {
            // 开局选中的也记下来：刷新之后还是这个仓库，各页读 prefs.dir 时也是同一个。
            env.selectDir(chosen.path)
            setDir(chosen.path)
          }
        })
        .catch(() => {
          if (!alive) return
          setReady(true)
        })
      return () => {
        alive = false
      }
    }, [env])

    /**
     * 换工作区：记进偏好（页面刷新后还认），并通知每个已经挂载的页面跟过去。
     *
     * @param {string} next
     * @returns {void}
     */
    function changeDir(next) {
      if (!next) return
      env.selectDir(next)
      setDir(next)
    }

    return (
      <div
        style={{
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: token.colorBgLayout,
        }}
      >
        <Tabs
          className="coder-tabs"
          activeKey={tab}
          onChange={setTab}
          tabBarExtraContent={{
            left: (
              <Typography.Text strong style={{ fontSize: 15, marginRight: 14, letterSpacing: 0.2 }}>
                {t('title')}
              </Typography.Text>
            ),
            right: (
              <Space size={6} style={{ paddingRight: 2 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('workspace')}
                </Typography.Text>
                <Select
                  size="small"
                  style={{ width: 200 }}
                  value={dir || undefined}
                  placeholder={t('noWorkspace')}
                  disabled={!ready || workspaces.length === 0}
                  onChange={changeDir}
                  options={workspaces.map((item) => ({
                    value: item.path,
                    label: item.title || item.path,
                  }))}
                />
              </Space>
            ),
          }}
          items={[
            { key: 'design', label: t('tabDesign'), children: <Design /> },
            { key: 'codes', label: t('tabCodes'), children: <Codes /> },
            { key: 'reports', label: t('tabReports'), children: <Reports /> },
            { key: 'solutions', label: t('tabSolutions'), children: <Solutions /> },
          ]}
        />
      </div>
    )
  }
}

/**
 * 页内兜底：渲染出错时只坏这一页，并把原因写在页面上（而不是让宿主的主区域一片空白）。
 */
class PageBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  /**
   * @param {Error} error
   * @returns {{ error: Error }}
   */
  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      const detail = this.state.error && this.state.error.stack ? this.state.error.stack : String(this.state.error)
      return (
        <div style={{ padding: 20 }}>
          <Alert
            type="error"
            showIcon
            title="这一页出错了"
            description={
              <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{detail}</pre>
            }
          />
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * 整个 app 包一层主题（亮暗与品牌色都跟随宿主）。
 *
 * @param {{ t: (key: string) => string, subscribeLocale: (fn: () => void) => () => void }} env
 * @returns {Function}
 */
function createShell(env) {
  const App = createApp(env)
  return withTheme(function CoderRoot(props) {
    return (
      <PageBoundary>
        <App {...props} />
      </PageBoundary>
    )
  })
}

/**
 * 插件工厂：注册左侧栏图标 + 主区域页面。
 *
 * @param {object} _React 宿主传入的 React（这里只用模块级那一份）
 * @returns {{ inject: string[], apply: (ctx: object) => void }}
 */
export function coderClientPlugin() {
  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      const locale = ctx.get('locale')
      if (locale && typeof locale.register === 'function') {
        for (const [id, dict] of Object.entries(CODER_MESSAGES)) {
          try {
            ctx.effect(() => locale.register('coder', id, dict))
          } catch {
            // 同一个 namespace 重复注册（热重载）不该让整页挂掉：没有词典就走英文兜底。
          }
        }
      }
      const bind = locale && typeof locale.bind === 'function' ? locale.bind('coder') : () => undefined

      /**
       * 宿主界面的语言：locale 服务绑不到时（命名空间/语言 id 对不上）用它兜底，
       * 免得整页变成英文。
       *
       * @returns {'zh'|'en'}
       */
      const hostLanguage = () => {
        try {
          const tags = []
          if (typeof document !== 'undefined') {
            tags.push(document.documentElement?.getAttribute('lang') ?? '')
            tags.push(document.body?.getAttribute('lang') ?? '')
          }
          if (typeof navigator !== 'undefined') tags.push(navigator.language ?? '')
          for (const tag of tags) {
            if (String(tag).toLowerCase().startsWith('zh')) return 'zh'
          }
        } catch {
          // 拿不到就当英文
        }
        return 'en'
      }

      const tr = (key) => {
        let text
        try {
          text = bind(key)
        } catch {
          text = undefined
        }
        if (typeof text === 'string' && text && text !== key) return text
        const dict = CODER_MESSAGES[hostLanguage()] ?? CODER_MESSAGES.en
        if (dict[key] !== undefined) return dict[key]
        return CODER_MESSAGES.en[key] === undefined ? key : CODER_MESSAGES.en[key]
      }
      const subscribeLocale =
        locale && typeof locale.subscribe === 'function' ? (fn) => locale.subscribe(fn) : () => () => {}

      // entry 级草稿：key = 工作区 + 文件。面板卸载（切到对话/别的面板）时留下，
      // 回到这一页再恢复；entry 本身被卸载或页面刷新就没了 —— 和「自动化任务」一致。
      const drafts = new Map()
      // 「上次看的是哪个工作区、哪个文件」：刷新/重启之后也认（localStorage，只存路径）。
      const prefs = readPrefs()

      // 工作区是**四个 Tab 共用**的一份：在「设计」页换了仓库，切到「诊断码」也是它。
      // 页面都在 Tabs 里常驻（切走不卸载），所以改的时候要通知其它页，不能只改自己的 state。
      const dirListeners = new Set()
      const selectDir = (next) => {
        if (!next) return
        prefs.dir = next
        writePrefs(prefs)
        for (const listener of dirListeners) {
          try {
            listener(next)
          } catch {
            // 一个页面坏掉不该让换工作区失败
          }
        }
      }
      const onDir = (listener) => {
        dirListeners.add(listener)
        return () => dirListeners.delete(listener)
      }

      const Page = createShell({ t: tr, subscribeLocale, drafts, prefs, selectDir, onDir })

      // 一个 app 一个页面：左侧栏一项「Coder」，页内顶部四个 Tab（设计 / 诊断码 / 诊断报告 / 解决方案）。
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'coder' }, Page))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'coder', order: 20, label: () => tr('nav') },
          CoderIcon,
        ),
      )
    },
  }
}

/**
 * @param {string} method
 * @param {string} url
 * @param {object} [body]
 * @returns {Promise<object>}
 */
async function request(method, url, body) {
  const init = { method, headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(url, init)
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || !data || data.ok === false) {
    const first = data && Array.isArray(data.problems) && data.problems[0]
    const message =
      (data && data.message) ||
      (first && first.message) ||
      `${response.status} ${response.statusText || ''}`.trim()
    throw new Error(message || 'request failed')
  }
  return data
}

/** 给测试用的几个纯函数（不参与运行时路径）。 */
export const __coderTest = {
  CODER_MESSAGES,
  ReportGroups,
  SolutionGroups,
  TargetList,
  addTarget,
  chooseFile,
  chooseWorkspace,
  designCaptureDpr,
  designHomeTargetOf,
  designUrlOf,
  draftKeyOf,
  feishuHomeOf,
  fill,
  groupByCode,
  groupSolutionsByCode,
  isFeishuUrl,
  numberChipStyle,
  parseImported,
  pointInViewport,
  pickKeyOf,
  readPrefs,
  readSolutionPicks,
  textBlocksOf,
  withAllEnabled,
  withoutDisabled,
  writePrefs,
  writeSolutionPicks,
}

