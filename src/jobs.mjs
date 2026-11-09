/**
 * 「搜集 targets」的任务表：请求只负责开工，结果由那个对话回填，谁来看都查得到。
 *
 * 为什么要有它：
 * - 开一个对话要跑几分钟，不能一直挂着一个 HTTP 请求；
 * - 用户可能中途离开页面，那条连接就断了 —— 结果不能跟着连接一起消失；
 * - 所以任务存在服务端（内存 + TTL），对话完成后通过 `coder_job` 工具把结果写进来，
 *   页面要么当场收到推送（SSE），要么下次回来用 jobId 查一次。
 *
 * **没有超时**：那个对话要跑多久就等多久，任务不会因为「等太久了」被判成失败。
 * 唯一的边界是 TTL（从开工算起）：过了 TTL 的任务一律清掉，清的时候正在等的页面
 * 会收到一次「还没有结果」，不会一直转圈。
 *
 * 只存内存：DSH 重启后这些任务就没了（页面会显示「任务已过期」，重新点一次即可）。
 */

/** 一条任务最多留这么久。 */
const TTL_MS = 60 * 60 * 1000

/** 最多留这么多条，防止一直点。 */
const MAX_JOBS = 50

/**
 * @param {{ ttlMs?: number, max?: number, now?: () => number }} [options]
 * @returns {object}
 */
export function createJobStore(options = {}) {
  const ttlMs = options.ttlMs ?? TTL_MS
  const max = options.max ?? MAX_JOBS
  const now = options.now ?? (() => Date.now())
  const jobs = new Map()
  const listeners = new Map()

  /**
   * 清掉过期的任务：**从开工算起**超过 TTL 的一律删除，跑着的也算 —— 它不是「超时失败」，
   * 只是「这条任务不再值得记着」。正在等它的页面会先收到一次「没结果」的推送，不会一直转圈。
   *
   * 活要跑多久就让它跑多久：这里没有等多久算失败这回事，唯一的边界是 TTL。
   */
  function sweep() {
    const deadline = now() - ttlMs
    for (const [id, job] of jobs) {
      if (job.startedAt >= deadline) continue
      jobs.delete(id)
      notify(id, {
        ...job,
        status: 'failed',
        targets: null,
        error: `任务超过 ${Math.round(ttlMs / 60_000)} 分钟还没有结果`,
        finishedAt: now(),
      })
    }
    while (jobs.size > max) {
      const oldest = jobs.keys().next().value
      jobs.delete(oldest)
    }
  }

  /**
   * 通知正在等这条任务的订阅者（只通知一次：通知完就清掉订阅表）。
   *
   * @param {string} id
   * @param {object} job
   * @returns {void}
   */
  function notify(id, job) {
    const pending = listeners.get(id)
    listeners.delete(id)
    if (!pending) return
    for (const listener of pending) {
      try {
        listener({ ...job })
      } catch {
        // 一个订阅者出错不影响别人
      }
    }
  }

  return {
    /**
     * 开一条任务。
     *
     * @param {{ dir: string, rel: string, code: string, sessionId?: string }} input
     * @returns {object}
     */
    create(input) {
      sweep()
      const id = `job-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const job = {
        id,
        dir: input.dir,
        rel: input.rel,
        code: input.code,
        sessionId: String(input.sessionId ?? ''),
        status: 'running',
        targets: null,
        error: null,
        startedAt: now(),
        finishedAt: null,
      }
      jobs.set(id, job)
      return { ...job }
    },

    /**
     * @param {string} id
     * @returns {object | null}
     */
    get(id) {
      sweep()
      const job = jobs.get(id)
      return job ? { ...job } : null
    },

    /**
     * 结束一条任务：`done` 带结果，`failed` 带原因。重复结束以第一次为准。
     *
     * @param {string} id
     * @param {{ status: 'done'|'failed', targets?: string[], error?: string }} patch
     * @returns {object | null}
     */
    finish(id, patch) {
      const job = jobs.get(id)
      if (!job) return null
      if (job.status !== 'running') return { ...job }
      job.status = patch.status
      job.targets = patch.status === 'done' ? (patch.targets ?? []) : null
      job.error = patch.status === 'failed' ? String(patch.error ?? '') : null
      job.finishedAt = now()
      notify(id, job)
      return { ...job }
    },

    /**
     * 订阅一条任务：结束时会收到一次回填。
     *
     * @param {string} id
     * @param {(job: object) => void} listener
     * @returns {() => void}
     */
    subscribe(id, listener) {
      const set = listeners.get(id) ?? new Set()
      set.add(listener)
      listeners.set(id, set)
      return () => {
        const current = listeners.get(id)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(id)
      }
    },

    /**
     * 最近的任务，可按文件过滤（页面回到界面上时用来找「有没有还没取回的结果」）。
     *
     * @param {{ dir?: string, rel?: string }} [filter]
     * @returns {Array<object>}
     */
    list(filter = {}) {
      sweep()
      return [...jobs.values()]
        .filter((job) => (filter.dir ? job.dir === filter.dir : true))
        .filter((job) => (filter.rel ? job.rel === filter.rel : true))
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((job) => ({ ...job }))
    },
  }
}
