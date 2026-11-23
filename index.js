/**
 * `coder`：给 coder 文档树一个确定性入口。
 *
 * 插件注册五个工具：
 *
 *   list    扫描项目根目录下的 `.coder/` 文档树，罗列全部文档，标出非法和
 *           缺失的预期文档，并按 `docs/design.md` 的格式约定逐份诊断；
 *           诊断码的作用范围、步骤格式与文件通配会被检查，上锁时还会校验 lock.md 的 hash。
 *
 *   render  把 `.coder/` 的设计文档与诊断文档渲染成一个 `design.html`，默认写到
 *           `dist/.coder/design.html`；页面内嵌文档正文。
 *
 *   lock    写入 `.coder/lock.md`，记录当前 hash 与用户授权原文。
 *
 *   unlock  删除 `.coder/lock.md`。
 *
 *   update  用 `tmp/` 下的源文件替换 `.coder` 设计或诊断文档；上锁时分两步，
 *           要求子代理审查后带 key、decision、review 再次调用。
 *
 * 文档目录、预期文档和格式规则都是固化的，插件不接受配置。
 * 本包是纯 ESM、零运行时依赖：不 import 任何 `@deepseek-ai/*` 或第三方包，
 * 只使用 Node 内置模块。
 *
 * @module coder
 */

import { createListTool } from './src/tools/list.js'
import { createLockTool, createUnlockTool } from './src/tools/lock.js'
import { createRenderTool } from './src/tools/render.js'
import { createUpdateTool } from './src/tools/update.js'

/** 稳定的 Cordis 插件名（也是 cordis.patch.yml 里那一行的 id）。 */
export const name = 'coder'

/** 注册工具之前需要 `tools` 服务。 */
export const inject = ['tools']

/**
 * 挂载插件。
 *
 * 一个工具注册失败不影响另一个；失败只记日志，不把异常抛回加载器。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  try {
    ctx.inject(['tools'], (toolsCtx) => {
      const registered = []
      const definitions = [
        createListTool(ctx.logger),
        createRenderTool(ctx.logger),
        createLockTool(ctx.logger),
        createUnlockTool(ctx.logger),
        createUpdateTool(ctx.logger),
      ]
      for (const definition of definitions) {
        try {
          toolsCtx.tools.register(definition)
          registered.push(definition.name)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.error(`coder: 注册工具 ${definition.name} 失败：${message}`)
        }
      }
      if (registered.length === 0) {
        ctx.logger.error('coder: 所有工具都没有注册上，插件实际上不可用')
      } else {
        ctx.logger.info(`coder: 已注册工具 ${registered.join(', ')}`)
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.error(`coder: 无法注册工具（缺少 tools 服务）：${message}`)
  }
}
