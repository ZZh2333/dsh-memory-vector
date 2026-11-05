/**
 * 离线单测：不联网、不需要凭证。
 *   node tests/unit.mjs
 */
import assert from 'node:assert/strict'

import { eventText, splitChunk } from '../lib/index.js'
import { ftsQuery, ftsText } from '../lib/store.js'
import { selectHits } from '../lib/retrieval.js'
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
import {
  discardExpired,
  emptyState,
  nextId,
  renderNotes,
  resolvePending,
  trimEntries,
  validateDraft
} from '../lib/selfnote.js'
import { dirOf, normalizePath, pathsFromToolCall, relativeTo, renderList } from '../lib/deliverables.js'
import { collectTurnChunks, estimateTokens, pickSessions } from '../lib/backfill.js'

/* ---------- 事件抽取 ---------- */

assert.deepEqual(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } }), {
  role: 'user',
  text: '你好'
})
assert.equal(eventText({ type: 'user/message', data: { content: [], source: { kind: 'runtime-context' } } }), null)
assert.equal(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'runtime-context' } } }), null)
// 白名单：任何非 user 来源都不进记忆，尤其是我们自己的注入（否则记忆引用自己）
assert.equal(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'memory-vector' } } }), null)
assert.equal(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'compact-checkpoint' } } }), null)
assert.equal(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'command-result' } } }), null)
assert.equal(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'skill-catalog' } } }), null)
assert.deepEqual(eventText({ type: 'user/message', data: { content: [{ type: 'text', text: '真话' }], source: { kind: 'user' } } }), {
  role: 'user',
  text: '真话'
})
assert.deepEqual(
  eventText({
    type: 'user/message',
    data: {
      content: [{ type: 'text', text: '看这个\n\n<system-reminder>\n技能目录变了\n</system-reminder>' }],
      source: { kind: 'user' }
    }
  }),
  { role: 'user', text: '看这个' },
  'system-reminder 不算主人说的话'
)
// 兜底：注入被宿主以 user 身份落盘时，靠正文开头认出来
assert.equal(
  eventText({
    type: 'user/message',
    data: { content: [{ type: 'text', text: '【记忆·自动回想】以下是从过去对话里检索到的相关片段……' }], source: { kind: 'user' } }
  }),
  null,
  '召回注入不许进库'
)
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

/* ---------- L4 自我叙述：六道闸门 ---------- */

const anchorTexts = ['我把索引改成了分片，每片 3000 字，检索时先查 FTS 再算余弦。']

const good = validateDraft(
  { kind: '教训', claim: '索引需要分片，每片 3000 字，检索先查 FTS 再算余弦。', anchors: ['session-abc#42'] },
  { anchorSources: anchorTexts, entries: [], now: clock, mode: 'auto' }
)
assert.equal(good.ok, true, JSON.stringify(good.errors))
assert.equal(good.entry.status, 'active')

const invented = validateDraft(
  { kind: '教训', claim: '我意识到简洁的代码更容易维护，这是我今年的最大收获。', anchors: ['session-abc#42'] },
  { anchorSources: anchorTexts, entries: [], now: clock, mode: 'auto' }
)
assert.equal(invented.ok, false)
assert.ok(invented.errors.some((line) => line.includes('重叠')), JSON.stringify(invented.errors))

for (const claim of ['我感到很开心。', '我最擅长写检索。', '我会永远记住这条。', '我是人类。', '最近我发现分片很重要。']) {
  const result = validateDraft({ kind: '教训', claim, anchors: ['session-abc#42'] }, { anchorSources: anchorTexts, entries: [], now: clock })
  assert.equal(result.ok, false, `应当拒收：${claim}`)
  assert.ok(result.errors.some((line) => line.includes('禁语')), `${claim} → ${JSON.stringify(result.errors)}`)
}

assert.equal(validateDraft({ kind: '随便', claim: '索引分片', anchors: ['session-abc#42'] }, { anchorSources: anchorTexts, entries: [], now: clock }).ok, false)
assert.equal(validateDraft({ kind: '教训', claim: '索引分片', anchors: [] }, { anchorSources: anchorTexts, entries: [], now: clock }).ok, false)

const withReason = validateDraft(
  { kind: '未完成', claim: '权重历史回填还没做完，因为要扫全部日志太慢。', anchors: ['session-abc#42'] },
  { anchorSources: anchorTexts, entries: [], now: clock }
)
assert.equal(withReason.ok, false)
assert.ok(withReason.errors.some((line) => line.includes('不许写原因')), JSON.stringify(withReason.errors))

const tooLong = validateDraft({ kind: '教训', claim: '分'.repeat(240), anchors: ['session-abc#42'] }, { anchorSources: [], entries: [], now: clock })
assert.equal(tooLong.ok, false)
console.log('ok · 闸门（禁语 / 重叠 / 未完成不写原因 / 长度）')

const existing = [{ id: 'L4-20261101-01', kind: '教训', claim: '索引需要分片，每片 3000 字。', anchors: ['session-x#1'], status: 'active' }]
const quietEdit = validateDraft(
  { kind: '教训', claim: '索引需要分片，每片 3000 字，检索先查 FTS 再算余弦。', anchors: ['session-abc#42'] },
  { anchorSources: anchorTexts, entries: existing, now: clock }
)
assert.equal(quietEdit.ok, false, '高度重合的改写必须带 supersedes')
assert.ok(quietEdit.errors.some((line) => line.includes('supersedes')))

const explicit = validateDraft(
  { kind: '教训', claim: '索引需要分片，每片 3000 字，检索先查 FTS 再算余弦。', anchors: ['session-abc#42'], supersedes: 'L4-20261101-01' },
  { anchorSources: anchorTexts, entries: existing, now: clock }
)
assert.equal(explicit.ok, true, JSON.stringify(explicit.errors))
console.log('ok · 冲突必须显式取代（supersedes）')

assert.equal(nextId([], clock), 'L4-20261104-01')
assert.equal(nextId([{ id: 'L4-20261104-01' }, { id: 'L4-20261104-02' }], clock), 'L4-20261104-03')

const notesText = renderNotes(
  [{ id: 'L4-1', kind: '能力边界', claim: '我不能直接读剪贴板。', anchors: ['session-abc#42'], status: 'active' }],
  { budget: 1200 }
)
assert.ok(notesText.startsWith('【我记下的关于自己的事实】'), '措辞必须是"记下的"而不是"我是"')
assert.ok(notesText.includes('以当前事实为准'), '必须给模型自我否决权')
assert.ok(notesText.includes('session-abc#42'))
assert.equal(renderNotes([{ id: 'L4-2', kind: '教训', claim: '这句不该出现', anchors: [], status: 'stale' }], {}), '', 'stale 不注入')

const capped = emptyState()
capped.entries = Array.from({ length: 5 }, (_item, index) => ({
  id: `L4-20261101-0${index + 1}`,
  at: clock,
  kind: '教训',
  claim: `第 ${index + 1} 条`,
  anchors: [],
  status: 'active'
}))
trimEntries(capped, 3)
assert.equal(capped.entries.length, 3, '超出上限要归档')
assert.equal(capped.archive.length, 2, '归档不是删除')

const pendingState = emptyState()
pendingState.pending = [{ id: 'L4-9', claim: 'x', createdAt: clock - 80 * 3600000 }]
assert.equal(discardExpired(pendingState, 72, clock), 1)
assert.equal(pendingState.pending.length, 0)

const queueState = emptyState()
queueState.pending = [{ id: 'L4-9', kind: '教训', claim: '索引分片', anchors: ['a#1'], status: 'pending', createdAt: clock }]
assert.equal(resolvePending(queueState, 'L4-9', 'discard').ok, true)
assert.equal(queueState.entries.length, 0)
queueState.pending = [{ id: 'L4-9', kind: '教训', claim: '索引分片', anchors: ['a#1'], status: 'pending', createdAt: clock }]
assert.equal(resolvePending(queueState, 'L4-9', 'approve').ok, true)
assert.equal(queueState.entries.length, 1)
assert.equal(queueState.entries[0].status, 'active')
console.log('ok · 编号 / 注入措辞 / 上限归档 / 过期丢弃 / 采纳丢弃')

/* ---------- L3 交付物：从工具调用里抠路径 ---------- */

assert.deepEqual(pathsFromToolCall('write', '{"file_path":"D:\\\\w\\\\a.md","content":"x"}'), [
  { path: 'D:\\w\\a.md', kind: 'created', note: '' }
])
assert.deepEqual(pathsFromToolCall('edit', '{"path":"/tmp/b.py"}'), [{ path: '/tmp/b.py', kind: 'modified', note: '' }])
assert.deepEqual(pathsFromToolCall('present', '{"files":[{"path":"out/report.docx","description":"周报"}]}'), [
  { path: 'out/report.docx', kind: 'delivered', note: '周报' }
])
assert.deepEqual(pathsFromToolCall('write', '{"file_path":"D:\\\\w\\\\half'), [])
assert.deepEqual(pathsFromToolCall('pwsh', '{"file_path":"x"}'), [])
assert.deepEqual(pathsFromToolCall('write', '{"content":"没有路径"}'), [])
assert.deepEqual(pathsFromToolCall('my_tool', '{"file_path":"y.md"}', ['my_tool']), [{ path: 'y.md', kind: 'modified', note: '' }])
console.log('ok · 交付物路径抽取（write / edit / present / 半截 JSON / 名单过滤）')

assert.equal(normalizePath('  "D:\\\\Work\\\\a.md"  '), 'D:/Work/a.md')
assert.equal(relativeTo('D:\\projects\\demo', 'D:\\projects\\demo\\src\\a.ts'), 'src/a.ts')
assert.equal(relativeTo('D:\\projects\\demo', 'D:\\other\\b.ts'), 'D:/other/b.ts')
assert.equal(dirOf('D:\\projects\\demo\\a.ts'), 'D:/projects/demo')
console.log('ok · 路径归一 / 相对化 / 取目录')

assert.match(renderList([], {}), /还没有记录/)
const listing = renderList(
  [
    { path: 'D:\\projects\\demo\\report.md', kind: 'created', at: clock, sessionId: 'session-abc', turn: 4, note: '' },
    { path: 'D:\\projects\\demo\\out.xlsx', kind: 'delivered', at: clock, sessionId: 'session-abc', turn: 5, note: '报表' }
  ],
  { cwd: 'D:\\projects\\demo', budget: 2000 }
)
assert.match(listing, /report\.md/)
assert.match(listing, /session-abc#4/)
assert.match(listing, /报表/)
assert.ok(!listing.includes('D:\\projects\\demo\\report.md'), '同工作区应显示相对路径')
console.log('ok · 交付物列表渲染（相对路径 + 出处 + 描述）')

/* ---------- 历史回填：按轮聚合 + 挑会话 ---------- */

const fakeTextOf = (event) =>
  event.type === 'user/message'
    ? { role: 'user', text: event.data.content[0].text }
    : event.type === 'assistant/message'
      ? { role: 'assistant', text: event.data.message.content[0].text }
      : null

const surfaceEvents = [
  { type: 'user/message', seq: 1, data: { turn: 1, content: [{ type: 'text', text: '把索引改成分片，每片三千字' }] } },
  { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: '改完了，另外加了 FTS 混合检索' }] } } },
  { type: 'turn/end', seq: 3, data: { turn: 1 } },
  { type: 'user/message', seq: 4, data: { turn: 2, content: [{ type: 'text', text: '短' }] } },
  { type: 'assistant/message', seq: 5, data: { turn: 3, message: { content: [{ type: 'text', text: '第三轮：权重快照改成一天一次，半衰期二十一天' }] } } }
]
const turnChunks = collectTurnChunks(surfaceEvents, { textOf: fakeTextOf, maxChars: 3000, minChars: 24 })
assert.equal(turnChunks.length, 2, JSON.stringify(turnChunks))
assert.match(turnChunks[0].text, /我：把索引改成分片/)
assert.match(turnChunks[0].text, /你：改完了/)
assert.equal(turnChunks[0].turn, 1)
assert.equal(turnChunks[1].turn, 3, '太短的单轮要丢掉')
console.log('ok · 回填按轮聚合（user+assistant 拼块 / 过短的丢掉）')

const pickable = pickSessions(
  [
    { header: { id: 's-old', cwd: 'D:\\w', createdAt: 1 } },
    { header: { id: 's-new', cwd: 'D:\\w', createdAt: 9 } },
    { header: { id: 's-done', cwd: 'D:\\w', createdAt: 8 } },
    { header: { id: 's-sub', cwd: 'D:\\w', createdAt: 7, origin: 'subagent' } },
    { header: { id: 's-other', cwd: 'D:\\other', createdAt: 6 } }
  ],
  { done: new Set(['s-done']), cwd: 'D:\\w', onlyWorkspace: true, limit: 10 }
)
assert.deepEqual(pickable.map((session) => session.id), ['s-new', 's-old'])
assert.equal(pickSessions(pickable, { cwd: 'D:\\w', onlyWorkspace: true, limit: 0 }).length, 0)
assert.equal(estimateTokens([{ text: 'a'.repeat(160) }]), 100)
console.log('ok · 回填选场（跳过已处理 / 子会话 / 别的工作区 / 新的优先）')

/* ---------- 检索的工作区范围 ---------- */

const scopedRows = [
  { rowid: 1, sessionId: 's-home', cwd: 'D:\\home', seq: 1, turn: 1, text: '本工作区的部署脚本', createdAt: clock },
  { rowid: 2, sessionId: 's-away', cwd: 'D:\\away', seq: 2, turn: 1, text: '别的项目也在说部署脚本', createdAt: clock },
  { rowid: 3, sessionId: 's-home2', cwd: 'D:\\home', seq: 3, turn: 2, text: '本工作区的第二条', createdAt: clock }
]
const scopedStore = { rowsByIds: (ids) => scopedRows.filter((row) => ids.includes(row.rowid)) }
const scopedOrder = [
  { rowid: 2, score: 0.9, similarity: 0.9, ftsRank: null, vecRank: 1 },
  { rowid: 1, score: 0.8, similarity: 0.8, ftsRank: null, vecRank: 2 },
  { rowid: 3, score: 0.7, similarity: 0.7, ftsRank: null, vecRank: 3 }
]
const baseSelect = {
  store: scopedStore,
  ordered: scopedOrder,
  topK: 3,
  minScore: 0,
  maxHitsPerSession: 5,
  contextChars: 4000,
  cwd: 'D:\\home'
}

const globalHits = selectHits({ ...baseSelect, scope: 'global' })
assert.deepEqual(globalHits.map((hit) => hit.rowid), [2, 1, 3], 'global 完全按相关度')

const localOnly = selectHits({ ...baseSelect, scope: 'workspace' })
assert.deepEqual(localOnly.map((hit) => hit.rowid), [1, 3], 'workspace 不许别的项目进来')

const localFirst = selectHits({ ...baseSelect, scope: 'workspace-first' })
assert.deepEqual(localFirst.map((hit) => hit.rowid), [1, 3, 2], 'workspace-first 本工作区整体提前')
assert.equal(selectHits({ ...baseSelect, scope: 'workspace', cwd: '' }).length, 3, '没有 cwd 时不瞎过滤')
console.log('ok · 检索范围（global / workspace / workspace-first）')

console.log('\n全部单测通过')
