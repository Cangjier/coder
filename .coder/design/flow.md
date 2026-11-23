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
## 加载插件
```mermaid
flowchart TD
  A[加载 coder bundle] --> B[执行 apply]
  B --> C[注册 list / render]
  B --> D[注册 lock / unlock]
  B --> E[注册 update]
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
update 从 tmp/ 读取源文件；上锁时先审查、再带 key 和 decision 执行。

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
把六份预期文档渲染成一个 HTML 页面。

```mermaid
flowchart LR
  A[render 调用] --> B[读取 .coder/design 与 .coder/diagnosis]
  B --> C[汇总诊断]
  C --> D[生成 HTML]
  D --> E[写入 dist/.coder]
```
