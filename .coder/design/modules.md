# 0001
文档检查：扫描 `.coder` 文档树，按格式约定诊断设计、诊断、计划、模块、问题、日志与成员文档，并读取 manifest.json 给出大代码文件提示。

# 0002
诊断与计划校验：诊断码、计划编码、模块索引和问题文件的确定性检查。

# 0003
工具与渲染：`list` / `render` / `lock` / `unlock` / `update` / `create_issue` 工具与 `design.html` 生成，渲染时收录存在的模块详情与成员文档。

# 0004
日志校验：解析 logs/audit、logs/update、logs/usage 与 logs/research 下的日期序号文件，校验日期与同日序号连续性、标题、固定字段与更新内容的编号条目，并把条目汇总进 logs。
