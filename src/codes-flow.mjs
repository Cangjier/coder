/**
 * 「生成 codes.jsonl」这件事的完整流程：文档 → 诊断码 → 落在文档同目录。
 *
 * 独立成一层，是因为它是**一个工具**（`coder_codes`）的主要工作，
 * 同时也是 `coder_debug` 的前置：debug 直接调这里，而不是自己再写一遍。
 *
 * 三步：
 * 0. 仓库里只有一份现成的 `codes.jsonl` 时，直接用它——不选文档、不出码、不起任何子代理；
 * 1. 否则扫描 `**\/docs/*.md`，一个代理判断哪些是规范性文档，另一个代理选出一份；
 * 2. 文档同目录已有 `codes.jsonl` 就原样复用（`force` 才重写），没有才生成；
 * 3. 生成时先出 D 码、再把 D 码交给 Q 码的代理，合并后原子写入。
 *
 * 编辑这份文件用左侧栏的「诊断码」页（client.js + src/web.mjs），插件不再往仓库里写编辑页。
 *
 * 子代理需要一个工作区；调用方给了就用它（debug 的 d 工作区），没给就自己建一个、用完删掉。
 * 走第 0 步时连工作区都不建。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { runStep } from './agents.mjs'
import { codesPathFor, readCodesFile, writeCodesFile } from './codes.mjs'
import { compareRows, CHECK_TYPES, normalizeRow, parseCodes, validateRows } from './codes-client.js'
import { SEVERITIES } from './diagnostics.mjs'
import { docExcerpt, isDocPath, listDocs, topDirs } from './docs.mjs'
import { CoderError, describeError } from './errors.mjs'
import {
  addWorktree,
  linkSharedDirs,
  lsTree,
  readBlob,
  relativeInside,
  removeWorktree,
  scratchRoot,
} from './git.mjs'
import { codesPrompt, selectPrompt, triagePrompt } from './prompts.mjs'
import { exists, makeRunId } from './util.mjs'

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['docs'],
  properties: {
    docs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'normative'],
        properties: {
          path: { type: 'string' },
          normative: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const SELECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string' },
    reason: { type: 'string' },
    ranking: { type: 'array', items: { type: 'string' } },
  },
}

const CODES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['codes'],
  properties: {
    codes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'check', 'severity', 'rule', 'detect', 'fix'],
        properties: {
          code: { type: 'string' },
          check: {
            type: 'string',
            enum: CHECK_TYPES,
            description: 'How this code is checked: static = by reading the code, runtime = by running it.',
          },
          severity: { type: 'string', enum: SEVERITIES },
          rule: { type: 'string' },
          detect: { type: 'string' },
          fix: {
            type: 'string',
            description:
              'Solving idea: what to change so the rule is satisfied, e.g. "route every log line through log() instead of console". Concrete, one or two sentences.',
          },
          targets: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Classes, interfaces or methods this code is about, e.g. ["Session#append"]. Names, not paths. Empty means unrestricted.',
          },
        },
      },
    },
    notes: { type: 'string' },
  },
}

/**
 * 生成（或复用）一份 codes.jsonl。
 *
 * @param {{
 *   ctx: object, config: object, logger?: object, parent: object,
 *   repo: string, head: string, force?: boolean, worktree?: string | null, prefix?: string,
 * }} options
 * @returns {Promise<object>}
 */
export async function runCodesFlow(options) {
  const { ctx, config, logger, parent, repo, head, force = false, worktree = null, prefix = 'coder_codes' } = options
  if (!parent) throw new CoderError('NO_AGENT', '无法确定发起调用的 agent：需要在一个工具调用里执行')

  const warnings = []
  let existingCount = 0

  // 现成的 codes.jsonl 就是答案。只有一份时连「选文档」都不做——那一步只是为了找到它旁边该生成什么。
  if (!force) {
    const found = await inspectCodes({ repo, head })
    existingCount = found.files.length
    const rel = await onlyCodesFile({ files: found.files, warnings })
    if (rel) {
      const reused = await reuseCodes({ repo, head, rel, logger, prefix, warnings })
      if (reused) return reused
    }
  }

  const docList = await listDocs(repo, head, { maxDocs: config.maxDocs })
  if (docList.total === 0) {
    throw new CoderError('NO_DOCS', `提交 ${head.slice(0, 8)} 里没有 **/docs/*.md，也没有现成的 codes.jsonl`)
  }

  const owned = typeof worktree !== 'string' || worktree === ''
  const runId = makeRunId()
  const branch = `coder/codes-${runId}`
  const dir = owned ? path.join(scratchRoot(), `codes-${runId}`, 'repo') : worktree
  let created = false

  try {
    if (owned) {
      await fs.mkdir(path.dirname(dir), { recursive: true })
      await addWorktree(repo, dir, branch, head)
      created = true
      await linkSharedDirs(repo, dir, config.linkDirs)
    }

    const doc = await selectDoc({ ctx, config, logger, parent, repo, worktree: dir, head, docList, prefix })
    const stored = await ensureCodes({
      ctx,
      config,
      logger,
      parent,
      repo,
      head,
      doc: doc.doc,
      worktree: dir,
      force,
      existingCount,
      prefix,
      warnings,
    })

    return {
      ok: true,
      head,
      doc: doc.doc,
      ...stored,
      warnings,
    }
  } finally {
    if (owned && created && config.cleanup) {
      await removeWorktree(repo, dir).catch((error) => {
        logger?.warn?.(`${prefix}: 清理临时工作区失败：${describeError(error).message}`)
      })
      // removeWorktree 只管 worktree 本身，上层目录（<tmp>/coder-debug/codes-<runId>）也一起收掉。
      await fs.rm(path.dirname(dir), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {})
    }
  }
}

/**
 * 仓库里现成的 codes.jsonl：只有一份时可以直接用，不必再选文档。
 *
 * 0 份 → null（本该生成）；1 份 → 它的相对路径；多份 → null 并留一条 warning
 * （哪一份才是这次要用的，只有选过文档才知道）。
 *
 * @param {{ files: Array<{ path: string }>, warnings: string[] }} input
 * @returns {string | null}
 */
function onlyCodesFile({ files, warnings }) {
  if (files.length === 0) return null
  if (files.length > 1) {
    warnings.push(
      `docs 下有 ${files.length} 份 codes.jsonl（${files.map((item) => item.path).join('、')}），先选文档，再用它旁边那份`,
    )
    return null
  }
  return files[0].path
}

/**
 * 直接复用现成的那一份：不选文档、不生成、不进临时工作区、不起任何子代理。
 *
 * 复用就是只读：codes.jsonl 一个字都不改。
 *
 * 返回 null 表示这份文件是空的（空文件等于没有），交给后面的生成流程。
 *
 * @returns {Promise<object | null>}
 */
async function reuseCodes({ repo, head, rel, logger, prefix, warnings }) {
  const file = path.join(repo, ...rel.split('/'))
  const existing = await readCodesFile(file)
  if (existing.status === 'bad') throw badCodesFile(rel, existing)
  if (existing.status !== 'ok') return null

  const doc = await docOfReused({ repo, head, rel })
  logger?.info?.(`${prefix}: 复用 ${rel}（${existing.rows.length} 条诊断码，只读），没有起子代理`)
  return {
    ok: true,
    head,
    doc,
    ...summarise({ rel, file, rows: existing.rows, reused: true }),
    warnings,
  }
}

/**
 * 复用时不选文档，所以「来源文档」只在同一个 docs 目录下恰好只有一份 Markdown 时才知道；
 * 多份时宁可不写，也不猜。
 *
 * @returns {Promise<object>}
 */
async function docOfReused({ repo, head, rel }) {
  const dir = path.posix.dirname(rel)
  const entries = await lsTree(repo, head)
  const docs = entries
    .filter((entry) => entry.type === 'blob' && isDocPath(entry.path) && path.posix.dirname(entry.path) === dir)
    .map((entry) => entry.path)

  const known = docs.length === 1
  return {
    path: known ? docs[0] : null,
    reason: known
      ? `复用同目录的 ${rel}，没有重新选文档`
      : `复用 ${rel}，没有重新选文档（${dir} 下有 ${docs.length} 份 Markdown，判断不出哪一份是来源）`,
    ranking: known ? docs : [],
    scanned: [],
    total: docs.length,
    truncated: false,
  }
}

/**
 * @param {string} rel
 * @param {{ problems: Array<{ message: string }> }} existing
 * @returns {CoderError}
 */
function badCodesFile(rel, existing) {
  const detail = existing.problems
    .slice(0, 5)
    .map((item) => item.message)
    .join('；')
  return new CoderError(
    'BAD_CODES_FILE',
    `${rel} 有 ${existing.problems.length} 处问题，改好再跑（左侧栏的「诊断码」页就是编辑器）：${detail}`,
    { file: rel, problems: existing.problems.slice(0, 20) },
  )
}

/**
 * 读现有的 codes.jsonl，不生成任何东西。`show` 用它。
 *
 * 候选来自两处：提交里的 `**\/docs/codes.jsonl`，以及提交里每个 docs 目录在工作区里的同名文件
 * （生成后还没入库的时候，只有后者存在）。工作区里有就用工作区的。
 *
 * @param {{ repo: string, head: string }} input
 * @returns {Promise<{ files: Array<object> }>}
 */
export async function inspectCodes({ repo, head }) {
  const entries = await lsTree(repo, head)
  const fromCommit = entries
    .filter((entry) => entry.type === 'blob' && /(^|\/)docs\/codes\.jsonl$/.test(entry.path))
    .map((entry) => entry.path)
  const docDirs = new Set(
    entries
      .filter((entry) => entry.type === 'blob' && isDocPath(entry.path))
      .map((entry) => path.posix.dirname(entry.path)),
  )

  const candidates = new Set(fromCommit)
  for (const dir of docDirs) {
    const rel = dir === '.' ? 'codes.jsonl' : `${dir}/codes.jsonl`
    const absolute = path.join(repo, ...rel.split('/'))
    if (await exists(absolute)) candidates.add(rel)
  }

  const out = []
  for (const rel of [...candidates].sort()) {
    const absolute = path.join(repo, ...rel.split('/'))
    let text = await fs.readFile(absolute, 'utf8').catch(() => null)
    let source = 'working-tree'
    if (text === null) {
      const blob = await readBlob(repo, head, rel)
      text = blob.ok ? blob.text : ''
      source = 'commit'
    }

    const parsed = parseCodes(text)
    const problems = [...parsed.problems, ...validateRows(parsed.rows)]
    out.push({
      path: rel,
      source,
      status: problems.length > 0 ? 'bad' : parsed.rows.length > 0 ? 'ok' : 'empty',
      codes: parsed.rows.map((row) => ({
        code: row.code,
        kind: row.kind,
        check: row.check,
        enabled: row.enabled,
        severity: row.severity,
        rule: row.rule,
        detect: row.detect,
        fix: row.fix,
        targets: row.targets ?? [],
      })),
      problems: problems.map((item) => item.message),
    })
  }
  return { files: out }
}

/**
 * 两族共同的前置：筛选 → 选一份 → 读正文。
 *
 * @returns {Promise<object>}
 */
async function selectDoc({ ctx, config, logger, parent, repo, worktree, head, docList, prefix }) {
  const candidates = []
  for (const doc of docList.docs) {
    candidates.push({ path: doc.path, excerpt: await docExcerpt(repo, head, doc.path, config.docExcerptChars) })
  }

  const triage = await runStep({
    ctx,
    config,
    logger,
    parent,
    repoDir: worktree,
    prefix,
    name: 'triage',
    prompt: triagePrompt(candidates),
    schema: TRIAGE_SCHEMA,
    validate: (value) => validateTriage(value, candidates),
  })

  const scanned = triage.structured.docs.map((item) => ({
    path: String(item.path),
    normative: Boolean(item.normative),
    reason: String(item.reason ?? ''),
  }))
  const normative = scanned.filter((item) => item.normative)
  if (normative.length === 0) {
    throw new CoderError('NO_NORMATIVE_DOC', 'docs 下的 Markdown 没有一份被判定为规范性文档')
  }

  const selection = await runStep({
    ctx,
    config,
    logger,
    parent,
    repoDir: worktree,
    prefix,
    name: 'select',
    prompt: selectPrompt(normative),
    schema: SELECT_SCHEMA,
    validate: (value) => validateSelect(value, normative),
  })

  const docPath = String(selection.structured.path)
  const blob = await readBlob(repo, head, docPath)
  if (!blob.ok) throw new CoderError('DOC_UNREADABLE', `读不到文档：${docPath}`)

  return {
    doc: {
      path: docPath,
      reason: String(selection.structured.reason ?? ''),
      ranking: Array.isArray(selection.structured.ranking) ? selection.structured.ranking.map(String) : [],
      scanned,
      total: docList.total,
      truncated: docList.truncated,
    },
  }
}

/**
 * 诊断码：文档同目录已有 codes.jsonl 就直接复用，没有才生成。
 *
 * 复用是「原样复用」：不改写、不覆盖，也不看文档是否变过——这份文件是人的输入。
 *
 * @returns {Promise<object>}
 */
async function ensureCodes({ ctx, config, logger, parent, repo, head, doc, worktree, force, existingCount, prefix, warnings }) {
  const file = codesPathFor(repo, doc.path)
  const rel = relativeInside(repo, file) ?? path.basename(file)

  if (!force) {
    const existing = await readCodesFile(file)
    if (existing.status === 'bad') throw badCodesFile(rel, existing)
    if (existing.status === 'ok') {
      logger?.info?.(`${prefix}: 复用 ${rel}（${existing.rows.length} 条诊断码，只读）`)
      return summarise({ rel, file, rows: existing.rows, reused: true })
    }
    // 仓库里已经有别人维护的 codes.jsonl，而选中这份文档旁边没有：
    // 不新建——新建等于替用户决定「哪一份算数」，还会在多包仓库里长出第二份。
    if (existing.status === 'absent' && existingCount > 0) {
      throw new CoderError(
        'CODES_AMBIGUOUS',
        `仓库里已有 ${existingCount} 份 codes.jsonl，选中的文档 ${doc.path} 旁边没有，不会替你新建；` +
          '把它放到这份文档旁边，或者删掉多余的那几份，然后重跑',
      )
    }
    if (existing.status === 'empty') warnings.push(`${rel} 是空文件，本次重新生成诊断码`)
  }

  const dirs = await topDirs(repo, head)

  // 先 D 后 Q：Q 会看到 D 的码，从而不去重复同一条规则。
  // 两个代理并行读同一份文档时，同一句规则会被两族各出一次——实测确实大面积重复。
  const debugCodes = await codesAgent({
    ctx,
    config,
    logger,
    parent,
    worktree,
    docPath: doc.path,
    kind: 'debug',
    dirs,
    prefix,
  })
  const rawQuality = await codesAgent({
    ctx,
    config,
    logger,
    parent,
    worktree,
    docPath: doc.path,
    kind: 'quality',
    dirs,
    prefix,
    prior: debugCodes,
  })

  // 兜底：提示词之外，规则原文相同的一律算重复，留 D 那条。
  const seenRules = new Map(debugCodes.map((item) => [normalizeRule(item.rule), item.code]))
  const qualityCodes = []
  const dropped = []
  for (const item of rawQuality) {
    const key = normalizeRule(item.rule)
    if (seenRules.has(key)) {
      dropped.push(`${item.code}→${seenRules.get(key)}`)
      continue
    }
    seenRules.set(key, item.code)
    qualityCodes.push(item)
  }
  if (dropped.length > 0) {
    warnings.push(`质量码里有 ${dropped.length} 条和 Debug 码规则重复，已丢弃：${dropped.slice(0, 8).join('、')}`)
    logger?.info?.(`${prefix}: 丢弃与 D 码重复的质量码 ${dropped.join(', ')}`)
  }

  const rows = [...debugCodes, ...qualityCodes].sort(compareRows)
  if (rows.length === 0) throw new CoderError('NO_CODES', `文档 ${doc.path} 没有提炼出任何诊断码`)

  await writeCodesFile(file, rows)
  logger?.info?.(`${prefix}: 生成 ${rel}（${rows.length} 条诊断码）`)
  return summarise({ rel, file, rows, reused: false })
}

/**
 * @returns {object}
 */
function summarise({ rel, file, rows, reused }) {
  const counts = {
    total: rows.length,
    debug: rows.filter((row) => row.kind === 'debug').length,
    quality: rows.filter((row) => row.kind === 'quality').length,
    disabled: rows.filter((row) => row.enabled === false).length,
  }
  return {
    codes: rows,
    counts,
    file,
    rel,
    reused,
  }
}

/**
 * 生成一族诊断码（D 码或 Q 码）。
 *
 * `prior` 是另一族已有的码：只在生成 Q 码时传，让 Q 不去重复 D 已经覆盖的规则。
 *
 * @returns {Promise<Array<object>>}
 */
async function codesAgent({ ctx, config, logger, parent, worktree, docPath, kind, dirs, prefix, prior }) {
  const result = await runStep({
    ctx,
    config,
    logger,
    parent,
    repoDir: worktree,
    prefix,
    name: `codes-${kind}`,
    prompt: codesPrompt({ path: docPath, worktree, kind, dirs, prior }),
    schema: CODES_SCHEMA,
    validate: (value) => validateCodes(value, kind),
  })
  return normalizeCodes(result.structured.codes).filter((item) => item.kind === kind)
}

/**
 * 规则原文的比较键：去空白、去句末标点，只看「说的是不是同一件事」。
 *
 * @param {unknown} rule
 * @returns {string}
 */
function normalizeRule(rule) {
  return String(rule ?? '')
    .replace(/[\s`*_]/g, '')
    .replace(/[。．.；;，,：:]+$/g, '')
    .toLowerCase()
}

/**
 * 去重并统一成 codes.jsonl 的行结构（含可选的 targets）。
 *
 * @param {Array<object>} codes
 * @returns {Array<object>}
 */
export function normalizeCodes(codes) {
  const seen = new Set()
  const out = []
  for (const item of codes ?? []) {
    const row = normalizeRow(item)
    if (!row.code || seen.has(row.code)) continue
    seen.add(row.code)
    out.push(row)
  }
  return out
}

/**
 * @param {any} value
 * @param {Array<{ path: string }>} candidates
 * @returns {string | null}
 */
function validateTriage(value, candidates) {
  if (!Array.isArray(value?.docs)) return 'docs 必须是数组'
  const returned = new Map(value.docs.map((item) => [String(item?.path ?? ''), item]))
  const missing = candidates.filter((item) => !returned.has(item.path)).map((item) => item.path)
  if (missing.length > 0) return `漏掉了这些路径：${missing.slice(0, 5).join(', ')}`
  for (const item of value.docs) {
    if (typeof item.normative !== 'boolean') return `${item.path} 的 normative 不是布尔值`
  }
  return null
}

/**
 * @param {any} value
 * @param {Array<{ path: string }>} normative
 * @returns {string | null}
 */
function validateSelect(value, normative) {
  const file = String(value?.path ?? '')
  if (!normative.some((item) => item.path === file)) return `path「${file}」不在规范性文档清单里`
  return null
}

/**
 * @param {any} value
 * @param {'debug'|'quality'} kind
 * @returns {string | null}
 */
function validateCodes(value, kind) {
  if (!Array.isArray(value?.codes)) return 'codes 必须是数组'
  if (value.codes.length > 40) return 'codes 超过 40 条，太多了'
  const prefix = kind === 'debug' ? 'D' : 'Q'
  const label = kind === 'debug' ? 'Debug' : 'Quality'

  for (const item of value.codes) {
    const code = String(item?.code ?? '')
    if (!new RegExp(`^${prefix}[0-9]{2,4}$`).test(code)) return `诊断码「${code}」不是 ${prefix}0xx 形式的${label}码`
  }
  // 解决思路是每条码的必备内容：没有它，「诊断出来之后怎么改」就得重新想一遍。
  for (const item of value.codes) {
    if (!String(item?.fix ?? '').trim()) {
      return `${item?.code} 没有写 fix（解决思路）：这条规则被违反时怎么改才算满足它`
    }
  }
  for (const item of value.codes) {
    for (const field of ['targets']) {
      const raw = item?.[field]
      if (raw === undefined || raw === null) continue
      if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
        return `${item?.code} 的 ${field} 应为字符串数组`
      }
    }
  }

  const problems = validateRows(normalizeCodes(value.codes))
  if (problems.length > 0) return problems[0].message
  return null
}
