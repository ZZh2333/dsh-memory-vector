# dsh-memory-vector · 记忆向量库

给 DeepSeek Harness 补上**五层记忆链的向量层**：对话原文落盘、切块向量化、关键词与向量混合召回。
接的是火山方舟 Agent Plan 的 `doubao-embedding-vision`（`/api/plan/v3/embeddings`）。

> 当前版本 **0.3.0**：L0 原文库 + 混合检索 + **每轮自动回想（P1）** + 设置页 + 多套向量化模型可切换。L1 桥接 / L2 权重链 / L4 自述的参数已进设置页，行为待接入。

## 它做什么

```
session/event ──► 按 turn 聚合成块 ──► Ark /embeddings ──► sqlite（正文 + FTS5 + 归一化 float32 向量）
                                                                   │
agent/pre-step ──► 自动回想（每轮首步）◄── RRF 融合（bm25 名次 ⊕ 余弦名次）──► memory_search(query)
```

- **采集**：`session/event` 的 user/assistant 文本按回合拼块，`turn/end` 时入队，异步向量化。
  运行时注入的上下文（`source.kind === 'runtime-context'`）不入库。
- **自动回想（P1）**：每轮第一个步骤，按你这句话检索记忆，命中就作为一条 `source.kind = memory-vector`
  的用户消息插在你后面，带 `sessionId#seq` 溯源。同一轮不重复、跨轮同内容也不重复（它已经在历史里了），
  字符预算独立（`injectChars`，默认 1500）——注入的内容会永久留在会话里，所以比手动检索更省。
  关掉 `injectEnabled` 就只剩工具按需检索。
- **存储**：`<DSH_HOME>/storages/memory-vector/index.sqlite`，正文和向量同一行，检索路径永远对得上。
- **中文检索**：FTS5 的 `unicode61` 会把整句中文当一个 token，所以额外存一列 CJK 重叠二元组，
  `记忆检索` → `记忆 忆检 检索`，否则中文关键词等于搜不到。
- **检索**：`memory_search` 工具，返回带 `sessionId#seq` 的块，可用 `session_event_read` 回溯原文。

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
| 检索 | `topK` / `minScore` / `maxHitsPerSession` / `contextChars` / `hybrid` / `injectEnabled` / `injectChars` | 召回条数、预算、自动回想开关 |
| 向量模型 | `embeddingProviders[]` / `embeddingActive` | 多套并存，逐套 `model` / `dimensions` / `baseUrl` / `apiKeyRef` / `timeoutMs` / `batchSize` |
| L1 桥接 | `bridgeEnabled` / `bridgeScope` / `bridgeDays` / `bridgeMessages` | 待接入（P2） |
| L2 权重 | `weightsEnabled` / `halfLifeDays` / `maxEntries` / `refreshTurns` | 待接入（P3） |
| L4 自述 | `selfNoteEnabled` / `maxNoteEntries` / `budgetChars` | 待接入（P4） |

`bridgeScope` 支持 `workspace-latest`（同工作区最近一场）与 `recent-days`（最近 N 天，N 可配）。

## 自检

```powershell
node tests/unit.mjs                                  # 离线：事件抽取 / 切块 / 设置收敛 / 多套模型 / 中文分词
$env:ARK_CODE_LATEST_API_KEY='...'
node tests/host-smoke.mjs                            # 假 ctx 跑 apply()：多套模型 / 自动回想 / 全部同源 API（不碰真实 DSH_HOME）
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
