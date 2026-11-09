/**
 * 编排：诊断码（由 coder_codes 那一段流程产出）→ 静态审查 → 两套独立的运行期检查。
 *
 * 每个 LLM 步骤各起一个独立子代理，互不共享上下文；
 * 插件只做机械动作：git、临时工作区、编译、运行、日志解析、证据核对、清理。
 *
 * 生成 / 复用 codes.jsonl 不在这个文件里，而是 `runCodesFlow`（`coder_codes` 工具也用同一段代码）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { requireSubagents, runStep } from './agents.mjs'
import { runCodesFlow } from './codes-flow.mjs'
import { isCoderArtifact } from './codes.mjs'
import { parseDiagnostics, parseQuality, SEVERITIES, sortEntries } from './diagnostics.mjs'
import { CoderError, describeError } from './errors.mjs'
import {
  addWorktree,
  changedFiles,
  commitAll,
  fingerprint,
  linkSharedDirs,
  readBlob,
  relativeInside,
  removeWorktree,
  resolveChange,
  resolveRepo,
  scratchRoot,
  treeFiles,
} from './git.mjs'
import { instrumentPrompt, integratePrompt, qualityPrompt, reviewPrompt, verifyPrompt } from './prompts.mjs'
import { describeProgram, parseProgram } from './program.mjs'
import { runBuild, runLaunch } from './runner.mjs'
import { renderHtml } from './report.mjs'
import { exists, makeRunId, nowIso, oneLine, readJsonl, writeJsonl } from './util.mjs'

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'file', 'line', 'severity', 'message', 'steps'],
        properties: {
          code: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          column: { type: 'integer' },
          severity: { type: 'string', enum: SEVERITIES },
          message: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'How to reproduce this diagnostic, one action per entry.',
          },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const INSTRUMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sites'],
  properties: {
    sites: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'file', 'line'],
        properties: {
          code: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          note: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

const QUALITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['applicable', 'sites'],
  properties: {
    applicable: { type: 'boolean' },
    sites: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'file', 'line', 'steps'],
        properties: {
          code: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          metric: { type: 'string' },
          note: { type: 'string' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'How to produce this metric, one action per entry.',
          },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'reason'],
        properties: { code: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    notes: { type: 'string' },
  },
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnostics'],
  properties: {
    diagnostics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'severity', 'file', 'line', 'message', 'verdict', 'steps'],
        properties: {
          code: { type: 'string' },
          severity: { type: 'string', enum: SEVERITIES },
          file: { type: 'string' },
          line: { type: 'integer' },
          column: { type: 'integer' },
          message: { type: 'string' },
          verdict: { type: 'string', enum: ['violation', 'pass', 'unknown'] },
          evidence: { type: 'string' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'How to reproduce this diagnostic end to end, one action per entry.',
          },
        },
      },
    },
    summary: { type: 'string' },
  },
}

/**
 * 复核：出完诊断记录后，逐条判断「步骤能不能跑通」与「是不是误报」。
 */
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'repro', 'verdict', 'note'],
        properties: {
          id: { type: 'integer', description: 'The diagnostic id from the list, starting at 1.' },
          repro: { type: 'string', enum: ['pass', 'fail', 'unknown'], description: 'Did the steps actually run?' },
          verdict: {
            type: 'string',
            enum: ['confirmed', 'false-positive', 'uncertain'],
            description: 'Is this diagnostic real?',
          },
          note: { type: 'string', description: 'What you did and what you saw.' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only when repro=fail: corrected steps that do run.',
          },
        },
      },
    },
  },
}

/**
 * @param {{ ctx: object, config: object, logger?: object, exec?: object, args: object }} context
 * @returns {Promise<object>}
 */
export async function runFlow(context) {
  const { ctx, config, logger, exec, args } = context
  const repo = await resolveRepo(args.repo)
  const parent = resolveParent(context)
  if (!parent) throw new CoderError('NO_AGENT', '无法确定发起调用的 agent：coder_debug 需要在工具调用里执行')

  const buildSteps = parseProgram(args.build, 'build')
  const launchSteps = parseProgram(args.launch, 'launch')
  if (launchSteps.length === 0) {
    throw new CoderError('BAD_ARGS', '缺少参数 launch：至少要一步（{type:"cmd",entry:"…"} 或 {type:"dsh-plugin",entry:"<工具名>"}）')
  }
  const { provider } = requireSubagents(ctx, config)

  const changeSpec = normalizeChange(args.change)
  const outRoot = path.resolve(repo, config.outDir)
  const exclude = excludeOf(repo, outRoot)
  const runTimeoutMs = config.runTimeoutMs

  const runId = makeRunId()
  const runDir = path.join(outRoot, 'runs', runId)
  const workspaceRoot = path.join(scratchRoot(), runId)
  const debugDir = path.join(workspaceRoot, 'd')
  const repoDir = path.join(debugDir, 'repo')
  const qualityDir = path.join(workspaceRoot, 'q')
  const qualityRepo = path.join(qualityDir, 'repo')

  const change = await resolveChange(repo, changeSpec)
  // 整仓模式没有差集：范围就是这个提交的完整文件树。
  const files =
    change.mode === 'all' ? await treeFiles(repo, change.head) : await changedFiles(repo, change.base, change.head)
  const before = await fingerprint(repo, { exclude, skip: isCoderArtifact })

  const state = {
    runId,
    createdAt: nowIso(),
    status: 'running',
    input: {
      repo,
      change: changeSpec,
      build: buildSteps,
      launch: launchSteps,
      runTimeoutMs,
    },
    change: { ...change, files },
    environment: { node: process.version, platform: process.platform, subagentProvider: provider },
    docs: null,
    codes: [],
    codeCache: null,
    codesFile: null,
    staticFindings: [],
    instrumentation: null,
    build: null,
    run: null,
    diagnostics: [],
    passed: [],
    qualityRuntime: null,
    lanes: null,
    verification: null,
    rejected: [],
    summary: '',
    warnings: [],
    error: null,
    lines: null,
    cleanup: null,
    integrity: { changed: false },
    fingerprint: { before, after: null },
  }

  await fs.mkdir(workspaceRoot, { recursive: true })
  await addWorktree(repo, repoDir, `coder/${runId}`, change.head)
  await linkSharedDirs(repo, repoDir, config.linkDirs)

  try {
    await pipeline({
      ctx,
      config,
      logger,
      parent,
      state,
      repo,
      repoDir,
      debugDir,
      qualityRepo,
      qualityDir,
      runDir,
      runTimeoutMs,
    })
  } catch (error) {
    state.error = describeError(error)
    state.status = 'failed'
    logger?.error?.(`coder_debug: ${runId} 失败：${state.error.message}`)
  }

  state.status = state.status === 'failed' ? 'failed' : 'done'
  await finalize({ state, runDir, repo, repoDir, qualityRepo, workspaceRoot, config, exclude })
  return summaryOf(state, runDir)
}

/**
 * 主流程。
 *
 * @returns {Promise<void>}
 */
async function pipeline({ ctx, config, logger, parent, state, repo, repoDir, debugDir, qualityRepo, qualityDir, runDir, runTimeoutMs }) {
  const head = state.change.head

  // 诊断码是两族共用的：这就是 coder_codes 的同一段流程，debug 复用它。
  // 工作区用 Debug 线自己的那个（这几个代理只读文档与代码，不会影响后面的插桩）。
  const codesRun = await runCodesFlow({ ctx, config, logger, parent, repo, head, worktree: repoDir, prefix: 'coder_debug' })
  state.docs = {
    scanned: codesRun.doc.scanned,
    selected: { path: codesRun.doc.path, reason: codesRun.doc.reason },
    ranking: codesRun.doc.ranking,
    total: codesRun.doc.total,
    truncated: codesRun.doc.truncated,
  }
  state.codes = codesRun.codes
  state.codesFile = codesRun.rel
  state.codeCache = { file: codesRun.rel, reused: codesRun.reused }
  state.warnings.push(...codesRun.warnings)

  // 未启用的码只是留在文件里的备注：不进提示词、不可能产生诊断。
  const activeCodes = codesRun.codes.filter((item) => item.enabled !== false)
  state.activeCodes = activeCodes
  if (activeCodes.length === 0 && codesRun.codes.length > 0) {
    state.warnings.push(`codes.jsonl 里的 ${codesRun.codes.length} 条诊断码全部未启用，本次不产生任何诊断`)
  }

  const debugCodes = activeCodes.filter((item) => item.kind === 'debug')
  const qualityCodes = activeCodes.filter((item) => item.kind === 'quality')

  // 第二个工作区先建好（git worktree 的写操作不并发），之后每条线只碰自己的那个。
  await addWorktree(repo, qualityRepo, `coder/${state.runId}-quality`, head)
  await linkSharedDirs(repo, qualityRepo, config.linkDirs)

  const runLane = async (fn) => {
    const started = Date.now()
    const value = await fn()
    return { ...value, started, ended: Date.now() }
  }

  const lanes = await Promise.allSettled([
    runLane(() =>
      debugLane({ ctx, config, logger, parent, state, repo, repoDir, debugDir, head, codes: debugCodes, runTimeoutMs }),
    ),
    runLane(() =>
      qualityLane({
        ctx,
        config,
        logger,
        parent,
        state,
        repo,
        qualityRepo,
        qualityDir,
        head,
        codes: qualityCodes,
        runTimeoutMs,
      }),
    ),
  ])

  const failed = lanes.find((lane) => lane.status === 'rejected')
  for (const lane of lanes) {
    if (lane.status === 'rejected') {
      state.warnings.push(`诊断线失败：${describeError(lane.reason).message}`)
    }
  }

  // 一条线失败也要保留另一条线的结论。
  const debug = lanes[0].status === 'fulfilled' ? lanes[0].value : { findings: [] }
  const quality = lanes[1].status === 'fulfilled' ? lanes[1].value : { findings: [] }
  state.staticFindings = sortEntries([...debug.findings, ...quality.findings])
  // 静态结论与运行期结果的合并规则：Debug 码被同码同文件 ±3 行的运行期证据确认后，只保留运行期那条。
  state.staticFindings = state.staticFindings.map((item) => ({
    ...item,
    confirmed: item.kind === 'debug' ? isConfirmed(item, state.diagnostics) : null,
  }))
  state.lanes = {
    debug: debug.started ? { started: debug.started, ended: debug.ended } : null,
    quality: quality.started ? { started: quality.started, ended: quality.ended } : null,
  }

  // 诊断记录出完了：最后一个节点把复现步骤走一遍，并把误报挑掉，然后才交付。
  await verifyLines({ ctx, config, logger, parent, state, repoDir })

  if (failed) throw failed.reason
}

/**
 * Debug 线：静态审查 → 插桩 → 编译 → 跑一次 → 整合。
 *
 * @returns {Promise<{ findings: Array<object> }>}
 */
async function debugLane({ ctx, config, logger, parent, state, repo, repoDir, debugDir, head, codes, runTimeoutMs }) {
  if (codes.length === 0) {
    state.warnings.push('没有 Debug 诊断码：跳过 Debug 静态审查与运行期检查')
    return { findings: [] }
  }

  const review = await reviewFamily({
    ctx,
    config,
    logger,
    parent,
    repoDir,
    codes,
    scope: state.change,
    source: sourceOf(repo, head),
    kind: 'debug',
  })

  await debugCheck({
    ctx,
    config,
    logger,
    parent,
    state,
    repo,
    repoDir,
    debugDir,
    runTimeoutMs,
    debugCodes: codes,
    staticFindings: review.findings,
  })

  return { findings: review.findings }
}

/**
 * 质量线：静态审查 → 按需插桩指标 → 编译 → 跑一次 → 收集指标。
 *
 * @returns {Promise<{ findings: Array<object> }>}
 */
async function qualityLane({ ctx, config, logger, parent, state, repo, qualityRepo, qualityDir, head, codes, runTimeoutMs }) {
  if (codes.length === 0) {
    state.warnings.push('没有质量诊断码：跳过质量静态审查与运行期检查')
    return { findings: [] }
  }

  const review = await reviewFamily({
    ctx,
    config,
    logger,
    parent,
    repoDir: qualityRepo,
    codes,
    scope: state.change,
    source: sourceOf(repo, head),
    kind: 'quality',
  })

  await qualityCheck({
    ctx,
    config,
    logger,
    parent,
    state,
    repo,
    qualityRepo,
    qualityDir,
    runTimeoutMs,
    qualityCodes: codes,
  })

  return { findings: review.findings }
}

/**
 * Debug 路径：插桩 → 编译 → 跑一次 → 整合。
 *
 * @returns {Promise<void>}
 */
async function debugCheck({ ctx, config, logger, parent, state, repo, repoDir, debugDir, runTimeoutMs, debugCodes, staticFindings }) {
  const head = state.change.head
  const instrumented = await instrumentCode({
    ctx,
    config,
    logger,
    parent,
    repoDir,
    codes: debugCodes,
    scope: state.change,
    staticFindings,
    source: sourceOf(repo, head),
    build: state.input.build,
  })
  state.instrumentation = { ...instrumented, commit: await commitAll(repoDir, 'coder_debug: instrument for diagnostics') }

  const build = await runBuild({
    steps: state.input.build,
    cwd: repoDir,
    timeoutMs: config.buildTimeoutMs,
    logDir: path.join(debugDir, 'build'),
    maxLogBytes: config.maxLogBytes,
    callTool: callToolFor(ctx, parent),
  })
  state.build = {
    ok: build.ok,
    skipped: build.skipped,
    exitCode: build.exitCode,
    timedOut: build.timedOut,
    durationMs: build.durationMs,
    ran: build.ran,
    failedStep: build.failedStep ?? null,
    steps: build.steps ?? [],
  }
  if (!build.ok && !build.skipped) {
    state.warnings.push(
      build.failedStep
        ? `Debug 构建失败于「${oneLine(build.failedStep, 60)}」，未运行；Debug 诊断码没有运行期结论`
        : 'Debug 构建失败，未运行；Debug 诊断码没有运行期结论',
    )
    return
  }

  const logsDir = path.join(debugDir, 'logs')
  await fs.mkdir(logsDir, { recursive: true })
  const run = await runLaunch({
    steps: state.input.launch,
    cwd: repoDir,
    timeoutMs: runTimeoutMs,
    logDir: path.join(debugDir, 'run'),
    maxLogBytes: config.maxLogBytes,
    env: { CODER_LOG_DIR: logsDir, CODER_RUN: state.runId },
    callTool: callToolFor(ctx, parent),
  })
  state.run = { exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs, steps: run.steps ?? [] }

  const logPath = path.join(logsDir, 'diagnostics.jsonl')
  const text = await fs.readFile(logPath, 'utf8').catch(() => '')
  const parsed = parseDiagnostics(text)
  if (parsed.entries.length === 0) {
    state.warnings.push('Debug 运行期没有产生任何诊断日志：可能没走到插桩路径，或插桩没有生效')
    return
  }

  const integrated = await integrateDiagnostics({
    ctx,
    config,
    logger,
    parent,
    repoDir,
    codes: debugCodes,
    entries: parsed.entries,
    run: state.run,
    logPath,
    source: sourceOf(repo, head),
  })
  state.diagnostics = sortEntries(integrated.diagnostics)
  state.passed = integrated.passed
  state.summary = integrated.summary
}

/**
 * 质量路径：独立的临时工作区、独立的运行、独立的指标，跑完就删。
 *
 * @returns {Promise<void>}
 */
async function qualityCheck({ ctx, config, logger, parent, state, repo, qualityRepo, qualityDir, runTimeoutMs, qualityCodes }) {
  const head = state.change.head

  const plan = await runStep({
    ctx,
    config,
    logger,
    parent,
    repoDir: qualityRepo,
    name: 'quality',
    prompt: qualityPrompt({
      worktree: qualityRepo,
      codes: qualityCodes,
      scope: state.change,
      launch: state.input.launch,
    }),
    schema: QUALITY_SCHEMA,
    validate: (value) => validateQualitySites(value, qualityCodes, sourceOf(repo, head)),
  })

  const sites = plan.structured.sites ?? []
  state.qualityRuntime = {
    applicable: Boolean(plan.structured.applicable),
    sites: sites.map((site) => ({
      code: String(site.code),
      file: normalizeFile(site.file),
      line: Number(site.line) || 0,
      metric: String(site.metric ?? ''),
      note: String(site.note ?? ''),
      steps: normalizeSteps(site.steps),
    })),
    skipped: (plan.structured.skipped ?? []).map((item) => ({ code: String(item.code), reason: String(item.reason) })),
    notes: String(plan.structured.notes ?? ''),
    build: null,
    run: null,
    entries: [],
  }

  if (!plan.structured.applicable || sites.length === 0) {
    state.warnings.push('质量运行期检查：没有可观测的质量码，已跳过运行')
    return
  }

  const build = await runBuild({
    steps: state.input.build,
    cwd: qualityRepo,
    timeoutMs: config.buildTimeoutMs,
    logDir: path.join(qualityDir, 'build'),
    maxLogBytes: config.maxLogBytes,
    callTool: callToolFor(ctx, parent),
  })
  state.qualityRuntime.build = {
    ok: build.ok,
    skipped: build.skipped,
    exitCode: build.exitCode,
    ran: build.ran,
    failedStep: build.failedStep ?? null,
    steps: build.steps ?? [],
  }
  if (!build.ok && !build.skipped) {
    state.warnings.push('质量构建失败，未运行质量检查')
    return
  }

  const logsDir = path.join(qualityDir, 'logs')
  await fs.mkdir(logsDir, { recursive: true })
  const run = await runLaunch({
    steps: state.input.launch,
    cwd: qualityRepo,
    timeoutMs: runTimeoutMs,
    logDir: path.join(qualityDir, 'run'),
    maxLogBytes: config.maxLogBytes,
    env: { CODER_LOG_DIR: logsDir, CODER_RUN: state.runId },
    callTool: callToolFor(ctx, parent),
  })
  state.qualityRuntime.run = {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    steps: run.steps ?? [],
  }

  const text = await fs.readFile(path.join(logsDir, 'quality.jsonl'), 'utf8').catch(() => '')
  const parsed = parseQuality(text)
  state.qualityRuntime.entries = parsed.entries
  state.qualityRuntime.badLines = parsed.bad
  if (parsed.entries.length === 0) {
    state.warnings.push('质量运行期没有产出 quality.jsonl：插桩可能没有生效')
  }
}

/**
 * 静态审查：一族一个代理。
 *
 * @param {{ kind: 'debug'|'quality' }} input
 * @returns {Promise<{ findings: Array<object>, notes: string }>}
 */
async function reviewFamily({ ctx, config, logger, parent, repoDir, codes, scope, source, kind }) {
  const result = await runStep({
    ctx,
    config,
    logger,
    parent,
    repoDir,
    name: `review-${kind}`,
    prompt: reviewPrompt({ worktree: repoDir, codes, scope, kind }),
    schema: REVIEW_SCHEMA,
    validate: (value) => validateFindings(value, codes, source),
  })

  return {
    findings: (result.structured.findings ?? []).map((item) => ({
      code: String(item.code),
      kind,
      severity: SEVERITIES.includes(item.severity) ? item.severity : 'warning',
      file: normalizeFile(item.file),
      line: Number(item.line) || null,
      column: Number(item.column) || null,
      message: String(item.message ?? ''),
      confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
      evidence: String(item.evidence ?? ''),
      steps: normalizeSteps(item.steps),
      confirmed: null,
    })),
    notes: String(result.structured.notes ?? ''),
  }
}

/**
 * 插桩：只处理 Debug 码。
 *
 * @returns {Promise<object>}
 */
async function instrumentCode({ ctx, config, logger, parent, repoDir, codes, scope, staticFindings, source, build }) {
  const result = await runStep({
    ctx,
    config,
    logger,
    parent,
    repoDir,
    name: 'instrument',
    prompt: instrumentPrompt({ worktree: repoDir, codes, scope, staticFindings, build }),
    schema: INSTRUMENT_SCHEMA,
    validate: (value) => validateSites(value, codes, source),
  })
  return {
    sites: (result.structured.sites ?? []).map((site) => ({
      code: String(site.code),
      file: normalizeFile(site.file),
      line: Number(site.line) || 0,
      note: String(site.note ?? ''),
    })),
    notes: String(result.structured.notes ?? ''),
  }
}

/**
 * 整合：只处理 Debug 码的运行期日志。
 *
 * @returns {Promise<{ diagnostics: Array<object>, passed: Array<object>, summary: string }>}
 */
async function integrateDiagnostics({ ctx, config, logger, parent, repoDir, codes, entries, run, logPath, source }) {
  const numbered = entries.map(
    (entry) =>
      `${entry.logLine}: ${JSON.stringify({ code: entry.code, severity: entry.severity, file: entry.file, line: entry.line, message: entry.message, data: entry.data })}`,
  )

  const result = await runStep({
    ctx,
    config,
    logger,
    parent,
    repoDir,
    name: 'integrate',
    prompt: integratePrompt({ codes, entries, numbered, run, logRel: 'logs/diagnostics.jsonl' }),
    schema: INTEGRATE_SCHEMA,
    validate: (value) => validateIntegration(value, { codes, logPath, source }),
  })

  const diagnostics = []
  const passed = []
  for (const item of result.structured.diagnostics) {
    const entry = {
      code: String(item.code),
      severity: SEVERITIES.includes(item.severity) ? item.severity : 'warning',
      file: normalizeFile(item.file),
      line: Number(item.line) || null,
      column: Number(item.column) || null,
      message: String(item.message ?? ''),
      verdict: item.verdict ?? 'unknown',
      steps: normalizeSteps(item.steps),
    }
    if (entry.verdict === 'pass') passed.push(entry)
    else diagnostics.push(entry)
  }
  return { diagnostics, passed, summary: String(result.structured.summary ?? '') }
}

/**
 * 复核：把诊断记录交给一个独立代理——照着 steps 走一遍，顺带把误报挑出来。
 *
 * 这是软节点：复核失败不让整次诊断失败（前面已经花了几分钟），只在 warnings 里说明
 * 「这些诊断没有经过复核」。通过复核判成 false-positive 的，直接不进最终记录。
 *
 * @returns {Promise<void>}
 */
async function verifyLines({ ctx, config, logger, parent, state, repoDir }) {
  const started = Date.now()
  const draft = buildLines(state)

  if (draft.length === 0) {
    state.verification = {
      status: 'skipped',
      checked: 0,
      confirmed: 0,
      uncertain: 0,
      dropped: 0,
      rewritten: 0,
      durationMs: 0,
    }
    state.lines = draft
    return
  }

  const items = draft.map((line, index) => ({
    id: index + 1,
    code: line.code,
    kind: line.kind,
    severity: line.severity,
    source: line.source,
    file: line.file,
    line: line.line,
    message: line.message,
    steps: line.steps ?? [],
  }))

  let result
  try {
    result = await runStep({
      ctx,
      config,
      logger,
      parent,
      repoDir,
      name: 'verify',
      prompt: verifyPrompt({ worktree: repoDir, launch: state.input.launch, items }),
      schema: VERIFY_SCHEMA,
      validate: (value) => validateChecks(value, draft),
    })
  } catch (error) {
    const message = describeError(error).message
    state.verification = {
      status: 'failed',
      checked: 0,
      confirmed: 0,
      uncertain: 0,
      dropped: 0,
      rewritten: 0,
      durationMs: Date.now() - started,
      message,
    }
    state.warnings.push(`复核没有完成：${message}；下面的诊断没有经过复核`)
    state.lines = draft
    return
  }

  const byId = new Map(result.structured.checks.map((check) => [Number(check.id), check]))
  const kept = []
  const rejected = []
  const counts = { confirmed: 0, uncertain: 0, dropped: 0, rewritten: 0 }

  draft.forEach((line, index) => {
    const check = byId.get(index + 1)
    const repro = ['pass', 'fail', 'unknown'].includes(check.repro) ? check.repro : 'unknown'
    // 步骤跑不通时，代理会给出它实际跑通的步骤：换掉，并标成 rewritten。
    const fixed = repro === 'fail' ? normalizeSteps(check.steps) : []
    const checked = {
      ...line,
      verification: check.verdict === 'uncertain' ? 'uncertain' : 'confirmed',
      repro: fixed.length > 0 ? 'rewritten' : repro,
      reproNote: String(check.note ?? '').trim(),
      ...(fixed.length > 0 ? { steps: fixed } : {}),
    }
    if (fixed.length > 0) counts.rewritten += 1

    if (check.verdict === 'false-positive') {
      counts.dropped += 1
      rejected.push({
        code: checked.code,
        kind: checked.kind,
        severity: checked.severity,
        file: checked.file,
        line: checked.line,
        source: checked.source,
        message: checked.message,
        reason: checked.reproNote,
      })
      return
    }
    if (checked.verification === 'uncertain') counts.uncertain += 1
    else counts.confirmed += 1
    kept.push(checked)
  })

  state.lines = kept
  state.rejected = rejected
  state.verification = { status: 'done', checked: draft.length, ...counts, durationMs: Date.now() - started }

  logger?.info?.(
    `coder_debug: 复核 ${draft.length} 条 → 确认 ${counts.confirmed}、存疑 ${counts.uncertain}、排除 ${counts.dropped}、改写步骤 ${counts.rewritten}`,
  )
  if (counts.dropped > 0) {
    const sample = rejected
      .slice(0, 5)
      .map((item) => `${item.code} ${item.file}:${item.line ?? '?'}`)
      .join('、')
    state.warnings.push(`复核排除了 ${counts.dropped} 条误报：${sample}`)
  }
  if (counts.rewritten > 0) {
    state.warnings.push(`复核发现 ${counts.rewritten} 条复现步骤跑不通，已换成实测过的步骤`)
  }
}

/**
 * 收尾：写四个交付物（两份 JSONL、一份 HTML、一份运行摘要），删两套临时工作区。
 *
 * @returns {Promise<void>}
 */
async function finalize({ state, runDir, repo, repoDir, qualityRepo, workspaceRoot, config, exclude }) {
  try {
    const after = await fingerprint(state.input.repo, { exclude, skip: isCoderArtifact })
    state.fingerprint.after = after
    state.integrity.changed = Boolean(state.fingerprint.before) && after !== state.fingerprint.before
    if (state.integrity.changed) state.warnings.push('源仓库在运行期间发生了变化（HEAD / 分支 / 工作区指纹不一致）')
  } catch (error) {
    state.warnings.push(`无法复核源仓库指纹：${describeError(error).message}`)
  }

  // 编号按最终输出顺序给（先按严重度、再按文件行号），用户可以用「第 N 条」直接索引。
  // 复核已经排好序并挑掉了误报；没走到复核（前面就失败）时在这里补一次。
  state.lines = (state.lines ?? buildLines(state)).map((line, index) => ({ id: index + 1, ...line }))

  await writeJsonl(
    path.join(runDir, 'codes.jsonl'),
    state.codes.map((item) => ({
      code: item.code,
      kind: item.kind,
      check: item.check,
      enabled: item.enabled !== false,
      severity: item.severity,
      rule: item.rule,
      detect: item.detect,
      fix: item.fix ?? '',
      targets: item.targets ?? [],
    })),
  )
  await writeJsonl(path.join(runDir, 'diagnostics.jsonl'), state.lines)
  await fs.writeFile(path.join(runDir, 'diagnostics.html'), renderHtml(state), 'utf8')
  // 本次运行的摘要：「诊断报告」页直接读它（范围、复核结论、计数），不用去解析 HTML。
  await fs.writeFile(
    path.join(runDir, 'summary.json'),
    `${JSON.stringify(summaryOf(state, runDir), null, 2)}\n`,
    'utf8',
  )

  if (config.cleanup) {
    await removeWorktree(repo, repoDir)
    await removeWorktree(repo, qualityRepo)
    try {
      await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      state.cleanup = { tempRemoved: true, kept: false, workspace: workspaceRoot }
    } catch {
      state.cleanup = { tempRemoved: false, kept: true, workspace: workspaceRoot }
    }
  } else {
    state.cleanup = { tempRemoved: false, kept: true, workspace: workspaceRoot }
  }
}

/**
 * 诊断行。
 *
 * @param {object} state
 * @returns {Array<object>}
 */
function buildLines(state) {
  const lines = []

  for (const item of state.diagnostics) {
    if (item.verdict === 'pass') continue
    lines.push({
      code: item.code,
      kind: 'debug',
      severity: item.severity,
      file: item.file,
      line: item.line,
      column: item.column ?? null,
      message: item.message,
      source: 'runtime',
      verdict: item.verdict,
      steps: item.steps ?? [],
    })
  }

  for (const finding of state.staticFindings) {
    if (finding.kind === 'debug' && finding.confirmed === true) continue
    lines.push({
      code: finding.code,
      kind: finding.kind,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      column: finding.column ?? null,
      message: finding.message,
      source: 'static',
      confidence: finding.confidence,
      steps: finding.steps ?? [],
    })
  }

  for (const entry of state.qualityRuntime?.entries ?? []) {
    if (entry.pass === true) continue
    lines.push({
      code: entry.code,
      kind: 'quality',
      severity: entry.severity,
      file: entry.file,
      line: entry.line,
      message: entry.message,
      source: 'quality-runtime',
      metric: entry.metric,
      value: entry.value,
      unit: entry.unit,
      threshold: entry.threshold,
      pass: entry.pass,
      steps: stepsForQuality(state, entry),
    })
  }

  return sortEntries(lines)
}

/**
 * @param {object} state
 * @param {string} runDir
 * @returns {object}
 */
function summaryOf(state, runDir) {
  const counts = { error: 0, warning: 0, info: 0 }
  for (const item of state.lines ?? []) counts[item.severity] = (counts[item.severity] ?? 0) + 1
  const sources = { runtime: 0, static: 0, 'quality-runtime': 0 }
  for (const item of state.lines ?? []) sources[item.source] = (sources[item.source] ?? 0) + 1

  return {
    ok: !state.error,
    runId: state.runId,
    status: state.status,
    change: { mode: state.change.mode, base: state.change.base, head: state.change.head, files: state.change.files.length },
    doc: state.docs?.selected ?? null,
    codes: state.codes.length,
    debugCodes: state.codes.filter((item) => item.kind === 'debug').length,
    qualityCodes: state.codes.filter((item) => item.kind === 'quality').length,
    activeCodes: (state.activeCodes ?? []).length,
    disabledCodes: state.codes.filter((item) => item.enabled === false).length,
    codeCache: state.codeCache,
    codesFile: state.codesFile,
    lanes: state.lanes,
    build: state.build,
    run: state.run,
    verification: state.verification,
    rejected: state.rejected,
    diagnostics: state.lines?.length ?? 0,
    counts,
    sources,
    qualityRuntime: state.qualityRuntime
      ? {
          applicable: state.qualityRuntime.applicable,
          sites: state.qualityRuntime.sites.length,
          entries: state.qualityRuntime.entries.length,
        }
      : null,
    files: {
      codes: path.join(runDir, 'codes.jsonl'),
      diagnostics: path.join(runDir, 'diagnostics.jsonl'),
      html: path.join(runDir, 'diagnostics.html'),
    },
    cleanup: state.cleanup,
    warnings: state.warnings,
    error: state.error,
  }
}

/**
 * @param {{ args: object, config: object }} context
 * @returns {Promise<object>}
 */
export async function statusFlow({ args, config }) {
  const outRoot = await outRootOf(args, config)
  const runsDir = path.join(outRoot, 'runs')

  if (!args.runId) {
    const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [])
    const runs = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const runDir = path.join(runsDir, entry.name)
      const hasCodes = await exists(path.join(runDir, 'codes.jsonl'))
      const hasDiagnostics = await exists(path.join(runDir, 'diagnostics.jsonl'))
      if (!hasCodes && !hasDiagnostics) continue
      runs.push({
        runId: entry.name,
        codes: await countLines(path.join(runDir, 'codes.jsonl')),
        diagnostics: await countLines(path.join(runDir, 'diagnostics.jsonl')),
      })
    }
    return { ok: true, outRoot, runs }
  }

  const runDir = path.join(runsDir, args.runId)
  if (!(await exists(runDir))) throw new CoderError('RUN_NOT_FOUND', `找不到 run ${args.runId}`)
  return {
    ok: true,
    runId: args.runId,
    codes: await countLines(path.join(runDir, 'codes.jsonl')),
    diagnostics: await countLines(path.join(runDir, 'diagnostics.jsonl')),
  }
}

/**
 * @param {{ args: object, config: object }} context
 * @returns {Promise<object>}
 */
export async function reportFlow({ args, config }) {
  const outRoot = await outRootOf(args, config)
  if (!args.runId) throw new CoderError('BAD_ARGS', 'report 需要 runId')
  const file = path.join(outRoot, 'runs', args.runId, 'diagnostics.jsonl')
  if (!(await exists(file))) throw new CoderError('REPORT_NOT_FOUND', `找不到 ${file}`)
  return { ok: true, path: file, diagnostics: await readJsonl(file) }
}

/**
 * @param {{ args: object, config: object }} context
 * @returns {Promise<object>}
 */
export async function cleanFlow({ args, config }) {
  await outRootOf(args, config)
  if (!args.runId) throw new CoderError('BAD_ARGS', 'clean 需要 runId')

  const repo = await resolveRepo(args.repo)
  const workspaceRoot = path.join(scratchRoot(), args.runId)
  await removeWorktree(repo, path.join(workspaceRoot, 'd', 'repo')).catch(() => {})
  await removeWorktree(repo, path.join(workspaceRoot, 'q', 'repo')).catch(() => {})
  await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {})
  return { ok: true, runId: args.runId, workspaceRoot, removed: true }
}

// ---------- 校验 ----------

/**
 * 复核结果必须逐条对上：id 一条不多一条不少，三件事都要有，判误报要有理由。
 *
 * @param {any} value
 * @param {Array<object>} draft
 * @returns {string | null}
 */
function validateChecks(value, draft) {
  if (!Array.isArray(value?.checks)) return 'checks 必须是数组'
  const expected = new Set(draft.map((_, index) => index + 1))
  const seen = new Set()

  for (const check of value.checks) {
    const id = Number(check?.id)
    if (!Number.isInteger(id) || !expected.has(id)) return `checks 里有未知的 id：${check?.id}`
    if (seen.has(id)) return `checks 里 id ${id} 出现了两次`
    seen.add(id)
    if (!['pass', 'fail', 'unknown'].includes(check.repro)) {
      return `#${id} 的 repro 只接受 pass / fail / unknown`
    }
    if (!['confirmed', 'false-positive', 'uncertain'].includes(check.verdict)) {
      return `#${id} 的 verdict 只接受 confirmed / false-positive / uncertain`
    }
    const note = String(check.note ?? '').trim()
    if (!note) return `#${id} 缺 note：说清你做了什么、看到了什么`
    if (note.length > 300) return `#${id} 的 note 超过 300 字`
    if (check.steps !== undefined && check.steps !== null) {
      const problem = stepsProblem(check.steps, `#${id}`)
      if (problem) return problem
    }
  }

  const missing = [...expected].filter((id) => !seen.has(id))
  if (missing.length > 0) return `漏掉了这些 id：${missing.slice(0, 8).join(', ')}`
  return null
}

/**
 * @param {any} value
 * @param {Array<{ code: string }>} codes
 * @param {object} source
 * @returns {Promise<string | null>}
 */
async function validateFindings(value, codes, source) {
  if (!Array.isArray(value?.findings)) return 'findings 必须是数组'
  if (value.findings.length > 200) return 'findings 超过 200 条'
  const known = new Set(codes.map((item) => item.code))
  for (const item of value.findings) {
    const code = String(item?.code ?? '')
    if (!known.has(code)) return `静态审查引用了未声明的码：${code}`
    if (!SEVERITIES.includes(item.severity)) return `${code} 的 severity 不合法`
    if (!String(item.message ?? '').trim()) return `${code} 缺 message`
    const file = normalizeFile(item?.file)
    if (!file || file.includes('..')) return `静态审查的 file 不合法：${file}`
    const count = await source.lineCount(file)
    if (count === null) return `静态审查指向的文件不在这次提交里：${file}`
    const line = Number(item?.line)
    if (!Number.isInteger(line) || line < 1 || line > count) {
      return `${file} 的行号 ${line} 不在 1..${count} 内`
    }
    const stepIssue = stepsProblem(item.steps, code)
    if (stepIssue) return stepIssue
  }
  return null
}

/**
 * @param {any} value
 * @param {Array<{ code: string }>} codes
 * @param {object} source
 * @returns {Promise<string | null>}
 */
async function validateSites(value, codes, source) {
  if (!Array.isArray(value?.sites)) return 'sites 必须是数组'
  const known = new Set(codes.map((item) => item.code))
  for (const site of value.sites) {
    const code = String(site?.code ?? '')
    if (!known.has(code)) return `site 引用了未声明的诊断码：${code}`
    const file = normalizeFile(site?.file)
    if (!file || file.includes('..')) return `site 的 file 不合法：${file}`
    const count = await source.lineCount(file)
    if (count === null) return `site 指向的文件不在这次提交里：${file}`
    const line = Number(site?.line)
    if (!Number.isInteger(line) || line < 1 || line > count) {
      return `${file} 的行号 ${line} 不在 1..${count} 内（要写原始提交的行号）`
    }
  }
  return null
}

/**
 * @param {any} value
 * @param {Array<{ code: string }>} codes
 * @param {object} source
 * @returns {Promise<string | null>}
 */
async function validateQualitySites(value, codes, source) {
  if (typeof value?.applicable !== 'boolean') return 'applicable 必须是布尔值'
  if (!Array.isArray(value?.sites)) return 'sites 必须是数组'
  if (!value.applicable) return null
  if (value.sites.length === 0) return 'applicable=true 但 sites 为空'

  const known = new Set(codes.map((item) => item.code))
  for (const site of value.sites) {
    const code = String(site?.code ?? '')
    if (!known.has(code)) return `质量插桩引用了未声明的质量码：${code}`
    const file = normalizeFile(site?.file)
    if (!file || file.includes('..')) return `质量插桩的 file 不合法：${file}`
    const count = await source.lineCount(file)
    if (count === null) return `质量插桩指向的文件不在这次提交里：${file}`
    const line = Number(site?.line)
    if (!Number.isInteger(line) || line < 1 || line > count) {
      return `${file} 的行号 ${line} 不在 1..${count} 内（要写原始提交的行号）`
    }
    const stepIssue = stepsProblem(site.steps, code)
    if (stepIssue) return stepIssue
  }
  return null
}

/**
 * @param {any} value
 * @param {{ codes: Array<object>, logPath: string, source: object }} context
 * @returns {Promise<string | null>}
 */
async function validateIntegration(value, context) {
  if (!Array.isArray(value?.diagnostics)) return 'diagnostics 必须是数组'
  const known = new Set(context.codes.map((item) => item.code))
  const logText = await fs.readFile(context.logPath, 'utf8').catch(() => '')
  const logLines = logText.split('\n')

  for (const item of value.diagnostics) {
    const code = String(item?.code ?? '')
    if (!known.has(code)) return `诊断引用了未声明的码：${code}`
    if (!SEVERITIES.includes(item.severity)) return `${code} 的 severity 不合法`
    if (!['violation', 'pass', 'unknown'].includes(item.verdict)) return `${code} 的 verdict 不合法`
    const file = normalizeFile(item?.file)
    if (!file || file.includes('..')) return `诊断的 file 不合法：${file}`
    const count = await context.source.lineCount(file)
    if (count === null) return `诊断指向的文件不在这次提交里：${file}`
    const line = Number(item?.line)
    if (!Number.isInteger(line) || line < 1 || line > count) {
      return `${file} 的行号 ${line} 不在 1..${count} 内（要写原始提交的行号）`
    }
    const stepIssue = stepsProblem(item.steps, code)
    if (stepIssue) return stepIssue
    const evidence = String(item?.evidence ?? '')
    const match = evidence.match(/^logs\/diagnostics\.jsonl:(\d+)$/)
    if (!match) return `${code} 的 evidence 格式应为 logs/diagnostics.jsonl:<行号>`
    const logLine = Number(match[1])
    const raw = logLines[logLine - 1]
    if (!raw) return `${code} 的 evidence 行号 ${logLine} 超出日志范围`
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return `${code} 的 evidence 指向的不是一行 JSON`
    }
    if (String(parsed?.code ?? '') !== code) {
      return `${code} 的 evidence 指向的日志行属于 ${parsed?.code ?? '未知码'}`
    }
  }
  return null
}

/**
 * 原始提交的只读视图：诊断里的 file/line 必须落在这个提交里。
 *
 * @param {string} repo
 * @param {string} rev
 * @returns {{ lineCount: (file: string) => Promise<number | null> }}
 */
function sourceOf(repo, rev) {
  const cache = new Map()
  return {
    async lineCount(file) {
      if (cache.has(file)) return cache.get(file)
      const blob = await readBlob(repo, rev, file)
      const count = blob.ok ? blob.text.split('\n').length : null
      cache.set(file, count)
      return count
    },
  }
}

/**
 * 静态结论是否被运行期确认：同码、同文件、行号相差 3 行以内。
 *
 * @param {object} finding
 * @param {Array<object>} diagnostics
 * @returns {boolean}
 */
function isConfirmed(finding, diagnostics) {
  return diagnostics.some(
    (item) =>
      item.code === finding.code &&
      item.file === finding.file &&
      Math.abs((item.line ?? 0) - (finding.line ?? 0)) <= 3,
  )
}

/** 复现步骤：每条诊断最多几步、一步多长。 */
const MAX_STEPS = 6
const MAX_STEP_CHARS = 300

/**
 * 规范化复现步骤：去编号、去空行、截到上限。
 *
 * @param {unknown} steps
 * @returns {string[]}
 */
function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return []
  return steps
    .map((step) =>
      String(step ?? '')
        .trim()
        .replace(/^[-*+>]\s+/, '')
        .replace(/^\d+[.)、]\s*/, '')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, MAX_STEPS)
}

/**
 * 复现步骤必须真的存在：用户要的是「每条诊断都能照着做一次」。
 *
 * @param {unknown} steps
 * @param {string} label
 * @returns {string | null}
 */
function stepsProblem(steps, label) {
  if (!Array.isArray(steps)) return `${label} 缺 steps（复现步骤）`
  if (steps.length === 0) return `${label} 的 steps 是空的：每条诊断都必须给出照着做的复现步骤`
  if (steps.length > MAX_STEPS) return `${label} 的 steps 超过 ${MAX_STEPS} 步`
  for (const step of steps) {
    const text = String(step ?? '').trim()
    if (!text) return `${label} 的 steps 里有空步骤`
    if (text.length > MAX_STEP_CHARS) return `${label} 的 steps 里有一句超过 ${MAX_STEP_CHARS} 字`
  }
  return null
}

/**
 * 质量指标的复现步骤来自插桩计划里那条同码的 site（同一文件优先）。
 *
 * 日志里出现了计划外的一条指标时，退到「这次运行真实的入口 + 指标落在哪」——
 * 宁可机械也别让某条诊断没有复现步骤。
 *
 * @param {object} state
 * @param {object} entry
 * @returns {string[]}
 */
function stepsForQuality(state, entry) {
  const sites = state.qualityRuntime?.sites ?? []
  const same = sites.filter((site) => site.code === entry.code)
  const planned = (same.find((site) => site.file === entry.file) ?? same[0])?.steps
  if (Array.isArray(planned) && planned.length > 0) return planned

  const steps = Array.isArray(state.input?.launch) ? state.input.launch : []
  const first = steps.find((step) => step.type === 'cmd') ?? steps[0]
  const start = first
    ? first.type === 'dsh-plugin'
      ? `调用 DSH 工具 ${first.entry}${first.input ? ` ${JSON.stringify(first.input)}` : ''}`
      : `在仓库根执行 ${first.entry}`
    : '在仓库根执行启动命令'
  return [start, `看 logs/quality.jsonl 里 ${entry.code} 这一行（metric / value / threshold）`]
}

/**
 * 把「调一个 DSH 工具」包成 runner 能用的 callTool。
 *
 * dsh-plugin 步骤指名道姓地要一个工具：这里走 tools 服务的 execute，和模型调用走同一条路
 * （照样过 guard、权限与渲染），再把结果整理成一段文本交给 runner 记日志。
 *
 * @param {object} ctx
 * @param {object} parent
 * @returns {(name: string, args: object, options?: { timeoutMs?: number }) => Promise<{ ok: boolean, text: string, timedOut?: boolean }>}
 */
function callToolFor(ctx, parent) {
  return async (name, args, options = {}) => {
    const tools = (typeof ctx?.get === 'function' ? ctx.get('tools') : undefined) ?? ctx?.tools
    if (!tools || typeof tools.execute !== 'function') {
      return { ok: false, text: `当前 profile 没有 tools 服务，无法调用 DSH 工具 ${name}` }
    }

    const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 60_000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const batch = await tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: `coder-${Date.now().toString(36)}`,
            name,
            arguments: JSON.stringify(args ?? {}),
          },
        ],
        signal: controller.signal,
        agent: parent,
      })
      const result = Array.isArray(batch?.results) ? batch.results[0] : undefined
      return { ok: !result?.isError, text: resultText(result) }
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, timedOut: true, text: `[超时] ${name} 在 ${timeoutMs}ms 内没有返回` }
      }
      return { ok: false, text: `[调用失败] ${describeError(error).message}` }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * @param {any} result
 * @returns {string}
 */
function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (text) return text
  if (result?.value !== undefined && result?.value !== null) return JSON.stringify(result.value)
  return ''
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeFile(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * `change` 可以不传：不传（或传空对象）= 整个仓库。
 *
 * 给了 `from` 就是区间，给了 `ref` 就是单个提交——不让人为了一个明显的意思去多写一个 mode。
 *
 * @param {any} raw
 * @returns {{ mode: string, ref?: string, from?: string, to?: string }}
 */
function normalizeChange(raw) {
  if (raw === undefined || raw === null) return { mode: 'all' }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CoderError(
      'BAD_CHANGE',
      'change 应为对象：{mode:"commit",ref} / {mode:"range",from,to}；不传 change 就是对整个仓库',
    )
  }
  const mode = raw.mode || (raw.from ? 'range' : raw.ref ? 'commit' : 'all')
  if (!['commit', 'range', 'all'].includes(mode)) {
    throw new CoderError(
      'BAD_CHANGE',
      `change.mode 只接受 commit / range / all，收到：${mode}。不传 change 就是对整个仓库`,
    )
  }
  return {
    mode,
    ...(raw.ref ? { ref: String(raw.ref) } : {}),
    ...(raw.from ? { from: String(raw.from) } : {}),
    ...(raw.to ? { to: String(raw.to) } : {}),
  }
}

/**
 * @param {object} context
 * @returns {object | undefined}
 */
function resolveParent(context) {
  if (context.exec?.agent) return context.exec.agent
  const agents = context.ctx?.get?.('agents')
  try {
    return agents?.currentInitiator?.()
  } catch {
    return undefined
  }
}

/**
 * @param {string} repo
 * @param {string} outRoot
 * @returns {string[]}
 */
function excludeOf(repo, outRoot) {
  const rel = relativeInside(repo, outRoot)
  return rel ? [rel] : []
}

/**
 * @param {string} value
 * @param {string} name
 */
function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new CoderError('BAD_ARGS', `缺少参数 ${name}`)
}

/**
 * @param {{ repo?: string }} args
 * @param {object} config
 * @returns {Promise<string>}
 */
async function outRootOf(args, config) {
  if (!args.repo) throw new CoderError('BAD_ARGS', '需要 repo')
  const repo = await resolveRepo(args.repo)
  return path.resolve(repo, config.outDir)
}

/**
 * @param {string} file
 * @returns {Promise<number>}
 */
async function countLines(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  return text.split('\n').filter((line) => line.trim()).length
}
