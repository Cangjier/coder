/**
 * 交付用的 HTML 视图：单文件、零外部资源，双击就能看。
 *
 * 数据全部来自本次运行的内存状态；这里只做转义、排序和分组，不做任何判断。
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * @param {string} kind
 * @returns {string}
 */
function kindLabel(kind) {
  return kind === 'quality' ? 'Quality' : 'Debug'
}

/**
 * @param {string} check
 * @returns {string}
 */
function checkLabel(check) {
  return check === 'static' ? 'Static' : 'Runtime'
}

/**
 * @param {string} source
 * @returns {string}
 */
function sourceLabel(source) {
  if (source === 'runtime') return '运行期'
  if (source === 'quality-runtime') return '质量运行期'
  return '静态'
}

/**
 * @param {object} line
 * @returns {string}
 */
function metricText(line) {
  if (line.source !== 'quality-runtime') return ''
  const parts = []
  if (line.metric) parts.push(`${line.metric}=${line.value ?? '?'}${line.unit ?? ''}`)
  if (typeof line.threshold === 'number') parts.push(`阈值 ${line.threshold}`)
  if (line.pass === true) parts.push('达标')
  if (line.pass === false) parts.push('未达标')
  return parts.join(' · ')
}

/**
 * @param {object} line
 * @returns {string}
 */
function locationText(line) {
  if (!line.file) return ''
  return `${line.file}${line.line ? `:${line.line}` : ''}${line.column ? `:${line.column}` : ''}`
}

/**
 * 一条码涉及的对象，给报告用。
 *
 * @param {object} code
 * @returns {string}
 */
function scopeText(code) {
  const targets = Array.isArray(code.targets) ? code.targets : []
  return targets.length === 0 ? '全部代码' : targets.join(', ')
}

const VERIFY_TEXT = { confirmed: '已确认', uncertain: '存疑' }
const REPRO_TEXT = { pass: '步骤可复现', fail: '步骤跑不通', rewritten: '步骤已改写', unknown: '步骤未执行' }

/**
 * 复核结论：这条诊断可不可信、步骤到底跑不跑得通。
 *
 * @param {object} line
 * @returns {string}
 */
function verifyHtml(line) {
  if (!line.verification) return ''
  const verdict = String(line.verification)
  const repro = line.repro
    ? `<span class="vt vt-repro">${esc(REPRO_TEXT[line.repro] ?? line.repro)}</span>`
    : ''
  const note = line.reproNote ? `<div class="vnote">${esc(line.reproNote)}</div>` : ''
  return `<div class="verify"><span class="vt ${verdict === 'confirmed' ? 'vt-ok' : 'vt-warn'}">${esc(
    VERIFY_TEXT[verdict] ?? verdict,
  )}</span>${repro}${note}</div>`
}

/**
 * 复核判定为误报、已经不进诊断的那些。
 *
 * @param {Array<object>} rejected
 * @returns {string}
 */
function rejectedSection(rejected) {
  if (rejected.length === 0) return ''
  const rows = rejected
    .map((item) =>
      [
        '<tr>',
        `<td><code>${esc(item.code)}</code></td>`,
        `<td><code>${esc(locationText(item))}</code></td>`,
        `<td><span class="src">${esc(sourceLabel(item.source))}</span></td>`,
        `<td>${esc(item.message)}<div class="vnote">${esc(item.reason)}</div></td>`,
        '</tr>',
      ].join(''),
    )
    .join('\n')
  return `<section class="rejected"><h2>已排除（复核判定误报：${rejected.length}）</h2>
<table><thead><tr><th>码</th><th>位置</th><th>来源</th><th>理由</th></tr></thead><tbody>
${rows}
</tbody></table></section>`
}

/**
 * 复现步骤：报告里每条诊断下面挂一个有序列表，照着做就能看到这条。
 *
 * @param {object} line
 * @returns {string}
 */
function stepsHtml(line) {
  const steps = Array.isArray(line.steps) ? line.steps.map((step) => String(step ?? '').trim()).filter(Boolean) : []
  if (steps.length === 0) return ''
  return `<div class="steps"><span class="steps-tag">复现步骤</span><ol>${steps
    .map((step) => `<li>${esc(step)}</li>`)
    .join('')}</ol></div>`
}

/**
 * 复核这一行：做了没有、结论分布、花了多久。
 *
 * @param {object} state
 * @returns {string}
 */
function verifySummary(state) {
  const info = state.verification
  if (!info || info.status === 'skipped') return '这次没有诊断，无需复核'
  if (info.status === 'failed') return `没有完成：${info.message ?? '未知原因'}（下面的诊断没有复核过）`
  return (
    `${info.checked} 条 → 确认 ${info.confirmed} · 存疑 ${info.uncertain} · 排除误报 ${info.dropped} · 改写步骤 ${info.rewritten}` +
    `（${((info.durationMs ?? 0) / 1000).toFixed(1)}s）`
  )
}

/**
 * 一次运行诊断的范围：整仓 / 区间 / 单个提交。
 *
 * @param {{ mode?: string, base?: string | null, head?: string, files?: Array<object> }} change
 * @returns {string}
 */
function changeLabel(change) {
  const head = String(change?.head ?? '').slice(0, 12)
  const count = change?.files?.length ?? 0
  if (change?.mode === 'all') return `整个仓库（提交 ${head} 的完整文件树，${count} 个文件）`
  const base = String(change?.base ?? '').slice(0, 12)
  if (change?.mode === 'range') return `区间 ${base}..${head}（${count} 个文件）`
  return `提交 ${head}（对比 ${base}，${count} 个文件）`
}

/**
 * @param {object} state
 * @returns {string}
 */
export function renderHtml(state) {
  const lines = state.lines ?? []
  const codes = state.codes ?? []
  const counts = { error: 0, warning: 0, info: 0 }
  for (const line of lines) counts[line.severity] = (counts[line.severity] ?? 0) + 1
  const hits = new Map()
  for (const line of lines) hits.set(line.code, (hits.get(line.code) ?? 0) + 1)

  const change = state.change ?? {}
  const doc = state.docs?.selected ?? null
  const cache = state.codeCache
  const generated = new Date().toISOString()

  const rows = lines
    .map((line) => {
      const metric = metricText(line)
      return [
        `<tr data-sev="${esc(line.severity)}" data-src="${esc(line.source)}" id="d${esc(line.id ?? '')}">`,
        `<td class="num idx">#${esc(line.id ?? '')}</td>`,
        `<td class="sev sev-${esc(line.severity)}">${esc(line.severity)}</td>`,
        `<td><code>${esc(line.code)}</code></td>`,
        `<td><span class="kind">${esc(kindLabel(line.kind))}</span></td>`,
        `<td><code>${esc(locationText(line))}</code></td>`,
        `<td><span class="src">${esc(sourceLabel(line.source))}</span></td>`,
        `<td>${esc(line.message)}${metric ? `<div class="metric">${esc(metric)}</div>` : ''}${verifyHtml(line)}${stepsHtml(line)}</td>`,
        '</tr>',
      ].join('')
    })
    .join('\n')

  const codeRows = codes
    .map((code) => {
      const count = hits.get(code.code) ?? 0
      const off = code.enabled === false ? ' <span class="vt vt-warn">未启用</span>' : ''
      return [
        `<tr${off ? ' class="code-off"' : ''}>`,
        `<td><code>${esc(code.code)}</code></td>`,
        `<td><span class="kind">${esc(kindLabel(code.kind))}</span>${off}</td>`,
        `<td><span class="kind">${esc(checkLabel(code.check))}</span></td>`,
        `<td class="sev sev-${esc(code.severity)}">${esc(code.severity)}</td>`,
        `<td class="rule">${esc(code.rule)}</td>`,
        `<td class="rule">${esc(scopeText(code))}</td>`,
        `<td class="num">${count}</td>`,
        '</tr>',
      ].join('')
    })
    .join('\n')

  const warnings = (state.warnings ?? []).length
    ? `<section class="warnbox"><h2>注意（${state.warnings.length}）</h2><ul>${state.warnings
        .map((item) => `<li>${esc(item)}</li>`)
        .join('')}</ul></section>`
    : ''

  const errorBox = state.error
    ? `<div class="errorbox"><strong>运行失败：</strong>${esc(state.error.message)}${state.error.code ? `（${esc(state.error.code)}）` : ''}</div>`
    : ''

  const lanes = state.lanes
  const starts = [lanes?.debug?.started, lanes?.quality?.started].filter((value) => Number.isFinite(value))
  const base = starts.length > 0 ? Math.min(...starts) : 0
  const laneText = (lane) => {
    if (!lane) return '未运行'
    const from = ((lane.started - base) / 1000).toFixed(1)
    const to = ((lane.ended - base) / 1000).toFixed(1)
    return `${from}s → ${to}s（${((lane.ended - lane.started) / 1000).toFixed(1)}s）`
  }
  const laneLine = lanes
    ? `<div class="lanes">并行时间线：Debug ${esc(laneText(lanes.debug))} · Quality ${esc(laneText(lanes.quality))}</div>`
    : ''

  const disabledCount = codes.filter((item) => item.enabled === false).length

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>coder_debug · ${esc(state.runId)}</title>
<style>
:root{--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--chip:#f6f8fa;--err:#cf222e;--warn:#9a6700;--info:#0969da;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--chip:#161b22;--err:#ff7b72;--warn:#d29922;--info:#58a6ff;--ok:#3fb950}}
*{box-sizing:border-box}
body{margin:0;padding:28px 32px 48px;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;color:var(--muted);font-size:13px;margin:12px 0 0}
.meta dt{font-weight:600}
.meta dd{margin:0;overflow-wrap:anywhere}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted)}
.chip b{color:var(--fg)}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.filters button{border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}
.filters button.active{border-color:var(--fg);font-weight:600}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}
td{font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12.5px}
.sev-error{color:var(--err);font-weight:600}
.sev-warning{color:var(--warn);font-weight:600}
.sev-info{color:var(--info);font-weight:600}
.kind,.src{font-size:11.5px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:1px 6px;white-space:nowrap}
.code-off td:not(.num){opacity:.55}
.metric{margin-top:3px;font-size:12px;color:var(--muted)}
.steps{margin-top:8px;padding:7px 10px;border-left:2px solid var(--line);background:var(--chip);border-radius:0 6px 6px 0;max-width:760px}
.steps-tag{font-size:11.5px;color:var(--muted);letter-spacing:.04em}
.steps ol{margin:3px 0 0;padding-left:19px;font-size:12.5px;line-height:1.6}
.steps li{margin:2px 0;overflow-wrap:anywhere}
.verify{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.vt{font-size:11.5px;border:1px solid var(--line);border-radius:4px;padding:1px 6px;color:var(--muted);white-space:nowrap}
.vt-ok{color:var(--ok);border-color:var(--ok)}
.vt-warn{color:var(--warn);border-color:var(--warn)}
.vt-repro{color:var(--muted)}
.vnote{margin-top:4px;font-size:12.5px;color:var(--muted)}
.rejected{margin-top:28px}
.rule{color:var(--muted);max-width:420px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.idx{color:var(--muted);white-space:nowrap}
.errorbox{margin-top:16px;border:1px solid var(--err);border-radius:8px;padding:10px 12px;color:var(--err)}
.warnbox ul{margin:8px 0 0;padding-left:20px;color:var(--muted)}
.lanes{margin-top:10px;font-size:12.5px;color:var(--muted)}
.empty{color:var(--muted);padding:14px 0}
footer{margin-top:36px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<h1>coder_debug 诊断报告</h1>
<div class="meta">
  <dt>仓库</dt><dd>${esc(state.input?.repo ?? '')}</dd>
  <dt>变更</dt><dd>${esc(changeLabel(change))}</dd>
  <dt>Run</dt><dd>${esc(state.runId)}</dd>
  <dt>规范文档</dt><dd>${doc?.path ? `${esc(doc.path)}${doc.reason ? ` — ${esc(doc.reason)}` : ''}` : esc(doc?.reason ?? '未选出')}</dd>
  <dt>诊断码</dt><dd>${codes.filter((item) => item.kind === 'debug').length} 条 Debug / ${codes.filter((item) => item.kind === 'quality').length} 条 Quality${disabledCount > 0 ? `（其中 ${disabledCount} 条未启用，不参与诊断）` : ''}${cache ? ` · ${cache.reused ? '复用' : '本次生成'} <code>${esc(cache.file)}</code>` : ''}</dd>
  <dt>复核</dt><dd>${esc(verifySummary(state))}</dd>
  <dt>生成时间</dt><dd>${esc(generated)}</dd>
</div>
<div class="stats">
  <span class="chip">诊断 <b>${lines.length}</b></span>
  <span class="chip">error <b>${counts.error}</b></span>
  <span class="chip">warning <b>${counts.warning}</b></span>
  <span class="chip">info <b>${counts.info}</b></span>
  <span class="chip">运行期 <b>${lines.filter((item) => item.source === 'runtime').length}</b></span>
  <span class="chip">静态 <b>${lines.filter((item) => item.source === 'static').length}</b></span>
  <span class="chip">质量运行期 <b>${lines.filter((item) => item.source === 'quality-runtime').length}</b></span>
</div>
${laneLine}
${errorBox}
<section>
  <h2>诊断（${lines.length}）</h2>
  <div class="filters">
    <button data-filter="all" class="active">全部</button>
    <button data-filter="error">error</button>
    <button data-filter="warning">warning</button>
    <button data-filter="info">info</button>
    <button data-filter="runtime">运行期</button>
    <button data-filter="static">静态</button>
    <button data-filter="quality-runtime">质量运行期</button>
  </div>
  ${lines.length === 0 ? '<div class="empty">本次没有产生任何诊断。</div>' : `<table>
  <thead><tr><th>#</th><th>级别</th><th>码</th><th>族</th><th>位置</th><th>来源</th><th>说明</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`}
</section>
${rejectedSection(state.rejected ?? [])}
<section>
  <h2>诊断码（${codes.length}）</h2>
  ${codes.length === 0 ? '<div class="empty">没有诊断码。</div>' : `<table>
  <thead><tr><th>码</th><th>族</th><th>检查</th><th>级别</th><th>规则</th><th>涉及</th><th>命中</th></tr></thead>
  <tbody>
${codeRows}
  </tbody>
</table>`}
</section>
${warnings}
<footer>由 coder_debug 生成 · 规范文档同目录的 codes.jsonl 是诊断码（在左侧栏的「诊断码」页编辑）· 同目录的 diagnostics.jsonl 是机器可读的诊断</footer>
<script>
(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.filters button'));
  var rows = Array.prototype.slice.call(document.querySelectorAll('tbody tr[data-sev]'));
  function apply() {
    var active = buttons.filter(function (b) { return b.classList.contains('active') })[0];
    var filter = active ? active.getAttribute('data-filter') : 'all';
    rows.forEach(function (row) {
      var hit = filter === 'all' || row.getAttribute('data-sev') === filter || row.getAttribute('data-src') === filter;
      row.hidden = !hit;
    });
  }
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      buttons.forEach(function (other) { other.classList.toggle('active', other === button) });
      apply();
    });
  });
})();
</script>
</body>
</html>
`
}
