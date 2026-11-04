/**
 * dsh-memory-vector · L4 自我叙述
 *
 * 规则见 docs/l4-antidrift.md。这里只记一句话：
 * 把"我是谁"从自由创作，压缩成"可核对的事实清单"。
 *
 * 数据分两份：
 *   memory/self-note.json   —— 真源（条目、归档、待审队列）
 *   memory/self-note.md     —— 给人看和给模型注入的渲染结果（受管块）
 *
 * 只有模型主动调用 self_note_write 才会写入；插件自己不总结、不定时反思。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const NOTE_START = '<!-- managed:self-note start -->'
export const NOTE_END = '<!-- managed:self-note end -->'

/** 允许的五类，别的免谈。 */
export const KINDS = ['能力边界', '偏好', '教训', '关系', '未完成']

/** 禁语：命中即拒。 */
const BANNED = [
  { pattern: /我感到|我觉得自己|我很开心|我很难过|我委屈|我骄傲|我害怕/, why: '情绪自述' },
  { pattern: /我很聪明|我最擅长|我比.{0,6}更|我从不犯错|我很厉害|我特别强/, why: '自我评价' },
  { pattern: /我会永远|我保证|我绝不会|我发誓|我永远不/, why: '承诺' },
  { pattern: /我是人类|我真的穿越|我不再是 ?AI|我是个真人/, why: '身份改写' },
  { pattern: /最近|一直以来|这阵子|近段时间/, why: '模糊时间' }
]

/** "未完成"只许写什么没做完，不许写原因——那是自我开脱的入口。 */
const REASON_WORDS = /因为|由于|原因是|是因为|导致|所以才|没办法|来不及/

const MAX_CLAIM = 200

/** 字符二元组，用来量 claim 和原文的重叠。中文按字，英文按词。 */
export function bigrams(text) {
  const normalized = String(text).toLowerCase().replace(/\s+/g, '')
  const grams = new Set()
  const chars = [...normalized]
  for (let index = 0; index < chars.length - 1; index += 1) grams.add(chars[index] + chars[index + 1])
  return grams
}

/** claim 有多少比例能在原文里找到。0.3 是采纳线，0.2 是体检线。 */
export function overlapRatio(claim, sources) {
  const mine = bigrams(claim)
  if (mine.size === 0) return 0
  const pool = new Set()
  for (const source of sources) for (const gram of bigrams(source)) pool.add(gram)
  let hit = 0
  for (const gram of mine) if (pool.has(gram)) hit += 1
  return hit / mine.size
}

/**
 * 单向包含：短的那条有多少比例被长的覆盖。
 * 用来判断"这条是不是在改写已有条目"——比对称比例稳，
 * 因为改写通常只是补了半句。
 */
export function containment(left, right) {
  const a = bigrams(left)
  const b = bigrams(right)
  const small = a.size <= b.size ? a : b
  if (small.size === 0) return 0
  let hit = 0
  for (const gram of small) if (a.has(gram) && b.has(gram)) hit += 1
  return hit / small.size
}

export function parseAnchor(anchor) {  const text = String(anchor).trim()
  const match = /^(session-[A-Za-z0-9._-]+|[\w.-]{6,})#(\d+)$/.exec(text)
  if (match === null) return null
  return { sessionId: match[1], seq: Number(match[2]) }
}

/**
 * 把一条草稿按六道闸门过一遍。
 * @param {object} draft {kind, claim, anchors, supersedes}
 * @param {object} env {anchorSources: string[], entries, now, mode:'auto'|'pending'}
 * @returns {{ok:boolean, errors:string[], entry?:object}}
 */
export function validateDraft(draft, env) {
  const errors = []
  const claim = String(draft?.claim ?? '').trim()
  const kind = String(draft?.kind ?? '').trim()
  const anchors = Array.isArray(draft?.anchors) ? draft.anchors.map((item) => String(item).trim()).filter((item) => item !== '') : []

  if (!KINDS.includes(kind)) errors.push(`kind 必须是 ${KINDS.join(' / ')} 之一`)
  if (claim === '') errors.push('claim 不能为空')
  if (claim.length > MAX_CLAIM) errors.push(`claim 超过 ${MAX_CLAIM} 字（现在 ${claim.length}）`)
  if (anchors.length === 0) errors.push('至少要给一个 anchors（sessionId#seq）')
  if (anchors.length > 3) errors.push('anchors 最多 3 个')

  for (const anchor of anchors) {
    if (parseAnchor(anchor) === null) errors.push(`anchor 格式不对：${anchor}（应为 session-xxx#12）`)
  }

  for (const rule of BANNED) {
    const hit = rule.pattern.exec(claim)
    if (hit !== null) errors.push(`禁语（${rule.why}）：${hit[0]}`)
  }

  if (kind === '未完成') {
    const hit = REASON_WORDS.exec(claim)
    if (hit !== null) errors.push(`「未完成」只许写什么没做完，不许写原因：${hit[0]}`)
  }

  // G2：claim 必须能在锚点原文里找到足够多的字
  const sources = Array.isArray(env?.anchorSources) ? env.anchorSources : []
  const ratio = overlapRatio(claim, sources)
  if (sources.length > 0 && ratio < 0.3) {
    errors.push(`claim 与原文重叠只有 ${(ratio * 100).toFixed(0)}%，低于 30%：说得比原文多，就是编造`)
  }

  // G6：与已有条目冲突必须显式说明取代了谁
  const entries = Array.isArray(env?.entries) ? env.entries : []
  if (typeof draft?.supersedes === 'string' && draft.supersedes !== '') {
    if (!entries.some((entry) => entry.id === draft.supersedes)) {
      errors.push(`supersedes 指向的条目不存在：${draft.supersedes}`)
    }
  } else {
    const conflicting = entries.find(
      (entry) => entry.kind === kind && entry.claim !== claim && containment(claim, entry.claim) >= 0.5
    )
    if (conflicting !== undefined) {
      errors.push(`和已有条目 ${conflicting.id} 高度重合，如果是修正它，请带 supersedes: ${conflicting.id}`)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    errors: [],
    entry: {
      id: '',
      at: Number(env?.now ?? Date.now()),
      kind,
      claim,
      anchors,
      supersedes: typeof draft?.supersedes === 'string' && draft.supersedes !== '' ? draft.supersedes : null,
      status: env?.mode === 'pending' ? 'pending' : 'active'
    }
  }
}

/** 编号：L4-20261104-03。 */
export function nextId(entries, now, prefix = 'L4') {
  const day = new Date(now)
  const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
  const used = entries.filter((entry) => String(entry.id).startsWith(`${prefix}-${stamp}-`)).length
  return `${prefix}-${stamp}-${String(used + 1).padStart(2, '0')}`
}

export function emptyState() {
  return { version: 1, entries: [], archive: [], pending: [], lastAt: 0, lastTurn: 0 }
}

export function normalizeState(raw) {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object') return base
  const take = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.claim === 'string')
      .map((entry) => ({
        id: String(entry.id ?? ''),
        at: Number(entry.at ?? 0),
        kind: KINDS.includes(String(entry.kind)) ? String(entry.kind) : '教训',
        claim: String(entry.claim),
        anchors: Array.isArray(entry.anchors) ? entry.anchors.map(String).slice(0, 3) : [],
        supersedes: typeof entry.supersedes === 'string' ? entry.supersedes : null,
        status: ['active', 'stale', 'pending'].includes(String(entry.status)) ? String(entry.status) : 'active',
        createdAt: Number(entry.createdAt ?? entry.at ?? 0)
      }))
  base.entries = take(raw.entries)
  base.archive = take(raw.archive)
  base.pending = take(raw.pending)
  base.lastAt = Number(raw.lastAt ?? 0)
  base.lastTurn = Number(raw.lastTurn ?? 0)
  return base
}

export function readState(path) {
  try {
    return normalizeState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return emptyState()
  }
}

export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(normalizeState(state), null, 2) + '\n', 'utf8')
  renameSync(temp, path)
}

/** 渲染给模型看的注入文本。永远是"记下的",不是"我是"。 */
export function renderNotes(entries, options = {}) {
  const { budget = 1200, zh = true } = options
  const active = entries.filter((entry) => entry.status === 'active')
  if (active.length === 0) return ''
  const head = zh
    ? '【我记下的关于自己的事实】（每条附出处；与当前事实冲突时，以当前事实为准）'
    : '[Facts I recorded about myself] (anchored; current facts win when they conflict)'
  const lines = []
  let used = head.length
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const entry = active[index]
    const line = `- [${entry.kind}] ${entry.claim}（${entry.anchors.join('、')}）`
    if (used + line.length > budget) break
    used += line.length
    lines.unshift(line)
  }
  if (lines.length === 0) return ''
  return `${head}\n${lines.join('\n')}`
}

/** 渲染磁盘上的 md（受管块）。 */
export function renderFile(entries, options = {}) {
  const body = renderNotes(entries, options)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const note = `> 由 dsh-memory-vector 维护，只增不删；被取代的进归档。更新时间 ${stamp}。`
  const content = body === '' ? `${note}\n\n（还没有条目）` : `${note}\n\n${body}`
  return `${NOTE_START}\n${content}\n${NOTE_END}\n`
}

export function applyManaged(text, block) {
  const source = typeof text === 'string' ? text : ''
  const start = source.indexOf(NOTE_START)
  const end = source.indexOf(NOTE_END)
  if (start >= 0 && end > start) {
    const head = source.slice(0, start).replace(/\n+$/, '')
    const tail = source.slice(end + NOTE_END.length).replace(/^\n+/, '')
    return `${head === '' ? '' : head + '\n\n'}${block}${tail === '' ? '' : '\n' + tail}`
  }
  const trimmed = source.replace(/\n+$/, '')
  return `${trimmed === '' ? '' : trimmed + '\n\n'}${block}`
}

export function writeFile(path, entries, options) {
  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = ''
  }
  const block = renderFile(entries, options)
  const next = applyManaged(existing, block)
  mkdirSync(dirname(path), { recursive: true })
  if (next === existing) return { changed: false, path }
  const temp = `${path}.tmp`
  writeFileSync(temp, next, 'utf8')
  renameSync(temp, path)
  return { changed: true, path }
}

/** 把 active 条数压到上限：最旧的进归档（不删）。 */
export function trimEntries(state, maxEntries) {
  const limit = Math.max(1, Number(maxEntries) || 12)
  const active = state.entries.filter((entry) => entry.status !== 'archived')
  if (active.length <= limit) return state
  const overflow = active.slice(0, active.length - limit)
  const overflowIds = new Set(overflow.map((entry) => entry.id))
  state.archive = [
    ...overflow.map((entry) => ({ ...entry, status: 'archived', archivedAt: Date.now(), reason: 'capped' })),
    ...state.archive
  ]
  state.entries = state.entries.filter((entry) => !overflowIds.has(entry.id))
  return state
}

/** 体检：claim 和锚点原文的重叠跌破 0.2 就标 stale，不注入。 */
export function auditEntries(entries, sourcesByAnchor) {
  let stale = 0
  for (const entry of entries) {
    if (entry.status !== 'active') continue
    const sources = entry.anchors.map((anchor) => sourcesByAnchor[anchor]).filter((text) => typeof text === 'string')
    if (sources.length === 0) continue
    if (overlapRatio(entry.claim, sources) < 0.2) {
      entry.status = 'stale'
      stale += 1
    }
  }
  return stale
}

/** 待审队列过期丢弃。 */
export function discardExpired(state, ttlHours, now) {
  const ttl = Math.max(1, Number(ttlHours) || 72) * 3600000
  const kept = state.pending.filter((entry) => now - entry.createdAt < ttl)
  const dropped = state.pending.length - kept.length
  state.pending = kept
  return dropped
}

/** 采纳 / 丢弃待审条目。 */
export function resolvePending(state, id, action) {
  const index = state.pending.findIndex((entry) => entry.id === id)
  if (index < 0) return { ok: false, error: `没有待审条目 ${id}` }
  const [entry] = state.pending.splice(index, 1)
  if (action === 'discard') return { ok: true, entry: null }
  const accepted = { ...entry, status: 'active', createdAt: Date.now() }
  if (accepted.supersedes !== null) {
    const target = state.entries.find((item) => item.id === accepted.supersedes)
    if (target !== undefined) {
      state.archive.push({ ...target, status: 'archived', archivedAt: Date.now(), reason: `superseded by ${accepted.id}`, supersededBy: accepted.id })
      state.entries = state.entries.filter((item) => item.id !== target.id)
    }
  }
  state.entries.push(accepted)
  return { ok: true, entry: accepted }
}
