/**
 * `coder_codes` 工具：把「文档 → 诊断码」独立成一步。
 *
 * 它做的事就是 `runCodesFlow`：扫 `**\/docs/*.md`、选一份、生成两族码，落在文档同目录；
 * 已经有 `codes.jsonl` 就原样复用（`force` 才重写）。改它用左侧栏的「诊断码」页。
 *
 * `coder_debug` 不重复实现这一段，它直接调同一个 `runCodesFlow`。
 */
import { CoderError } from '../errors.mjs'
import { inspectCodes, runCodesFlow } from '../codes-flow.mjs'
import { revParse, resolveRepo } from '../git.mjs'
import { targetsLabelOf, targetsOf, validateRows } from '../codes-client.js'
import { readCodesFile, writeCodesFile } from '../codes.mjs'
import path from 'node:path'
import { oneLine } from '../util.mjs'

/**
 * @param {object} ctx
 * @param {object} config
 * @param {object} logger
 * @returns {object}
 */
export function createCodesTool(ctx, config, logger) {
  return {
    name: 'coder_codes',
    description: [
      'Turn the repository documentation into the diagnostic codes used by coder_debug, and nothing else.',
      'Independent subagents judge which **/docs/*.md are normative and pick the most important one, then two agents generate the two families one after the other: D001… (debug, observable at runtime) first, then Q001… (quality, judged by reading code) with the debug codes as input — so the same documentation rule is not listed twice. Quality codes that only restate a debug rule are dropped.',
      'The result is written to <docs dir>/codes.jsonl — the same directory as that document. A row carries check (static = judged by reading the code / runtime = judged by running it) and enabled (false keeps the code in the file but out of diagnosis). Edit it in the "Diagnostic codes" page in the left sidebar (the page shipped in this bundle), not in a generated HTML file: nothing is written into the repository beside the codes any more.',
      'If exactly one codes.jsonl already exists and parses, it is reused as-is and the repository is left untouched: no subagent runs at all (neither the document triage nor the codes agents), and nothing is written — not the file, not anything beside it. With two or more docs directories holding one, the document is selected first so that the file beside it is the one used; a missing file next to that document is an error rather than a new file. Delete it (or empty it) to regenerate, or pass force:true — that is the only path that writes over an existing file.',
      'Every code may carry optional targets — what it is about: exact names like ["Session#append"], or a plain-language description like "every XxxService". They are read semantically and never string-matched; empty means unrestricted. The "Diagnostic codes" page can collect them for you: it opens a conversation in the target workspace and lets that agent fill the field in.',
      'Actions: run (default) generates or reuses the file; show reads the existing file(s) without generating anything; targets writes the classes, interfaces or methods one code is about back into codes.jsonl.',
      `Subagent provider ${config.subagentProvider} (config, not a tool argument).`,
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['run', 'show', 'targets'],
          description:
            'run generates or reuses docs/codes.jsonl; show only reads what is already there; targets writes the given names into that one code. Default: run.',
        },
        code: {
          type: 'string',
          description: 'targets: which code to update, e.g. "D001".',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'targets: class / interface / method names, e.g. ["Session#append", "parseDiagnostics"].',
        },
        file: {
          type: 'string',
          description: 'targets: which codes.jsonl to update when the repository holds more than one.',
        },
        repo: {
          type: 'string',
          description: 'Code directory (absolute, or relative to the caller cwd). Must be a git repository.',
        },
        change: {
          type: 'object',
          additionalProperties: false,
          description:
            'Which revision to read the documentation from. Omit it to read HEAD, which is what the whole-repository mode does: ' +
            'every **/docs/*.md in the tree is scanned either way. {mode:"commit",ref:"<sha>"} or {mode:"range",from:"<sha>",to:"<sha>"}.',
          properties: {
            mode: {
              type: 'string',
              enum: ['all', 'commit', 'range'],
              description: 'all = the tree at ref; commit / range pick the revision to read. Default: all.',
            },
            ref: { type: 'string', description: 'commit / all: the revision. Default HEAD.' },
            from: { type: 'string', description: 'range: base revision.' },
            to: { type: 'string', description: 'range: head revision. Default HEAD.' },
          },
        },
        force: {
          type: 'boolean',
          description:
            'run: regenerate even when codes.jsonl already exists, overwriting it (and any hand edits). Default false.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: formatCodes(value) }]
      },
    },
    timeoutMs: 1_800_000,

    /**
     * @param {object} args
     * @param {object} exec
     * @returns {Promise<object>}
     */
    async execute(args, exec) {
      const action = args?.action ?? 'run'
      try {
        if (!args?.repo) throw new CoderError('BAD_ARGS', '缺少参数 repo')
        const repo = await resolveRepo(args.repo)
        const head = await revParse(repo, headRefOf(args.change))

        if (action === 'show') {
          const found = await inspectCodes({ repo, head })
          return lossless({ ok: true, action, head, file: found.files[0]?.path ?? null, files: found.files })
        }
        if (action === 'targets') {
          return lossless(await setTargets({ repo, args }))
        }
        if (action !== 'run') throw new CoderError('BAD_ARGS', `未知 action：${action}`)

        const parent = resolveParent(ctx, exec)
        if (!parent) throw new CoderError('NO_AGENT', '无法确定发起调用的 agent：coder_codes 需要在工具调用里执行')

        const result = await runCodesFlow({
          ctx,
          config,
          logger,
          parent,
          repo,
          head,
          force: args.force === true,
          worktree: null,
          prefix: 'coder_codes',
        })

        return lossless({
          ok: true,
          action,
          head,
          file: result.rel,
          path: result.file,
          reused: result.reused,
          doc: result.doc,
          counts: result.counts,
          codes: result.codes.map((item) => ({
            code: item.code,
            kind: item.kind,
            check: item.check,
            enabled: item.enabled !== false,
            severity: item.severity,
            rule: item.rule,
            detect: item.detect,
            fix: item.fix,
            targets: item.targets ?? [],
          })),
          warnings: result.warnings,
        })
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
 * `action: 'targets'`：把一条码涉及的 class / interface / method 写回 codes.jsonl。
 *
 * 只改那一条的 `targets`，其它字段原样保留；文件只有一份时不用指定 file。
 *
 * @param {{ repo: string, args: object }} options
 * @returns {Promise<object>}
 */
async function setTargets({ repo, args }) {
  const code = String(args?.code ?? '').trim()
  if (!code) throw new CoderError('BAD_ARGS', '缺少参数 code')
  const targets = targetsOf(args?.targets)
  if (targets.length === 0) throw new CoderError('BAD_ARGS', 'targets 不能为空')

  const found = await inspectCodes({ repo, head: 'HEAD' })
  const wanted = args?.file ? String(args.file) : null
  const candidates = found.files.filter((item) => (wanted ? item.path === wanted : true))
  if (candidates.length === 0) throw new CoderError('NO_CODES', `没有找到 ${wanted ?? 'docs/codes.jsonl'}，先跑一次 coder_codes`)
  if (candidates.length > 1) {
    throw new CoderError('MANY_CODES', `有多份 codes.jsonl，请用 file 指定一份：${candidates.map((item) => item.path).join(', ')}`)
  }

  const target = candidates[0]
  const abs = path.join(repo, ...target.path.split('/'))
  const current = await readCodesFile(abs)
  if (current.status !== 'ok') {
    throw new CoderError('BAD_CODES_FILE', `${target.path} 读不出来：${current.problems?.[0]?.message ?? current.status}`)
  }
  const rows = current.rows
  const index = rows.findIndex((row) => row.code === code)
  if (index < 0) throw new CoderError('NO_CODE', `${target.path} 里没有 ${code}`)

  const next = rows.map((row, at) => (at === index ? { ...row, targets } : row))
  const problems = validateRows(next)
  if (problems.length > 0) throw new CoderError('BAD_TARGETS', problems[0].message)
  await writeCodesFile(abs, next)
  return { ok: true, action: 'targets', head: 'HEAD', file: target.path, code, targets }
}

/**
 * 从哪个提交读文档。`change` 不传 = HEAD（整仓模式在文档这一步本来就等于 HEAD 的完整树）。
 *
 * @param {unknown} change
 * @returns {string}
 */
function headRefOf(change) {
  if (change === undefined || change === null) return 'HEAD'
  if (typeof change !== 'object') throw new CoderError('BAD_CHANGE', 'change 应为对象')
  const mode = change.mode || (change.from ? 'range' : change.ref ? 'commit' : 'all')
  if (mode === 'range') return String(change.to || 'HEAD')
  if (mode === 'commit' || mode === 'all') return String(change.ref || 'HEAD')
  throw new CoderError('BAD_CHANGE', `change.mode 只接受 commit / range / all，收到：${mode}`)
}

/**
 * @param {object} ctx
 * @param {object} exec
 * @returns {object | undefined}
 */
function resolveParent(ctx, exec) {
  if (exec?.agent) return exec.agent
  const agents = ctx?.get?.('agents')
  try {
    return agents?.currentInitiator?.()
  } catch {
    return undefined
  }
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
export function formatCodes(value) {
  if (!value || typeof value !== 'object') return String(value)
  if (value.ok === false) {
    return `coder_codes 失败：${value.message ?? '未知错误'}${value.code ? `（${value.code}）` : ''}`
  }

  if (value.action === 'show') {
    if (!value.files || value.files.length === 0) return `coder_codes：这次提交里没有 docs/codes.jsonl（${value.head?.slice(0, 8) ?? ''}）`
    const lines = [`coder_codes：找到 ${value.files.length} 份 codes.jsonl`]
    for (const file of value.files) {
      lines.push(`  ${file.path}（${file.source === 'working-tree' ? '工作区' : '提交里'}，${file.codes.length} 条，${file.status}）`)
      for (const code of file.codes.slice(0, 20)) {
        lines.push(`    ${codeLine(code)}`)
      }
      if (file.codes.length > 20) lines.push(`    …还有 ${file.codes.length - 20} 条`)
      for (const problem of file.problems.slice(0, 5)) lines.push(`    问题：${problem}`)
    }
    return lines.join('\n')
  }

  const counts = value.counts ?? {}
  const lines = [
    `coder_codes done：诊断码 ${counts.total ?? 0} 条（Debug ${counts.debug ?? 0} / Quality ${counts.quality ?? 0}` +
      `${counts.disabled > 0 ? `，未启用 ${counts.disabled}` : ''}）` +
      `，${value.reused ? '复用' : '本次生成'} ${value.file}`,
  ]
  if (value.doc?.path) {
    lines.push(`来源文档：${value.doc.path}${value.doc.reason ? `（${oneLine(value.doc.reason, 60)}）` : ''}`)
  } else if (value.doc?.reason) {
    lines.push(`来源文档：${oneLine(value.doc.reason, 100)}`)
  }
  for (const code of (value.codes ?? []).slice(0, 20)) {
    lines.push(`  ${codeLine(code)}`)
  }
  if ((value.codes ?? []).length > 20) lines.push(`  …还有 ${value.codes.length - 20} 条`)
  for (const warning of value.warnings ?? []) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/**
 * 一条码在文本输出里的一行：`D001  error  Runtime  全部源文件  <rule>`，未启用的加个标记。
 *
 * @param {object} code
 * @returns {string}
 */
function codeLine(code) {
  const check = code.check === 'static' ? 'Static ' : 'Runtime'
  const off = code.enabled === false ? '  [未启用]' : ''
  return `${code.code}  ${String(code.severity).padEnd(7)}  ${check}  ${targetsLabelOf(code)}  ${oneLine(code.rule, 60)}${off}`
}
