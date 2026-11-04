/**
 * dsh-memory-vector · L3 交付物索引
 *
 * 只回答一个问题：这个文件是哪一场会话、哪一轮做出来的。
 * 不存文件内容，不读文件，只记路径 + 出处（sessionId / turn / 时间）。
 *
 * 采集走 session 事件里的 tool/call：写文件的工具一被调用就记一笔。
 * 只对 root 会话开放查询——子智能体看不到主人的交付物清单（见 lib/index.js 的工具门）。
 */

/** 默认算作"产出文件"的工具。 */
export const DEFAULT_TOOLS = ['write', 'edit', 'str-replace-editor', 'present']

/** 从工具名 + 参数里抠出文件路径。参数可能是流式中的半截 JSON，所以要能失败。 */
export function pathsFromToolCall(name, argumentsText, allowed = DEFAULT_TOOLS) {
  if (!allowed.includes(name)) return []
  let args
  try {
    args = typeof argumentsText === 'string' ? JSON.parse(argumentsText) : argumentsText
  } catch {
    return []
  }
  if (args === null || typeof args !== 'object') return []

  const results = []

  // present：交付声明，天然带描述
  if (name === 'present' && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (file === null || typeof file !== 'object') continue
      const path = typeof file.path === 'string' ? file.path.trim() : ''
      if (path === '') continue
      results.push({ path, kind: 'delivered', note: typeof file.description === 'string' ? file.description : '' })
    }
    return results
  }

  const raw =
    (typeof args.file_path === 'string' && args.file_path) ||
    (typeof args.path === 'string' && args.path) ||
    (typeof args.target_file === 'string' && args.target_file) ||
    ''

  const path = String(raw).trim()
  if (path === '') return []
  const note = typeof args.description === 'string' ? args.description : ''
  results.push({ path, kind: name === 'write' ? 'created' : 'modified', note })
  return results
}

/** 统一路径写法：去引号、折叠分隔符，方便去重和比较。 */
export function normalizePath(input) {
  let text = String(input ?? '').trim().replace(/^["']|["']$/g, '')
  if (text === '') return ''
  text = text.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  return text
}

/** 同一工作区内的相对路径，显示更短。 */
export function relativeTo(cwd, path) {
  const base = normalizePath(cwd)
  const target = normalizePath(path)
  if (base === '' || target === '') return target
  return target.toLowerCase().startsWith(base.toLowerCase() + '/') ? target.slice(base.length + 1) : target
}

/** 目录部分，用来按目录聚合。 */
export function dirOf(path) {
  const target = normalizePath(path)
  const index = target.lastIndexOf('/')
  return index <= 0 ? '.' : target.slice(0, index)
}

export function renderList(rows, options = {}) {
  const { cwd = '', budget = 2000, zh = true } = options
  if (rows.length === 0) {
    return zh ? '（交付物索引里还没有记录。）' : '(no deliverables recorded)'
  }
  const lines = []
  let used = 0
  for (const row of rows) {
    const when = new Date(row.at).toISOString().slice(0, 10)
    const shown = relativeTo(cwd, row.path)
    const line =
      `- ${shown}｜${row.kind === 'delivered' ? (zh ? '交付' : 'delivered') : row.kind === 'created' ? (zh ? '新建' : 'created') : (zh ? '修改' : 'modified')}` +
      ` · ${when} · ${row.sessionId}#${row.turn}` +
      (row.note === '' ? '' : ` · ${row.note}`)
    if (used + line.length > budget) break
    used += line.length
    lines.push(line)
  }
  return lines.join('\n')
}
