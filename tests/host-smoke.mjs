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
const ctx = {
  logger: { warn() {}, info() {}, error() {} },
  on() {
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
    if (service !== 'credentials') return undefined
    return {
      async resolve(ref) {
        const value = process.env[ref]
        return typeof value === 'string' && value !== '' ? { value, source: 'env' } : undefined
      }
    }
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
console.log('ok · 插件装载（工具 + API 路由）')

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
if (key === undefined || key === '') {
  console.log('skip · 没有 ARK_CODE_LATEST_API_KEY，跳过探针')
} else {
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
