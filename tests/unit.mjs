/**
 * 离线单测：不联网、不需要凭证。
 *   node tests/unit.mjs
 */
import assert from 'node:assert/strict'

import { eventText, splitChunk } from '../lib/index.js'
import { ftsQuery, ftsText } from '../lib/store.js'
import { normalize, normalizeProviders, activeProvider, DEFAULTS, DEFAULT_PROVIDER } from '../lib/settings.js'
import { messageOf, tailOf, renderBridge, collectBridge } from '../lib/bridge.js'
import {
  applyManagedBlock,
  decayWeight,
  isDue,
  rankWeights,
  renderManagedBlock,
  resolveTarget,
  MANAGED_START,
  MANAGED_END
} from '../lib/weights.js'

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

const clamped = normalize({ topK: 999, minScore: -1, ingestEnabled: 'yes' })
assert.equal(clamped.topK, 20)
assert.equal(clamped.minScore, 0)
assert.equal(clamped.ingestEnabled, DEFAULTS.ingestEnabled)
assert.equal(clamped.bridgeScope, DEFAULTS.bridgeScope)
assert.equal(normalize({ bridgeScope: 'recent-days' }).bridgeScope, 'recent-days')
assert.equal(normalize({ bridgeScope: 'nonsense' }).bridgeScope, DEFAULTS.bridgeScope)
console.log('ok · 设置收敛（越界钳制 + 非法类型回退）')

/* ---------- 多套向量化模型 ---------- */

const fresh = normalize({})
assert.equal(fresh.embeddingProviders.length, 1)
assert.equal(fresh.embeddingActive, DEFAULT_PROVIDER.id)
assert.deepEqual(Object.keys(fresh.embeddingProviders[0]).sort(), [
  'apiKeyRef',
  'baseUrl',
  'batchSize',
  'dimensions',
  'id',
  'label',
  'model',
  'timeoutMs'
])

// 两套并存 + 指针指向第二套
const multi = normalize({
  embeddingProviders: [
    { id: 'ark-plan', label: '方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', apiKeyRef: 'K', model: 'doubao-embedding-vision', dimensions: 1024 },
    { id: 'Local-BGE!', label: '', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyRef: '', model: 'bge-m3', dimensions: 1024, batchSize: 99 },
  ],
  embeddingActive: 'local-bge'
})
assert.equal(multi.embeddingProviders.length, 2)
assert.equal(multi.embeddingProviders[1].id, 'local-bge', 'id 应被规范成小写连字符')
assert.equal(multi.embeddingProviders[1].apiKeyRef, '', '本地服务允许空凭证')
assert.equal(multi.embeddingProviders[1].batchSize, 32, '批量应被钳到上限')
assert.equal(multi.embeddingActive, 'local-bge')
assert.equal(activeProvider(multi).model, 'bge-m3')

// 指针指向不存在的 id → 回退第一套
assert.equal(normalize({ ...multi, embeddingActive: 'ghost' }).embeddingActive, 'ark-plan')

// id 重复 → 自动加后缀，不丢条目
const dup = normalizeProviders([
  { id: 'same', model: 'a' },
  { id: 'same', model: 'b' },
])
assert.deepEqual(dup.map((item) => item.id), ['same', 'same-2'])

// 空列表 → 落回默认那套
assert.equal(normalizeProviders([]).length, 1)
assert.equal(normalizeProviders(null)[0].id, DEFAULT_PROVIDER.id)

// 维度越界钳制
assert.equal(normalizeProviders([{ id: 'a', dimensions: 999999 }])[0].dimensions, 4096)
assert.equal(normalizeProviders([{ id: 'a', dimensions: 1 }])[0].dimensions, 64)
console.log('ok · 多套模型（id 规范化 / 去重 / 指针回退 / 空列表兜底 / 维度钳制）')

// 0.1.0 的扁平设置自动迁移成一套 provider
const legacy = normalize({
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  apiKeyRef: 'ARK_CODE_LATEST_API_KEY',
  model: 'doubao-embedding-vision',
  dimensions: 2048
})
assert.equal(legacy.embeddingProviders.length, 1)
assert.equal(legacy.embeddingProviders[0].dimensions, 2048)
assert.equal(legacy.embeddingProviders[0].model, 'doubao-embedding-vision')
assert.equal(legacy.embeddingActive, 'ark-plan')
assert.equal(legacy.baseUrl, undefined, '旧扁平字段不再保留')
console.log('ok · 旧扁平设置迁移（不丢配置）')

// L2 / L4 的 maxEntries 不再撞车
assert.notEqual(DEFAULTS.maxEntries, undefined)
assert.notEqual(DEFAULTS.maxNoteEntries, undefined)
console.log('ok · L2 与 L4 上限字段不冲突')

/* ---------- 中文分词 ---------- */

assert.equal(ftsText('记忆检索'), ' 记忆 忆检 检索 ')
assert.equal(ftsQuery(''), '')
assert.ok(ftsQuery('Agent Plan').includes('"Agent"'))
assert.ok(ftsQuery('a"b').includes('""'))
console.log('ok · 中文二元组与查询转义')

/* ---------- L1 桥接 ---------- */

const ev = (type, data) => ({ type, seq: 1, time: Date.now(), data })

assert.deepEqual(messageOf(ev('user/message', { role: 'user', content: [{ type: 'text', text: '早' }], source: { kind: 'user' } })), {
  role: 'user',
  text: '早',
  seq: 1
})
assert.equal(messageOf(ev('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'compact-checkpoint' } })), null)
assert.equal(messageOf(ev('user/message', { content: [{ type: 'text', text: 'x' }], source: { kind: 'memory-vector' } })), null)
assert.equal(messageOf(ev('assistant/message', { message: { content: [{ type: 'text', text: '嗯' }] } })).role, 'assistant')
assert.equal(messageOf(ev('tool/result', {})), null)
console.log('ok · 桥接消息筛选（压缩摘要、插件注入、工具结果都不进）')

const events = [
  ev('user/message', { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } }),
  ev('assistant/message', { message: { content: [{ type: 'text', text: '第二句' }] } }),
  ev('user/message', { content: [{ type: 'text', text: '<compacted-summary>旧摘要</compacted-summary>' }], source: { kind: 'user' } }),
  ev('user/message', { content: [{ type: 'text', text: '第三句' }], source: { kind: 'user' } })
]
const tail = tailOf(events, 10)
assert.deepEqual(tail.map((item) => item.text), ['第一句', '第二句', '第三句'], '压缩摘要应被剔除')
assert.deepEqual(tailOf(events, 1).map((item) => item.text), ['第三句'])
console.log('ok · 取尾巴（截断 + 剔除压缩摘要）')

const rendered = renderBridge({
  cwd: 'D:\\projects\\demo',
  sessions: [
    { id: 'aaaa1111', createdAt: Date.now() - 60000, messages: [{ role: 'user', text: '旧问题' }, { role: 'assistant', text: '旧回答' }] },
    { id: 'bbbb2222', createdAt: Date.now(), messages: [{ role: 'user', text: '新问题' }] }
  ],
  budget: 500
})
assert.match(rendered, /【前面聊过的】/)
assert.match(rendered, /bbbb2222/)
assert.ok(rendered.indexOf('旧问题') < rendered.indexOf('新问题'), '旧的在前，新的在后')
assert.equal(renderBridge({ cwd: '', sessions: [], budget: 500 }), '')

const tight = renderBridge({
  cwd: '',
  sessions: [{ id: 'cccc3333', createdAt: Date.now(), messages: [{ role: 'user', text: '啊'.repeat(2000) }] }],
  budget: 120,
  perMessage: 400
})
assert.ok(tight.length < 400, `预算应生效，实际 ${tight.length}`)
console.log('ok · 桥接渲染（顺序 + 预算 + 空态）')

// 假的 sessionQuery：两场会话 + 一场子智能体
const now = Date.now()
const fakeQuery = {
  async listSessions() {
    return [
      { header: { id: 'new-1', cwd: 'D:\\w', createdAt: now } },
      { header: { id: 'old-1', cwd: 'D:\\w', createdAt: now - 3600000 } },
      { header: { id: 'sub-1', cwd: 'D:\\w', createdAt: now, origin: 'subagent' } },
      { header: { id: 'other-1', cwd: 'D:\\elsewhere', createdAt: now } }
    ]
  },
  async readSurface(id) {
    return {
      events: [ev('user/message', { content: [{ type: 'text', text: `来自 ${id}` }], source: { kind: 'user' } })]
    }
  }
}

const latest = await collectBridge({ sessionQuery: fakeQuery, cwd: 'D:\\w', currentSessionId: '', scope: 'workspace-latest', days: 7, maxMessages: 12, budget: 1200 })
assert.deepEqual(latest.sessions, ['new-1'], 'workspace-latest 只取最近一场同工作区会话')
assert.match(latest.text, /来自 new-1/)

const excluded = await collectBridge({ sessionQuery: fakeQuery, cwd: 'D:\\w', currentSessionId: 'new-1', scope: 'workspace-latest', days: 7, maxMessages: 12, budget: 1200 })
assert.deepEqual(excluded.sessions, ['old-1'], '应排除自己')

const recent = await collectBridge({ sessionQuery: fakeQuery, cwd: 'D:\\w', currentSessionId: '', scope: 'recent-days', days: 7, maxMessages: 12, budget: 2400 })
assert.ok(recent.sessions.includes('new-1') && recent.sessions.includes('old-1'))
assert.ok(!recent.sessions.includes('sub-1'), '子智能体会话不桥接')
assert.ok(!recent.sessions.includes('other-1'), 'recent-days 也只取同工作区')

const noService = await collectBridge({ sessionQuery: undefined, cwd: 'D:\\w', currentSessionId: '', scope: 'workspace-latest', days: 7, maxMessages: 12, budget: 1200 })
assert.deepEqual(noService, { text: '', sessions: [] })
console.log('ok · 桥接采集（排除自己 / 过滤子会话 / 无服务时静默）')

/* ---------- L2 长期权重 ---------- */

const DAY = 86400000
const clock = Date.UTC(2026, 10, 4)

// 半衰期：命中 0 次、恰好过了 21 天 → 权重 0.5
const halved = decayWeight({ hits: 0, lastHitAt: clock - 21 * DAY, createdAt: clock - 100 * DAY, now: clock, halfLifeDays: 21 })
assert.ok(Math.abs(halved - 0.5) < 1e-9, `半衰期应为 0.5，实际 ${halved}`)

const oneHit = decayWeight({ hits: 1, lastHitAt: clock, createdAt: clock, now: clock, halfLifeDays: 21 })
const tenHits = decayWeight({ hits: 10, lastHitAt: clock, createdAt: clock, now: clock, halfLifeDays: 21 })
assert.ok(tenHits > oneHit, '命中越多权重越高')

const justUsed = decayWeight({ hits: 3, lastHitAt: clock, createdAt: clock, now: clock, halfLifeDays: 21 })
const longUnused = decayWeight({ hits: 3, lastHitAt: clock - 60 * DAY, createdAt: clock, now: clock, halfLifeDays: 21 })
assert.ok(justUsed > longUnused, '越久没用权重越低')
// 从没被用过 → 用创建时间做衰减锚点
assert.ok(decayWeight({ hits: 0, lastHitAt: 0, createdAt: clock - 21 * DAY, now: clock, halfLifeDays: 21 }) < 0.6)
console.log('ok · 艾宾浩斯权重（半衰期 / 次数强化 / 时间衰减）')

const ranked = rankWeights(
  [
    { sessionId: 'a', seq: 1, text: '旧的热门', hits: 5, lastHitAt: clock - 30 * DAY, createdAt: clock - 40 * DAY },
    { sessionId: 'b', seq: 2, text: '新的冷门', hits: 1, lastHitAt: clock, createdAt: clock - 2 * DAY },
    { sessionId: 'c', seq: 3, text: '从没用过', hits: 0, lastHitAt: 0, createdAt: clock - 1 * DAY }
  ],
  { now: clock, halfLifeDays: 21, limit: 2 }
)
assert.equal(ranked.length, 2)
assert.ok(ranked[0].weight >= ranked[1].weight)
console.log('ok · 权重排序与截断')

const block = renderManagedBlock(
  [{ sessionId: 'sess-1', seq: 42, text: '索引改成分片了', hits: 3, lastHitAt: clock - 2 * DAY, weight: 1.8 }],
  { now: clock, halfLifeDays: 21, zh: true }
)
assert.ok(block.startsWith(MANAGED_START))
assert.ok(block.trimEnd().endsWith(MANAGED_END))
assert.match(block, /sess-1#42/, '每条都要带锚点')
assert.match(block, /半衰期 21 天/)
console.log('ok · 快照渲染（标记 + 锚点）')

const appended = applyManagedBlock('', block)
assert.ok(appended.startsWith(MANAGED_START))

const withPersona = applyManagedBlock('# 你是谁\n\n我是子非鱼。\n', block)
assert.ok(withPersona.startsWith('# 你是谁'))
assert.ok(withPersona.includes('我是子非鱼。'))
assert.ok(withPersona.includes(MANAGED_START))

const grown = withPersona.replace('我是子非鱼。', '我是子非鱼，来自夜之城。')
const edited = block.replace('索引改成分片了', '索引改成两片')
const replaced = applyManagedBlock(grown, edited)
assert.ok(replaced.includes('我是子非鱼，来自夜之城。'), '受管块之外的内容不能被改')
assert.equal(replaced.match(/managed:memory-weights start/g).length, 1, '不能出现两个受管块')
assert.ok(replaced.includes('索引改成两片'))
assert.equal(replaced, applyManagedBlock(replaced, edited), '同内容重写应幂等')
console.log('ok · 受管块就地替换（之外内容零改动 + 幂等）')

assert.equal(isDue({ mode: 'daily', hours: 24, lastAt: 0, lastTurn: null, turn: 1, now: clock }), true)
assert.equal(isDue({ mode: 'daily', hours: 24, lastAt: clock - 23 * 3600000, lastTurn: null, turn: 5, now: clock }), false)
assert.equal(isDue({ mode: 'daily', hours: 24, lastAt: clock - 25 * 3600000, lastTurn: null, turn: 5, now: clock }), true)
assert.equal(isDue({ mode: 'daily', hours: 12, lastAt: clock - 13 * 3600000, lastTurn: null, turn: 5, now: clock }), true)
assert.equal(isDue({ mode: 'turns', hours: 24, turns: 20, lastAt: clock, lastTurn: 5, turn: 24, now: clock }), false)
assert.equal(isDue({ mode: 'turns', hours: 24, turns: 20, lastAt: clock, lastTurn: 5, turn: 25, now: clock }), true)
assert.equal(isDue({ mode: 'manual', hours: 24, turns: 20, lastAt: 0, lastTurn: null, turn: 99, now: clock }), false)
console.log('ok · 刷新节奏（按天 / 按轮 / 手动）')

assert.ok(resolveTarget('C:\\h', 'AGENT.md').endsWith('AGENT.md'))
assert.ok(resolveTarget('C:\\h', 'notes/mem.md').endsWith('mem.md'))
console.log('ok · 快照目标路径')

console.log('\n全部单测通过')
