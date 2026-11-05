/**
 * dsh-memory-vector · 设置层
 *
 * 单一真源：DEFAULTS 提供默认值，SCHEMA 提供设置页渲染所需的元数据。
 * 设置页从 /state 拿到 SCHEMA，不自己硬编码字段，避免宿主与前端各写一份漂移。
 *
 * 存储位置：<DSH_HOME>/storages/memory-vector/settings.json
 * 读取方式：DEFAULTS ← settings.json（用户改动），逐字段校验后合并。
 *
 * 向量化模型是「可多套并存」的：每套是一条 embeddingProviders 记录
 * （id / 名称 / 地址 / 凭证引用 / 模型名 / 维度 / 超时 / 批量），
 * embeddingActive 指向当前生效的那一套。换模型只改指针，历史块仍可读。
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

/** 一套向量化模型的默认形状。 */
export const DEFAULT_PROVIDER = {
  id: 'ark-plan',
  label: '方舟 Agent Plan',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  apiKeyRef: 'ARK_CODE_LATEST_API_KEY',
  model: 'doubao-embedding-vision',
  dimensions: 1024,
  timeoutMs: 8000,
  batchSize: 8
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
  /** global=全部记忆；workspace=只本工作区；workspace-first=本工作区优先。 */
  retrievalScope: 'workspace-first',
  /** 每轮开始自动回想（agent/pre-step 注入）；关掉就只剩 memory_search 工具。 */
  injectEnabled: true,
  /** 自动回想的字符预算：注入内容会永久留在会话历史里，宁短勿长。 */
  injectChars: 1500,

  // ---- 向量化模型（多套）----
  embeddingProviders: [DEFAULT_PROVIDER],
  /** 当前生效的 provider id；空串表示用第一套。 */
  embeddingActive: DEFAULT_PROVIDER.id,

  // ---- L1 桥接 ----
  bridgeEnabled: false,
  bridgeScope: 'workspace-latest',
  bridgeDays: 7,
  bridgeMessages: 12,
  /** 桥接正文预算：进 systemPrompt，每次请求都付这份钱。 */
  bridgeChars: 1200,

  // ---- L3 交付物索引 ----
  deliverablesEnabled: true,
  /** 哪些工具算"产出文件"，逗号分隔。 */
  deliverableTools: 'write,edit,str-replace-editor,present',
  /** workspace=只看当前工作区；all=全部。 */
  deliverableScope: 'workspace',
  maxDeliverables: 2000,
  /** 只让 root 会话查；子智能体一律拒绝。 */
  deliverablesOwnerOnly: true,

  // ---- 历史回填 ----
  backfillMaxSessions: 50,
  backfillMaxChunks: 300,
  backfillOnlyWorkspace: true,

  // ---- L2 长期权重 ----
  weightsEnabled: false,
  halfLifeDays: 21,
  maxEntries: 40,
  /** 快照刷新节奏：daily（按小时）/ turns（按轮数）/ manual（只手动）。 */
  weightsRefreshMode: 'daily',
  /** daily 模式的间隔小时数。 */
  weightsRefreshHours: 24,
  /** turns 模式的间隔轮数。 */
  refreshTurns: 20,
  /** 权重快照写进哪个文件（相对 DSH_HOME）。 */
  weightsTarget: 'AGENT.md',

  // ---- 归因（注入 vs 真被引用） ----
  /** referenced=按回复比对；assume=注入即算用（旧行为）；off=不记账。 */
  hitAttribution: 'referenced',
  /** 回复里有多少连续字符原样出现在记忆里，才算引用。 */
  attributeWindow: 12,
  /** 第二道：回复与记忆的 bigram 重合率线。 */
  attributeThreshold: 0.15,
  /** 单轮最多认几块被引用，防止整段复述导致虚高。 */
  attributeMaxUsed: 3,
  /** 注入多少次还没被引用，算死重。 */
  deadAfterInjections: 3,
  /** 死重的权重乘子：只降权，不删。 */
  deadWeightPenalty: 0.6,

  // ---- L4 自述 ----
  selfNoteEnabled: false,
  /** 新条目是否先排队等主人点头。默认关：主人选了"顺畅优先"。 */
  requireApproval: false,
  /** 待审队列过期时间（小时），过期直接丢，不落盘。 */
  pendingTtlHours: 72,
  maxNoteEntries: 12,
  budgetChars: 1200,
  /** 每 N 轮最多新增一条，防止一口气写满。 */
  noteRateTurns: 10,
  /** 超过这么多轮没写自述，就在系统提示末尾提醒一句；0 = 不提醒。 */
  noteNudgeTurns: 20,
  /** 每写入 N 条做一次锚点核对。 */
  auditEvery: 10,
  /** 自述文件位置（相对 DSH_HOME）。 */
  selfNoteTarget: 'memory/self-note.md'
}

/**
 * 设置页字段元数据（不含向量化模型 —— 那一组由前端渲染成"多套模型"卡片）。
 * type: 'boolean' | 'number' | 'string' | 'select'
 */
export const SCHEMA = [
  {
    group: 'source',
    key: 'ingestEnabled',
    type: 'boolean',
    title: { zh: '自动采集新对话', en: 'Capture new turns' },
    hint: {
      zh: '开启后，每轮对话结束时把「你 + 我」的对话正文切块、向量化并存入本地原文库。正文会发送到当前生效的向量化模型（见上方地址）。',
      en: 'When on, each finished turn is chunked, embedded, and stored locally. Turn text is sent to the active embedding provider.'
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
    key: 'retrievalScope',
    type: 'select',
    options: ['workspace-first', 'workspace', 'global'],
    title: { zh: '跨工作区范围', en: 'Workspace scope' },
    hint: {
      zh: 'workspace-first（默认）：本工作区的记忆排在前面，其他项目的记忆仍然可能被召回；workspace：只认本工作区，干净但会断掉跨项目复用；global：不分工作区，完全按相关度排。',
      en: 'workspace-first = local memories rank ahead, others still allowed; workspace = local only; global = no scoping.'
    }
  },
  {
    group: 'retrieval',
    key: 'hybrid',
    type: 'boolean',
    title: { zh: '关键词 + 向量混合检索', en: 'Hybrid retrieval' },
    hint: { zh: '关闭后只走向量：语义更灵，专有名词更钝。', en: 'Off = vector only.' }
  },
  {
    group: 'retrieval',
    key: 'injectEnabled',
    type: 'boolean',
    title: { zh: '每轮自动回想', en: 'Auto-recall each turn' },
    hint: {
      zh: '开启后，每轮第一个步骤会按你的话检索记忆，命中就插在你说的话后面（只在本轮生效）。关掉后只能靠我主动调用 memory_search。',
      en: 'On each turn, recall from your message and insert hits right after it. Off = only the memory_search tool.'
    }
  },
  {
    group: 'retrieval',
    key: 'injectChars',
    type: 'number',
    min: 200,
    max: 8000,
    step: 100,
    title: { zh: '自动回想字符预算', en: 'Auto-recall budget' },
    hint: {
      zh: '注入内容会留在会话历史里，所以比手动检索的预算更小。调大更舍得塞，调小更省上下文。',
      en: 'Injected text stays in history, so this budget is smaller than manual retrieval.'
    }
  },

  {
    group: 'source',
    key: 'backfillMaxSessions',
    type: 'number',
    min: 1,
    max: 1000,
    step: 1,
    title: { zh: '回填·场次上限', en: 'Backfill sessions' },
    hint: {
      zh: '一次「回填历史」最多处理多少场旧会话。处理过的会被记住，重复点不会重复花钱。',
      en: 'How many past sessions one backfill run may process.'
    }
  },
  {
    group: 'source',
    key: 'backfillMaxChunks',
    type: 'number',
    min: 10,
    max: 5000,
    step: 10,
    title: { zh: '回填·块数上限', en: 'Backfill chunks' },
    hint: {
      zh: '一次回填最多补多少块（等于多少次向量化调用）。这是花钱的上限，别设太大。',
      en: 'Upper bound on embedded chunks per run — the spend cap.'
    }
  },
  {
    group: 'source',
    key: 'backfillOnlyWorkspace',
    type: 'boolean',
    title: { zh: '回填只取当前工作区', en: 'Current workspace only' },
    hint: {
      zh: '开（默认）：只补当前工作区的旧会话，噪音小；关掉会把所有项目的对话都补进来。',
      en: 'On: only the current workspace is backfilled.'
    }
  },

  {
    group: 'deliverables',
    key: 'deliverablesEnabled',
    type: 'boolean',
    title: { zh: 'L3 交付物索引', en: 'L3 deliverables' },
    hint: {
      zh: '记下"哪个文件是哪场会话、哪一轮做的"——只存路径和出处，不存文件内容、不读文件、不出本机。用 deliverable_search 查。',
      en: 'Records which file came from which session/turn. Paths and provenance only.'
    }
  },
  {
    group: 'deliverables',
    key: 'deliverableTools',
    type: 'string',
    title: { zh: '算作产出的工具', en: 'Producer tools' },
    hint: {
      zh: '逗号分隔的工具名。默认 write / edit / str-replace-editor / present：前三个是改文件，present 是明确交付。改这里等于改"什么算产出"。',
      en: 'Comma-separated tool names counted as producing a file.'
    }
  },
  {
    group: 'deliverables',
    key: 'deliverableScope',
    type: 'select',
    options: ['workspace', 'all'],
    title: { zh: '检索范围', en: 'Scope' },
    hint: {
      zh: 'workspace=只查当前工作区（默认，噪音小）；all=跨所有工作区查，会带出别的项目。',
      en: 'workspace = current workspace only (default); all = every workspace.'
    }
  },
  {
    group: 'deliverables',
    key: 'maxDeliverables',
    type: 'number',
    min: 50,
    max: 20000,
    step: 50,
    title: { zh: '索引条数上限', en: 'Max entries' },
    hint: {
      zh: '超过就丢最旧的记录——只丢索引条目，磁盘上的文件一个都不动。',
      en: 'Oldest records are dropped; files on disk are untouched.'
    }
  },
  {
    group: 'deliverables',
    key: 'deliverablesOwnerOnly',
    type: 'boolean',
    title: { zh: '只允许主会话查询', en: 'Root session only' },
    hint: {
      zh: '开（默认）：子智能体调用 deliverable_search 会被拒绝——交付物清单属于主人，不该被子会话翻。关掉则谁都能查。',
      en: 'On: subagents are denied the index.'
    }
  },

  {
    group: 'bridge',
    key: 'bridgeEnabled',
    type: 'boolean',
    title: { zh: 'L1 跨会话桥接', en: 'L1 session bridge' },
    hint: {
      zh: '新会话开场时，把上一场对话的尾巴挂进系统提示的固定位置，避免"聊着聊着跟不上"。只读本机会话日志，不外发。',
      en: 'Attach the tail of the previous session to a fixed system-prompt slot. Reads local logs only.'
    }
  },
  {
    group: 'bridge',
    key: 'bridgeScope',
    type: 'select',
    options: ['workspace-latest', 'recent-days'],
    title: { zh: '桥接范围', en: 'Bridge scope' },
    hint: {
      zh: 'workspace-latest=同工作区最近一场对话；recent-days=同工作区最近 N 天内最多三场。',
      en: 'Latest session in this workspace, or up to three in this workspace within N days.'
    }
  },
  {
    group: 'bridge',
    key: 'bridgeDays',
    type: 'number',
    min: 1,
    max: 365,
    step: 1,
    title: { zh: 'N 天（recent-days 生效）', en: 'N days' },
    hint: { zh: '配合"桥接范围=recent-days"使用。', en: 'Used when scope is recent-days.' }
  },
  {
    group: 'bridge',
    key: 'bridgeMessages',
    type: 'number',
    min: 2,
    max: 60,
    step: 1,
    title: { zh: '桥接消息条数', en: 'Bridged messages' },
    hint: { zh: '带进来的历史消息条数上限（每场会话）。', en: 'Maximum carried-over messages per session.' }
  },
  {
    group: 'bridge',
    key: 'bridgeChars',
    type: 'number',
    min: 200,
    max: 8000,
    step: 100,
    title: { zh: '桥接字符预算', en: 'Bridge budget' },
    hint: {
      zh: '这段内容进系统提示，每次请求都要付钱。1000 字大约 600 token。',
      en: 'This lives in the system prompt and is paid on every request.'
    }
  },

  {
    group: 'weights',
    key: 'weightsEnabled',
    type: 'boolean',
    title: { zh: 'L2 长期权重链', en: 'L2 long-term weights' },
    hint: {
      zh: '按艾宾浩斯曲线给记忆加权：被反复用到的记得牢，久不用的自然淡出。权重只影响排序，不进提示词；定期把最强的那批写进 AGENT.md 的受管章节，让下个会话也能看见。',
      en: 'Ebbinghaus-weighted memory: often-recalled blocks stay, stale ones fade. Weights only affect ranking; the strongest entries are written into a managed AGENT.md section.'
    }
  },
  {
    group: 'weights',
    key: 'hitAttribution',
    type: 'select',
    options: ['referenced', 'assume', 'off'],
    title: { zh: '怎么算"被用到"', en: 'What counts as used' },
    hint: {
      zh: 'referenced（默认）：注入后等我这一轮回复出来，回复里确实复述了这块记忆的原话才 +1；assume：一注入就算用过（旧行为，权重会虚高）；off：完全不计。这一项决定权重准不准，改了不会重算历史。',
      en: 'referenced = only count when the reply actually quotes the block; assume = count on injection (inflated); off = never count.'
    }
  },
  {
    group: 'weights',
    key: 'attributeWindow',
    type: 'number',
    min: 4,
    max: 40,
    step: 1,
    title: { zh: '引用判定·连续字数', en: 'Verbatim window (chars)' },
    hint: {
      zh: '回复里连续多少个字原样出现在记忆里，就认定"真的读了这段"。中文里 12 个字照抄基本不可能是巧合；调小容易误判，调大容易漏判。',
      en: 'How many consecutive characters must appear verbatim to count as a real reference.'
    }
  },
  {
    group: 'weights',
    key: 'attributeThreshold',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.05,
    title: { zh: '引用判定·重合率', en: 'Overlap ratio' },
    hint: {
      zh: '第二道判据：回复与记忆的二连字重合比例超过它也算引用。逐字那条漏掉改写转述时，靠这个补。',
      en: 'Secondary rule: reply/memory bigram overlap above this also counts.'
    }
  },
  {
    group: 'weights',
    key: 'attributeMaxUsed',
    type: 'number',
    min: 1,
    max: 10,
    step: 1,
    title: { zh: '单轮最多算几块', en: 'Max credited per turn' },
    hint: {
      zh: '一轮里最多认几块被引用。防止模型整段复述注入内容时，所有块一起涨权重。',
      en: 'Cap on blocks credited in one turn.'
    }
  },
  {
    group: 'weights',
    key: 'deadAfterInjections',
    type: 'number',
    min: 1,
    max: 20,
    step: 1,
    title: { zh: '死重判定·注入次数', en: 'Dead after N injections' },
    hint: {
      zh: '被注入这么多次却一次都没被引用，判为"死重"：占着位置不干活。只降权、只报告，不删。',
      en: 'Injected this many times without a single reference = dead weight (downranked, never deleted).'
    }
  },
  {
    group: 'weights',
    key: 'deadWeightPenalty',
    type: 'number',
    min: 0.1,
    max: 1,
    step: 0.05,
    title: { zh: '死重惩罚系数', en: 'Dead weight penalty' },
    hint: {
      zh: '死重的权重乘这个数。1 = 不惩罚；0.6 = 打六折。不设 0：那等于删除，而删除之后就没法回头验证判定器是不是判错了。',
      en: 'Multiplier applied to dead-weight memories. Never 0 — deleting would hide judge errors.'
    }
  },
  {
    group: 'weights',
    key: 'halfLifeDays',
    type: 'number',
    min: 1,
    max: 365,
    step: 1,
    title: { zh: '半衰期·天数', en: 'Half-life (days)' },
    hint: {
      zh: '一条记忆从"上次被用到"起，权重降到一半要多少天。天数越大忘得越慢；改这个不用重算历史，下次刷新自然生效。',
      en: 'Days for a memory weight to halve since its last recall. Larger = slower forgetting.'
    }
  },
  {
    group: 'weights',
    key: 'maxEntries',
    type: 'number',
    min: 5,
    max: 200,
    step: 1,
    title: { zh: '权重表上限·条', en: 'Weight entries' },
    hint: {
      zh: '快照里最多保留几条。超过就淘汰最弱的，避免 AGENT.md 越写越长。',
      en: 'Maximum entries kept in the snapshot; weakest are evicted.'
    }
  },
  {
    group: 'weights',
    key: 'weightsRefreshMode',
    type: 'select',
    options: ['daily', 'turns', 'manual'],
    title: { zh: '快照刷新节奏', en: 'Refresh cadence' },
    hint: {
      zh: 'daily=按小时数定期重写（默认，权重是慢变量，一天一次足够）；turns=每 N 轮写一次，更及时但更频繁改文件；manual=只在设置页点「立即刷新」。',
      en: 'daily = rewrite every N hours (default); turns = every N turns; manual = only from the settings page.'
    }
  },
  {
    group: 'weights',
    key: 'weightsRefreshHours',
    type: 'number',
    min: 1,
    max: 168,
    step: 1,
    title: { zh: '刷新间隔·小时', en: 'Refresh every (hours)' },
    hint: {
      zh: '「按小时」节奏下每隔多少小时重写一次快照。24=一天一次，12=一天两次。只有权重排序真的变了才会写盘。',
      en: 'Interval in hours for the daily cadence. 24 = once a day.'
    }
  },
  {
    group: 'weights',
    key: 'refreshTurns',
    type: 'number',
    min: 1,
    max: 200,
    step: 1,
    title: { zh: '刷新间隔·轮', en: 'Refresh every (turns)' },
    hint: {
      zh: '只在「按轮数」节奏下生效：每多少轮重写一次快照。改得太勤会频繁动 AGENT.md，也会让提示前缀失效。',
      en: 'Used only by the turns cadence.'
    }
  },
  {
    group: 'weights',
    key: 'weightsTarget',
    type: 'string',
    title: { zh: '快照写入文件', en: 'Snapshot file' },
    hint: {
      zh: '相对 DSH 主目录的路径，默认 AGENT.md。插件只改文件里 <!-- managed:memory-weights --> 之间的内容，你自己写的部分一个字都不会动；写成 notes/memory.md 之类则新建一个文件。',
      en: 'Path relative to DSH_HOME (default AGENT.md). Only the managed block is rewritten.'
    }
  },

  {
    group: 'selfNote',
    key: 'selfNoteEnabled',
    type: 'boolean',
    title: { zh: 'L4 自我叙述', en: 'L4 self notes' },
    hint: {
      zh: '允许我调用 self_note_write，把「我记下的关于自己的事实」写进单独的文件。只收带出处的陈述句：有禁语表、有原文重叠校验、只增不删、旧条目归档。我无权改 AGENT.md 里的人格。',
      en: 'Lets the agent record anchored facts about itself in its own file. Banned phrases, overlap checks, append-only.'
    }
  },
  {
    group: 'selfNote',
    key: 'requireApproval',
    type: 'boolean',
    title: { zh: '新条目需人工审批', en: 'Require approval' },
    hint: {
      zh: '开：每条先进待审队列，你在下面点「采纳」才生效。关（默认）：通过校验就直接写入——写错了只能靠归档记录看出来。',
      en: 'On: new entries wait for your approval. Off (default): validated entries land immediately.'
    }
  },
  {
    group: 'selfNote',
    key: 'pendingTtlHours',
    type: 'number',
    min: 1,
    max: 720,
    step: 1,
    title: { zh: '待审有效期·小时', en: 'Pending TTL (hours)' },
    hint: {
      zh: '待审条目的保质期：过了这个时间还没处理就自动丢弃，不写入、不留档。',
      en: 'Unapproved entries are discarded after this many hours.'
    }
  },
  {
    group: 'selfNote',
    key: 'maxNoteEntries',
    type: 'number',
    min: 2,
    max: 60,
    step: 1,
    title: { zh: '自述条数上限', en: 'Max notes' },
    hint: { zh: '注入块里的条数上限；满了就把最旧的挪进归档区，不删除。', en: 'Oldest notes move to the archive, never deleted.' }
  },
  {
    group: 'selfNote',
    key: 'budgetChars',
    type: 'number',
    min: 200,
    max: 8000,
    step: 100,
    title: { zh: '自述字符预算', en: 'Notes budget' },
    hint: { zh: '这段进系统提示，每次请求都付固定 token，宁短勿长。', en: 'Fixed prompt cost per request.' }
  },
  {
    group: 'selfNote',
    key: 'noteRateTurns',
    type: 'number',
    min: 1,
    max: 200,
    step: 1,
    title: { zh: '写入间隔·轮', en: 'Write every N turns' },
    hint: { zh: '每 N 轮最多新增一条，防止一口气把自述写满。', en: 'At most one new note per N turns.' }
  },
  {
    group: 'selfNote',
    key: 'noteNudgeTurns',
    type: 'number',
    min: 0,
    max: 500,
    step: 1,
    title: { zh: '提醒间隔·轮', en: 'Nudge every N turns' },
    hint: {
      zh: '这里只是限速，不会主动催写。所以另设一个提醒：超过 N 轮没更新，就在系统提示末尾加一句"要不要记一条"（约 60 字）。0 = 永不提醒，自述就只剩你自己想起来才写。',
      en: 'Turns without a note before appending a one-line nudge to the system prompt; 0 disables.'
    }
  },
  {
    group: 'selfNote',
    key: 'auditEvery',
    type: 'number',
    min: 1,
    max: 100,
    step: 1,
    title: { zh: '体检间隔·条', en: 'Audit every N notes' },
    hint: {
      zh: '每写入 N 条就重新核对一遍：claim 与锚点原文重叠跌破 20% 的标黄（stale），不再注入，等人处理。',
      en: 'Re-checks anchors every N notes; drifted entries are flagged and stop being injected.'
    }
  },
  {
    group: 'selfNote',
    key: 'selfNoteTarget',
    type: 'string',
    title: { zh: '自述文件', en: 'Notes file' },
    hint: {
      zh: '相对 DSH 主目录的路径，默认 memory/self-note.md。故意不放在 AGENT.md：人格是你写的，我不碰。',
      en: 'Path relative to DSH_HOME. Deliberately not AGENT.md.'
    }
  }
]

/** 分组标题（前端按顺序渲染；providers 组由专用卡片渲染）。 */
export const GROUPS = [
  { key: 'source', title: { zh: 'L0 · 原文库采集', en: 'L0 · Raw store' } },
  { key: 'retrieval', title: { zh: '检索', en: 'Retrieval' } },
  { key: 'providers', title: { zh: '向量化模型', en: 'Embedding models' }, card: 'providers' },
  { key: 'deliverables', title: { zh: 'L3 · 交付物索引', en: 'L3 · Deliverables' } },
  { key: 'bridge', title: { zh: 'L1 · 跨会话桥接', en: 'L1 · Session bridge' } },
  { key: 'weights', title: { zh: 'L2 · 长期权重', en: 'L2 · Long-term weights' } },
  { key: 'selfNote', title: { zh: 'L4 · 自我叙述', en: 'L4 · Self notes' } }
]

/** 向量化模型卡片里每个字段的元数据（前端渲染用）。 */
export const PROVIDER_FIELDS = [
  {
    key: 'label',
    type: 'string',
    title: { zh: '名称', en: 'Label' },
    hint: { zh: '只给你自己看，随便起。', en: 'Only shown to you.' }
  },
  {
    key: 'baseUrl',
    type: 'string',
    title: { zh: '接口地址', en: 'Base URL' },
    hint: {
      zh: 'OpenAI 兼容的 /embeddings 前缀，插件会拼成 {baseUrl}/embeddings。方舟 Agent Plan 必须带 /plan。',
      en: 'The plugin calls {baseUrl}/embeddings.'
    }
  },
  {
    key: 'apiKeyRef',
    type: 'string',
    title: { zh: '凭证引用名', en: 'Credential ref' },
    hint: {
      zh: '指向 .credentials.yaml 里 refs 下的名字，不是密钥本身。本地无鉴权服务留空即不带 Authorization。',
      en: 'A name in .credentials.yaml refs. Leave empty for local servers without auth.'
    }
  },
  {
    key: 'model',
    type: 'string',
    title: { zh: '模型名', en: 'Model' },
    hint: { zh: '例如 doubao-embedding-vision、text-embedding-3-small。', en: 'For example doubao-embedding-vision.' }
  },
  {
    key: 'dimensions',
    type: 'number',
    min: 64,
    max: 4096,
    step: 1,
    title: { zh: '维度', en: 'Dimensions' },
    hint: { zh: '要与模型实际输出一致；换维度后旧块不参与向量召回。', en: 'Must match the model; old blocks stay out of vector recall.' }
  },
  {
    key: 'timeoutMs',
    type: 'number',
    min: 1000,
    max: 60000,
    step: 500,
    title: { zh: '超时（毫秒）', en: 'Timeout' },
    hint: { zh: '检索路径另有 1.5s 硬上限。', en: 'Retrieval has its own 1.5s cap.' }
  },
  {
    key: 'batchSize',
    type: 'number',
    min: 1,
    max: 32,
    step: 1,
    title: { zh: '批量大小', en: 'Batch size' },
    hint: { zh: '一次请求打包几条文本。', en: 'Texts per request.' }
  }
]

const FIELD_BY_KEY = new Map()
for (const field of SCHEMA) FIELD_BY_KEY.set(field.key, field)

/** 把任意输入收敛成合法值；类型不对就退回默认值。 */
function coerce(key, raw) {
  const fallback = DEFAULTS[key]
  const field = FIELD_BY_KEY.get(key)
  if (field === undefined) return fallback
  if (field.type === 'boolean') return typeof raw === 'boolean' ? raw : fallback
  if (field.type === 'string') return typeof raw === 'string' ? raw : fallback
  if (field.type === 'select') {
    return field.options.some((option) => option === raw) ? raw : fallback
  }
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return fallback
  const clamped = Math.min(field.max, Math.max(field.min, value))
  return field.step === 1 ? Math.round(clamped) : Math.round(clamped / field.step) * field.step
}

/** provider id 只允许小写字母/数字/连字符，避免设置页里出现奇怪键。 */
function normalizeId(raw, index, taken) {
  const base = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : ''
  let id = base === '' ? `provider-${index + 1}` : base
  let suffix = 2
  while (taken.has(id)) {
    id = `${base === '' ? 'provider' : base}-${suffix}`
    suffix += 1
  }
  taken.add(id)
  return id
}

/** 一套 provider 的字段收敛。 */
function coerceProvider(raw, index, taken) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const provider = { id: normalizeId(source.id, index, taken) }
  for (const field of PROVIDER_FIELDS) {
    const value = source[field.key]
    if (field.type === 'number') {
      const numeric = typeof value === 'number' ? value : Number(value)
      const fallback = DEFAULT_PROVIDER[field.key]
      if (!Number.isFinite(numeric)) {
        provider[field.key] = fallback
        continue
      }
      const clamped = Math.min(field.max, Math.max(field.min, numeric))
      provider[field.key] = field.step === 1 ? Math.round(clamped) : Math.round(clamped / field.step) * field.step
    } else {
      provider[field.key] = typeof value === 'string' ? value : String(DEFAULT_PROVIDER[field.key] ?? '')
    }
  }
  if (provider.label.trim() === '') provider.label = provider.model === '' ? provider.id : provider.model
  return provider
}

/** provider 列表收敛：去重 id、至少保留一套。 */
export function normalizeProviders(raw) {
  const list = Array.isArray(raw) ? raw : []
  const taken = new Set()
  const providers = list.map((entry, index) => coerceProvider(entry, index, taken))
  if (providers.length > 0) return providers
  return [coerceProvider(DEFAULT_PROVIDER, 0, taken)]
}

/**
 * 旧版扁平设置（baseUrl/model/apiKeyRef/dimensions 直接挂在顶层）→ 单套 provider。
 * 这样从 0.1.0 升级上来的用户不用重配。
 */
function migrateLegacy(raw) {
  if (raw === null || typeof raw !== 'object') return raw
  if (Array.isArray(raw.embeddingProviders) && raw.embeddingProviders.length > 0) return raw
  const hasLegacy = ['baseUrl', 'model', 'apiKeyRef'].some((key) => typeof raw[key] === 'string' && raw[key] !== '')
  if (!hasLegacy) return raw
  const provider = {
    ...DEFAULT_PROVIDER,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_PROVIDER.baseUrl,
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_PROVIDER.model,
    apiKeyRef: typeof raw.apiKeyRef === 'string' ? raw.apiKeyRef : DEFAULT_PROVIDER.apiKeyRef,
    dimensions: raw.dimensions
  }
  return { ...raw, embeddingProviders: [provider], embeddingActive: DEFAULT_PROVIDER.id }
}

/** 补齐 + 收敛一份设置。 */
export function normalize(raw) {
  const source = migrateLegacy(raw)
  const next = {}
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'embeddingProviders') {
      next.embeddingProviders = normalizeProviders(source?.embeddingProviders)
      continue
    }
    next[key] = coerce(key, source?.[key])
  }
  const ids = new Set(next.embeddingProviders.map((provider) => provider.id))
  const active = typeof source?.embeddingActive === 'string' ? source.embeddingActive : ''
  next.embeddingActive = ids.has(active) ? active : next.embeddingProviders[0].id
  return next
}

/** 当前生效的那套模型（永远返回一条，不会 undefined）。 */
export function activeProvider(settings) {
  const providers = settings.embeddingProviders ?? []
  const found = providers.find((provider) => provider.id === settings.embeddingActive)
  return found ?? providers[0] ?? DEFAULT_PROVIDER
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
