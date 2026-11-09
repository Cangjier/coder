/**
 * 每一步子代理的提示词。
 *
 * 每个代理都是新起的、互不共享上下文，所以提示词必须自包含：
 * 路径、输入、返回结构、硬规则。
 */
import { describeProgram } from './program.mjs'

/** 每一条码都带的可选「涉及对象」字段，提示词里要讲清语义。 */
const SCOPE_RULE = [
  '每条码除了 code / check / severity / rule / detect / fix，还有一个可选的 targets：这条码涉及的对象。',
  'targets 里可能是精确名字（["Session#append", "parseDiagnostics"]），也可能是一句泛化的描述（["所有 XxxService", "带重试的 RPC 调用"]）——',
  '所以它只按语义理解，不做字符串匹配：看到描述就自己判断指的是哪些 class / interface / method。',
  '空数组 = 没限定，整份代码都算；写了就只在这些对象上取证。',
]

/** 检查类型的说明：两条线都按它决定自己这一步要不要管这条码。 */
const CHECK_RULE = [
  '每条码的 check 是检查类型：static = 读代码就能判定，runtime = 必须跑起来观察。',
  '它决定这条规则靠什么证实，和 code 的族是两件事。',
]

/**
 * 每条诊断都要带的复现步骤：别人照着做，必须能亲眼看到这条诊断说的是什么。
 *
 * 「怎么确认」也算复现——有些规则（注释缺失、职责划分）跑起来看不到，指到位置同样是复现。
 */
const STEPS_RULE = [
  '每条诊断都要带 steps（复现步骤）：别人照着做，就能看到这条诊断说的是什么。2–4 步，每步一个动作。',
  '- 能跑出来的就写命令：`在仓库根执行 <启动命令>`、`请求 POST /api/save`、`把 config.json 的 port 改成 0`；',
  '- 只能读代码确认的，就指到确切位置：`打开 src/a.ts:42，看导出的 run() 上方有没有注释`；',
  '- 不许写「检查代码」「查看日志」「修复它」这类空话；不要写行号以外的文件路径缩写；',
  '- steps 是字符串数组，不带 1./2. 编号。',
]

/** 每次最多列多少个文件名：整仓可能有几万个文件，提示词里全列出来没有意义。 */
const MAX_SCOPE_FILES = 200

/**
 * 构建 / 启动步骤在提示词里的一段。
 *
 * 步骤是 `{type, entry}`：`cmd` 由编排起子进程执行，`dsh-plugin` 由编排让 DSH 调用那个工具。
 * 代理要知道这一步到底会被谁执行，才知道自己该不该假设它「已经跑过」。
 *
 * @param {string} title
 * @param {unknown} steps
 * @returns {string[]}
 */
export function stepLines(title, steps) {
  const lines = describeProgram(steps)
  if (lines.length === 0) return []
  return [title, ...lines.map((line) => `  ${line}`)]
}

/**
 * 「这次要看多大一片代码」的统一说法。
 *
 * 三种范围：整仓（没有改动清单，让代理自己去找）、区间、单个提交。
 *
 * @param {{ mode?: string, base?: string | null, head?: string, files?: Array<{ status: string, path: string }> }} scope
 * @returns {string[]}
 */
function scopeBlock(scope) {
  const mode = scope?.mode ?? 'commit'
  const head = shortSha(scope?.head)
  const files = Array.isArray(scope?.files) ? scope.files : []

  if (mode === 'all') {
    return [
      `本次范围：**整个仓库**（提交 ${head} 的完整文件树，共 ${files.length} 个文件，不是某次改动的差集）。`,
      '没有「改动文件」清单可看——该看哪几处，自己按诊断码的 targets（涉及的 class / interface / method）、规则里提到的名字去工作区里找。',
      '',
    ]
  }

  const base = shortSha(scope?.base)
  const label = mode === 'range' ? `提交区间 ${base}..${head}` : `提交 ${head}（对比父提交 ${base}）`
  const shown = files.slice(0, MAX_SCOPE_FILES)
  return [
    `本次范围：${label}，改动 ${files.length} 个文件：`,
    ...(shown.length > 0 ? shown.map((file) => `- ${file.status} ${file.path}`) : ['- （没有改动文件信息）']),
    ...(files.length > shown.length ? [`- …还有 ${files.length - shown.length} 个文件未列出`] : []),
    '',
  ]
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function shortSha(value) {
  return String(value ?? '').slice(0, 8)
}

/**
 * @param {Array<{ path: string, excerpt: string }>} candidates
 * @returns {string}
 */
export function triagePrompt(candidates) {
  return [
    '你是 coder_debug 的文档筛选代理。',
    '',
    '下面是一个仓库 docs 目录下的 Markdown 候选（路径 + 开头片段）。',
    '请判断每个文件是不是「规范性文档」：',
    '- 是：它以规则口吻规定这个仓库必须 / 禁止 / 应当怎样写代码或怎样行为，能直接作为诊断依据。',
    '- 否：说明文、教程、设计草稿、变更日志、API 索引、会议记录、模板、空文件、纯示例。',
    '',
    `候选（共 ${candidates.length} 个）：`,
    '',
    ...candidates.map((item) => `### ${item.path}\n${item.excerpt}\n`),
    '',
    '返回 JSON：',
    '{"docs":[{"path":"docs/a.md","normative":true,"reason":"一句话说明"}]}',
    '必须覆盖上面每一个路径，一个都不能少；顺序不限。',
  ].join('\n')
}

/**
 * @param {Array<{ path: string, reason: string }>} normative
 * @returns {string}
 */
export function selectPrompt(normative) {
  return [
    '你是 coder_debug 的文档决策代理。',
    '',
    '下面是这个仓库里被判定为「规范性文档」的清单。请选出**一份**作为本次诊断的依据。',
    '标准按优先级：',
    '1. 约束力：写的是「必须 / 禁止 / 不得」这类硬规则，而不是建议；',
    '2. 覆盖面：约束的是仓库的核心行为，而不是某个边角模块；',
    '3. 具体性：每条规则都能落到可观察的代码位置。',
    '',
    '候选：',
    ...normative.map((item) => `- ${item.path}：${item.reason}`),
    '',
    '返回 JSON：{"path":"docs/a.md","reason":"为什么是它","ranking":["docs/a.md","docs/b.md"]}',
    'path 必须是候选里的一个。',
  ].join('\n')
}

/**
 * 两族诊断码：Debug 先出（运行期可观察的规则），质量后出，并且**看到 D 码**——
 * 否则两个代理各读一遍同一份文档，同一句规则会被两族各出一次。
 *
 * @param {{ path: string, worktree: string, kind: 'debug'|'quality', dirs?: string[], prior?: Array<object> }} input
 * @returns {string}
 */
export function codesPrompt(input) {
  const debug = input.kind === 'debug'
  const prior = Array.isArray(input.prior) ? input.prior : []
  return [
    `你是 coder_debug 的${debug ? ' Debug' : '质量'}诊断码设计代理。`,
    '',
    `工作区：${input.worktree}`,
    `请读这份规范性文档：${input.path}（相对工作区根）`,
    '',
    debug
      ? '只产出 **D 码（Debug）**：运行期可观察的行为规则。每条都要能说清「什么情况下触发」，靠插桩 + 运行来证实。'
      : '只产出 **Q 码（质量）**：只能靠读代码判断的结构性要求——复杂度、重复、命名、职责划分、注释缺失、一致性。这些规则运行期观察不到。',
    ...(debug
      ? []
      : [
          '',
          '⚠️ Debug 码已经覆盖下面这些规则。**同一条规则不要再出 Q 码**——哪怕换个说法、换个角度（例如 D 码管「必须用 log() 输出」，你就不要再出「禁止直接调 console」）：',
          '```json',
          JSON.stringify(
            prior.map((item) => ({ code: item.code, check: item.check, rule: item.rule })),
            null,
            2,
          ),
          '```',
          '你要找的是这些**之外**的、只能靠读代码判断的要求。文档里能被运行期观察的规则，交给 D 码，别在这里重复一遍。',
        ]),
    '',
    '要求：',
    debug
      ? '- 覆盖文档里的硬性行为规则（必须 / 禁止 / 不得）；'
      : '- 覆盖文档里关于结构、可维护性、一致性、可读性的要求；',
    '- 每条 rule 逐字摘录文档原文（≤120 字），不要改写；',
    debug ? '- detect 写清楚运行期该观察什么；' : '- detect 写清楚读代码时怎么判断；',
    '- fix 写解决思路：这条规则被违反时**怎么改才算满足它**（具体到做法，一两句话；不要「修复它」「改代码」这类空话）；',
    '- check：static（读代码就能判定）/ runtime（必须跑起来观察）。D 码一般 runtime，Q 码一般 static；某条规则用运行期指标（调用次数、耗时、内存）才说得清时，就写 runtime；',
    debug ? '- code 从 D001 起编号；' : '- code 从 Q001 起编号；',
    '- severity：error（必须）/ warning（应当）/ info（建议）；',
    ...(debug ? [] : ['- 一条码只对应文档里的一处要求：同一件事不要拆成两条，也不要把两条要求揉进一条；']),
    '',
    ...SCOPE_RULE,
    '能确定这条要求落在哪些 class / interface / method 上就填 targets（精确名字或一句描述都行），拿不准就留空。',
    ...(Array.isArray(input.dirs) && input.dirs.length > 0
      ? ['', `仓库里的顶层目录（供参考）：${input.dirs.join(', ')}`]
      : []),
    '',
    debug
      ? '- 这一族确实没有可观察的规则时返回空数组，并在 notes 里说明。'
      : '- 除了 D 码已经覆盖的之外确实没有别的质量要求时返回空数组，并在 notes 里说明。',
    '',
    '返回 JSON：',
    debug
      ? '{"codes":[{"code":"D001","check":"runtime","severity":"error","rule":"原文…","detect":"运行期观察点","fix":"解决思路…","targets":[]}],"notes":"…"}'
      : '{"codes":[{"code":"Q001","check":"static","severity":"warning","rule":"原文…","detect":"读代码时的判断标准","fix":"解决思路…","targets":["Session#append"]}],"notes":"…"}',
    '不要输出 title 字段：这条规则说的是什么，看 rule。',
    '只返回 JSON，不要解释。',
  ].join('\n')
}

/**
 * @param {{ worktree: string, codes: Array<object>, scope: object, kind: 'debug'|'quality' }} input
 * @returns {string}
 */
export function reviewPrompt(input) {
  const debug = input.kind === 'debug'
  const wholeRepo = (input.scope?.mode ?? 'commit') === 'all'
  return [
    `你是 coder_debug 的${debug ? ' Debug' : '质量'}静态审查代理。`,
    '',
    `工作区：${input.worktree}（就是本次要诊断的提交，还没有插桩）`,
    '',
    ...scopeBlock(input.scope),
    `诊断码（只有 ${debug ? 'D 码' : 'Q 码'}）：`,
    '```json',
    JSON.stringify(input.codes, null, 2),
    '```',
    '',
    '每条码的 targets 是它涉及的对象：按语义理解（可能是精确名字，也可能是一句描述），只在这些对象上报；空数组表示没限定。',
    '',
    ...CHECK_RULE,
    debug
      ? 'runtime 的码你的结论只是嫌疑，后面有运行期证据；static 的码运行期看不出来，你的结论就是最终结论。'
      : 'static 的码你的结论就是最终结论；runtime 的码会被质量运行期再观测一次。',
    '',
    debug
      ? '你的结论是**嫌疑**：这些规则运行期可观察，后面会由运行期证据证实或排除。只报你能指出具体位置的违规。'
      : '你的结论是**最终结论**：这些规则运行期观察不到，没有后续证据来纠正它。宁可少报，也不要报一条站不住的。',
    '',
    wholeRepo
      ? '任务：只读地审查整个仓库，找出违反诊断码的位置（不受「改动文件」限制）。'
      : '任务：只读地审查这次提交的改动及其直接相关代码，找出违反诊断码的位置。',
    '',
    '规则：',
    '1. 只报你能指出**具体文件与行号**的违规；行号用当前工作区的行号。',
    '2. 每条说清楚：哪里、违反了哪条、看到了什么。',
    '3. 没把握的不要报；介于两者之间的标 confidence=low。',
    '4. 不要修改任何文件，不要运行程序。',
    '5. 同一处只报一次；同一条规则在多处违反时分别报。',
    '',
    ...STEPS_RULE,
    '',
    '返回 JSON：',
    `{"findings":[{"code":"${debug ? 'D001' : 'Q001'}","file":"src/app.mjs","line":4,"severity":"${debug ? 'error' : 'warning'}","message":"…","confidence":"high","evidence":"命中的代码片段","steps":["打开 src/app.mjs:4","看 run() 里直接调用了 console.log"]}],"notes":"…"}`,
    '只返回 JSON，不要解释。',
  ].join('\n')
}

/**
 * @param {{ worktree: string, codes: Array<object>, scope: object, staticFindings?: Array<object> }} input
 * @returns {string}
 */
export function instrumentPrompt(input) {
  const wholeRepo = (input.scope?.mode ?? 'commit') === 'all'
  return [
    '你是 coder_debug 的插桩代理。',
    '',
    `工作区：${input.worktree}（这里的代码就是本次要诊断的提交）`,
    '',
    ...stepLines('构建方式（你返回后由编排按顺序执行；dsh-plugin 是让 DSH 调用那个工具）：', input.build),
    ...(input.build?.length ? [''] : []),
    ...scopeBlock(input.scope),
    '诊断码（只有 Debug 码；质量码不在这一步处理）：',
    '```json',
    JSON.stringify(input.codes, null, 2),
    '```',
    '',
    '每条码的 targets 是它涉及的对象：按语义理解（可能是精确名字，也可能是一句描述），只在这些对象上插桩；空数组表示没限定。',
    ...CHECK_RULE,
    '只给 check=runtime 的码插桩；check=static 的码运行期观察不到，不要硬插，把它们写进 notes。',
    ...(input.staticFindings?.length
      ? [
          '',
          '静态审查已经怀疑这些位置，请优先在这些位置插桩，用运行期日志确认或排除：',
          ...input.staticFindings
            .slice(0, 30)
            .map((item) => `- ${item.code} ${item.file}:${item.line} ${item.message}`),
        ]
      : []),
    '',
    '任务：给这些诊断码插入运行期诊断日志。',
    ...(wholeRepo ? ['整个仓库都在范围内：不要只盯着最近改过的地方，按码的 targets 去找。'] : []),
    '',
    '要求：',
    '1. 只改工作区里的文件；不要 git commit / push / checkout；不要动工作区以外的东西。',
    '2. 每条日志是一行 JSON，追加到 `$CODER_LOG_DIR/diagnostics.jsonl`：',
    '   {"code":"D001","severity":"error","file":"src/a.ts","line":42,"message":"人话说明","data":{}}',
    '   - file 用相对工作区根的 posix 路径；',
    '   - line 必须是**原始提交里**该观察点的行号，不是你插桩后的行号；',
    '   - file/line 指向被观察的业务代码，不要指向你新加的日志辅助代码；',
    '   - message 只描述现象与上下文，**不要写行号或文件路径**（报告会按 file/line 渲染位置）；',
    '   - data 放可机读的上下文（变量值、分支名、计数），不要放密钥、令牌、用户隐私。',
    '3. 用目标语言最自然的方式写；日志本身失败绝不能影响业务（try/catch 或等价写法）。',
    '4. 不引入新依赖，不改变业务逻辑、返回值、异常行为。',
    '5. 同一个码可以在多条关键路径上各插一处，但不要为了凑数在每个函数里都插。',
    '6. 某个码在当前代码里确实找不到可插桩的位置时不要硬插，写进 notes。',
    '',
    '返回 JSON：',
    '{"sites":[{"code":"D001","file":"src/a.ts","line":42,"note":"插在哪"}],"notes":"…"}',
    '只返回 JSON，不要解释。',
  ].join('\n')
}

/**
 * @param {{ worktree: string, codes: Array<object>, scope: object, launch: string }} input
 * @returns {string}
 */
export function qualityPrompt(input) {
  return [
    '你是 coder_debug 的质量运行期检查代理。',
    '',
    `工作区：${input.worktree}（独立副本，只做质量观测，和 Debug 插桩互不影响）`,
    ...stepLines('启动方式（按顺序执行；dsh-plugin 是让 DSH 调用那个工具）：', input.launch),
    '',
    ...scopeBlock(input.scope),
    '质量诊断码：',
    '```json',
    JSON.stringify(input.codes, null, 2),
    '```',
    '',
    '每条码的 targets 是它涉及的对象：按语义理解（可能是精确名字，也可能是一句描述），只在这些对象上插桩；空数组表示没限定。',
    ...CHECK_RULE,
    '只处理 check=runtime 的码；check=static 的码运行期观测不到，直接放进 skipped。',
    '',
    '任务：判断哪些质量码可以用**运行期指标**观测（调用次数、耗时、内存/分配、重复计算次数、循环次数等），',
    '然后只给这些码插桩。',
    '',
    '要求：',
    '1. 只改这个工作区；不要 git commit / push / checkout。',
    '2. 每个指标一行 JSON，追加到 `$CODER_LOG_DIR/quality.jsonl`：',
    '   {"code":"Q001","file":"src/a.ts","line":3,"metric":"calls","value":120,"unit":"次","threshold":100,"pass":false,"message":"…"}',
    '   - line 用**原始提交里**的行号；message 不写行号或文件路径；',
    '   - threshold / pass 只有在有明确阈值时才写，没有就只给 value。',
    '3. 无法用运行期指标衡量的码（注释缺失、命名、模块职责、结构）不要硬插，放进 skipped 并说明原因。',
    '4. 一个码都观测不了时 applicable=false，并且不要改任何文件。',
    '5. 不引入依赖，不改变业务逻辑与返回值；日志失败绝不能影响业务。',
    '',
    ...STEPS_RULE,
    '这里每一处 site 的 steps 是「怎么跑出这个指标」：启动 → 触发哪条路径 → 看 quality.jsonl 里哪一行的 value。',
    '',
    '返回 JSON：',
    '{"applicable":true,"sites":[{"code":"Q001","file":"src/a.ts","line":3,"metric":"calls","note":"插在哪","steps":["在仓库根执行 <启动命令>","调用 run() 两次","看 quality.jsonl 里 Q001 的 value 是否超过 threshold"]}],"skipped":[{"code":"Q003","reason":"注释缺失无法在运行期观测"}],"notes":"…"}',
    '只返回 JSON，不要解释。',
  ].join('\n')
}

/**
 * 复核：诊断记录出完之后，把复现步骤真走一遍，并且按证据排误报。
 *
 * 这是整条链路上唯一「照着别人的步骤再做一次」的节点，所以提示词要写清执行纪律：
 * 可以跑、不许改、超时就放弃。
 *
 * @param {{ worktree: string, launch: Array<object>, items: Array<object> }} input
 * @returns {string}
 */
export function verifyPrompt(input) {
  return [
    '你是 coder_debug 的复核代理。诊断记录已经产出，你要做两件事：',
    '1. 把每条的复现步骤**真的走一遍**，判断它能不能跑通；',
    '2. 按证据复核这条诊断本身，把误报挑出来。',
    '',
    `工作区：${input.worktree}（已经插桩并跑过一次的副本，可以直接执行）`,
    ...stepLines('启动方式（按顺序执行；dsh-plugin 是让 DSH 调用那个工具）：', input.launch),
    '',
    `诊断（共 ${input.items.length} 条，file / line 是原始提交里的位置）：`,
    '```json',
    JSON.stringify(input.items, null, 2),
    '```',
    '',
    '每一条都要回答三件事：',
    '- repro：',
    '  pass —— 照着 steps 做了一遍，能看到 message 描述的现象；',
    '  fail —— 步骤跑不通：命令不存在、路径或接口不对、缺前置条件、做完了现象对不上；',
    '  unknown —— 没法执行（需要外部服务、需要交互输入、单条命令会超过 60 秒）。',
    '- verdict：confirmed（这处问题确实存在）/ false-positive（不成立）/ uncertain（证据不够，拿不准）',
    '- note：一句话说清你实际做了什么、看到了什么。不要写诊断编号。',
    '',
    '什么时候才可以判 false-positive（给不出理由就不要判）：',
    '- 代码里根本没有这回事：行号指错了，同一文件附近也没有这处问题；',
    '- 规则不适用于这段代码（例如这条码 targets 写的是 Session，而这段代码处理的是别的类型）；',
    '- 报告的现象是插桩或工具自己制造的，不是业务代码的行为。',
    '',
    '执行纪律：',
    '1. 先读文件核对 file:line 到底是什么；行号偏了但同一文件里确实存在这处问题 → confirmed，并在 note 里指出正确行号。',
    '2. 能跑就跑：启动命令、HTTP 请求、CLI 参数这类操作可以做；**不要修改任何文件、不要装依赖、不要 git 操作**；',
    '   起了服务记得在结束前关掉；单条命令超过 60 秒就放弃，写 unknown。',
    '3. 命令在工作区根执行；本次运行的日志在 $CODER_LOG_DIR 下（写过的话）。',
    '4. 犹豫就写 uncertain——不要为了让报告干净而报 false-positive。',
    '',
    'repro=fail 时，用 steps 给出你**实际跑通了的**步骤（2–4 步，照着做就能看到）；其他情况不要给 steps。',
    '',
    '返回 JSON：',
    '{"checks":[{"id":1,"repro":"pass","verdict":"confirmed","note":"按 steps 跑了一遍，stdout 里确实有一行没经过 log()"},{"id":2,"repro":"fail","verdict":"confirmed","note":"步骤写的是 npm start，仓库里没有这个脚本；改成 node src/app.mjs 后能复现","steps":["在仓库根执行 node src/app.mjs","观察 stdout 的 port=3000"]}]}',
    '必须覆盖上面每一条 id，一条不多、一条不少。只返回 JSON，不要解释。',
  ].join('\n')
}

/**
 * @param {{ codes: Array<object>, entries: Array<object>, numbered: string[], run: object, logRel: string }} input
 * @returns {string}
 */
export function integratePrompt(input) {
  return [
    '你是 coder_debug 的诊断整合代理。',
    '',
    '下面是本次运行期收集到的诊断日志（已去重，每行前面是行号）和声明的诊断码。',
    '',
    '诊断码：',
    '```json',
    JSON.stringify(input.codes, null, 2),
    '```',
    '',
    `运行期日志（${input.logRel}）：`,
    '```jsonl',
    ...input.numbered,
    '```',
    '',
    `运行信息：退出码 ${input.run.exitCode ?? 'null'}${input.run.timedOut ? '（超时被杀）' : ''}，耗时 ${input.run.durationMs}ms。`,
    '',
    '任务：整合分类，输出最终诊断列表。规则：',
    '1. 只能引用日志里真实出现的条目，不许编造新的 code / file / line。',
    '2. evidence 写成 `logs/diagnostics.jsonl:<行号>`，行号就是上面每行前面的数字。',
    '3. message 改写成能直接给人看的一句话：哪里、违反了哪条、观察到了什么。不要自己写行号或文件路径——报告会按 file/line 渲染位置。',
    '4. verdict：violation（确实违反）/ pass（观察点通过、未违反）/ unknown（有日志但无法判断）。',
    '5. 声明了却没有任何日志的码由插件自动归入未触发，你不用重复列。',
    '6. summary 一句话总结本次诊断。',
    '',
    ...STEPS_RULE,
    '这里 steps 要能让别人重跑出这条日志：启动命令、要触发的操作/输入、在什么条件下会走到那个观察点。',
    '',
    '返回 JSON：',
    '{"diagnostics":[{"code":"D001","severity":"error","file":"src/a.ts","line":42,"column":5,"message":"…","verdict":"violation","evidence":"logs/diagnostics.jsonl:3","steps":["在仓库根执行 <启动命令>","请求 GET /health，让程序走到 readConfig()","观察到 stdout 出现未经 log() 的一行"]}],"summary":"…"}',
    '只返回 JSON，不要解释。',
  ].join('\n')
}
