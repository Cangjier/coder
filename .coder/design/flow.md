# 流程
## 检查项目文档
```mermaid
flowchart TD
  A[list 调用] --> B[解析 root]
  B --> C[扫描 .coder/ 文档树]
  C --> D[比对预期文档]
  D --> E[逐份格式诊断]
  E --> F[汇总报告]
```
## 检查文件覆盖
用 file.md 的路径/通配检查项目里的每个文件。

```mermaid
flowchart LR
  A[读取 file.md] --> B[列出项目文件]
  B --> C[排除 .coder]
  C --> D[逐项通配匹配]
  D --> E[未覆盖文件]
```
## 检查诊断码
在 list 时解析 error.md 和 warn.md，校验编码、作用范围、诊断方式、步骤格式与编号；作用范围是文件通配时，以及步骤里的文件通配，都必须至少命中一个项目文件。

```mermaid
flowchart TD
  A[读取诊断文档] --> B[按 # 分段解析诊断码]
  B --> C[校验 E/W 前缀与 4 位数字]
  C --> D[读取作用范围]
  D --> E{全局还是通配?}
  E -- 全局 --> F[记录全局诊断码]
  E -- 通配 --> G[用项目文件匹配]
  G --> H{至少命中一个?}
  H -- 否 --> I[报 diagnosis.scope.no-match]
  H -- 是 --> J[记录命中数]
  F --> K[校验诊断方式、步骤格式与编号]
  I --> K
  J --> K
  K --> L[写入 diagnoses]
```
## 检查计划文档
在 list 时解析 todo / goal 与归档文档，校验编码、字段顺序、编号条目、完成预期、当前进度和关联 ToDo；同一个编码不能同时留在 active 与 archived。

```mermaid
flowchart TD
  A[读取 plan 文档] --> B[按 # 分段解析编码]
  B --> C[校验 T/G 前缀与 4 位数字]
  C --> D[校验字段顺序与编号]
  D --> E[校验完成预期、进度通配与关联 ToDo]
  E --> F{active 与 archived 重复?}
  F -- 是 --> G[报 plan.code.archived-duplicate]
  F -- 否 --> H[写入 plans]
```

## 检查模块文档
list 解析 modules.md 和存在的 module-NNNN.md，校验模块编码、架构/流程/数据结构分段、子模块引用，以及索引与详情文件是否成对。

```mermaid
flowchart TD
  A[读取 modules.md] --> B[解析 # 0001]
  B --> C[读取存在的 module-NNNN.md]
  C --> D[校验架构/流程/数据结构分段]
  D --> E[校验子模块引用]
  E --> F{索引与详情成对?}
  F -- 否 --> G[报 module.file.missing / module.index.missing]
  F -- 是 --> H[写入 modules / moduleDocs]
```

## 检查问题文档
问题文档都是可选的；存在时校验详情段落、状态、进度行、关闭原因，以及索引与详情文件是否对应、open 与 close 是否冲突。

```mermaid
flowchart TD
  A[读取 issues/] --> B{文件存在?}
  B -- 否 --> C[跳过]
  B -- 是 --> D[解析详情与索引]
  D --> E[校验段落、状态、进度与关闭原因]
  E --> F[检查索引编码与详情文件]
  F --> G[写入 issues]
```

## 检查成员文档
成员文档都是可选的；存在时解析 members/all.md 的主对话与成员字段，members/flow.md 沿用场景和 Mermaid 规则。

```mermaid
flowchart TD
  A[读取 members/] --> B{all.md 存在?}
  B -- 是 --> C[解析 # 主对话 / # 成员N]
  C --> D[校验字段、顺序与成员编号]
  B -- 否 --> E[跳过 all.md]
  D --> F{flow.md 存在?}
  E --> F
  F -- 是 --> G[按场景 + Mermaid 检查]
  F -- 否 --> H[跳过 flow.md]
```

## 创建问题
create_issue 取已用最大编码加一，生成详情并登记到 open.md 或 close.md；上锁时拒绝写入。

```mermaid
flowchart TD
  A[create_issue 调用] --> B{已上锁?}
  B -- 是 --> C[拒绝]
  B -- 否 --> D[收集已用编码]
  D --> E[生成详情并自检]
  E --> F[写详情]
  F --> G[追加索引]
  G --> H[返回编码]
```

## 加载插件
```mermaid
flowchart TD
  A[加载 coder bundle] --> B[执行 apply]
  B --> C[注册 list / render]
  B --> D[注册 lock / unlock]
  B --> E[注册 update]
  B --> F[注册 create_issue]
```
## 检查数据结构
按 `##` 分段检查 data_structure.md 的 ts 围栏和 interface 声明。

```mermaid
flowchart TD
  A[读取 data_structure.md] --> B[按 ## 分段]
  B --> C[收集 ts 围栏]
  C --> D[提取 interface]
  D --> E[记录诊断]
```
## 上锁
lock 计算当前 .coder 的 hash，把声明、hash 和授权原文写进 lock.md。

```mermaid
flowchart TD
  A[lock 调用] --> B[计算 .coder hash]
  B --> C[写 .coder/lock.md]
  C --> D[返回锁状态]
```
## 解锁
unlock 校验授权原文，删除 lock.md；hash 不一致时仍然解锁并报告。

```mermaid
flowchart TD
  A[unlock 调用] --> B[校验授权原文]
  B --> C[删除 .coder/lock.md]
  C --> D[返回 hashMatches]
```
## 更新文档
update 从 tmp/ 读取源文件，目标可以是 .coder/ 下的任意文件；上锁时先审查、再带 key 和 decision 执行。

```mermaid
flowchart TD
  A[update 调用] --> B{已上锁?}
  B -- 否 --> C[直接替换]
  B -- 是 --> D{带 key?}
  D -- 否 --> E[返回 key 和审查计划]
  D -- 是 --> F[校验 hash / key / 源文件]
  F --> G{decision}
  G -- 补充 --> H[替换 + 更新 hash + 提交]
  G -- 调整 --> I[checkpoint + 按 branch 新建分支 + 提交]
```
## 渲染文档
把十一份预期文档、存在的模块详情和存在的成员文档渲染成一个 HTML 页面。

```mermaid
flowchart LR
  A[render 调用] --> B[读取 .coder/design、diagnosis 与 plan]
  B --> C[读取存在的模块详情与成员文档]
  C --> D[汇总诊断]
  D --> E[生成 HTML]
  E --> F[写入 dist/.coder]
```
