coder 的设计目标是提供一系列确定性工具，驱动 dsh 实现符合需求的代码项目。主要方法是维护 `.coder/` 下的一系列结构化文档。

# DESIGN

设计文档在 `.coder/design/` 下，包括 `file.md`、`architecture.md`、`flow.md`、`data_structure.md`、`modules.md` 和可选的 `module-NNNN.md`；诊断文档在 `.coder/diagnosis/` 下，包括 `error.md` 和 `warn.md`；计划条目在 `.coder/plan/todo/`、`.coder/plan/todo/archived/`、`.coder/plan/goal/` 和 `.coder/plan/goal/archived/` 下，一项一个文件，文件名就是编码；问题文件在 `.coder/issues/open/` 与 `.coder/issues/close/` 下，一个问题一个 `issue-NNNN.md`，状态由所在文件夹决定；`.coder/manifest.json` 是可选的配置；成员文档在 `.coder/members/` 下，包括可选的 `all.md` 和 `flow.md`。

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

## design/modules.md 与 design/module-NNNN.md

模块文档是设计文档的枝干/叶子：`architecture.md` 是顶层设计，`modules.md` 是模块索引，`module-NNNN.md` 把复杂模块的架构、流程和数据结构拆出来。

`modules.md` 用 4 位编码组织，每个编码后面是模块说明：

```md
# 0001
文档检查：扫描 .coder 文档树并逐份诊断。
```

`module-NNNN.md` 复用设计文档的结构，把三类内容放在一级标题下：

````md
# 架构
## 全局视角
模块的全局结构。
```mermaid
flowchart TB
  subgraph 层
    A[扫描]
  end
```
## 局部视角：诊断
可选，模块需要时再写。
```mermaid
flowchart LR
  A --> B
```
# 流程
## 检查文档
```mermaid
flowchart TD
  A --> B
```
# 数据结构
## 模块条目
```ts
export interface ModuleEntry {
  code: string
}
```
# 子模块
## 0002
子模块说明。
````

- `modules.md` 是预期文档；空文件合法，表示还没有需要拆分的模块。
- `modules.md` 只用一级标题写 4 位模块编码；编码唯一，每个编码后面至少一行说明。
- 模块索引里的每个编码都要有 `design/module-NNNN.md`；存在的模块详情也必须出现在索引里。
- `module-NNNN.md` 必填 `# 架构`、`# 流程`、`# 数据结构`，可选 `# 子模块`；一级段落按这个顺序出现。
- `# 架构` 的 `## 全局视角` 必须有说明和一张带 `subgraph` 的 Mermaid 图；`## 局部视角：<名称>` 可选，写了就按 architecture.md 的规则检查。
- `# 流程` 和 `# 数据结构` 分别复用 flow.md、data_structure.md 的规则。
- `# 子模块` 用 `## 0002` 加说明表达；子模块编码必须指向存在的模块，不能引用自己，也不能重复。

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

## plan/todo/T####.md、plan/goal/G####.md 与 archived

计划条目一项一个文件，文件名就是编码：todo 放 `.coder/plan/todo/T0001.md`（进行中）和 `.coder/plan/todo/archived/T0001.md`（已归档）；goal 放 `.coder/plan/goal/G0001.md`（进行中）和 `.coder/plan/goal/archived/G0001.md`（已归档）。文件里只有一个编码标题，字段与编号条目跟在标题后面。

```md
# T0001

任务范围：src/**

优先级：P1

完成预期：

1. 如果计划文件缺少字段，则 list 报告 plan.* 诊断，否则通过。
2. 如果编号不连续，则 list 报错，否则通过。

当前进度：

1. [src/**] 解析与校验已实现。
```

```md
# G0001

任务范围：src/**

完成预期：

1. 如果计划文件无法由 list 机械校验，则视为未达成，否则通过。

关联ToDo：

1. T0001
```

- `plan/todo/` 与 `plan/todo/archived/` 只放 `T` 开头的编码，`plan/goal/` 与 `plan/goal/archived/` 只放 `G` 开头的编码；数字部分固定 4 位。
- 文件名决定编码与归档状态；文件里的 `# T0001` / `# G0001` 标题必须与文件名一致，否则报 `plan.file.code`。
- 计划条目文件是可选的：没有 `plan/` 目录或目录为空表示当前没有待办或归档记录，不报缺失。
- 任务完成后把条目移到 `archived/` 目录；同一个编码不能同时出现在 active 与 archived 目录，否则报 `plan.code.archived-duplicate`。
- `任务范围` 只能是 `全局`，或相对于项目根目录的文件路径通配；通配写法与 `file.md` 相同。
- todo 的字段顺序是 `任务范围 → 优先级 → 完成预期 → 当前进度`；goal 是 `任务范围 → 完成预期 → 关联ToDo`。
- `优先级` 只能是 `P1`、`P2` 或 `P3`。
- todo 的 `完成预期`、`当前进度` 和 goal 的 `完成预期`、`关联ToDo` 下面的条目从 `1.` 开始连续编号。
- 完成预期写成 `如果 ... 则 ...，否则 ...`；当前进度写成 `[文件路径通配] 说明`。
- `关联ToDo` 的条目是 `T` 加 4 位数字。
- 计划文件只用一个 `#` 标题写编码；字段和条目都写成普通行，第二个 `#` 标题报 `plan.code.multiple`。
- 空计划文件报 `plan.no-code`；计划文件必须从编码标题开始。
- `list` 检查文件名与编码、字段顺序与重复、编号、句式、进度里的文件通配和关联 ToDo 格式；任务是否真的完成、进度描述是否属实无法机械判断。
- 归档时用 `update` 写入 `archived/` 下的新文件，再用 `{ "target": "...", "delete": true }` 删除 active 文件。

## issues/open/issue-NNNN.md 与 issues/close/issue-NNNN.md

问题文件记录当前框架在实施过程中发现的问题：实现某个需求或运行某个工具时，框架本身暴露出的缺陷、缺口或需要调整的约定。它不是需求清单，也不是通用的用户工单；一条问题应当能指向实施过程中实际遇到的障碍。一个问题一个文件，状态由所在文件夹决定：开启的问题放 `issues/open/`，关闭的问题放 `issues/close/`。

开启的问题文件：

```md
# 问题
列表漏报了 flow.md 的格式问题。

# 复现
1. 把 flow.md 的 mermaid 代码块删掉。
2. 运行 list。

# 建议
补上 flow.scenario.no-diagram。

# 提交源
用户

# 当前进度
[src/**] 当前进度为 正在补检查。
```

关闭的问题文件用 `# 关闭原因` 代替 `# 当前进度`：

```md
# 问题
列表漏报了 flow.md 的格式问题。

# 提交源
用户

# 关闭原因
已补上检查并验证。
```

- 一个问题一个文件，文件名是 `issue-NNNN.md`，编码固定 4 位数字。
- 状态由文件夹决定：`issues/open/` 表示开启，`issues/close/` 表示关闭；文件里不写 `# 状态`，出现会报 `issue.status.removed`。
- 段落顺序固定为 `问题 → 复现 → 建议 → 提交源 → 当前进度 / 关闭原因`；`# 问题` 与 `# 提交源` 必填，`# 复现`、`# 建议` 可选，也接受 `# 复现（可选）`、`# 建议（可选）`。
- 开启的问题必须有一个 `# 当前进度` 段落，只写一行 `[文件路径通配] 当前进度为 ...`；通配必须合法并至少命中一个项目文件。
- 关闭的问题必须有一个 `# 关闭原因` 段落，至少一行非空原因，说明问题如何被解决或为什么不再处理。
- 每个存在的段落至少一行正文；第一个标题之前不能有正文；只用 `#` 写段落。
- 同一个编码不能同时出现在 `open/` 与 `close/`，否则报 `issue.status.conflict`。
- 两个目录都可以不存在：没有问题时 `list` 不报缺失；目录下不符合 `issue-NNNN.md` 命名的文件是非法文档。
- `create_issue` 用于在实施过程中登记问题，按两个文件夹里的最大编码加一创建问题文件。

## requirements/<状态>/requirement-NNNN.md

需求放在六个状态目录里，目录就是状态：

```md
.coder/requirements/登记/requirement-0001.md
.coder/requirements/接受-待开发/requirement-0001.md
.coder/requirements/开发中/requirement-0001.md
.coder/requirements/本版本已完成/requirement-0001.md
.coder/requirements/历史已完成/requirement-0001.md
.coder/requirements/丢弃/requirement-0001.md
```

一个需求一个文件，文件名是 `requirement-NNNN.md`，数字部分固定 4 位。还没结束的需求：

```md
# 需求
支持需求登记与状态流转。

# 背景
现在需求散落在对话里。

# 验收标准

1. 能在登记目录创建需求。
2. 能按文件夹区分状态。

# 提交源
用户

# 当前进度
[src/**] 当前进度为 已登记，等待处理。
```

本版本已完成与历史已完成的需求把 `# 当前进度` 换成 `# 完成说明`，丢弃的需求换成 `# 丢弃原因`：

```md
# 完成说明
已实现并验证。
```

- `# 需求`、`# 验收标准`、`# 提交源` 和结尾段落必填；`# 背景` 可选。
- 段落顺序固定为 `需求 → 背景 → 验收标准 → 提交源 → 当前进度 / 完成说明 / 丢弃原因`。
- 状态由目录决定，文件里写 `# 状态` 报 `requirement.status.removed`。
- `# 验收标准` 下面用 `1. ...` 连续编号，至少一条。
- 还没有结束的需求（登记、接受-待开发、开发中）在 `# 当前进度` 下只写一行 `[文件通配] 当前进度为 ...`。
- 六个目录都是可选的：没有需求文件不报缺失；同一个编码不能同时出现在两个状态目录里，否则报 `requirement.status.conflict`。
- 状态流转就是移动文件：用 `update` 在目标状态目录写入新文件，再删除旧目录里的文件，编号不变。
- `render` 不渲染需求。

`create_requirement` 在某个状态目录创建需求，默认 `登记/`；编号取六个目录里的最大值加一。

## logs/audit、logs/update、logs/usage 与 logs/research

日志记录项目运行过程中的四类事实，一个条目一个文件，目录决定类别：

```md
.coder/logs/audit/2026-11-28-001.md     审计日志
.coder/logs/update/2026-11-28-001.md    产品更新日志
.coder/logs/usage/2026-11-28-001.md     使用报告日志
.coder/logs/research/2026-11-28-001.md  竞品调研日志
```

审计日志记录一次审计的范围与结论：

```md
# 2026-11-28-001

审计范围：src/**

审计结论：格式与覆盖检查通过

说明：本轮没有发现遗漏。
```

产品更新日志记录一次产品发布，更新内容写成连续编号条目：

```md
# 2026-11-28-001

版本：0.1.0

更新内容：

1. 增加日志目录与检查。
2. 更新设计文档。
```

使用报告日志记录业务对产品实际使用的反馈：

```md
# 2026-11-28-001

使用场景：业务录入

使用反馈：字段太多，希望合并。

说明：下个版本评估。
```

竞品调研日志记录一次竞品调研的对象与结论：

```md
# 2026-11-28-001

竞品：同类产品甲

调研结论：字段更少，导入更快。

说明：可在下个版本参考。
```

- 文件名是 `YYYY-MM-DD-NNN.md`：日期必须真实存在，序号是三位数字；同一目录同一天的序号从 `001` 开始连续，缺号报 `log.sequence.gap`。
- 文件里只有一个一级标题，写成 `# YYYY-MM-DD-NNN` 并与文件名一致；标题缺失、格式不符、出现额外标题或标题前有正文都会报错。
- 字段写成普通行 `字段：值`，顺序固定且不能重复：
  - 审计日志：`审计范围`、`审计结论`，可选 `说明`；
  - 产品更新日志：`版本`、`更新内容`，可选 `说明`；
  - 使用报告日志：`使用场景`、`使用反馈`，可选 `说明`；
  - 竞品调研日志：`竞品`、`调研结论`，可选 `说明`。
- 必填字段不能为空；`更新内容` 的值必须写成后续的 `N. ...` 条目，从 `1.` 开始连续，至少一条。
- 四类日志都是可选的：没有日志文件不报缺失；`logs/` 下不符合命名规则的文件是非法文档。
- `render` 不渲染日志。

## manifest.json

`.coder/manifest.json` 是可选配置，空文件等同默认值。目前只支持一个键：

```json
{ "largeCodeFileBytes": 20480 }
```

- `largeCodeFileBytes` 是正整数，单位字节，默认 `20480`（20KB）；源码文件超过该值时 `list` 给出拆分提示。
- JSON 不合法、顶层不是对象、出现未知键或值不是正整数时分别报 `manifest.invalid`、`manifest.unknown`、`manifest.value`。
- 配置只影响 `list` 的大文件提示，不改变文档检查规则；`render` 不渲染 manifest.json。

## members/all.md 与 members/flow.md

成员文档记录主对话与成员的身份、工作范围，以及他们之间的工作流程。两个文件都是可选的：`list` 只在文件存在时检查内容格式，文件不存在不报缺失。

成员名册 `all.md` 用一级标题分节：

```md
# 主对话
身份：开发
工作范围：插件设计与实现

# 成员1
工作区名称：coder
身份：验证
工作范围：部署后的只读验证
备注：Linux 成员，SSH 用户 root
```

- `# 主对话` 必须存在，且是第一个一级标题；只能出现一次。
- 其余一级标题写成 `# 成员N`，N 是正整数（从 1 开始，不接受前导零），同一份文档里成员编号不能重复。
- 成员可以为零：只有 `# 主对话`、没有任何 `# 成员N` 也是合法状态。
- `# 主对话` 必填 `身份` 和 `工作范围`；`# 成员N` 必填 `工作区名称`、`身份` 和 `工作范围`。
- `# 成员N` 还可以写一个可选的 `备注`，用来记录部署方式、SSH 用户等补充信息；出现时必须写在 `工作范围` 之后。`# 主对话` 不接受 `备注`。
- 字段写在节的正文里，每行一个 `字段：值`；顺序固定，值不能为空，同一节里的字段不能重复。
- 一节的正文只放这些字段行；空行可以忽略，其他正文行报错。
- 第一个一级标题之前不能有正文。

成员流程 `flow.md` 沿用 `design/flow.md` 的规则：用 `## <场景>` 分段，每个场景至少一段说明和一张非空的 `mermaid` 图。它讲解主对话如何分派任务、等待成员、部署验证，以及如何维护成员身份、工作范围与备注。

## lock.md

`.coder/lock.md` 是锁状态文件，不是预期文档，`render` 不渲染它。

- 第一行是固定声明：`.coder 被上锁，禁止直接修改文件，修改必须走 update。`
- 第二行是 `sha256:<hex>`：递归遍历 `.coder/` 下除 `lock.md` 外的所有文件，按相对路径排序，逐个计算内容 sha256，把 hex 直接拼接后再计算 sha256。
- 第三行起是 lock 时传入的用户授权原文，逐字保存。
- 锁是软约束：不拦截文件系统或 bash 写入；`list` 和 `update` 通过 hash 发现直接修改。
- `unlock` 会删除 lock.md；删除后可以自由修改 `.coder`，直到再次 lock。

# 工具

## list

dsh 调用 `list` 时，将会罗列 `.coder/` 下所有文档。`lock.md` 状态为 `lock`；`issues/open/issue-NNNN.md`、`issues/close/issue-NNNN.md`、`design/module-NNNN.md`、`members/all.md`、`members/flow.md`、`manifest.json` 与计划条目文件是可选文档，存在时检查内容格式，不存在不报缺失；其余不在预期集合、也不在可选白名单里的文档提示为非法文档。同时诊断每一个文档的内容格式，存在问题的，罗列诊断记录。如果缺失预期文档，将罗列所有缺失的文档。`list` 还会检查 `file.md` 是否覆盖项目里的所有文件，`.coder` 自身及其内容除外；`.coder` 自身或它下面的路径出现在 `file.md` 中会报错。`architecture.md`、`flow.md`、`data_structure.md` 和 `modules.md` 按各自的格式约定检查，`module-NNNN.md` 复用前三者的规则并检查子模块引用。`diagnosis/error.md` 和 `warn.md` 会检查诊断码前缀、4 位数字、作用范围、诊断方式、步骤格式和编号；文件通配形式的作用范围以及步骤里的文件通配必须至少命中一个项目文件。`plan/todo/T####.md`、`plan/todo/archived/T####.md`、`plan/goal/G####.md` 和 `plan/goal/archived/G####.md` 会检查文件名与标题编码、字段顺序、编号、完成预期句式、当前进度和关联 ToDo，并检查同一个编码是否同时留在 active 与 archived。问题文件会检查文件名编码、段落顺序、当前进度和关闭原因，并检查同一个编码是否同时出现在 open/ 与 close/。需求文件会检查所在状态目录、段落顺序、验收标准编号、当前进度或完成说明/丢弃原因，并检查同一个编码是否同时出现在两个状态目录。日志文件会检查文件名里的日期与三位序号、同一天序号是否连续、标题是否与文件名一致、字段顺序与必填，以及更新内容是否为连续编号条目。成员文档会检查 `all.md` 的主对话、`# 成员N` 编号与字段（含成员的备注），以及 `flow.md` 的场景和 Mermaid 图。存在 `lock.md` 时，`list` 会校验它的声明、hash 格式和当前 hash；hash 不一致报 `lock.hash.mismatch`。反向校验 file.md 的引用：具体路径不存在报 `file.path.missing`，通配零命中只写入 `hints`（`kind: 'unused-glob'`）。大代码文件也不进入 diagnostics：超过 `manifest.json` 阈值（默认 20KB）的源码文件写入 `hints`（`kind: 'large-code'`）和 text 的「提示：」段，`ok` 不受影响。text 只打印各类数量，不罗列全部文档路径，只额外列出非法与缺失文档的路径；结构化结果仍包含完整的 `documents`、`plans`、`issues`、`requirements` 与 `logs`。

### 预期文档

| 文档 | 作用 |
| --- | --- |
| `.coder/design/file.md` | 目录与文件定义 |
| `.coder/design/architecture.md` | 多视角架构图 |
| `.coder/design/flow.md` | 主要场景流程 |
| `.coder/design/data_structure.md` | 关键数据结构 |
| `.coder/design/modules.md` | 模块索引 |
| `.coder/diagnosis/error.md` | E 开头的错误诊断码 |
| `.coder/diagnosis/warn.md` | W 开头的警告诊断码 |

`.coder/lock.md` 状态为 `lock`，不计入预期文档，也不渲染。计划条目文件不是预期文档：`.coder/plan/todo/T####.md`、`.coder/plan/todo/archived/T####.md`、`.coder/plan/goal/G####.md` 和 `.coder/plan/goal/archived/G####.md` 属于可选白名单，存在时检查、不存在不报缺失；`plan/` 下不符合这些路径形式的文件是非法文档。`.coder/issues/open/issue-NNNN.md`、`.coder/issues/close/issue-NNNN.md`、`.coder/requirements/登记/requirement-NNNN.md`、`.coder/requirements/接受-待开发/requirement-NNNN.md`、`.coder/requirements/开发中/requirement-NNNN.md`、`.coder/requirements/本版本已完成/requirement-NNNN.md`、`.coder/requirements/历史已完成/requirement-NNNN.md`、`.coder/requirements/丢弃/requirement-NNNN.md`、`.coder/logs/audit/YYYY-MM-DD-NNN.md`、`.coder/logs/update/YYYY-MM-DD-NNN.md`、`.coder/logs/usage/YYYY-MM-DD-NNN.md`、`.coder/logs/research/YYYY-MM-DD-NNN.md`、`.coder/design/module-NNNN.md`、`.coder/members/all.md`、`.coder/members/flow.md` 和 `.coder/manifest.json` 是可选白名单：存在时检查内容格式，不存在不报缺失。预期文档集合是固化的，不接受配置。

### 格式约定

`list` 对文档格式的诊断是确定性的，规则如下。

#### file.md

- 每一项以一级或二级 ATX 标题开始：`# <相对路径>` 表示目录或独立文件，`## <相对路径>` 表示某个目录下的文件。
- 路径相对于项目根目录，使用 `/` 分隔；不能为空，不能以 `/` 开头，不能包含 `.` 或 `..` 路径段，不能以 `/` 结尾。
- 路径支持 `*`（段内任意字符）、`**`（跨段零层或多层）、`?`（段内一个字符）。
- `tmp/**` 同时表达目录 `tmp` 和它下面的文件，不需要再写 `tmp`。
- 除 `.coder` 及其内容外，项目里的每个文件必须至少被一个路径/通配匹配；未覆盖的文件报 `file.coverage.missing`。
- 反向也要成立：不含 `*` / `?` 的具体路径必须真实存在，否则报 `file.path.missing`；存在即可，不区分目录和文件。
- 通配路径（含 `*` / `?` / `**`）零命中项目文件时不报错，只写入 `hints` 与「提示：」段（`kind: 'unused-glob'`），因为 `tmp/**` 这类目录可能还没创建。
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

#### design/modules.md 与 design/module-NNNN.md

- `modules.md` 可以留空；非空时只用一级标题写 `\d{4}` 模块编码，编码唯一、不能有正文前导。
- 每个模块编码后面至少有一行说明；`##` 及其他标题级别报 `modules.heading.level`。
- `modules.md` 里登记的每个编码都要有 `design/module-NNNN.md`，否则报 `module.file.missing`。
- 存在的 `design/module-NNNN.md` 必须出现在 `modules.md` 里，否则报 `module.index.missing`。
- `module-NNNN.md` 的一级段落依次是 `# 架构`、`# 流程`、`# 数据结构`，`# 子模块` 可选；必填段落缺失、重复、未知或顺序错误都会报 `module.section.*`。
- `# 架构` 至少有一个 `## 全局视角`，必须有说明和一张以 `flowchart`/`graph` 开头、包含 `subgraph` 的 Mermaid 图；`## 局部视角：<名称>` 可选，写了就按 architecture.md 的规则检查。
- `# 流程` 按 flow.md 的规则检查：每个 `## <场景>` 至少一张非空 Mermaid 图。
- `# 数据结构` 按 data_structure.md 的规则检查：每个 `## <名称>` 至少一个非空 `ts` 围栏，并含 `interface`。
- `# 子模块` 用 `## NNNN` 加说明表达；编码必须是 4 位数字、不能引用自己、不能重复，且必须指向存在的模块文件，否则报 `module.submodule.*`。

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

#### plan/todo/T####.md、plan/goal/G####.md 与 archived

- 每个文件一个条目，文件名是 `T####.md` 或 `G####.md`；todo 目录只允许 `T\d{4}.md`，goal 目录只允许 `G\d{4}.md`，数字部分固定 4 位。
- 文件里只有一个一级标题 `# T0001` / `# G0001`，且必须与文件名一致；文件名与标题不一致报 `plan.file.code`。
- 同一份文件里出现第二个一级标题报 `plan.code.multiple`；`##` 标题报 `plan.heading.level`，其他正文行报 `plan.body`。
- 第一个编码标题之前不能有正文；空文件报 `plan.no-code`。
- 每个文件必须包含规定字段，字段顺序固定且不能重复：
  - todo：`任务范围`、`优先级`、`完成预期`、`当前进度`；
  - goal：`任务范围`、`完成预期`、`关联ToDo`。
- `任务范围` 必须是 `全局` 或合法的文件路径通配。
- `优先级` 必须是 `P1`、`P2` 或 `P3`。
- todo 的 `完成预期` 和 `当前进度` 至少各有一个条目；goal 的 `完成预期` 和 `关联ToDo` 至少各有一个条目；条目从 `1.` 开始连续编号。
- 完成预期必须匹配 `如果 ... 则 ...，否则 ...`；当前进度必须匹配 `[文件通配] 说明`。
- `关联ToDo` 至少有一个条目，每个条目是 `T` 加 4 位数字。
- 字段之间空一行，Markdown 才会逐行显示。
- 没有计划文件时不报缺失；`plan/` 目录下不符合命名规则的文件是非法文档。

#### issues/open/issue-NNNN.md 与 issues/close/issue-NNNN.md

- 一个问题一个文件，文件名是 `issue-\d{4}.md`，数字部分固定 4 位；`issues/open/` 与 `issues/close/` 之外的问题文件不在白名单里。
- 状态由文件夹决定；文件里写 `# 状态` 报 `issue.status.removed`。
- 开启的问题只允许 `问题 / 复现 / 建议 / 提交源 / 当前进度`，关闭的问题只允许 `问题 / 复现 / 建议 / 提交源 / 关闭原因`，顺序固定；其他段落报 `issue.section.unknown`，重复报 `issue.section.duplicate`，顺序错误报 `issue.section.order`。
- `# 问题`、`# 提交源` 和最后一个段落（`# 当前进度` 或 `# 关闭原因`）必填，缺少报 `issue.section.missing`；`# 复现`、`# 建议` 可省略。
- 每个存在的段落至少一行非空正文，否则报 `issue.section.empty`；只用 `#` 写段落，`##` 等标题报 `issue.heading.level`。
- 开启问题的 `# 当前进度` 只写一行 `[文件通配] 当前进度为 ...`：格式错误报 `issue.progress.format`，多行报 `issue.progress.lines`，通配非法报 `issue.progress.glob`，通配没有命中项目文件报 `issue.progress.no-match`。
- 关闭问题的 `# 关闭原因` 至少一行非空正文；空段落报 `issue.section.empty`。
- 第一个标题之前不能有正文，否则报 `issue.preamble`；空文件报 `issue.empty`。
- 同一个编码同时出现在 `open/` 与 `close/` 报 `issue.status.conflict`。

#### requirements/登记/requirement-NNNN.md 等六个状态目录

- 一个需求一个文件，文件名是 `requirement-\d{4}.md`，数字部分固定 4 位；只有 `requirements/登记/`、`requirements/接受-待开发/`、`requirements/开发中/`、`requirements/本版本已完成/`、`requirements/历史已完成/`、`requirements/丢弃/` 六个目录在白名单里，其他目录或文件名是非法文档。
- 状态由目录决定；文件里写 `# 状态` 报 `requirement.status.removed`。
- 允许的段落与顺序：
  - 登记 / 接受-待开发 / 开发中：`需求 / 背景 / 验收标准 / 提交源 / 当前进度`；
  - 本版本已完成 / 历史已完成：`需求 / 背景 / 验收标准 / 提交源 / 完成说明`；
  - 丢弃：`需求 / 背景 / 验收标准 / 提交源 / 丢弃原因`。
- `# 需求`、`# 验收标准`、`# 提交源` 和结尾段落必填，缺少报 `requirement.section.missing`；`# 背景` 可省略，也可以写成 `# 背景（可选）`。
- 未知段落报 `requirement.section.unknown`，重复报 `requirement.section.duplicate`，顺序错误报 `requirement.section.order`，空段落报 `requirement.section.empty`；`##` 等标题报 `requirement.heading.level`。
- `# 验收标准` 只接受 `N. 内容` 编号条目，从 `1.` 开始连续；格式错误报 `requirement.criteria.format`，跳号报 `requirement.criteria.number`，一条都没有报 `requirement.criteria.empty`。
- 还没结束的需求，`# 当前进度` 只写一行 `[文件通配] 当前进度为 ...`：格式错误报 `requirement.progress.format`，多行报 `requirement.progress.lines`，通配非法报 `requirement.progress.glob`，通配没有命中项目文件报 `requirement.progress.no-match`。
- `# 完成说明` 与 `# 丢弃原因` 至少一行非空正文，空段落报 `requirement.section.empty`。
- 第一个标题之前不能有正文，否则报 `requirement.preamble`；空文件报 `requirement.empty`。
- 同一个编码同时出现在两个状态目录报 `requirement.status.conflict`。

#### logs/audit/YYYY-MM-DD-NNN.md、logs/update/YYYY-MM-DD-NNN.md、logs/usage/YYYY-MM-DD-NNN.md 与 logs/research/YYYY-MM-DD-NNN.md

- 一个条目一个文件，文件名是 `YYYY-MM-DD-NNN.md`，日期必须是真实存在的日历日期，序号固定三位数字；`logs/`、`logs/audit/`、`logs/update/`、`logs/usage/`、`logs/research/` 之外的文件不在白名单里。
- 同一目录同一天的序号必须从 `001` 开始连续；缺号报 `log.sequence.gap`，`000` 报 `log.file.sequence`。
- 文件里只有一个一级标题，写成 `# YYYY-MM-DD-NNN` 并与文件名一致；没有标题报 `log.title.missing`，不一致报 `log.title.format`，额外标题报 `log.heading.extra`。
- 第一个标题之前不能有正文，否则报 `log.preamble`；空文件报 `log.empty`。
- 字段顺序固定且不能重复：
  - 审计日志：`审计范围`、`审计结论`，可选 `说明`；
  - 产品更新日志：`版本`、`更新内容`，可选 `说明`；
  - 使用报告日志：`使用场景`、`使用反馈`，可选 `说明`；
  - 竞品调研日志：`竞品`、`调研结论`，可选 `说明`。
- 必填字段缺失报 `log.field.missing`，顺序错误报 `log.field.order`，重复报 `log.field.multiple`，未知字段报 `log.field.unexpected`，值为空报 `log.field.empty`。
- `更新内容` 的值必须写成后续的 `N. ...` 条目，不能写在同一行（否则报 `log.field.inline`）；条目至少一条（否则报 `log.item.missing`），从 `1.` 开始连续（否则报 `log.item.number`），条目内容不能为空（否则报 `log.item.empty`）。
- 正文只允许字段行和编号条目，其他行报 `log.body`。
- 日志之间按类别与日期独立编号，不同类别、不同日期的序号互不影响。

#### manifest.json

- 文件可选；不存在或为空时使用默认配置。
- 内容必须是 JSON 对象；解析失败或顶层不是对象报 `manifest.invalid`。
- 只允许 `largeCodeFileBytes` 一个键，其他键报 `manifest.unknown`。
- `largeCodeFileBytes` 必须是正整数（字节），否则报 `manifest.value`。

#### members/all.md 与 members/flow.md

- 两个文件都是可选的；文件不存在时不报缺失，存在时按下面的规则检查。
- `all.md` 只用一级标题分节；`# 主对话` 必须存在、只能出现一次，而且是第一个一级标题，否则报 `members.main.missing`、`members.main.duplicate` 或 `members.main.order`。
- 其余一级标题必须是 `# 成员N`，N 是正整数且不接受前导零；编号重复报 `members.member.duplicate`，写成 `# 成员` 等非法形式报 `members.member.format`，其他标题报 `members.section.unknown`。
- `# 主对话` 必填 `身份`、`工作范围`；`# 成员N` 必填 `工作区名称`、`身份`、`工作范围`，可选 `备注`。`备注` 只用于成员，出现时必须写在最后；主对话写 `备注` 报 `members.field.unexpected`。字段顺序固定，值不能为空；缺字段、空值、重复字段、顺序错误或出现不支持的字段分别报 `members.field.missing`、`members.field.empty`、`members.field.duplicate`、`members.field.order`、`members.field.unexpected`。
- 每节正文每行一个 `字段：值`，空行忽略；其他正文行报 `members.body`。`##` 及其他标题级别报 `members.heading.level`。
- 第一个一级标题之前不能有正文，否则报 `members.preamble`。
- `flow.md` 按 `design/flow.md` 的规则检查：每个 `## <场景>` 至少一段说明和一张非空的 `mermaid` 图；缺少场景、场景为空、缺少图或图为空分别报 `flow.no-scenario`、`flow.scenario.empty`、`flow.scenario.no-diagram`、`flow.diagram.empty`。

#### lock.md

- 第一行必须与固定声明逐字一致，否则报 `lock.declaration`。
- 第二行必须是 `sha256:<64 位小写 hex>`，否则报 `lock.hash.invalid`。
- 第三行起必须有非空授权原文，否则报 `lock.authorization.missing`。
- 当前 `.coder` 重新计算的 hash 必须与第二行一致，否则报 `lock.hash.mismatch`。
- 文件不可读时报 `doc.unreadable`，hash 无法计算时报 `lock.hash.unreadable`。

### 输出

`list` 返回一份结构化结果，并在 `text` 中给出可直接阅读的汇总：

- `documents`：`.coder/` 下发现的全部文档，状态为 `expected`、`optional`、`illegal`、`missing` 或 `lock`。
- `illegal` / `missing`：非法文档与缺失文档的路径清单；`lock.md` 不在其中，可选的模块详情、问题文档与成员文档也不计入缺失。
- `lock`：`present`、`declarationValid`、`hash`、`hashMatches`、`currentHash`、`authorizationLength`；未上锁时为 `null`。
- `summary.locked`：是否存在 `lock.md`。
- `modules`：`modules.md` 里解析出的模块索引，包含 `code`、`line`、`description`。
- `moduleDocs`：存在的模块详情，包含 `code`、`path`、`submodules`。
- `issues`：`open`、`close` 两组问题文件，`all` 是两组的汇总（`code`、`path`、`status`）。
- `requirements`：`registered`、`accepted`、`developing`、`current`、`history`、`discarded` 六组需求条目，`all` 是六组的汇总（`code`、`status`、`criteria`）。
- `logs`：`audit`、`update`、`usage`、`research` 四组日志条目，`all` 是四组的汇总（`kind`、`date`、`sequence`）。
- `summary.modules` / `summary.moduleFiles` / `summary.issues` / `summary.openIssues` / `summary.closedIssues` / `summary.logs` / `summary.auditLogs` / `summary.updateLogs` / `summary.usageLogs` / `summary.researchLogs` / `summary.requirements` / `summary.registeredRequirements` / `summary.acceptedRequirements` / `summary.developingRequirements` / `summary.currentRequirements` / `summary.historyRequirements` / `summary.discardedRequirements`：模块、模块详情、问题、日志与需求数量。
- `summary.optional`：存在的可选文档数量。
- `text`：只打印各类数量，不罗列全部文档路径；非法与缺失文档的路径单独列出。
- `diagnostics`：每条诊断包含 `doc`、`line`（能定位时）、`rule` 与 `message`。
- `diagnoses`：两份诊断文档里解析出的诊断码，包含 `code`、`severity`、`scope`、`scopeKind`、`method`、`steps`、`matches`。
- `summary.codes`：解析出的诊断码数量。
- `plans`：计划条目文件里解析出的条目，包含 `code`、`kind`、`archived`、`scope`、`priority`、`expected`、`progress`、`todos`。
- `summary.plans`：解析出的计划条目数量。
- `hints`：提示列表，`kind: 'large-code'` 含 `path`、`bytes`、`threshold`，`kind: 'unused-glob'` 含 `doc`、`line`、`path`；`summary.hints` 是提示数量，不影响 `ok`。
- `manifest`：生效的配置，包含 `largeCodeFileBytes`。
- `ok`：没有非法文档、没有缺失文档、也没有任何诊断时为 `true`。

## render

`render` 把 `.coder/` 的七份预期文档、存在的模块详情和存在的成员文档渲染成一个 `design.html`；计划条目、问题文件、需求文件与日志文件不渲染。

- 默认输出目录：`dist/.coder/`；文件名固定 `design.html`。
- 调用参数 `out` 可以指定另一个输出目录。
- 页面内嵌七份预期文档、`design/module-NNNN.md` 和存在的 `members/all.md` / `members/flow.md`；file.md 渲染为可折叠的树表格，目录行可展开/收起，层级用缩进引导线；architecture.md 和 flow.md 渲染为 Markdown 与 Mermaid 图，data_structure.md 渲染为 Markdown 与 TypeScript 代码块，modules.md 与模块详情渲染为 Markdown，成员文档渲染为 Markdown，diagnosis/error.md 与 warn.md 渲染为 Markdown 诊断码目录，左侧是目录。
- 问题文件、计划条目文件、需求文件与日志文件不进入渲染页面；成员文档存在时进入页面，不存在时页面不显示空区块。
- 页面不显示额外的状态或提示文案。
- 页面在服务端预置全部被渲染文档的源码；脚本不可用时保留源码作为正文，脚本可用时升级为树表格 / Markdown / Mermaid。
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

`update` 用 `tmp/` 下的源文件替换 `.coder/` 下的文档，或删除 `.coder/` 下不再需要的文档。

输入 `updates` 是非空数组，每项 `{ source, target }` 或 `{ target, delete: true }`：

- `source` 必须位于项目根目录的 `tmp/` 下，是普通文件，使用 `/` 分隔；`delete: true` 的项不需要 `source`。
- 使用 git 的项目在 file.md 中用 `# .git/**` 覆盖 git 目录，用 `# tmp/**` 覆盖暂存目录，避免覆盖检查把这些文件报成未描述。
- `target` 是 `.coder/` 下的任意文件，例如 `.coder/design/flow.md`、`.coder/diagnosis/error.md` 或 `.coder/plan/todo/T0001.md`；`.coder/lock.md` 由工具维护，不能作为 target。
- 替换项的 `target` 可以已经存在，也可以缺失；缺失时创建它和必要的父目录。已存在时必须是普通文件。
- 删除项的 `target` 必须已经存在且是普通文件；删除后父目录保留。
- 同一目标只能出现一次。

### 未上锁

直接按源文件内容替换目标文件、删除删除项的目标文件，返回 `locked:false` 和「未上锁、update 用于流程变更、不推荐」的提示。不提交 git，不生成 key。

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
- 替换或删除目标文件，重新计算 lock hash 并写回 lock.md。
- `supplement`：在当前分支提交目标文件（含删除）与 lock.md。
- `adjustment`：先把当前工作区提交为 checkpoint，按传入的 `branch` 新建分支，再替换、删除、更新 hash 并提交。
- 不 push；不做复杂回滚，git 和 dsh 的 fs 沙盒是保底。

## create_issue

`create_issue` 在实施过程中登记当前框架发现的问题。

输入：

- `problem`（必填）：`# 问题` 的正文。
- `source`（必填）：`# 提交源`，记录发现问题的工具、文档或实施步骤。
- `status`：`开启` 或 `关闭`，默认 `开启`。
- `reproduce` / `suggestion`（可选）：写入 `# 复现` / `# 建议`。
- `scope`（可选）：开启问题的 `# 当前进度` 行里的文件路径通配，默认 `**`。
- `progress`（可选）：开启问题的进度说明，默认「已登记，等待处理。」。
- `closeReason`（可选）：关闭问题的 `# 关闭原因`，默认「已关闭。」。

行为：

- 扫描 `.coder/issues/open/` 与 `.coder/issues/close/` 下的 `issue-NNNN.md`，取已用编码最大值加一，从 `0001` 开始；编码固定 4 位。
- `开启` 写 `.coder/issues/open/issue-NNNN.md`，`关闭` 写 `.coder/issues/close/issue-NNNN.md`；文件按固定段落生成，状态不进文件。
- 生成的内容先自检，自检不过不落盘。
- `.coder` 已上锁时拒绝写入：问题文件要么先 unlock，要么经 update 流程提交。
- 不提交 git。

## create_requirement

`create_requirement` 登记一个新需求，默认写入 `登记/`。

输入：

- `requirement`（必填）：`# 需求` 的正文。
- `source`（必填）：`# 提交源`，单行。
- `status`（可选）：`登记`、`接受-待开发`、`开发中`、`本版本已完成`、`历史已完成`、`丢弃` 之一，默认 `登记`。
- `background`（可选）：`# 背景`。
- `acceptance`（必填）：验收标准数组，至少一条，写入 `# 验收标准` 的连续编号条目。
- `scope`（可选）：还没结束的需求的当前进度文件通配，默认 `**`。
- `progress`（可选）：当前进度说明，默认按状态取「已登记，等待处理。」「已接受，等待开发。」「正在开发。」。
- `completion`（可选）：`# 完成说明`，默认「已完成。」，只用于本版本已完成与历史已完成。
- `discardReason`（可选）：`# 丢弃原因`，默认「已丢弃。」，只用于丢弃。

行为：

- 扫描六个状态目录下的 `requirement-NNNN.md`，取已用编码最大值加一，从 `0001` 开始；编码固定 4 位。
- 按状态生成固定的结尾段落；状态不进文件。
- 生成的内容先自检，自检不过不落盘。
- `.coder` 已上锁时拒绝写入：需求文件要么先 unlock，要么经 update 流程提交。
- 不提交 git。
