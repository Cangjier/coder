# Coder

Coder 是一个 DSH Host 插件，提供五个确定性工具：

- `list`：检查项目的 `.coder/` 文档树和锁 hash。
- `render`：把 `.coder/design/` 渲染成一个 `design.html`。
- `lock`：写入 `.coder/lock.md`，记录当前 hash 和授权原文。
- `unlock`：删除 `.coder/lock.md`。
- `update`：用 `tmp/` 下的源文件替换 `.coder` 设计文档；上锁时分两步执行。

它不生成设计内容，也不调用模型：`list` 只读文档并报告状态，`render` 只把已有文档写成 HTML，`update` 只做确定性的校验、替换和 git 提交。

设计见 [`docs/design.md`](docs/design.md)。

## .coder 文档树

项目根目录下的 `.coder/` 按约定维护四份设计文档：

| 文档 | 作用 |
| --- | --- |
| `.coder/design/file.md` | 目录与文件定义 |
| `.coder/design/architecture.md` | 多视角架构图 |
| `.coder/design/flow.md` | 主要场景流程 |
| `.coder/design/data_structure.md` | 关键数据结构（TypeScript interface） |

`architecture.md` 用 Mermaid `flowchart` + `subgraph` 画多张图：第一个 `## 全局视角`，后面是若干 `## 局部视角：<名称>`。每个视角一段说明 + 一张图。`data_structure.md` 只记录跨模块的关键结构，按 `##` 分段，用 `ts` 围栏和 TypeScript `interface` 表达。

`.coder/lock.md` 是锁状态文件，不属于四份设计文档；`list` 会把它标为 `lock`，`render` 不渲染它。

`file.md` 的路径支持通配：`*` 匹配一个路径段内的任意字符，`**` 匹配零层或多层目录。`tmp/**` 同时表达目录 `tmp` 和它下面的文件，不需要再写 `tmp`。项目里的每个文件（`.coder` 自身除外）都必须被至少一个路径/通配覆盖。`.coder` 自身或它下面的路径不能出现在 `file.md` 中，出现会报 `file.entry.coder`。

## list

`list` 每次调用做六件事：

1. 罗列 `.coder/` 下的所有文档，`lock.md` 标为 `lock`。
2. 不在预期集合、也不是 `lock.md` 的文档标记为**非法文档**。
3. 列出所有**缺失**的预期文档。
4. 按 [`docs/design.md`](docs/design.md) 的格式约定诊断每个文档，返回带行号的诊断记录。
5. 检查 `file.md` 是否覆盖项目里的所有文件，`.coder` 自身及其内容除外；`file.md` 中出现 `.coder` 会报错。
6. 存在 `lock.md` 时校验声明、hash 格式和当前 hash；hash 不一致报 `lock.hash.mismatch`。

```json
{ "root": "/path/to/project" }
```

`root` 可以省略，默认使用会话工作目录。结果同时包含结构化字段和一段可读的 `text` 汇总；没有非法文档、缺失文档和诊断时 `ok` 为 `true`。

## render

```json
{ "root": "/path/to/project", "out": "dist/.coder" }
```

默认写入 `dist/.coder/design.html`。`out` 可以指定另一个输出目录，文件名固定为 `design.html`。

页面内嵌四份文档：`file.md` 显示为可折叠的树表格，目录行可展开/收起，层级用缩进引导线；`architecture.md` 和 `flow.md` 显示为 Markdown 与 Mermaid 图，`data_structure.md` 显示为 Markdown 与 TypeScript 代码块，左侧是目录。页面不显示额外的状态或提示文案。Markdown 用 marked 渲染，Mermaid 图用 mermaid 渲染，两者从 jsDelivr 加载；离线时回退为 Markdown 源码。

## lock / unlock

```json
{ "root": "/path/to/project", "authorization": "用户授权原文" }
```

`lock` 写入 `.coder/lock.md`：第一行固定声明，第二行是当前 `.coder` 的 hash，第三行起原样保存 `authorization`。hash 的算法是：遍历 `.coder` 下除 `lock.md` 外的所有文件，按路径排序，逐个计算内容 sha256，拼接 hex 后再计算 sha256。已存在锁时 `lock` 失败。

`unlock` 要求 `authorization` 与 lock.md 中保存的原文逐字一致，然后删除 lock.md。hash 不一致时仍然解锁，但返回 `hashMatches:false` 提示自查。

锁是软约束：它不拦截 fs/bash。上锁期间直接修改 `.coder` 会被 `list` 和 `update` 的 hash 检查发现。

## update

```json
{
  "root": "/path/to/project",
  "updates": [
    { "source": "tmp/new-flow.md", "target": ".coder/design/flow.md" }
  ]
}
```

`source` 必须位于项目根目录的 `tmp/` 下，`target` 必须是四份设计文档之一且已经存在。使用 git 的项目请在 file.md 里用 `# .git/**` 覆盖 git 目录，并用 `# tmp/**` 覆盖暂存目录，否则 `list` 会按未覆盖文件报告。

未上锁时直接替换，返回「未上锁、update 用于流程变更、不推荐」的提示，不提交。

已上锁时分两步：

1. 第一次调用返回随机 `key` 和流程计划，不修改文件；dsh 起子代理审查 tmp 源文件，判断是设计补充还是设计调整。
2. 第二次调用带相同的 `updates`、`key`、`decision`（`supplement` / `adjustment`）、`review`（本次更新的用户授权原文）；选择 `adjustment` 时还必须带 `branch`（新建分支名）。`update` 重新检查 lock hash 和源文件 hash，替换文件、更新 lock.md 的 hash，并按 decision 提交。

`supplement` 在当前分支提交，不需要 `branch`。`adjustment` 先把当前工作区提交为 checkpoint，按传入的 `branch` 新建分支，再替换、更新 hash 并提交。不 push；复杂失败场景交给 git 和 dsh 的 fs 沙盒。

## 固化约定

插件不接受配置。以下内容写死在代码里：

| 内容 | 值 |
| --- | --- |
| 文档树目录 | `.coder` |
| 预期文档 | `design/file.md`、`design/architecture.md`、`design/flow.md`、`design/data_structure.md` |
| 覆盖范围 | 项目所有文件，`.coder` 自身及其内容除外 |
| 非预期白名单 | `.coder/lock.md` |
| 锁 hash | 所有 `.coder` 文件（除 lock.md）内容 sha256 拼接后再 sha256 |
| 默认渲染输出 | `dist/.coder/design.html` |

调用参数 `root` / `out` 只表示这次操作的位置，不是配置项。

## 开发

```sh
npm test
npm run check
```

插件是纯 ESM、零运行时依赖，只使用 Node 内置模块。`list` 的扫描与校验逻辑在 `src/docs.js`，锁格式与 hash 在 `src/lock.js`，HTML 生成在 `src/render.js`，git 操作在 `src/git.js`，工具定义在 `src/tools/`。
