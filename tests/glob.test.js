/**
 * glob 匹配器的行为测试。
 *
 * 重点覆盖 file.md 实际会用到的三种写法：段内 `*`、跨段 `**`、单字符 `?`，
 * 以及 `tmp/**` 同时匹配目录本身和它下面的文件。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { matchGlob } from '../src/glob.js'

describe('matchGlob', () => {
  it('* 只匹配一个路径段内的字符', () => {
    assert.equal(matchGlob('src/*.js', 'src/a.js'), true)
    assert.equal(matchGlob('src/*.js', 'src/a/b.js'), false)
    assert.equal(matchGlob('*.md', 'README.md'), true)
    assert.equal(matchGlob('*.md', 'docs/design.md'), false)
  })

  it('** 匹配零层或多层目录', () => {
    assert.equal(matchGlob('src/**', 'src/a.js'), true)
    assert.equal(matchGlob('src/**', 'src/a/b.js'), true)
    assert.equal(matchGlob('src/**', 'src'), true)
    assert.equal(matchGlob('src/**', 'src2/a.js'), false)
    assert.equal(matchGlob('**/*.js', 'a.js'), true)
    assert.equal(matchGlob('**/*.js', 'dir/a.js'), true)
    assert.equal(matchGlob('**/*.js', 'dir/a.ts'), false)
    assert.equal(matchGlob('a/**/b', 'a/b'), true)
    assert.equal(matchGlob('a/**/b', 'a/x/b'), true)
    assert.equal(matchGlob('a/**/b', 'a/x/y/b'), true)
    assert.equal(matchGlob('a/**/b', 'a/x/c'), false)
    assert.equal(matchGlob('**', 'a/b/c'), true)
  })

  it('tmp/** 同时匹配目录和它下面的文件', () => {
    assert.equal(matchGlob('tmp/**', 'tmp'), true)
    assert.equal(matchGlob('tmp/**', 'tmp/a.txt'), true)
    assert.equal(matchGlob('tmp/**', 'tmp/cache/a.bin'), true)
    assert.equal(matchGlob('tmp/**', 'other/a.txt'), false)
  })

  it('? 匹配一个字符', () => {
    assert.equal(matchGlob('file?.md', 'file1.md'), true)
    assert.equal(matchGlob('file?.md', 'file12.md'), false)
  })

  it('字面量按原样匹配', () => {
    assert.equal(matchGlob('README.md', 'README.md'), true)
    assert.equal(matchGlob('README.md', 'readme.md'), false)
    assert.equal(matchGlob('dist/.coder/design.html', 'dist/.coder/design.html'), true)
  })

  it('空模式和越界路径不匹配', () => {
    assert.equal(matchGlob('', 'a'), false)
    assert.equal(matchGlob('src', 'src/a.js'), false)
  })
})
