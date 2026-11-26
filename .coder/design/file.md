# index.js
插件入口：导出 name、inject 与 apply，注册 `list`、`render`、`lock`、`unlock`、`update`、`create_issue` 工具。
# package.json
包清单：声明 coder bundle、导出文件与测试脚本。
# cordis.patch.yml
bundle 补丁：插入 id 为 coder 的 Host 插件行。
# README.md
插件说明：检查目标、使用方式与固化约定。
# icon.svg
插件图标：文档与勾选标记。
# src
源码目录。
## src/docs.js
文档扫描与格式诊断：扫描 .coder/ 文档树，比对预期文档与可选文档，执行设计、诊断、计划、模块、问题与成员文档的确定性检查，并汇总条目与交叉引用。
## src/glob.js
通配匹配：支持 *、**、? 的路径匹配与文件覆盖检查。
## src/markdown.js
Markdown 结构扫描：提取标题、围栏、行号和未闭合围栏。
## src/design.js
设计文档结构检查：architecture.md、flow.md 与 data_structure.md 的视角、场景与 ts interface 规则，供模块详情复用。
## src/diagnosis.js
诊断文档：解析 error.md / warn.md，校验诊断码、作用范围、诊断方式、步骤格式与编号，并检查文件通配命中。
## src/scope.js
作用范围：全局与文件路径通配的合法性校验，以及通配命中。
## src/plan.js
计划条目：解析 plan/todo 与 plan/goal 下的 T####/G#### 单条目文件（含 archived），校验文件名与标题编码、字段顺序、编号、完成预期、当前进度与关联 ToDo。
## src/module.js
模块文档：解析 modules.md 与可选的 module-NNNN.md，校验模块编码、说明、架构/流程/数据结构分段与子模块引用。
## src/issue.js
问题文件：解析 issues/open 与 issues/close 下的 issue-NNNN.md，校验段落顺序、当前进度与关闭原因；状态由所在文件夹决定。
## src/member.js
成员文档：解析可选的 members/all.md 与 members/flow.md，校验主对话、成员编号、身份/工作范围/工作区名称字段与可选的成员备注，以及成员流程的场景与 Mermaid 图。
## src/lock.js
锁文件：lock.md 的格式解析、.coder hash 计算与读写。
## src/git.js
update 的 git 操作：提交指定文件、checkpoint 与新建分支。
## src/render.js
HTML 渲染：把七份预期文档、存在的计划条目、存在的模块详情和存在的成员文档写成单页 design.html。
# src/tools
工具定义目录。
## src/tools/list.js
`list` 工具：读取项目根目录、调用检查器、输出结构化报告与可读汇总。
## src/tools/lock.js
`lock` / `unlock` 工具：写入或删除 lock.md，处理授权原文。
## src/tools/render.js
`render` 工具：默认把 HTML 写到 dist/.coder/design.html。
## src/tools/root.js
所有工具共用的项目根目录解析。
## src/tools/update.js
`update` 工具：校验 tmp 源与 .coder 目标、上锁时分两步、替换或删除并更新 hash，按 decision 提交。
## src/tools/create-issue.js
`create_issue` 工具：按最大编码加一在 issues/open 或 issues/close 下创建问题文件。
# tests
测试目录。
## tests/docs.test.js
覆盖扫描、缺失、非法、文件覆盖与七份文档及计划条目的格式诊断。
## tests/diagnosis.test.js
覆盖诊断码格式、前缀、作用范围、通配命中、诊断方式与步骤格式。
## tests/plan.test.js
覆盖计划文件名与编码、字段、编号、完成预期、当前进度、关联 ToDo 与归档一致性。
## tests/module.test.js
覆盖模块索引、模块详情、子模块引用、索引交叉检查与渲染收录。
## tests/issue.test.js
覆盖问题文件段落、open/close 文件夹状态、当前进度与关闭原因，以及 create_issue 的编号和写入规则。
## tests/member.test.js
覆盖成员名册的主对话、成员编号、字段与可选备注，成员流程的场景与 Mermaid 图，以及 list/render 对成员文档的收录。
## tests/fixtures.js
多份测试共用的合法文档样本。
## tests/glob.test.js
覆盖 *、**、? 与 tmp/** 的匹配行为。
## tests/plugin.test.js
覆盖插件装配、工具注册与工具端到端调用。
## tests/lock.test.js
覆盖 lock/unlock、lock.md 格式、hash 比对与 list 诊断。
## tests/render.test.js
覆盖 HTML 生成、默认输出路径、缺失文档与确定性。
## tests/update.test.js
覆盖未上锁替换、上锁两步、key/review、补充提交、调整分支与 hash 校验。
# docs
插件设计文档目录。
## docs/design.md
coder 的设计说明：文档约定、list/render 行为与格式规则。
# locale
显示文案目录。
## locale/en.json
英文标题与描述。
## locale/zh.json
中文标题与描述。
# dist/**
渲染输出目录及生成文件。
# tmp/**
update 的源文件暂存目录。
# .git/**
git 元数据目录。
