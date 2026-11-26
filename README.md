# Coder

Coder 是一个 DSH Host 插件，提供六个确定性工具：

- `list`：检查项目的 `.coder/` 文档树和锁 hash。
- `render`：把 `.coder/` 的设计、诊断、计划与成员文档渲染成一个 `design.html`。
- `lock`：写入 `.coder/lock.md`，记录当前 hash 和授权原文。
- `unlock`：删除 `.coder/lock.md`。
- `update`：用 `tmp/` 下的源文件替换 `.coder` 下的文档；上锁时分两步执行。
- `create_issue`：在实施过程中登记当前框架发现的问题，写入 `.coder/issues/`。

它不生成设计内容，也不调用模型：`list` 只读文档并报告状态，`render` 只把已有文档写成 HTML，`update` 只做确定性的校验、替换和 git 提交。

设计见 [`docs/design.md`](docs/design.md)。

## .coder 文档树

项目根目录下的 `.coder/` 按约定维护五份设计文档和两份诊断文档，并可选维护计划条目文件、模块详情、成员文档与问题文档：

| 文档 | 作用 |
| --- | --- |
| `.coder/design/file.md` | 目录与文件定义 |
| `.coder/design/architecture.md` | 多视角架构图 |
| `.coder/design/flow.md` | 主要场景流程 |
| `.coder/design/data_structure.md` | 关键数据结构（TypeScript interface） |
| `.coder/design/modules.md` | 模块索引 |
| `.coder/design/module-NNNN.md` | 模块详情（可选） |
| `.coder/diagnosis/error.md` | E 开头的错误诊断码 |
| `.coder/diagnosis/warn.md` | W 开头的警告诊断码 |
| `.coder/plan/todo/T0001.md` | T 开头的进行中待办，一项一个文件（可选） |
| `.coder/plan/todo/archived/T0001.md` | T 开头的已归档待办（可选） |
| `.coder/plan/goal/G0001.md` | G 开头的进行中目标，一项一个文件（可选） |
| `.coder/plan/goal/archived/G0001.md` | G 开头的已归档目标（可选） |
| `.coder/issues/open/issue-NNNN.md` | 开启的问题，一个问题一个文件（可选） |
| `.coder/issues/close/issue-NNNN.md` | 关闭的问题，一个问题一个文件（可选） |
| `.coder/members/all.md` | 主对话与成员的身份、工作范围，成员的备注（可选） |
| `.coder/members/flow.md` | 成员之间的工作流程（可选） |

计划条目一项一个文件，文件名就是编码：todo 放 `plan/todo/T0001.md`（进行中）和 `plan/todo/archived/T0001.md`（已归档），goal 放 `plan/goal/G0001.md` 和 `plan/goal/archived/G0001.md`。todo 目录只放 `T` 加 4 位数字，goal 目录只放 `G` 加 4 位数字；文件里的 `# T0001` / `# G0001` 标题必须与文件名一致。todo 写 `任务范围`、`优先级`（P1/P2/P3）、`完成预期` 和 `当前进度`；goal 写 `任务范围`、`完成预期` 和 `关联ToDo`。完成预期条目写成 `如果 ... 则 ...，否则 ...`，当前进度条目写成 `[文件通配] 说明`。任务完成后把条目移到 `archived/` 目录；同一个编码不能同时留在两边。没有计划文件表示当前没有待办或归档记录；计划文件为空、或一份文件里出现两个编码标题都会报错。归档时用 `update` 写入 archived 文件，再用 `{ "target": ".coder/plan/todo/T0001.md", "delete": true }` 删除 active 文件。字段之间空一行，Markdown 才会逐行显示。

`architecture.md` 用 Mermaid `flowchart` + `subgraph` 画多张图：第一个 `## 全局视角`，后面是若干 `## 局部视角：<名称>`。每个视角一段说明 + 一张图。`data_structure.md` 只记录跨模块的关键结构，按 `##` 分段，用 `ts` 围栏和 TypeScript `interface` 表达。

诊断文档用诊断码组织：`error.md` 只放 `E` 加 4 位数字（如 `E0001`），`warn.md` 只放 `W` 加 4 位数字（如 `W0001`）。还没有可固化的诊断码时，两份诊断文档保持空文件即可。每个诊断码写 `作用范围`、`诊断方式：静态代码审查` 或 `诊断方式：运行时日志审查`，再用 `步骤N：` 写具体步骤。静态步骤写成 `步骤N：查看 [文件通配] 代码位置描述，如果 ...，则 ...，否则 ...`；运行时步骤用 `步骤N：在 [文件通配] 代码位置描述，插入日志：` 后接 `ts` 伪代码，再用 `步骤N：查看日志，如果 ...，则 ...，否则 ...` 判断。作用范围、诊断方式和每个步骤之间空一行，Markdown 才会逐行显示。

`modules.md` 是模块索引：只用 `# 0001` 这样的 4 位编码加一行模块说明，空文件表示还没有拆分模块。`module-NNNN.md` 是可选的模块详情，把 `# 架构`（全局视角必填、局部视角可选）、`# 流程`、`# 数据结构` 和可选的 `# 子模块` 收进一份文档；子模块用 `## 0002` 加说明表达。模块是设计文档的枝干/叶子，`architecture.md` 仍然是顶层设计。索引里的每个编码都要有对应的模块文件，存在的模块文件也必须出现在索引里。

问题文件记录当前框架在实施过程中发现的问题：一个问题一个文件，文件名是 `issue-NNNN.md`，状态由文件夹决定——开启的问题放 `issues/open/`，关闭的问题放 `issues/close/`。文件里按 `# 问题`、可选的 `# 复现` 与 `# 建议`、`# 提交源`、`# 当前进度`（开启）或 `# 关闭原因`（关闭）写正文；不再写 `# 状态`。两个文件夹都是可选的，`list` 只在文件存在时检查；同一个编码不能同时出现在 open/ 与 close/。`create_issue` 负责按最大编码加一在对应文件夹创建问题文件。

成员文档记录协作关系：`members/all.md` 先写 `# 主对话` 的 `身份` 与 `工作范围`，再用 `# 成员1`、`# 成员2` 等一级标题写每个成员的 `工作区名称`、`身份`、`工作范围`，以及可选的 `备注`（写在最后，用来记录部署方式、SSH 用户等补充信息）；字段顺序固定、值不能为空，成员编号在同一份文档里不能重复。成员可以为零，只有 `# 主对话` 也是合法状态。`members/flow.md` 用 `## 场景` 加非空 `mermaid` 图讲解成员之间的工作流程，规则与 `design/flow.md` 相同。两个文件都是可选的，`list` 只在存在时检查。

`.coder/lock.md` 是锁状态文件，不属于七份预期文档；`list` 会把它标为 `lock`，`render` 不渲染它。模块详情、成员文档和问题文档属于可选白名单，存在时检查、不存在不报缺失。

`file.md` 的路径支持通配：`*` 匹配一个路径段内的任意字符，`**` 匹配零层或多层目录。`tmp/**` 同时表达目录 `tmp` 和它下面的文件，不需要再写 `tmp`。项目里的每个文件（`.coder` 自身除外）都必须被至少一个路径/通配覆盖。`.coder` 自身或它下面的路径不能出现在 `file.md` 中，出现会报 `file.entry.coder`。

## list

`list` 每次调用做十一件事：

1. 罗列 `.coder/` 下的所有文档，`lock.md` 标为 `lock`。
2. 不在预期集合、也不是 `lock.md`、也不在可选白名单（`design/module-NNNN.md`、`issues/open/issue-NNNN.md`、`issues/close/issue-NNNN.md`、`members/all.md`、`members/flow.md`，以及 `plan/todo/T####.md`、`plan/todo/archived/T####.md`、`plan/goal/G####.md`、`plan/goal/archived/G####.md`）里的文档标记为**非法文档**。
3. 列出所有**缺失**的预期文档；可选文档不存在时不报缺失。
4. 按 [`docs/design.md`](docs/design.md) 的格式约定诊断每个存在的 Markdown 文档，返回带行号的诊断记录。
5. 解析两份诊断文档：校验编码前缀与 4 位数字、作用范围、诊断方式、步骤格式、步骤编号、文件通配命中和日志围栏。
6. 解析计划条目文件：校验目录与文件名编码、标题编码是否一致，字段顺序、编号条目、完成预期、当前进度、关联 ToDo，以及同一编码是否同时留在 active 与 archived。
7. 解析 `modules.md` 和存在的 `module-NNNN.md`：校验模块编码、说明、架构/流程/数据结构分段、子模块引用，以及索引与详情文件是否成对。
8. 解析可选的 `issues/open/issue-NNNN.md` 与 `issues/close/issue-NNNN.md`：校验文件名编码、段落顺序、当前进度、关闭原因，以及同一编码是否同时出现在 open/ 与 close/。
9. 解析可选的 `members/all.md` 与 `members/flow.md`：校验主对话、成员编号、身份/工作范围/工作区名称字段与可选的成员备注，以及成员流程的场景与 Mermaid 图。
10. 检查 `file.md` 是否覆盖项目里的所有文件，`.coder` 自身及其内容除外；`file.md` 中出现 `.coder` 会报错。
11. 存在 `lock.md` 时校验声明、hash 格式和当前 hash；hash 不一致报 `lock.hash.mismatch`。

诊断码的作用范围是文件通配时，以及步骤里的文件通配，都要求至少命中一个项目文件；步骤内容是自然语言，`list` 只检查格式，不执行它们。

```json
{ "root": "/path/to/project" }
```

`root` 可以省略，默认使用会话工作目录。结果同时包含结构化字段和一段可读的 `text` 汇总；没有非法文档、缺失文档和诊断时 `ok` 为 `true`。

## render

```json
{ "root": "/path/to/project", "out": "dist/.coder" }
```

默认写入 `dist/.coder/design.html`。`out` 可以指定另一个输出目录，文件名固定为 `design.html`。

页面内嵌七份预期文档、存在的计划条目、存在的模块详情和存在的成员文档：`file.md` 显示为可折叠的树表格，目录行可展开/收起，层级用缩进引导线；`architecture.md` 和 `flow.md` 显示为 Markdown 与 Mermaid 图，`data_structure.md` 显示为 Markdown 与 TypeScript 代码块，`modules.md` 与 `module-NNNN.md` 显示为 Markdown，`members/all.md` 与 `members/flow.md` 显示为 Markdown，`error.md` / `warn.md` 显示为 Markdown 诊断码目录，每个计划条目文件显示为一份 Markdown 计划条目，左侧是目录。问题文档属于实施过程记录，不进入页面。页面不显示额外的状态或提示文案。服务端先写入全部被渲染文档的源码，脚本不可用时它就是可读正文；脚本可用时前端升级为树表格 / Markdown / Mermaid。Markdown 用 marked 渲染，Mermaid 图用 mermaid 渲染，两者从 jsDelivr 加载。

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

`source` 必须位于项目根目录的 `tmp/` 下，`target` 是 `.coder/` 下的任意文件（`.coder/lock.md` 除外），可以已经存在，也可以缺失。缺失时会创建目标文件和必要的父目录。要删除一个已存在的文件时，用 `{ "target": ".coder/plan/todo/T0001.md", "delete": true }`，不需要 `source`；删除同样受 lock hash 与 git 提交保护。使用 git 的项目请在 file.md 里用 `# .git/**` 覆盖 git 目录，并用 `# tmp/**` 覆盖暂存目录，否则 `list` 会按未覆盖文件报告。

未上锁时直接替换或删除，返回「未上锁、update 用于流程变更、不推荐」的提示，不提交。

已上锁时分两步：

1. 第一次调用返回随机 `key` 和流程计划，不修改文件；dsh 起子代理审查 tmp 源文件，判断是文档补充还是文档调整。
2. 第二次调用带相同的 `updates`、`key`、`decision`（`supplement` / `adjustment`）、`review`（本次更新的用户授权原文）；选择 `adjustment` 时还必须带 `branch`（新建分支名）。`update` 重新检查 lock hash 和源文件 hash，替换文件、更新 lock.md 的 hash，并按 decision 提交。

`supplement` 在当前分支提交，不需要 `branch`。`adjustment` 先把当前工作区提交为 checkpoint，按传入的 `branch` 新建分支，再替换、更新 hash 并提交。不 push；复杂失败场景交给 git 和 dsh 的 fs 沙盒。

## create_issue

```json
{
  "root": "/path/to/project",
  "problem": "列表漏报了 flow.md 的格式问题",
  "source": "list 检查时发现",
  "scope": "src/**",
  "progress": "正在补检查",
  "status": "开启"
}
```

问题文件记录当前框架在实施过程中发现的问题。`create_issue` 扫描 `.coder/issues/open/` 与 `.coder/issues/close/`，取已用编码最大值加一，从 `0001` 开始；`开启` 写 `issues/open/issue-NNNN.md`（以 `# 当前进度` 收尾，内容为 `[scope] 当前进度为 ...`），`关闭` 写 `issues/close/issue-NNNN.md`（以 `# 关闭原因` 收尾）。状态由文件夹决定，文件里不写 `# 状态`。`reproduce` 和 `suggestion` 可选，分别写入 `# 复现` 与 `# 建议`；`# 提交源` 记录发现问题的工具、文档或实施步骤。

生成的内容先按问题格式自检，自检不过不落盘。`.coder` 已上锁时拒绝直接写入，问题文档需要通过 unlock 或 update 流程变更。工具不提交 git。

## 固化约定

插件不接受配置。以下内容写死在代码里：

| 内容 | 值 |
| --- | --- |
| 文档树目录 | `.coder` |
| 预期文档 | `design/file.md`、`design/architecture.md`、`design/flow.md`、`design/data_structure.md`、`design/modules.md`、`diagnosis/error.md`、`diagnosis/warn.md` |
| 覆盖范围 | 项目所有文件，`.coder` 自身及其内容除外 |
| 诊断码 | `error.md` 只允许 `E\d{4}`，`warn.md` 只允许 `W\d{4}` |
| 计划编码 | `plan/todo/` 与 `plan/todo/archived/` 只允许 `T\d{4}.md`，`plan/goal/` 与 `plan/goal/archived/` 只允许 `G\d{4}.md`；文件名必须与标题一致 |
| 模块编码 | `modules.md`、`module-NNNN.md` 与子模块只允许 `\d{4}` |
| 问题编码 | `issues/open/` 与 `issues/close/` 下只允许 `issue-\d{4}.md`，状态由文件夹决定 |
| 非预期白名单 | `.coder/lock.md`（状态 `lock`）、`.coder/design/module-NNNN.md`、`.coder/issues/open/issue-NNNN.md`、`.coder/issues/close/issue-NNNN.md`、`.coder/members/all.md`、`.coder/members/flow.md`、`.coder/plan/todo/T####.md`、`.coder/plan/todo/archived/T####.md`、`.coder/plan/goal/G####.md`、`.coder/plan/goal/archived/G####.md`（计划条目可选，路径不合法时是非法文档） |
| 锁 hash | 所有 `.coder` 文件（除 lock.md）内容 sha256 拼接后再 sha256 |
| 默认渲染输出 | `dist/.coder/design.html` |

调用参数 `root` / `out` 只表示这次操作的位置，不是配置项。

## 开发

```sh
npm test
npm run check
```

插件是纯 ESM、零运行时依赖，只使用 Node 内置模块。`list` 的扫描与校验逻辑在 `src/docs.js`，设计文档结构检查在 `src/design.js`，模块索引与详情在 `src/module.js`，问题文档在 `src/issue.js`，成员文档在 `src/member.js`，诊断文档解析在 `src/diagnosis.js`，计划条目解析在 `src/plan.js`，作用范围校验在 `src/scope.js`，Markdown 结构扫描在 `src/markdown.js`，锁格式与 hash 在 `src/lock.js`，HTML 生成在 `src/render.js`，git 操作在 `src/git.js`，工具定义在 `src/tools/`。
