/**
 * dsh-memory-vector · 归因
 *
 * 一个问题：一块记忆被塞进了上下文，后来它真的被用到了吗？
 *
 * 为什么不用"再问一次模型"：那要再烧一遍 token，而且它的自述不可靠。
 * 这里看两件事——回复里有没有复述这块记忆的原话，以及回复与这块记忆的
 * 语义是否真的贴。第一条纯本地、零成本；第二条每轮最多一次向量化。
 *
 * 逐字判据选"连续 N 个字"而不是"任意片段"，是因为中文里连续 12 个字照抄，
 * 基本只能是"真的在读这段记忆"。但有个 0.12 之前没想到的偏置：块越长，
 * 里面能撞上的 12-gram 越多，长块（提示词、大表格、配置清单）天然占便宜。
 * 0.13.0 起门槛按 sqrt(块长/400) 缩放：400 字以内还是 12，3000 字要 33。
 *
 * 语义判据是给"转述"补的：逐字和 bigram 都认不出来的改写，靠余弦。
 * 但余弦高不一定是引用——两段都在聊同一个项目就会天然相似，所以另加一道
 * 词面交集（共享 bigram ≥ 6 条），宁可少给一条权重，也不让同主题的闲聊
 * 把权重垫起来。
 */
import { dot } from './embed.js'

/** 回复里有没有 ≥window 个连续字符原样出现在这块记忆里。 */
export function sharesVerbatim(reply, text, window = 12) {
  const source = String(reply ?? '')
  const target = String(text ?? '')
  const size = Math.max(4, Number(window) || 12)
  if (source.length < size || target.length < size) return false
  for (let index = 0; index + size <= source.length; index += 1) {
    if (target.includes(source.slice(index, index + size))) return true
  }
  return false
}

/**
 * 逐字重合的覆盖长度：把回复里所有撞上的片段向左右延伸到最长，合并区间后
 * 统计总字数。用它代替"只要撞上一段就算"，才能让长块的门槛可伸缩。
 *
 * 代价是 O(块长 + 回复长) 建一次 seed 索引——只在固定门槛没过时才走这条路，
 * 正常情况下压根不会调用。
 */
export function verbatimCoverage(reply, text, seed = 12) {
  const source = String(reply ?? '')
  const target = String(text ?? '')
  const size = Math.max(4, Number(seed) || 12)
  if (source.length < size || target.length < size) return 0

  const index = new Map()
  for (let position = 0; position + size <= target.length; position += 1) {
    const gram = target.slice(position, position + size)
    if (!index.has(gram)) index.set(gram, position)
  }

  const spans = []
  for (let start = 0; start + size <= source.length; start += 1) {
    const anchor = index.get(source.slice(start, start + size))
    if (anchor === undefined) continue
    let end = start + size
    let cursor = anchor + size
    while (end < source.length && cursor < target.length && source[end] === target[cursor]) {
      end += 1
      cursor += 1
    }
    let head = start
    let back = anchor
    while (head > 0 && back > 0 && source[head - 1] === target[back - 1]) {
      head -= 1
      back -= 1
    }
    spans.push([head, end])
  }
  if (spans.length === 0) return 0

  spans.sort((left, right) => left[0] - right[0])
  let covered = 0
  let openStart = spans[0][0]
  let openEnd = spans[0][1]
  for (const [start, end] of spans.slice(1)) {
    if (start <= openEnd) {
      if (end > openEnd) openEnd = end
      continue
    }
    covered += openEnd - openStart
    openStart = start
    openEnd = end
  }
  return covered + (openEnd - openStart)
}

/**
 * 块长归一后的逐字门槛。
 *
 * 缩放用 sqrt 而不是线性：撞上的机会随块长增长，但增长得很慢（随机文本里
 * 最长重合近似 log 长度）。sqrt 落在两者中间——400 字以内不动，
 * 1300 字要 22，3000 字要 33，8000 字要 54，上限 96 兜底。
 */
export function verbatimNeeded(blockLength, base = 12, normalize = true) {
  const floor = Math.max(4, Number(base) || 12)
  if (normalize !== true) return floor
  const length = Math.max(0, Number(blockLength) || 0)
  const scale = Math.sqrt(Math.max(1, length / 400))
  return Math.min(96, Math.max(floor, Math.round(floor * scale)))
}

function grams(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  const chars = [...normalized]
  for (let index = 0; index < chars.length - 1; index += 1) set.add(chars[index] + chars[index + 1])
  return set
}

/** 两段文字共享多少个二连字。 */
export function sharedGrams(left, right) {
  const mine = grams(left)
  const pool = grams(right)
  if (mine.size === 0 || pool.size === 0) return 0
  let hit = 0
  for (const gram of mine) if (pool.has(gram)) hit += 1
  return hit
}

/** 回复有多大比例的二连字能在这一块里找到。 */
export function replyOverlap(reply, text) {
  const mine = grams(reply)
  if (mine.size === 0) return 0
  const pool = grams(text)
  let hit = 0
  for (const gram of mine) if (pool.has(gram)) hit += 1
  return hit / mine.size
}

/**
 * 语义补判：回复向量与块向量的余弦过线，且两边至少有 lexicalFloor 条共享
 * 二连字。返回按余弦降序的候选，由调用方决定认领几条。
 *
 * @param {object} input
 * @param {string} input.reply
 * @param {Array<{rowid:number,text:string}>} input.blocks 还没被认领的块
 * @param {Map<number,Float32Array>|Record<number,Float32Array>} input.vectors
 * @param {Float32Array|null} input.replyVector 回复的向量（归一化后）
 * @param {number} [input.threshold] 余弦门槛
 * @param {number} [input.lexicalFloor] 共享 bigram 条数下限
 * @returns {Array<{rowid:number,cosine:number}>}
 */
export function attributeSemantic(input) {
  const { reply = '', blocks = [], vectors, replyVector, threshold = 0.72, lexicalFloor = 6 } = input ?? {}
  if (!(replyVector instanceof Float32Array) || replyVector.length === 0) return []
  if (!Array.isArray(blocks) || blocks.length === 0) return []
  const get = vectors instanceof Map
    ? (rowid) => vectors.get(rowid)
    : (rowid) => (vectors === null || vectors === undefined ? undefined : vectors[rowid])

  const candidates = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const rowid = Number(block.rowid)
    const vector = get(rowid)
    if (!(vector instanceof Float32Array) || vector.length !== replyVector.length) continue
    if (sharedGrams(reply, block.text) < Math.max(1, Number(lexicalFloor) || 1)) continue
    candidates.push({ rowid, cosine: dot(replyVector, vector) })
  }
  return candidates
    .filter((entry) => entry.cosine >= Number(threshold))
    .sort((left, right) => right.cosine - left.cosine)
}

/**
 * 合并两批认领结果：字面判定优先，语义候选按余弦顺序补位，总数不超过 cap。
 * 单独拆出来是为了能离线测——避免把"认领哪几条"藏进异步的事件回调里。
 */
export function mergeUsed(input) {
  const { literal = [], semantic = [], cap = 3 } = input ?? {}
  const used = []
  for (const rowid of literal) {
    const id = Number(rowid)
    if (!used.includes(id)) used.push(id)
  }
  for (const entry of semantic) {
    if (used.length >= Math.max(1, Number(cap) || 3)) break
    const id = Number(entry?.rowid)
    if (!used.includes(id)) used.push(id)
  }
  return used
}

/**
 * 一批注入块里，哪些真的被引用了。
 * @param {string} reply 本轮回复正文
 * @param {Array<{rowid:number,text:string}>} blocks 注入过的块
 * @param {{window?:number,minRatio?:number,maxUsed?:number,normalizeWindow?:boolean}} options
 * @returns {{used:number[], verdicts:Array<{rowid:number,verbatim:boolean,coverage:number,ratio:number}>}}
 */
export function attributeReply(reply, blocks, options = {}) {
  const {
    window = 12,
    minRatio = 0.15,
    maxUsed = 3,
    normalizeWindow = true
  } = options
  const text = String(reply ?? '').trim()
  const verdicts = []
  if (text === '' || !Array.isArray(blocks) || blocks.length === 0) return { used: [], verdicts }

  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const body = String(block.text ?? '')
    let verbatim = sharesVerbatim(text, body, window)
    let coverage = verbatim ? Math.max(4, Number(window) || 12) : 0
    if (verbatim && normalizeWindow === true) {
      // 长块不能"撞上一段就算"：要量出总覆盖长度够不够（门槛随块长走）。
      // 只有真的撞上了才会走到这里，所以建索引的代价只落在会命中的块上。
      const needed = verbatimNeeded(body.length, window, true)
      if (needed > Math.max(4, Number(window) || 12)) {
        coverage = verbatimCoverage(text, body, window)
        verbatim = coverage >= needed
      }
    }
    const ratio = verbatim ? 1 : replyOverlap(text, body)
    verdicts.push({ rowid: Number(block.rowid), verbatim, coverage, ratio })
  }

  verdicts.sort((left, right) => Number(right.verbatim) - Number(left.verbatim) || right.ratio - left.ratio)
  const used = verdicts
    .filter((entry) => entry.verbatim || entry.ratio >= minRatio)
    .slice(0, Math.max(1, Number(maxUsed) || 3))
    .map((entry) => entry.rowid)
  return { used, verdicts }
}
