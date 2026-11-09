import assert from 'node:assert/strict'
import test from 'node:test'

import { describeProgram, parseProgram, withWorktree } from '../src/program.mjs'

test('解析：字符串是 cmd 简写，cmd 与 dsh-plugin 都认，input 就是对象', () => {
  assert.deepEqual(parseProgram('node app.mjs', 'launch'), [
    { type: 'cmd', entry: 'node app.mjs', args: {} },
  ])
  assert.deepEqual(parseProgram(undefined, 'launch'), [])
  assert.deepEqual(parseProgram([' ', ''], 'launch'), [], '空字符串不是一步')

  const steps = parseProgram(
    [
      { type: 'cmd', entry: 'npm run build' },
      { type: 'dsh-plugin', entry: 'xl_build', input: { paths: ['src'], flat: true } },
      { entry: 'node app.mjs' },
    ],
    'launch',
  )
  assert.deepEqual(steps[0], { type: 'cmd', entry: 'npm run build', args: {} })
  assert.equal(steps[1].type, 'dsh-plugin')
  assert.equal(steps[1].entry, 'xl_build')
  assert.deepEqual(steps[1].input, { paths: ['src'], flat: true }, 'input 就是对象本身')
  assert.deepEqual(steps[1].args, { paths: ['src'], flat: true })
  assert.equal(steps[2].type, 'cmd', 'type 默认 cmd')

  // 旧写法：JSON 字符串也认；空对象等于没给
  const [fromString] = parseProgram([{ type: 'dsh-plugin', entry: 'x', input: '{"paths":["src"]}' }], 'build')
  assert.deepEqual(fromString.input, { paths: ['src'] })
  const [empty] = parseProgram([{ type: 'dsh-plugin', entry: 'x', input: {} }], 'build')
  assert.equal(empty.input, undefined, '空对象不必写进提示词')
  assert.deepEqual(empty.args, {})
})

test('不认识的类型、缺 entry、cmd 带 input、input 不是对象都报错', () => {
  assert.throws(() => parseProgram([{ type: 'http', entry: 'http://x' }], 'build'), /type 只接受 cmd \/ dsh-plugin/)
  assert.throws(() => parseProgram([{ type: 'cmd' }], 'build'), /缺 entry/)
  assert.throws(() => parseProgram([{ type: 'cmd', entry: 'x', input: { a: 1 } }], 'build'), /是 cmd，不需要 input/)
  assert.throws(() => parseProgram([{ type: 'dsh-plugin', entry: 'x', input: '{不合法' }], 'build'), /必须是 JSON 对象/)
  assert.throws(() => parseProgram([{ type: 'dsh-plugin', entry: 'x', input: ['a'] }], 'build'), /必须是 JSON 对象/)
  assert.throws(() => parseProgram([{ type: 'dsh-plugin', entry: 'x', input: 42 }], 'build'), /必须是 JSON 对象/)
  assert.throws(() => parseProgram([42], 'build'), /应为 \{type, entry\} 对象/)
})

test('描述成提示词里的一段，{{worktree}} 换成工作区路径', () => {
  assert.deepEqual(describeProgram(parseProgram([{ type: 'cmd', entry: 'npm run build' }], 'build')), [
    '1. [命令] npm run build',
  ])
  assert.deepEqual(
    describeProgram(parseProgram([{ type: 'dsh-plugin', entry: 'xl_build', input: { paths: ['src'] } }], 'build')),
    ['1. [DSH 工具] xl_build {"paths":["src"]}'],
  )
  assert.deepEqual(describeProgram([]), [])

  assert.equal(withWorktree('node {{worktree}}/src/app.mjs', 'C:/tmp/w'), 'node C:/tmp/w/src/app.mjs')
  assert.equal(withWorktree('npm run build', 'C:/tmp/w'), 'npm run build')
})
