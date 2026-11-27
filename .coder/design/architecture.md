# 架构
## 全局视角
从 Host 的 tools 服务到六个工具，再向下经过扫描层和诊断层；file.md 的通配覆盖项目文件并反向检查标题引用，诊断码的文件通配范围在 list 时检查命中，计划条目、模块、问题文件与成员文档由 list 校验格式和交叉引用，大代码文件由 list 给出拆分提示，render 复用扫描结果生成 HTML。

```mermaid
flowchart TB
  subgraph 宿主层
    cordis["Cordis 上下文"]
    tools["tools 服务"]
  end
  subgraph 工具层
    list["list 工具"]
    render["render 工具"]
    lock["lock 工具"]
    unlock["unlock 工具"]
    update["update 工具"]
    issue["create_issue 工具"]
  end
  subgraph 扫描层
    walk["目录遍历"]
    parse["Markdown 解析"]
  end
  subgraph 诊断层
    file["file.md 校验"]
    glob["通配匹配"]
    arch["architecture.md 校验"]
    flow["flow.md 校验"]
    data["data_structure.md 校验"]
    diag["诊断码校验"]
    plan["计划文档校验"]
    module["模块文档校验"]
    issueDoc["问题文件校验"]
    memberDoc["成员文档校验"]
    scope["作用范围命中"]
    lockHash["lock.md hash 校验"]
    report["报告汇总"]
  end
  subgraph 锁层
    lockFile["lock.md"]
    hash["hash 计算"]
  end
  subgraph 提交层
    git["git commit / 分支"]
  end
  宿主层 --> 工具层
  工具层 --> 扫描层
  工具层 --> 锁层
  工具层 --> 提交层
  扫描层 --> 诊断层
  锁层 --> 诊断层
  诊断层 --> report
```

## 局部视角：文档扫描
只回答「怎么发现文件、怎么比对预期文档」，不重复全局图的层。

```mermaid
flowchart LR
  A[解析 root] --> B[读取 .coder]
  B --> C[递归遍历]
  C --> D[相对路径集合]
  D --> E[比对预期文档]
  E --> F[缺失 / 非法]
```

## 局部视角：文件引用与覆盖
只回答「file.md 是否覆盖项目里的每个文件」以及「file.md 的标题是否指向真实路径」，`.coder` 自身除外。

```mermaid
flowchart LR
  A[读取 file.md 路径] --> B[列出项目文件]
  B --> C[排除 .coder]
  C --> D[通配匹配]
  D --> E[未覆盖文件]
  A --> F[具体路径]
  F --> G{存在?}
  G -- 否 --> H[报 file.path.missing]
  G -- 是 --> I[通过]
  A --> J[通配路径]
  J --> K{命中项目文件?}
  K -- 否 --> L[写入 unused-glob 提示]
  K -- 是 --> I
```

## 局部视角：诊断码
只回答「error.md / warn.md 如何被解析和检查」：编码、作用范围、诊断方式、步骤格式和文件通配命中。

```mermaid
flowchart LR
  A[读取 error.md / warn.md] --> B[解析 # E0001 / # W0001]
  B --> C[校验前缀与 4 位数字]
  C --> D[校验作用范围、诊断方式与步骤格式]
  D --> E{作用范围是通配?}
  E -- 是 --> F[匹配项目文件并要求至少命中一个]
  E -- 否 --> G[全局范围]
  F --> H[写入 diagnoses]
  G --> H
```

## 局部视角：计划条目
只回答「todo / goal 单条目文件如何被校验和归档」：文件名与标题编码、字段顺序、编号条目、完成预期、当前进度、关联 ToDo，以及 active 与 archived 是否重复。

```mermaid
flowchart LR
  A[读取 plan/todo 与 plan/goal 下的单条目文件] --> B[校验文件名编码与 # T0001 / # G0001 一致]
  B --> C[校验目录前缀与 4 位数字]
  C --> D[校验字段顺序与编号条目]
  D --> E[校验完成预期、进度通配与关联 ToDo]
  E --> F{同一编码在 active 与 archived?}
  F -- 是 --> G[报 plan.code.archived-duplicate]
  F -- 否 --> H[写入 plans]
```

## 局部视角：模块与问题
只回答「模块和问题文件如何被校验」：模块按索引与详情成对检查，问题文件按段落、进度或关闭原因与文件夹状态检查。

```mermaid
flowchart LR
  A[读取 modules.md / module-NNNN.md] --> B[校验模块编码与分段]
  B --> C{索引与详情成对?}
  C -- 否 --> D[报 module.* 诊断]
  C -- 是 --> E[记录 modules / moduleDocs]
  F[读取 issues/open 与 issues/close] --> G[校验段落、当前进度与关闭原因]
  G --> H{同一编码同时在两边?}
  H -- 是 --> I[报 issue.status.conflict]
  H -- 否 --> J[记录 issues]
```

## 局部视角：成员文档
只回答「成员名册和成员流程如何被校验」：名册按主对话与成员分节检查字段，成员的可选备注写在最后，流程按场景和 Mermaid 图检查。

```mermaid
flowchart LR
  A[读取 members/all.md] --> B[解析 # 主对话 / # 成员N]
  B --> C[校验字段、顺序、备注与成员编号]
  D[读取 members/flow.md] --> E[按场景 + Mermaid 检查]
  C --> F{格式有效?}
  E --> F
  F -- 否 --> G[报 members.* / flow.* 诊断]
  F -- 是 --> H[列为可选文档]
```

## 局部视角：数据结构
只回答「data_structure.md 如何被校验」：按 `##` 分段，每段读取 ts 围栏，提取 interface 名称并查重。

```mermaid
flowchart LR
  A[读取 data_structure.md] --> B[按 ## 分段]
  B --> C[收集 ts 围栏]
  C --> D[提取 interface]
  D --> E[空块 / 缺 interface / 重名]
```

## 局部视角：锁定与更新
只回答「lock 如何约束修改、update 如何放行修改」；hash 计算复用全局图的锁层。

```mermaid
flowchart LR
  A[lock] --> B[计算 hash]
  B --> C[写 lock.md]
  D[update] --> E{已上锁?}
  E -- 否 --> F[直接替换，不提交]
  E -- 是 --> G{带 key?}
  G -- 否 --> H[返回 key 和审查计划]
  G -- 是 --> I[校验 hash / key / 源文件]
  I --> J{decision}
  J -- 补充 --> K[替换 + 更新 hash + 提交]
  J -- 调整 --> L[checkpoint + 新分支 + 替换 + 提交]
```

## 局部视角：大文件提示
只回答「list 如何提示大文件」：读取可选的 `.coder/manifest.json` 取阈值（默认 20KB），只统计源码扩展名并跳过依赖与产物目录；命中写入提示段，不改变 `ok`。

```mermaid
flowchart LR
  A[读取 .coder/manifest.json] --> B{JSON 有效?}
  B -- 否 --> C[报 manifest.* 诊断并使用默认值]
  B -- 是 --> D[取 largeCodeFileBytes]
  C --> D
  D --> E[遍历项目源码文件]
  E --> F{大小超过阈值?}
  F -- 是 --> G[写入 hints 与提示段]
  F -- 否 --> H[跳过]
```

## 局部视角：渲染
只回答「render 如何把文档变成 HTML」，扫描和诊断复用全局图。

```mermaid
flowchart LR
  A[render 调用] --> B[读取七份预期文档、模块详情与成员文档]
  B --> C[读取存在的模块详情]
  C --> D[汇总诊断]
  D --> E[生成 HTML]
  E --> F[写入 dist/.coder/design.html]
```
