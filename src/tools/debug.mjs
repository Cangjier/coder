/**
 * `coder_debug` 工具定义与分发。
 *
 * 诊断码那一段不在这里：它由 `coder_codes`（`runCodesFlow`）产出，debug 直接复用同一段代码。
 */
import { CoderError } from '../errors.mjs'
import { cleanFlow, reportFlow, runFlow, statusFlow } from '../flow.mjs'
import { formatTs } from '../diagnostics.mjs'
import { oneLine } from '../util.mjs'

/**
 * @param {object} ctx
 * @param {object} config
 * @param {object} logger
 * @returns {object}
 */
export function createDebugTool(ctx, config, logger) {
  return {
    name: 'coder_debug',
    description: [
      '**This tool is essentially a sub-agent.** Calling it delegates one long investigation (minutes; several isolated sub-agents with their own worktrees; its own builds and runs) and gives back one finished result. Call it, then read the summary — do not interleave it with work that depends on its findings, and do not call it in parallel with itself on the same repository. It must be called from an agent context: the calling agent becomes the parent of every sub-agent it starts, so a call from a bare script fails with NO_AGENT.',
      'Diagnose the repository from its documentation, statically and at runtime — a single commit, a commit range, or the whole repository when no change is given.',
      'The diagnostic codes come from the coder_codes flow: <docs dir>/codes.jsonl, beside the normative document. If exactly one such file already exists it is reused as-is and no subagent runs at all — not even the documentation triage — and the run writes nothing into the repository (no codes.jsonl, no companion file): a file that is there belongs to the user. Otherwise the documentation is triaged and one document picked, then the debug family is generated first and the quality family second, with the debug codes as input. Call coder_codes directly when the codes are all you need.',
      'D001… are debug codes (observable at runtime), Q001… are quality codes (judged by reading code). Every code may carry optional targets — the objects it is about, as exact names or a plain-language description, read semantically rather than string-matched — and a finding should land on those objects. check is how a code is proven: static (by reading the code) or runtime (by running it). A code whose enabled is false stays in the file but takes no part in the diagnosis — it never reaches an agent, so it cannot produce a finding. Edit <docs dir>/codes.jsonl in the "Diagnostic codes" page in the left sidebar (shipped in this bundle).',
      'Scope: omit change entirely and the whole file tree of HEAD is the subject — there is no changed-file list, the agents locate the relevant code themselves. {mode:"commit"} compares one commit with its parent, {mode:"range"} uses a range. Uncommitted changes are never read.',
      'Two static review agents then read the code in parallel, one per family: the debug reviewer reports suspects that the runtime check will confirm or refute, the quality reviewer reports final conclusions.',
      'From review onward the two families are two fully independent lanes that run together and never wait for each other: each has its own worktree, its own build and its own single run — the debug lane confirms findings from its log, the quality lane instruments only runtime-measurable Q codes and collects metrics.',
      'A final verification node then takes the finished diagnostics, actually replays their reproduction steps, and drops the ones it can prove are false positives (a step set that does not run is replaced with one that does). If that node cannot run, the diagnostics are delivered unreviewed and a warning says so.',
      'Deliverables under <repo>/.coder/runs/<runId>/: codes.jsonl (the snapshot this run used), diagnostics.jsonl (machine-readable, each line carries a sequential id and its reproduction steps), diagnostics.html — a self-contained view with severity/source filters and #N anchors — and summary.json (the same run summary the Diagnostic codes page reads). Both temporary worktrees are deleted afterwards; the source repository is only read and fingerprinted before and after (codes.jsonl is ours and excluded from that check).',
      'Actions: run (default); status lists runs; report returns a run\'s diagnostics; clean removes a leftover workspace.',
      `Run timeout ${config.runTimeoutMs}ms, subagent provider ${config.subagentProvider} (config, not a tool argument).`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'status', 'report', 'clean'],
          description: 'Which action to perform. Default: run.',
        },
        repo: {
          type: 'string',
          description: 'Code directory (absolute, or relative to the caller cwd). Must be a git repository.',
        },
        change: {
          type: 'object',
          additionalProperties: false,
          description:
            'What to diagnose. Omit it entirely to analyze the whole repository: the complete file tree of HEAD, no diff. ' +
            '{mode:"commit",ref:"<sha>"} compares that commit with its parent; ' +
            '{mode:"range",from:"<sha>",to:"<sha>"} uses the whole range. Uncommitted changes are not supported.',
          properties: {
            mode: {
              type: 'string',
              enum: ['all', 'commit', 'range'],
              description: 'all = the whole tree; commit = one commit against its parent; range = from..to. Default: all.',
            },
            ref: { type: 'string', description: 'commit / all: the revision to read. Default HEAD.' },
            from: { type: 'string', description: 'range: base revision.' },
            to: { type: 'string', description: 'range: head revision. Default HEAD.' },
          },
        },
        build: {
          type: 'array',
          description:
            '构建步骤，按顺序执行；一步失败就停，整体算构建失败（不会运行）。空 = 跳过构建。每项是 {type,entry,input}：\n' +
            '- {type:"cmd", entry:"npm run build"}：在工作区里跑一条命令；\n' +
            '- {type:"dsh-plugin", entry:"xl_build", input:{"paths":["{{worktree}}/src"]}}：让 DSH 调用名为 xl_build 的工具（插件），input 就是它的入参对象。\n' +
            'entry 与 input 里的字符串中的 {{worktree}} 会换成当次工作区的绝对路径。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['entry'],
            properties: {
              type: {
                type: 'string',
                enum: ['cmd', 'dsh-plugin'],
                description: 'cmd（默认）：shell 命令；dsh-plugin：调用 DSH 工具。',
              },
              entry: { type: 'string', description: 'cmd：命令行；dsh-plugin：DSH 工具名，例如 xl_build。' },
              input: {
                type: 'object',
                additionalProperties: true,
                description: '仅 dsh-plugin：工具入参，直接给 JSON 对象。cmd 不要给。',
              },
            },
          },
        },
        launch: {
          type: 'array',
          description:
            '启动步骤，run 必需，至少一步。按顺序执行，通常最后一步是长驻程序，到点被杀；整组共享运行超时。每项 {type,entry,input}：\n' +
            '- {type:"cmd", entry:"node src/app.mjs"}：在工作区里跑一条命令；\n' +
            '- {type:"dsh-plugin", entry:"xl_build", input:{…}}：让 DSH 调用那个工具。\n' +
            '整组在 CODER_LOG_DIR 下运行，写进那里的日志会被收集。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['entry'],
            properties: {
              type: {
                type: 'string',
                enum: ['cmd', 'dsh-plugin'],
                description: 'cmd（默认）：shell 命令；dsh-plugin：调用 DSH 工具。',
              },
              entry: { type: 'string', description: 'cmd：命令行；dsh-plugin：DSH 工具名。' },
              input: {
                type: 'object',
                additionalProperties: true,
                description: '仅 dsh-plugin：工具入参，直接给 JSON 对象。cmd 不要给。',
              },
            },
          },
        },
        runId: {
          type: 'string',
          description: 'status/report/clean: which run to address.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: formatValue(value) }]
      },
    },
    timeoutMs: 3_600_000,

    /**
     * @param {object} args
     * @param {object} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      const action = args?.action ?? 'run'
      try {
        if (action === 'run') {
          if (typeof args?.repo !== 'string' || !args.repo.trim()) throw new CoderError('BAD_ARGS', '缺少参数 repo')
          return lossless(await runFlow({ ctx, config, logger, exec, args }))
        }
        if (action === 'status') return lossless(await statusFlow({ args, config }))
        if (action === 'report') return lossless(await reportFlow({ args, config }))
        if (action === 'clean') return lossless(await cleanFlow({ args, config }))
        throw new CoderError('BAD_ARGS', `未知 action：${action}`)
      } catch (error) {
        if (error instanceof CoderError) {
          return {
            ok: false,
            code: error.code,
            message: error.message,
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          }
        }
        throw error
      }
    },
  }
}

/**
 * 「这次诊断的是多大一片代码」。
 *
 * @param {{ mode?: string, base?: string | null, head?: string, files?: number }} change
 * @returns {string}
 */
function scopeLabel(change) {
  const head = String(change.head ?? '').slice(0, 8)
  const count = change.files ?? 0
  if (change.mode === 'all') return `整个仓库（提交 ${head} 的完整文件树，共 ${count} 个文件）`
  const base = String(change.base ?? '').slice(0, 8)
  if (change.mode === 'range') return `提交区间 ${base}..${head}（${count} 个文件）`
  return `提交 ${head}（对比父提交 ${base}，${count} 个文件）`
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function lossless(value) {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {object} value
 * @returns {string}
 */
function formatValue(value) {
  if (!value || typeof value !== 'object') return String(value)
  if (value.ok === false) {
    return `coder_debug 失败：${value.message ?? value.error?.message ?? '未知错误'}${value.code ? `（${value.code}）` : ''}`
  }

  if (Array.isArray(value.runs)) {
    if (value.runs.length === 0) return `coder_debug：${value.outRoot} 下还没有 run`
    return [
      `coder_debug：${value.outRoot} 下有 ${value.runs.length} 个 run`,
      ...value.runs.slice(0, 10).map((run) => `  ${run.runId}  码 ${run.codes} / 诊断 ${run.diagnostics}`),
    ].join('\n')
  }

  if (Array.isArray(value.diagnostics) && value.path) {
    return [
      `coder_debug 诊断：${value.diagnostics.length} 行`,
      ...value.diagnostics.slice(0, 20).map(formatTs),
      `路径：${value.path}`,
    ].join('\n')
  }

  const counts = value.counts ?? {}
  const sources = value.sources ?? {}
  const lines = [
    `coder_debug ${value.status ?? ''}：诊断 ${value.diagnostics ?? 0} 行` +
      `（error ${counts.error ?? 0} / warning ${counts.warning ?? 0} / info ${counts.info ?? 0}）` +
      `，运行期 ${sources.runtime ?? 0} / 静态 ${sources.static ?? 0} / 质量运行期 ${sources['quality-runtime'] ?? 0}`,
    `诊断码 ${value.codes ?? 0} 条（Debug ${value.debugCodes ?? 0} / Quality ${value.qualityCodes ?? 0}` +
      `${value.disabledCodes > 0 ? `，未启用 ${value.disabledCodes}` : ''}）` +
      (value.codeCache ? `，${value.codeCache.reused ? '复用' : '本次生成'} ${value.codeCache.file}` : ''),
  ]
  if (value.change) lines.push(`范围：${scopeLabel(value.change)}`)
  if (value.qualityRuntime) {
    lines.push(
      `质量运行期：${value.qualityRuntime.applicable ? `可观测 ${value.qualityRuntime.sites} 处，产出 ${value.qualityRuntime.entries} 条指标` : '无可观测的质量码，已跳过'}`,
    )
  }
  if (value.lanes) {
    const fmt = (lane) => (lane ? `${((lane.ended - lane.started) / 1000).toFixed(1)}s` : '未运行')
    lines.push(`并行：Debug ${fmt(value.lanes.debug)} · Quality ${fmt(value.lanes.quality)}`)
  }
  if (value.build) {
    const steps = value.build.steps ?? []
    const label = steps
      .map((step) => (step.type === 'dsh-plugin' ? `DSH:${step.entry}` : step.entry))
      .join(' → ')
    lines.push(
      value.build.skipped
        ? '构建：跳过'
        : `构建：${value.build.ok ? '成功' : `失败于「${oneLine(value.build.failedStep ?? '未知步骤', 40)}」`}` +
            `${label ? `（${oneLine(label, 60)}）` : ''}`,
    )
  }
  if (value.run) {
    lines.push(
      `运行：退出码 ${value.run.exitCode ?? 'null'}${value.run.timedOut ? '（超时被杀）' : ''}，${(
        (value.run.durationMs ?? 0) / 1000
      ).toFixed(1)}s`,
    )
  }
  if (value.verification) {
    const info = value.verification
    if (info.status === 'done') {
      lines.push(
        `复核：${info.checked} 条 → 确认 ${info.confirmed} / 存疑 ${info.uncertain} / 排除误报 ${info.dropped} / 改写步骤 ${info.rewritten}` +
          `（${((info.durationMs ?? 0) / 1000).toFixed(1)}s）`,
      )
    } else if (info.status === 'failed') {
      lines.push(`复核：没有完成（${oneLine(info.message ?? '未知原因', 80)}）`)
    }
  }
  for (const item of (value.rejected ?? []).slice(0, 5)) {
    lines.push(`  已排除 ${item.code} ${item.file}:${item.line ?? '?'} —— ${oneLine(item.reason ?? '', 60)}`)
  }
  if ((value.rejected ?? []).length > 5) lines.push(`  …还有 ${value.rejected.length - 5} 条被排除`)
  if (value.doc?.path) lines.push(`来源文档：${value.doc.path}${value.doc.reason ? `（${oneLine(value.doc.reason, 60)}）` : ''}`)
  if (value.codesFile) lines.push(`诊断码文件：${value.codesFile}`)
  if (value.files?.codes) lines.push(`本次快照：${value.files.codes}`)
  if (value.files?.diagnostics) lines.push(`诊断：${value.files.diagnostics}`)
  if (value.files?.html) lines.push(`HTML：${value.files.html}`)
  if (value.cleanup?.tempRemoved) lines.push('临时目录：已删除')
  if (value.cleanup?.kept) lines.push(`临时目录：保留在 ${value.cleanup.workspace}`)
  for (const warning of value.warnings ?? []) lines.push(`注意：${warning}`)
  if (value.error) lines.push(`错误：${value.error.message ?? value.error}`)
  return lines.join('\n')
}

export { formatValue }
