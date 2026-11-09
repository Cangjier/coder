/**
 * 把 `src/client/entry.js`（React + antd 页面）打包成浏览器能直接加载的 `client.js`。
 *
 * 模块表只提供 `react`，所以：
 * - `react` 保持 external —— 运行时用宿主那一份，hooks 和渲染器才是同一个 React；
 * - antd、react-dom、图标都打进同一个文件（约 1.3MB），页面不需要别的模块表条目；
 * - JSX 用 classic transform 编译（`React.createElement`），因此也不需要 `react/jsx-runtime`。
 *
 * 用法：
 *   node scripts/build-client.mjs           写出 client.js
 *   node scripts/build-client.mjs --check   只检查 client.js 是不是最新的（测试用）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const OUT = path.join(root, 'client.js')

/**
 * @returns {Promise<string>}
 */
export async function buildClient() {
  const built = await esbuild.build({
    entryPoints: [path.join(root, 'src/client/entry.js')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome110'],
    jsx: 'transform',
    loader: { '.js': 'jsx' },
    external: ['react', 'react-dom'],
    minify: true,
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const body = built.outputFiles[0].text.trimEnd()

  return `/**
 * coder 的浏览器一半：左侧栏「诊断码」图标 + 主区域页面（React + antd）。
 *
 * 这个文件是生成的，别手改：改 src/client/app.jsx 或 src/codes-client.js 之后
 * 跑 \`npm run build:client\`（\`npm test\` 会检查它是不是最新的）。
 */
window.__ModuleLoader__.load({
  id: 'coder',
  factory(require) {
    var module = { exports: {} }
    try {
      ;(function (module, exports, require) {
${body}
      }).call(module.exports, module, module.exports, require)
      var plugin = module.exports.coderClientPlugin()
      // 测试用的纯函数挂在插件对象上（不参与运行时路径）。
      plugin.__test = module.exports.__coderTest
      return plugin
    } catch (error) {
      // 包本身没起来（依赖解析、初始化抛错）：在页面上留一张错误卡，
      // 而不是让「诊断码」悄悄从侧栏消失。
      return errorPlugin(require, error)
    }
  },
})

/**
 * 兜底：把初始化错误原样显示出来，仍然注册同一个侧栏位置。
 *
 * @param {Function} require
 * @param {unknown} error
 * @returns {object}
 */
function errorPlugin(require, error) {
  var React = require('react')
  var text = error && error.stack ? error.stack : String(error)
  return {
    inject: ['slots'],
    apply: function (ctx) {
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: 'coder-codes' }, function () {
          return React.createElement(
            'div',
            {
              style: {
                margin: 24,
                padding: 16,
                border: '1px solid var(--dsw-alias-state-error-primary)',
                borderRadius: 8,
                color: 'var(--dsw-alias-state-error-primary)',
                font: '12px ui-monospace, Consolas, monospace',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              },
            },
            'coder 浏览器一半加载失败：\\n' + text,
          )
        })
      })
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: 'coder-codes', order: 20, label: function () { return '诊断码' } },
          function () {
            return React.createElement('span', { style: { fontSize: 14, color: 'var(--dsw-alias-state-error-primary)' } }, '!')
          },
        )
      })
    },
  }
}
`
}

const check = process.argv.includes('--check')
const text = await buildClient()
const current = await fs.readFile(OUT, 'utf8').catch(() => null)

if (check) {
  if (current !== text) {
    console.error('client.js 不是最新的：跑 `npm run build:client` 重新生成')
    process.exitCode = 1
  } else {
    console.log('client.js 是最新的')
  }
} else if (current === text) {
  console.log('client.js 没有变化')
} else {
  await fs.writeFile(OUT, text, 'utf8')
  console.log(`已写出 ${path.relative(root, OUT)}（${(Buffer.byteLength(text) / 1024).toFixed(0)} KB）`)
}
