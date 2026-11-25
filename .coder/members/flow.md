# 成员流程

## 分派任务
主对话用 call_member 在成员工作区新建对话，或带 conversationId 继续已有对话；成员执行任务并回报结果。
```mermaid
flowchart TD
  A[主对话] --> B{新建还是继续}
  B -- 新建 --> C[call_member 指定成员与工作区]
  B -- 继续 --> D[call_member 带 conversationId]
  C --> E[成员执行任务]
  D --> E
  E --> F[成员回报结果]
```

## 等待与汇总
主对话用 wait_member 的 all 模式等待任一成员返回；还有进行中的会话就继续等，全部结束后汇总。
```mermaid
flowchart TD
  A[wait_member all] --> B{有成员返回}
  B -- 是 --> C[读取这一轮回复]
  C --> D{还有进行中}
  D -- 是 --> A
  D -- 否 --> E[汇总结果]
  B -- 超时 --> A
```

## 部署与验证
主对话把插件同步到成员并重启成员服务；成员在临时目录运行 list 和工具检查，回报版本与验证结果。
```mermaid
flowchart LR
  A[主对话打包插件] --> B[上传到成员]
  B --> C[重启成员服务]
  C --> D[成员只读验证]
  D --> E[回报结果]
```

## 身份与范围
主对话用 set_member_scope 设置成员的身份和工作范围，并把同一组值记录到 members/all.md；部署方式、SSH 用户等补充信息写成可选的备注。
```mermaid
flowchart LR
  A[确定分工] --> B[set_member_scope]
  B --> C[成员会话]
  C --> D[写入 members/all.md]
  C --> E[补充可选备注]
  E --> D
```
