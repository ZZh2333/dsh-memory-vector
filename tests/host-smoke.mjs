/**
 * Host 侧集成冒烟：用假 ctx 直接跑 apply() 与同源 API。
 * 不碰真实 DSH_HOME（临时目录），不写真实设置。
 *   $env:ARK_CODE_LATEST_API_KEY='...'; node tests/host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const ANCHOR_TEXT = '索引改成分片，每片 3000 字，检索先查 FTS 再算余弦。'
const sessionQuery = {
  async listSessions() {
    return fakeSessions
  },
  async readEvent(request) {
    const seq = Number(request.seq)
    if (seq < 1 || seq > 2) throw new Error(`event not found: ${seq}`)
    return {
      target: {
        type: 'user/message',
        seq,
        time: Date.now() - 40000,
        data: { content: [{ type: 'text', text: ANCHOR_TEXT }], source: { kind: 'user' } }
      }
    }
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
    const list = handlers.get(event) ?? []
    list.push(fn)
    handlers.set(event, list)
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
assert.equal(tools.length, 3)
assert.equal(tools[0].name, 'memory_search')
assert.equal(tools[1].name, 'self_note_write')
assert.equal(tools[2].name, 'deliverable_search')
assert.equal(typeof tools[0].output.render, 'function')
assert.ok(handlers.has('agent/pre-step'), 'pre-step 钩子没注册')
assert.ok(promptContexts.some((spec) => spec.name === 'memory-vector:bridge'), '桥接上下文没注册')
assert.ok(promptContexts.some((spec) => spec.name === 'memory-vector:self-note'), '自述上下文没注册')
assert.ok(handlers.has('session/event'), '采集钩子没注册')
console.log('ok · 插件装载（工具 + API 路由 + pre-step 钩子）')

/* ---------- P4：L4 自我叙述（闸门 + 注入 + 待审） ---------- */

const noteTool = tools.find((tool) => tool.name === 'self_note_write')
assert.ok(noteTool !== undefined, 'self_note_write 没注册')

const noteFile = join(HOME, 'memory', 'self-note.md')

const offResult = await noteTool.execute({ kind: '教训', claim: ANCHOR_TEXT, anchors: ['prev-0001#2'] })
assert.match(offResult, /未开启/, offResult)
assert.equal(existsSync(noteFile), false, '关闭时不该创建文件')
console.log('ok · 自述默认关闭且不落盘')

await call('POST', '/settings', {
  settings: { ...(await call('GET', '/state')).body.settings, selfNoteEnabled: true }
})

const rejected = await noteTool.execute({ kind: '教训', claim: '我感到很开心，索引改成分片了。', anchors: ['prev-0001#2'] })
assert.match(rejected, /被拒/)
assert.match(rejected, /禁语/)

const badAnchor = await noteTool.execute({ kind: '教训', claim: '索引改成分片，每片 3000 字。', anchors: ['prev-0001#99'] })
assert.match(badAnchor, /被拒/, badAnchor)

const accepted = await noteTool.execute({ kind: '教训', claim: '索引改成分片，每片 3000 字。', anchors: ['prev-0001#2'] })
assert.match(accepted, /已写入/, accepted)
assert.ok(existsSync(noteFile), '应写出自述文件')
const noteMd = readFileSync(noteFile, 'utf8')
assert.ok(noteMd.includes('<!-- managed:self-note start -->'))
assert.ok(noteMd.includes('索引改成分片'))

const noteSpec = promptContexts.find((spec) => spec.name === 'memory-vector:self-note')
const injected = noteSpec.text()
assert.ok(injected.startsWith('【我记下的关于自己的事实】'), injected)
assert.ok(injected.includes('prev-0001#2'), '注入必须带出处')
console.log('ok · 自述写入（禁语 / 锚点拦截 + 受管块 + 带出处注入）')

await call('POST', '/settings', {
  settings: { ...(await call('GET', '/state')).body.settings, requireApproval: true }
})
const queued = await noteTool.execute({ kind: '偏好', claim: '检索先查 FTS 再算余弦。', anchors: ['prev-0001#2'] })
assert.match(queued, /待审/, queued)

const queueState = await call('GET', '/selfnote')
assert.equal(queueState.body.pending.length, 1)
const pendingId = queueState.body.pending[0].id
const approved = await call('POST', '/selfnote', { action: 'approve', id: pendingId })
assert.equal(approved.body.pending.length, 0)
assert.equal(approved.body.entries.length, 2)
console.log(`ok · 待审队列（${pendingId} 采纳后生效）`)

/* ---------- P5：L3 交付物索引（采集 + root-only） ---------- */

function emitSession(event, session, payload) {
  for (const listener of handlers.get(event) ?? []) listener(session, payload)
}

const liveSession = { header: { id: 'session-live', cwd: 'D:\\projects\\demo' } }
emitSession('session/event', liveSession, {
  type: 'tool/call',
  time: Date.now(),
  data: { name: 'write', callId: 'c1', turn: 4, arguments: JSON.stringify({ file_path: 'D:\\projects\\demo\\report.md' }) }
})
emitSession('session/event', liveSession, {
  type: 'tool/call',
  time: Date.now(),
  data: {
    name: 'present',
    callId: 'c2',
    turn: 4,
    arguments: JSON.stringify({ files: [{ path: 'D:\\projects\\demo\\out.xlsx', description: '报表' }] })
  }
})
// 不在名单里的工具、半截 JSON：都不该记
emitSession('session/event', liveSession, {
  type: 'tool/call',
  time: Date.now(),
  data: { name: 'pwsh', callId: 'c3', turn: 4, arguments: JSON.stringify({ command: 'echo hi' }) }
})
emitSession('session/event', liveSession, {
  type: 'tool/call',
  time: Date.now(),
  data: { name: 'write', callId: 'c4', turn: 5, arguments: '{"file_path":"D:\\projects\\demo\\half' }
})

await new Promise((resolve) => setTimeout(resolve, 120))

const listed = await call('GET', '/deliverables')
assert.equal(listed.body.rows.length, 2, JSON.stringify(listed.body.rows))
assert.ok(listed.body.rows.some((row) => row.path.endsWith('report.md')))
assert.ok(listed.body.rows.some((row) => row.path.endsWith('out.xlsx') && row.kind === 'delivered'))
console.log('ok · 交付物采集（tool/call → 索引；非名单工具与半截 JSON 被忽略）')

const deliverableTool = tools.find((tool) => tool.name === 'deliverable_search')
const ownerView = await deliverableTool.execute(
  { query: 'report' },
  { agent: { session: { header: { id: 'session-live', cwd: 'D:\\projects\\demo' } } } }
)
assert.match(ownerView, /report\.md/, ownerView)
assert.match(ownerView, /session-live#4/)

const subagentView = await deliverableTool.execute(
  { query: 'report' },
  { agent: { session: { header: { id: 'sub-1', cwd: 'D:\\projects\\demo', origin: 'subagent', delegationDepth: 1 } } } }
)
assert.match(subagentView, /被拒/, subagentView)
assert.ok(!subagentView.includes('report.md'), '子会话不该看到主人的文件清单')
console.log('ok · 交付物只对主会话开放（子智能体被拒）')

const otherWorkspace = await deliverableTool.execute(
  { query: 'report' },
  { agent: { session: { header: { id: 'session-other', cwd: 'D:\\projects\\other' } } } }
)
assert.ok(!otherWorkspace.includes('report.md'), '默认工作区隔离')
const crossWorkspace = await deliverableTool.execute(
  { query: 'report', all: true },
  { agent: { session: { header: { id: 'session-other', cwd: 'D:\\projects\\other' } } } }
)
assert.match(crossWorkspace, /report\.md/, 'all:true 才能跨工作区')
console.log('ok · 工作区隔离（要跨区必须显式 all:true）')

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

const waitFor = async (check, timeoutMs = 4000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const preStep = handlers.get('agent/pre-step')[0]
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

  const awayStrict = await call('POST', '/search', { query: QUERY, cwd: 'D:\\projects\\other', scope: 'workspace' })
  assert.equal(awayStrict.body.hits.length, 0, 'workspace 模式下不该召回别的工作区')
  const homeStrict = await call('POST', '/search', { query: QUERY, cwd: 'D:\\projects\\old', scope: 'workspace' })
  assert.equal(homeStrict.body.hits.length, 1, 'workspace 模式下应召回本工作区')
  const awayDefault = await call('POST', '/search', { query: QUERY, cwd: 'D:\\projects\\other' })
  assert.equal(awayDefault.body.hits.length, 1, '默认 workspace-first 仍允许召回外区')
  console.log('ok · 检索工作区范围（workspace 严格 / workspace-first 放行）')

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

  // 冷启动：换到一个一条记忆都没有的工作区
  const emptyWorkspace = {
    ...turnInput,
    turn: 9,
    agent: { session: { id: 'session-empty', header: { cwd: 'D:\\projects\\brand-new' } } },
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '这个项目怎么构建' }] }]
  }
  const coldStart = await preStep(emptyWorkspace, enter)
  assert.equal(coldStart.messages.length, 1, '空白工作区应有一条提示')
  assert.match(coldStart.messages[0].content[0].text, /还没有任何记忆/)
  const againCold = await preStep(emptyWorkspace, enter)
  const againText = againCold.messages.map((message) => message.content?.[0]?.text ?? '').join('\n')
  assert.ok(!/还没有任何记忆/.test(againText), '同一会话不重复提醒')
  console.log('ok · 空白工作区只提醒一次')

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

  /* ---------- 归因：注入之后到底有没有被引用 ---------- */

  const beforeAttr = (await call('GET', '/state')).body.metrics
  assert.ok(beforeAttr.attribution.injected >= 1, '注入要被记到 injected')
  assert.equal(beforeAttr.attribution.used, 0, '还没回复，used 必须是 0')
  console.log(`ok · 注入只记 injected（injected=${beforeAttr.attribution.injected}, used=0）`)

  // 回复里原样复述了这块记忆 → 应该被认成"用到了"
  emitSession('session/event', liveSession, {
    type: 'assistant/message',
    time: Date.now(),
    data: {
      turn: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '按记录：doubao-embedding-vision 默认 1024 维，走方舟 Agent Plan。' }] }
    }
  })
  emitSession('session/event', liveSession, { type: 'turn/end', time: Date.now(), data: { turn: 1 } })

  const attributed = await waitFor(async () => {
    const metrics = (await call('GET', '/state')).body.metrics
    return metrics.attribution.used >= 1
  })
  assert.ok(attributed, '复述了记忆却没算成引用')
  const afterAttr = (await call('GET', '/state')).body.metrics
  assert.ok(afterAttr.attribution.usedRatio > 0 && afterAttr.attribution.usedRatio <= 1)
  assert.ok(afterAttr.turns.attributed >= 1)
  console.log(`ok · 归因（used=${afterAttr.attribution.used}，注入利用率 ${afterAttr.attribution.usedRatio}）`)

  // 空回复（纯工具轮 / 被中断）→ 不判定，计入 undecided
  await preStep({ ...turnInput, turn: 4, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: QUERY }] }] }, enter)
  emitSession('session/event', liveSession, { type: 'turn/end', time: Date.now(), data: { turn: 4 } })
  const undecided = await waitFor(async () => (await call('GET', '/state')).body.metrics.turns.undecided >= 1)
  assert.ok(undecided, '没有正文的轮次应计入 undecided')
  console.log('ok · 无正文的轮次不猜（计 undecided）')
} else {
  console.log('skip · 没有 ARK_CODE_LATEST_API_KEY，跳过自动回想与探针')
}

/* ---------- P2：L1 跨会话桥接（不需要凭证） ---------- */

const bridgeSpec = promptContexts.find((spec) => spec.name === 'memory-vector:bridge')
const reader = { agent: { session: { id: 'reader-1', header: { cwd: 'D:\\projects\\old' } } } }

assert.equal(bridgeSpec.text(reader), '', '默认关闭时不注入')
console.log('ok · 桥接默认关闭')

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

/* ---------- P3：L2 权重快照（需要真实命中记录） ---------- */

if (hasKey) {
  const AGENT_MD = join(HOME, 'AGENT.md')
  writeFileSync(AGENT_MD, '# 你是谁\n\n我是子非鱼。\n\n# 边界\n\n不编造。\n', 'utf8')

  const weightsOn = await call('POST', '/settings', {
    settings: { ...(await call('GET', '/state')).body.settings, weightsEnabled: true }
  })
  assert.equal(weightsOn.body.settings.weightsEnabled, true)
  assert.equal(weightsOn.body.settings.weightsRefreshMode, 'daily', '默认节奏应是一天一次')
  assert.equal(weightsOn.body.settings.weightsRefreshHours, 24)

  const refreshed = await call('POST', '/weights', {})
  assert.equal(refreshed.body.result.ok, true, JSON.stringify(refreshed.body.result))
  assert.ok(refreshed.body.result.entries >= 1, '至少要写进一条被命中过的记忆')

  const after = readFileSync(AGENT_MD, 'utf8')
  assert.ok(after.startsWith('# 你是谁'), '手写内容必须在最前，且不被改动')
  assert.ok(after.includes('我是子非鱼。'))
  assert.ok(after.includes('不编造。'))
  assert.ok(after.includes('<!-- managed:memory-weights start -->'))
  assert.ok(after.includes('session-old#7'), '快照条目要带 sessionId#seq 锚点')
  console.log(`ok · 权重快照写入 AGENT.md（${refreshed.body.result.entries} 条，手写内容零改动）`)

  const again = await call('POST', '/weights', {})
  assert.equal(again.body.result.changed, false, '同内容重写应幂等')
  assert.equal(readFileSync(AGENT_MD, 'utf8'), after)
  console.log('ok · 重复刷新不重写文件')

  const weightsState = (await call('GET', '/state')).body.weights
  assert.equal(weightsState.enabled, true)
  assert.ok(weightsState.lastAt > 0)
  assert.match(weightsState.preview, /managed:memory-weights/)
  console.log(`ok · /state 暴露权重状态（${weightsState.entries} 条）`)
} else {
  console.log('skip · 没有 ARK_CODE_LATEST_API_KEY，跳过权重快照')
}

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
/* ---------- 历史回填（预览 → 确认 → 落库 → 幂等） ---------- */

const preview = await call('GET', '/backfill')
assert.equal(preview.body.ok, true, JSON.stringify(preview.body))
assert.ok(preview.body.sessions >= 1, '应至少有一场可回填')
assert.ok(preview.body.estimateChunks >= 1)

const noConfirm = await call('POST', '/backfill', {})
assert.equal(noConfirm.status, 400, '没有 confirm 不该开始')

const chunksBefore = (await call('GET', '/state')).body.stats.chunks
const kickoff = await call('POST', '/backfill', { confirm: true })
assert.equal(kickoff.body.ok, true, JSON.stringify(kickoff.body))

let backfill = null
for (let index = 0; index < 60; index += 1) {
  backfill = (await call('GET', '/state')).body.backfill
  if (backfill.running !== true) break
  await new Promise((resolve) => setTimeout(resolve, 200))
}
assert.equal(backfill.running, false, '回填应在超时内结束')
assert.ok(backfill.sessions >= 1, JSON.stringify(backfill))
assert.equal(backfill.error, null)

const chunksAfter = (await call('GET', '/state')).body.stats.chunks
assert.ok(chunksAfter > chunksBefore, `回填后块数应增加：${chunksBefore} → ${chunksAfter}`)
console.log(`ok · 历史回填（${backfill.sessions} 场 / 块数 ${chunksBefore}→${chunksAfter}）`)

const again = await call('GET', '/backfill')
assert.equal(again.body.sessions, 0, '已回填的会话不应再出现在预览里')
assert.ok(again.body.done.sessions >= 1)
console.log('ok · 回填幂等（已处理的会话不再计入）')

disposers.forEach((dispose) => dispose())
await new Promise((resolve) => setTimeout(resolve, 100))
rmSync(HOME, { recursive: true, force: true })
assert.equal(existsSync(join(HOME, 'storages')), false)
console.log('\nHost 冒烟全部通过')
