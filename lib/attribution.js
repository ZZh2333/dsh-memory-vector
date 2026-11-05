/**
 * dsh-memory-vector · 归因
 *
 * 一个问题：一块记忆被塞进了上下文，后来它真的被用到了吗？
 *
 * 为什么不用"再问一次模型"：那要再烧一遍 token，而且它的自述不可靠。
 * 这里只看一件事——回复里有没有复述这块记忆里的原话。
 *
 * 判据是窗口内的逐字重合（默认 12 个字）。选逐字而不是语义，是因为中文里
 * 连续 12 个字照抄，基本只能是"真的在读这段记忆"；反过来，模型换说法转述会漏判，
 * 这是有意的偏保守——宁可不给权重，也不虚抬。
 *
 * 另有第二道：回复与这一块的 bigram 重合率。两条任一命中就算用到。
 */

/** 回复里有没有 ≥window 个连续字符原样出现在这块记忆里。 */
export function sharesVerbatim(reply, text, window = 12) {
  const source = String(reply ?? '')
  const target = String(text ?? '')
  const size = Math.max(4, Number(window) || 12)
  if (source.length < size || target.length < size) return false
  for (let index = 0; index + size <= source.length; index += 1) {
    if (target.includes(source.slice(index, index + size))) return true
  }
  return false
}

function grams(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/\s+/g, '')
  const set = new Set()
  const chars = [...normalized]
  for (let index = 0; index < chars.length - 1; index += 1) set.add(chars[index] + chars[index + 1])
  return set
}

/** 回复有多大比例的二连字能在这一块里找到。 */
export function replyOverlap(reply, text) {
  const mine = grams(reply)
  if (mine.size === 0) return 0
  const pool = grams(text)
  let hit = 0
  for (const gram of mine) if (pool.has(gram)) hit += 1
  return hit / mine.size
}

/**
 * 一批注入块里，哪些真的被引用了。
 * @param {string} reply 本轮回复正文
 * @param {Array<{rowid:number,text:string}>} blocks 注入过的块
 * @param {{window?:number,minRatio?:number,maxUsed?:number}} options
 * @returns {{used:number[], verdicts:Array<{rowid:number,verbatim:boolean,ratio:number}>}}
 */
export function attributeReply(reply, blocks, options = {}) {
  const { window = 12, minRatio = 0.15, maxUsed = 3 } = options
  const text = String(reply ?? '').trim()
  const verdicts = []
  if (text === '' || !Array.isArray(blocks) || blocks.length === 0) return { used: [], verdicts }

  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const verbatim = sharesVerbatim(text, block.text, window)
    const ratio = verbatim ? 1 : replyOverlap(text, block.text)
    verdicts.push({ rowid: Number(block.rowid), verbatim, ratio })
  }

  verdicts.sort((left, right) => Number(right.verbatim) - Number(left.verbatim) || right.ratio - left.ratio)
  const used = verdicts
    .filter((entry) => entry.verbatim || entry.ratio >= minRatio)
    .slice(0, Math.max(1, Number(maxUsed) || 3))
    .map((entry) => entry.rowid)
  return { used, verdicts }
}
