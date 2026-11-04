/**
 * dsh-memory-vector · 历史回填
 *
 * 插件装上之前的会话没有进原文库，于是检索没有时间纵深、L2 权重也没有更早的锚点。
 * 这里做一件事：把历史会话按轮聚成块，走同一条采集管线补进去。
 *
 * 三条自律：
 *   1. 只读本机会话日志（sessionQuery），不再外发别的东西；但补进去的正文要过向量化，
 *      所以会花 token——必须先预览、由主人确认。
 *   2. 有上限：场次上限 + 块数上限，到量就停，不是无底洞。
 *   3. 幂等：处理过的会话记在 backfill_sessions 表里，重复点击不会重复花钱。
 */

/** 把一场会话的事件聚成「每轮一块」：同一轮的 user + assistant 拼一起，更像一段对话。 */
export function collectTurnChunks(events, options) {
  const { textOf, maxChars = 3000, minChars = 24 } = options
  const byTurn = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const extracted = textOf(event)
    if (extracted === null) continue
    const text = String(extracted.text ?? '').trim()
    if (text === '') continue
    const turn = Number(event.data?.turn ?? event.turn ?? 0)
    const key = Number.isFinite(turn) ? turn : -1
    const bucket = byTurn.get(key) ?? { turn: key, seq: Number(event.seq ?? 0), parts: [] }
    bucket.seq = Math.max(bucket.seq, Number(event.seq ?? 0))
    bucket.parts.push(`${extracted.role === 'user' ? '我' : '你'}：${text}`)
    byTurn.set(key, bucket)
  }
  const chunks = []
  for (const bucket of [...byTurn.values()].sort((left, right) => left.seq - right.seq)) {
    const text = bucket.parts.join('\n')
    if (text.length < minChars) continue
    chunks.push({ turn: bucket.turn, seq: bucket.seq, text: text.slice(0, maxChars) })
  }
  return chunks
}

/** 挑选要回填的会话：排除已处理的、子智能体会话；可选只取当前工作区。 */
export function pickSessions(sessions, options) {
  const { done = new Set(), cwd = '', onlyWorkspace = true, limit = 50 } = options
  const eligible = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session === null || typeof session !== 'object') continue
    const header = session.header ?? session
    const id = String(header.id ?? '')
    if (id === '' || done.has(id)) continue
    if (header.origin === 'subagent') continue
    const sessionCwd = String(header.cwd ?? '')
    if (onlyWorkspace && cwd !== '' && sessionCwd !== cwd) continue
    eligible.push({ id, cwd: sessionCwd, createdAt: Number(header.createdAt ?? 0) })
  }
  // 新的优先：越近的对话越可能被再用到
  eligible.sort((left, right) => right.createdAt - left.createdAt)
  return eligible.slice(0, Math.max(0, Number(limit) || 0))
}

/** 估算：字符数 / 1.6 ≈ token，用来在确认前给个数。 */
export function estimateTokens(chunks) {
  let chars = 0
  for (const chunk of chunks) chars += String(chunk.text ?? '').length
  return Math.round(chars / 1.6)
}
