/**
 * 多份测试共用的计划文档样本。
 *
 * 计划文档的格式在 `src/plan.js` 与 `docs/design.md` 中约定；这里只提供
 * 合法样本，避免每个测试文件重复维护同一段文本。
 */

export const PLAN_TODO = `# T0001

任务范围：src/**

优先级：P1

完成预期：

1. 如果计划文档缺少字段，则 list 报告 plan.* 诊断，否则通过。
2. 如果编号不连续，则 list 报错，否则通过。

当前进度：

1. [src/**] 解析与校验已实现。
`

export const PLAN_TODO_ARCHIVED = `# T0002

任务范围：src/**

优先级：P2

完成预期：

1. 如果诊断文档的步骤格式不合法，则 list 报告 diagnosis.* 诊断，否则通过。

当前进度：

1. [src/**] 诊断码与步骤校验已实现并归档。
`

export const PLAN_GOAL = `# G0001

任务范围：src/**

完成预期：

1. 如果计划文档无法由 list 机械校验，则视为未达成，否则通过。

关联ToDo：

1. T0001
`

export const PLAN_GOAL_ARCHIVED = `# G0002

任务范围：src/**

完成预期：

1. 如果设计与诊断文档无法由确定性工具检查，则视为未达成，否则通过。

关联ToDo：

1. T0002
`
