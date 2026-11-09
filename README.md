# dsh-memory-vector · 记忆向量库

给 DeepSeek Harness 补上**五层记忆链的向量层**：对话原文落盘、切块向量化、关键词与向量混合召回。
接的是火山方舟 Agent Plan 的 `doubao-embedding-vision`（`/api/plan/v3/embeddings`）。

> 当前版本 **0.12.0**：L0 原文库 + 混合检索 + 每轮自动回想（P1）+ L1 跨会话桥接（P2）+ L2 长期权重（P3）+ L4 自我叙述（P4）+ L3 交付物索引（P5）+ 历史回填 + 跨工作区范围 + 注入归因与记忆体检 + 空白工作区自检 + 清空前自动快照 + 注入节流 + 设置页 + 多套向量化模型可切换。

> **0.9.1–0.9.2 修了什么**：采集从"黑名单"改成"白名单"——只认 `source.kind === 'user'` 的用户消息。
> 0.9.0 之前只排除 `runtime-context` / `command-result` 两种，结果插件自己的召回注入
> 被当成用户发言存进库，再被召回，记忆自己引用自己。
> 0.9.2 又补了一道兜底：宿主可能把注入以 `user` 身份落盘，来源就骗不了人了，
> 所以正文以 `【记忆·自动回想】` 开头的消息一律不收。宿主追加的 `<system-reminder>` 也会被剥掉。
> 已有脏数据需要 `清除记忆` 后重新回填。

## 它做什么

```
session/event ──► 按 turn 聚合成块 ──► Ark /embeddings ──► sqlite（正文 + FTS5 + 归一化 float32 向量）
                                                                   │
agent/pre-step ──► 自动回想（每轮首步）◄── RRF 融合（bm25 名次 ⊕ 余弦名次）──► memory_search(query)

systemPrompt.context('memory-vector:bridge') ◄── sessionQuery.readSurface(上一场) ◄── 本地会话日志
```

- **采集**：`session/event` 的 user/assistant 文本按回合拼块，`turn/end` 时入队，异步向量化。
  运行时注入的上下文（`source.kind === 'runtime-context'`）不入库。
- **自动回想（P1）**：每轮第一个步骤，按你这句话检索记忆，命中就作为一条 `source.kind = memory-vector`
  的用户消息插在你后面，带 `sessionId#seq` 溯源。同一轮不重复、跨轮同内容也不重复（它已经在历史里了），
  字符预算独立（`injectChars`，0.12.0 起默认 **350**）——注入的内容会永久留在会话里，
  之后每一轮请求都要重发一次，所以比手动检索省得多。
  0.12.0 又加了两道闸：`injectMinScore`（自动注入的相关性门槛，默认 0.5，比手动检索的
  `minScore` 高）和 `injectEveryTurns`（最多每 N 轮注入一次，默认 2）。
  关掉 `injectEnabled` 就只剩工具按需检索。
  **空白工作区自检**：第一次在某个工作区说话、那里面一条记忆都没有时，注入里会明说一句
  「这里我什么都没有」——否则"检索不到"和"我记得但没想起来"在我这边长一个样。
  每个会话只提一次（`coldStartNotice`）。
- **跨会话桥接（P2）**：新会话开场时，把上一场对话的尾巴挂进系统提示的固定位置，
  走 `systemPrompt.context` 而不是塞进消息列表——位置固定、内容恒等，前缀缓存不会被打断。
  内容只来自本机会话日志（`sessionQuery`），不外发；压缩摘要、插件注入、子智能体会话都会被剔除。
- **长期权重（P3）**：每次**真正被引用**的块才记一次「用到」（`used`）。权重 =
  `(1 + ln(1+used)) × 0.5^(天数 / 半衰期)`——用得多的记得牢，久不用的自然淡出。
  0.10.0 起**注入 ≠ 引用**：注入只记 `injected`、不涨权重；要等这一轮回复出来，回复里逐字
  复述了这块记忆（连续 `attributeWindow` 字，默认 12）或二连字重合率过线，才记一次 `used`。
  注入了 `deadAfterInjections` 次却一次没被引用的判为「死重」，权重乘 `deadWeightPenalty`
  （默认 0.6）——**只降权，不删**：删了就没法回头验证判定器是不是判错了。
  设置页「记忆体检」卡片会摆出注入利用率、死重清单和近 7 天入库曲线。
  权重只影响排序，不进提示词；定期把最强的一批写成快照，落进 `memory/weights.md` 里
  `<!-- managed:memory-weights start -->` 与 `end` 之间的受管章节，**之外的内容一个字都不动**。
  刷新节奏可选 `daily`（默认，按小时）/ `turns`（按轮）/ `manual`（只手动），
  内容没变就不写盘。
  ⚠️ 0.12.0 把快照的默认目标从 `AGENT.md` 挪到了 `memory/weights.md`：
  `AGENT.md` 整份进系统提示、每请求付一次钱，实测那段 3430 字的清单吃掉了人格文件 83% 的长度
  （约 2100 token / 请求），而它大半没人读。挪出来以后它变成「要查才读」的普通文件，
  权重排序照旧（读的是数据库）。**不要改回 AGENT.md**，除非你确实要它每轮都在眼前。
- **自我叙述（P4）**：`self_note_write` 工具让我记「关于自己的事实」——只收带 `sessionId#seq`
  锚点的陈述句，有禁语表（情绪/自评/承诺/身份改写）、原文重叠 ≥30% 校验、只增不删、
  超上限归档。写在 `memory/self-note.md`，**故意不碰 AGENT.md**：人格是主人写的。
  规则全文见 [`docs/l4-antidrift.md`](docs/l4-antidrift.md)。
  ⚠️ 这一层**没有自我触发能力**：`noteRateTurns` 只是限速（每 N 轮最多一条），不是催写。
  所以 0.9.3 加了 `noteNudgeTurns`（默认 20）：超过 N 轮没更新，就在系统提示末尾追加一句
  「有没有可核对的新事实，要不要记一条」，约 60 字；写满 `maxNoteEntries` 就不催；设 0 关掉。
  0.11.0 起**不再全量注入**：按与当前问题的词面重合挑 top `noteTopK`（默认 3），
  一条都不相关时只留最近 `noteFallbackCount` 条（默认 2）——宁可少给，也不把预算铺在没人看的条目上；
  `noteTopK = 0` 回到"全量按时间塞"。
- **交付物索引（P5）**：监听 `tool/call`，`write` / `edit` / `str-replace-editor` 记「新建·修改」，
  `present` 记「交付」。只存路径 + `sessionId#turn` + 时间，**不读文件内容、不出本机**。
  `deliverable_search` 查；默认只看当前工作区，跨区要显式 `all: true`；
  **默认只对主会话开放**，子智能体调用会被拒。
- **历史回填**：设置页「预览开销」→「开始回填」。把插件装上之前的旧会话按轮聚块补进原文库，
  让检索有时间纵深、权重有更早的锚点。两条硬约束：**先预览再确认**（要花向量化 token）、
  **处理过的会话记账不重复**（`backfill_sessions` 表）。场次与块数都有上限。
  回填不恢复 `hits`——历史上没人检索过，补进来的块按创建时间起算衰减，这正是艾宾浩斯该有的样子。
- **清空索引（危险）**：0.11.1 起，清空前先 `VACUUM INTO` 落一份完整快照到
  `index.sqlite.bak-<时间戳>`，保留最近 3 份，返回路径给设置页显示。
  「不可撤销」是这个按钮的设计意图，但不该等于「不能后悔」——
  2026-11-05 有人点过一次，81 块当场归零，全靠会话日志还能回填才没真丢。
- **存储**：`<DSH_HOME>/storages/memory-vector/index.sqlite`，正文和向量同一行，检索路径永远对得上。
- **中文检索**：FTS5 的 `unicode61` 会把整句中文当一个 token，所以额外存一列 CJK 重叠二元组，
  `记忆检索` → `记忆 忆检 检索`，否则中文关键词等于搜不到。
- **检索**：`memory_search` 工具，返回带 `sessionId#seq` 的块，可用 `session_event_read` 回溯原文。
- **跨工作区**：`retrievalScope` 三档——`workspace-first`（默认，本工作区整体提前，外区仍可召回）、
  `workspace`（只认本工作区）、`global`（不分工作区）。桥接、交付物、回填另有一层工作区隔离，
  与检索范围互不影响。

## 它到底花多少 token

三处，量级差很远（实测于 152 块 / 12.8 万字的库）：

| 位置 | 何时计费 | 实测 |
|---|---|---|
| 权重快照 | 每次请求，直到你把它挪走 | 3430 字 ≈ 2100 token **/请求** |
| 自动回想注入 | 注入那一轮 **+ 之后每一轮重发** | 350 字 ≈ 230 token，累积计费 |
| 向量化（embedding） | 只在写入和检索时 | 每轮问题约 30 token；全库一次性约 8 万 |

关键区别：**注入进对话的内容会一直躺在历史里**，后面每轮请求都要重发一遍。一个 20 轮会话
若 15 轮都有注入，累计约 430×180 ≈ 7.7 万 token——均摊每轮多 4 千。所以真正该省的不是
"哪一次查得多"，而是"查得多频繁、塞得多长"。

0.12.0 的对策就是按这个账改的：快照挪出系统提示、注入加相关性门槛、加间隔闸、预算砍半。

## 多套向量化模型

嵌入模型不是写死的：`embeddingProviders` 是一个数组，`embeddingActive` 指向当前生效的那一套。
设置页里可以增删、逐套改参数、逐套「测试连通」，用单选决定谁生效——**切换只改指针，不动历史块**。

```json
{
  "embeddingActive": "ark-plan",
  "embeddingProviders": [
    {
      "id": "ark-plan",
      "label": "方舟 Agent Plan",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
      "apiKeyRef": "ARK_CODE_LATEST_API_KEY",
      "model": "doubao-embedding-vision",
      "dimensions": 1024,
      "timeoutMs": 8000,
      "batchSize": 8
    },
    {
      "id": "local-bge",
      "label": "本地 bge-m3",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "apiKeyRef": "",
      "model": "bge-m3",
      "dimensions": 1024,
      "timeoutMs": 20000,
      "batchSize": 4
    }
  ]
}
```

规则：

- **`id`** 小写字母/数字/连字符，重复会自动加 `-2` 后缀；删到只剩一套时不允许再删。
- **`apiKeyRef` 留空 = 不带 `Authorization`**，给本地 llama.cpp / ollama 这类无鉴权服务用；填了名字就按 `.credentials.yaml` 的 `refs` 解析。
- **`dimensions`** 必须与模型实际输出一致（设置页「测试」会回报真实维度并对比配置值）。
- 换模型或换维度后，旧块的向量与新维度不匹配：**仍可被关键词命中，但不参与向量召回**，页面会提示索引里有几种向量。
- 从 0.1.0 升级：旧的扁平字段（`baseUrl` / `model` / `apiKeyRef` / `dimensions`）会自动迁移成一套 provider，不用重配。

## 隐私：什么会离开这台机器

只有**对话正文**，发往当前生效那套 `baseUrl` 做向量化，请求头按 `apiKeyRef` 解析出的凭证。
向量和正文都留在本机 sqlite 里。

- 采集默认**关闭**，要在设置页手动打开；
- 关闭后不再新增，但已写入的块仍在，需要手动「清空索引」；
- 凭证只按引用名解析（默认 `ARK_CODE_LATEST_API_KEY`），插件从不读取、也不落盘密钥本身；
- 可以用 `excludeWorkspaces` 按路径片段排除工作区（例如 `secrets,work-temp`）。

## 安装

在 DSH 里用插件管理器安装本目录（安装后会出现在「设置 → 插件」列表，并在「设置 → 记忆」提供配置页）：

```
plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

装完重启一次 Harness，让 Host 侧注册 `memory_search` 并开放 `/api/memory-vector/*`。

## 设置项

设置 → **记忆**。所有参数都落在 `<DSH_HOME>/storages/memory-vector/settings.json`，
`lib/settings.js` 的 `SCHEMA` 是唯一真源，页面按宿主下发的 schema 渲染，不在前端硬编码字段。

| 组 | 关键参数 | 说明 |
|---|---|---|
| L0 采集 | `ingestEnabled` / `minTurnChars` / `maxChunkChars` / `excludeWorkspaces` | 采集开关与切块粒度 |
| 历史回填 | `backfillMaxSessions` / `backfillMaxChunks` / `backfillOnlyWorkspace` | 一次补多少、补哪些 |
| 检索 | `topK` / `minScore` / `maxHitsPerSession` / `contextChars` / `hybrid` / `retrievalScope` / `injectEnabled` / `injectChars` | 召回条数、预算、跨工作区范围、自动回想开关 |
| 向量模型 | `embeddingProviders[]` / `embeddingActive` | 多套并存，逐套 `model` / `dimensions` / `baseUrl` / `apiKeyRef` / `timeoutMs` / `batchSize` |
| L1 桥接 | `bridgeEnabled` / `bridgeScope` / `bridgeDays` / `bridgeMessages` / `bridgeChars` | 同工作区最近一场（或 N 天内最多三场）的尾巴 |
| L3 交付物 | `deliverablesEnabled` / `deliverableTools` / `deliverableScope` / `maxDeliverables` / `deliverablesOwnerOnly` | 文件路径 + 出处，不含内容 |
| L2 权重 | `weightsEnabled` / `halfLifeDays` / `maxEntries` / `weightsRefreshMode` / `weightsRefreshHours` / `refreshTurns` / `weightsTarget` | 艾宾浩斯权重 + 快照节奏 |
| L4 自述 | `selfNoteEnabled` / `requireApproval` / `pendingTtlHours` / `maxNoteEntries` / `budgetChars` / `noteRateTurns` / `auditEvery` / `selfNoteTarget` | 带锚点的事实清单 |

`bridgeScope` 支持 `workspace-latest`（同工作区最近一场）与 `recent-days`（同工作区最近 N 天内最多三场，N 可配）。
桥接正文进系统提示，**每次请求都要付这份 token**，所以另有 `bridgeChars` 预算（默认 1200）。

`weightsRefreshMode` 三选一：`daily`（按 `weightsRefreshHours`，默认 24 小时＝一天一次）、
`turns`（按 `refreshTurns`）、`manual`（只在设置页点「立即刷新」）。权重是慢变量，一天一次足够；
`weightsTarget` 默认 `AGENT.md`，也可以指向别的文件。

## 自检

```powershell
node tests/unit.mjs                                  # 离线：事件抽取 / 切块 / 设置收敛 / 多套模型 / 桥接渲染 / 中文分词
$env:ARK_CODE_LATEST_API_KEY='...'
node tests/host-smoke.mjs                            # 假 ctx 跑 apply()：多套模型 / 自动回想 / 桥接 / 全部同源 API（不碰真实 DSH_HOME）
node tests/e2e.mjs                                   # 真调 /embeddings：写入 → 4 个语义查询 + 1 个专有名词查询
```

## 已知限制

- 向量检索是暴力余弦（个人量级万块以内够用），没有 ANN 索引；
- 历史会话回填（读 `session.v4.jsonl.zstd`）还没做，需要走 `sessionQuery`，排在 P3；
- 换模型或维度后旧向量会因维度不匹配被跳过，需要清空重建；
- L1/L2/L4 目前只有参数与占位，没有行为。

## 设计取舍

- **插件而不是改核心**：核心包在 asar 里，改了会被升级覆盖；接缝（`session/event`、`ctx.tools`、`webServer`）已经够用。
- **不写新事件类型**：`Session.append()` 不能打 `ignorable` 标记，写了新类型会让会话无法再打开，所以状态全在插件自己的 sqlite 里。
- **不阻塞主链路**：采集全异步；检索 1.5s 硬超时，失败静默降级为空结果。
