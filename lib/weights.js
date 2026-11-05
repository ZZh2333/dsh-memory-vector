/**
 * dsh-memory-vector · L2 长期权重链
 *
 * 一条记忆的"分量"由两件事决定：被用过几次（强化），以及多久没被用过（遗忘）。
 * 用的是艾宾浩斯那套：R = e^(-t/halfLife)，再乘上次数带来的强度 1 + ln(1+hits)。
 *
 * 权重只做两件事，都不碰提示词的措辞：
 *   1. 检索排序里做加权（RRF × (1 + α·ln(1+w))）；
 *   2. 定期把最强的一批写成快照，落进 AGENT.md 的受管章节。
 *
 * 快照是「事实清单」，不是「人格」。写进去的每条都必须带 sessionId#seq 锚点，
 * 方便下个会话回溯原文——这也是防止自我叙述漂移的第一道闸。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const MANAGED_START = '<!-- managed:memory-weights start -->'
export const MANAGED_END = '<!-- managed:memory-weights end -->'

/**
 * 艾宾浩斯权重：次数带来的强度 × 时间衰减 × 死重惩罚。
 *
 * ⚠️ 这里的次数是「真被引用」的次数（used），不是「被塞进上下文」的次数（injected）。
 * 混为一谈会让权重变成"最常被注入的排最前"，那是自我强化，不是记忆。
 * 灌进去很多次却一次没被引用的，乘一个惩罚系数——它占着位置不干活。
 */
export function decayWeight(input) {
  const {
    used,
    hits,
    injected = 0,
    lastUsedAt,
    lastHitAt,
    createdAt,
    now,
    halfLifeDays,
    deadAfterInjections = 3,
    deadWeightPenalty = 0.6
  } = input
  const count = Math.max(0, Number(used ?? hits ?? 0))
  const anchorAt = Number(lastUsedAt ?? lastHitAt ?? 0)
  const anchor = anchorAt > 0 ? anchorAt : createdAt
  const days = Math.max(0, (now - anchor) / 86400000)
  const halfLife = Math.max(0.5, Number(halfLifeDays) || 21)
  const decay = Math.pow(0.5, days / halfLife)
  const strength = 1 + Math.log1p(count)
  const dead = count === 0 && Number(injected) >= Math.max(1, Number(deadAfterInjections) || 3)
  const penalty = dead ? Math.min(1, Math.max(0, Number(deadWeightPenalty) || 0.6)) : 1
  return strength * decay * penalty
}

/** 给候选块算权重、排序、截断。 */
export function rankWeights(rows, options) {
  const { now, halfLifeDays, limit, deadAfterInjections, deadWeightPenalty } = options
  const scored = rows.map((row) => ({
    ...row,
    weight: decayWeight({
      used: row.used,
      injected: row.injected,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      now,
      halfLifeDays,
      deadAfterInjections,
      deadWeightPenalty
    })
  }))
  scored.sort((left, right) => right.weight - left.weight || Number(right.used ?? 0) - Number(left.used ?? 0))
  return scored.slice(0, Math.max(1, limit))
}

function clip(text, limit) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(1, limit - 1))}…`
}

function daysAgo(at, now) {
  if (at <= 0) return null
  return Math.max(0, Math.floor((now - at) / 86400000))
}

/** 快照正文（不含标记本身）。 */
export function renderSnapshot(entries, options) {
  const { now, halfLifeDays, zh = true } = options
  const lines = []
  lines.push(
    zh
      ? `> 由 dsh-memory-vector 自动维护：按「引用次数 × 时间衰减」给记忆排序，半衰期 ${halfLifeDays} 天。`
      : `> Maintained by dsh-memory-vector: ranked by usage × time decay, half-life ${halfLifeDays} days.`
  )
  lines.push(
    zh
      ? '> 这里只放事实和出处，不放语气、不放承诺。要改请在设置页调参数，不要手改这段。'
      : '> Facts and provenance only. Tune it from the settings page; do not hand-edit this block.'
  )
  lines.push('')
  lines.push(zh ? `更新时间：${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}` : `updated: ${new Date(now).toISOString()}`)
  lines.push('')
  if (entries.length === 0) {
    lines.push(zh ? '（还没有被用到过的记忆。）' : '(no memory has been recalled yet.)')
    return lines.join('\n')
  }
  for (const entry of entries) {
    const ago = daysAgo(entry.lastUsedAt ?? entry.lastHitAt, now)
    const used = Number(entry.used ?? entry.hits ?? 0)
    const injected = Number(entry.injected ?? 0)
    const meta = zh
      ? `引用 ${used} 次${injected > used ? ` / 注入 ${injected} 次` : ''}${ago === null ? '' : `，最后 ${ago} 天前`}，权重 ${entry.weight.toFixed(2)}`
      : `${used} used / ${injected} injected${ago === null ? '' : `, last ${ago}d ago`}, weight ${entry.weight.toFixed(2)}`
    lines.push(`- \`${entry.sessionId}#${entry.seq}\` ${clip(entry.text, 160)}（${meta}）`)
  }
  return lines.join('\n')
}

/** 完整的受管块（含标记）。 */
export function renderManagedBlock(entries, options) {
  const body = renderSnapshot(entries, options)
  return `${MANAGED_START}\n${body}\n${MANAGED_END}\n`
}

/**
 * 把受管块贴进文件内容：有旧块就替换，没有就追加到文件末尾。
 * 文件里受管块之外的内容，一个字都不会被碰。
 */
export function applyManagedBlock(existing, block) {
  const text = typeof existing === 'string' ? existing : ''
  const start = text.indexOf(MANAGED_START)
  const end = text.indexOf(MANAGED_END)
  if (start >= 0 && end > start) {
    const after = end + MANAGED_END.length
    const tail = text.slice(after).replace(/^\n+/, '')
    const head = text.slice(0, start).replace(/\n+$/, '')
    return `${head === '' ? '' : head + '\n\n'}${block}${tail === '' ? '' : '\n' + tail}`
  }
  const trimmed = text.replace(/\n+$/, '')
  return `${trimmed === '' ? '' : trimmed + '\n\n'}${block}`
}

/** 是否到了该重写快照的时候。 */
export function isDue(input) {
  const { mode, hours, turns, lastAt, lastTurn, turn, now } = input
  if (mode === 'manual') return false
  if (mode === 'turns') {
    if (lastTurn === null || lastTurn === undefined) return true
    return Number(turn) - Number(lastTurn) >= Math.max(1, Number(turns) || 20)
  }
  // daily
  if (lastAt === null || lastAt === undefined || lastAt === 0) return true
  return now - Number(lastAt) >= Math.max(1, Number(hours) || 24) * 3600000
}

/** 相对路径 → 绝对路径；默认落在 DSH 主目录的 AGENT.md。 */
export function resolveTarget(home, target) {
  const raw = typeof target === 'string' && target.trim() !== '' ? target.trim() : 'AGENT.md'
  return join(home, raw)
}

/** 读、改、写。文件不存在就新建；写盘用临时文件 + 重命名，避免写一半。 */
export function writeManaged(filePath, block) {
  let existing = ''
  try {
    existing = readFileSync(filePath, 'utf8')
  } catch {
    existing = ''
  }
  const next = applyManagedBlock(existing, block)
  if (next === existing) return { changed: false, path: filePath }
  mkdirSync(dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp`
  writeFileSync(temp, next, 'utf8')
  renameSync(temp, filePath)
  return { changed: true, path: filePath }
}
