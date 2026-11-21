# 数据结构

只记录跨模块传递的关键结构：诊断、文档条目、检查报告，以及渲染的输入与结果。解析器内部的行、围栏等中间结构留在代码里，由 `src/docs.js` 自己维护。

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

## 文档条目

`.coder/` 下扫描到的每个文件都变成一条文档条目，预期、非法和缺失共用同一种形状。

```ts
export type DocumentKind = 'file' | 'architecture' | 'flow' | 'data' | 'lock' | 'generic'

export type DocumentStatus = 'expected' | 'illegal' | 'missing' | 'lock'

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
  /** 缺失文档数 */
  missing: number
  /** 诊断条数 */
  diagnostics: number
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
  summary: Summary
  /** 锁的状态；未上锁时为 null */
  lock: LockReport | null
  /** 可直接阅读的汇总文本 */
  text: string
}
```

## 渲染

渲染只接收四份文档的正文，输出页面路径、字节数和当前的检查状态。

```ts
export interface RenderDocument {
  /** 展示用路径，例如 .coder/design/file.md */
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
  /** .coder 下的目标文件 */
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
