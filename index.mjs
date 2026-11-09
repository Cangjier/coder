/**
 * coder：两个工具 + 一个主界面页面。
 *
 * - `coder_codes`：从仓库文档提炼「诊断码」，落在文档同目录的 codes.jsonl（有就复用）；
 * - `coder_debug`：复用同一段出码流程，按码的作用范围插桩，跑一次程序收集运行期诊断，
 *   最后交付一份 tsc 风格的诊断列表；
 * - 左侧栏的「诊断码」页（`client.js`：`sidebar.panellist` 图标 + `main` 面板，和「自动化任务」一样）：
 *   直接改 codes.jsonl。它通过 `/coder/api` 读写，Host 一侧只允许已登记工作区里的 `docs/codes.jsonl`。
 *
 * 为什么是插件：每一步都要起独立子代理，`subagents` 服务只在 DSH 进程里。
 *
 * 零依赖、纯 ESM：不 import 任何 harness 包，服务从 Cordis 上下文里取，
 * 所以整条编排链路可以用假 ctx 离线测。
 *
 * @module coder
 */
import { normalizeConfig } from './src/config.mjs'
import { fileURLToPath } from 'node:url'
import { createBrowserManager } from './src/browser.mjs'
import { createJobStore } from './src/jobs.mjs'
import { registerTools } from './src/tools/index.mjs'
import { registerCodesApi } from './src/web.mjs'

/** Cordis 插件名（也是 cordis.patch.yml 里那一行的 id）。 */
export const name = 'coder'

/** 注册工具之前需要 `tools` 服务。 */
export const inject = ['tools']

export { normalizeConfig }

/**
 * 挂载插件。配置无效时不注册任何工具，把原因写进日志。
 *
 * @param {object} ctx
 * @param {object} [rawConfig]
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`coder: 配置无效，插件未注册任何工具：${message}`)
    return
  }

  // 「让 DSH 搜集」的任务表：请求只开工，结果由那个对话用 coder_job 回填，
  // 页面当场收推送、或者下次回来用 jobId 查 —— 人离开界面也不会丢。
  const jobs = createJobStore()

  // 「设计」页的无头浏览器：跨域 iframe 里的弹窗和跳转父页面拿不到，
  // 放到宿主这一侧就都能拿到（弹窗 URL 用来内部跳转，frameNavigated 用来恢复上次浏览的页面）。
  const extensionDir = fileURLToPath(new URL('./extension', import.meta.url))
  const browsers = createBrowserManager({
    logger: ctx.logger,
    executable: config.browserPath,
    profileDir: config.browserProfileDir,
    viewport: { width: config.browserWidth, height: config.browserHeight },
    idleMs: config.browserIdleMs,
    maxTabs: config.browserMaxTabs,
    scale: config.browserScale,
    zoom: config.browserZoom,
  })
  try {
    ctx.effect(() => () => {
      browsers.dispose().catch(() => {})
    })
  } catch {
    // 老 ctx 没有 effect：浏览器由进程退出时一起收掉。
  }

  try {
    ctx.inject(['tools'], (toolsCtx) => {
      registerTools(ctx, toolsCtx, config, ctx.logger, jobs)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`coder: 无法注册工具（缺少 tools 服务）：${message}`)
  }

  // 编辑页的接口：等 webServer 就绪再挂。冷启动时它可能比本插件晚激活，
  // 直接 ctx.get('webServer') 会拿到 undefined，路由就永远不在了（页面报 404）。
  // 非 Web profile 没有这个服务，这段就一直是待命状态，什么也不做。
  try {
    ctx.inject(['webServer'], (webCtx) => registerCodesApi({ ctx: webCtx, logger: ctx.logger, jobs, browsers }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`coder: 诊断码编辑页接口没挂上：${message}`)
  }
}
