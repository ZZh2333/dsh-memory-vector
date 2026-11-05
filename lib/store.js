/**
 * dsh-memory-vector · 索引存储
 *
 * 正文也落库（原文库），向量以归一化 float32 blob 存在同一行：
 * 这样"检索路径"和"原文"永远对得上，不依赖外部文件是否被改动。
 *
 * 中文检索：FTS5 的 unicode61 会把整句中文当成一个 token，等于搜不到。
 * 所以额外存一列 fts_text，把 CJK 串拆成二元组（重叠 bigram），
 * 英文/代码保持原样。牺牲一点索引体积，换中文可用。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 1
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g

/** CJK 串 → 重叠二元组；其它字符原样保留。 */
export function ftsText(input) {
  return String(input).replace(CJK, (run) => {
    const chars = [...run]
    if (chars.length === 1) return ` ${chars[0]} `
    const grams = []
    for (let index = 0; index < chars.length - 1; index += 1) grams.push(chars[index] + chars[index + 1])
    return ` ${grams.join(' ')} `
  })
}

/** FTS5 查询串：每个词独立打引号，避免用户输入被当成语法。 */
export function ftsQuery(input) {
  const text = String(input).trim()
  if (text === '') return ''
  const grams = [...new Set(ftsText(text).split(/\s+/).filter((term) => term.length > 0))]
  if (grams.length === 0) return ''
  return grams.slice(0, 24).map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
}

/** 一个索引句柄；插件生命周期内单例。 */
export class MemoryStore {
  constructor(db, path) {
    this.db = db
    this.path = path
  }

  /** 打开（或创建）索引。维度/模型不一致时只标记，不删数据。 */
  static async open(path, options = {}) {
    mkdirSync(dirname(path), { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      cwd TEXT NOT NULL DEFAULT '',
      seq INTEGER NOT NULL DEFAULT 0,
      turn INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      vec BLOB,
      dim INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      weight REAL NOT NULL DEFAULT 1
    )`)
    db.exec(`CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id)`)
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(fts_text, tokenize = 'unicode61')`)
    // L2 需要：这条记忆被用过几次、最后一次是什么时候
    const columns = new Set(db.prepare('PRAGMA table_info(chunks)').all().map((row) => String(row.name)))
    if (!columns.has('hits')) db.exec('ALTER TABLE chunks ADD COLUMN hits INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('last_hit_at')) db.exec('ALTER TABLE chunks ADD COLUMN last_hit_at INTEGER NOT NULL DEFAULT 0')
    // 归因：injected = 被放进过上下文；used = 回复里真被引用。hits 从此只读不写。
    if (!columns.has('injected')) db.exec('ALTER TABLE chunks ADD COLUMN injected INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('used')) db.exec('ALTER TABLE chunks ADD COLUMN used INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('last_used_at')) db.exec('ALTER TABLE chunks ADD COLUMN last_used_at INTEGER')
    if (!columns.has('judged')) db.exec('ALTER TABLE chunks ADD COLUMN judged INTEGER NOT NULL DEFAULT 0')
    // L3 交付物索引：路径 + 出处，不存内容
    db.exec(`CREATE TABLE IF NOT EXISTS deliverables(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      cwd TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'modified',
      turn INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      UNIQUE(session_id, path)
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS deliverables_path ON deliverables(path)')
    db.exec('CREATE INDEX IF NOT EXISTS deliverables_at ON deliverables(at DESC)')
    // 回填台账：处理过的会话，保证重复点「回填」不重复花钱
    db.exec(`CREATE TABLE IF NOT EXISTS backfill_sessions(
      session_id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      chunks INTEGER NOT NULL DEFAULT 0
    )`)
    const store = new MemoryStore(db, path)
    store.setMeta('schema_version', String(SCHEMA_VERSION))
    store.setMeta('dimension', String(options.dimension ?? 0))
    store.setMeta('model', String(options.model ?? ''))
    // 一次性迁移：老 hits 全是"被注入"，不是"被用到"，所以只记到 injected，used 从零起。
    if (store.getMeta('attribution_v1') === undefined && columns.has('hits')) {
      db.exec('UPDATE chunks SET injected = hits WHERE hits > 0 AND injected = 0 AND judged = 0')
      store.setMeta('attribution_v1', String(Date.now()))
    }
    return store
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row === undefined ? undefined : String(row.value)
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  /** 该内容是否已入库（重复对话不重复计费）。 */
  hasHash(hash) {
    const row = this.db.prepare('SELECT 1 AS hit FROM chunks WHERE hash = ?').get(hash)
    return row !== undefined
  }

  /**
   * 写入一块记忆。
   * @param {{id:string,sessionId:string,cwd?:string,seq?:number,turn?:number,text:string,vector:Float32Array,dim:number,model:string,createdAt?:number}} input
   * @returns {boolean} 是否新写入（重复返回 false）
   */
  addChunk(input) {
    const hash = hashText(`${input.sessionId}\n${input.text}`)
    if (this.hasHash(hash)) return false
    const createdAt = input.createdAt ?? Date.now()
    this.db
      .prepare(
        `INSERT INTO chunks(id, session_id, cwd, seq, turn, text, hash, created_at, vec, dim, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.sessionId,
        input.cwd ?? '',
        input.seq ?? 0,
        input.turn ?? 0,
        input.text,
        hash,
        createdAt,
        Buffer.from(input.vector.buffer, input.vector.byteOffset, input.vector.byteLength),
        input.dim,
        input.model
      )
    const rowid = this.db.prepare('SELECT rowid AS id FROM chunks WHERE id = ?').get(input.id).id
    this.db.prepare('INSERT INTO chunks_fts(rowid, fts_text) VALUES (?, ?)').run(rowid, ftsText(input.text))
    return true
  }

  /** 关键词候选：返回 rowid + 名次。 */
  searchFts(query, limit = 50) {
    const expression = ftsQuery(query)
    if (expression === '') return []
    try {
      return this.db
        .prepare('SELECT rowid AS rowid, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?')
        .all(expression, limit)
        .map((row, index) => ({ rowid: Number(row.rowid), rank: index + 1 }))
    } catch {
      return []
    }
  }

  /** 读出全部向量做暴力余弦；个人量级（万级）足够，不引 ANN 依赖。 */
  *iterateVectors(dimension) {
    const statement = this.db.prepare('SELECT rowid AS rowid, vec AS vec FROM chunks WHERE dim = ? AND vec IS NOT NULL')
    for (const row of statement.iterate(dimension)) {
      const buffer = row.vec
      if (buffer === undefined || buffer === null) continue
      const vec = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      yield { rowid: Number(row.rowid), vec }
    }
  }

  /** 按 rowid 取回完整行。 */
  rowsByIds(ids) {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db
      .prepare(`SELECT rowid AS rowid, id, session_id, cwd, seq, turn, text, created_at FROM chunks WHERE rowid IN (${placeholders})`)
      .all(...ids)
      .map((row) => ({
        rowid: Number(row.rowid),
        id: String(row.id),
        sessionId: String(row.session_id),
        cwd: String(row.cwd ?? ''),
        seq: Number(row.seq ?? 0),
        turn: Number(row.turn ?? 0),
        text: String(row.text),
        createdAt: Number(row.created_at ?? 0)
      }))
  }

  /**
   * 这些块被放进了上下文。只加 injected，不动权重——被塞进去不等于被读过。
   * @returns {number} 实际改动的行数
   */
  bumpInjected(ids, at = Date.now()) {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const statement = this.db.prepare(
      `UPDATE chunks SET injected = injected + 1, judged = 1 WHERE rowid IN (${placeholders})`
    )
    return Number(statement.run(...ids).changes ?? 0)
  }

  /** 这些块真的被引用了：used +1、记时间、权重才有资格涨。 */
  bumpUsed(ids, at = Date.now()) {
    if (!Array.isArray(ids) || ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const statement = this.db.prepare(
      `UPDATE chunks SET used = used + 1, last_used_at = ?, judged = 1 WHERE rowid IN (${placeholders})`
    )
    return Number(statement.run(at, ...ids).changes ?? 0)
  }

  /** 兼容旧调用：语义等同"被用到"。 */
  bumpHits(ids, at = Date.now()) {
    return this.bumpUsed(ids, at)
  }

  /** 候选集：被用过至少一次的块，按使用次数取前 N 条。 */
  hitCandidates(limit = 400) {
    return this.db
      .prepare(
        `SELECT rowid AS rowid, session_id, cwd, seq, text, created_at, used, injected, last_used_at
         FROM chunks WHERE used > 0 ORDER BY used DESC, last_used_at DESC LIMIT ?`
      )
      .all(limit)
      .map((row) => ({
        rowid: Number(row.rowid),
        sessionId: String(row.session_id),
        cwd: String(row.cwd ?? ''),
        seq: Number(row.seq ?? 0),
        text: String(row.text),
        createdAt: Number(row.created_at ?? 0),
        used: Number(row.used ?? 0),
        injected: Number(row.injected ?? 0),
        lastUsedAt: Number(row.last_used_at ?? 0)
      }))
  }

  /** 近 N 天入库曲线：库是不是在失控。 */
  growthByDay(days = 7) {
    const span = Math.max(1, Math.min(90, Number(days) || 7))
    return this.db
      .prepare(
        `SELECT date(created_at/1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
         FROM chunks WHERE created_at >= ? GROUP BY day ORDER BY day`
      )
      .all(Date.now() - span * 86400000)
      .map((row) => ({ day: String(row.day ?? ''), chunks: Number(row.n ?? 0) }))
  }

  /** 体检数据：注入/使用比、死重、判定覆盖率。 */
  attributionStats() {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(injected), 0) AS injected,
                COALESCE(SUM(used), 0) AS used,
                COALESCE(SUM(CASE WHEN used = 0 THEN 1 ELSE 0 END), 0) AS neverUsed,
                COALESCE(SUM(CASE WHEN judged = 1 THEN 1 ELSE 0 END), 0) AS judged
         FROM chunks`
      )
      .get()
    return {
      chunks: Number(row?.total ?? 0),
      injected: Number(row?.injected ?? 0),
      used: Number(row?.used ?? 0),
      neverUsed: Number(row?.neverUsed ?? 0),
      judged: Number(row?.judged ?? 0)
    }
  }

  /** 死重候选：灌进过上下文、却从没被引用的块（只报告，不删）。 */
  deadCandidates(minInjections = 3, limit = 20) {
    return this.db
      .prepare(
        `SELECT rowid AS rowid, session_id, seq, cwd, injected, text
         FROM chunks WHERE used = 0 AND injected >= ?
         ORDER BY injected DESC LIMIT ?`
      )
      .all(minInjections, limit)
      .map((row) => ({
        rowid: Number(row.rowid),
        sessionId: String(row.session_id),
        seq: Number(row.seq ?? 0),
        cwd: String(row.cwd ?? ''),
        injected: Number(row.injected ?? 0),
        text: String(row.text)
      }))
  }

  /** 记一笔交付物；同一会话同一路径只留最新一次。 */
  addDeliverable(input) {
    const path = String(input.path ?? '')
    if (path === '') return false
    this.db
      .prepare(
        `INSERT INTO deliverables(session_id, cwd, path, kind, turn, at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, path) DO UPDATE SET
           kind = excluded.kind, turn = excluded.turn, at = excluded.at, note = excluded.note`
      )
      .run(
        String(input.sessionId ?? ''),
        String(input.cwd ?? ''),
        path,
        String(input.kind ?? 'modified'),
        Number(input.turn ?? 0),
        Number(input.at ?? Date.now()),
        String(input.note ?? '')
      )
    return true
  }

  /** 查交付物：可按工作区限定、按路径子串过滤。 */
  searchDeliverables(options = {}) {
    const { cwd = '', query = '', limit = 50 } = options
    const where = []
    const params = []
    if (cwd !== '') {
      where.push('cwd = ?')
      params.push(cwd)
    }
    const term = String(query ?? '').trim()
    if (term !== '') {
      where.push('path LIKE ?')
      params.push(`%${term.replace(/[%_]/g, '')}%`)
    }
    const sql =
      `SELECT session_id, cwd, path, kind, turn, at, note FROM deliverables` +
      `${where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`
    return this.db
      .prepare(sql)
      .all(...params, Math.max(1, Number(limit) || 50))
      .map((row) => ({
        sessionId: String(row.session_id),
        cwd: String(row.cwd ?? ''),
        path: String(row.path),
        kind: String(row.kind ?? 'modified'),
        turn: Number(row.turn ?? 0),
        at: Number(row.at ?? 0),
        note: String(row.note ?? '')
      }))
  }

  markBackfilled(sessionId, chunks, at = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO backfill_sessions(session_id, at, chunks) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET at = excluded.at, chunks = excluded.chunks`
      )
      .run(String(sessionId), at, Number(chunks) || 0)
  }

  backfilledIds() {
    return new Set(this.db.prepare('SELECT session_id FROM backfill_sessions').all().map((row) => String(row.session_id)))
  }

  backfillStats() {
    const row = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chunks), 0) AS c, MAX(at) AS t FROM backfill_sessions').get()
    return { sessions: Number(row?.n ?? 0), chunks: Number(row?.c ?? 0), lastAt: row?.t === null || row?.t === undefined ? null : Number(row.t) }
  }

  deliverableCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM deliverables').get()?.n ?? 0)
  }

  /** 超出上限时丢掉最旧的记录（文件本身不动）。 */
  trimDeliverables(maxRows) {
    const limit = Math.max(1, Number(maxRows) || 2000)
    const total = this.deliverableCount()
    if (total <= limit) return 0
    const removed = this.db
      .prepare(
        `DELETE FROM deliverables WHERE id IN (
           SELECT id FROM deliverables ORDER BY at ASC LIMIT ?
         )`
      )
      .run(total - limit)
    return Number(removed.changes ?? 0)
  }

  stats() {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n ?? 0)
    const sessions = Number(this.db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM chunks').get()?.n ?? 0)
    const last = this.db.prepare('SELECT MAX(created_at) AS t FROM chunks').get()?.t
    const byModel = this.db
      .prepare('SELECT model, dim, COUNT(*) AS n FROM chunks GROUP BY model, dim ORDER BY n DESC')
      .all()
      .map((row) => ({ model: String(row.model ?? ''), dimension: Number(row.dim ?? 0), chunks: Number(row.n ?? 0) }))
    return {
      chunks: total,
      sessions,
      lastAt: last === null || last === undefined ? null : Number(last),
      dimension: Number(this.getMeta('dimension') ?? 0),
      model: this.getMeta('model') ?? '',
      byModel,
      deliverables: this.deliverableCount(),
      path: this.path,
      sizeBytes: this.fileSize()
    }
  }

  fileSize() {
    try {
      return Number(this.db.prepare('PRAGMA page_count').get()?.page_count ?? 0) * Number(this.db.prepare('PRAGMA page_size').get()?.page_size ?? 0)
    } catch {
      return 0
    }
  }

  /** 清空全部索引（设置页的危险按钮）。 */
  clear() {
    this.db.exec('DELETE FROM chunks')
    this.db.exec('DELETE FROM chunks_fts')
    // 清空即重置：回填台账一起清掉，否则「重建」会以为旧会话都补过了
    this.db.exec('DELETE FROM backfill_sessions')
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }
}
