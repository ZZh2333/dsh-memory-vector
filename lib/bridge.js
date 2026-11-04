/**
 * dsh-memory-vector · L1 跨会话桥接
 *
 * 目的：新会话开场不要"失忆"。把上一场对话的尾巴做成一段稳定的运行时上下文，
 * 挂在 systemPrompt 的固定位置。
 *
 * 为什么是 systemPrompt 而不是第一条用户消息：
 *   - 位置固定、内容在一个会话内恒定 → 前缀缓存不会反复失效；
 *   - 走 systemPrompt.context 注册，不写进消息列表，不占轮次、不触发新事件类型。
 *
 * 代价：每次请求都要付这段的固定 token。所以要预算（chars）和条数（messages）双限。
 */

/** 这些来源的消息不进桥接：压缩摘要、各插件注入、我们自己。 */
const SKIP_KINDS = new Set(['compact-checkpoint', 'runtime-context', 'memory-vector', 'system-prompt'])

/** 事件 → {role, text}；不是对话消息就返回 null。 */
export function messageOf(event) {
  if (event === null || typeof event !== 'object') return null
  if (event.type === 'user/message') {
    const data = event.data ?? {}
    const kind = data.source?.kind
    if (typeof kind === 'string' && SKIP_KINDS.has(kind)) return null
    if (kind !== 'user') return null
    return { role: 'user', text: contentText(data.content), seq: event.seq }
  }
  if (event.type === 'assistant/message') {
    const message = event.data?.message ?? {}
    return { role: 'assistant', text: contentText(message.content), seq: event.seq }
  }
  return null
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 压缩摘要正文里带标记的，整段丢掉。 */
function looksLikeCheckpoint(text) {
  return text.startsWith('<compacted-summary>') || text.includes('<compacted-summary>')
}

/**
 * 从一场会话的 surface 事件里取最后 N 条有效对话。
 * @returns {Array<{role:'user'|'assistant', text:string, seq:number|undefined}>}
 */
export function tailOf(events, limit) {
  if (!Array.isArray(events)) return []
  const picked = []
  for (const event of events) {
    const message = messageOf(event)
    if (message === null) continue
    if (message.text === '' || looksLikeCheckpoint(message.text)) continue
    picked.push(message)
  }
  return picked.slice(Math.max(0, picked.length - Math.max(1, limit)))
}

function clip(text, limit) {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(1, limit - 1))}…`
}

/**
 * 渲染桥接文本。会话按时间从旧到新排，最后一个才是"上一场"。
 * @param {object} input
 * @param {string} input.cwd
 * @param {Array<{id:string, createdAt:number, messages:Array}>} input.sessions
 * @param {number} input.budget 字符预算
 * @param {number} input.perMessage 单条上限
 * @param {boolean} input.zh
 */
export function renderBridge(input) {
  const { cwd, sessions, budget, perMessage = 400, zh = true } = input
  if (!Array.isArray(sessions) || sessions.length === 0) return ''

  const blocks = []
  let used = 0
  // 从最新的一场往回填，预算用完就停
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]
    const lines = []
    for (let cursor = session.messages.length - 1; cursor >= 0; cursor -= 1) {
      const message = session.messages[cursor]
      const line = `${message.role === 'user' ? (zh ? '用户' : 'user') : zh ? '助手' : 'assistant'}：${clip(message.text, perMessage)}`
      if (used + line.length > budget) break
      used += line.length
      lines.unshift(line)
    }
    if (lines.length === 0) continue
    const stamp = new Date(session.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    blocks.unshift({
      head: `${zh ? '会话' : 'session'} ${String(session.id).slice(0, 8)} · ${stamp}`,
      lines
    })
    if (used >= budget) break
  }
  if (blocks.length === 0) return ''

  const head = zh
    ? `【前面聊过的】${cwd === '' ? '' : cwd + '｜'}只作为背景线索：不要复述，不要假装当时参与过；与本轮无关就忽略。`
    : `[Earlier sessions]${cwd === '' ? '' : ' ' + cwd + ' |'} background only: do not recite, do not pretend you took part; ignore when irrelevant.`

  const body = blocks
    .map((block) => `— ${block.head}\n${block.lines.join('\n')}`)
    .join('\n\n')

  return `${head}\n\n${body}`
}

/**
 * 采集桥接内容：找到同工作区里"最近的其它会话"，取尾巴。
 *
 * @param {object} input
 * @param {object} input.sessionQuery 宿主服务（可空）
 * @param {string} input.cwd 当前工作区
 * @param {string} input.currentSessionId 排除自己
 * @param {'workspace-latest'|'recent-days'} input.scope
 * @param {number} input.days scope=recent-days 时的时间窗
 * @param {number} input.maxMessages 每条会话取的条数上限
 * @param {number} input.budget 字符预算
 * @returns {Promise<{text:string, sessions:string[]}>}
 */export async function collectBridge(input) {
  const { sessionQuery, cwd, currentSessionId, scope, days, maxMessages, budget } = input
  const empty = { text: '', sessions: [] }
  if (sessionQuery === undefined || sessionQuery === null) return empty

  let records
  try {
    records = await sessionQuery.listSessions()
  } catch {
    return empty
  }
  if (!Array.isArray(records)) return empty

  const since = Date.now() - Math.max(1, Number(days) || 7) * 86400000
  const candidates = records.filter((record) => {
    const header = record?.header ?? {}
    if (String(header.id) === String(currentSessionId)) return false
    if (header.origin === 'subagent') return false
    if (scope === 'recent-days') {
      // 仍然限定同工作区：把别的项目的对话塞进来只会是噪音
      return (header.cwd ?? '') === cwd && Number(header.createdAt ?? 0) >= since
    }
    // workspace-latest：同工作区，取最近一场
    return (header.cwd ?? '') === cwd
  })

  const limit = scope === 'recent-days' ? Math.min(3, Math.max(1, candidates.length)) : 1
  const chosen = candidates.slice(0, limit)
  if (chosen.length === 0) return empty

  const sessions = []
  for (const record of chosen) {
    const id = String(record.header.id)
    let surface
    try {
      surface = await sessionQuery.readSurface(record.header.id)
    } catch {
      continue
    }
    const messages = tailOf(surface?.events, maxMessages)
    if (messages.length === 0) continue
    sessions.push({ id, createdAt: Number(record.header.createdAt ?? Date.now()), messages })
  }
  if (sessions.length === 0) return empty

  sessions.sort((left, right) => left.createdAt - right.createdAt)
  const text = renderBridge({ cwd, sessions, budget })
  return { text, sessions: sessions.map((session) => session.id) }
}
