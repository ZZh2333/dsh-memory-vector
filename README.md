# dsh-memory-vector · 记忆向量库

给 DeepSeek Harness 补上**五层记忆链的向量层**：对话原文落盘、切块向量化、关键词与向量混合召回。
接的是火山方舟 Agent Plan 的 `doubao-embedding-vision`（`/api/plan/v3/embeddings`）。

> 当前版本 **0.1.0（P0）**：L0 原文库 + 混合检索 + 设置页。L1 桥接 / L2 权重链 / L4 自述的参数已进设置页，行为待接入。

## 它做什么

```
session/event ──► 按 turn 聚合成块 ──► Ark /embeddings ──► sqlite（正文 + FTS5 + 归一化 float32 向量）
                                                                   │
memory_search(query) ◄── RRF 融合（bm25 名次 ⊕ 余弦名次）◄─────────┘
```

- **采集**：`session/event` 的 user/assistant 文本按回合拼块，`turn/end` 时入队，异步向量化。
  运行时注入的上下文（`source.kind === 'runtime-context'`）不入库。
- **存储**：`<DSH_HOME>/storages/memory-vector/index.sqlite`，正文和向量同一行，检索路径永远对得上。
- **中文检索**：FTS5 的 `unicode61` 会把整句中文当一个 token，所以额外存一列 CJK 重叠二元组，
  `记忆检索` → `记忆 忆检 检索`，否则中文关键词等于搜不到。
- **检索**：`memory_search` 工具，返回带 `sessionId#seq` 的块，可用 `session_event_read` 回溯原文。

## 隐私：什么会离开这台机器

只有**对话正文**，发往你配置的 `baseUrl`（默认 `https://ark.cn-beijing.volces.com/api/plan/v3`）做向量化，
请求头带 `apiKeyRef` 指向的凭证。向量和正文都留在本机 sqlite 里。

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
| 检索 | `topK` / `minScore` / `maxHitsPerSession` / `contextChars` / `hybrid` | 召回条数与预算 |
| 向量模型 | `model` / `dimensions` / `baseUrl` / `apiKeyRef` / `timeoutMs` / `batchSize` | 换模型或维度需要重建索引 |
| L1 桥接 | `bridgeEnabled` / `bridgeScope` / `bridgeDays` / `bridgeMessages` | 待接入（P2） |
| L2 权重 | `weightsEnabled` / `halfLifeDays` / `maxEntries` / `refreshTurns` | 待接入（P3） |
| L4 自述 | `selfNoteEnabled` / `maxEntries` / `budgetChars` | 待接入（P4） |

`bridgeScope` 支持 `workspace-latest`（同工作区最近一场）与 `recent-days`（最近 N 天，N 可配）。

## 自检

```powershell
$env:ARK_CODE_LATEST_API_KEY='...'
node tests/e2e.mjs
```

会真调一次 embedding：3 条种子 → 写入 → 4 个中文语义查询 + 1 个专有名词查询，全部断言命中才算过。

## 已知限制

- 向量检索是暴力余弦（个人量级万块以内够用），没有 ANN 索引；
- 历史会话回填（读 `session.v4.jsonl.zstd`）还没做，需要走 `sessionQuery`，排在 P3；
- 换模型或维度后旧向量会因维度不匹配被跳过，需要清空重建；
- L1/L2/L4 目前只有参数与占位，没有行为。

## 设计取舍

- **插件而不是改核心**：核心包在 asar 里，改了会被升级覆盖；接缝（`session/event`、`ctx.tools`、`webServer`）已经够用。
- **不写新事件类型**：`Session.append()` 不能打 `ignorable` 标记，写了新类型会让会话无法再打开，所以状态全在插件自己的 sqlite 里。
- **不阻塞主链路**：采集全异步；检索 1.5s 硬超时，失败静默降级为空结果。
