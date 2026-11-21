# index.js
插件入口：导出 name、inject 与 apply，注册 `list`、`render`、`lock`、`unlock`、`update` 工具。
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
文档扫描与格式诊断：扫描 .coder/ 文档树，比对预期文档，执行四份文档的确定性检查。
## src/glob.js
通配匹配：支持 *、**、? 的路径匹配与文件覆盖检查。
## src/lock.js
锁文件：lock.md 的格式解析、.coder hash 计算与读写。
## src/git.js
update 的 git 操作：提交指定文件、checkpoint 与新建分支。
## src/render.js
HTML 渲染：把四份文档写成单页 design.html。
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
`update` 工具：校验 tmp 源、上锁时分两步、替换并更新 hash，按 decision 提交。
# tests
测试目录。
## tests/docs.test.js
覆盖扫描、缺失、非法、文件覆盖与四份文档的格式诊断。
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
