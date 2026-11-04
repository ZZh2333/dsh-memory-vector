/**
 * dsh-memory-vector · Host 半侧
 *
 * 职责（P0）：
 *   1. 采集   —— 监听 session/event，把每轮「用户 + 助手」正文切成块；
 *   2. 向量化 —— 调方舟 Agent Plan 的 /embeddings（doubao-embedding-vision）；
 *   3. 存储   —— node:sqlite：正文 + FTS5(中文二元组) + 归一化 float32 向量；
 *   4. 检索   —— memory_search 工具：关键词与向量 RRF 融合，带会话溯源；
 *   5. 设置   —— 同源 HTTP /api/memory-vector/*，给设置页读写。
 *
 * 不做的事：不改会话日志、不写新事件类型、不阻塞 agent 主链路
 * （向量化全异步；检索有超时，失败静默降级）。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { embedTexts, EmbedError } from './embed.js'
import { loadSettings, saveSettings, normalize, dshHome, memoryRoot, SCHEMA, GROUPS } from './settings.js'
import { MemoryStore } from './store.js'
import { rankCandidates, selectHits } from './retrieval.js'

export const name = 'memory-vector'
export const inject = ['tools', 'webServer']

const API_PREFIX = '/api/memory-vector'
const RETRIEVAL_TIMEOUT_MS = 1500

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
function eventText(event) {
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
function splitChunk(text, limit) {
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
    skipped: 0
  }

  const turnBuffer = new Map()
  let queue = []
  let draining = false

  // ---- 凭证 ------------------------------------------------------------
  async function resolveKey() {
    const ref = settings.apiKeyRef
    if (typeof ref !== 'string' || ref === '') return { key: '', source: 'none' }
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

  // ---- 索引 ------------------------------------------------------------
  function indexPath() {
    return join(memoryRoot(), 'index.sqlite')
  }

  async function getStore() {
    if (storePromise !== null && storeDimension === settings.dimensions && storeModel === settings.model) {
      return storePromise
    }
    if (storePromise !== null) {
      const previous = storePromise
      storePromise = null
      previous.then((store) => store.close()).catch(() => {})
    }
    storeDimension = settings.dimensions
    storeModel = settings.model
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
    const { key } = await resolveKey()
    const parts = splitChunk(job.text, settings.maxChunkChars)
    for (let index = 0; index < parts.length; index += 1) {
      const text = parts[index]
      if (text.length < settings.minTurnChars) {
        health.skipped += 1
        continue
      }
      const { vectors, dimension, usage } = await embedTexts([text], {
        baseUrl: settings.baseUrl,
        apiKey: key,
        model: settings.model,
        dimensions: settings.dimensions,
        timeoutMs: settings.timeoutMs
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
        model: settings.model,
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
    const { key } = await resolveKey()
    const stats = store.stats()
    if (stats.chunks === 0) return { hits: [], reason: 'empty', tookMs: Date.now() - started }

    let queryVector = null
    let embedFailed = null
    try {
      const embedded = await embedTexts([query], {
        baseUrl: settings.baseUrl,
        apiKey: key,
        model: settings.model,
        dimensions: settings.dimensions,
        timeoutMs: Math.min(settings.timeoutMs, RETRIEVAL_TIMEOUT_MS)
      })
      queryVector = embedded.vectors[0]
    } catch (error) {
      embedFailed = error instanceof EmbedError ? error.message : String(error)
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
      contextChars: settings.contextChars
    })

    health.lastSearchAt = new Date().toISOString()
    health.lastSearchMs = Date.now() - started
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

  // ---- 同源 API --------------------------------------------------------
  async function statePayload() {
    let stats = null
    let storeError = null
    try {
      stats = (await getStore()).stats()
    } catch (error) {
      storeError = String(error?.message ?? error)
    }
    const key = await resolveKey()
    return {
      settings,
      schema: SCHEMA,
      groups: GROUPS,
      stats,
      storeError,
      health: { ...health, queued: queue.length },
      credentials: { configured: key.key !== '', source: key.source, ref: settings.apiKeyRef },
      paths: { home: dshHome(), memoryRoot: memoryRoot(), index: indexPath() },
      version: '0.1.0'
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
          const key = await resolveKey()
          const started = Date.now()
          try {
            const embedded = await embedTexts(['记忆探针 ping'], {
              baseUrl: settings.baseUrl,
              apiKey: key.key,
              model: settings.model,
              dimensions: settings.dimensions,
              timeoutMs: Math.min(settings.timeoutMs, 10000)
            })
            return sendJson(res, 200, {
              ok: true,
              dimension: embedded.dimension,
              tokens: embedded.usage.totalTokens,
              tookMs: Date.now() - started
            })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: String(error?.message ?? error), tookMs: Date.now() - started })
          }
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
    queue = []
    const pending = storePromise
    storePromise = null
    if (pending !== null) pending.then((store) => store.close()).catch(() => {})
  })

  void disposeEvent
  void disposeTool
  void disposeApi
}
