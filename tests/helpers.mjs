import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 本进程建的临时目录：退出时全删掉，反复跑测试不会在 %TEMP% 里留几千个仓库。 */
const tempRoots = []
process.once('exit', () => {
  for (const dir of tempRoots) {
    try {
      fsSync.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // 删不掉就算了：临时目录不该影响测试结果。
    }
  }
})

/**
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
export async function tempDir(prefix = 'coder-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/**
 * 建一个带 docs 和两次提交的临时仓库。
 *
 * 模板只建一次（每个测试进程一份），之后每处都用 `fs.cp` 复制：git 进程在 Windows 上一次
 * 要 200~300ms，`git init` + 两次提交是 7 次，逐个用例重建会把整个测试套拖到几分钟。
 *
 * @returns {Promise<{ dir: string, run: (args: string[], options?: object) => string, head: string, base: string }>}
 */
export async function makeRepo() {
  const template = await templateRepo()
  const dir = path.join(await tempDir('coder-repo-'), 'repo')
  await fs.cp(template.dir, dir, { recursive: true })
  const run = (args, options = {}) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', ...options })
  return { dir, run, head: template.head, base: template.base }
}

/** @type {Promise<{ dir: string, head: string, base: string }> | null} */
let templatePromise = null

/**
 * @returns {Promise<{ dir: string, head: string, base: string }>}
 */
function templateRepo() {
  if (!templatePromise) templatePromise = buildTemplate()
  return templatePromise
}

/**
 * @returns {Promise<{ dir: string, head: string, base: string }>}
 */
async function buildTemplate() {
  const dir = path.join(await tempDir('coder-template-'), 'repo')
  await fs.mkdir(dir, { recursive: true })
  const run = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  const commit = (message) => run(['commit', '-q', '--no-verify', '-m', message])

  run(['init', '-q'])
  // 身份写进 config：用例自己还会建提交（例如改 app.mjs 再 commit），不能只靠 -c 传。
  run(['config', 'user.name', 'coder-test'])
  run(['config', 'user.email', 'test@localhost'])
  run(['config', 'commit.gpgsign', 'false'])
  // 关掉换行转换：否则每次 add 都往 stderr 写一堆 LF→CRLF 警告，把测试输出淹掉。
  run(['config', 'core.autocrlf', 'false'])

  await fs.mkdir(path.join(dir, 'docs'), { recursive: true })
  await fs.mkdir(path.join(dir, 'src'), { recursive: true })
  await fs.mkdir(path.join(dir, 'node_modules', 'pkg', 'docs'), { recursive: true })

  // 每份文档带一个随机尾巴：诊断码缓存按文档 md5 命中，测试之间不能互相污染。
  const salt = randomBytes(4).toString('hex')
  await fs.writeFile(
    path.join(dir, 'docs', 'rules.md'),
    `# 诊断规则\n\n## 必须\n- 必须使用结构化日志，禁止直接使用 console。\n- 不得吞掉异常。\n\n<!-- ${salt} -->\n`,
    'utf8',
  )
  await fs.writeFile(path.join(dir, 'docs', 'guide.md'), '# 使用指南\n\n这是教程，不是规范。\n', 'utf8')
  await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'docs', 'x.md'), '# 依赖文档\n', 'utf8')
  await fs.writeFile(
    path.join(dir, 'app.mjs'),
    [
      "import fs from 'node:fs'",
      'const dir = process.env.CODER_LOG_DIR',
      'const diag = { code: "D001", severity: "error", file: "app.mjs", line: 1, message: "直接使用了 console" }',
      'const metric = { code: "Q001", severity: "warning", file: "app.mjs", line: 1, metric: "calls", value: 120, threshold: 100, pass: false, message: "调用次数超过阈值" }',
      'fs.appendFileSync(dir + "/diagnostics.jsonl", JSON.stringify(diag) + "\\n")',
      'fs.appendFileSync(dir + "/quality.jsonl", JSON.stringify(metric) + "\\n")',
      'console.log("ok")',
      '',
    ].join('\n'),
    'utf8',
  )
  await fs.writeFile(path.join(dir, 'src', 'a.mjs'), 'export const value = 1\n', 'utf8')
  // 名字和 src 只有一个字母之差：作用范围要按路径段匹配，不能前缀匹配。
  await fs.mkdir(path.join(dir, 'srcx'), { recursive: true })
  await fs.writeFile(path.join(dir, 'srcx', 'b.mjs'), 'export const other = 1\n', 'utf8')

  run(['add', '-A'])
  commit('init')
  const base = run(['rev-parse', 'HEAD']).trim()

  await fs.writeFile(path.join(dir, 'src', 'a.mjs'), 'export const value = 2\n', 'utf8')
  run(['add', '-A'])
  commit('change')
  const head = run(['rev-parse', 'HEAD']).trim()

  return { dir, head, base }
}

/**
 * 假 ctx：按步骤名分发的 subagents 服务。
 *
 * @param {Record<string, (input: { prompt: string, cwd: string }) => object | Promise<object>>} handlers
 * @returns {{ ctx: object, exec: object, calls: object[] }}
 */
export function makeFakeContext(handlers) {
  const parent = { id: 'parent-session' }
  const calls = []
  const toolCalls = []
  const subagents = {
    list: () => ['spawn'],
    async startActivation(spec) {
      const label = String(spec.label)
      const name = label.replace(/^coder_(debug|codes) /, '')
      const prompt = spec.request?.prompt?.[0]?.text ?? ''
      calls.push({ label, name, prompt, cwd: spec.request.cwd })
      const handler = handlers[name]
      if (!handler) throw new Error(`没有为步骤 ${name} 准备假实现`)
      const structured = await handler({ prompt, cwd: spec.request.cwd })
      return {
        childId: `child-${calls.length}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: JSON.stringify(structured) }],
          structured,
          stopReason: 'completed',
        }),
        dispose: async () => {},
      }
    },
  }
  // dsh-plugin 步骤走 tools 服务：假实现按 `tool:<名字>` 分发。
  const tools = {
    async execute(input) {
      const call = input.calls[0]
      const args = JSON.parse(call.arguments)
      toolCalls.push({ name: call.name, args })
      const handler = handlers[`tool:${call.name}`]
      if (!handler) {
        return { results: [{ isError: true, content: [{ type: 'text', text: `没有为工具 ${call.name} 准备假实现` }] }] }
      }
      const value = await handler(args)
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return { results: [{ isError: false, content: [{ type: 'text', text }], value }] }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'subagents') return subagents
      if (name === 'agents') return { currentInitiator: () => parent }
      if (name === 'tools') return tools
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, exec: { agent: parent }, calls, toolCalls, parent }
}

/**
 * 标准假实现：全部文档都是规范文档，选第一份，一个诊断码，插桩空操作，整合一条诊断。
 *
 * @returns {Record<string, (input: { prompt: string }) => object>}
 */
export function standardHandlers() {
  return {
    triage: ({ prompt }) => {
      const paths = [...prompt.matchAll(/^### (\S+)$/gm)].map((match) => match[1])
      return { docs: paths.map((path) => ({ path, normative: true, reason: '测试里全算规范' })) }
    },
    select: ({ prompt }) => {
      const path = prompt.includes('docs/rules.md') ? 'docs/rules.md' : prompt.match(/^- (\S+?)：/m)?.[1]
      return { path, reason: '测试固定选 rules.md', ranking: path ? [path] : [] }
    },
    'codes-debug': () => ({
      codes: [
        {
          code: 'D001',
          check: 'runtime',
          severity: 'error',
          rule: '禁止直接使用 console。',
          detect: '运行期捕获 console 调用',
          fix: '把那一行 console 调用换成 log()，所有输出都走它。',
        },
      ],
    }),
    'codes-quality': () => ({
      codes: [
        {
          code: 'Q001',
          check: 'static',
          severity: 'warning',
          rule: '单个函数不应超过 50 行。',
          detect: '读代码数函数行数',
          fix: '按职责把超长的函数拆成几个小函数。',
        },
      ],
    }),
    'review-debug': () => ({
      findings: [
        {
          code: 'D001',
          file: 'app.mjs',
          line: 1,
          severity: 'error',
          message: '静态发现直接使用 console',
          confidence: 'high',
          steps: ['在仓库根执行 node app.mjs', '看 stdout 里 port=3000 这一行'],
        },
      ],
      notes: '',
    }),
    'review-quality': () => ({
      findings: [
        {
          code: 'Q001',
          file: 'src/a.mjs',
          line: 1,
          severity: 'warning',
          message: 'run() 偏长，建议拆分',
          confidence: 'medium',
          steps: ['打开 src/a.mjs:1', '看 run() 从第 1 行到第 60 行'],
        },
      ],
      notes: '',
    }),
    instrument: () => ({ sites: [], notes: '测试里不真正插桩，app.mjs 自带一条诊断' }),
    quality: () => ({
      applicable: true,
      sites: [
        {
          code: 'Q001',
          file: 'app.mjs',
          line: 1,
          metric: 'calls',
          note: '统计 run() 调用次数',
          steps: ['在仓库根执行 node app.mjs', '看 quality.jsonl 里 Q001 的 value'],
        },
      ],
      skipped: [],
      notes: '',
    }),
    integrate: () => ({
      diagnostics: [
        {
          code: 'D001',
          severity: 'error',
          file: 'app.mjs',
          line: 1,
          message: '直接使用了 console',
          verdict: 'violation',
          evidence: 'logs/diagnostics.jsonl:1',
          steps: ['在仓库根执行 node app.mjs', '看 stdout 里没有经过 log() 的那一行'],
        },
      ],
      summary: '抓到 1 条规则违反',
    }),
    // 默认全部确认、步骤都能跑通；要测「排误报」和「改写步骤」的用例自己覆盖它。
    verify: ({ prompt }) => ({
      checks: verifyItemsOf(prompt).map((item) => ({
        id: item.id,
        repro: 'pass',
        verdict: 'confirmed',
        note: '按 steps 走了一遍，现象对得上',
      })),
    }),
  }
}

/**
 * 从复核提示词里取回诊断清单（提示词里那一段 JSON）。
 *
 * @param {string} prompt
 * @returns {Array<object>}
 */
export function verifyItemsOf(prompt) {
  const match = String(prompt ?? '').match(/```json\n([\s\S]*?)\n```/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
