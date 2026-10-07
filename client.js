// dsh-armor-lite — 破甲面板（Client 半）
//
// 由 dsh.client（package.json）经 __ModuleLoader__ 加载，并在侧栏「插件 / 上下文洞察」
// 那一组里加一个「破甲」入口（sidebar.panellist id=armor, order=30），点开是中央面板
// （main key=armor）。与 dsh-context 的挂法一致。
//
// 数据面走 Host 半的 /dsh-armor/api/*（与宿主 webServer 同源）。
// 本文件不 import 任何 Harness Client 包，只用 react 与 --dsw-alias-* 主题 token。

window.__ModuleLoader__.load({
  id: 'dsh-armor-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-armor/api'

    const T = {
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      label: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    // ── 数据面 ────────────────────────────────────────────────────────
    async function call(path, init) {
      const res = await fetch(API + path, init)
      let body = {}
      try { body = await res.json() } catch { /* 空响应 */ }
      if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    const postJson = (path, payload) => call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    // ── 控件 ──────────────────────────────────────────────────────────
    function Switch({
      on, busy, onChange, compact,
      onText = '破甲 · 已开启', offText = '破甲 · 已关闭',
      onTitle = '点击关闭破甲（回到原版提示词）', offTitle = '点击开启破甲',
    }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        disabled: busy,
        onClick: () => onChange(!on),
        title: on ? onTitle : offTitle,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: compact ? 7 : 9,
          padding: compact ? '5px 11px' : '7px 14px', borderRadius: 999,
          cursor: busy ? 'wait' : 'pointer',
          border: `1px solid ${on ? T.brand : T.border}`,
          background: on ? T.brand : T.layer1,
          color: on ? '#fff' : T.label2,
          fontSize: compact ? 12 : 13, fontWeight: 600, fontFamily: 'inherit',
        },
      },
        h('span', {
          style: {
            width: 9, height: 9, borderRadius: 999,
            background: on ? '#fff' : T.label2,
            opacity: on ? 1 : 0.55,
          },
        }),
        on ? onText : offText,
      )
    }

    function Btn({ children, onClick, disabled, primary }) {
      return h('button', {
        type: 'button', disabled, onClick,
        style: {
          padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${primary ? T.brand : T.border}`,
          background: primary ? T.brand : 'transparent',
          color: primary ? '#fff' : T.label,
          opacity: disabled ? 0.5 : 1,
        },
      }, children)
    }

    function Editor({ title, hint, value, meta, dirty, busy, onChange, onSave, onReload }) {
      return h('section', { style: { marginTop: 26 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 15, fontWeight: 700, color: T.label } }, title),
          h('span', { style: { fontSize: 12, color: T.label2 } }, hint),
          dirty ? h('span', { style: { fontSize: 12, color: T.warn } }, '· 未保存') : null,
        ),
        h('div', {
          style: { marginTop: 6, fontSize: 11.5, color: T.label2, wordBreak: 'break-all' },
        }, meta),
        h('textarea', {
          value,
          spellCheck: false,
          onChange: (e) => onChange(e.target.value),
          style: {
            marginTop: 10, width: '100%', boxSizing: 'border-box',
            minHeight: 300, resize: 'vertical',
            padding: 12, borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            color: T.label, background: T.layer1,
            border: `1px solid ${T.border}`, outline: 'none',
          },
        }),
        h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h(Btn, { onClick: onSave, disabled: !!busy, primary: true }, busy === 'save' ? '保存中…' : '保存'),
          h(Btn, { onClick: onReload, disabled: !!busy }, '重新读取'),
          h('span', { style: { fontSize: 12, color: T.label2 } }, `${value.length} 字符`),
        ),
      )
    }

    // ── 面板 ──────────────────────────────────────────────────────────
    function ArmorPanel() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState('load')
      const [note, setNote] = React.useState(null)
      const [persona, setPersona] = React.useState('')
      const [rules, setRules] = React.useState('')
      const [dirty, setDirty] = React.useState({ persona: false, rules: false })
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const load = React.useCallback(async () => {
        setBusy('load')
        try {
          const body = await call('/state')
          if (!alive.current) return
          setData(body)
          setPersona(body.persona.text || '')
          setRules(body.rules.text || '')
          setDirty({ persona: false, rules: false })
          setNote(null)
        } catch (e) {
          if (alive.current) setNote({ kind: 'err', text: `读取失败：${e.message}` })
        } finally {
          if (alive.current) setBusy('')
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const save = async (which) => {
        setBusy('save')
        try {
          const text = which === 'persona' ? persona : rules
          const body = await postJson('/save', { which, text })
          if (!alive.current) return
          setDirty((d) => ({ ...d, [which]: false }))
          setNote({ kind: 'ok', text: `已保存 ${body.bytes} 字节 → ${body.path}（约 2 秒内对后续请求生效）` })
          setData((s) => (s ? { ...s, [which]: { ...s[which], text, bytes: body.bytes, source: body.path, persisted: true } } : s))
        } catch (e) {
          if (alive.current) setNote({ kind: 'err', text: `保存失败：${e.message}` })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const NOTE = {
        armed: {
          on: '破甲已开启：人设/规则段生效，固定身份开场白被剔除，削减文案改写生效。',
          off: '破甲已关闭：人设/规则段清空、改写停用、身份开场白恢复 —— 等同于原版 DSH。',
        },
        recover: {
          on: '拒答恢复已开启：一轮正常收尾但内容是拒答时，自动补一句把它顶回去（每轮上限 2 次）。',
          off: '拒答恢复已关闭：模型拒答时不再自动补话。',
        },
        continue: {
          on: '空转续写已开启：输出被 max-tokens 截断时自动补「继续」（每轮上限 3 次）。',
          off: '空转续写已关闭。',
        },
      }

      // key: 'armed' | 'recover' | 'continue'
      const toggle = async (key, next) => {
        setBusy('toggle')
        try {
          const body = await postJson('/toggle', { key, enabled: next })
          if (!alive.current) return
          setData((s) => (s ? { ...s, [key]: body[key] } : s))
          const on = !!body[key]
          setNote({ kind: on ? 'ok' : 'warn', text: NOTE[key] ? NOTE[key][on ? 'on' : 'off'] : `${key} → ${on}` })
        } catch (e) {
          if (alive.current) setNote({ kind: 'err', text: `切换失败：${e.message}` })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const wrap = (children) => h('div', {
        style: {
          height: '100%', overflowY: 'auto', boxSizing: 'border-box',
          padding: '26px 30px 64px', color: T.label,
        },
      }, h('div', { style: { maxWidth: 980, margin: '0 auto' } }, children))

      if (!data) {
        return wrap([
          h('h2', { key: 't', style: { margin: 0, fontSize: 18, fontWeight: 700 } }, '破甲'),
          h('div', { key: 's', style: { marginTop: 12, fontSize: 13, color: note ? T.err : T.label2 } },
            busy === 'load' ? '读取中…' : (note ? note.text : '无法读取破甲状态')),
          note ? h('div', { key: 'r', style: { marginTop: 14 } },
            h(Btn, { onClick: () => void load(), primary: true }, '重试')) : null,
        ])
      }

      const tone = note ? (note.kind === 'ok' ? T.ok : note.kind === 'warn' ? T.warn : T.err) : T.label2
      const metaOf = (slot) => `${slot.source || slot.path || '(未知来源)'} · ${slot.bytes} 字节`
        + (slot.persisted === false ? ' · 尚未落盘，保存后写入该路径' : '')
        + (slot.inline ? ' · 来自 YAML 内联值（保存后改写到文件）' : '')
      const personaMeta = metaOf(data.persona)
      const rulesMeta = metaOf(data.rules)

      return wrap([
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
        },
          h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, '破甲'),
          h('span', { style: { fontSize: 12, color: T.label2 } },
            '运行时改写系统提示词 · 不改任何官方文件'),
          h('span', { style: { flex: 1 } }),
          h(Switch, { on: !!data.armed, busy: busy === 'toggle', onChange: (v) => void toggle('armed', v) }),
        ),

        h('div', {
          key: 'facts',
          style: {
            marginTop: 14, padding: 14, borderRadius: 12,
            background: T.layer2, border: `1px solid ${T.border}`,
            fontSize: 12, color: T.label2, lineHeight: 1.75,
          },
        },
          h('div', {}, '段顺序：armor:persona (-1500) → armor:rules (-1400) → 第一方指导'),
          h('div', {}, '剔除的身份段：harness:identity、deployment:persona-prefix'),
          h('div', {}, `文件目录：${data.home}`),
          h('div', {}, `外部直接改人设/规则文件会在 ${data.watchIntervalMs || 2000} ms 内被读到；三个开关写在 state.json，重启后保持（外部改那个文件要重启才读）。`),
        ),

        h('div', {
          key: 'switches',
          style: {
            marginTop: 12, padding: '12px 14px', borderRadius: 12,
            background: T.layer2, border: `1px solid ${T.border}`,
            display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center',
          },
        },
          h('span', { style: { fontSize: 12, color: T.label2 } }, '附加层（事件级，不碰提示词）：'),
          h(Switch, {
            on: !!data.recover, busy: busy === 'toggle', compact: true,
            onChange: (v) => void toggle('recover', v),
            onText: '拒答恢复 · 开', offText: '拒答恢复 · 关',
            onTitle: '拒答会被自动顶回去；点击关闭', offTitle: '模型拒答时不动它；点击开启',
          }),
          h(Switch, {
            on: !!data.continue, busy: busy === 'toggle', compact: true,
            onChange: (v) => void toggle('continue', v),
            onText: '空转续写 · 开', offText: '空转续写 · 关',
            onTitle: '输出被 max-tokens 截断时自动补「继续」；点击关闭', offTitle: '点击开启',
          }),
          h('span', { style: { fontSize: 11.5, color: T.label2 } },
            `每轮上限 ${data.recoverMax ?? 2} / ${data.continueMax ?? 3} 次；破甲总开关关掉时这两个也停。`),
        ),

        note ? h('div', {
          key: 'note',
          style: { marginTop: 14, fontSize: 12.5, color: tone, lineHeight: 1.6 },
        }, note.text) : null,

        h(Editor, {
          key: 'persona',
          title: '人设', hint: '段 armor:persona，排在最前，永远先于第一方指导',
          value: persona, meta: personaMeta, dirty: dirty.persona, busy,
          onChange: (v) => { setPersona(v); setDirty((d) => ({ ...d, persona: true })) },
          onSave: () => void save('persona'),
          onReload: () => void load(),
        }),

        h(Editor, {
          key: 'rules',
          title: '规则', hint: '段 armor:rules，紧跟在人设之后',
          value: rules, meta: rulesMeta, dirty: dirty.rules, busy,
          onChange: (v) => { setRules(v); setDirty((d) => ({ ...d, rules: true })) },
          onSave: () => void save('rules'),
          onReload: () => void load(),
        }),
      ])
    }

    // ── 侧栏图标 ──────────────────────────────────────────────────────
    function ArmorGlyph({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('path', {
          d: 'M12 3.2 18.6 6v5.4c0 3.9-2.7 7.1-6.6 8.4-3.9-1.3-6.6-4.5-6.6-8.4V6L12 3.2Z',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M6.6 17.4 17.4 6.6',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 中央面板（sidebar.panellist 的 id 会派发到 main 的同名 key）
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'armor',
        }, () => h(ArmorPanel)))

        // 侧栏入口：插件(0) / 破甲(30) / 上下文洞察(20) 同一组
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'armor',
          order: 30,
          label: '破甲',
        }, (props) => h(ArmorGlyph, { size: props && props.size })))
      },
    }
  },
})
