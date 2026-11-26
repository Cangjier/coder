# 架构
## 全局视角
文档检查从项目根目录出发，扫描 `.coder` 下的全部文件，比对预期文档与可选白名单，再把每份 Markdown 交给对应的结构检查器。诊断与计划校验是检查层里的子模块。
```mermaid
flowchart TB
  subgraph 入口
    list["list 工具"]
  end
  subgraph 扫描
    walk["目录遍历"]
    expected["预期与可选比对"]
  end
  subgraph 检查
    design["设计文档检查"]
    diagnosis["诊断与计划检查"]
    module["模块文档检查"]
    issue["问题文档检查"]
    member["成员文档检查"]
    coverage["file.md 覆盖检查"]
    lock["lock hash 检查"]
  end
  subgraph 汇总
    report["报告与 text"]
  end
  list --> walk
  walk --> expected
  expected --> design
  expected --> diagnosis
  expected --> module
  expected --> issue
  expected --> member
  design --> coverage
  design --> report
  diagnosis --> report
  module --> report
  issue --> report
  member --> report
  coverage --> report
  lock --> report
```
## 局部视角：格式分派
每份文档按 `.coder/` 相对路径确定类型，再进入对应检查器；未知路径只作为非法文档报告。
```mermaid
flowchart LR
  A[相对路径] --> B{类型}
  B -- 设计文档 --> C[design.js]
  B -- 诊断/计划 --> D[diagnosis.js / plan.js]
  B -- 模块 --> E[module.js]
  B -- 问题 --> F[issue.js]
  B -- 成员 --> H[member.js]
  B -- 其他 --> G[非法文档]
```
# 流程
## 检查项目文档
list 读取根目录，遍历 `.coder`，逐份诊断后汇总报告。
```mermaid
flowchart TD
  A[list 调用] --> B[解析 root]
  B --> C[遍历 .coder]
  C --> D[比对预期与可选文档]
  D --> E[逐份格式诊断]
  E --> F[汇总报告]
```
## 汇总报告
报告同时给出结构化字段和可读 text；非法、缺失或诊断非空时 ok 为 false。
```mermaid
flowchart LR
  A[文档条目] --> B[诊断列表]
  B --> C[summary]
  C --> D[text]
```
# 数据结构
## 检查报告
检查结果汇总了文档状态、诊断与各类条目数量。
```ts
export interface DocumentCheckSummary {
  expected: number
  found: number
  illegal: number
  optional: number
  missing: number
  diagnostics: number
  modules: number
  issues: number
}
```
## 诊断
每条诊断定位到文档和行，并带稳定规则代码。
```ts
export interface DocumentDiagnostic {
  doc: string
  line: number
  rule: string
  severity: 'error'
  message: string
}
```
# 子模块
## 0002
诊断与计划校验：诊断码、计划编码、模块索引和问题文件的确定性检查。
