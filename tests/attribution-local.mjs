/**
 * 归因端到端（离线）：假 embedding 服务 + 假 ctx，跑通
 *   入库 → 每轮回想注入 → 回复归因（字面 / 语义）→ 手动检索同口径
 *
 * 为什么要这个文件：单测只覆盖纯函数，"归因到底有没有被接上"必须跑一次真实链路。
 * 这里用一个本地 HTTP 服务冒充 OpenAI 兼容的 /embeddings，不花真钱、不碰真实 DSH_HOME。
 *
 *   node tests/attribution-local.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sharesVerbatim } from '../lib/attribution.js'

const HOME = mkdtempSync(join(tmpdir(), 'dmv-attr-'))
process.env.DSH_HOME = HOME
const WORK = join(HOME, 'workspace')
mkdirSync(WORK, { recursive: true })

/* ---------- 假向量化：字符二元组落 1024 个桶，同词的文本天然靠近 ---------- */

function embed(text) {
  const vector = new Array(1024).fill(0)
  const source = String(text ?? '')
  const chars = [...source]
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const gram = chars[index] + chars[index + 1]
    let hash = 2166136261
    for (const char of gram) {
      hash ^= char.codePointAt(0)
      hash = Math.imul(hash, 16777619)
    }
    vector[Math.abs(hash) % 1024] += 1
  }
  let sum = 0
  for (const value of vector) sum += value * value
  // 全零向量会让 store 当成无效块丢掉：退成一个确定性的假向量
  if (sum === 0) vector[0] = 1
  return vector
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    try {
      const payload = JSON.parse(body)
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input]
      const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data, usage: { prompt_tokens: 1, total_tokens: 1 } }))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

/* ---------- 落地设置：指向假服务，归因调成"只认逐字和语义" ---------- */

const settingsDir = join(HOME, 'storages', 'memory-vector')
mkdirSync(settingsDir, { recursive: true })
writeFileSync(
  join(settingsDir, 'settings.json'),
  JSON.stringify({
    ingestEnabled: true,
    minTurnChars: 10,
    topK: 3,
    minScore: 0,
    maxHitsPerSession: 1,
    contextChars: 1200,
    hybrid: true,
    retrievalScope: 'workspace',
    injectEnabled: true,
    injectChars: 1200,
    injectMinScore: 0,
    injectEveryTurns: 1,
    coldStartNotice: false,
    embeddingProviders: [
      {
        id: 'fake',
        label: 'fake',
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        apiKeyRef: '',
        model: 'fake-1024',
        dimensions: 1024,
        timeoutMs: 4000,
        batchSize: 8
      }
    ],
    embeddingActive: 'fake',
    bridgeEnabled: false,
    weightsEnabled: false,
    selfNoteEnabled: false,
    deliverablesEnabled: false,
    hitAttribution: 'referenced',
    // 重合率调到 1：把"整段复述"那条路关掉，逼开语义补判
    attributeThreshold: 1,
    attributeMaxUsed: 3,
    attributeLengthNormalize: true,
    semanticAttribution: true,
    attributeSemanticThreshold: 0.3
  }),
  'utf8'
)

const { apply } = await import('../lib/index.js')

/* ---------- 假 ctx（和 host-smoke 同一套形状，只留用得到的） ---------- */

const handlers = new Map()
let handler = null
const tools = []
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  on(event, fn) {
    const list = handlers.get(event) ?? []
    list.push(fn)
    handlers.set(event, list)
    return () => {}
  },
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  get(service) {
    if (service === 'credentials') return { async resolve() { return undefined } }
    if (service === 'sessionQuery') return { async listSessions() { return [] }, async readEvent() { throw new Error('none') }, async readSurface() { return { events: [] } } }
    if (service === 'systemPrompt') return { context() { return () => {} }, section() { return () => {} }, getContextOrder() { return 0 } }
    return undefined
  },
  tools: { register(definition) { tools.push(definition); return () => {} } },
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    }
  }
}

apply(ctx, {})

async function call(method, route, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: `/api/memory-vector${route}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    }
  }
  let captured = null
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) { captured = { status: this.statusCode, body: JSON.parse(text) } }
  }
  await handler(req, res)
  return captured
}

function emit(event, payload, session) {
  for (const listener of handlers.get(event) ?? []) listener(session, payload)
}

const SESSION = { id: 'session-attr', header: { id: 'session-attr', cwd: WORK } }
const preStep = (handlers.get('agent/pre-step') ?? [])[0]
const searchTool = tools.find((tool) => tool.name === 'memory_search')
const enter = async () => ({ kind: 'enter', messages: [] })

async function waitFor(check, label, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`等待超时：${label}`)
}

/* ---------- 1. 入库 ---------- */

const BLOCK = '索引按段落切成三千字一块，检索先走 FTS 再算余弦，命中会记下出处方便回溯，回填不补命中次数。'
emit('session/event', { type: 'user/message', seq: 1, time: Date.now() - 5000, data: { content: [{ type: 'text', text: '记忆库的切块和检索是怎么定的？' }], source: { kind: 'user' } } }, SESSION)
emit('session/event', { type: 'assistant/message', seq: 2, time: Date.now() - 4000, data: { message: { content: [{ type: 'text', text: BLOCK }] } } }, SESSION)
emit('session/event', { type: 'turn/end', seq: 3, time: Date.now() - 3000, data: { turn: 1 } }, SESSION)

await waitFor(async () => (await call('GET', '/state')).body.stats.chunks >= 1, '入库完成')
console.log(`ok · 入库（${(await call('GET', '/state')).body.stats.chunks} 块）`)

/* ---------- 1b. 插件注入的人设不该进库 ---------- */

const beforePersona = (await call('GET', '/state')).body.stats.chunks
emit(
  'session/event',
  {
    type: 'user/message',
    seq: 10,
    time: Date.now(),
    data: {
      content: [{ type: 'text', text: '［身份］你是「子非鱼」，称用户「主人」，自称「小鱼」。［她的人设］以下是她专属的设定……' }],
      source: { kind: 'user' }
    }
  },
  SESSION
)
emit('session/event', { type: 'turn/end', seq: 11, time: Date.now(), data: { turn: 9 } }, SESSION)
await new Promise((resolve) => setTimeout(resolve, 400))
const afterPersona = (await call('GET', '/state')).body.stats.chunks
assert.equal(afterPersona, beforePersona, '前缀黑名单里的文本不该入库')
console.log('ok · 前缀过滤（注入的人设没有进库）')

/* ---------- 2. 每轮回想：注入只记 injected ---------- */

const injected = await preStep(
  {
    turn: 2,
    step: 1,
    agent: { session: SESSION },
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '切块和检索是怎么定的？' }] }]
  },
  enter
)
const memoryText = injected.messages?.[0]?.content?.[0]?.text ?? ''
assert.match(memoryText, /【记忆·自动回想】/, `没注入：${memoryText.slice(0, 80)}`)
const afterInject = (await call('GET', '/state')).body.metrics.attribution
assert.ok(afterInject.injected >= 1, '注入要记 injected')
assert.equal(afterInject.used, 0, '还没回复，used 必须还是 0')
console.log(`ok · 注入只记 injected（injected=${afterInject.injected}, used=0）`)

/* ---------- 3. 转述式子回复：字面不沾，靠语义认领 ---------- */

const REPLY = '按段落切块这个思路可以；余弦那步接着 FTS，命中都带出处，回填也别补次数。'
assert.equal(sharesVerbatim(REPLY, BLOCK, 12), false, '这条回复故意不抄满 12 连字，才能测语义那条路')

emit('session/event', { type: 'assistant/message', seq: 4, time: Date.now(), data: { message: { content: [{ type: 'text', text: REPLY }] } } }, SESSION)
emit('session/event', { type: 'turn/end', seq: 5, time: Date.now(), data: { turn: 2 } }, SESSION)

await waitFor(async () => (await call('GET', '/state')).body.metrics.attribution.used >= 1, '语义归因落库')
const afterSemantic = (await call('GET', '/state')).body.metrics.attribution
console.log(`ok · 语义补判认领了转述（used=${afterSemantic.used}, 答疑率 ${afterSemantic.usedRatio}）`)

/* ---------- 4. 手动检索同口径：查了不等于用了 ---------- */

const before = (await call('GET', '/state')).body.metrics.attribution
const toolText = await searchTool.execute(
  { query: '切块检索怎么定的' },
  { agent: { session: { header: { id: 'session-attr', cwd: WORK } } } }
)
assert.match(toolText, /retrieved \d+ block/, `工具没返回结果：${toolText.slice(0, 120)}`)
const afterTool = (await call('GET', '/state')).body.metrics.attribution
assert.ok(afterTool.injected > before.injected, '手动检索也要记 injected')
assert.equal(afterTool.used, before.used, '查了还没回复，used 不能涨')

emit('session/event', { type: 'assistant/message', seq: 6, time: Date.now(), data: { message: { content: [{ type: 'text', text: '这件事先记着，晚点再说。' }] } } }, SESSION)
emit('session/event', { type: 'turn/end', seq: 7, time: Date.now(), data: { turn: 3 } }, SESSION)
await new Promise((resolve) => setTimeout(resolve, 300))
const afterIgnore = (await call('GET', '/state')).body.metrics.attribution
assert.equal(afterIgnore.used, afterTool.used, '回复没用到，就不该涨权重')
console.log(`ok · 手动检索同口径（injected=${afterIgnore.injected}, used 仍为 ${afterIgnore.used}）`)

console.log('\n归因端到端通过')
server.close()
try { rmSync(HOME, { recursive: true, force: true }) } catch { /* sqlite 句柄还占着就算了 */ }
