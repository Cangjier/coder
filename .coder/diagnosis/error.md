# E0001

作用范围：全局

诊断方式：静态代码审查

步骤1：查看 [src/docs.js] 文档扫描与诊断汇总，如果 illegal 或 missing 非空，或者 diagnostics 中存在 error 级规则，则认定为 E0001，否则继续。

步骤2：查看 [src/tools/list.js] list 工具的输出，如果 text 没有报告文档状态或诊断，则认定为 E0001，否则继续。

# E0002

作用范围：.coder/**

诊断方式：运行时日志审查

步骤1：在 [src/tools/update.js] lock hash 校验处，插入日志：

```ts
console.log('coder-lock-check', { recordedHash, currentHash })
```

步骤2：查看日志，如果 recordedHash 与 currentHash 不一致，则认定为 E0002，否则继续。
