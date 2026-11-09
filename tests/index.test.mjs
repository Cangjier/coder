import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../index.mjs'

/**
 * 假 ctx：只记录 inject 的依赖与回调，其它服务一律没有。
 *
 * @param {(name: string) => unknown} [get]
 * @returns {{ ctx: object, injected: Array<{ deps: string[], callback: Function }> }}
 */
function makeCtx(get) {
  const injected = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (key) => (get ? get(key) : undefined),
    inject(deps, callback) {
      injected.push({ deps, callback })
    },
  }
  return { ctx, injected }
}

test('插件名与硬依赖：tools', () => {
  assert.equal(name, 'coder')
  assert.deepEqual(inject, ['tools'])
})

test('apply 会等 webServer 就绪再挂 /coder/api（冷启动顺序问题的回归）', () => {
  const { ctx, injected } = makeCtx()
  apply(ctx, {})

  const deps = injected.map((item) => item.deps)
  assert.deepEqual(deps, [['tools'], ['webServer']], '两个依赖都用 inject 等着，而不是直接 ctx.get')

  // 模拟 webServer 出现后 Cordis 回调：应该注册一条 prefix 路由，并把 disposer 交回去。
  const routes = []
  const webCtx = {
    get(key) {
      if (key === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  const dispose = injected[1].callback(webCtx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/coder/api')
  assert.equal(typeof routes[0].handler, 'function')
  assert.equal(typeof dispose, 'function', '回调要把 disposer 交回去，插件卸载时路由才会摘掉')
})

test('没有 webServer 时接口注册不抛异常，只返回空 disposer', async () => {
  const { registerCodesApi } = await import('../src/web.mjs')
  const dispose = registerCodesApi({ ctx: { get: () => undefined }, logger: { warn() {} } })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})
