/**
 * dsh-memory-vector · 检索融合
 *
 * 关键词与向量各出一份候选，用 RRF（倒数排名融合）合并：
 *   score = Σ 1 / (K + rank)
 * 好处是不用把 bm25 分数和余弦分数校准到同一量纲——两把尺子各排各的，
 * 只在名次上达成一致。专有名词靠 FTS，语义模糊靠向量。
 */
import { dot } from './embed.js'

const RRF_K = 60

/**
 * 自动回想的节奏闸：注入过的那一轮之后，至少隔 N 轮再来一次。
 *
 * 为什么要有这道闸：注入进对话历史的内容，后面每一轮请求都会重发一次。
 * 每轮都塞，等于让这段文字在整个会话里被反复计费。而已经塞过的块本来就不会
 * 重复塞（同内容 40 轮内只注入一次），所以放宽间隔不会漏内容，只是少几次
 * "这一轮也想起来了"。
 *
 * @param {{turn:number, lastTurn?:number|null, everyTurns?:number}} input
 * @returns {boolean} 这一轮是否允许注入
 */
export function injectDue(input) {
  const turn = Number(input?.turn ?? 0)
  const gap = Math.max(1, Number(input?.everyTurns) || 1)
  const last = input?.lastTurn
  if (last === null || last === undefined) return true
  const lastTurn = Number(last)
  if (!Number.isFinite(lastTurn)) return true
  return turn - lastTurn >= gap
}

/**
 * 合并候选。
 * @param {object} input
 * @param {import('./store.js').MemoryStore} input.store
 * @param {string} input.query
 * @param {Float32Array|null} input.queryVector
 * @param {boolean} input.hybrid
 * @param {number} [input.limit] 每路候选上限
 * @returns {Array<{rowid:number,score:number,similarity:number|null,ftsRank:number|null,vecRank:number|null}>}
 */
export function rankCandidates(input) {
  const { store, query, queryVector, hybrid, limit = 50 } = input
  const ranked = new Map()
  const bump = (rowid, rank, kind) => {
    const entry = ranked.get(rowid) ?? { rowid, score: 0, similarity: null, ftsRank: null, vecRank: null }
    entry.score += 1 / (RRF_K + rank)
    if (kind === 'fts') entry.ftsRank = rank
    else entry.vecRank = rank
    ranked.set(rowid, entry)
  }

  if (hybrid) {
    for (const hit of store.searchFts(query, limit)) bump(hit.rowid, hit.rank, 'fts')
  }

  if (queryVector !== null && queryVector !== undefined) {
    const scored = []
    for (const row of store.iterateVectors(queryVector.length)) {
      scored.push({ rowid: row.rowid, similarity: dot(queryVector, row.vec) })
    }
    scored.sort((left, right) => right.similarity - left.similarity)
    scored.slice(0, limit).forEach((hit, index) => {
      bump(hit.rowid, index + 1, 'vec')
      const entry = ranked.get(hit.rowid)
      if (entry !== undefined) entry.similarity = hit.similarity
    })
  }

  return [...ranked.values()].sort((left, right) => right.score - left.score)
}

/**
 * 按相似度阈值、单会话配额、字符预算裁剪最终结果。
 * @param {object} input
 * @param {'global'|'workspace'|'workspace-first'} [input.scope] 工作区范围
 * @param {string} [input.cwd] 当前工作区
 * @returns {Array<object>}
 */
export function selectHits(input) {
  const { store, ordered, topK, minScore, maxHitsPerSession, contextChars, scope = 'global', cwd = '' } = input
  const rows = new Map(store.rowsByIds(ordered.map((entry) => entry.rowid)).map((row) => [row.rowid, row]))

  // workspace-first：本工作区的候选整体提前，组内保持原顺序（稳定排序）
  let sequence = ordered
  if (scope === 'workspace-first' && cwd !== '') {
    const locality = (entry) => (rows.get(entry.rowid)?.cwd === cwd ? 0 : 1)
    sequence = [...ordered].sort((left, right) => locality(left) - locality(right))
  }

  const perSession = new Map()
  const hits = []
  let budget = contextChars

  for (const entry of sequence) {
    if (hits.length >= topK) break
    const row = rows.get(entry.rowid)
    if (row === undefined) continue
    // workspace：别的项目一个字都不进
    if (scope === 'workspace' && cwd !== '' && row.cwd !== cwd) continue
    // 只有向量通路给了相似度；纯 FTS 命中没有余弦，不参与阈值判断
    if (entry.similarity !== null && entry.similarity < minScore) continue
    const count = perSession.get(row.sessionId) ?? 0
    if (count >= maxHitsPerSession) continue
    if (budget <= 0) break
    const text = row.text.length > budget ? row.text.slice(0, budget) : row.text
    if (text === '') continue
    budget -= text.length
    perSession.set(row.sessionId, count + 1)
    hits.push({
      ...row,
      text,
      score: entry.score,
      similarity: entry.similarity,
      ftsRank: entry.ftsRank,
      vecRank: entry.vecRank
    })
  }
  return hits
}
