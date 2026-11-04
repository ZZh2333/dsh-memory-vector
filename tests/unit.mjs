/**
 * 离线单测：不联网、不需要凭证。
 *   node tests/unit.mjs
 */
import assert from 'node:assert/strict'

import { eventText, splitChunk } from '../lib/index.js'
import { ftsQuery, ftsText } from '../lib/store.js'
import { normalize, DEFAULTS } from '../lib/settings.js'

/* ---------- 事件抽取 ---------- */

assert.deepEqual(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } }), {
  role: 'user',
  text: '你好'
})
assert.equal(eventText({ type: 'user/message', data: { content: [], source: { kind: 'runtime-context' } } }), null)
assert.equal(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'runtime-context' } } }), null)
assert.deepEqual(eventText({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在' }] } } }), {
  role: 'assistant',
  text: '在'
})
assert.equal(eventText({ type: 'assistant/message', data: { message: { content: [{ type: 'thinking', thinking: '嗯' }] } } }), null)
assert.equal(eventText({ type: 'tool/result', data: {} }), null)
assert.equal(eventText({ type: 'turn/end', data: {} }), null)
assert.equal(eventText(null), null)
console.log('ok · 事件抽取（含运行时上下文过滤）')

/* ---------- 切块 ---------- */

const short = '一句话'
assert.deepEqual(splitChunk(short, 100), [short])

const long = '第一段。'.repeat(50)
const parts = splitChunk(long, 100)
assert.ok(parts.length > 1)
assert.ok(parts.every((part) => part.length <= 100))
assert.equal(parts.join(''), long)
console.log(`ok · 切块（${long.length} 字 → ${parts.length} 块，无内容丢失）`)

const paragraphs = 'A'.repeat(60) + '\n\n' + 'B'.repeat(60)
const split = splitChunk(paragraphs, 80)
assert.ok(split.length >= 2)
assert.ok(split[0].startsWith('A'))
assert.ok(split.join('').includes('B'))
console.log('ok · 段落优先切分')

/* ---------- 设置收敛 ---------- */

const clamped = normalize({ topK: 999, minScore: -1, dimensions: 4096, ingestEnabled: 'yes' })
assert.equal(clamped.topK, 20)
assert.equal(clamped.minScore, 0)
assert.equal(clamped.dimensions, DEFAULTS.dimensions)
assert.equal(clamped.ingestEnabled, DEFAULTS.ingestEnabled)
assert.equal(clamped.bridgeScope, DEFAULTS.bridgeScope)
assert.equal(normalize({ bridgeScope: 'recent-days' }).bridgeScope, 'recent-days')
assert.equal(normalize({ bridgeScope: 'nonsense' }).bridgeScope, DEFAULTS.bridgeScope)
console.log('ok · 设置收敛（越界钳制 + 非法类型回退）')

/* ---------- 中文分词 ---------- */

assert.equal(ftsText('记忆检索'), ' 记忆 忆检 检索 ')
assert.equal(ftsQuery(''), '')
assert.ok(ftsQuery('Agent Plan').includes('"Agent"'))
assert.ok(ftsQuery('a"b').includes('""'))
console.log('ok · 中文二元组与查询转义')

console.log('\n全部单测通过')
