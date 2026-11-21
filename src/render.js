/**
 * 把 `.coder/design/` 的四份文档渲染成一个 `design.html`。
 *
 * 页面只表达文档本身：
 *
 * - 左侧是目录，文档标题和 architecture.md / flow.md 的标题都可跳转；
 * - file.md 渲染成树表格；
 * - architecture.md / flow.md 渲染成 Markdown，Mermaid 图由浏览器绘制；
 * - data_structure.md 渲染成 Markdown，TypeScript 代码块按原文展示；
 * - 不显示状态卡、页脚、说明文案或回退提示。
 *
 * Markdown 由 `marked` 渲染，Mermaid 由 `mermaid` 渲染，两者从 jsDelivr
 * 加载。页面在服务端预置四份文档的源码：脚本不可用时它就是可读的正文；
 * 脚本可用时升级为树表格 / Markdown / Mermaid。CDN 不可用时保留源码。
 *
 * 这里不生成时间戳，也不读环境信息：同样的文档永远得到同样的 HTML。
 *
 * @module coder/render
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CoderError, DOCS_DIR, EXPECTED_DOCS, inspectDocs, kindOf } from './docs.js'

/** 默认输出目录，相对于项目根目录。 */
export const DEFAULT_OUT_DIR = 'dist/.coder'

/** 输出文件名。 */
export const OUTPUT_FILE = 'design.html'

/**
 * 转义为可以放进 `<pre>` 的文本。
 *
 * @param {string} value - 原文。
 * @returns {string} HTML 文本。
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

/**
 * 服务端预置的文档区块。
 *
 * 脚本不可用时，这就是页面正文：四份文档以纯文本呈现，至少可读；
 * 脚本可用时，前端把它替换成树表格 / Markdown / Mermaid。
 *
 * @param {{path: string, kind: string, present: boolean, content: string}[]} docs - 四份文档。
 * @returns {string} 文档区块的 HTML。
 */
function renderFallbackSections(docs) {
  return docs.map((doc) => {
    const body = doc.present
      ? `<div class="markdown doc-fallback"><pre>${escapeHtml(doc.content)}</pre></div>`
      : '<div class="doc-missing"></div>'
    return `<section class="doc" id="${escapeHtml(doc.kind)}" data-doc="${escapeHtml(doc.kind)}">
  <h2>${escapeHtml(doc.path)}</h2>
  ${body}
</section>`
  }).join('\n')
}

/**
 * 服务端预置的目录，只列四份文档；前端会在此基础上补文档内标题。
 *
 * @param {{path: string, kind: string}[]} docs - 四份文档。
 * @returns {string} 目录的 HTML。
 */
function renderStaticNav(docs) {
  const items = docs
    .map((doc) => `    <li><a href="#${escapeHtml(doc.kind)}">${escapeHtml(doc.path)}</a></li>`)
    .join('\n')
  return `<ul class="toc">\n${items}\n  </ul>`
}

/**
 * 构造单页 HTML。
 *
 * @param {object} input - 输入。
 * @param {{path: string, kind: string, present: boolean, content: string}[]} input.docs - 四份文档。
 * @returns {string} HTML 文本。
 */
function buildHtml({ docs }) {
  const payload = {
    docs: docs.map((doc) => ({
      path: doc.path,
      kind: doc.kind,
      present: doc.present,
      content: doc.content,
    })),
  }
  const dataJson = JSON.stringify(payload).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coder Design</title>
<style>
:root {
  --bg: #f4f6f8;
  --panel: #ffffff;
  --text: #1f2937;
  --muted: #667085;
  --border: #e4e7ec;
  --accent: #2563eb;
  --accent-soft: #eef4ff;
  --code: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --panel: #161a21;
    --text: #e6e8eb;
    --muted: #9aa3af;
    --border: #2a3038;
    --accent: #7aa2ff;
    --accent-soft: #1b2436;
    --code: #1d232c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  line-height: 1.65;
  background: var(--bg);
  color: var(--text);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  padding: 14px 24px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 12px; }
.mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--accent);
  color: #ffffff;
  font-weight: 700;
}
.brand h1 { margin: 0; font-size: 17px; line-height: 1.2; }
.layout {
  display: grid;
  grid-template-columns: 250px minmax(0, 1fr);
  gap: 32px;
  max-width: 1240px;
  margin: 0 auto;
  padding: 28px 24px 64px;
}
.sidebar {
  position: sticky;
  top: 84px;
  align-self: start;
  max-height: calc(100vh - 104px);
  overflow-y: auto;
  padding-right: 8px;
}
.nav-title {
  margin: 0 0 10px;
  padding: 0 8px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--muted);
}
.toc { list-style: none; margin: 0; padding: 0; }
.toc ul {
  list-style: none;
  margin: 4px 0 10px 8px;
  padding-left: 10px;
  border-left: 1px solid var(--border);
}
.toc a {
  display: block;
  padding: 5px 8px;
  border-radius: 6px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.toc a:hover { background: var(--accent-soft); color: var(--accent); text-decoration: none; }
.toc > li > a { color: var(--text); font-weight: 600; }
.doc {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 28px 32px;
  margin-bottom: 24px;
  overflow-wrap: anywhere;
  scroll-margin-top: 84px;
}
.doc > h2 {
  margin: 0 0 18px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.markdown h1 { margin: 0 0 14px; font-size: 24px; line-height: 1.3; scroll-margin-top: 84px; }
.markdown h2 {
  margin: 26px 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  font-size: 19px;
  scroll-margin-top: 84px;
}
.markdown h3 { margin: 20px 0 8px; font-size: 16px; }
.markdown p, .markdown ul, .markdown ol { margin: 10px 0; }
.markdown ul, .markdown ol { padding-left: 24px; }
.markdown li { margin: 4px 0; }
.markdown code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--code);
  font-size: 0.9em;
}
.markdown pre {
  margin: 16px 0;
  padding: 16px;
  border-radius: 10px;
  background: var(--code);
  overflow: auto;
}
.markdown pre code { padding: 0; background: none; }
.markdown table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
.markdown th, .markdown td { padding: 8px 10px; border: 1px solid var(--border); text-align: left; }
.markdown th { background: var(--code); }
.markdown blockquote {
  margin: 16px 0;
  padding: 8px 16px;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  color: var(--muted);
}
.file-tree-wrap { overflow-x: auto; }
.file-tree { width: 100%; border-collapse: collapse; font-size: 14px; }
.file-tree th {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--muted);
  font-weight: 600;
}
.file-tree td { padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.file-tree tr:hover td { background: var(--accent-soft); }
.tree-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: nowrap;
}
.tree-guide {
  display: inline-block;
  width: 20px;
  height: 1.65em;
  border-left: 1px solid var(--border);
  vertical-align: middle;
}
.tree-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--muted);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  vertical-align: middle;
}
.tree-toggle:hover { background: var(--accent-soft); color: var(--accent); }
.tree-path-toggle { cursor: pointer; }
.tree-mark { display: inline-block; width: 20px; color: var(--muted); vertical-align: middle; }
.tree-name { color: var(--text); }
.tree-name.dir { font-weight: 600; }
.tree-name.glob { color: var(--accent); }
.tree-desc { color: var(--muted); }
.doc-missing {
  min-height: 56px;
  border: 1px dashed var(--border);
  border-radius: 10px;
}
.mermaid { display: flex; justify-content: center; margin: 18px 0; overflow-x: auto; }
.mermaid svg { max-width: 100%; height: auto; }
@media (max-width: 860px) {
  .layout { grid-template-columns: 1fr; gap: 16px; padding: 16px; }
  .sidebar { position: static; max-height: none; order: -1; }
  .doc { padding: 20px; }
  .topbar { padding: 12px 16px; }
}
@media print {
  .topbar, .sidebar { display: none; }
  .layout { display: block; padding: 0; }
  .doc { border: none; padding: 0; }
  .mermaid { break-inside: avoid; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="mark">C</span>
    <h1>Coder Design</h1>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">
    <p class="nav-title">目录</p>
    <nav id="nav" aria-label="目录">
  ${renderStaticNav(docs)}
    </nav>
  </aside>
  <main id="content">
${renderFallbackSections(docs)}
  </main>
</div>
<script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script type="application/json" id="coder-data">${dataJson}</script>
<script>
(function () {
  'use strict'
  var data = JSON.parse(document.getElementById('coder-data').textContent)
  var nav = document.getElementById('nav')
  var hasMarked = typeof window.marked !== 'undefined'
  var hasMermaid = typeof window.mermaid !== 'undefined'
  var newline = String.fromCharCode(10)
  var carriageReturn = String.fromCharCode(13)
  var tick = String.fromCharCode(96)

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
    })
  }

  function parseHeading(line) {
    var level = 0
    while (level < line.length && line.charAt(level) === '#') level += 1
    if (level < 1 || level > 2) return null
    if (line.charAt(level) !== ' ') return null
    return { level: level, text: line.slice(level + 1).trim() }
  }

  function parseFileEntries(markdown) {
    var lines = markdown.split(newline)
    var entries = []
    var current = null
    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index]
      if (line.charAt(line.length - 1) === carriageReturn) line = line.slice(0, -1)
      var heading = parseHeading(line)
      if (heading !== null) {
        current = { level: heading.level, path: heading.text.split(tick).join('').trim(), description: [] }
        entries.push(current)
      } else if (current !== null && line.trim() !== '') {
        current.description.push(line.trim())
      }
    }
    return entries
      .filter(function (entry) {
        return entry.path !== '.coder' && entry.path.indexOf('.coder/') !== 0
      })
      .map(function (entry) {
        return { level: entry.level, path: entry.path, description: entry.description.join(' ') }
      })
  }

  function buildFileTree(entries) {
    var roots = []
    var byPath = {}
    var nextId = 0

    function createNode(name, nodePath, depth, parent) {
      var node = {
        id: 'node-' + nextId,
        parentId: parent === null ? '' : parent.id,
        name: name,
        path: nodePath,
        description: '',
        depth: depth,
        kind: 'file',
        children: [],
      }
      nextId += 1
      byPath[nodePath] = node
      if (parent === null) roots.push(node)
      else {
        parent.children.push(node)
        parent.kind = 'dir'
      }
      return node
    }

    entries.forEach(function (entry) {
      if (entry.path.indexOf('*') >= 0 || entry.path.indexOf('?') >= 0) {
        var glob = createNode(entry.path, entry.path, 0, null)
        glob.kind = 'glob'
        glob.description = entry.description
        return
      }
      var parts = entry.path.split('/')
      var parent = null
      var prefix = ''
      parts.forEach(function (part, index) {
        prefix = prefix === '' ? part : prefix + '/' + part
        var node = byPath[prefix]
        if (!node) node = createNode(part, prefix, index, parent)
        if (index === parts.length - 1) node.description = entry.description
        parent = node
      })
    })

    Object.keys(byPath).forEach(function (key) {
      if (byPath[key].children.length > 0) byPath[key].kind = 'dir'
    })
    return roots
  }

  function renderFileTree(markdown) {
    var table = document.createElement('table')
    table.className = 'file-tree'
    var thead = document.createElement('thead')
    var headRow = document.createElement('tr')
    var pathHead = document.createElement('th')
    pathHead.textContent = '路径'
    var descHead = document.createElement('th')
    descHead.textContent = '说明'
    headRow.appendChild(pathHead)
    headRow.appendChild(descHead)
    thead.appendChild(headRow)
    table.appendChild(thead)
    var tbody = document.createElement('tbody')

    function isHidden(row, collapsedIds) {
      var parentId = row.getAttribute('data-parent-id')
      while (parentId) {
        if (collapsedIds[parentId]) return true
        var parentRow = tbody.querySelector('tr[data-node-id="' + parentId + '"]')
        if (parentRow === null) break
        parentId = parentRow.getAttribute('data-parent-id')
      }
      return false
    }

    function refresh() {
      var rows = tbody.querySelectorAll('tr')
      var collapsedIds = {}
      Array.prototype.forEach.call(rows, function (row) {
        if (row.classList.contains('collapsed')) collapsedIds[row.getAttribute('data-node-id')] = true
      })
      Array.prototype.forEach.call(rows, function (row) {
        row.hidden = isHidden(row, collapsedIds)
      })
    }

    function appendRows(nodes) {
      nodes.forEach(function (node) {
        var row = document.createElement('tr')
        row.setAttribute('data-node-id', node.id)
        row.setAttribute('data-parent-id', node.parentId)
        var pathCell = document.createElement('td')
        pathCell.className = 'tree-path'
        for (var level = 0; level < node.depth; level += 1) {
          var guide = document.createElement('span')
          guide.className = 'tree-guide'
          pathCell.appendChild(guide)
        }
        if (node.kind === 'dir') {
          var toggle = document.createElement('button')
          toggle.type = 'button'
          toggle.className = 'tree-toggle'
          toggle.setAttribute('aria-expanded', 'true')
          toggle.setAttribute('aria-label', '展开或折叠 ' + node.path)
          toggle.textContent = '▾'
          var toggleRow = function () {
            var isCollapsed = row.classList.toggle('collapsed')
            toggle.textContent = isCollapsed ? '▸' : '▾'
            toggle.setAttribute('aria-expanded', String(!isCollapsed))
            refresh()
          }
          toggle.addEventListener('click', function (event) {
            event.stopPropagation()
            toggleRow()
          })
          pathCell.classList.add('tree-path-toggle')
          pathCell.addEventListener('click', function (event) {
            if (event.target === toggle) return
            toggleRow()
          })
          pathCell.appendChild(toggle)
        } else {
          var mark = document.createElement('span')
          mark.className = 'tree-mark'
          mark.textContent = node.kind === 'glob' ? '✧' : '·'
          pathCell.appendChild(mark)
        }
        var name = document.createElement('span')
        name.className = 'tree-name ' + node.kind
        name.textContent = node.name
        name.title = node.path
        pathCell.appendChild(name)
        var descCell = document.createElement('td')
        descCell.className = 'tree-desc'
        descCell.textContent = node.description
        row.appendChild(pathCell)
        row.appendChild(descCell)
        tbody.appendChild(row)
        if (node.children.length > 0) appendRows(node.children)
      })
    }

    appendRows(buildFileTree(parseFileEntries(markdown)))
    table.appendChild(tbody)
    var wrap = document.createElement('div')
    wrap.className = 'file-tree-wrap'
    wrap.appendChild(table)
    return wrap
  }

  data.docs.forEach(function (doc) {
    var section = document.getElementById(doc.kind)
    if (section === null || !doc.present) return
    var fallback = section.querySelector('.doc-fallback')
    if (doc.kind === 'file') {
      var tree = renderFileTree(doc.content)
      if (fallback !== null) section.replaceChild(tree, fallback)
      else section.appendChild(tree)
      return
    }
    if (!hasMarked) return
    var body = document.createElement('div')
    body.className = 'markdown'
    try {
      body.innerHTML = window.marked.parse(doc.content, { gfm: true })
    } catch (error) {
      return
    }
    if (fallback !== null) section.replaceChild(body, fallback)
    else section.appendChild(body)
  })

  function jumpTo(id) {
    var target = document.getElementById(id)
    if (target === null) return false
    var section = target.closest ? target.closest('.doc') : null
    if (section !== null) section.hidden = false
    var current = window.scrollY || document.documentElement.scrollTop || 0
    var top = Math.max(0, target.getBoundingClientRect().top + current - 84)
    if (window.scrollTo) window.scrollTo(0, top)
    else window.location.hash = id
    var after = window.scrollY || document.documentElement.scrollTop || 0
    if (Math.abs(after - current) < 2 && Math.abs(top - current) > 2 && section !== null) {
      Array.prototype.forEach.call(document.querySelectorAll('#content > .doc'), function (candidate) {
        candidate.hidden = candidate !== section
      })
    }
    try {
      if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#' + id)
    } catch (error) {}
    return true
  }

  function bindJump(link, id) {
    link.href = '#' + id
    link.addEventListener('click', function (event) {
      if (jumpTo(id)) event.preventDefault()
    })
  }

  while (nav.firstChild) nav.removeChild(nav.firstChild)

  var toc = document.createElement('ul')
  toc.className = 'toc'
  data.docs.forEach(function (doc) {
    var item = document.createElement('li')
    var link = document.createElement('a')
    bindJump(link, doc.kind)
    link.textContent = doc.path
    item.appendChild(link)
    var section = document.getElementById(doc.kind)
    if (section !== null) {
      var headings = section.querySelectorAll('.markdown h1, .markdown h2')
      if (headings.length > 0) {
        var sublist = document.createElement('ul')
        Array.prototype.forEach.call(headings, function (heading, index) {
          heading.id = doc.kind + '-h-' + index
          var subItem = document.createElement('li')
          var subLink = document.createElement('a')
          bindJump(subLink, heading.id)
          subLink.textContent = heading.textContent
          subItem.appendChild(subLink)
          sublist.appendChild(subItem)
        })
        item.appendChild(sublist)
      }
    }
    toc.appendChild(item)
  })
  nav.appendChild(toc)

  if (hasMermaid) {
    var codes = document.querySelectorAll('code.language-mermaid')
    Array.prototype.forEach.call(codes, function (code) {
      var diagram = document.createElement('div')
      diagram.className = 'mermaid'
      diagram.textContent = code.textContent
      var pre = code.closest ? code.closest('pre') : null
      if (pre) pre.parentNode.replaceChild(diagram, pre)
      else code.parentNode.replaceChild(diagram, code)
    })
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.mermaid'))
    if (nodes.length > 0) {
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' })
      window.mermaid.run({ nodes: nodes }).catch(function () {})
    }
  }
})()
</script>
</body>
</html>
`
}

/**
 * 渲染 `.coder/design/` 到 `design.html`。
 *
 * @param {object} options - 选项。
 * @param {string} options.root - 项目根目录。
 * @param {string} [options.outDir] - 输出目录；默认 `dist/.coder`，相对于项目根目录。
 * @returns {Promise<object>} 渲染结果。
 * @throws {CoderError} 读文档或写 HTML 失败时。
 */
export async function renderDesign({ root, outDir }) {
  const absoluteRoot = path.resolve(root)
  const report = await inspectDocs({ root: absoluteRoot })

  const docs = []
  for (const relative of EXPECTED_DOCS) {
    const absolute = path.join(absoluteRoot, DOCS_DIR, ...relative.split('/'))
    let content = ''
    let present = true
    try {
      content = await fs.readFile(absolute, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        present = false
      } else {
        throw new CoderError(`无法读取 ${absolute}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    docs.push({ path: `${DOCS_DIR}/${relative}`, kind: kindOf(relative), present, content })
  }

  let targetDir
  if (outDir === undefined || outDir === null) {
    targetDir = path.resolve(absoluteRoot, DEFAULT_OUT_DIR)
  } else if (typeof outDir === 'string') {
    const trimmed = outDir.trim()
    targetDir = path.resolve(absoluteRoot, trimmed === '' ? DEFAULT_OUT_DIR : trimmed)
  } else {
    throw new CoderError('out 必须是字符串')
  }

  const output = path.join(targetDir, OUTPUT_FILE)
  const html = buildHtml({ docs })
  try {
    await fs.mkdir(targetDir, { recursive: true })
    await fs.writeFile(output, html, 'utf8')
  } catch (error) {
    throw new CoderError(`无法写入 ${output}：${error instanceof Error ? error.message : String(error)}`)
  }

  const bytes = Buffer.byteLength(html, 'utf8')
  return {
    ok: true,
    output,
    bytes,
    healthy: report.ok,
    summary: report.summary,
    missing: report.missing,
    illegal: report.illegal,
    diagnostics: report.diagnostics,
    text: [
      `已生成 ${OUTPUT_FILE}`,
      `输出：${output}`,
      `大小：${bytes} 字节`,
      `文档：${report.summary.found}/${report.summary.expected}｜非法 ${report.summary.illegal}｜缺失 ${report.summary.missing}｜诊断 ${report.summary.diagnostics}`,
      '在浏览器中打开即可查看；Markdown 与 Mermaid 由 jsDelivr 上的 marked/mermaid 渲染，离线时回退为源码。',
    ].join('\n'),
  }
}
