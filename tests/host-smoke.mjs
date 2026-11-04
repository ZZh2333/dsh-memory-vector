/**
 * Host 侧集成冒烟：用假 ctx 直接跑 apply() 与同源 API。
 * 不碰真实 DSH_HOME（临时目录），不写真实设置。
 *   $env:ARK_CODE_LATEST_API_KEY='...'; node tests/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dmv-home-'))
process.env.DSH_HOME = HOME

const { apply, inject, name } = await import('../lib/index.js')

assert.equal(name, 'memory-vector')
assert.deepEqual(inject, ['tools', 'webServer'])

let handler = null
const tools = []
const disposers = []
const handlers = new Map()
const promptContexts = []
const fakeSessions = [{ header: { id: 'prev-0001', cwd: 'D:\\projects\\old', createdAt: Date.now() - 60000 } }]
const sessionQuery = {
  async listSessions() {
    return fakeSessions
  },
  async readSurface(id) {
    return {
      events: [
        {
          type: 'user/message',
          seq: 1,
          time: Date.now() - 50000,
          data: { content: [{ type: 'text', text: '上一场说的：把索引改成分片' }], source: { kind: 'user' } }
        },
        {
          type: 'assistant/message',
          seq: 2,
          time: Date.now() - 49000,
          data: { message: { content: [{ type: 'text', text: `好，${id} 已经改完。` }] } }
        }
      ]
    }
  }
}
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  on(event, fn) {
    handlers.set(event, fn)
    return () => {}
  },
  effect(fn) {
    const dispose = fn()
    disposers.push(() => {
      if (typeof dispose === 'function') dispose()
    })
    return () => {}
  },
  get(service) {
    if (service === 'credentials') {
      return {
        async resolve(ref) {
          const value = process.env[ref]
          return typeof value === 'string' && value !== '' ? { value, source: 'env' } : undefined
        }
      }
    }
    if (service === 'sessionQuery') return sessionQuery
    if (service === 'systemPrompt') {
      return {
        context(spec) {
          promptContexts.push(spec)
          return () => {}
        },
        section() {
          return () => {}
        },
        getContextOrder() {
          return 0
        }
      }
    }
    return undefined
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    }
  },
  webServer: {
    register(route) {
      handler = route.handler
      assert.equal(route.kind, 'prefix')
      assert.equal(route.path, '/api/memory-vector')
      return () => {}
    }
  }
}

apply(ctx, {})
assert.ok(handler !== null, 'webServer 路由没注册')
assert.equal(tools.length, 1)
assert.equal(tools[0].name, 'memory_search')
assert.equal(typeof tools[0].output.render, 'function')
assert.ok(handlers.has('agent/pre-step'), 'pre-step 钩子没注册')
assert.ok(promptContexts.some((spec) => spec.name === 'memory-vector:bridge'), '桥接上下文没注册')
assert.ok(handlers.has('session/event'), '采集钩子没注册')
console.log('ok · 插件装载（工具 + API 路由 + pre-step 钩子）')

/** 构造假 req/res，直接打 handler。 */
async function call(method, route, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: `/api/memory-vector${route}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    }
  }
  let captured = null
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      captured = { status: this.statusCode, body: JSON.parse(text) }
    }
  }
  await handler(req, res)
  return captured
}

const state = await call('GET', '/state')
assert.equal(state.status, 200)
assert.equal(state.body.settings.embeddingProviders.length, 1)
assert.equal(state.body.settings.embeddingActive, 'ark-plan')
assert.equal(state.body.active.dimensions, 1024)
assert.ok(Array.isArray(state.body.providerFields) && state.body.providerFields.length >= 7)
assert.ok(Array.isArray(state.body.groups))
console.log(`ok · /state（模型 ${state.body.active.id} · ${state.body.active.model} · ${state.body.active.dimensions}d）`)

const twoProviders = {
  ...state.body.settings,
  embeddingProviders: [
    state.body.settings.embeddingProviders[0],
    {
      id: 'ark-2k',
      label: '方舟 2048 维',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      apiKeyRef: 'ARK_CODE_LATEST_API_KEY',
      model: 'doubao-embedding-vision',
      dimensions: 2048,
      timeoutMs: 12000,
      batchSize: 4
    }
  ]
}
const saved = await call('POST', '/settings', { settings: twoProviders })
assert.equal(saved.status, 200)
assert.equal(saved.body.settings.embeddingProviders.length, 2)
assert.equal(saved.body.settings.embeddingActive, 'ark-plan')
assert.equal(JSON.parse(readFileSync(join(HOME, 'storages', 'memory-vector', 'settings.json'), 'utf8')).embeddingProviders.length, 2)
console.log('ok · /settings 保存两套模型并落盘')

const illegal = await call('POST', '/settings', {
  settings: { ...saved.body.settings, embeddingActive: 'ghost', topK: 999, minScore: -3 }
})
assert.equal(illegal.body.settings.embeddingActive, 'ark-plan', '未知 id 应回退到第一套')
assert.equal(illegal.body.settings.topK, 20)
assert.equal(illegal.body.settings.minScore, 0)
console.log('ok · /settings 收敛（未知指针对回退 + 越界钳制）')

const empty = await call('POST', '/search', { query: '随便问一句' })
assert.equal(empty.status, 200)
assert.equal(empty.body.reason, 'empty')
console.log('ok · /search 空索引优雅返回')

const refused = await call('POST', '/clear', {})
assert.equal(refused.status, 400)
console.log('ok · /clear 需要显式 confirm')

const key = process.env.ARK_CODE_LATEST_API_KEY
const hasKey = typeof key === 'string' && key !== ''

/* ---------- P1：每轮自动回想 ---------- */

const preStep = handlers.get('agent/pre-step')
const QUERY = 'doubao-embedding-vision 默认用多少维'

if (hasKey) {
  const { MemoryStore } = await import('../lib/store.js')
  const { embedTexts } = await import('../lib/embed.js')
  const active = state.body.active
  const { vectors } = await embedTexts([QUERY], {
    baseUrl: active.baseUrl,
    apiKey: key,
    model: active.model,
    dimensions: active.dimensions
  })

  const seedStore = await MemoryStore.open(join(HOME, 'storages', 'memory-vector', 'index.sqlite'), {
    dimension: active.dimensions,
    model: active.model
  })
  seedStore.addChunk({
    id: 'seed-1',
    sessionId: 'session-old',
    cwd: 'D:\\projects\\old',
    seq: 7,
    turn: 3,
    text: '我们定下来 doubao-embedding-vision 默认 1024 维，走方舟 Agent Plan。',
    vector: vectors[0],
    dim: active.dimensions,
    model: active.model
  })
  seedStore.close()
  console.log('ok · 种下一条历史记忆（向量与查询相同 → 余弦 1.0）')

  const turnInput = {
    agent: { session: { id: 'session-live' } },
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: QUERY }] }],
    turn: 1,
    step: 1,
    signal: { aborted: false }
  }
  const enter = async () => ({ kind: 'enter', messages: [] })

  const first = await preStep({ ...turnInput }, enter)
  assert.equal(first.kind, 'enter')
  assert.equal(first.messages.length, 1, '应注入一条记忆消息')
  const injected = first.messages[0]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, 'memory-vector')
  assert.equal(injected.source.form, 'snapshot')
  assert.match(injected.content[0].text, /【记忆·自动回想】/)
  assert.match(injected.content[0].text, /session-old#7/)
  console.log(`ok · pre-step 注入（${injected.content[0].text.length} 字，带 sessionId#seq 溯源）`)

  const again = await preStep({ ...turnInput }, enter)
  assert.equal(again.messages.length, 0, '同一轮重复调用不应重复注入')
  console.log('ok · 同一轮去重')

  const secondStep = await preStep({ ...turnInput, step: 2 }, enter)
  assert.equal(secondStep.messages.length, 0, '非首步不注入')
  console.log('ok · 只在每轮首步回想')

  const rejected = await preStep({ ...turnInput }, async () => ({ kind: 'reject' }))
  assert.deepEqual(rejected, { kind: 'reject' }, '被拒绝的步骤必须原样放行')
  console.log('ok · reject 决策原样透传')

  const noise = await preStep(
    {
      ...turnInput,
      turn: 2,
      messages: [{ role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: QUERY }] }]
    },
    enter
  )
  assert.equal(noise.messages.length, 0, '只有注入消息时不该回想')
  console.log('ok · 无真实用户输入时不回想')

  const off = await call('POST', '/settings', {
    settings: { ...saved.body.settings, injectEnabled: false }
  })
  assert.equal(off.body.settings.injectEnabled, false)
  const whileOff = await preStep({ ...turnInput, turn: 3 }, enter)
  assert.equal(whileOff.messages.length, 0, '关闭开关后不注入')
  await call('POST', '/settings', { settings: { ...off.body.settings, injectEnabled: true } })
  console.log('ok · 开关关闭时自动回想停止')

  const health = (await call('GET', '/state')).body.health
  assert.ok(health.injected >= 1)
  assert.equal(health.lastInjectReason, 'ok')
  console.log(`ok · health 记录注入（${health.injected} 次）`)
} else {
  console.log('skip · 没有 ARK_CODE_LATEST_API_KEY，跳过自动回想与探针')
}

/* ---------- P2：L1 跨会话桥接（不需要凭证） ---------- */

const bridgeSpec = promptContexts.find((spec) => spec.name === 'memory-vector:bridge')
const reader = { agent: { session: { id: 'reader-1', header: { cwd: 'D:\\projects\\old' } } } }

assert.equal(bridgeSpec.text(reader), '', '默认关闭时不注入')
console.log('ok · 桥接默认关闭')

const waitFor = async (check, timeoutMs = 4000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const enabled = await call('POST', '/settings', {
  settings: { ...(await call('GET', '/state')).body.settings, bridgeEnabled: true }
})
assert.equal(enabled.body.settings.bridgeEnabled, true)
assert.ok(await waitFor(() => bridgeSpec.text(reader) !== ''), '开启后应能读到上一场会话的尾巴')

const bridged = bridgeSpec.text(reader)
assert.match(bridged, /【前面聊过的】/)
assert.match(bridged, /上一场说的：把索引改成分片/)
assert.ok(bridged.length <= enabled.body.settings.bridgeChars + 200, `预算内：${bridged.length}`)
console.log(`ok · 桥接注入（${bridged.length} 字，来自 prev-0001）`)

// 冻结：同一会话第二次装配必须完全一致（否则前缀缓存会失效）
assert.equal(bridgeSpec.text(reader), bridged)
console.log('ok · 同一会话内容冻结（缓存安全）')

// 缓存里含自己 → 宁可不注入
const selfReader = { agent: { session: { id: 'prev-0001', header: { cwd: 'D:\\projects\\old' } } } }
assert.equal(bridgeSpec.text(selfReader), '', '不能把当前会话自己当"上一场"')
console.log('ok · 自身排除')

// 没有对应工作区的会话 → 空
const stranger = { agent: { session: { id: 'reader-2', header: { cwd: 'D:\\nowhere' } } } }
assert.equal(bridgeSpec.text(stranger), '')
console.log('ok · 无同工作区历史时静默')

const bridgeHealth = (await call('GET', '/state')).body.health
assert.ok(bridgeHealth.bridgeChars > 0)
assert.deepEqual(bridgeHealth.bridgeSessions, ['prev-0001'])
assert.equal(bridgeHealth.bridgeFrozen, 1)
console.log(`ok · health 记录桥接（${bridgeHealth.bridgeChars} 字 / 冻结 ${bridgeHealth.bridgeFrozen} 场）`)

if (hasKey) {
  const offline = await call('POST', '/probe', {
    provider: { ...state.body.settings.embeddingProviders[0], baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 1500 }
  })
  assert.equal(offline.body.ok, false)
  console.log(`ok · /probe 对不可达地址报错而不是抛：${String(offline.body.error).slice(0, 40)}`)

  const probe2k = await call('POST', '/probe', {
    provider: twoProviders.embeddingProviders[1]
  })
  assert.equal(probe2k.body.ok, true, probe2k.body.error)
  assert.equal(probe2k.body.dimension, 2048)
  console.log(`ok · /probe 未保存的第二套配置可用：${probe2k.body.dimension}d ${probe2k.body.tookMs}ms`)

  const probeActive = await call('POST', '/probe', {})
  assert.equal(probeActive.body.ok, true, probeActive.body.error)
  assert.equal(probeActive.body.dimension, 1024)
  console.log(`ok · /probe 不带参数走当前生效：${probeActive.body.dimension}d`)
}

// 模拟插件卸载：释放索引句柄，否则临时目录里的 sqlite 还占着句柄
disposers.forEach((dispose) => dispose())
await new Promise((resolve) => setTimeout(resolve, 100))
rmSync(HOME, { recursive: true, force: true })
assert.equal(existsSync(join(HOME, 'storages')), false)
console.log('\nHost 冒烟全部通过')
