/**
 * dsh-memory-vector · Host 半侧
 *
 * 职责（P0）：
 *   1. 采集   —— 监听 session/event，把每轮「用户 + 助手」正文切成块；
 *   2. 向量化 —— 调当前生效的那套 embedding provider（可多套并存，随时切换）；
 *   3. 存储   —— node:sqlite：正文 + FTS5(中文二元组) + 归一化 float32 向量；
 *   4. 检索   —— memory_search 工具：关键词与向量 RRF 融合，带会话溯源；
 *   5. 设置   —— 同源 HTTP /api/memory-vector/*，给设置页读写。
 *
 * 不做的事：不改会话日志、不写新事件类型、不阻塞 agent 主链路
 * （向量化全异步；检索有超时，失败静默降级）。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { embedTexts, EmbedError } from './embed.js'
import {
  activeProvider,
  loadSettings,
  saveSettings,
  normalize,
  normalizeProviders,
  dshHome,
  memoryRoot,
  SCHEMA,
  GROUPS,
  PROVIDER_FIELDS
} from './settings.js'
import { MemoryStore } from './store.js'
import { rankCandidates, selectHits } from './retrieval.js'
import { collectBridge } from './bridge.js'
import { isDue, rankWeights, renderManagedBlock, resolveTarget, writeManaged } from './weights.js'

export const name = 'memory-vector'
export const inject = ['tools', 'webServer']

const API_PREFIX = '/api/memory-vector'
const RETRIEVAL_TIMEOUT_MS = 1500

/** 版本号只有 package.json 一个真源，免得设置页和包版本对不上。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 内容块 → 纯文本（只取 text，图片/工具引用不参与记忆）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 从会话事件里抠出正文；不是对话事件就返回 null。 */
export function eventText(event) {
  const type = event?.type
  const data = event?.data
  if (type === 'user/message') {
    // 运行时注入的上下文不是用户说的话，不该进记忆
    if (data?.source?.kind === 'runtime-context') return null
    if (data?.source?.kind === 'command-result') return null
    const text = textOfContent(data?.content)
    return text.trim() === '' ? null : { role: 'user', text }
  }
  if (type === 'assistant/message') {
    const text = textOfContent(data?.message?.content ?? data?.content)
    return text.trim() === '' ? null : { role: 'assistant', text }
  }
  return null
}

function cwdOf(session) {
  const fromHeader = session?.header?.cwd
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader
  const direct = session?.cwd
  return typeof direct === 'string' ? direct : ''
}

function excluded(cwd, list) {
  if (list === undefined || list.trim() === '') return false
  const fragments = list
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
  const haystack = cwd.toLowerCase()
  return fragments.some((fragment) => haystack.includes(fragment))
}

/** 段落安全切分：先按段，再按句子，最后硬切。 */
export function splitChunk(text, limit) {
  if (text.length <= limit) return [text]
  const out = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('。'), window.lastIndexOf('\n'))
    const at = cut > limit * 0.5 ? cut + 1 : limit
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at)
  }
  if (rest.trim() !== '') out.push(rest.trim())
  return out.filter((part) => part !== '')
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(payload)
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

export function apply(ctx, _config) {
  let settings = loadSettings()
  /** 已打开的索引句柄（惰性创建，维度/模型变更后重建）。 */
  let storePromise = null
  let storeDimension = 0
  let storeModel = ''

  const health = {
    lastEmbedAt: null,
    lastEmbedError: null,
    lastSearchAt: null,
    lastSearchMs: null,
    embeddedTokens: 0,
    ingestedChunks: 0,
    queued: 0,
    skipped: 0,
    injected: 0,
    lastInjectAt: null,
    lastInjectReason: null,
    bridgeChars: 0,
    bridgeSessions: [],
    bridgeFrozen: 0,
    weightsAt: null,
    weightsEntries: 0,
    weightsChanged: null
  }

  const turnBuffer = new Map()
  let queue = []
  let draining = false

  // ---- 凭证 ------------------------------------------------------------
  /** 按引用名解析密钥；引用名为空表示该服务不需要鉴权（本地 llama.cpp / ollama 等）。 */
  async function resolveKey(ref) {
    if (typeof ref !== 'string' || ref.trim() === '') return { key: '', source: 'none' }
    try {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        const resolved = await credentials.resolve(ref)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') {
          return { key: resolved.value, source: resolved.source ?? 'credentials' }
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`memory-vector: 读取凭证失败 ${error?.message ?? error}`)
    }
    const fromEnv = process.env[ref]
    if (typeof fromEnv === 'string' && fromEnv !== '') return { key: fromEnv, source: 'env' }
    return { key: '', source: 'none' }
  }

  /** 当前生效的向量化模型。 */
  function provider() {
    return activeProvider(settings)
  }

  // ---- 索引 ------------------------------------------------------------
  function indexPath() {
    return join(memoryRoot(), 'index.sqlite')
  }

  async function getStore() {
    const current = provider()
    if (storePromise !== null && storeDimension === current.dimensions && storeModel === current.model) {
      return storePromise
    }
    if (storePromise !== null) {
      const previous = storePromise
      storePromise = null
      previous.then((store) => store.close()).catch(() => {})
    }
    storeDimension = current.dimensions
    storeModel = current.model
    storePromise = MemoryStore.open(indexPath(), { dimension: storeDimension, model: storeModel })
    return storePromise
  }

  // ---- 采集 ------------------------------------------------------------
  function bufferedTurn(sessionId) {
    let buffer = turnBuffer.get(sessionId)
    if (buffer === undefined) {
      buffer = { user: [], assistant: [], cwd: '', seq: 0 }
      turnBuffer.set(sessionId, buffer)
    }
    return buffer
  }

  function enqueue(job) {
    queue.push(job)
    health.queued = queue.length
    void drain()
  }

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const job = queue.shift()
        health.queued = queue.length
        try {
          await ingestJob(job)
        } catch (error) {
          health.skipped += 1
          ctx.logger?.warn?.(`memory-vector: 采集失败 ${error?.message ?? error}`)
        }
      }
    } finally {
      draining = false
    }
  }

  async function ingestJob(job) {
    const store = await getStore()
    const current = provider()
    const { key } = await resolveKey(current.apiKeyRef)
    if (current.apiKeyRef !== '' && key === '') {
      throw new Error(`向量化模型「${current.label}」的凭证未配置：${current.apiKeyRef}`)
    }
    const parts = splitChunk(job.text, settings.maxChunkChars)
    for (let index = 0; index < parts.length; index += 1) {
      const text = parts[index]
      if (text.length < settings.minTurnChars) {
        health.skipped += 1
        continue
      }
      const { vectors, dimension, usage } = await embedTexts([text], {
        baseUrl: current.baseUrl,
        apiKey: key,
        model: current.model,
        dimensions: current.dimensions,
        timeoutMs: current.timeoutMs
      })
      const added = store.addChunk({
        id: randomUUID(),
        sessionId: job.sessionId,
        cwd: job.cwd,
        seq: job.seq,
        turn: job.turn,
        text,
        vector: vectors[0],
        dim: dimension,
        model: current.model,
        createdAt: Date.now()
      })
      health.embeddedTokens += usage.totalTokens
      health.lastEmbedAt = new Date().toISOString()
      health.lastEmbedError = null
      if (added) health.ingestedChunks += 1
      else health.skipped += 1
      store.setMeta('dimension', String(dimension))
      store.setMeta('model', settings.model)
    }
  }

  const disposeEvent = ctx.on('session/event', (session, event) => {
    try {
      if (!settings.ingestEnabled) return
      const extracted = eventText(event)
      if (extracted !== null) {
        const buffer = bufferedTurn(session.id)
        buffer.cwd = cwdOf(session) || buffer.cwd
        buffer.seq = Number(event.seq ?? buffer.seq) || buffer.seq
        if (extracted.role === 'user') buffer.user.push(extracted.text)
        else buffer.assistant.push(extracted.text)
        return
      }
      if (event?.type !== 'turn/end') return

      const buffer = turnBuffer.get(session.id)
      if (buffer === undefined) return
      turnBuffer.delete(session.id)
      const text = [...buffer.user, ...buffer.assistant].join('\n\n').trim()
      buffer.user = []
      buffer.assistant = []
      if (text === '') return
      if (excluded(buffer.cwd, settings.excludeWorkspaces)) {
        health.skipped += 1
        return
      }
      enqueue({
        sessionId: String(session.id),
        cwd: buffer.cwd,
        seq: buffer.seq,
        turn: Number(event.data?.turn ?? 0) || 0,
        text
      })
    } catch (error) {
      ctx.logger?.warn?.(`memory-vector: 事件处理失败 ${error?.message ?? error}`)
    }
  })

  // ---- 检索 ------------------------------------------------------------
  async function search(query, options = {}) {
    const started = Date.now()
    const topK = Math.min(20, Math.max(1, Number(options.topK ?? settings.topK) || settings.topK))
    const store = await getStore()
    const current = provider()
    const { key } = await resolveKey(current.apiKeyRef)
    const stats = store.stats()
    if (stats.chunks === 0) return { hits: [], reason: 'empty', tookMs: Date.now() - started }

    let queryVector = null
    let embedFailed = null
    if (current.apiKeyRef !== '' && key === '') {
      embedFailed = `向量化模型「${current.label}」的凭证未配置：${current.apiKeyRef}`
    } else {
      try {
        const embedded = await embedTexts([query], {
          baseUrl: current.baseUrl,
          apiKey: key,
          model: current.model,
          dimensions: current.dimensions,
          timeoutMs: Math.min(current.timeoutMs, RETRIEVAL_TIMEOUT_MS)
        })
        queryVector = embedded.vectors[0]
      } catch (error) {
        embedFailed = error instanceof EmbedError ? error.message : String(error)
      }
    }

    const ordered = rankCandidates({
      store,
      query,
      queryVector,
      hybrid: settings.hybrid
    })

    if (ordered.length === 0) {
      health.lastSearchAt = new Date().toISOString()
      health.lastSearchMs = Date.now() - started
      return { hits: [], reason: embedFailed === null ? 'no-candidate' : 'embed-failed', error: embedFailed, tookMs: Date.now() - started }
    }

    const hits = selectHits({
      store,
      ordered,
      topK,
      minScore: settings.minScore,
      maxHitsPerSession: settings.maxHitsPerSession,
      contextChars: Math.min(settings.contextChars, Number(options.chars ?? settings.contextChars) || settings.contextChars)
    })

    health.lastSearchAt = new Date().toISOString()
    health.lastSearchMs = Date.now() - started
    // 被用到的块记一次命中：L2 权重的原始素材，也是"这条记忆有没有用"的唯一证据
    if (hits.length > 0) {
      try {
        store.bumpHits(hits.map((hit) => hit.rowid))
      } catch (error) {
        ctx.logger?.warn?.(`memory-vector: 命中计数失败 ${error?.message ?? error}`)
      }
    }
    return { hits, reason: hits.length === 0 ? 'filtered' : 'ok', error: embedFailed, tookMs: Date.now() - started }
  }

  function formatHits(hits) {
    const lines = []
    hits.forEach((hit, index) => {
      const where = hit.cwd === '' ? '' : ` · ${hit.cwd}`
      lines.push(`[${index + 1}] session ${hit.sessionId}#${hit.seq}${where}`)
      lines.push(hit.text.trim())
      if (index < hits.length - 1) lines.push('')
    })
    return lines.join('\n')
  }

  // ---- 工具 ------------------------------------------------------------
  const disposeTool = ctx.tools.register({
    name: 'memory_search',
    description:
      'Search your own long-term memory (past sessions) by meaning, not just keywords. ' +
      'Returns matching memory blocks with their session id and sequence so you can read the original with session_event_read.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to remember, in natural language.' },
        k: { type: 'integer', description: 'How many blocks to return. Defaults to the configured top-k.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
    },
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (query === '') return 'memory_search: query is empty'
      const result = await search(query, { topK: args?.k })
      if (result.hits.length === 0) {
        if (result.reason === 'empty') return 'memory_search: the memory index is empty (no turns captured yet).'
        if (result.error !== null && result.error !== undefined) return `memory_search: retrieval unavailable (${result.error}); no results.`
        return 'memory_search: nothing relevant found.'
      }
      const footer = `\n\nretrieved ${result.hits.length} block(s) in ${result.tookMs}ms`
      return formatHits(result.hits) + footer
    }
  })

  // ---- 每轮自动回想（P1）-----------------------------------------------
  /**
   * 只在每轮第一个步骤做一次，命中就插在用户这句话后面。
   * 注入的消息带自己的 source.kind，既不会污染原文库（采集时按 kind 过滤），
   * 也方便日后回溯"这条记忆是哪次注入的"。
   */
  const lastInjection = new Map()

  /** 取本步真正的用户输入（跳过各种注入消息）。 */
  function lastUserText(messages) {
    if (!Array.isArray(messages)) return ''
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user') continue
      if (message?.source?.kind !== 'user') continue
      const text = textOfContent(message.content).trim()
      if (text !== '') return text
    }
    return ''
  }

  function memoryMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'memory-vector',
        form: 'snapshot',
        sections: [{ name: 'memory-vector', text }]
      }
    }
  }

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      try {
        if (decision?.kind !== 'enter') return decision
        if (settings.injectEnabled !== true) return decision
        if (Number(payload?.step ?? 0) !== 1) return decision
        if (payload?.signal?.aborted) return decision

        const sessionId = String(payload?.agent?.session?.id ?? '')
        if (sessionId === '') return decision

        const query = lastUserText(payload.messages)
        if (query === '') return decision

        const result = await search(query, { topK: settings.topK, chars: settings.injectChars })
        if (result.hits.length === 0) {
          health.lastInjectReason = result.reason === 'empty' ? 'empty' : 'no-hit'
          return decision
        }

        const key = `${result.hits.map((hit) => `${hit.sessionId}#${hit.seq}`).join(',')}`
        const previous = lastInjection.get(sessionId)
        const turn = Number(payload.turn)
        // 同一轮内当然不重复；跨轮同内容也不重复——它已经躺在历史里了。
        // 隔了 40 轮再遇到同样的内容才允许重注入（多半是压缩把它挤掉了）。
        if (previous !== undefined && previous.key === key && turn - previous.turn < 40) {
          return decision
        }
        lastInjection.set(sessionId, { turn, key })

        const body = formatHits(result.hits)
        const text = `【记忆·自动回想】以下是从过去对话里检索到的相关片段（第 ${Number(payload.turn)} 轮，${result.tookMs}ms）。可能与当前问题无关，只在你确实需要旧信息时参考；需要看原文就按 sessionId#seq 去读。\n\n${body}`
        health.lastInjectAt = new Date().toISOString()
        health.injected += 1
        health.lastInjectReason = 'ok'
        return { ...decision, messages: [...decision.messages, memoryMessage(text)] }
      } catch (error) {
        health.lastInjectReason = 'error'
        ctx.logger?.warn?.(`memory-vector: 自动回想失败 ${error?.message ?? error}`)
        return decision
      }
    },
    { prepend: false }
  )

  // ---- L1 跨会话桥接（P2）----------------------------------------------
  /**
   * 桥接内容每次请求都随系统提示付出 token，所以：
   *   1. 每个工作区只算一次，缓存起来；
   *   2. 每个会话在第一次装配时"冻结"住，此后恒等 —— 前缀缓存不会中途失效；
   *   3. 万一缓存里恰好包含当前会话自己（同一工作区两场并行），宁可不注入。
   */
  const bridgeCache = new Map()
  const bridgeBySession = new Map()

  async function refreshBridge(cwd) {
    if (settings.bridgeEnabled !== true) return
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') return
    try {
      const { text, sessions } = await collectBridge({
        sessionQuery,
        cwd,
        currentSessionId: '',
        scope: settings.bridgeScope,
        days: settings.bridgeDays,
        maxMessages: settings.bridgeMessages,
        budget: settings.bridgeChars
      })
      bridgeCache.set(cwd, { text, sessions })
      health.bridgeChars = text.length
      health.bridgeSessions = sessions
    } catch (error) {
      ctx.logger?.warn?.(`memory-vector: 桥接采集失败 ${error?.message ?? error}`)
    }
  }

  /** 启动时把最近几个工作区热起来，第一个新会话才来得及。 */
  async function warmBridges(limit = 3) {
    if (settings.bridgeEnabled !== true) return
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') return
    let records
    try {
      records = await sessionQuery.listSessions()
    } catch {
      return
    }
    if (!Array.isArray(records)) return
    const seen = new Set()
    for (const record of records) {
      const header = record?.header ?? {}
      if (header.origin === 'subagent') continue
      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      if (seen.has(cwd)) continue
      seen.add(cwd)
      await refreshBridge(cwd)
      if (seen.size >= limit) break
    }
  }

  let disposeBridge = () => {}
  {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && typeof systemPrompt.context === 'function') {
      try {
        disposeBridge = systemPrompt.context({
          name: 'memory-vector:bridge',
          // 排在人格（260）之后：先"你是谁"，再"之前聊过什么"。
          order: 270,
          text: (context) => {
            if (settings.bridgeEnabled !== true) return ''
            const session = context?.agent?.session
            const id = String(session?.id ?? '')
            if (id === '') return ''
            const frozen = bridgeBySession.get(id)
            if (frozen !== undefined) return frozen
            const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
            const entry = bridgeCache.get(cwd)
            if (entry === undefined || entry.sessions.includes(id)) return ''
            if (entry.text === '') return ''
            // 冻结：这个会话从此刻起内容恒定，前缀缓存不再被这段改动打断。
            bridgeBySession.set(id, entry.text)
            health.bridgeFrozen += 1
            return entry.text
          }
        })
      } catch (error) {
        ctx.logger?.warn?.(`memory-vector: 桥接注册失败 ${error?.message ?? error}`)
      }
    }
  }

  const disposeBridgeWarm = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    if (settings.bridgeEnabled !== true) return
    const cwd = cwdOf(session)
    if (cwd === '') return
    void refreshBridge(cwd)
  })

  void warmBridges()

  // ---- L2 长期权重（P3）------------------------------------------------
  /**
   * 快照只写进 AGENT.md 里 <!-- managed:memory-weights --> 之间的那一块，
   * 之外的内容（也就是用户自己写的全部）一个字都不动。
   */
  async function refreshWeights(options = {}) {
    if (settings.weightsEnabled !== true && options.force !== true) {
      return { ok: false, reason: 'disabled' }
    }
    const store = await getStore()
    const now = Date.now()
    const rows = store.hitCandidates(400)
    if (rows.length === 0 && options.force !== true) {
      return { ok: false, reason: 'no-data' }
    }
    const entries = rankWeights(rows, {
      now,
      halfLifeDays: settings.halfLifeDays,
      limit: settings.maxEntries
    })
    const block = renderManagedBlock(entries, { now, halfLifeDays: settings.halfLifeDays, zh: true })
    const target = resolveTarget(dshHome(), settings.weightsTarget)
    let written
    try {
      written = writeManaged(target, block)
    } catch (error) {
      ctx.logger?.warn?.(`memory-vector: 写权重快照失败 ${error?.message ?? error}`)
      return { ok: false, reason: 'write-failed', error: String(error?.message ?? error) }
    }
    store.setMeta('weightsLastAt', String(now))
    if (Number.isFinite(Number(options.turn))) store.setMeta('weightsLastTurn', String(Number(options.turn)))
    store.setMeta('weightsPreview', block.slice(0, 4000))
    store.setMeta('weightsEntries', String(entries.length))
    health.weightsAt = new Date(now).toISOString()
    health.weightsEntries = entries.length
    health.weightsChanged = written.changed
    return { ok: true, changed: written.changed, entries: entries.length, path: written.path, at: now }
  }

  /** 每轮结束时看一眼：该重写就重写（节奏由设置决定，默认一天一次）。 */
  async function maybeRefreshWeights(turn) {
    if (settings.weightsEnabled !== true) return
    const store = await getStore()
    const lastAt = Number(store.getMeta('weightsLastAt') ?? 0)
    const lastTurnRaw = store.getMeta('weightsLastTurn')
    const due = isDue({
      mode: settings.weightsRefreshMode,
      hours: settings.weightsRefreshHours,
      turns: settings.refreshTurns,
      lastAt,
      lastTurn: lastTurnRaw === undefined ? null : Number(lastTurnRaw),
      turn,
      now: Date.now()
    })
    if (!due) return
    await refreshWeights({ turn })
  }

  const disposeWeightsTick = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    if (settings.weightsEnabled !== true) return
    void maybeRefreshWeights(Number(event.data?.turn ?? 0)).catch((error) => {
      ctx.logger?.warn?.(`memory-vector: 权重刷新失败 ${error?.message ?? error}`)
    })
  })

  async function weightsPayload() {
    const store = await getStore()
    return {
      enabled: settings.weightsEnabled === true,
      mode: settings.weightsRefreshMode,
      hours: settings.weightsRefreshHours,
      turns: settings.refreshTurns,
      halfLifeDays: settings.halfLifeDays,
      maxEntries: settings.maxEntries,
      target: resolveTarget(dshHome(), settings.weightsTarget),
      lastAt: Number(store.getMeta('weightsLastAt') ?? 0),
      lastTurn: store.getMeta('weightsLastTurn') ?? null,
      entries: Number(store.getMeta('weightsEntries') ?? 0),
      preview: store.getMeta('weightsPreview') ?? ''
    }
  }

  // ---- 同源 API --------------------------------------------------------
  async function statePayload() {
    let stats = null
    let storeError = null
    try {
      stats = (await getStore()).stats()
    } catch (error) {
      storeError = String(error?.message ?? error)
    }
    const current = provider()
    const key = await resolveKey(current.apiKeyRef)
    return {
      settings,
      schema: SCHEMA,
      groups: GROUPS,
      providerFields: PROVIDER_FIELDS,
      active: {
        id: current.id,
        label: current.label,
        model: current.model,
        dimensions: current.dimensions,
        baseUrl: current.baseUrl
      },
      stats,
      storeError,
      health: { ...health, queued: queue.length },
      credentials: {
        configured: current.apiKeyRef === '' || key.key !== '',
        source: current.apiKeyRef === '' ? 'none' : key.source,
        ref: current.apiKeyRef
      },
      paths: { home: dshHome(), memoryRoot: memoryRoot(), index: indexPath() },
      weights: await weightsPayload(),
      version: VERSION
    }
  }

  /** 用任意一套（可能是设置页里还没保存的）provider 打一次探针。 */
  async function probeProvider(candidate) {
    const started = Date.now()
    const key = await resolveKey(candidate.apiKeyRef)
    if (candidate.apiKeyRef !== '' && key.key === '') {
      return { ok: false, error: `凭证未配置：${candidate.apiKeyRef}`, tookMs: Date.now() - started }
    }
    try {
      const embedded = await embedTexts(['记忆探针 ping'], {
        baseUrl: candidate.baseUrl,
        apiKey: key.key,
        model: candidate.model,
        dimensions: candidate.dimensions,
        timeoutMs: Math.min(Number(candidate.timeoutMs) || 8000, 15000)
      })
      return {
        ok: true,
        dimension: embedded.dimension,
        expected: candidate.dimensions,
        tokens: embedded.usage.totalTokens,
        tookMs: Date.now() - started
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), tookMs: Date.now() - started }
    }
  }

  const disposeApi = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      try {
        if (route === '/state' && req.method === 'GET') {
          return sendJson(res, 200, await statePayload())
        }
        if (route === '/settings' && req.method === 'POST') {
          const body = await readBody(req)
          const patch = body?.settings ?? body ?? {}
          settings = saveSettings(normalize({ ...settings, ...patch }))
          bridgeBySession.clear()
          void warmBridges()
          return sendJson(res, 200, await statePayload())
        }
        if (route === '/search' && req.method === 'POST') {
          const body = await readBody(req)
          const query = String(body?.query ?? '').trim()
          if (query === '') return sendJson(res, 400, { error: 'query 不能为空' })
          const result = await search(query, { topK: body?.k })
          return sendJson(res, 200, result)
        }
        if (route === '/probe' && req.method === 'POST') {
          const body = await readBody(req)
          // 允许直接带上未保存的 provider 配置来试连；不带就用当前生效的
          const candidate = body?.provider !== null && typeof body?.provider === 'object'
            ? normalizeProviders([{ ...provider(), ...body.provider }])[0]
            : provider()
          return sendJson(res, 200, await probeProvider(candidate))
        }
        if (route === '/weights' && req.method === 'GET') {
          return sendJson(res, 200, await weightsPayload())
        }
        if (route === '/weights' && req.method === 'POST') {
          const result = await refreshWeights({ force: true })
          return sendJson(res, 200, { result, weights: await weightsPayload() })
        }
        if (route === '/clear' && req.method === 'POST') {
          const body = await readBody(req)
          if (body?.confirm !== true) return sendJson(res, 400, { error: '需要 confirm: true' })
          const store = await getStore()
          store.clear()
          health.ingestedChunks = 0
          return sendJson(res, 200, await statePayload())
        }
        return sendJson(res, 404, { error: `unknown route ${route}` })
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }
  })

  ctx.effect(() => () => {
    turnBuffer.clear()
    lastInjection.clear()
    bridgeBySession.clear()
    bridgeCache.clear()
    queue = []
    const pending = storePromise
    storePromise = null
    if (pending !== null) pending.then((store) => store.close()).catch(() => {})
  })

  void disposeEvent
  void disposeTool
  void disposeApi
  void disposePreStep
  void disposeBridgeWarm
  void disposeBridge
  void disposeWeightsTick
}
