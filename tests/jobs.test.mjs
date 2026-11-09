import assert from 'node:assert/strict'
import test from 'node:test'

import { createJobStore } from '../src/jobs.mjs'
import { createJobTool } from '../src/tools/job.mjs'

test('任务表：开工 → 完成，状态可查；重复结束以第一次为准', () => {
  const jobs = createJobStore()
  const job = jobs.create({ dir: 'C:/repo', rel: 'docs/codes.jsonl', code: 'D001', sessionId: 's1' })
  assert.equal(job.status, 'running')
  assert.equal(jobs.get(job.id).code, 'D001')
  assert.deepEqual(jobs.list({ dir: 'C:/repo' }).map((item) => item.id), [job.id])

  const done = jobs.finish(job.id, { status: 'done', targets: ['Session#append'] })
  assert.equal(done.status, 'done')
  assert.deepEqual([...done.targets], ['Session#append'])

  const again = jobs.finish(job.id, { status: 'failed', error: 'late' })
  assert.equal(again.status, 'done', '已经结束的任务不会被第二次覆盖')

  assert.equal(jobs.get('nope'), null)
})

test('任务表：订阅者会在结束时收到一次；取消订阅后收不到', () => {
  const jobs = createJobStore()
  const job = jobs.create({ dir: 'C:/repo', rel: 'docs/codes.jsonl', code: 'D001' })

  const seen = []
  const off = jobs.subscribe(job.id, (value) => seen.push(value.status))
  jobs.finish(job.id, { status: 'done', targets: ['X'] })
  assert.deepEqual(seen, ['done'])

  const other = jobs.create({ dir: 'C:/repo', rel: 'docs/codes.jsonl', code: 'D002' })
  const off2 = jobs.subscribe(other.id, () => seen.push('should-not'))
  off2()
  jobs.finish(other.id, { status: 'failed', error: 'x' })
  assert.deepEqual(seen, ['done'])
  off()
})

test('任务表：按文件过滤、过期清理、数量上限', () => {
  let now = 1_000
  const jobs = createJobStore({ ttlMs: 100, max: 3, now: () => now })

  const a = jobs.create({ dir: 'C:/a', rel: 'docs/codes.jsonl', code: 'D001' })
  jobs.finish(a.id, { status: 'done', targets: ['x'] })
  const b = jobs.create({ dir: 'C:/b', rel: 'docs/codes.jsonl', code: 'D001' })
  assert.deepEqual(jobs.list({ dir: 'C:/b' }).map((item) => item.id), [b.id])
  assert.equal(jobs.list({ dir: 'C:/a' }).length, 1)

  now += 1_000 // a 已经过期
  assert.equal(jobs.get(a.id), null, '过了 TTL 的已完成任务会被清掉')

  for (let i = 0; i < 5; i += 1) jobs.create({ dir: 'C:/c', rel: 'docs/codes.jsonl', code: `D00${i}` })
  assert.ok(jobs.list().length <= 3, '不超过上限')
})

test('任务表：没有超时这回事；过期只按 TTL 清，清的时候正在等的页面会收到一次「没结果」', () => {
  let now = 1_000
  const jobs = createJobStore({ ttlMs: 100, now: () => now })

  const job = jobs.create({ dir: 'C:/repo', rel: 'docs/codes.jsonl', code: 'D001' })
  const seen = []
  jobs.subscribe(job.id, (value) => seen.push([value.status, value.error]))

  // 很久都没回填，但它还在跑：不会被判成失败
  now += 90
  assert.equal(jobs.get(job.id).status, 'running')

  // 过了 TTL 才清掉，并且先把结论推给正在等的人
  now += 20
  assert.equal(jobs.get(job.id), null, '超过 TTL 的任务被清掉')
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'failed')
  assert.match(seen[0][1], /还没有结果/)
})

test('coder_job 工具：提交 targets / 记失败 / 任务不存在 / 参数不全', async () => {
  const jobs = createJobStore()
  const tool = createJobTool(jobs)
  const job = jobs.create({ dir: 'C:/repo', rel: 'docs/codes.jsonl', code: 'D001' })

  const submitted = await tool.execute({
    action: 'submit',
    jobId: job.id,
    targets: [' Session#append ', 'Session#append', '所有 XxxService'],
  })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.count, 2, '去重之后两项')
  assert.deepEqual([...jobs.get(job.id).targets], ['Session#append', '所有 XxxService'])
  assert.equal(tool.output.render({}, submitted).includes('已提交'), true)

  const empty = await tool.execute({ action: 'submit', jobId: job.id, targets: [] })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'BAD_ARGS')

  const missing = await tool.execute({ action: 'submit', jobId: 'job-nope', targets: ['X'] })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NO_JOB')

  const second = jobs.create({ dir: 'C:/repo', rel: 'docs/codes.jsonl', code: 'D002' })
  const failed = await tool.execute({ action: 'fail', jobId: second.id, message: '找不到相关类型' })
  assert.equal(failed.ok, true)
  assert.equal(jobs.get(second.id).status, 'failed')
  assert.match(jobs.get(second.id).error, /找不到/)
})
