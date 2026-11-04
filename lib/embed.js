/**
 * dsh-memory-vector · 向量化客户端
 *
 * 只做一件事：把若干段文本变成若干条归一化向量。
 * - OpenAI 兼容 /embeddings，接方舟 Agent Plan（必须 /plan 的 base URL）。
 * - 请求带超时；失败抛 EmbedError，由调用方决定是降级还是重试。
 * - 写入前就归一化，检索时点积即余弦，省一次遍历。
 */

export class EmbedError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'EmbedError'
    this.code = options.code ?? 'EMBED_FAILED'
    this.status = options.status
  }
}

/**
 * 归一化到单位长度；全零向量原样返回（调用方会当成无效块丢弃）。
 * @param {number[]} vector
 * @returns {Float32Array}
 */
export function toUnitVector(vector) {
  const out = new Float32Array(vector.length)
  let sum = 0
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(vector[index]) || 0
    out[index] = value
    sum += value * value
  }
  if (sum <= 0) return out
  const scale = 1 / Math.sqrt(sum)
  for (let index = 0; index < out.length; index += 1) out[index] *= scale
  return out
}

/** 单条文本 → 向量（内部走批量接口）。 */
export async function embedTexts(texts, options) {
  const {
    baseUrl,
    apiKey,
    model,
    dimensions,
    timeoutMs = 8000,
    signal
  } = options
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new EmbedError('没有可用的 API Key：请检查凭证引用名是否配置正确', { code: 'NO_KEY' })
  }
  const url = `${String(baseUrl).replace(/\/+$/, '')}/embeddings`
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs))
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: texts,
        ...(dimensions === undefined ? {} : { dimensions })
      }),
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    throw new EmbedError(
      controller.signal.aborted ? `向量化请求超时（${timeoutMs}ms）` : `向量化请求失败：${error?.message ?? error}`,
      { code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK' }
    )
  }
  clearTimeout(timer)
  if (signal !== undefined) signal.removeEventListener('abort', onAbort)

  if (!response.ok) {
    let detail = ''
    try {
      const text = await response.text()
      detail = text.slice(0, 400)
    } catch {
      detail = ''
    }
    throw new EmbedError(`向量化接口返回 ${response.status}${detail === '' ? '' : `：${detail}`}`, {
      code: 'HTTP',
      status: response.status
    })
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new EmbedError(`向量化响应不是合法 JSON：${error?.message ?? error}`, { code: 'BAD_JSON' })
  }
  const rows = Array.isArray(payload?.data) ? payload.data : []
  if (rows.length !== texts.length) {
    throw new EmbedError(`向量化返回条数不匹配：请求 ${texts.length}，返回 ${rows.length}`, { code: 'BAD_COUNT' })
  }
  const vectors = rows
    .slice()
    .sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0))
    .map((row) => {
      const embedding = row?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new EmbedError('向量化响应缺少 embedding', { code: 'BAD_VECTOR' })
      }
      return toUnitVector(embedding)
    })

  return {
    vectors,
    dimension: vectors[0]?.length ?? 0,
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens ?? 0) || 0,
      totalTokens: Number(payload?.usage?.total_tokens ?? 0) || 0
    }
  }
}

/** 点积 = 余弦（两边都已归一化）。 */
export function dot(left, right) {
  if (left === undefined || right === undefined || left.length !== right.length) return 0
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index]
  return sum
}
