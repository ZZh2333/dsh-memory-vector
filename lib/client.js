/**
 * dsh-memory-vector · 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建）
 *
 * 注册一个「记忆」设置页（slot: settings.section）：
 *   - 展示索引现状（块数 / 会话数 / 维度 / 模型 / 凭证来源）
 *   - 按宿主下发的 SCHEMA 渲染全部可调参数，保存到 <DSH_HOME>/storages/memory-vector/settings.json
 *   - 提供「测试向量化」「测试检索」「清空索引」三个动作
 * 只走同源 HTTP（/api/memory-vector/*），不碰 RPC。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-vector',
  factory(require) {
    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useState = React.useState

    var API = '/api/memory-vector'

    function lang() {
      var raw = ''
      try {
        raw = (navigator.languages && navigator.languages[0]) || navigator.language || ''
      } catch (error) {
        raw = ''
      }
      return String(raw).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }

    function pick(record) {
      if (record === null || record === undefined) return ''
      if (typeof record === 'string') return record
      var preferred = lang()
      return record[preferred] || record.zh || record.en || ''
    }

    function readJson(response) {
      return response.json().then(function (body) {
        if (!response.ok) {
          var message = body && body.error ? String(body.error) : 'HTTP ' + response.status
          throw new Error(message)
        }
        return body
      })
    }

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      }).then(readJson)
    }

    function formatBytes(value) {
      var size = Number(value) || 0
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      return (size / 1024 / 1024).toFixed(1) + ' MB'
    }

    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '—'
      var date = typeof value === 'number' ? new Date(value) : new Date(String(value))
      if (Number.isNaN(date.getTime())) return '—'
      var pad = function (n) {
        return n < 10 ? '0' + n : String(n)
      }
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /* ---------------- 基础控件 ---------------- */

    function Switch(props) {
      var checked = props.checked === true
      var disabled = props.disabled === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          disabled: disabled,
          onClick: function () {
            if (!disabled) props.onChange(!checked)
          },
          className: 'dmv-switch' + (checked ? ' is-on' : '') + (disabled ? ' is-disabled' : ''),
        },
        h('span', { className: 'dmv-switch-knob' })
      )
    }

    function Row(props) {
      var field = props.field
      var value = props.value
      var disabled = props.disabled === true
      var control
      if (field.type === 'boolean') {
        control = h(Switch, { checked: value === true, disabled: disabled, onChange: props.onChange })
      } else if (field.type === 'select') {
        control = h(
          'select',
          {
            className: 'dmv-input dmv-select',
            value: String(value),
            disabled: disabled,
            onChange: function (event) {
              var raw = event.target.value
              var option = (field.options || []).filter(function (item) {
                return String(item) === raw
              })[0]
              props.onChange(option === undefined ? raw : option)
            },
          },
          (field.options || []).map(function (option) {
            return h('option', { key: String(option), value: String(option) }, String(option))
          })
        )
      } else if (field.type === 'number') {
        control = h('input', {
          className: 'dmv-input dmv-number',
          type: 'number',
          value: value === undefined || value === null ? '' : String(value),
          min: field.min,
          max: field.max,
          step: field.step,
          disabled: disabled,
          onChange: function (event) {
            var raw = event.target.value
            if (raw === '') return props.onChange('')
            var parsed = Number(raw)
            if (Number.isFinite(parsed)) props.onChange(parsed)
          },
        })
      } else {
        control = h('input', {
          className: 'dmv-input',
          type: 'text',
          value: value === undefined || value === null ? '' : String(value),
          disabled: disabled,
          onChange: function (event) {
            props.onChange(event.target.value)
          },
        })
      }

      return h(
        'div',
        { className: 'dmv-row' + (field.pending ? ' is-pending' : '') },
        h(
          'div',
          { className: 'dmv-row-text' },
          h(
            'div',
            { className: 'dmv-row-title' },
            pick(field.title),
            field.pending ? h('span', { className: 'dmv-tag' }, lang() === 'zh' ? '待接入' : 'pending') : null
          ),
          h('div', { className: 'dmv-row-hint' }, pick(field.hint))
        ),
        h('div', { className: 'dmv-row-control' }, control)
      )
    }

    function Stat(props) {
      return h(
        'div',
        { className: 'dmv-stat' },
        h('div', { className: 'dmv-stat-label' }, props.label),
        h('div', { className: 'dmv-stat-value' + (props.warn ? ' is-warn' : '') }, props.value)
      )
    }

    function ProviderEditor(props) {
      var provider = props.provider
      var zh = lang() === 'zh'
      var probe = props.probe
      return h(
        'div',
        { className: 'dmv-provider' + (props.active ? ' is-active' : '') },
        h(
          'div',
          { className: 'dmv-provider-head' },
          h(
            'label',
            { className: 'dmv-radio' },
            h('input', {
              type: 'radio',
              checked: props.active,
              onChange: function () {
                props.onActivate()
              },
            }),
            h('span', null, props.active ? (zh ? '当前使用' : 'Active') : zh ? '设为当前' : 'Use this')
          ),
          h('div', { className: 'dmv-provider-title' }, provider.label || provider.id),
          h('code', { className: 'dmv-provider-id' }, provider.id),
          h(
            'div',
            { className: 'dmv-provider-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dmv-button is-small',
                disabled: props.busy,
                onClick: props.onProbe,
              },
              zh ? '测试' : 'Test'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dmv-button is-small is-danger',
                disabled: props.busy || !props.canRemove,
                onClick: props.onRemove,
              },
              zh ? '删除' : 'Delete'
            )
          )
        ),
        probe !== null && probe !== undefined
          ? h(
              'div',
              { className: 'dmv-banner ' + (probe.ok ? 'is-ok' : 'is-error') },
              probe.ok
                ? (zh ? '连通：维度 ' : 'OK: dim ') +
                  probe.dimension +
                  (probe.dimension === probe.expected ? '' : (zh ? '（与配置的维度不一致：' : ' (configured ') + probe.expected + ')') +
                  '，' + probe.tookMs + 'ms'
                : (zh ? '失败：' : 'Failed: ') + probe.error
            )
          : null,
        (props.fields || []).map(function (field) {
          return h(Row, {
            key: field.key,
            field: field,
            value: provider[field.key],
            disabled: props.busy,
            onChange: function (value) {
              props.onField(field.key, value)
            },
          })
        })
      )
    }

    function ProviderList(props) {
      var providers = props.providers || []
      var fields = props.fields || []
      var zh = lang() === 'zh'
      return h(
        'section',
        { className: 'dmv-card' },
        h(
          'div',
          { className: 'dmv-card-head' },
          h('div', { className: 'dmv-card-title' }, props.title),
          h(
            'button',
            {
              type: 'button',
              className: 'dmv-button is-small',
              disabled: props.busy,
              onClick: props.onAdd,
            },
            zh ? '添加一套' : 'Add'
          )
        ),
        h(
          'div',
          { className: 'dmv-note' },
          zh
            ? '可以并存多套：切换只改指针，不动历史块。换维度或模型后，旧块仍可用关键词命中，但不参与向量召回。'
            : 'Several sets can coexist. Switching only moves the pointer; blocks embedded with another dimension stay keyword-only.'
        ),
        providers.map(function (provider, index) {
          return h(ProviderEditor, {
            key: provider.id,
            index: index,
            provider: provider,
            fields: fields,
            active: provider.id === props.activeId,
            canRemove: providers.length > 1,
            busy: props.busy,
            probe: props.probes ? props.probes[provider.id] : null,
            onActivate: function () {
              props.onActivate(provider.id)
            },
            onRemove: function () {
              props.onRemove(provider.id)
            },
            onProbe: function () {
              props.onProbe(provider)
            },
            onField: function (key, value) {
              props.onField(provider.id, key, value)
            },
          })
        })
      )
    }

    /* ---------------- 面板 ---------------- */

    function MemoryPanel() {
      var [state, setState] = useState(null)
      var [draft, setDraft] = useState(null)
      var [error, setError] = useState('')
      var [busy, setBusy] = useState(false)
      var [notice, setNotice] = useState('')
      var [probe, setProbe] = useState(null)
      var [probes, setProbes] = useState({})
      var [query, setQuery] = useState('')
      var [result, setResult] = useState(null)

      var zh = lang() === 'zh'
      var t = function (cn, en) {
        return zh ? cn : en
      }

      var reload = useCallback(function () {
        setError('')
        return apiGet('/state')
          .then(function (payload) {
            setState(payload)
            setDraft(payload.settings)
            return payload
          })
          .catch(function (failure) {
            setError(String((failure && failure.message) || failure))
            return null
          })
      }, [])

      useEffect(function () {
        reload()
      }, [reload])

      var dirty = useMemo(
        function () {
          if (state === null || draft === null) return false
          return JSON.stringify(state.settings) !== JSON.stringify(draft)
        },
        [state, draft]
      )

      var setField = useCallback(function (key, value) {
        setDraft(function (current) {
          var next = {}
          for (var name in current) next[name] = current[name]
          next[key] = value
          return next
        })
      }, [])

      var save = useCallback(
        function () {
          if (draft === null) return
          setBusy(true)
          setNotice('')
          apiPost('/settings', { settings: draft })
            .then(function (payload) {
              setState(payload)
              setDraft(payload.settings)
              setNotice(t('已保存', 'Saved'))
            })
            .catch(function (failure) {
              setError(String((failure && failure.message) || failure))
            })
            .finally(function () {
              setBusy(false)
            })
        },
        [draft]
      )

      var runProbe = useCallback(function () {
        setBusy(true)
        setProbe(null)
        apiPost('/probe', {})
          .then(function (payload) {
            setProbe(payload)
          })
          .catch(function (failure) {
            setProbe({ ok: false, error: String((failure && failure.message) || failure) })
          })
          .finally(function () {
            setBusy(false)
          })
      }, [])

      /* ---- 多套向量化模型：都只改 draft，保存前不落盘 ---- */

      var providerFields = state === null ? [] : state.providerFields || []

      var patchProvider = useCallback(function (id, key, value) {
        setDraft(function (current) {
          var next = {}
          for (var name in current) next[name] = current[name]
          next.embeddingProviders = (current.embeddingProviders || []).map(function (item) {
            if (item.id !== id) return item
            var updated = {}
            for (var field in item) updated[field] = item[field]
            updated[key] = value
            return updated
          })
          return next
        })
      }, [])

      var activateProvider = useCallback(function (id) {
        setDraft(function (current) {
          var next = {}
          for (var name in current) next[name] = current[name]
          next.embeddingActive = id
          return next
        })
      }, [])

      var removeProvider = useCallback(function (id) {
        setDraft(function (current) {
          var list = (current.embeddingProviders || []).filter(function (item) {
            return item.id !== id
          })
          if (list.length === 0) return current
          var next = {}
          for (var name in current) next[name] = current[name]
          next.embeddingProviders = list
          if (next.embeddingActive === id) next.embeddingActive = list[0].id
          return next
        })
      }, [])

      var addProvider = useCallback(function () {
        setDraft(function (current) {
          var list = (current.embeddingProviders || []).slice()
          var taken = {}
          list.forEach(function (item) {
            taken[item.id] = true
          })
          var index = list.length + 1
          var id = 'provider-' + index
          while (taken[id]) {
            index += 1
            id = 'provider-' + index
          }
          var template = list[0] || {}
          var created = { id: id }
          providerFields.forEach(function (field) {
            created[field.key] = template[field.key]
          })
          created.label = t('新的一套', 'New provider')
          list.push(created)
          var next = {}
          for (var name in current) next[name] = current[name]
          next.embeddingProviders = list
          return next
        })
      }, [providerFields])

      var probeProvider = useCallback(function (target) {
        setBusy(true)
        apiPost('/probe', { provider: target })
          .then(function (payload) {
            setProbes(function (current) {
              var next = {}
              for (var key in current) next[key] = current[key]
              next[target.id] = payload
              return next
            })
          })
          .catch(function (failure) {
            setProbes(function (current) {
              var next = {}
              for (var key in current) next[key] = current[key]
              next[target.id] = { ok: false, error: String((failure && failure.message) || failure) }
              return next
            })
          })
          .finally(function () {
            setBusy(false)
          })
      }, [])

      var runSearch = useCallback(function () {
        var text = String(query).trim()
        if (text === '') return
        setBusy(true)
        setResult(null)
        apiPost('/search', { query: text })
          .then(function (payload) {
            setResult(payload)
          })
          .catch(function (failure) {
            setResult({ error: String((failure && failure.message) || failure), hits: [] })
          })
          .finally(function () {
            setBusy(false)
          })
      }, [query])

      var clearIndex = useCallback(function () {        if (!window.confirm(t('确定清空全部记忆索引？此操作不可撤销（原文也会一起删掉）。', 'Clear the whole memory index? This cannot be undone.'))) return
        setBusy(true)
        apiPost('/clear', { confirm: true })
          .then(function (payload) {
            setState(payload)
            setResult(null)
            setNotice(t('索引已清空', 'Index cleared'))
          })
          .catch(function (failure) {
            setError(String((failure && failure.message) || failure))
          })
          .finally(function () {
            setBusy(false)
          })
      }, [])

      var refreshWeightsNow = useCallback(function () {
        setBusy(true)
        setNotice('')
        apiPost('/weights', {})
          .then(function (payload) {
            var result = (payload && payload.result) || {}
            setNotice(
              result.ok
                ? t('权重快照已更新（' + (result.entries || 0) + ' 条）', 'Snapshot updated (' + (result.entries || 0) + ' entries)')
                : t('没写成：' + (result.reason || '未知原因'), 'Not written: ' + (result.reason || 'unknown'))
            )
            return reload()
          })
          .catch(function (failure) {
            setError(String((failure && failure.message) || failure))
          })
          .finally(function () {
            setBusy(false)
          })
      }, [reload])

      if (state === null) {
        return h(
          'div',
          { className: 'dmv-page' },
          error !== ''
            ? h('div', { className: 'dmv-banner is-error' }, error)
            : h('div', { className: 'dmv-loading' }, t('正在读取记忆状态…', 'Loading memory state…'))
        )
      }

      var stats = state.stats || {}
      var health = state.health || {}
      var credentials = state.credentials || {}
      var schema = state.schema || []
      var groups = state.groups || []

      return h(
        'div',
        { className: 'dmv-page' },
        h(
          'div',
          { className: 'dmv-header' },
          h('div', { className: 'dmv-title' }, t('记忆', 'Memory')),
          h(
            'div',
            { className: 'dmv-subtitle' },
            t('五层记忆链的向量层：原文库 + 混合检索。', 'Vector layer of the five-tier memory chain.')
          )
        ),

        h(
          'div',
          { className: 'dmv-banner is-warn' },
          h('strong', null, t('先看清楚再开：', 'Read this before enabling: ')),
          t(
            '开启采集后，每轮对话正文会被发送到 ',
            'When capture is on, turn text is sent to '
          ),
          h('code', null, state.active ? state.active.baseUrl : ''),
          t(
            ' 做向量化，向量与正文都存在本机（索引文件 + settings.json 同目录）。关闭采集后不再新增，但已写入的块要手动清空。',
            ' for embedding. Vectors and text stay on this machine. Turning capture off stops new writes but keeps existing blocks.'
          )
        ),

        error !== '' ? h('div', { className: 'dmv-banner is-error' }, error) : null,
        notice !== '' ? h('div', { className: 'dmv-banner is-ok' }, notice) : null,

        h(
          'div',
          { className: 'dmv-stats' },
          h(Stat, { label: t('记忆块', 'Blocks'), value: String(stats.chunks === undefined ? '—' : stats.chunks) }),
          h(Stat, { label: t('会话数', 'Sessions'), value: String(stats.sessions === undefined ? '—' : stats.sessions) }),
          h(Stat, {
            label: t('生效模型', 'Active model'),
            value: state.active ? String(state.active.label || state.active.id) : '—'
          }),
          h(Stat, { label: t('生效维度', 'Active dimension'), value: String(state.active ? state.active.dimensions : '—') }),
          h(Stat, { label: t('索引体积', 'Index size'), value: stats.sizeBytes === undefined ? '—' : formatBytes(stats.sizeBytes) }),
          h(Stat, { label: t('写入队列', 'Queue'), value: String(health.queued || 0) }),
          h(Stat, {
            label: t('凭证', 'Credential'),
            value: credentials.configured ? credentials.source : t('未找到', 'missing'),
            warn: credentials.configured !== true
          })
        ),

        (stats.byModel || []).length > 1
          ? h(
              'div',
              { className: 'dmv-banner is-warn' },
              t('索引里目前有多种向量：', 'The index holds several vector kinds: '),
              (stats.byModel || [])
                .map(function (row) {
                  return row.model + '@' + row.dimension + ' × ' + row.chunks
                })
                .join(' · '),
              t('。只有与生效维度一致的那些参与向量召回，其余仍可被关键词命中。', ' Only the active dimension joins vector recall.')
            )
          : null,

        h(
          'div',
          { className: 'dmv-meta' },
          h('span', null, t('最近写入：', 'Last write: ') + formatTime(stats.lastAt)),
          h('span', null, t('最近检索：', 'Last search: ') + (health.lastSearchMs === null || health.lastSearchMs === undefined ? '—' : health.lastSearchMs + 'ms')),
          h('span', null, t('索引：', 'Index: ') + String(state.paths ? state.paths.index : '')),
          health.lastEmbedError ? h('span', { className: 'is-error-text' }, health.lastEmbedError) : null
        ),

        groups.map(function (group) {
          if (group.card === 'providers') {
            return h(ProviderList, {
              key: group.key,
              title: pick(group.title),
              providers: draft === null ? [] : draft.embeddingProviders || [],
              activeId: draft === null ? '' : draft.embeddingActive,
              fields: providerFields,
              probes: probes,
              busy: busy,
              onAdd: addProvider,
              onActivate: activateProvider,
              onRemove: removeProvider,
              onProbe: probeProvider,
              onField: patchProvider,
            })
          }
          var fields = schema.filter(function (field) {
            return field.group === group.key
          })
          if (fields.length === 0) return null
          return h(
            'section',
            { key: group.key, className: 'dmv-card' },
            h('div', { className: 'dmv-card-title' }, pick(group.title)),
            fields.map(function (field) {
              return h(Row, {
                key: field.key,
                field: field,
                value: draft === null ? undefined : draft[field.key],
                disabled: field.pending === true || busy,
                onChange: function (value) {
                  setField(field.key, value)
                },
              })
            })
          )
        }),

        draft !== null && draft.weightsEnabled === true
          ? h(
              'section',
              { className: 'dmv-card' },
              h(
                'div',
                { className: 'dmv-card-head' },
                h('div', { className: 'dmv-card-title' }, t('L2 快照', 'L2 snapshot')),
                h(
                  'button',
                  { type: 'button', className: 'dmv-button is-small', disabled: busy, onClick: refreshWeightsNow },
                  t('立即刷新', 'Refresh now')
                )
              ),
              h(
                'div',
                { className: 'dmv-note' },
                t(
                  '写入 ' +
                    (state.weights ? state.weights.target : '—') +
                    '；上次 ' +
                    formatTime(state.weights ? state.weights.lastAt : 0) +
                    '，条目 ' +
                    String(state.weights ? state.weights.entries : 0) +
                    '。只改受管标记之间的内容，你写的部分不会被碰。',
                  'Written to ' + (state.weights ? state.weights.target : '—') + '; only the managed block changes.'
                )
              ),
              state.weights && state.weights.preview !== ''
                ? h('pre', { className: 'dmv-preview' }, state.weights.preview)
                : null
            )
          : null,

        h(
          'div',
          { className: 'dmv-actions' },
          h(
            'button',
            { type: 'button', className: 'dmv-button is-primary', disabled: !dirty || busy, onClick: save },
            dirty ? t('保存设置', 'Save') : t('已保存', 'Saved')
          ),
          h('button', { type: 'button', className: 'dmv-button', disabled: busy, onClick: runProbe }, t('测试向量化', 'Test embedding')),
          h('button', { type: 'button', className: 'dmv-button is-danger', disabled: busy, onClick: clearIndex }, t('清空索引', 'Clear index'))
        ),

        probe !== null
          ? h(
              'div',
              { className: 'dmv-banner ' + (probe.ok ? 'is-ok' : 'is-error') },
              probe.ok
                ? t(
                    '向量化正常：维度 ' + probe.dimension + '，tokens ' + probe.tokens + '，耗时 ' + probe.tookMs + 'ms',
                    'Embedding OK: dimension ' + probe.dimension + ', tokens ' + probe.tokens + ', ' + probe.tookMs + 'ms'
                  )
                : t('向量化失败：' + probe.error, 'Embedding failed: ' + probe.error)
            )
          : null,

        h(
          'section',
          { className: 'dmv-card' },
          h('div', { className: 'dmv-card-title' }, t('检索试跑', 'Try a search')),
          h(
            'div',
            { className: 'dmv-search' },
            h('input', {
              className: 'dmv-input',
              type: 'text',
              placeholder: t('用一句话描述你想找回的事', 'Describe what you want to recall'),
              value: query,
              onChange: function (event) {
                setQuery(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') runSearch()
              },
            }),
            h('button', { type: 'button', className: 'dmv-button', disabled: busy || String(query).trim() === '', onClick: runSearch }, t('检索', 'Search'))
          ),
          result === null
            ? null
            : result.error !== undefined && result.hits !== undefined && result.hits.length === 0
              ? h('div', { className: 'dmv-banner is-error' }, String(result.error))
              : result.hits === undefined || result.hits.length === 0
                ? h('div', { className: 'dmv-empty' }, t('没有命中（可能要等采集写入，或降低最低相似度）。', 'No hits yet.'))
                : h(
                    'div',
                    { className: 'dmv-hits' },
                    result.hits.map(function (hit, index) {
                      return h(
                        'div',
                        { key: hit.id || index, className: 'dmv-hit' },
                        h(
                          'div',
                          { className: 'dmv-hit-head' },
                          h('span', null, '#' + (index + 1)),
                          h('code', null, hit.sessionId + '#' + hit.seq),
                          hit.similarity === null || hit.similarity === undefined
                            ? null
                            : h('span', null, 'cos ' + Number(hit.similarity).toFixed(3))
                        ),
                        h('div', { className: 'dmv-hit-body' }, String(hit.text || '').slice(0, 400))
                      )
                    })
                  )
        )
      )
    }

    /* ---------------- 错误边界 ---------------- */

    function ErrorBoundary(props) {
      var [failure, setFailure] = useState('')
      useEffect(function () {
        function onError(event) {
          setFailure(String((event && event.message) || 'unknown error'))
        }
        window.addEventListener('error', onError)
        return function () {
          window.removeEventListener('error', onError)
        }
      }, [])
      if (failure !== '') {
        return h('div', { className: 'dmv-banner is-error' }, 'memory-vector 设置页出错：' + failure)
      }
      return props.children
    }

    /* ---------------- 样式 ---------------- */

    var CSS = [
      '.dmv-page{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dmv-header{display:flex;flex-direction:column;gap:4px}',
      '.dmv-title{font-size:16px;font-weight:600}',
      '.dmv-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dmv-banner{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;line-height:1.6;font-size:12px}',
      '.dmv-banner.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}',
      '.dmv-banner.is-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dmv-banner.is-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.dmv-banner code{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-1);padding:1px 4px;border-radius:4px}',
      '.dmv-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}',
      '.dmv-stat{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}',
      '.dmv-stat-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dmv-stat-value{font-size:14px;font-weight:600}',
      '.dmv-stat-value.is-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dmv-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dmv-meta .is-error-text{color:var(--dsw-alias-state-error-primary)}',
      '.dmv-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.dmv-card-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
      '.dmv-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.dmv-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px}',
      '.dmv-provider{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base)}',
      '.dmv-provider.is-active{border-color:var(--dsw-alias-brand-primary)}',
      '.dmv-provider-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dmv-provider-title{font-size:13px;font-weight:600}',
      '.dmv-provider-id{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary)}',
      '.dmv-provider-actions{margin-left:auto;display:flex;gap:6px}',
      '.dmv-radio{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dmv-radio input{accent-color:var(--dsw-alias-brand-primary)}',
      '.dmv-button.is-small{padding:3px 9px;font-size:11px}',
      '.dmv-preview{margin:0;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-l1);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,Consolas,monospace;font-size:10.5px;line-height:1.7;max-height:220px;overflow:auto;white-space:pre-wrap;color:var(--dsw-alias-label-primary)}',
      '.dmv-row{display:flex;align-items:flex-start;gap:16px;justify-content:space-between}',
      '.dmv-row.is-pending{opacity:.55}',
      '.dmv-row-text{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dmv-row-title{font-size:13px;display:flex;align-items:center;gap:6px}',
      '.dmv-tag{font-size:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;color:var(--dsw-alias-label-secondary)}',
      '.dmv-row-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55}',
      '.dmv-row-control{flex:0 0 auto;min-width:120px;display:flex;justify-content:flex-end}',
      '.dmv-input{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 8px;outline:none;font-family:inherit}',
      '.dmv-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dmv-number{width:110px;text-align:right}',
      '.dmv-select{min-width:150px}',
      '.dmv-row-control .dmv-input{width:100%}',
      '.dmv-switch{width:38px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);position:relative;cursor:pointer;padding:0;transition:background .15s}',
      '.dmv-switch.is-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dmv-switch.is-disabled{opacity:.5;cursor:not-allowed}',
      '.dmv-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}',
      '.dmv-switch.is-on .dmv-switch-knob{transform:translateX(16px)}',
      '.dmv-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.dmv-button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.dmv-button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.dmv-button:disabled{opacity:.45;cursor:not-allowed}',
      '.dmv-button.is-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.dmv-button.is-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dmv-search{display:flex;gap:8px}',
      '.dmv-search .dmv-input{flex:1 1 auto}',
      '.dmv-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dmv-hits{display:flex;flex-direction:column;gap:8px}',
      '.dmv-hit{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-base)}',
      '.dmv-hit-head{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.dmv-hit-head code{font-family:ui-monospace,Consolas,monospace}',
      '.dmv-hit-body{font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto}',
      '.dmv-loading{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 0}',
    ].join('\n')

    /* ---------------- 插件导出 ---------------- */

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-memory-vector-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var element = document.getElementById(id)
          if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, 'dsh-memory-vector: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'memory-vector',
            order: 47,
            label: function () {
              return lang() === 'zh' ? '记忆' : 'Memory'
            },
          },
          function (props) {
            return h(ErrorBoundary, null, h(MemoryPanel, props || {}))
          }
        )
      })
    }

    return {
      name: 'memory-vector',
      inject: ['slots'],
      apply: apply,
    }
  },
})
