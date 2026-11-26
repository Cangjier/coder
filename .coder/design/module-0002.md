# 架构
## 全局视角
诊断与计划校验把文档文本解析成条目，再检查编码、字段、作用范围与交叉引用；它只依赖项目文件列表，不执行诊断步骤，也不判断任务是否真的完成。
```mermaid
flowchart TB
  subgraph 输入
    text["文档正文"]
    files["项目文件列表"]
  end
  subgraph 解析
    diag["诊断码解析"]
    plan["计划条目解析"]
    module["模块索引与子模块"]
    issue["问题文件"]
  end
  subgraph 输出
    codes["diagnoses"]
    plans["plans"]
    modules["modules / moduleDocs"]
    issues["issues"]
  end
  text --> diag
  text --> plan
  text --> module
  text --> issue
  files --> diag
  files --> issue
  diag --> codes
  plan --> plans
  module --> modules
  issue --> issues
```
# 流程
## 检查诊断码
诊断码按一级标题分段，校验前缀、作用范围、诊断方式和步骤；作用范围与步骤里的通配必须命中项目文件。
```mermaid
flowchart TD
  A[读取 error.md / warn.md] --> B[解析 # E0001 / # W0001]
  B --> C[校验编码、作用范围与诊断方式]
  C --> D[校验步骤格式与编号]
  D --> E[匹配项目文件]
  E --> F[写入 diagnoses]
```
## 检查计划条目、模块与问题
计划条目按目录区分 active 与 archived、按文件名定位编码；模块索引按一级标题编码分段；问题文件按 open/ 与 close/ 文件夹区分状态；交叉检查归档与问题状态。
```mermaid
flowchart TD
  A[读取 plan 条目文件 / modules / issues] --> B{计划文件?}
  B -- 是 --> C[校验文件名编码与标题一致、字段与条目]
  B -- 否 --> D{问题文件?}
  D -- 是 --> E[校验段落、进度/关闭原因与文件夹状态]
  D -- 否 --> F[解析模块一级标题编码]
  C --> G{active 与 archived 重复?}
  E --> H{同一编码同时在 open/ 与 close/?}
  F --> I{索引与详情成对?}
  G -- 是 --> J[记录 plan.* 诊断]
  G -- 否 --> K[写入 plans]
  H -- 是 --> L[记录 issue.status.conflict]
  H -- 否 --> M[写入 issues]
  I -- 否 --> N[记录 module.* 诊断]
  I -- 是 --> O[写入 modules]
```
# 数据结构
## 诊断码
诊断码条目记录作用范围、诊断方式和步骤命中数。
```ts
export interface IssueDiagnosisCode {
  code: string
  severity: 'error' | 'warn'
  scope: string | null
  method: string | null
  steps: number
  matches: number | null
}
```
## 问题条目
问题文件按文件夹区分状态，文件名是 4 位编码；开启的问题带当前进度，关闭的问题带关闭原因。
```ts
export type IssueStatus = '开启' | '关闭'
export interface IssueProgress {
  line: number
  scope: string | null
  text: string
  matches: number | null
}
export interface IssueEntry {
  doc: string
  line: number
  code: string
  status: IssueStatus
  progress: IssueProgress | null
  reason: string | null
}
```
