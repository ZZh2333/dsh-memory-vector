/**
 * dsh-memory-vector · 设置层
 *
 * 单一真源：DEFAULTS 提供默认值，SCHEMA 提供设置页渲染所需的元数据。
 * 设置页从 /state 拿到 SCHEMA，不自己硬编码字段，避免宿主与前端各写一份漂移。
 *
 * 存储位置：<DSH_HOME>/storages/memory-vector/settings.json
 * 读取方式：DEFAULTS ← settings.json（用户改动），逐字段校验后合并。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 本机 DSH 主目录；跟随 DSH_HOME 环境变量。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 记忆数据的根目录。 */
export function memoryRoot() {
  return join(dshHome(), 'storages', 'memory-vector')
}

export function settingsPath() {
  return join(memoryRoot(), 'settings.json')
}

/** 默认值：全部可覆盖，全部可在设置页改。 */
export const DEFAULTS = {
  // ---- 采集（L0 原文库）----
  ingestEnabled: false,
  minTurnChars: 24,
  maxChunkChars: 3000,
  excludeWorkspaces: '',

  // ---- 检索 ----
  topK: 6,
  minScore: 0.35,
  maxHitsPerSession: 2,
  contextChars: 4000,
  hybrid: true,

  // ---- 嵌入模型 ----
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  apiKeyRef: 'ARK_CODE_LATEST_API_KEY',
  model: 'doubao-embedding-vision',
  dimensions: 1024,
  timeoutMs: 8000,
  batchSize: 8,

  // ---- L1 桥接 ----
  bridgeEnabled: false,
  bridgeScope: 'workspace-latest',
  bridgeDays: 7,
  bridgeMessages: 12,

  // ---- L2 长期权重 ----
  weightsEnabled: false,
  halfLifeDays: 21,
  maxEntries: 40,
  refreshTurns: 20,

  // ---- L4 自述 ----
  selfNoteEnabled: false,
  maxEntries: 12,
  budgetChars: 1200

  // ---- 说明 ----
  // L1/L2/L4 的开关先占位：P0 只交付「L0 原文库 + 混合检索」，
  // 这三组参数会原样落到设置页，但打开后暂无行为（页面里标了「待接入」）。
}

/**
 * 设置页字段元数据。
 * type: 'boolean' | 'number' | 'string' | 'select'
 * group: 分组键，前端按 group 顺序渲染卡片
 */
export const SCHEMA = [
  {
    group: 'source',
    key: 'ingestEnabled',
    type: 'boolean',
    title: { zh: '自动采集新对话', en: 'Capture new turns' },
    hint: {
      zh: '开启后，每轮对话结束时把「你 + 我」的对话正文切块、向量化并存入本地原文库。正文会发送到方舟做嵌入（见上方隐私说明）。',
      en: 'When on, each finished turn is chunked, embedded, and stored locally. Turn text is sent to Ark for embedding.'
    }
  },
  {
    group: 'source',
    key: 'minTurnChars',
    type: 'number',
    min: 0,
    max: 500,
    step: 1,
    title: { zh: '最短收录长度（字符）', en: 'Minimum turn length' },
    hint: { zh: '太短的寒暄不值得记，低于这个长度的对话不建块。', en: 'Turns shorter than this are not indexed.' }
  },
  {
    group: 'source',
    key: 'maxChunkChars',
    type: 'number',
    min: 200,
    max: 20000,
    step: 100,
    title: { zh: '单块最大字符', en: 'Max chunk size' },
    hint: { zh: '超过则按段落再切，避免一块塞进整场对话。', en: 'Longer turns are split by paragraph.' }
  },
  {
    group: 'source',
    key: 'excludeWorkspaces',
    type: 'string',
    title: { zh: '不采集的工作区', en: 'Excluded workspaces' },
    hint: { zh: '逗号分隔的路径片段，命中即跳过（例如 secrets,work-temp）。', en: 'Comma-separated path fragments to skip.' }
  },

  {
    group: 'retrieval',
    key: 'topK',
    type: 'number',
    min: 1,
    max: 20,
    step: 1,
    title: { zh: '召回条数', en: 'Top K' },
    hint: { zh: '每次检索交给模型的记忆块数量上限。', en: 'Maximum memory blocks per retrieval.' }
  },
  {
    group: 'retrieval',
    key: 'minScore',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    title: { zh: '最低相似度', en: 'Minimum score' },
    hint: { zh: '低于此分数的候选直接丢弃，宁缺毋滥。', en: 'Candidates below this score are dropped.' }
  },
  {
    group: 'retrieval',
    key: 'maxHitsPerSession',
    type: 'number',
    min: 1,
    max: 5,
    step: 1,
    title: { zh: '单会话最多命中', en: 'Hits per session' },
    hint: { zh: '防止一次召回被同一场对话霸屏。', en: 'Caps hits coming from one session.' }
  },
  {
    group: 'retrieval',
    key: 'contextChars',
    type: 'number',
    min: 500,
    max: 20000,
    step: 100,
    title: { zh: '注入字符预算', en: 'Context budget' },
    hint: { zh: '检索结果拼进上下文的总字符上限。', en: 'Total characters allowed in injected context.' }
  },
  {
    group: 'retrieval',
    key: 'hybrid',
    type: 'boolean',
    title: { zh: '关键词 + 向量混合检索', en: 'Hybrid retrieval' },
    hint: { zh: '关闭后只走向量：语义更灵，专有名词更钝。', en: 'Off = vector only.' }
  },

  {
    group: 'embedding',
    key: 'model',
    type: 'string',
    title: { zh: '向量模型', en: 'Embedding model' },
    hint: { zh: '建议固定版本，换模型需要重建索引。', en: 'Changing this requires a reindex.' }
  },
  {
    group: 'embedding',
    key: 'dimensions',
    type: 'select',
    options: [1024, 2048],
    title: { zh: '向量维度', en: 'Dimensions' },
    hint: { zh: '1024 省一半存储与计算；2048 信息更全。改动需重建索引。', en: 'Changing this requires a reindex.' }
  },
  {
    group: 'embedding',
    key: 'baseUrl',
    type: 'string',
    title: { zh: '接口地址', en: 'Base URL' },
    hint: { zh: 'Agent Plan 专属地址必须带 /plan。', en: 'Agent Plan base URL must contain /plan.' }
  },
  {
    group: 'embedding',
    key: 'apiKeyRef',
    type: 'string',
    title: { zh: '凭证引用名', en: 'Credential ref' },
    hint: { zh: '指向 .credentials.yaml 里 refs 下的名字，不是密钥本身。', en: 'A name in .credentials.yaml refs, never the secret itself.' }
  },
  {
    group: 'embedding',
    key: 'timeoutMs',
    type: 'number',
    min: 1000,
    max: 60000,
    step: 500,
    title: { zh: '请求超时（毫秒）', en: 'Request timeout' },
    hint: { zh: '检索路径建议短超时，失败静默降级。', en: 'Short timeouts keep the turn fast.' }
  },
  {
    group: 'embedding',
    key: 'batchSize',
    type: 'number',
    min: 1,
    max: 32,
    step: 1,
    title: { zh: '批量大小', en: 'Batch size' },
    hint: { zh: '一次请求打包几条文本，过大易被限流。', en: 'Texts per embedding request.' }
  },

  {
    group: 'bridge',
    key: 'bridgeEnabled',
    type: 'boolean',
    title: { zh: 'L1 跨会话桥接', en: 'L1 session bridge' },
    hint: {
      zh: '新会话开场时，把上一场对话的尾部几轮带进来，避免"聊着聊着跟不上"。待接入（P2）。',
      en: 'Carry the tail of the previous session into a new one. Pending (P2).'
    },
    pending: true
  },
  {
    group: 'bridge',
    key: 'bridgeScope',
    type: 'select',
    options: ['workspace-latest', 'recent-days'],
    title: { zh: '桥接范围', en: 'Bridge scope' },
    hint: {
      zh: 'workspace-latest=同工作区最近一场对话；recent-days=最近 N 天所有对话。',
      en: 'Latest session in this workspace, or every session within N days.'
    },
    pending: true
  },
  {
    group: 'bridge',
    key: 'bridgeDays',
    type: 'number',
    min: 1,
    max: 365,
    step: 1,
    title: { zh: 'N 天（recent-days 生效）', en: 'N days' },
    hint: { zh: '配合"桥接范围=recent-days"使用。', en: 'Used when scope is recent-days.' },
    pending: true
  },
  {
    group: 'bridge',
    key: 'bridgeMessages',
    type: 'number',
    min: 2,
    max: 60,
    step: 1,
    title: { zh: '桥接消息条数', en: 'Bridged messages' },
    hint: { zh: '带进来的历史消息条数上限。', en: 'Maximum carried-over messages.' },
    pending: true
  },

  {
    group: 'weights',
    key: 'weightsEnabled',
    type: 'boolean',
    title: { zh: 'L2 长期权重链', en: 'L2 long-term weights' },
    hint: {
      zh: '按艾宾浩斯曲线给记忆加权：常出现的不衰，久不出现的淡出。快照会写进 AGENT.md 的受管章节。待接入（P3）。',
      en: 'Ebbinghaus-weighted memory. Snapshot lands in a managed AGENT.md section. Pending (P3).'
    },
    pending: true
  },
  {
    group: 'weights',
    key: 'halfLifeDays',
    type: 'number',
    min: 1,
    max: 365,
    step: 1,
    title: { zh: '半衰期（天）', en: 'Half-life (days)' },
    hint: { zh: '权重降到一半所需天数；改这个不用重算历史。', en: 'Days to halve a weight.' },
    pending: true
  },
  {
    group: 'weights',
    key: 'maxEntries',
    type: 'number',
    min: 5,
    max: 200,
    step: 1,
    title: { zh: '权重表上限', en: 'Weight entries' },
    hint: { zh: '超过则淘汰最弱的，保持快照精简。', en: 'Weakest entries are evicted.' },
    pending: true
  },
  {
    group: 'weights',
    key: 'refreshTurns',
    type: 'number',
    min: 1,
    max: 200,
    step: 1,
    title: { zh: '快照刷新间隔（轮）', en: 'Refresh every N turns' },
    hint: { zh: '别每轮重写：快照变了才会重新注入，改得太勤会炸缓存。', en: 'Snapshot is rewritten at most this often.' },
    pending: true
  },

  {
    group: 'selfNote',
    key: 'selfNoteEnabled',
    type: 'boolean',
    title: { zh: 'L4 自我叙述', en: 'L4 self notes' },
    hint: {
      zh: '让我自己写"我是怎么变成现在这样的"，有上限、旧条目归档可回溯。待接入（P4）。',
      en: 'The agent writes its own narrative, capped and archived. Pending (P4).'
    },
    pending: true
  },
  {
    group: 'selfNote',
    key: 'maxEntries',
    type: 'number',
    min: 2,
    max: 60,
    step: 1,
    title: { zh: '自述条数上限', en: 'Max notes' },
    hint: { zh: '满了就把最旧的归档，不是删除。', en: 'Oldest notes are archived, not deleted.' },
    pending: true
  },
  {
    group: 'selfNote',
    key: 'budgetChars',
    type: 'number',
    min: 200,
    max: 8000,
    step: 100,
    title: { zh: '自述字符预算', en: 'Notes budget' },
    hint: { zh: '每次注入的固定成本，宁短勿长。', en: 'Fixed cost per request.' },
    pending: true
  }
]

/** 分组标题（前端按顺序渲染）。 */
export const GROUPS = [
  { key: 'source', title: { zh: 'L0 · 原文库采集', en: 'L0 · Raw store' } },
  { key: 'retrieval', title: { zh: '检索', en: 'Retrieval' } },
  { key: 'embedding', title: { zh: '向量模型', en: 'Embedding' } },
  { key: 'bridge', title: { zh: 'L1 · 跨会话桥接', en: 'L1 · Session bridge' } },
  { key: 'weights', title: { zh: 'L2 · 长期权重', en: 'L2 · Long-term weights' } },
  { key: 'selfNote', title: { zh: 'L4 · 自我叙述', en: 'L4 · Self notes' } }
]

const NUMBER_LIMITS = new Map()
for (const field of SCHEMA) {
  if (field.type === 'number') NUMBER_LIMITS.set(field.key, field)
}

/** 把任意输入收敛成合法值；类型不对就退回默认值。 */
function coerce(key, raw) {
  const fallback = DEFAULTS[key]
  const field = SCHEMA.find((entry) => entry.key === key)
  if (field === undefined) return fallback
  if (field.type === 'boolean') return typeof raw === 'boolean' ? raw : fallback
  if (field.type === 'string') return typeof raw === 'string' ? raw : fallback
  if (field.type === 'select') {
    return field.options.some((option) => option === raw) ? raw : fallback
  }
  const limit = NUMBER_LIMITS.get(key)
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return fallback
  const clamped = Math.min(limit.max, Math.max(limit.min, value))
  return limit.step === 1 ? Math.round(clamped) : Math.round(clamped / limit.step) * limit.step
}

/** 补齐 + 收敛一份设置。 */
export function normalize(raw) {
  const next = {}
  for (const key of Object.keys(DEFAULTS)) next[key] = coerce(key, raw?.[key])
  return next
}

/** 读取设置；文件缺失或损坏都退回默认值，绝不因为设置崩掉插件。 */
export function loadSettings() {
  let raw = null
  try {
    raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    raw = null
  }
  return normalize(raw ?? {})
}

/** 原子写回设置。 */
export function saveSettings(settings) {
  const normalized = normalize(settings)
  mkdirSync(dirname(settingsPath()), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(normalized, null, 2) + '\n', 'utf8')
  return normalized
}
