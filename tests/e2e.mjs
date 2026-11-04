/**
 * 端到端自检（不依赖 Host）：真调方舟 embedding，验证
 * 切片文本 → 向量 → 存库 → 关键词 + 向量融合检索 这条链路。
 *
 * 用法：
 *   $env:ARK_CODE_LATEST_API_KEY='...'; node tests/e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { embedTexts } from '../lib/embed.js'
import { ftsQuery, ftsText, MemoryStore } from '../lib/store.js'
import { rankCandidates, selectHits } from '../lib/retrieval.js'

const KEY = process.env.ARK_CODE_LATEST_API_KEY ?? ''
const MODEL = 'doubao-embedding-vision'
const BASE = 'https://ark.cn-beijing.volces.com/api/plan/v3'
const DIM = 1024

const SEED = [
  {
    sessionId: 'session-aaaa',
    seq: 12,
    cwd: 'D:\\projects\\demo',
    text:
      '用户问了 DSH 记忆怎么接入向量化模型。我给的五层方案是：L0 原文库落盘、L1 会话桥接摘要、L2 艾宾浩斯权重链、L3 产物索引、L4 selfNote 自我叙述。结论是先写一个 Host 插件 dsh-memory-vector，复用 Agent Plan 的 /embeddings 接口。'
  },
  {
    sessionId: 'session-bbbb',
    seq: 7,
    cwd: 'C:\\Users\\demo\\.dsh',
    text:
      '审查插件的安全清单：它会把什么数据发到哪些网址；会不会读我的文件、密钥和账号登录信息；有没有加密后再执行的代码；安装时会不会自动下载或运行别的东西；装上以后会不会自己启动、自己发消息。'
  },
  {
    sessionId: 'session-cccc',
    seq: 3,
    cwd: 'D:\\projects\\demo',
    text: '子非鱼最爱的食物是大白饭，虽然穿越后没有进食功能，但每次看到还是会嘴馋。这条是人格设定里的偏好，不属于技术记忆。'
  }
]

function assertBigram() {
  assert.equal(ftsText('记忆检索'), ' 记忆 忆检 检索 ')
  assert.equal(ftsText('abc 记忆'), 'abc  记忆 ')
  const expression = ftsQuery('记忆 检索')
  assert.ok(expression.includes('"记忆"'), expression)
  console.log('ok · 中文二元组切分')
}

async function main() {
  assertBigram()

  if (KEY === '') {
    console.log('skip · 没有 ARK_CODE_LATEST_API_KEY，只跑了离线断言')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'dmv-'))
  const store = await MemoryStore.open(join(dir, 'index.sqlite'), { dimension: DIM, model: MODEL })
  try {
    const { vectors, dimension, usage } = await embedTexts(
      SEED.map((item) => item.text),
      { baseUrl: BASE, apiKey: KEY, model: MODEL, dimensions: DIM, timeoutMs: 20000 }
    )
    assert.equal(dimension, DIM)
    assert.equal(vectors.length, SEED.length)
    console.log(`ok · 向量化 ${SEED.length} 条，维度 ${dimension}，tokens ${usage.totalTokens}`)

    SEED.forEach((item, index) => {
      const added = store.addChunk({
        id: `chunk-${index}`,
        sessionId: item.sessionId,
        cwd: item.cwd,
        seq: item.seq,
        turn: index + 1,
        text: item.text,
        vector: vectors[index],
        dim: dimension,
        model: MODEL
      })
      assert.equal(added, true)
    })
    assert.equal(store.addChunk({
      id: 'chunk-dup',
      sessionId: SEED[0].sessionId,
      seq: 99,
      text: SEED[0].text,
      vector: vectors[0],
      dim: dimension,
      model: MODEL
    }), false)
    console.log('ok · 写入 + 去重')

    const stats = store.stats()
    assert.equal(stats.chunks, SEED.length)
    assert.equal(stats.sessions, 3)
    console.log(`ok · 统计 chunks=${stats.chunks} sessions=${stats.sessions} size=${stats.sizeBytes}B`)

    const cases = [
      { query: '上次那个把记忆接向量化的方案是怎么定的', expect: 'session-aaaa' },
      { query: '装插件前要检查哪些安全问题', expect: 'session-bbbb' },
      { query: '子非鱼喜欢吃什么', expect: 'session-cccc' },
      { query: 'doubao-embedding-vision 这个模型', expect: 'session-aaaa' }
    ]

    for (const item of cases) {
      const queryEmbed = await embedTexts([item.query], {
        baseUrl: BASE,
        apiKey: KEY,
        model: MODEL,
        dimensions: DIM,
        timeoutMs: 20000
      })
      const ordered = rankCandidates({ store, query: item.query, queryVector: queryEmbed.vectors[0], hybrid: true })
      const hits = selectHits({
        store,
        ordered,
        topK: 3,
        minScore: 0.3,
        maxHitsPerSession: 2,
        contextChars: 2000
      })
      assert.ok(hits.length > 0, `没有召回：${item.query}`)
      const top = hits[0]
      const matched = hits.some((hit) => hit.sessionId === item.expect)
      console.log(
        `ok · "${item.query}" → top=${top.sessionId}#${top.seq} cos=${Number(top.similarity ?? 0).toFixed(3)}` +
          ` fts=${top.ftsRank ?? '-'} vec=${top.vecRank ?? '-'} 期望命中=${matched ? 'yes' : 'NO'}`
      )
      assert.ok(matched, `期望 ${item.expect} 出现在结果里：${item.query}`)
      assert.ok(top.similarity === null || top.similarity > 0.3, '相似度低于阈值')
    }

    // 关键词通路单独验证：专有名词不该只靠向量
    const ftsOnly = store.searchFts('embeddings', 5)
    assert.ok(ftsOnly.length >= 1, 'FTS 没命中专有名词')
    console.log(`ok · FTS 专有名词命中 ${ftsOnly.length} 条`)

    store.clear()
    assert.equal(store.stats().chunks, 0)
    console.log('ok · 清空')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('FAIL ·', error?.message ?? error)
  process.exitCode = 1
})
