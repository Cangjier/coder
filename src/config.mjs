/**
 * 配置归一化。所有可调项都在这里，行内 config 覆盖默认值。
 */
import { CoderError } from './errors.mjs'

export const DEFAULTS = {
  /** 报告目录，相对仓库根。 */
  outDir: '.coder',
  /** 插桩后跑一次 launch 的最长时间；到点杀进程树。 */
  runTimeoutMs: 60_000,
  /** 编译超时。 */
  buildTimeoutMs: 600_000,
  /** 单个子代理的超时。 */
  agentTimeoutMs: 900_000,
  /** 子代理 provider：auto 优先 spawn。 */
  subagentProvider: 'auto',
  provider: undefined,
  model: undefined,
  reasoningEffort: undefined,
  cleanup: true,
  /** 从源仓库联接到工作区的依赖目录。 */
  linkDirs: ['node_modules'],
  /** 最多读多少份 docs。 */
  maxDocs: 60,
  /** 每份 docs 给筛选代理看的前 N 个字符。 */
  docExcerptChars: 1_200,
  /** 单个日志文件保留的字节数（头尾各一半）。 */
  maxLogBytes: 2 * 1024 * 1024,
  /** 无头浏览器可执行文件；不填就用 CODER_BROWSER / 系统安装的 Chrome / Edge。 */
  browserPath: undefined,
  /** 无头浏览器的用户目录（飞书登录态在里头）；不填就是 ~/.coder/browser-profile。 */
  browserProfileDir: undefined,
  /** 无头浏览器视图宽度（逻辑像素）。 */
  browserWidth: 1280,
  /** 无头浏览器视图高度（逻辑像素）。 */
  browserHeight: 800,
  /** 会话空闲多久关掉（毫秒）。 */
  browserIdleMs: 30 * 60_000,
  browserMaxTabs: 8,
  /** 窗口按面板的多少倍创建（不改变页面 zoom）。 */
  browserScale: 1.5,
  /** 文档级 zoom（document.documentElement.style.zoom）。 */
  browserZoom: 1.5,
}

/**
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    outDir: text(input.outDir, DEFAULTS.outDir),
    runTimeoutMs: integer(input.runTimeoutMs, DEFAULTS.runTimeoutMs, 1_000, 1_800_000, 'runTimeoutMs'),
    buildTimeoutMs: integer(input.buildTimeoutMs, DEFAULTS.buildTimeoutMs, 1_000, 3_600_000, 'buildTimeoutMs'),
    agentTimeoutMs: integer(input.agentTimeoutMs, DEFAULTS.agentTimeoutMs, 10_000, 3_600_000, 'agentTimeoutMs'),
    subagentProvider: text(input.subagentProvider, DEFAULTS.subagentProvider),
    provider: optionalText(input.provider, 'provider'),
    model: optionalText(input.model, 'model'),
    reasoningEffort: optionalText(input.reasoningEffort, 'reasoningEffort'),
    cleanup: boolean(input.cleanup, DEFAULTS.cleanup, 'cleanup'),
    linkDirs: textArray(input.linkDirs, DEFAULTS.linkDirs, 'linkDirs'),
    maxDocs: integer(input.maxDocs, DEFAULTS.maxDocs, 1, 500, 'maxDocs'),
    docExcerptChars: integer(input.docExcerptChars, DEFAULTS.docExcerptChars, 200, 20_000, 'docExcerptChars'),
    maxLogBytes: integer(input.maxLogBytes, DEFAULTS.maxLogBytes, 4_096, 128 * 1024 * 1024, 'maxLogBytes'),
    browserPath: optionalText(input.browserPath, 'browserPath'),
    browserProfileDir: optionalText(input.browserProfileDir, 'browserProfileDir'),
    browserWidth: integer(input.browserWidth, DEFAULTS.browserWidth, 320, 3_840, 'browserWidth'),
    browserHeight: integer(input.browserHeight, DEFAULTS.browserHeight, 240, 2_160, 'browserHeight'),
    browserIdleMs: integer(input.browserIdleMs, DEFAULTS.browserIdleMs, 60_000, 24 * 60 * 60_000, 'browserIdleMs'),
    browserMaxTabs: integer(input.browserMaxTabs, DEFAULTS.browserMaxTabs, 1, 32, 'browserMaxTabs'),
    browserScale: Math.min(3, Math.max(1, Number(input.browserScale) || DEFAULTS.browserScale)),
    browserZoom: Math.min(3, Math.max(1, Number(input.browserZoom) || DEFAULTS.browserZoom)),
  }
}

/**
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {{ provider?: string, model?: string, reasoningEffort?: string } | undefined}
 */
export function agentOptionsOf(config) {
  const options = {}
  if (config.provider) options.provider = config.provider
  if (config.model) options.model = config.model
  if (config.reasoningEffort) options.reasoningEffort = config.reasoningEffort
  return Object.keys(options).length > 0 ? options : undefined
}

function text(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') throw new CoderError('BAD_CONFIG', '应为字符串')
  return value
}

function optionalText(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new CoderError('BAD_CONFIG', `${name} 应为字符串`)
  return value
}

function integer(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number)) throw new CoderError('BAD_CONFIG', `${name} 应为整数`)
  if (number < min || number > max) throw new CoderError('BAD_CONFIG', `${name} 应在 ${min}..${max} 之间`)
  return number
}

function boolean(value, fallback, name) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new CoderError('BAD_CONFIG', `${name} 应为布尔值`)
  return value
}

function textArray(value, fallback, name) {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new CoderError('BAD_CONFIG', `${name} 应为字符串数组`)
  }
  return [...value]
}
