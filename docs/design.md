coder 的设计目标是提供一系列确定性工具，驱动 dsh 实现符合需求的代码项目。主要方法是维护 `.coder/` 下的一系列结构化文档。

# DESIGN

设计文档在 `.coder/design/` 下，包括 `file.md`、`architecture.md`、`flow.md`、`data_structure.md`；诊断文档在 `.coder/diagnosis/` 下，包括 `error.md` 和 `warn.md`；计划文档在 `.coder/plan/` 下，包括 `todo.md`、`todo-archived.md`、`goal.md` 和 `goal-archived.md`。

## file.md

对目录和文件进行定义，明确其工作范围。路径可以用通配表达：`*` 匹配一个路径段内的任意字符，`**` 匹配零层或多层目录，`?` 匹配一个字符。

```md
# 目录/文件相对路径
目录/文件定义，只描述正向预期。
```

如：

```md
# src
源代码目录
## src/main.ts
功能入口
# docs
文档目录
# tmp/**
临时文件目录及文件
```

`# tmp/**` 同时表达目录 `tmp` 和它下面的文件，不需要再分别写 `tmp` 和 `tmp/**`。

`list` 会检查 file.md 是否覆盖项目里的所有文件，`.coder` 自身及其内容除外。

## architecture.md

用多张 Mermaid 图描述架构：先全局视角，再重点局部视角。

- `## 全局视角` 必须是第一个视角，图用 `flowchart`/`graph` 并以 `subgraph` 表达分层。
- 后面是若干 `## 局部视角：<名称>`，每个视角聚焦一个局部问题。
- 每个视角一段说明 + 一张 Mermaid 图；图类型为 `flowchart`/`graph`。
- 图是否准确描述代码无法机械校验，`list` 只校验结构。

## flow.md

针对主要场景，绘制其流程。

## data_structure.md

描述关键数据结构，用 `ts` 围栏和 TypeScript `interface` 表达。只记录跨模块传递的关键结构；解析器内部的行、围栏等中间结构留在代码里。

## diagnosis/error.md 与 warn.md

诊断文档描述项目自己的诊断码。

```md
# E0001

作用范围：全局

诊断方式：静态代码审查

步骤1：查看 [src/**] 入口代码，如果缺少导出，则认定为 E0001，否则继续。

步骤2：查看 [src/**] 注册代码，如果未注册，则认定为 E0001，否则继续。
```

运行时诊断使用日志审查，步骤里插入 `ts` 伪代码，再查看日志：

````md
# E0002

作用范围：全局

诊断方式：运行时日志审查

步骤1：在 [src/**] 校验处，插入日志：

```ts
console.log({ recorded, current })
```

步骤2：查看日志，如果 recorded 与 current 不一致，则认定为 E0002，否则继续。
````

- `error.md` 的诊断码以 `E` 开头，`warn.md` 的诊断码以 `W` 开头。
- 数字部分固定 4 位，所以合法形式是 `E0001`、`W0001`；`E001`、`E00001`、`e0001` 都不合法。
- `作用范围` 只能是 `全局`，或相对于项目根目录的文件路径通配；通配写法与 `file.md` 相同。
- 每个诊断码恰好有一个 `诊断方式：静态代码审查` 或 `诊断方式：运行时日志审查`。
- 静态代码审查的每个步骤必须写成：
  `步骤N：查看 [文件通配] 代码位置描述，如果 ...，则 ...，否则 ...`
- 运行时日志审查的步骤有两种：
  - `步骤N：在 [文件通配] 代码位置描述，插入日志：`，后面紧跟一个非空的 `ts`/`typescript` 围栏；
  - `步骤N：查看日志，如果 ...，则 ...，否则 ...`
- 步骤编号从 `步骤1` 开始连续递增；同一种诊断方式下不允许跳号或重号。
- 步骤里的文件通配由 `list` 校验；作用范围是文件通配时，也要求至少命中一个项目文件。
- 诊断文档可以留空：还没有需要固化的诊断码时，`error.md` 和 `warn.md` 保持空文件即可；写诊断码时从 `# E0001` / `# W0001` 开始。
- 诊断文档只用 `#` 写诊断码；作用范围、诊断方式和步骤都写成普通行，第一个诊断码之前不能有正文。
- 步骤内容是自然语言，`list` 检查格式、编号、通配命中和日志围栏，不执行步骤，也不判断步骤是否足够详细。

## plan/todo.md、goal.md 与归档文档

计划文档把待办（todo）和目标（goal）写成编码条目。todo 与 goal 各有一份 active 文档和一份 archived 文档；任务完成后从 active 移到 archived，同一个编码不能同时留在两边。

```md
# T0001

任务范围：src/**

优先级：P1

完成预期：

1. 如果计划文档缺少字段，则 list 报告 plan.* 诊断，否则通过。
2. 如果编号不连续，则 list 报错，否则通过。

当前进度：

1. [src/**] 解析与校验已实现。
```

```md
# G0001

任务范围：src/**

完成预期：

1. 如果计划文档无法由 list 机械校验，则视为未达成，否则通过。

关联ToDo：

1. T0001
```

- `todo.md` / `todo-archived.md` 只放 `T` 开头的编码，`goal.md` / `goal-archived.md` 只放 `G` 开头的编码；数字部分固定 4 位。
- `任务范围` 只能是 `全局`，或相对于项目根目录的文件路径通配；通配写法与 `file.md` 相同。
- todo 的字段顺序是 `任务范围 → 优先级 → 完成预期 → 当前进度`；goal 是 `任务范围 → 完成预期 → 关联ToDo`。
- `优先级` 只能是 `P1`、`P2` 或 `P3`。
- todo 的 `完成预期`、`当前进度` 和 goal 的 `完成预期`、`关联ToDo` 下面的条目从 `1.` 开始连续编号。
- 完成预期写成 `如果 ... 则 ...，否则 ...`；当前进度写成 `[文件路径通配] 说明`。
- `关联ToDo` 的条目是 `T` 加 4 位数字。
- 计划文档只用 `#` 写编码；字段和条目都写成普通行。
- 空计划文档合法，表示当前没有待办或没有归档记录。
- `list` 检查编码、字段顺序与重复、编号、句式、进度里的文件通配和关联 ToDo 格式；任务是否真的完成、进度描述是否属实无法机械判断。
- 同一个编码同时出现在 active 与 archived 文档时报 `plan.code.archived-duplicate`。
- 归档时用 `update` 替换 active 与 archived 文档，把完成条目从 active 移入 archived。

## lock.md

`.coder/lock.md` 是锁状态文件，不是预期文档，`render` 不渲染它。

- 第一行是固定声明：`.coder 被上锁，禁止直接修改文件，修改必须走 update。`
- 第二行是 `sha256:<hex>`：递归遍历 `.coder/` 下除 `lock.md` 外的所有文件，按相对路径排序，逐个计算内容 sha256，把 hex 直接拼接后再计算 sha256。
- 第三行起是 lock 时传入的用户授权原文，逐字保存。
- 锁是软约束：不拦截文件系统或 bash 写入；`list` 和 `update` 通过 hash 发现直接修改。
- `unlock` 会删除 lock.md；删除后可以自由修改 `.coder`，直到再次 lock。

# 工具

## list

dsh 调用 `list` 时，将会罗列 `.coder/` 下所有文档。如果该文档不在预期之内且不是 `lock.md`，则提示该文档为非法文档。同时诊断每一个文档的内容格式，存在问题的，罗列诊断记录。如果缺失文档，将罗列所有缺失的文档。`list` 还会检查 `file.md` 是否覆盖项目里的所有文件，`.coder` 自身及其内容除外；`.coder` 自身或它下面的路径出现在 `file.md` 中会报错。`data_structure.md` 会按 `##` 分段检查 `ts` 围栏和 `interface` 声明。`diagnosis/error.md` 和 `warn.md` 会检查诊断码前缀、4 位数字、作用范围、诊断方式、步骤格式和编号；文件通配形式的作用范围以及步骤里的文件通配必须至少命中一个项目文件。`plan/todo.md`、`todo-archived.md`、`goal.md` 和 `goal-archived.md` 会检查编码、字段顺序、编号、完成预期句式、当前进度和关联 ToDo，并检查同一个编码是否同时留在 active 与 archived。存在 `lock.md` 时，`list` 会校验它的声明、hash 格式和当前 hash；hash 不一致报 `lock.hash.mismatch`。

### 预期文档

| 文档 | 作用 |
| --- | --- |
| `.coder/design/file.md` | 目录与文件定义 |
| `.coder/design/architecture.md` | 多视角架构图 |
| `.coder/design/flow.md` | 主要场景流程 |
| `.coder/design/data_structure.md` | 关键数据结构 |
| `.coder/diagnosis/error.md` | E 开头的错误诊断码 |
| `.coder/diagnosis/warn.md` | W 开头的警告诊断码 |
| `.coder/plan/todo.md` | T 开头的进行中待办 |
| `.coder/plan/todo-archived.md` | T 开头的已归档待办 |
| `.coder/plan/goal.md` | G 开头的进行中目标 |
| `.coder/plan/goal-archived.md` | G 开头的已归档目标 |

`.coder/lock.md` 是唯一的非预期白名单文件，状态为 `lock`，不计入预期文档，也不渲染。预期文档集合是固化的，不接受配置。

### 格式约定

`list` 对文档格式的诊断是确定性的，规则如下。

#### file.md

- 每一项以一级或二级 ATX 标题开始：`# <相对路径>` 表示目录或独立文件，`## <相对路径>` 表示某个目录下的文件。
- 路径相对于项目根目录，使用 `/` 分隔；不能为空，不能以 `/` 开头，不能包含 `.` 或 `..` 路径段，不能以 `/` 结尾。
- 路径支持 `*`（段内任意字符）、`**`（跨段零层或多层）、`?`（段内一个字符）。
- `tmp/**` 同时表达目录 `tmp` 和它下面的文件，不需要再写 `tmp`。
- 除 `.coder` 及其内容外，项目里的每个文件必须至少被一个路径/通配匹配；未覆盖的文件报 `file.coverage.missing`。
- `.coder` 自身或它下面的路径不能出现在 file.md 中；出现报 `file.entry.coder`。
- 同一个路径只能出现一次。
- 每个标题后至少有一行非空说明。
- 说明只描述正向预期，不写「不要 / 禁止 / 不允许 / 不得 / 不能」之类的反向约束。
- 二级标题的父路径必须已经以一级标题出现过。

#### architecture.md

- 至少一个 `## 全局视角`，且必须是第一个视角；它的图必须包含 `subgraph`。
- 至少一个 `## 局部视角：<名称>`。
- 每个视角必须有非空说明，且恰好一张 Mermaid 图。
- 图必须以 `flowchart` 或 `graph` 开头，内容非空。

#### flow.md

- 每个主要场景使用 `## <场景名>`。
- 场景下至少有一个语言标记为 `mermaid` 的围栏代码块，且代码块内容非空。

#### data_structure.md

- 每个关键数据结构使用 `## <名称>` 分段。
- 每段至少有一个语言标记为 `ts`（或 `typescript`）的围栏代码块，且代码块内容非空。
- 每个 `ts` 围栏至少有一个 `interface <名称>` 声明；全篇的 interface 名称唯一。
- 只描述跨模块的关键结构；局部临时结构留在代码里。

#### diagnosis/error.md 与 warn.md

- 文档由一级标题的诊断码组成，例如 `# E0001`；`error.md` 只允许 `E\d{4}`，`warn.md` 只允许 `W\d{4}`。
- 同一份文档里诊断码不能重复。
- 每个诊断码必须有一个 `作用范围：全局` 或 `作用范围：<文件路径通配>`，且写在诊断方式和步骤之前。
- 每个诊断码必须有一个 `诊断方式：静态代码审查` 或 `诊断方式：运行时日志审查`，且写在步骤之前。
- 静态代码审查的步骤必须匹配：
  `步骤N：查看 [文件通配] 代码位置描述，如果 ...，则 ...，否则 ...`
- 运行时日志审查的步骤必须是以下两种之一：
  - `步骤N：在 [文件通配] 代码位置描述，插入日志：`，后面紧跟一个非空的 `ts`/`typescript` 代码围栏；
  - `步骤N：查看日志，如果 ...，则 ...，否则 ...`
- 步骤编号从 `步骤1` 开始连续递增；跳号或重号报 `diagnosis.step.number`。
- 步骤里的文件通配必须合法，并至少命中一个项目文件；否则报 `diagnosis.step.glob` 或 `diagnosis.step.no-match`。
- 插入日志缺少 `ts` 围栏报 `diagnosis.step.log-missing`；围栏语言不是 `ts`/`typescript` 报 `diagnosis.step.log-lang`；内容为空报 `diagnosis.step.log-empty`。
- 诊断文档只用 `#` 写诊断码；`##` 标题报 `diagnosis.heading.level`，其他正文行报 `diagnosis.body`。
- 第一个诊断码之前不能有正文。
- 作用范围、诊断方式和每个步骤之间空一行，Markdown 才会逐行显示。
- 步骤内容是自然语言，`list` 只检查格式、编号、通配命中和日志围栏，不执行步骤，也不判断步骤是否足够详细。

#### plan/todo.md、goal.md 与归档文档

- 文档由一级标题的编码组成，例如 `# T0001` / `# G0001`；todo 文档只允许 `T\d{4}`，goal 文档只允许 `G\d{4}`。
- 同一份文档里编码不能重复；同一个编码同时出现在 active 与 archived 文档时报 `plan.code.archived-duplicate`。
- 每个编码必须包含规定字段，字段顺序固定且不能重复：
  - todo：`任务范围`、`优先级`、`完成预期`、`当前进度`；
  - goal：`任务范围`、`完成预期`、`关联ToDo`。
- `任务范围` 必须是 `全局` 或合法的文件路径通配。
- `优先级` 必须是 `P1`、`P2` 或 `P3`。
- todo 的 `完成预期` 和 `当前进度` 至少各有一个条目；goal 的 `完成预期` 和 `关联ToDo` 至少各有一个条目；条目从 `1.` 开始连续编号。
- 完成预期必须匹配 `如果 ... 则 ...，否则 ...`；当前进度必须匹配 `[文件通配] 说明`。
- `关联ToDo` 至少有一个条目，每个条目是 `T` 加 4 位数字。
- 计划文档只用 `#` 写编码；`##` 标题报 `plan.heading.level`，其他正文行报 `plan.body`。
- 第一个编码之前不能有正文；编码之间可以空行。
- 空计划文档合法。
- 计划文档的字段之间空一行，Markdown 才会逐行显示。

#### lock.md

- 第一行必须与固定声明逐字一致，否则报 `lock.declaration`。
- 第二行必须是 `sha256:<64 位小写 hex>`，否则报 `lock.hash.invalid`。
- 第三行起必须有非空授权原文，否则报 `lock.authorization.missing`。
- 当前 `.coder` 重新计算的 hash 必须与第二行一致，否则报 `lock.hash.mismatch`。
- 文件不可读时报 `doc.unreadable`，hash 无法计算时报 `lock.hash.unreadable`。

### 输出

`list` 返回一份结构化结果，并在 `text` 中给出可直接阅读的汇总：

- `documents`：`.coder/` 下发现的全部文档，状态为 `expected`、`illegal`、`missing` 或 `lock`。
- `illegal` / `missing`：非法文档与缺失文档的路径清单；`lock.md` 不在其中。
- `lock`：`present`、`declarationValid`、`hash`、`hashMatches`、`currentHash`、`authorizationLength`；未上锁时为 `null`。
- `summary.locked`：是否存在 `lock.md`。
- `diagnostics`：每条诊断包含 `doc`、`line`（能定位时）、`rule` 与 `message`。
- `diagnoses`：两份诊断文档里解析出的诊断码，包含 `code`、`severity`、`scope`、`scopeKind`、`method`、`steps`、`matches`。
- `summary.codes`：解析出的诊断码数量。
- `plans`：四份计划文档里解析出的条目，包含 `code`、`kind`、`archived`、`scope`、`priority`、`expected`、`progress`、`todos`。
- `summary.plans`：解析出的计划条目数量。
- `ok`：没有非法文档、没有缺失文档、也没有任何诊断时为 `true`。

## render

`render` 把 `.coder/` 的十份预期文档渲染成一个 `design.html`。

- 默认输出目录：`dist/.coder/`；文件名固定 `design.html`。
- 调用参数 `out` 可以指定另一个输出目录。
- 页面内嵌十份文档；file.md 渲染为可折叠的树表格，目录行可展开/收起，层级用缩进引导线；architecture.md 和 flow.md 渲染为 Markdown 与 Mermaid 图，data_structure.md 渲染为 Markdown 与 TypeScript 代码块，diagnosis/error.md 与 warn.md 渲染为 Markdown 诊断码目录，plan 下的四份文档渲染为 Markdown 计划条目，左侧是目录。
- 页面不显示额外的状态或提示文案。
- 页面在服务端预置十份文档的源码；脚本不可用时保留源码作为正文，脚本可用时升级为树表格 / Markdown / Mermaid。
- Markdown 由 marked 渲染，Mermaid 图由 mermaid 渲染，两者从 jsDelivr 加载。
- CDN 不可用时保留源码正文与图表源码。
- 同样的文档得到同样的 HTML：不写时间戳，不读环境信息。

## lock

`lock` 写入 `.coder/lock.md`：

- 输入 `authorization` 是用户授权原文，必须非空；原样写入第三行起。
- 计算当前 `.coder` 的 hash（除 `lock.md`），写入第二行。
- 已经存在 `lock.md` 时失败，不覆盖原锁。
- 不提交 git。

## unlock

`unlock` 删除 `.coder/lock.md`：

- 输入 `authorization` 必须与 lock.md 中保存的原文逐字一致，否则失败。
- 不做 hash 拦截：hash 不一致时仍然解锁，并在结果中返回 `hashMatches:false`，提示自查。
- 没有 `lock.md` 时失败。
- 不提交 git。

## update

`update` 用 `tmp/` 下的源文件替换 `.coder/` 下的文档。

输入 `updates` 是非空数组，每项 `{ source, target }`：

- `source` 必须位于项目根目录的 `tmp/` 下，是普通文件，使用 `/` 分隔。
- 使用 git 的项目在 file.md 中用 `# .git/**` 覆盖 git 目录，用 `# tmp/**` 覆盖暂存目录，避免覆盖检查把这些文件报成未描述。
- `target` 是 `.coder/` 下的任意文件，例如 `.coder/design/flow.md`、`.coder/diagnosis/error.md` 或 `.coder/plan/todo.md`；`.coder/lock.md` 由工具维护，不能作为 target。
- `target` 可以已经存在，也可以缺失；缺失时创建它和必要的父目录。已存在时必须是普通文件。
- 同一目标只能出现一次。

### 未上锁

直接按源文件内容替换目标文件，返回 `locked:false` 和「未上锁、update 用于流程变更、不推荐」的提示。不提交 git，不生成 key。

### 已上锁

第一次调用（不带 `key`）：

- 检查 lock.md 的格式与 hash；不一致直接报错，提示自查直接修改。
- 校验 `updates` 和源文件，生成随机 `key`；key 只保存在当前插件进程内存中，一次性使用，插件重启后失效。
- 不修改任何文件。
- 返回 key、文件清单和流程计划，要求 dsh 起子代理审查 tmp 源文件，判断文档补充还是文档调整。

第二次调用（带 `key`、相同的 `updates`、`decision`、`review`）：

- `decision` 为 `supplement`（文档补充）或 `adjustment`（文档调整）。
- `branch` 是新建分支名，`adjustment` 时必填，且必须是不存在、合法的 git 分支名；`supplement` 不新建分支，不需要 `branch`。
- `review` 是本次更新的用户授权原文，必须非空；工具只能校验它存在，无法验证来源，锁的授权原文仍保存在 lock.md 第三行。
- 再次检查 lock hash，并核对 updates 的 source/target/源文件 hash 与第一次一致；任何变化直接报错。每一次 update 调用都会检查 hash。
- 替换目标文件，重新计算 lock hash 并写回 lock.md。
- `supplement`：在当前分支提交目标文件与 lock.md。
- `adjustment`：先把当前工作区提交为 checkpoint，按传入的 `branch` 新建分支，再替换、更新 hash 并提交。
- 不 push；不做复杂回滚，git 和 dsh 的 fs 沙盒是保底。
