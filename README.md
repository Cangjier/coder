# coder

DSH 插件 `coder`，注册三个工具，外加一个叫 **Coder** 的页面（左侧栏一项，页内四个 Tab）：

| 名字 | 做什么 |
| --- | --- |
| `coder_codes` | 从仓库文档提炼 Debug / Quality 两族诊断码，落在文档同目录的 `codes.jsonl`（有就复用） |
| `coder_debug` | 给定一个提交，复用上面那份诊断码，做一次静态审查和两套并行的运行期检查，最后交付一份带编号的诊断列表 |
| `coder_triage` | 把「发起排查」得出的解决方案写进这次运行目录（`solutions.jsonl`），页面「解决方案」读它 |
| 左侧栏 → Coder / 设计 | 把飞书设计文档放进页面里：宿主侧无头 Chrome 渲染成画面，可点可打字；弹窗就地打开、浏览记录按工作区记住 |
| 左侧栏 → Coder / 诊断码 | 编辑页（和「插件」「自动化任务」同一层）：挑工作区、看这个工作区里所有 `docs/codes.jsonl`、逐行改、校验后保存回原文件 |
| 左侧栏 → Coder / 诊断报告 | 只读：这个工作区**最新**一次 `coder_debug` 的报告，按诊断码分类展示；可一键「发起排查」 |
| 左侧栏 → Coder / 解决方案 | 排查结论（排掉误报后的真问题 + 怎么改），一条一个勾选框，勾上的可以「发起正式解决」 |

`coder_debug` 不重写「出码」那一段：它调的就是 `coder_codes` 用的同一个 `runCodesFlow`。
只想更新诊断码时用 `coder_codes`，不用跑整条诊断链。

它不自己判断代码：文档筛选、选主文档、生成诊断码、静态审查、插桩、整合，都是**一次一个独立子代理**；
插件只做机械动作：git、临时工作区、编译、运行、日志解析、证据核对、清理。

## coder_codes

### 输入

| 参数 | 说明 |
| --- | --- |
| `action` | `run`（默认）：生成或复用；`show`：只读现有的 `codes.jsonl`，不生成 |
| `repo` | 代码目录，必须是 git 仓库 |
| `change` | 从哪个提交读文档：`{mode:"commit",ref:"<sha>"}` 或 `{mode:"range",from,to}`；不传就是 HEAD（整仓模式：扫整棵树里的 `**/docs/*.md`） |
| `force` | `run` 时强制重新生成并覆盖已有文件（默认 false，覆盖手改内容要显式要求） |

### 输出：文档同目录的一份文件

```
<repo>/docs/codes.jsonl          # 诊断码，一行一条
```

（文档在 `packages/a/docs/x.md` 就落在 `packages/a/docs/`。）**别往仓库里放编辑页**：
要改它就用左侧栏的「诊断码」页，插件不再生成任何 HTML。

- **有就直接复用，一个子代理都不起**：`docs/` 下只有一份能解析的 `codes.jsonl` 时，连「筛文档 / 选文档」
  这两步也跳过——它们只是为了找到「该在哪份文档旁边生成」，文件已经在就不必找。
- **复用是只读的**：这份文件存在，就说明代码表由**用户**维护，插件只读它——不改写、不覆盖，
  跑一次检查不往仓库里落任何文件。
  改了文档但想重新生成，删掉或清空这个文件（空文件算「没有」），或者传 `force: true`（这是唯一会覆盖它的路径）。
- **多份时才需要选文档**：仓库里有 2 份以上 `codes.jsonl`（多包仓库）时分不清哪一份是这次的，
  才会先筛文档、选一份，再用它旁边那份；warnings 里会写清楚为什么还要选。
  选中那份文档旁边**没有** `codes.jsonl` 时不新建，直接报 `CODES_AMBIGUOUS`——新建等于替你决定哪一份算数。
- **没有才生成**：先出 D 码，再把 D 码交给 Q 码的代理。两族各读一遍同一份文档时，同一句规则会被
  两族各出一次（实测 6 条 Q 码里有 3 条和 D 码讲的是同一件事）；现在 Q 只找 D 没覆盖的、只能读代码
  判断的要求。提示词之外还有一道兜底：规则原文相同的 Q 码直接丢弃，warnings 里写明 `Q001→D002`。
  两族都齐了才原子写入。
- **能解析但有问题**（坏 JSON、重复码、缺字段、绝对路径…）直接报 `BAD_CODES_FILE`，
  消息里带行号，改好再跑——这份文件是人的输入，插件不替你猜。
- 生成是「要么全有要么全无」：两族有一族失败就整体不落盘，免得缺一族的文件被当成「已有」。
- 单独跑 `coder_codes` 时会自己建一个临时 worktree，跑完连同目录一起删掉；
  被 `coder_debug` 调用时则借用 Debug 线的那个工作区，不额外检出。

每一行的结构：

```json
{"code":"D001","kind":"debug","check":"runtime","enabled":true,"severity":"error","rule":"文档原文…","detect":"运行期观察什么","fix":"解决思路：怎么改才算满足它","targets":["Session#append"]}
```

`code` 前缀决定族（`D` = Debug，`Q` = Quality），`kind` 只是写下来的副本，两者不一致算错误。
`check` 是检查类型，和族是两件事——族说这条规则管什么，`check` 说怎么证实它：

| 字段 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `check` | `static` / `runtime` | D 码 `runtime`、Q 码 `static` | static = 读代码就能判定；runtime = 必须跑起来观察 |
| `enabled` | `true` / `false` | `true` | `false` 的码留在文件里，但**不参与诊断**：不进提示词、不可能产生诊断 |

没有 `title`：一条码说什么，看 `rule`。

`fix` 是**解决思路**：这条规则被违反时怎么改才算满足它（一句做法，不是「修复它」这类空话）。
它是生成时的必备字段 —— 代理漏了会带着问题重打回一次，两次都没有就让这次生成失败；
读老文件时它可以为空（那些文件本来就没有这个字段），页面里可以随时补上。

`targets` 是**每条码涉及的对象**，可以是精确名字，也可以是一句泛化描述；空数组表示没限定：

| 字段 | 含义 | 为空 |
| --- | --- | --- |
| `targets` | 这条码涉及什么，例如 `["Session#append"]`、`["所有 XxxService"]` | 任何位置都算 |

**它只按语义理解，不做机械匹配**：写 `Session#append` 就是那个方法，写「所有 XxxService」就是这一类；
机器分不清这两者，所以插件不拿它做字符串过滤，也不因此打回诊断 —— 判断交给读代码的人或代理。

### 页面（左侧栏「Coder」：四个 Tab）

插件带一个浏览器一半（`client.js`，`dsh.client` 声明）。**整个 app 叫 Coder**，左侧栏只有一项，
点开是整页，页内顶部一行 Tab（tab 栏左边就是名字 Coder）：`设计` / `诊断码` / `诊断报告` / `解决方案`。

- `sidebar.panellist`：`coder`（order 20，图标是一页码），排在「自动化任务」后面；
- `main` 的 key 也是 `coder`：点左侧栏那一项，中间主区域渲染这整页；
- **工作区只有一个选择器**：在 Tab 栏右边（`tabBarExtraContent` 的右侧，贴着 Tab），换一次四个 Tab 都跟着换，
  各页自己不再放选择器；选中的仓库记在 `localStorage["coder.page.v1"]`，刷新/重启之后还是它。

页面用 **React 19 + antd 6**。第一个 Tab（设计）是一个**内置浏览器**：宿主侧一个无头 Chrome，
每个工作区一个浏览器会话，会话里可以开多个标签页；页面顶部是标签栏（新建 / 切换 / 关闭）加地址栏。

- **画面**：宿主 `Page.startScreencast` 出 JPEG 帧，经 SSE `/coder/api/browser/frames` 推给页面，
  画在 `<canvas>` 上；点击/滚轮/键盘反过来经 `/coder/api/browser/input` 投给 CDP
  （`Input.dispatchMouseEvent` / `insertText` / `dispatchKeyEvent`）。
- **面板多大，视口就多大**：面板尺寸变化后 200ms 防抖，宿主用 `Emulation.setDeviceMetricsOverride`
  把当前标签页的视口改成面板尺寸，帧也按这个尺寸出，canvas 1:1 填满面板 —— **没有黑边、没有 letterbox**，
  点击坐标天然 1:1。这是"看不出差异"的关键；`getDisplayMedia` 在 headless 里固定 800×600（4:3），
  做不到任意尺寸，所以没有走视频那条路。
- **多标签页**：`+` 用 `Target.createTarget` 开新标签，点标签用 `Target.activateTarget` 切换（画面流跟着新标签走），
  `×` 用 `Target.closeTarget` 关闭并自动切到相邻标签；超过 `browserMaxTabs`（默认 8）时，
  自动关最久没用的非当前标签。同一标签里的普通跳转不会新建标签，旧页面直接被替换。飞书里的 `window.open` /
  `target="_blank"` 收编成同一会话里的新标签页，就地切换，不再跳系统浏览器。
- **浏览记录是真的**：`Page.frameNavigated` / `Page.navigatedWithinDocument` 让宿主知道每个标签每一跳的地址
  （包括单页应用换文档），重进 Coder 时按最后那个地址恢复。
- 工具条：标签栏、地址输入框（回车即载入）、「载入」「飞书文档主页」「回到设计文档」「重新载入」「新窗口打开」；
  「飞书文档主页」在新标签里打开（同一租户的 `<租户>/drive/home/`，没有地址就用 `www.feishu.cn/drive/home/`）；
- 地址只认 `http(s)`：只写 `xxx.feishu.cn/docx/…` 也会补成 `https://`；不是飞书域名只给一条提示，照样打开；
- 地址按工作区各记一份，存在 `localStorage["coder.page.v1"]` 的 `design` / `designDraft` / `designLast` 里 ——
  飞书文档是私人链接，不写进仓库；`designLast` 是宿主报回来的「最后浏览到哪」，切去对话、刷新、重启之后回到那一面；
- **光标跟着页面走**：移动时按 120ms 节流向宿主查 `document.elementFromPoint(...)` 的 `cursor`，
  本地画面贴成手型 / I 形 / 抓取等；无头页开了 `Emulation.setFocusEmulationEnabled`，输入框的插入光标与 `:focus` 样式正常。
- **画面**：宿主 `Page.startScreencast` 出 JPEG 帧，经 SSE `/coder/api/browser/frames` 推给页面，
  画在 `<canvas>` 上；点击/滚轮/键盘反过来经 `/coder/api/browser/input` 投给 CDP。
- **面板多大，视口就多大**：面板尺寸变化后 200ms 防抖，宿主用 `Emulation.setDeviceMetricsOverride`
  把当前标签页的视口改成面板尺寸，帧也按这个尺寸出，canvas 1:1 填满面板。
- **尺寸跟面板走**：面板尺寸变化时防抖调 `Browser.setWindowBounds`，视口与帧跟着变；
  帧尺寸没有 4:3 限制，宽面板就是宽画面，页面里的滚动条也是页面自己的（和真浏览器一样）。
- **不需要窗口**：无头 Chrome 没有可见窗口，画面来自标签页自己的渲染，不是屏幕。
- **第一次要在画面里登录一次飞书**：无头 Chrome 用的是自己的 profile（默认 `~/.coder/browser-profile`，
  可用 `browserProfileDir` 改），登录态存在那里，之后不用再登。
- 中文输入：键盘先落在画面上的隐藏输入框，输入法合成完的文本再 `insertText` 进去，所以能打中文；
  画面是远程渲染，点击/滚动有 100–300ms 的延迟，原生右键菜单、拖拽选择这类操作会比真浏览器弱一些。
- 输入框失焦会把还没载入的原文记进 `designDraft`；「新窗口打开」打开的就是当前标签这一页。

第二个 Tab（诊断码）是主从布局：

- 顶部工具条：文件下拉（有多份 `codes.jsonl` 时）、
  「重新载入」「全部启用」「全部禁用」「移除未启用」「全部清空」「导入」「发起诊断」；
- 左侧卡片：这个文件里的每一条码一行（`code`、`Debug`/`Quality` 标签、`未启用` 标记、校验失败的红标，
  下面一行是 `severity · check · rule` 摘要，再下一行是 `↳ 解决思路`），点一行在右边编辑；
- 右侧卡片：`码` 单行输入、`检查` 分段控件（Static / Runtime）、`级别` 下拉、`启用` 开关、上移/下移/删除，
  `rule`、`detect`、`fix` 三个自适应高度的文本框（`fix` 就是解决思路）；`targets` 是**一条一行的列表** ——
  每行一个精确名字或一句描述、行尾 × 删掉，下面输入框回车或点 + 添加（去首尾空白、自动去重）。
- **`targets` 旁边有「让 DSH 搜集」**：点一下在当前工作区开一个对话（宿主自己的 `sessionController`），
  把「这条码涉及哪些 class / interface / method」交给它，**结果不写文件**：
  - 接口只开工，立刻返回 `jobId`（任务存在服务端，跑几分钟也不会挂着 HTTP）；
  - 那个对话做完调用 `coder_job` 工具把 `targets` 交回任务表；
  - 页面用 **SSE** 等这一条推送（`GET /jobs/<id>/events`），到了就把结果填进 targets 输入框 ——
    是**未保存的改动**，保不保存由你决定；
  - **中途离开页面也不会丢**：jobId 存在 `localStorage`，回来（或刷新）时先查一次
    `GET /jobs/<id>`，还在跑就重新订阅，已经完成就直接填回来；Host 重启导致任务没了会提示重新点一次；
  - **不设超时**：那个对话跑多久就等多久 —— 任务只按 TTL（1 小时，从开工算起）清理，
    清的时候正在等它的页面会先收到一次「还没有结果」，不会一直转圈；回来再点一次即可。
- **「发起诊断」**（右上角）：在当前工作区开一个对话，让它跑一次 `coder_debug`（整个仓库、HEAD），
  跑完用人话讲结论。接口只开会话就返回 202，诊断要几分钟，页面不等它 —— 结果在那个对话里看。

第三个 Tab（诊断报告）只读 `<repo>/.coder/runs/` 里**最新**的那一次，**按诊断码分类**：

- 顶部：「重新载入报告」（工作区用 Tab 栏右边那个）；
- 先是一张运行摘要卡：`runId`、级别计数、`N 个码 · M 条诊断`、范围（整仓 / 区间 / 单提交，来自 `summary.json`）、
  复核结论（确认 / 存疑 / 排除误报）；老运行没有 `summary.json` 就少这两行；
- 下面分**两列**：左边是诊断码列表（一行一个码：`码 + Debug/Quality + 命中条数 + 两行以内的规则原文`），
  右边是选中那个码的全部诊断条目 —— 每条先给**编号**（`#N`，就是这次运行里 `diagnostics.jsonl` 的 `id`；报告里说「第 N 条」就是它），
  再给 `级别`、`文件:行`、存疑标记、message、复现步骤、复核备注；
  两列各自滚动，左边点一下右边就换；
- 组按码排序，组内先按级别（error → warning → info）、再按文件与行号；
- 只读：这一页不发任何写请求，报告本身还是那次运行的产物。
- **「发起排查」**（右上角）：在目标工作区开一个对话，让它逐条核对这份报告 ——
  **先排除误报**（证据不足、`verification` 是 uncertain、规则对不上代码），只对确认的真实问题给解决方案
  （属于哪个码、问题是什么、怎么改、涉及哪些文件、风险与把握），做完必须调用 `coder_triage` 把方案交回来。
  这一轮**不许改源文件**，只排查、出方案。结果落在 `<repo>/.coder/runs/<runId>/solutions.jsonl`。
- 发起之后页面上会留一条状态：**还在跑**（会话 id + 发起时刻）/ **已结束**（提示去「解决方案」页看），
  切 Tab、离开再回来都还在 —— Host 那边记着这次对话并按会话状态给 `running`，页面自己也留了一份
  （`localStorage["coder.launches.v1"]`），Host 重启过也至少知道「发起过」。

第四个 Tab（解决方案）读的也是这次运行目录，同样**分两列**：

- 左边：诊断码（一行一个码：`码 + Debug/Quality + 方案条数 + 两行以内的规则原文`），点一下右边就换；
- 右边：选中那个码的**全部方案**，每条一个勾选框 —— 醒目的 `#N` 编号、标题（加粗加大）、
  风险/把握标签、问题、方案、涉及的文件；勾上以后那张卡整体换成主题色底；
- `问题` / `方案` 两段文字按「句子成段、条目成行」排版：空行分段、`-`/`1.` 开头的行变成列表项，
  长句按句号攒成大约 80 字一段，不再是一坨连着的字；
- 勾选**按「工作区 + 运行」分开**记在 `localStorage["coder.picks.v1"]`，切 Tab、刷新都还在；
- 「全选 / 清空勾选」；「**对勾选的发起正式解决**」在目标工作区开一个对话，把勾中的方案交给它去真的改代码
  （要求跑测试/构建确认，不许动 `.coder/runs/` 的历史报告和 `docs/codes.jsonl`）；
- 一个都没勾选时按钮是灰的；服务端也会拒绝空的勾选（400）；
- 「发起正式解决」之后同样留一条状态提示（还在跑 / 已结束）。

诊断报告右列里，每条诊断的 `#N` 编号是**反色胶囊**（浅色主题深底浅字、深色主题反过来；不跟品牌色走 ——
宿主品牌是墨色，跟着它会变成黑底黑字）、message 用 14px 加粗的正常色文字 ——
编号和内容都比元信息（级别、文件行号、复核标记）显眼。

「诊断码」页上那两个开对话的按钮，开出来的会话都**登记在目标工作区下面**（`sessionController.create({ workspaceId })`，
而不是只给 `cwd`），所以左侧栏里它们出现在那个工作区的分组里，不是「未分组」。
  目录还没登记成工作区时先 `workspaceController.create` 登记一个（幂等）；两个服务都没有的老 profile
  退回到只带 `cwd`，对话照开，只是没有分组。
- 「全部启用 / 全部禁用」只改 `enabled`：一次把当前文件的所有码打开或关掉，右侧单条的开关仍然可以单独调；
  两种状态已经全部一致时对应按钮是灰的；
- 「移除未启用」把 `enabled: false` 的码**整条删掉**（不是只关开关）：二次确认、只改内存，点「保存」才落盘；
  一条未启用的都没有时按钮是灰的；
- 「全部清空」把这份文件的行清成 0 条（二次确认，保存后才落盘）；
- 「导入」读一个本地文件替换当前内容，文件类型不限（默认任意文件）：
  - **JSON / JSONL / `{codes:[…]}`**：字段名不一定要和我们一样，`id`/`编号`、`description`/`message`、`level: 错误`、
    `disabled: true`、`解决思路`/`fix`、`D1` 这种短编号都认；认不出的字段原样留着。什么都没有的条目补默认值（`detect` 写成「读代码判断它是否做到」）。
  - **markdown / 纯文本**：把 `- …`、`* …`、`1. …` 这样的要求条目逐条读成 **Q 码**（检查方式默认「读代码」），
    标题、引用、代码块里的内容跳过；导入后提示「从文本里认出了 N 条，保存前先核对」。
  - **二进制（docx / doc / pdf / 图片）**：读不出内容，直接告诉你先导出成文本或 markdown。
  - 认不出的文件只报一条错误，现有内容不动；导入和清空都只改内存，点「保存」才写回 `codes.jsonl`；
- 改动即时校验（码格式、族与前缀一致、重复、必填、路径合法性）：有问题就在顶部和那一行同时标出来，
  「保存」是灰的；底部工具条显示「没有改动 / 有未保存的修改」与条码统计；
- **会记住上次看的是哪个工作区、哪份文件**：存在 `localStorage["coder.page.v1"]`（只存路径），
  所以切到对话再回来、刷新页面、甚至重启 DSH 都回到原处。读回来时会核对：
  记着的工作区已经不在了就回落到默认工作区，再回落到第一份；文件同理，每个工作区各记各的。
  同一个 key 里还存着**每个工作区的设计文档地址**（`design`，见第一个 Tab）。
- **未保存的改动会留成 entry 级草稿**：切到对话或别的面板再回来，草稿会恢复并提示
  「已恢复上次离开本页时的未保存草稿」；保存、放弃修改或点「重新载入」都会清掉它。
  草稿按「工作区 + 文件」分开存，只在这一次页面生命周期里有效（刷新或插件卸载就没了）。
- 「保存」把整份文件原子写回，内容没变就不动文件；「放弃修改」回到磁盘上的版本。

跟随宿主主题：`body[data-ds-dark-theme]` → antd 的 dark 算法，品牌色直接读宿主的
`--dsw-alias-brand-primary`，所以亮/暗切换与换主题都不用另配。

一点细节：宿主的品牌色是墨色，antd 会拿它推导下拉「选中项背景」（`controlItemBgActive`），
推出来是 `#404040` 配黑字，等于看不清；所以 `Select` 的选中/悬停行用主题里的中性色显式覆盖
（组件 token 加一条只作用于 `.ant-select-dropdown` 的样式，亮暗两套都算好）。

页面自己不碰文件系统：它走同一个源上的 `/coder/api`

| 接口 | 作用 |
| --- | --- |
| `GET /coder/api/state` | 工作区清单 + 默认工作目录 |
| `GET /coder/api/codes?dir=<工作区>` | 列出并读出这个工作区里的每一份 `codes.jsonl` |
| `PUT /coder/api/codes` | `{dir, rel, rows}`：校验后原子写回，问题原样返回（400） |
| `POST /coder/api/collect` | `{dir, rel, code}`：开工，返回 `{jobId}`（202）；结果由对话用 `coder_job` 回填 |
| `POST /coder/api/debug` | `{dir}`：在工作区里开一个对话跑 `coder_debug`，返回 `{sessionId}`（202），不等诊断跑完 |
| `GET /coder/api/reports?dir=<工作区>` | 这个工作区**最新**一次运行：摘要 + 全部诊断行 + 这次用的码快照（没有运行过就 `run:null`） |
| `POST /coder/api/investigate` | `{dir}`：开一个对话排查最新报告、出方案；返回 `{sessionId, runId}`（202） |
| `GET /coder/api/solutions?dir=<工作区>` | 最新一次带方案的运行：`{runId, solutions, codes}`（`codes` 是这次运行的码快照，左边那列用） |
| `POST /coder/api/fix` | `{dir, runId, ids}`：把勾选的方案交给一个对话去真改；返回 `{sessionId, count}`（202） |
| `POST /coder/api/browser/open` | `{dir, url}`：起/复用这个工作区的无头浏览器并打开 url（只收 http(s)） |
| `GET /coder/api/browser/tabs?dir=<工作区>` | 标签页列表与当前标签 |
| `POST /coder/api/browser/tabs/new` | `{dir, url}`：开一个新标签并切过去 |
| `POST /coder/api/browser/tabs/activate` | `{dir, id}`：切到某个标签 |
| `POST /coder/api/browser/tabs/close` | `{dir, id}`：关掉某个标签 |
| `POST /coder/api/capture/start` | `{dir}`：在当前标签里启动自捕获，返回 offer 与捕获尺寸 |
| `POST /coder/api/capture/answer` | `{dir, sdp, type}`：把页面的 answer 写回标签 |
| `POST /coder/api/capture/candidate` | `{dir, candidate}`：把页面的 ICE 候选写回标签 |
| `GET /coder/api/capture/candidates?dir=&since=` | 标签侧收集到的 ICE 候选 |
| `POST /coder/api/capture/stop` | `{dir}`：停掉当前标签的捕获 |
| `GET /coder/api/capture/state?dir=` | 捕获状态（是否在投、是否已给 offer） |
| `GET /coder/api/browser/state?dir=<工作区>` | 这个工作区的浏览器状态：`running`、标签页列表、当前 `url`/`title`、最后一帧 |
| `POST /coder/api/browser/viewport` | `{dir, width, height}`：把视口改成面板尺寸（画面与输入都按它） |
| `POST /coder/api/browser/cursor` | `{dir, x, y}`：这个点下面元素的 `cursor`（页面光标形状） |
| `POST /coder/api/browser/navigate` | `{dir, url}`：让画面导航到另一个地址（内部跳转就用它） |
| `POST /coder/api/browser/reload` | `{dir}`：刷新当前页面 |
| `POST /coder/api/browser/input` | `{dir, events}`：鼠标/滚轮/文本/按键，坐标是视图逻辑坐标 |
| `GET /coder/api/browser/frames?dir=<工作区>` | 帧流（SSE）：`state` / `frame` / `closed`，一条连接一直推 |
| `GET /coder/api/activity?dir=<工作区>` | 页面开出去的排查/解决对话：`{kind, runId, sessionId, at, running}`，`running` 说还在不在跑 |
| `GET /coder/api/reports/<runId>?dir=` | 一次运行的摘要与全部诊断行（页面里直接看） |
| `GET /coder/api/jobs?dir=&rel=` | 这个文件的搜集任务列表（页面回来时找「有没有还没取回的结果」） |
| `GET /coder/api/jobs/<id>` | 一条任务的状态与结果（`running` / `done` / `failed`） |
| `GET /coder/api/jobs/<id>/events` | 这条任务的 SSE：先推当前状态，结束时再推一次 |

接口只允许**已登记的工作区**里的 `<目录>/docs/codes.jsonl`：目录不在工作区表里 403，
`rel` 不是 `docs/codes.jsonl` 或含 `..` 400。页面和插件用的校验规则是同一份
（`src/codes-client.js` 被一起打进 `client.js`）。

路由是**等 `webServer` 就绪之后**才挂的（`ctx.inject(['webServer'], …)`）：冷启动时它常常比本插件晚激活，
直接 `ctx.get('webServer')` 会拿到 `undefined`，路由就永远不在，页面只会报 `404 Not Found`。
非 Web profile 没有这个服务，这段就一直是待命状态，工具不受影响。

`client.js` 是构建产物（`npm run build:client`，esbuild；约 600KB）：`react` / `react-dom` 保持 external
用宿主那一份（hooks 与渲染器必须是同一个实例），antd、图标和我们的代码打进同一个文件 —— 运行期仍然零依赖。
`npm test` 会检查它是不是最新的，并把整包真的跑一遍（假模块表 + 真 React，SSR 渲染出 antd 页面）。

包里带了一层兜底：万一浏览器一半初始化就抛错，左侧栏仍然出现「诊断码」，点开是一张写着
错误栈的卡片，而不是让这一项悄悄消失。

### coder_job（搜集任务回填用）

那个被开出来的对话做完要调它，把结果交给服务端任务表：

| 参数 | 说明 |
| --- | --- |
| `action` | `submit`（交结果）/ `fail`（说明为什么没有结果） |
| `jobId` | 提示词里给的任务 id |
| `targets` | submit：class / interface / method 名字或一句描述（去空白、去重） |
| `message` | fail：原因 |

它只写内存里的任务表，不碰仓库；任务表有 TTL（1 小时）和条数上限（50），Host 重启就清空。

## coder_debug

### 输入

| 参数 | 说明 |
| --- | --- |
| `repo` | 代码目录，必须是 git 仓库 |
| `change` | **不传 = 整个仓库**；`{mode:"commit",ref:"<sha>"}`（对父提交）或 `{mode:"range",from,to}`；不接受未提交改动 |
| `build` | 构建步骤 `{type,entry,input?}[]`：按顺序执行，一步失败就停；空 = 跳过构建 |
| `launch` | 启动步骤（同上形状），必填且至少一步；两套检查各跑一次 |
| `runId` | 仅 `status` / `report` / `clean` 用 |

`action`：`run`（默认）；`status` 列 run；`report` 读一个 run 的诊断；`clean` 清掉残留临时目录。

`coder_debug` **本质是一个子代理**：一次调用就是把一件要跑几分钟的调查交出去——它会起若干个互不共享
上下文的子代理、开两套临时工作区、各自编译与运行，最后只回一份结论。所以「调一次、等结果」才是它的用法：
不要把它和依赖它结论的工作交错，也不要对同一个仓库并行跑两份。它必须在 agent 上下文里调用——
调用者会成为它所有子代理的父会话，从裸脚本里调会得到 `NO_AGENT`。

### 构建 / 启动：步骤列表

`build` 与 `launch` 都是 `{type, entry, input?}[]`，每一步要么是一条命令，要么是「让 DSH 调某个插件」：

```json
{
  "build": [
    {
      "type": "dsh-plugin",
      "entry": "xl_build",
      "input": { "paths": ["{{worktree}}/src"] }
    }
  ],
  "launch": [{ "type": "cmd", "entry": "node src/app.mjs" }]
}
```

| 字段 | 含义 |
| --- | --- |
| `type` | `cmd`（默认）：在工作区里跑一条 shell 命令；`dsh-plugin`：让 DSH 调用名为 `entry` 的工具（插件） |
| `entry` | `cmd` 是命令行；`dsh-plugin` 是 DSH 工具名，例如 `xl_build` |
| `input` | 仅 `dsh-plugin`：那个工具的入参，**直接给 JSON 对象**；`cmd` 给了会报错（命令本身写在 `entry`） |

- 两种步骤按顺序执行、共用同一套超时与日志（`step-N/stdout.log`）；`build` 里一步失败就算构建失败（不运行），
  `launch` 里通常最后一步是长驻程序，到点被杀。
- `entry` 里的字符串、以及 `input` 里任何一层字符串中的 `{{worktree}}`，执行前都会换成当次工作区的绝对路径。
- `input` 也接受 JSON 字符串（旧写法），内部一律当对象用；空对象等于没给。
- 一个字符串等价于只有一步的 `cmd`，旧写法继续可用。

### 范围：整仓 / 区间 / 单个提交

```
不传 change                → mode: all      HEAD 的完整文件树
{mode:"commit", ref:"<sha>"} → mode: commit  该提交对它的父提交
{mode:"range", from, to}    → mode: range   一段区间
```

`{ref:"<sha>"}` 会被推成 `commit`，`{from,to}` 会被推成 `range`，不用为了一个明显的意思多写一个 `mode`。

**整仓模式没有「改动文件」这个概念**：范围就是这个提交的完整文件树，提示词里不列文件清单，
而是让代理按每条码的 targets、规则里提到的名字自己在工作区里找。静态审查、插桩、质量检查三处
都按这个范围走。给了 `change` 才会把改动文件列表写进提示词（超过 200 个只列前 200 个，并注明还有多少个）。

两种模式都只读**提交**：整仓模式取的是 HEAD 的树，工作区里没提交的改动不参与——
诊断的输入必须是一个确定的提交，`diagnostics.jsonl` 里的行号就是对着它校验的。想诊断手头没提交的代码，先提交。

### 流程

```
前置：Debug 线的工作区（worktree）
① 出码：runCodesFlow（= coder_codes）
     docs/codes.jsonl 已在  → 直接复用：0 个代理、不建临时工作区、不往仓库写任何文件
     不在                  → 筛文档 → 选文档 → 先 D 码、再 Q 码（Q 拿 D 当输入）→ 写文件
② 两个工作区就绪后，两条互不等待的线同时起跑：

  D 线 静态审查 D ─→ 插桩 ─→ 编译 ─→ 跑一次 ─→ 整合日志
  Q 线 静态审查 Q ─→ 按需插桩指标 ─→ 编译 ─→ 跑一次 ─→ 收集指标

③ 复核（诊断记录出来之后、交付之前）：逐条照 steps 走一遍 + 按证据排误报
   步骤跑不通 → 换成实测过的步骤（标「步骤已改写」）
   判成误报   → 不进交付物，理由进报告的「已排除」一栏

后置：合并 → .coder/runs/<runId>/ 下的 codes.jsonl / diagnostics.jsonl / diagnostics.html → 删两套临时目录
```

出码是两族共用的前置（只有一份 `codes.jsonl`），**出码本身是串行的**（D 先、Q 后，避免同一规则出两遍），
之后两条线不共享任何步骤：不共用工作区、不共用编译、不共用运行、不共用日志，
一条线慢或失败不会让另一条线停下来等它。

`codes.jsonl` 里 `enabled: false` 的码不参与诊断：不进任何提示词，也就不可能出现在结果里；
它们只是留在文件里（规则、说明都还在），方便你临时关掉一条而不丢定义。整份文件全被关掉时只给一条警告，不跑空流程。

两族码走两条路：

- **D 码**：静态审查给「嫌疑」，运行期给「证据」。同码、同文件、行号相差 3 行以内算被确认；
  确认过的只保留运行期那条，没确认的以 `source: "static"` 留在结果里。
  `check: "static"` 的 D 码运行期看不出来，不插桩，静态结论就是最终结论。
- **Q 码**：静态审查给结论（`source: "static"`）。质量运行期检查**按需**进行——
  只有能用指标衡量的码（调用次数、耗时、重复计算、循环次数）才会插桩，也就是 `check: "runtime"` 的那些；
  注释缺失、命名、结构这类无法在运行期观察的码（`check: "static"`）由代理显式跳过。
  一个都观测不了就不建第二套工作区、不跑。

### 复核

诊断记录一出来（编号之前、写文件之前），还会过一个独立代理，在 Debug 线的工作区里做两件事：

1. **复现步骤能不能跑通**：照着 `steps` 真的做一遍——启动、请求、打开到那一行。
   - `pass`：做了，现象对得上；
   - `fail`：命令不存在、路径不对、缺前置条件、做完现象对不上 → 代理要给出**它实测跑通的步骤**，
     插件直接换掉原步骤，并标记 `repro: "rewritten"`；
   - `unknown`：没法执行（外部服务、交互输入、单条命令超过 60 秒）。
2. **是不是误报**：
   - `confirmed`：确实存在；行号偏了但同一文件里确实有这处问题，也算 confirmed，note 里会指出正确行号；
   - `false-positive`：**不进 `diagnostics.jsonl`**，改放进 `diagnostics.html` 的「已排除」一栏，附理由；
   - `uncertain`：拿不准，保留但标成存疑。

执行纪律写在提示词里：可以跑、**不许改文件、不许装依赖、不许 git 操作**，起服务记得关掉。

复核是**软节点**：它失败（两次输出不合格）不会让整次诊断失败——前面的结果照常交付，
`warnings` 里写明「这些诊断没有经过复核」，行上不带 `verification` 字段，报告里也照实说。

### 交付物

```
<repo>/.coder/runs/<runId>/
  codes.jsonl          # 本次实际用的诊断码快照
  diagnostics.jsonl    # 每条诊断一行（机器可读）
  diagnostics.html     # 只读视图：两族码 + 全部诊断，可筛选
  summary.json         # 本次运行的摘要：范围、复核结论、计数（页面「诊断报告」读它）
  solutions.jsonl      # 「发起排查」交回来的方案（页面「解决方案」读它；没有就不存在）
```

两个 JSONL 是原始交付物，HTML 是同一份数据的查看页：单文件、零外部依赖，双击即可打开。
页面顶部是仓库/范围/文档/诊断码来源摘要，中间是诊断表（可按级别或来源筛选，每条诊断下面带复现步骤），
下面是诊断码表（含每条码涉及的对象与命中数），底下是 warnings。没有 state.json、没有日志目录。
`summary.json` 是 HTML 的机器可读对应物（同一份 `summaryOf`），给左侧栏那个页面用，不用解析 HTML。

`diagnostics.jsonl`（`id` 是本次运行的编号，按输出顺序从 1 开始；`source` 区分来源）：

```json
{"id":1,"code":"D001","kind":"debug","severity":"error","file":"src/app.mjs","line":4,"column":11,"message":"…","source":"runtime","verdict":"violation","steps":["在仓库根执行 node src/app.mjs","访问 GET /health，让程序走到 readConfig()","看 stdout 里没经过 log() 的那一行"],"verification":"confirmed","repro":"pass","reproNote":"按 steps 跑了一遍，stdout 里确实有那一行"}
{"id":2,"code":"Q002","kind":"quality","severity":"error","file":"src/app.mjs","line":11,"column":null,"message":"…","source":"static","confidence":"high","steps":["打开 src/app.mjs:11","看 run() 里塞了几件事"],"verification":"uncertain","repro":"unknown","reproNote":"需要外部支付网关才能走到这段"}
{"id":3,"code":"Q001","kind":"quality","severity":"warning","file":"src/app.mjs","line":3,"message":"…","source":"quality-runtime","metric":"calls","value":120,"unit":"次","threshold":100,"pass":false,"steps":["在仓库根执行 node src/app.mjs","触发两次 run()","看 quality.jsonl 里 Q001 的 value"],"verification":"confirmed","repro":"rewritten","reproNote":"原步骤写的 npm start 不存在，改成 node src/app.mjs 才跑通"}
```

**每一条诊断都带 `steps`（复现步骤）**：别人照着做，就能亲眼看到这条诊断说的是什么。

- 来源不同，步骤的写法也不同：运行期诊断写「启动 → 触发哪条路径 → 看哪里」；
  静态诊断写「打开哪个文件哪一行、看什么」；质量指标写「怎么跑出这个数值」。
- 由对应的代理给出（整合 / 静态审查 / 质量插桩计划），插件校验：必须是非空字符串数组、
  最多 6 步、每步不超过 300 字；缺了会被打回重来一次，两次都没有就让这次运行失败。
- `diagnostics.html` 每条诊断下面挂一个有序列表；`report` action 的文本在每个 `#N` 行后面跟一行
  `复现：1) …；2) …`。
- 复核结论同样落在每一行上：`verification`（confirmed / uncertain）、`repro`（pass / fail / rewritten / unknown）、
  `reproNote`（它实际做了什么、看到什么）；被判成误报的不在这里，只在 `diagnostics.html` 的「已排除」一栏。

编号就是「第几条诊断」：`diagnostics.html` 第一列是 `#N`，行锚点是 `id="dN"`；
`report` action 返回的文本行也以 `#N` 开头，方便对话里直接引用某一条。

| source | 含义 |
| --- | --- |
| `runtime` | Debug 码在运行期观察到的结果（`verdict`: violation / unknown；pass 不写入） |
| `static` | 静态审查的结论（质量码全部在此；Debug 码只保留未被运行期确认的） |
| `quality-runtime` | 质量指标的实测值（`pass: true` 的达标项不写入） |

## 临时目录

```
<temp>/coder-debug/<runId>/          # coder_debug：一次诊断
  d/            # Debug：repo/（worktree）+ build/ run/ logs/
  q/            # 质量：repo/（另一个 worktree）+ build/ run/ logs/

<temp>/coder-debug/codes-<runId>/    # coder_codes 单独跑时的临时工作区，跑完即删
  repo/
```

两者都是同一提交上的独立 git worktree（分支 `coder/<runId>`、`coder/<runId>-quality`、`coder/codes-<runId>`），
各自独立编译、独立运行、独立日志。运行结束整套删除；`clean` 用于清理 `coder_debug` 异常中断留下的目录。

## 安全边界

- 源仓库只读：所有代码改动在临时 worktree 里；运行前后各拍一次指纹（HEAD + 分支 + status，
  排除 `.coder/` 以及 `docs/codes.jsonl`——这是插件自己生成的文件），不一致写进 warnings。
- worktree 里 hooks 关闭（`core.hooksPath=`），提交 `--no-verify --no-gpg-sign`，不 push。
- 本质上是「按子代理写出的代码执行 launch」，等于有意为之的代码执行。
- `docs/codes.jsonl` 是仓库里的持久物：建议提交它（团队共享一套码），不想入库就加进 `.gitignore`。
- **`docs/codes.jsonl` 一旦存在，就归用户**：插件只读它，不改写、不覆盖；
  检查跑完 `docs/` 连 mtime 都不变。想重新生成就删掉/清空它，或者在 `coder_codes` 上显式 `force: true`。
- 编辑页的写操作是**显式**的：只有你在页面里点「保存」才会写，写之前先整份校验，
  而且只写已登记工作区里的 `docs/codes.jsonl`（见上面「页面」一节的接口表）。
- 「设计」页的无头浏览器：监听端口只在 `127.0.0.1`（随机端口，由 Chrome 自己写进 profile 目录），
  只导航 `http(s)`，输入只接受页面发来的鼠标/滚轮/文本/按键；插件卸载时空闲 30 分钟以内的会话会被关掉。
  **飞书的登录态**存在 `~/.coder/browser-profile`（可用 `browserProfileDir` 改）—— 那是这台机器上的一个
  真实浏览器 profile，不要把它拷给别人，也不要放进仓库。

## 目录

```
index.mjs              插件入口（apply / inject tools / 挂 /coder/api）
client.js              浏览器一半（构建产物）：左侧栏一项 Coder + 页内四个 Tab（设计页是带标签栏的内置浏览器）
src/codes-client.js    codes.jsonl 的纯逻辑：解析、校验、序列化、targets、移除未启用（构建时内联进 client.js）
src/codes.mjs          docs/codes.jsonl 的位置、读写
src/codes-files.mjs    编辑页的 Host 一侧：扫工作区、读、校验后原子写
src/codes-flow.mjs     runCodesFlow / inspectCodes：文档 → 诊断码
src/client/app.jsx      编辑页源码（React + antd，构建进 client.js）
src/client/entry.js     打包入口：只导出插件工厂
src/browser.mjs        设计页的无头浏览器：起 Chrome、CDP 连接、多标签、WebRTC 捕获、帧流、输入投递
src/web.mjs            /coder/api：state / codes / collect / debug / reports / solutions / activity / browser（帧流 + 输入）/ jobs
src/reports.mjs        读 .coder/runs 下的运行与诊断行（页面「诊断报告」用）
src/solutions.mjs      读写 solutions.jsonl（页面「解决方案」用）
src/jobs.mjs           「让 DSH 搜集」的任务表：开工、回填、订阅、TTL
src/flow.mjs           coder_debug 的编排
src/program.mjs        build / launch 的步骤形状：{type:"cmd"|"dsh-plugin",entry,input?}
src/prompts.mjs        每个子代理的提示词
src/report.mjs         diagnostics.html
src/runner.mjs         步骤执行：cmd 起子进程、dsh-plugin 调 DSH 工具
src/tools/{index,codes,debug,job}.mjs   三个工具的定义与注册
scripts/build-client.mjs            把 codes-client + page.js 拼成 client.js
```

## 配置

```yaml
- id: coder
  name: coder
  config:
    outDir: .coder
    runTimeoutMs: 60000
    buildTimeoutMs: 600000
    agentTimeoutMs: 900000
    subagentProvider: auto      # auto → spawn
    cleanup: true
    linkDirs: ["node_modules"]
    maxDocs: 60
    docExcerptChars: 1200
    # 设计页的无头浏览器（可选）
    browserPath: ""             # 不填就自动找 Chrome
    browserProfileDir: ""       # 默认 ~/.coder/browser-profile
    browserWidth: 1280
    browserHeight: 800
    browserIdleMs: 1800000
    browserMaxTabs: 8           # 每个工作区最多几个标签，超出关最久没用的非当前标签
```

## 测试

```bash
node --test "tests/*.test.mjs"
```

109 个用例，离线跑完（整轮约 50 秒）：
codes.jsonl 的解析/校验/序列化/targets/`check`/`enabled`/`fix`、
诊断报告（只看最新、按码分组、两列里只有选中码的条目、读摘要与诊断行、坏行跳过、runId 不许拼路径）、
方案与排查（字段校验与补 id、写读运行目录、只认最新那次、勾选按运行分开记、排查/解决两个接口各自只交该交的东西、发起的对话能被 /activity 查回还在不在跑、中英词典键必须一致、方案两列与勾选、文本按句成段/条目成行）、
编辑页的 Host 接口（state / codes 读 / codes 写、工作区之外的目录 403、非 `docs/codes.jsonl` 400、没有 webServer 时什么都不注册）、
`targets` 接口（建对话 + 投递的提示词里带着码与工具名 + 会话带着 `workspaceId` 登记进工作区）、
`coder_debug` 接口（开会话就返回、提示词里带仓库路径、认不出工作区时先登记再退回只带 `cwd`、没有 sessionController 503）、
任务表（超时失败能被真正的回填改回完成，普通失败不行）、`coder_codes` 的 `targets` 动作写回文件、
编辑页的扫描/读取/保存与位置守卫、`apply` 等 webServer 再挂路由、
「记住上次的工作区/文件/设计文档地址/最后浏览位置」的读写与优先级（含坏 JSON）、设计文档地址（补 https、只收 http(s)、飞书域名按后缀判断）、批量启用只改 `enabled`、移除未启用整条删掉、targets 列表的增删与去重、导入（别人写的 JSON 字段别名、md 列表项、二进制文件、认不出的文本）、
`client.js` 是构建产物、能执行、注册 `main` + `sidebar.panellist`、并用真 React SSR 渲染出 Tab 栏与设计页的 canvas、画面坐标换算、
文档扫描、诊断日志与质量指标解析、范围解析（整仓 / 单提交 / 区间，含根提交指向整仓）、指纹与排除、构建与超时杀进程、
`coder_codes` 的生成/复用/force/show 与临时工作区清理、两个工具的注册、
「先 D 后 Q」的顺序与 Q 拿到 D 的规则、重复质量码被丢弃、
每条码必须带解决思路（漏了打回一次，两次都没有就不落盘）、
已有 codes.jsonl 时零代理复用（含多份时才回退到选文档、来源文档不猜）、
完整诊断链路（假代理 + 真 git + 真进程）、D/Q 两条线的时间重叠（用闸门固定，不靠谁跑得慢）、
codes.jsonl 的坏行与空文件、targets 只进提示词（精确名字和泛化描述都收，不做机械打回）、
两个 JSONL 的内容与来源、编造证据与越界行号打回、
整仓模式与提交模式的对比（范围是完整文件树而不是差集，提示词里没有改动清单）、
复现步骤（三个来源都带、缺了打回重试、计划外指标退到机械步骤、HTML 与 report 都渲染）、
复核（排在最后一步、误报被剔除并附理由、步骤跑不通换成实测步骤、复核失败只警告不丢结果）、
复用只读（已有 codes.jsonl 时不改文件、不在别的 docs 目录新建、未启用的码留在文件里但不进提示词也不产生诊断）、
步骤列表（cmd 与 dsh-plugin 两种、{{worktree}} 替换、工具失败算这一步失败、没有 tools 服务不静默通过）、
无头浏览器（DevToolsActivePort 与 http(s) 校验、输入事件的夹取与过滤、键码与修饰位、假 CDP 上的打开/导航/帧/输入/弹窗内部消化/断开清理、
以及一个**真 Chrome** 的用例：起 headless、打开本地页面、拿到帧与标题）。

集成用例都是真仓库 + 真 git + 真进程，一个用例 5~8 秒。为了整轮跑得进一分钟，做了两件事：
建仓库只建一次模板、之后每处 `fs.cp`（`git init` + 两次提交在 Windows 上要 3 秒，复制只要 80ms）；
`flow.test.mjs` 里的用例按 4 路并发跑（目录互不共享，git 进程多在等待）。
