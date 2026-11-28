/**
 * `.coder/` 文档树的扫描与格式诊断。
 *
 * 这里没有任何模型调用，也没有任何业务判断：给一个项目根目录，就把
 * `<root>/.coder/` 下的文件全部列出来，与预期集合比对，再按
 * `docs/design.md` 的格式约定逐份诊断。
 *
 * 五份设计文档、两份诊断文档和计划条目文件的规则都以「确定性」为前提，可选
 * 的模块详情、问题文档与成员文档共用同一套检查；
 * 所以只做能够机械判定的检查：标题路径是否合法、同一路径是否重复、说明是否
 * 为空、是否有反向表述、视角是否有图、场景是否有 mermaid 图、数据结构是否用
 * ts interface 表达、诊断码与作用范围是否合法、步骤格式与编号、文件通配范围
 * 是否命中、计划编码与字段顺序、编号条目和关联 ToDo 是否合法、模块索引与详情
 * 是否成对、问题文件夹与内容是否一致、成员名册的字段与成员流程的场景是否完整。
 * 判不了的（例如图是否真的描述了代码、任务是否真的完成）不猜，也不报。
 *
 * 文档目录、预期文档和格式规则都是固化的，不接受配置。
 *
 * @module coder/docs
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { validateArchitecture, validateData, validateFlow } from './design.js'
import { DIAGNOSIS_DOCS, diagnosisSeverity, inspectDiagnosis } from './diagnosis.js'
import { matchGlob } from './glob.js'
import { inspectIssue, isIssueDoc, issueKindOf, issueNumber } from './issue.js'
import { inspectLog, isLogDoc, logKindOf, logMetaOf } from './log.js'
import { LOCK_DECLARATION, LOCK_RELATIVE, hashCoder, readLock } from './lock.js'
import { analyzeMarkdown } from './markdown.js'
import { inspectMembersAll, inspectMembersFlow, isMemberDoc, memberKindOf } from './member.js'
import {
  MODULES_DOC,
  inspectModule,
  inspectModules,
  isOptionalModuleDoc,
  moduleKindOf,
  moduleNumber,
} from './module.js'
import { inspectPlan, planKindOf, planMetaOf } from './plan.js'
import {
  REQUIREMENT_STATUSES,
  inspectRequirement,
  isRequirementDoc,
  requirementMetaOf,
} from './requirement.js'

export { analyzeMarkdown }

/** 文档树目录，相对于项目根目录。固化，不提供配置。 */
export const DOCS_DIR = '.coder'

/** 预期文档，相对于文档树目录。固化，不提供配置。 */
export const EXPECTED_DOCS = Object.freeze([
  'design/file.md',
  'design/architecture.md',
  'design/flow.md',
  'design/data_structure.md',
  MODULES_DOC,
  ...DIAGNOSIS_DOCS,
])

/** 会被当作 Markdown 诊断的扩展名。 */
const MARKDOWN_EXTENSION = /\.(md|markdown)$/i

/** 可选配置文件，相对于 `.coder/`。 */
export const MANIFEST_DOC = 'manifest.json'

/** 大代码文件的默认阈值（字节）。 */
export const DEFAULT_LARGE_CODE_FILE_BYTES = 20 * 1024

/** 计入大文件提示的源码扩展名。 */
const CODE_FILE_EXTENSION = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|hxx|cs|swift|rb|php|scala|sh|bash|zsh|ps1|lua|pl|pm|r|ex|exs|erl|hs|ml|clj|cljs|dart|vue|svelte|html|css|scss|sass|less)$/i

/** 大文件提示跳过的目录名；`node_modules` 在任意层级都跳过。 */
const HINT_SKIP_DIRS = Object.freeze(
  new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    'out',
    'target',
    'vendor',
    'coverage',
    'tmp',
    '.cache',
    '.next',
    '.nuxt',
    '.output',
    'artifacts',
  ]),
)

/** 反向表述：行首这些词说明「只描述正向预期」被破坏了。 */
const NEGATION_START = /^(不要|禁止|不允许|不得|不能|勿|请勿|严禁|do not|don't|must not|never)/i

/** 反向表述：句中这些词也是高置信度的反向约束。 */
const NEGATION_ANY = /(禁止|不允许|不得)|\b(must not|should not|do not)\b/i

/** 扫描或读取失败时抛出的错；工具层把它变成一次明确的失败。 */
export class CoderError extends Error {
  /**
   * @param {string} message - 原因与改法。
   */
  constructor(message) {
    super(message)
    this.name = 'CoderError'
  }
}

/**
 * 根据文档路径推断它属于哪一类格式。
 *
 * 设计文档用 basename 判断；诊断文档和计划文档按完整相对路径判断，避免其他
 * 目录里同名的 error.md / warn.md 被误认。
 *
 * @param {string} relative - 相对于文档树目录的路径。
 * @returns {'file'|'architecture'|'flow'|'data'|'modules'|`module-${string}`|'diagnosis-error'|'diagnosis-warn'|'plan-todo'|'plan-todo-archived'|'plan-goal'|'plan-goal-archived'|'issue-open'|'issue-close'|'requirement'|'log-audit'|'log-update'|'log-usage'|'log-research'|'members-all'|'members-flow'|'lock'|'generic'} 文档类型。
 */
export function kindOf(relative) {
  if (relative === 'diagnosis/error.md') return 'diagnosis-error'
  if (relative === 'diagnosis/warn.md') return 'diagnosis-warn'
  const planKind = planKindOf(relative)
  if (planKind !== null) return planKind
  const moduleKind = moduleKindOf(relative)
  if (moduleKind !== null) return moduleKind
  const issueKind = issueKindOf(relative)
  if (issueKind !== null) return issueKind
  const logKind = logKindOf(relative)
  if (logKind !== null) return logKind
  if (isRequirementDoc(relative)) return 'requirement'
  const memberKind = memberKindOf(relative)
  if (memberKind !== null) return memberKind
  const base = path.posix.basename(relative).toLowerCase()
  if (base === 'file.md') return 'file'
  if (base === 'architecture.md') return 'architecture'
  if (base === 'flow.md') return 'flow'
  if (base === 'data_structure.md') return 'data'
  if (base === 'lock.md') return 'lock'
  return 'generic'
}

/**
 * 判断一个相对路径是否是可选文档：存在就检查，不存在也不报缺失。
 *
 * @param {string} relative - 相对于文档树目录的路径。
 * @returns {boolean} 是否是可选文档。
 */
export function isOptionalDoc(relative) {
  return (
    relative === MANIFEST_DOC ||
    planKindOf(relative) !== null ||
    isOptionalModuleDoc(relative) ||
    isIssueDoc(relative) ||
    isRequirementDoc(relative) ||
    isLogDoc(relative) ||
    isMemberDoc(relative)
  )
}

/**
 * 构造一条诊断。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {number} line - 1-based 行号。
 * @param {string} rule - 稳定的规则代码。
 * @param {string} message - 给人看的原因。
 * @returns {{doc: string, line: number, rule: string, severity: 'error', message: string}} 诊断。
 */
function diagnostic(doc, line, rule, message) {
  return { doc, line, rule, severity: 'error', message }
}

/**
 * 去掉标题两边可能包着的一对反引号。
 *
 * @param {string} text - 标题文本。
 * @returns {string} 纯路径文本。
 */
function stripInlineCode(text) {
  const trimmed = text.trim()
  const match = /^`([^`]+)`$/.exec(trimmed)
  return match ? match[1].trim() : trimmed
}

/**
 * 找某个标题所属段落的结束行。
 *
 * 段落一直延伸到下一个级别不高于 `maxLevel` 的标题之前；这样 `## L1` 的正文
 * 会包含它下面的 `### 模块`，而下一个 `##` 会开启新的层级。
 *
 * @param {{level: number, line: number}[]} headings - 全部标题。
 * @param {number} index - 当前标题在数组里的下标。
 * @param {number} lineCount - 文档总行数。
 * @param {number} maxLevel - 视为同级或更高的最大标题级别。
 * @returns {number} 段落最后一行的 1-based 行号。
 */
function sectionEnd(headings, index, lineCount, maxLevel) {
  for (let next = index + 1; next < headings.length; next += 1) {
    if (headings[next].level <= maxLevel) return headings[next].line - 1
  }
  return lineCount
}

/**
 * 取某个标题的「直属正文」行：直到下一个任意级别的标题之前。
 *
 * file.md 用这个规则——`# src` 的说明只算到 `## src/main.ts` 之前，
 * 不能拿子项的说明来顶替自己的说明。
 *
 * @param {string[]} lines - 文档全部行。
 * @param {{line: number}} heading - 当前标题。
 * @param {{line: number}[]} headings - 全部标题。
 * @param {number} index - 当前标题下标。
 * @returns {{text: string, line: number}[]} 直属正文行。
 */
function directBody(lines, heading, headings, index) {
  const nextLine = index + 1 < headings.length ? headings[index + 1].line : lines.length + 1
  const body = []
  for (let line = heading.line + 1; line < nextLine; line += 1) {
    body.push({ text: lines[line - 1], line })
  }
  return body
}

/**
 * 校验 file.md 里的一个标题路径。
 *
 * @param {string} raw - 标题里的路径文本。
 * @returns {{rule: string, message: string}|null} 问题；合法时为 null。
 */
function pathIssue(raw) {
  if (raw === '') {
    return { rule: 'file.path.empty', message: '标题后面缺少路径。' }
  }
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return { rule: 'file.path.absolute', message: `路径必须相对于项目根目录，不能是绝对路径：${raw}` }
  }
  if (raw.includes('\\')) {
    return { rule: 'file.path.separator', message: `路径必须使用 / 分隔：${raw}` }
  }
  const segments = raw.split('/')
  if (segments.includes('..')) {
    return { rule: 'file.path.traversal', message: `路径不能包含 ..：${raw}` }
  }
  if (segments.includes('.')) {
    return { rule: 'file.path.dot-segment', message: `路径不能包含 . 路径段：${raw}` }
  }
  if (segments.includes('')) {
    return { rule: 'file.path.empty-segment', message: `路径不能以 / 结尾或包含空路径段：${raw}` }
  }
  return null
}

/**
 * 判断一个路径/通配是否指向 `.coder` 自身或它下面。
 *
 * @param {string} value - 路径文本。
 * @returns {boolean} 是否属于 `.coder`。
 */
function isCoderPath(value) {
  return value === DOCS_DIR || value.startsWith(`${DOCS_DIR}/`)
}

/**
 * 从 file.md 的标题里取出用于覆盖检查的路径/通配。
 *
 * 只取一级和二级标题；路径本身非法的标题已经由 {@link validateFile} 报过，
 * 这里跳过，避免同一条问题重复出现。`.coder` 自身不参与覆盖。
 *
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {{path: string, line: number, level: number}[]} 路径模式。
 */
function extractFilePatterns(analysis) {
  const patterns = []
  for (const heading of analysis.headings) {
    if (heading.level > 2) continue
    const raw = stripInlineCode(heading.text)
    if (isCoderPath(raw)) continue
    if (pathIssue(raw) !== null) continue
    patterns.push({ path: raw, line: heading.line, level: heading.level })
  }
  return patterns
}

/**
 * 检查 file.md 是否覆盖项目里的每个文件。
 *
 * `.coder` 自身及其内容不要求描述；其余文件必须至少被一个路径/通配匹配。
 * 目录不需要单独成条：`tmp/**` 已经同时表达目录和它下面的文件。
 *
 * @param {string} text - file.md 正文。
 * @param {string[]} files - 项目文件（相对路径，已排除 `.coder`）。
 * @returns {object[]} 诊断。
 */
export function fileCoverage(text, files) {
  const analysis = analyzeMarkdown(text)
  const patterns = extractFilePatterns(analysis)
  const doc = `${DOCS_DIR}/${EXPECTED_DOCS[0]}`
  const diagnostics = []

  for (const file of files) {
    if (file === DOCS_DIR || file.startsWith(`${DOCS_DIR}/`)) continue
    if (patterns.some((entry) => matchGlob(entry.path, file))) continue
    diagnostics.push(
      diagnostic(
        doc,
        1,
        'file.coverage.missing',
        `文件未被 file.md 描述：${file}。用类似 tmp/** 的通配表达覆盖它。`,
      ),
    )
  }

  return diagnostics
}

/**
 * 反向校验 file.md 的标题：具体路径必须存在，通配至少要命中一个项目文件。
 *
 * 具体路径（不含 `*` / `?`）不存在时报 `file.path.missing`；通配零命中只写成
 * 提示（`kind: 'unused-glob'`），因为像 `tmp/**` 这样的条目可能描述的是还没
 * 创建、或暂时为空的目录。
 *
 * @param {string} text - file.md 正文。
 * @param {string} root - 项目根目录。
 * @param {string[]} files - 项目文件，相对路径。
 * @returns {Promise<{diagnostics: object[], hints: object[]}>} 诊断与提示。
 */
export async function fileReferences(text, root, files) {
  const doc = `${DOCS_DIR}/${EXPECTED_DOCS[0]}`
  const diagnostics = []
  const hints = []
  const analysis = analyzeMarkdown(text)
  for (const heading of analysis.headings) {
    if (heading.level > 2) continue
    const raw = stripInlineCode(heading.text)
    if (isCoderPath(raw) || pathIssue(raw) !== null) continue
    if (/[*?]/.test(raw)) {
      const matches = files.filter((file) => matchGlob(raw, file)).length
      if (matches === 0) {
        hints.push({ kind: 'unused-glob', doc, line: heading.line, path: raw })
      }
      continue
    }
    const absolute = path.join(root, ...raw.split('/'))
    const stat = await fs.stat(absolute).catch(() => null)
    if (stat === null) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'file.path.missing', `file.md 描述的路径不存在：${raw}。`),
      )
    }
  }
  return { diagnostics, hints }
}

/**
 * 校验 file.md。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {ReturnType<typeof analyzeMarkdown>} analysis - 解析结果。
 * @returns {object[]} 诊断。
 */
function validateFile(doc, analysis) {
  const diagnostics = []
  const { lines, headings, masked } = analysis

  if (headings.length === 0) {
    diagnostics.push(diagnostic(doc, 1, 'file.no-heading', 'file.md 里没有任何 # 或 ## 标题。'))
    return diagnostics
  }

  const entries = []
  const seen = new Map()
  const levelOne = new Set()

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (heading.level > 2) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'file.heading.level', `标题级别为 ${heading.level}；file.md 只用 #（目录或独立文件）和 ##（目录下的文件）。`),
      )
    }
    const raw = stripInlineCode(heading.text)
    if (isCoderPath(raw)) {
      diagnostics.push(
        diagnostic(doc, heading.line, 'file.entry.coder', 'file.md 不能描述 .coder 自身或它下面的文件。'),
      )
      continue
    }
    const issue = pathIssue(raw)
    if (issue !== null) {
      diagnostics.push(diagnostic(doc, heading.line, issue.rule, issue.message))
    } else {
      if (seen.has(raw)) {
        diagnostics.push(diagnostic(doc, heading.line, 'file.path.duplicate', `路径重复：${raw}（第一次出现在第 ${seen.get(raw)} 行）。`))
      } else {
        seen.set(raw, heading.line)
      }
      if (heading.level === 1) levelOne.add(raw)
      entries.push({ heading, index, path: raw })
    }

    const body = directBody(lines, heading, headings, index)
    const outside = body.filter((line) => line.text.trim() !== '' && !masked[line.line - 1])
    if (outside.length === 0) {
      diagnostics.push(diagnostic(doc, heading.line, 'file.description.missing', `${raw} 后面至少需要一行非空说明。`))
    }
    for (const line of outside) {
      if (NEGATION_START.test(line.text.trim()) || NEGATION_ANY.test(line.text)) {
        diagnostics.push(
          diagnostic(doc, line.line, 'file.description.negated', '说明只描述正向预期；反向约束请改写成期望达到的状态。'),
        )
      }
    }
  }

  for (const entry of entries) {
    if (entry.heading.level !== 2) continue
    const slash = entry.path.indexOf('/')
    if (slash <= 0) {
      diagnostics.push(diagnostic(doc, entry.heading.line, 'file.path.parent', `二级标题必须是目录下的文件：${entry.path}`))
      continue
    }
    const parent = entry.path.slice(0, slash)
    if (!levelOne.has(parent)) {
      diagnostics.push(
        diagnostic(doc, entry.heading.line, 'file.parent.missing', `父路径 ${parent} 没有以一级标题出现过。`),
      )
    }
  }

  return diagnostics
}

/**
 * 诊断一份文档。
 *
 * @param {string} doc - 展示用文档路径。
 * @param {string} text - 文档正文。
 * @param {'file'|'architecture'|'flow'|'data'|'modules'|`module-${string}`|'diagnosis-error'|'diagnosis-warn'|'plan-todo'|'plan-todo-archived'|'plan-goal'|'plan-goal-archived'|'issue-open'|'issue-close'|'requirement'|'log-audit'|'log-update'|'log-usage'|'log-research'|'members-all'|'members-flow'|'lock'|'generic'} kind - 文档类型。
 * @param {string[]} [files] - 项目文件；诊断文档用它检查文件通配范围。
 * @returns {object[]} 诊断。
 */
export function validateDocument(doc, text, kind, files) {
  if (kind === 'diagnosis-error' || kind === 'diagnosis-warn') {
    return inspectDiagnosis(doc, text, diagnosisSeverity(kind), files).diagnostics
  }
  if (kind.startsWith('plan-')) {
    return inspectPlan(doc, text, kind).diagnostics
  }
  if (kind === 'requirement') {
    const meta = requirementMetaOf(doc.slice(DOCS_DIR.length + 1).replaceAll('\\', '/'))
    return meta === null ? [] : inspectRequirement(doc, text, meta, files).diagnostics
  }
  if (kind === 'log-audit' || kind === 'log-update' || kind === 'log-usage' || kind === 'log-research') {
    const meta = logMetaOf(doc.slice(DOCS_DIR.length + 1).replaceAll('\\', '/'))
    return meta === null ? [] : inspectLog(doc, text, kind, meta).diagnostics
  }
  if (kind === 'issue-open' || kind === 'issue-close') {
    const code = /issue-(\d{4})\.md$/.exec(doc)?.[1] ?? ''
    return inspectIssue(doc, text, kind, code, files).diagnostics
  }
  if (kind === 'members-all') return inspectMembersAll(doc, text).diagnostics
  if (kind === 'members-flow') return inspectMembersFlow(doc, text).diagnostics
  if (kind === 'modules') return inspectModules(doc, text).diagnostics
  if (kind.startsWith('module-')) {
    return inspectModule(doc, text, kind.slice('module-'.length)).diagnostics
  }

  const diagnostics = []
  if (text.trim() === '') {
    diagnostics.push(diagnostic(doc, 1, 'doc.empty', '文档是空的。'))
    return diagnostics
  }
  const analysis = analyzeMarkdown(text)
  if (analysis.unclosed !== null) {
    diagnostics.push(
      diagnostic(doc, analysis.unclosed.startLine, 'markdown.unclosed-fence', '代码围栏没有闭合。'),
    )
  }
  if (kind === 'file') diagnostics.push(...validateFile(doc, analysis))
  else if (kind === 'architecture') diagnostics.push(...validateArchitecture(doc, analysis))
  else if (kind === 'flow') diagnostics.push(...validateFlow(doc, analysis))
  else if (kind === 'data') diagnostics.push(...validateData(doc, analysis))
  return diagnostics
}

/**
 * 递归列出一个目录下的全部普通文件。
 *
 * 不跟随符号链接：文档树之外的路径不应该被这次只读检查带进来。
 *
 * @param {string} dir - 绝对目录。
 * @param {string} root - 文档树根目录，用于计算相对路径。
 * @returns {Promise<string[]>} 使用 `/` 分隔的相对路径，已排序。
 */
async function walk(dir, root) {
  const result = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await walk(absolute, root)))
    } else if (entry.isFile()) {
      result.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  return result
}

/**
 * 列出项目里除 `.coder` 外的全部普通文件。
 *
 * 只跳过项目根目录下的 `.coder`；其他目录（包括 `node_modules`、`.git`）
 * 都按“所有文件”的规则参与覆盖检查，需要时用 `node_modules/**` 之类的
 * 通配表达。符号链接不跟随。
 *
 * @param {string} root - 项目根目录。
 * @returns {Promise<string[]>} 使用 `/` 分隔的相对路径，已排序。
 */
async function walkProject(root) {
  const files = []
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        if (relative === DOCS_DIR) continue
        await visit(absolute)
      } else if (entry.isFile()) {
        if (relative === DOCS_DIR) continue
        files.push(relative)
      }
    }
  }
  await visit(root)
  return files
}

/**
 * 解析可选的 `.coder/manifest.json`。
 *
 * 空文件等同默认配置。目前只支持一个键：`largeCodeFileBytes`（正整数，单位
 * 字节）。JSON 不合法、类型不对或出现未知键都会变成诊断，让配置错误暴露出来。
 *
 * @param {string} text - 文件正文。
 * @returns {{threshold: number, diagnostics: object[]}} 阈值与诊断。
 */
export function parseManifest(text) {
  const doc = `${DOCS_DIR}/${MANIFEST_DOC}`
  const diagnostics = []
  let threshold = DEFAULT_LARGE_CODE_FILE_BYTES
  if (text.trim() === '') return { threshold, diagnostics }

  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    diagnostics.push(
      diagnostic(
        doc,
        1,
        'manifest.invalid',
        `无法解析 JSON：${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return { threshold, diagnostics }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(diagnostic(doc, 1, 'manifest.invalid', 'manifest.json 必须是 JSON 对象。'))
    return { threshold, diagnostics }
  }

  for (const key of Object.keys(value)) {
    if (key !== 'largeCodeFileBytes') {
      diagnostics.push(
        diagnostic(doc, 1, 'manifest.unknown', `不支持的配置项：${key}；目前只支持 largeCodeFileBytes。`),
      )
    }
  }

  if (Object.hasOwn(value, 'largeCodeFileBytes')) {
    const bytes = value.largeCodeFileBytes
    if (!Number.isInteger(bytes) || bytes <= 0) {
      diagnostics.push(
        diagnostic(
          doc,
          1,
          'manifest.value',
          `largeCodeFileBytes 必须是正整数（字节）；收到：${JSON.stringify(bytes)}。`,
        ),
      )
    } else {
      threshold = bytes
    }
  }

  return { threshold, diagnostics }
}

/**
 * 收集超过阈值的大代码文件，供 `list` 提示拆分。
 *
 * 只统计源码扩展名；`.git`、`node_modules`、`dist`、`build`、`tmp` 等依赖和
 * 产物目录跳过，避免把依赖里的源码也算进来。
 *
 * @param {string} root - 项目根目录。
 * @param {string[]} files - 项目文件，相对路径。
 * @param {number} threshold - 阈值（字节）。
 * @returns {Promise<{path: string, bytes: number, threshold: number}[]>} 按大小降序的提示。
 */
export async function collectLargeFileHints(root, files, threshold) {
  const hints = []
  for (const relative of files) {
    if (!CODE_FILE_EXTENSION.test(relative)) continue
    const segments = relative.split('/')
    if (segments.includes('node_modules') || HINT_SKIP_DIRS.has(segments[0])) continue
    const absolute = path.join(root, ...segments)
    const stat = await fs.stat(absolute).catch(() => null)
    if (stat === null || !stat.isFile() || stat.size <= threshold) continue
    hints.push({ kind: 'large-code', path: relative, bytes: stat.size, threshold })
  }
  hints.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
  return hints
}

/**
 * 拼一个展示用路径。
 *
 * @param {string} relative - 相对路径；空串表示文档树根。
 * @returns {string} 例如 `.coder/design/file.md`。
 */
function displayPath(relative) {
  return relative === '' ? DOCS_DIR : `${DOCS_DIR}/${relative}`
}

/**
 * 把检查结果整理成一段可读文本。
 *
 * @param {object} report - `inspectDocs` 的结果。
 * @returns {string} 汇总文本。
 */
function formatReport(report) {
  const lines = [`Coder 文档检查：${report.docsRoot}`]
  if (!report.docsRootExists) lines.push(`（${DOCS_DIR}/ 不存在。）`)
  lines.push(
    `预期 ${report.summary.expected}｜找到 ${report.summary.found}｜可选 ${report.summary.optional}｜非法 ${report.summary.illegal}｜缺失 ${report.summary.missing}｜诊断 ${report.summary.diagnostics}｜计划 ${report.summary.plans}｜模块 ${report.summary.modules}｜问题 ${report.summary.issues}｜需求 ${report.summary.requirements}｜日志 ${report.summary.logs}${report.summary.hints > 0 ? `｜提示 ${report.summary.hints}` : ''}${report.summary.locked ? '｜已上锁' : ''}`,
  )
  if (report.illegal.length > 0) {
    lines.push('')
    lines.push('非法文档：')
    for (const item of report.illegal) lines.push(`  ${item}`)
  }
  if (report.missing.length > 0) {
    lines.push('')
    lines.push('缺失文档：')
    for (const item of report.missing) lines.push(`  ${item}`)
  }
  if (report.diagnoses.length > 0) {
    lines.push('')
    lines.push('诊断码：')
    for (const item of report.diagnoses) {
      const scope =
        item.scopeKind === 'global'
          ? '全局'
          : item.scopeKind === 'glob'
            ? `${item.scope}（命中 ${item.matches ?? '未检查'} 个文件）`
            : '作用范围无效'
      const method = item.method ?? '诊断方式无效'
      lines.push(`  ${item.code} [${item.severity}] ${scope}｜诊断方式 ${method}｜步骤 ${item.steps.length}`)
    }
  }
  if (report.modules.length > 0) {
    lines.push('')
    lines.push('模块：')
    for (const item of report.modules) {
      lines.push(`  ${item.code}｜${item.description}`)
    }
  }
  if (report.moduleDocs.length > 0) {
    lines.push('')
    lines.push('模块详情：')
    for (const item of report.moduleDocs) {
      lines.push(`  ${item.code ?? '编码无效'}｜子模块 ${item.submodules.length}`)
    }
  }
  if (report.hints.length > 0) {
    lines.push('')
    lines.push('提示：')
    for (const hint of report.hints) {
      if (hint.kind === 'unused-glob') {
        lines.push(
          `  ${hint.path}｜${hint.doc}:${hint.line}｜通配没有命中任何项目文件｜可能已过期，或目录还没有内容`,
        )
      } else {
        lines.push(
          `  ${hint.path}｜${(hint.bytes / 1024).toFixed(1)} KB（阈值 ${(hint.threshold / 1024).toFixed(1)} KB）｜建议拆分`,
        )
      }
    }
  }
  if (report.diagnostics.length > 0) {
    lines.push('')
    lines.push('诊断：')
    for (const item of report.diagnostics) {
      lines.push(`  ${item.doc}:${item.line} [${item.rule}] ${item.message}`)
    }
  }
  if (report.ok) {
    lines.push('')
    lines.push('所有文档齐全且格式正确。')
  }
  return lines.join('\n')
}

/**
 * 检查一个项目的 `.coder/` 文档树。
 *
 * @param {object} options - 选项。
 * @param {string} options.root - 项目根目录（绝对路径或可解析的相对路径）。
 * @returns {Promise<object>} 结构化报告，带 `text` 汇总。
 * @throws {CoderError} 根目录不存在或不可读时。
 */
export async function inspectDocs({ root }) {
  const absoluteRoot = path.resolve(root)
  const rootStat = await fs.stat(absoluteRoot).catch(() => null)
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new CoderError(`项目根目录不存在或不是目录：${absoluteRoot}`)
  }

  const docsRoot = path.resolve(absoluteRoot, DOCS_DIR)
  const diagnostics = []
  const diagnoses = []
  const plans = []
  const modules = []
  const moduleDocs = []
  const issues = { open: [], close: [], all: [] }
  const requirements = { registered: [], accepted: [], developing: [], current: [], history: [], discarded: [], all: [] }
  const logs = { audit: [], update: [], usage: [], research: [], all: [] }
  let docsRootExists = false
  let discovered = []
  let projectFiles = null
  let allFiles = null

  const docsRootStat = await fs.stat(docsRoot).catch((error) => {
    if (error && error.code === 'ENOENT') return null
    throw new CoderError(`无法读取 ${docsRoot}：${error instanceof Error ? error.message : String(error)}`)
  })

  if (docsRootStat !== null) {
    if (!docsRootStat.isDirectory()) {
      diagnostics.push(diagnostic(DOCS_DIR, 1, 'docsRoot.not-directory', `${DOCS_DIR} 不是目录。`))
    } else {
      docsRootExists = true
      discovered = await walk(docsRoot, docsRoot)
    }
  }

  let largeCodeFileBytes = DEFAULT_LARGE_CODE_FILE_BYTES
  if (docsRootExists) {
    const manifestDoc = `${DOCS_DIR}/${MANIFEST_DOC}`
    const manifestAbsolute = path.join(docsRoot, MANIFEST_DOC)
    let manifestText = null
    try {
      manifestText = await fs.readFile(manifestAbsolute, 'utf8')
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        diagnostics.push(
          diagnostic(
            manifestDoc,
            1,
            'doc.unreadable',
            `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }
    if (manifestText !== null) {
      const parsed = parseManifest(manifestText)
      diagnostics.push(...parsed.diagnostics)
      largeCodeFileBytes = parsed.threshold
    }
  }

  const expectedSet = new Set(EXPECTED_DOCS)
  const discoveredSet = new Set(discovered)
  const documents = []

  const referenceHints = []

  for (const relative of EXPECTED_DOCS) {
    const exists = discoveredSet.has(relative)
    documents.push({
      path: displayPath(relative),
      relative,
      absolute: path.join(docsRoot, ...relative.split('/')),
      status: exists ? 'expected' : 'missing',
      exists,
      kind: kindOf(relative),
    })
  }

  for (const relative of discovered) {
    if (expectedSet.has(relative) || relative === LOCK_RELATIVE) continue
    const optional = isOptionalDoc(relative)
    documents.push({
      path: displayPath(relative),
      relative,
      absolute: path.join(docsRoot, ...relative.split('/')),
      status: optional ? 'optional' : 'illegal',
      exists: true,
      kind: kindOf(relative),
    })
  }

  const hasLock = discovered.includes(LOCK_RELATIVE)
  if (hasLock) {
    documents.push({
      path: displayPath(LOCK_RELATIVE),
      relative: LOCK_RELATIVE,
      absolute: path.join(docsRoot, LOCK_RELATIVE),
      status: 'lock',
      exists: true,
      kind: 'lock',
    })
  }

  async function ensureProjectFiles() {
    if (projectFiles === null) {
      try {
        projectFiles = await walkProject(absoluteRoot)
      } catch (error) {
        throw new CoderError(
          `无法列出 ${absoluteRoot} 的文件：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return projectFiles
  }

  async function ensureAllFiles() {
    if (allFiles === null) {
      const project = await ensureProjectFiles()
      const docs = discovered.map((relative) => `${DOCS_DIR}/${relative}`)
      allFiles = [...new Set([...project, ...docs])].sort((a, b) => a.localeCompare(b))
    }
    return allFiles
  }

  for (const relative of discovered) {
    if (!MARKDOWN_EXTENSION.test(relative) || relative === LOCK_RELATIVE) continue
    const doc = displayPath(relative)
    const absolute = path.join(docsRoot, ...relative.split('/'))
    const text = await fs.readFile(absolute, 'utf8').catch((error) => {
      diagnostics.push(
        diagnostic(doc, 1, 'doc.unreadable', `无法读取文件：${error instanceof Error ? error.message : String(error)}`),
      )
      return null
    })
    if (text === null) continue
    const kind = kindOf(relative)
    if (kind === 'diagnosis-error' || kind === 'diagnosis-warn') {
      const result = inspectDiagnosis(doc, text, diagnosisSeverity(kind), await ensureAllFiles())
      diagnostics.push(...result.diagnostics)
      diagnoses.push(...result.codes)
    } else if (kind.startsWith('plan-')) {
      const result = inspectPlan(doc, text, kind, planMetaOf(relative)?.code ?? null)
      diagnostics.push(...result.diagnostics)
      plans.push(...result.entries)
    } else if (kind === 'issue-open' || kind === 'issue-close') {
      const code = issueNumber(relative) ?? ''
      const result = inspectIssue(doc, text, kind, code, await ensureProjectFiles())
      diagnostics.push(...result.diagnostics)
      const entry = { ...result.entry, doc, path: doc, relative }
      if (kind === 'issue-open') issues.open.push(entry)
      else issues.close.push(entry)
    } else if (kind === 'requirement') {
      const meta = requirementMetaOf(relative)
      const result = inspectRequirement(doc, text, meta, await ensureProjectFiles())
      diagnostics.push(...result.diagnostics)
      requirements[meta.key].push({ ...result.entry, path: doc, relative })
    } else if (kind === 'log-audit' || kind === 'log-update' || kind === 'log-usage' || kind === 'log-research') {
      const meta = logMetaOf(relative)
      const result = inspectLog(doc, text, kind, meta)
      diagnostics.push(...result.diagnostics)
      if (result.entry !== null) {
        logs[result.entry.kind].push({ ...result.entry, path: doc, relative })
      }
    } else if (kind === 'modules') {
      const result = inspectModules(doc, text)
      diagnostics.push(...result.diagnostics)
      modules.push(...result.entries)
    } else if (kind.startsWith('module-')) {
      const moduleCode = moduleNumber(relative)
      const result = inspectModule(doc, text, moduleCode ?? '')
      diagnostics.push(...result.diagnostics)
      moduleDocs.push({ doc, relative, code: moduleCode, submodules: result.submodules })
    } else {
      diagnostics.push(...validateDocument(doc, text, kind))
    }
    if (kind === 'file' && relative === EXPECTED_DOCS[0]) {
      const projectFiles = await ensureProjectFiles()
      diagnostics.push(...fileCoverage(text, projectFiles))
      const references = await fileReferences(text, absoluteRoot, projectFiles)
      diagnostics.push(...references.diagnostics)
      referenceHints.push(...references.hints)
    }
  }

  const planRank = (entry) => (entry.kind === 'todo' ? 0 : 2) + (entry.archived ? 1 : 0)
  plans.sort((a, b) => planRank(a) - planRank(b) || a.code.localeCompare(b.code))

  const planCodes = new Map()
  for (const entry of plans) {
    const key = `${entry.kind}:${entry.code}`
    const previous = planCodes.get(key)
    if (previous === undefined) {
      planCodes.set(key, entry)
    } else if (previous.archived !== entry.archived) {
      diagnostics.push(
        diagnostic(
          entry.doc,
          entry.line,
          'plan.code.archived-duplicate',
          `${entry.code} 同时出现在 ${previous.doc} 与 ${entry.doc}；完成的任务只保留在归档文档中。`,
        ),
      )
    }
  }

  modules.sort((a, b) => a.line - b.line)
  moduleDocs.sort((a, b) => a.relative.localeCompare(b.relative))
  issues.open.sort((a, b) => a.code.localeCompare(b.code))
  issues.close.sort((a, b) => a.code.localeCompare(b.code))
  issues.all = [
    ...issues.open.map((entry) => ({ code: entry.code, path: entry.path, status: '开启' })),
    ...issues.close.map((entry) => ({ code: entry.code, path: entry.path, status: '关闭' })),
  ]

  const requirementRank = new Map(REQUIREMENT_STATUSES.map((status, index) => [status.key, index]))
  const requirementSort = (a, b) => a.code.localeCompare(b.code) || requirementRank.get(a.key) - requirementRank.get(b.key)
  for (const status of REQUIREMENT_STATUSES) requirements[status.key].sort(requirementSort)
  requirements.all = REQUIREMENT_STATUSES.flatMap((status) => requirements[status.key])
  const requirementCodes = new Map()
  for (const entry of requirements.all) {
    const previous = requirementCodes.get(entry.code)
    if (previous === undefined) {
      requirementCodes.set(entry.code, entry)
    } else if (previous.key !== entry.key) {
      diagnostics.push(
        diagnostic(
          entry.doc,
          entry.line,
          'requirement.status.conflict',
          `${entry.code} 同时出现在 ${previous.doc} 与 ${entry.doc}；一个需求只能放在一个状态目录里。`,
        ),
      )
    }
  }

  const logSort = (a, b) => a.date.localeCompare(b.date) || a.sequence.localeCompare(b.sequence)
  for (const kind of ['audit', 'update', 'usage', 'research']) {
    logs[kind].sort(logSort)
    const byDate = new Map()
    for (const entry of logs[kind]) {
      const group = byDate.get(entry.date) ?? []
      group.push(entry)
      byDate.set(entry.date, group)
    }
    for (const [date, group] of byDate) {
      group.sort(logSort)
      let expected = 1
      for (const entry of group) {
        const actual = Number(entry.sequence)
        if (actual !== expected) {
          diagnostics.push(
            diagnostic(
              entry.doc,
              entry.line,
              'log.sequence.gap',
              `同一天（${date}）的序号必须从 001 开始连续；${entry.sequence} 之前缺少 ${String(expected).padStart(3, '0')}。`,
            ),
          )
        }
        expected = actual + 1
      }
    }
    logs.all.push(...logs[kind])
  }

  const indexedModules = new Map(modules.map((entry) => [entry.code, entry]))
  const moduleFiles = new Map(
    moduleDocs.filter((entry) => entry.code !== null).map((entry) => [entry.code, entry]),
  )
  for (const entry of modules) {
    if (!moduleFiles.has(entry.code)) {
      diagnostics.push(
        diagnostic(
          entry.doc,
          entry.line,
          'module.file.missing',
          `模块索引登记了 ${entry.code}，但 ${DOCS_DIR}/design/module-${entry.code}.md 不存在。`,
        ),
      )
    }
  }
  for (const file of moduleDocs) {
    if (file.code === null) continue
    if (!indexedModules.has(file.code)) {
      diagnostics.push(
        diagnostic(
          file.doc,
          1,
          'module.index.missing',
          `模块文件 ${file.code} 没有出现在 ${DOCS_DIR}/design/modules.md 中。`,
        ),
      )
    }
    for (const submodule of file.submodules) {
      if (!moduleFiles.has(submodule.code)) {
        diagnostics.push(
          diagnostic(
            submodule.doc,
            submodule.line,
            'module.submodule.missing',
            `子模块 ${submodule.code} 没有对应的 ${DOCS_DIR}/design/module-${submodule.code}.md。`,
          ),
        )
      }
    }
  }

  const openIssues = new Map(issues.open.map((entry) => [entry.code, entry]))
  for (const entry of issues.close) {
    const other = openIssues.get(entry.code)
    if (other !== undefined) {
      diagnostics.push(
        diagnostic(
          entry.doc,
          entry.line,
          'issue.status.conflict',
          `${entry.code} 同时出现在 ${other.path} 与 ${entry.path}；一个问题只能放在 open/ 或 close/ 一个文件夹里。`,
        ),
      )
    }
  }

  const hints = [
    ...(await collectLargeFileHints(absoluteRoot, await ensureProjectFiles(), largeCodeFileBytes)),
    ...referenceHints,
  ]

  let lock = hasLock
    ? {
        present: true,
        path: displayPath(LOCK_RELATIVE),
        declarationValid: false,
        hash: null,
        hashMatches: null,
        currentHash: null,
        authorizationLength: 0,
      }
    : null
  if (hasLock) {
    const doc = displayPath(LOCK_RELATIVE)
    let parsed = null
    try {
      parsed = await readLock(docsRoot)
    } catch (error) {
      diagnostics.push(
        diagnostic(doc, 1, 'doc.unreadable', `无法读取文件：${error instanceof Error ? error.message : String(error)}`),
      )
    }
    if (parsed !== null) {
      let hashMatches = null
      let currentHash = null
      if (parsed.hashValid) {
        try {
          currentHash = (await hashCoder(docsRoot)).hash
          hashMatches = currentHash === parsed.hash
        } catch (error) {
          diagnostics.push(
            diagnostic(
              doc,
              2,
              'lock.hash.unreadable',
              `无法重新计算 .coder 的 hash：${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      }
      if (!parsed.declarationValid) {
        diagnostics.push(diagnostic(doc, 1, 'lock.declaration', `第一行必须是固定声明：${LOCK_DECLARATION}`))
      }
      if (!parsed.hashValid) {
        diagnostics.push(diagnostic(doc, 2, 'lock.hash.invalid', '第二行必须是 sha256:<64 位小写 hex>。'))
      }
      if (!parsed.authorizationPresent) {
        diagnostics.push(diagnostic(doc, 3, 'lock.authorization.missing', '第三行起缺少用户授权原文。'))
      }
      if (parsed.hashValid && hashMatches === false) {
        diagnostics.push(
          diagnostic(doc, 2, 'lock.hash.mismatch', 'lock.md 记录的 hash 与当前 .coder 的内容不一致；请自查哪些文件被直接修改。'),
        )
      }
      lock = {
        present: true,
        path: doc,
        declarationValid: parsed.declarationValid,
        hash: parsed.hash,
        hashMatches,
        currentHash,
        authorizationLength: parsed.authorization.length,
      }
    }
  }

  const illegal = documents.filter((document) => document.status === 'illegal').map((document) => document.path)
  const missing = documents.filter((document) => document.status === 'missing').map((document) => document.path)
  const summary = {
    expected: EXPECTED_DOCS.length,
    found: EXPECTED_DOCS.length - missing.length,
    illegal: illegal.length,
    optional: documents.filter((document) => document.status === 'optional').length,
    missing: missing.length,
    diagnostics: diagnostics.length,
    codes: diagnoses.length,
    plans: plans.length,
    modules: modules.length,
    moduleFiles: moduleDocs.length,
    issues: issues.all.length,
    openIssues: issues.open.length,
    closedIssues: issues.close.length,
    requirements: requirements.all.length,
    registeredRequirements: requirements.registered.length,
    acceptedRequirements: requirements.accepted.length,
    developingRequirements: requirements.developing.length,
    currentRequirements: requirements.current.length,
    historyRequirements: requirements.history.length,
    discardedRequirements: requirements.discarded.length,
    logs: logs.all.length,
    auditLogs: logs.audit.length,
    updateLogs: logs.update.length,
    usageLogs: logs.usage.length,
    researchLogs: logs.research.length,
    hints: hints.length,
    locked: lock !== null,
  }
  const ok = illegal.length === 0 && missing.length === 0 && diagnostics.length === 0

  const report = {
    ok,
    root: absoluteRoot,
    docsRoot,
    docsRootExists,
    documents,
    illegal,
    missing,
    diagnostics,
    diagnoses,
    plans,
    modules,
    moduleDocs,
    issues,
    requirements,
    logs,
    hints,
    manifest: { largeCodeFileBytes },
    lock,
    summary,
  }
  report.text = formatReport(report)
  return report
}
