/**
 * `client.js` 的打包入口：插件工厂，外加给测试用的几个纯函数。
 *
 * `scripts/build-client.mjs` 用 esbuild 把这一段（连同 antd 与 src/codes-client.js）打成一个
 * CommonJS 文件，`react` / `react-dom` 保持 external —— 运行时用宿主那一份，hooks 才是同一个实例。
 */
import { coderClientPlugin, __coderTest } from './app.jsx'

export { coderClientPlugin, __coderTest }
