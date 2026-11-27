# 数据结构

只记录跨模块传递的关键结构：诊断、诊断码、计划条目、模块条目、问题条目、大文件提示、manifest 配置、文档条目、检查报告，以及渲染的输入与结果。解析器内部的行、围栏等中间结构留在代码里，由 `src/markdown.js` 自己维护。

## 诊断

`list` 和 `render` 都返回诊断；每条诊断能定位到文档和行，并带一个稳定的规则代码。

```ts
export type DiagnosticSeverity = 'error'

export interface Diagnostic {
  /** 展示用文档路径，例如 .coder/design/file.md */
  doc: string
  /** 1-based 行号 */
  line: number
  /** 稳定规则代码，例如 file.coverage.missing */
  rule: string
  severity: DiagnosticSeverity
  /** 给人看的原因与改法 */
  message: string
}
```

## 诊断码

诊断文档解析出的诊断码；`list` 用它展示编码、作用范围、诊断方式、步骤和文件通配命中数。

```ts
export type DiagnosisSeverity = 'error' | 'warn'

export type DiagnosisMethod = '静态代码审查' | '运行时日志审查'

export type DiagnosisStepKind = '静态' | '插入日志' | '查看日志'

export interface DiagnosisStep {
  /** 步骤N 的 N */
  number: number
  /** 步骤所在行 */
  line: number
  kind: DiagnosisStepKind
  /** 步骤里的文件通配；查看日志步骤为 null */
  glob: string | null
  /** 文件通配命中的项目文件数；全局或未检查时为 null */
  matches: number | null
  /** 插入日志步骤是否带了 ts 围栏 */
  log: boolean
}

export interface DiagnosisCode {
  /** 展示用文档路径，例如 .coder/diagnosis/error.md */
  doc: string
  /** 诊断码标题所在行 */
  line: number
  /** E0001 或 W0001 */
  code: string
  severity: DiagnosisSeverity
  /** 全局或文件路径通配；作用范围无效时为 null */
  scope: string | null
  scopeKind: 'global' | 'glob' | null
  /** 静态代码审查或运行时日志审查；无效时为 null */
  method: DiagnosisMethod | null
  steps: DiagnosisStep[]
  /** 文件通配命中的项目文件数；全局或未检查时为 null */
  matches: number | null
}
```

## 计划条目

计划条目文件解析出的 todo / goal 条目；结构化结果保留完整条目，`list` 的 text 只展示数量。

```ts
export type PlanKind = 'todo' | 'goal'

export type PlanPriority = 'P1' | 'P2' | 'P3'

export interface PlanEntry {
  /** 展示用文档路径，例如 .coder/plan/todo/T0001.md */
  doc: string
  /** 编码标题所在行 */
  line: number
  /** T0001 或 G0001 */
  code: string
  kind: PlanKind
  /** 是否位于 archived 文档 */
  archived: boolean
  /** 全局或文件路径通配；任务范围无效时为 null */
  scope: string | null
  /** todo 的优先级；goal 为 null */
  priority: PlanPriority | null
  /** 完成预期条目数 */
  expected: number
  /** 当前进度条目数；goal 为 0 */
  progress: number
  /** 关联 ToDo 条目数；todo 为 0 */
  todos: number
}
```

## 模块条目

`modules.md` 解析出的索引条目，以及存在的模块详情；模块详情里的子模块用编码引用另一个模块。

```ts
export interface ModuleEntry {
  /** 展示用文档路径，例如 .coder/design/modules.md */
  doc: string
  /** 编码标题所在行 */
  line: number
  /** 0001 */
  code: string
  /** 模块说明 */
  description: string
}

export interface ModuleSubmodule {
  doc: string
  line: number
  /** 0002 */
  code: string
  description: string
}

export interface ModuleDoc {
  /** 展示用文档路径，例如 .coder/design/module-0001.md */
  doc: string
  /** 相对于 .coder/ 的路径 */
  relative: string
  /** 模块自己的 4 位编码 */
  code: string | null
  submodules: ModuleSubmodule[]
}
```

## 问题条目

问题文件放在 `issues/open/` 或 `issues/close/` 下，状态由文件夹决定；没有索引文件。

```ts
export type IssueStatus = '开启' | '关闭'

export interface IssueProgress {
  line: number
  /** 进度通配；无效时为 null */
  scope: string | null
  /** 进度说明 */
  text: string
  /** 通配命中的项目文件数；未检查时为 null */
  matches: number | null
}

export interface IssueEntry {
  /** 展示用文档路径，例如 .coder/issues/open/issue-0001.md */
  doc: string
  /** 第一个段落的行号 */
  line: number
  /** 文件名里的 4 位编码 */
  code: string
  /** 所在文件夹决定的状态 */
  status: IssueStatus
  /** 开启问题的当前进度；关闭的问题为 null */
  progress: IssueProgress | null
  /** 关闭问题的关闭原因；开启的问题为 null */
  reason: string | null
}

export interface IssueReport {
  open: IssueEntry[]
  close: IssueEntry[]
  /** 两类问题的汇总，供 list 展示 */
  all: { code: string, path: string, status: IssueStatus }[]
}
```

## 大文件提示

`list` 对超过阈值的源码文件给出拆分提示；阈值来自可选的 `.coder/manifest.json`，默认 20KB。提示不进入诊断，也不影响 `ok`。

```ts
export interface LargeFileHint {
  /** 项目内相对路径 */
  path: string
  /** 文件字节数 */
  bytes: number
  /** 生效的阈值（字节） */
  threshold: number
}

export interface Manifest {
  /** 大代码文件阈值（字节），默认 20480 */
  largeCodeFileBytes: number
}
```

## 文档条目

`.coder/` 下扫描到的每个文件都变成一条文档条目，预期、可选、非法和缺失共用同一种形状。

```ts
export type DocumentKind =
  | 'file'
  | 'architecture'
  | 'flow'
  | 'data'
  | 'modules'
  | `module-${string}`
  | 'diagnosis-error'
  | 'diagnosis-warn'
  | 'plan-todo'
  | 'plan-todo-archived'
  | 'plan-goal'
  | 'plan-goal-archived'
  | 'issue-open'
  | 'issue-close'
  | 'members-all'
  | 'members-flow'
  | 'lock'
  | 'generic'

export type DocumentStatus = 'expected' | 'optional' | 'illegal' | 'missing' | 'lock'

export interface DocumentEntry {
  /** 展示用路径，例如 .coder/design/flow.md */
  path: string
  /** 相对于 .coder/ 的路径，例如 design/flow.md */
  relative: string
  /** 绝对路径 */
  absolute: string
  status: DocumentStatus
  /** 预期文档在磁盘上是否存在；非法文档为 true */
  exists: boolean
  kind: DocumentKind
}
```

## 检查报告

`list` 的返回值，也是 `render` 判断文档是否健康的依据。

```ts
export interface Summary {
  /** 预期文档总数 */
  expected: number
  /** 找到的预期文档数 */
  found: number
  /** 非法文档数 */
  illegal: number
  /** 可选文档数 */
  optional: number
  /** 缺失文档数 */
  missing: number
  /** 诊断条数 */
  diagnostics: number
  /** 解析出的诊断码数量 */
  codes: number
  /** 解析出的计划条目数量 */
  plans: number
  /** 模块索引条目数 */
  modules: number
  /** 存在的模块详情数 */
  moduleFiles: number
  /** 问题文件数 */
  issues: number
  /** 进行中问题数 */
  openIssues: number
  /** 已关闭问题数 */
  closedIssues: number
  /** 大代码文件的拆分提示数 */
  hints: number
  /** .coder/lock.md 是否存在 */
  locked: boolean
}

export interface Report {
  /** 没有非法文档、缺失文档和诊断时为 true */
  ok: boolean
  /** 项目根目录的绝对路径 */
  root: string
  /** .coder/ 的绝对路径 */
  docsRoot: string
  docsRootExists: boolean
  documents: DocumentEntry[]
  /** 非法文档的展示用路径 */
  illegal: string[]
  /** 缺失文档的展示用路径 */
  missing: string[]
  diagnostics: Diagnostic[]
  /** 两份诊断文档解析出的诊断码 */
  diagnoses: DiagnosisCode[]
  /** 计划条目文件解析出的计划条目 */
  plans: PlanEntry[]
  /** modules.md 解析出的模块索引 */
  modules: ModuleEntry[]
  /** 存在的模块详情 */
  moduleDocs: ModuleDoc[]
  /** 问题文件 */
  issues: IssueReport
  /** 大代码文件的拆分提示 */
  hints: LargeFileHint[]
  /** 生效的 manifest 配置 */
  manifest: Manifest
  summary: Summary
  /** 锁的状态；未上锁时为 null */
  lock: LockReport | null
  /** 可直接阅读的汇总文本 */
  text: string
}
```

## 渲染

渲染接收七份预期文档、存在的模块详情与存在的成员文档的正文；计划条目与问题文件不渲染。输出页面路径、字节数和当前的检查状态。

```ts
export interface RenderDocument {
  /** 展示用路径，例如 .coder/design/file.md 或 .coder/plan/todo/T0001.md */
  path: string
  kind: DocumentKind
  /** 文档是否存在；缺失时正文为空串 */
  present: boolean
  content: string
}

export interface RenderPayload {
  docs: RenderDocument[]
}

export interface RenderResult {
  ok: boolean
  /** design.html 的绝对路径 */
  output: string
  /** HTML 的 UTF-8 字节数 */
  bytes: number
  /** 渲染时文档是否齐全且格式正确 */
  healthy: boolean
  summary: Summary
  missing: string[]
  illegal: string[]
  diagnostics: Diagnostic[]
  text: string
}
```

## 锁

`.coder/lock.md` 是锁状态文件；第一行是固定声明，第二行是 hash，第三行起是授权原文。`list` 解析它并报告 hash 是否匹配。

```ts
export interface LockFile {
  /** 固定声明 */
  declaration: string
  /** 所有 .coder 文件（除 lock.md）内容 hash 拼接后的 sha256 */
  hash: string
  /** 用户授权原文，逐字保存 */
  authorization: string
}

export interface LockReport {
  present: boolean
  /** 第一行是否为固定声明 */
  declarationValid: boolean
  /** 第二行记录的 hash */
  hash: string | null
  /** 重新计算的 hash 是否与记录一致；无法计算时为 null */
  hashMatches: boolean | null
  /** 当前 .coder 的 hash */
  currentHash: string | null
  /** 授权原文的长度，不返回原文本身 */
  authorizationLength: number
}
```

## 更新

`update` 的输入是一组「tmp 源文件 → .coder 目标文件」；上锁时第一次调用只返回 key 和计划，第二次调用才替换。

```ts
export interface UpdateItem {
  /** tmp/ 下的源文件，相对项目根目录 */
  source: string
  /** .coder 下的目标文件，不能是 .coder/lock.md */
  target: string
}

export interface UpdateRequest {
  locked: boolean
  /** 第一次调用返回的随机 key，仅当前进程内存有效 */
  key?: string
  phase?: 'review'
  files: UpdateItem[]
}

export interface UpdateDecision {
  /** 第一次调用返回的随机 key */
  key: string
  decision: 'supplement' | 'adjustment'
  /** 本次更新的用户授权原文 */
  review: string
  /** adjustment 时传入的新建分支名 */
  branch?: string
}

export interface UpdateResult {
  locked: boolean
  decision?: 'supplement' | 'adjustment'
  /** supplement 为当前分支；adjustment 为传入的新分支名 */
  branch?: string
  /** adjustment 分支前的 checkpoint commit；没有变化时为 null */
  checkpoint?: string | null
  /** 本次 update 的 commit；没有变化时为 null */
  commit?: string | null
  /** 更新后的锁 hash */
  hash?: string
  applied?: UpdateItem[]
}
```
