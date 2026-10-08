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

    // 主题 token 全部带 fallback —— 宿主自己的 CSS 就是这么写的
    // （`var(--dsw-alias-label-primary, var(--dsh-boot-label-primary))`）。
    // 两个坑记这里，别再踩：
    //   1) 深色主题下 `--dsw-alias-brand-primary` 解析成 neutral-bluish-50 = #fafafa（近白），
    //      所以 primary 填充上的文字**不能**写死 #fff —— 要用 label-primary-foreground（同条件下近黑）。
    //   2) 原生 button 的 appearance 不关掉时，Chromium 会拿 buttonface（白）当底色。
    const T = {
      layer1: 'var(--dsw-alias-bg-layer-1, #1b1d21)',
      layer2: 'var(--dsw-alias-bg-layer-2, #212429)',
      layer3: 'var(--dsw-alias-bg-layer-3, #2a2e34)',
      border: 'var(--dsw-alias-border-l1, #ffffff1f)',
      border2: 'var(--dsw-alias-border-l2, #ffffff2e)',
      brand: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #fafafa))',
      brandText: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
      label: 'var(--dsw-alias-label-primary, #f5f6f7)',
      label2: 'var(--dsw-alias-label-secondary, #a8adb5)',
      hover: 'var(--dsw-alias-interactive-bg-hover, #ffffff14)',
      ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
      err: 'var(--dsw-alias-state-error-primary, #f04438)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    }
    /** 原生控件外观一律关掉：留着它，背景色在某些状态下会被 UA 的 buttonface 顶掉。 */
    const NO_APPEARANCE = { appearance: 'none', WebkitAppearance: 'none' }

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
          fontFamily: 'inherit',
          ...NO_APPEARANCE,
          border: `1px solid ${on ? T.brand : T.border2}`,
          background: on ? T.brand : T.layer3,
          // 开态填充在深色主题下是近白，文字必须用 foreground 而不是 #fff
          color: on ? T.brandText : T.label2,
          fontSize: compact ? 12 : 13, fontWeight: 600,
        },
      },
        h('span', {
          style: {
            width: 9, height: 9, borderRadius: 999,
            background: on ? T.brandText : T.label2,
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
          ...NO_APPEARANCE,
          border: `1px solid ${primary ? T.brand : T.border2}`,
          // 次要按钮给明确填充（不再用 transparent）：透明时按钮的可见性全压在边框上，
          // 而深色主题下 border-l1 只有 6% 不透明度，看上去就是一块没有边界的东西
          background: primary ? T.brand : T.layer3,
          color: primary ? T.brandText : T.label,
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

    // 人设库选择器。刻意不用 window.prompt —— Electron 渲染进程里它不可用，改成内联小表单。
    function PersonaPicker({ data, busy, onActivate, onCreate, onRemove }) {
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [manage, setManage] = React.useState(false)
      const current = (data.active && data.active.persona) || 'legacy'
      const available = (data.personas && data.personas.available) || []
      const options = [{ id: 'legacy', name: 'legacy · 直读 armor\\persona.md' }]
        .concat(available.map((p) => ({
          id: p.id,
          name: `${p.emoji ? `${p.emoji} ` : ''}${p.name} · ${p.bytes}B${p.valid === false ? ' · 缺 persona.md' : ''}`,
        })))
      // 与后端 PERSONA_ID_RE 同口径：末尾不许是 '.' / '-'
      const idOk = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/.test(draft)
      return h('section', { style: { marginTop: 26 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: 15, fontWeight: 700, color: T.label } }, '人设库'),
          h('span', { style: { fontSize: 12, color: T.label2 } },
            '选一份注入；legacy = 直读 armor\\persona.md'),
          h('span', { style: { flex: 1 } }),
          h('select', {
            value: current,
            disabled: !!busy,
            onChange: (e) => onActivate(e.target.value),
            style: {
              padding: '6px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              fontFamily: 'inherit', cursor: busy ? 'wait' : 'pointer',
              color: T.label, background: T.layer1, border: `1px solid ${T.border}`,
            },
          }, options.map((o) => h('option', { key: o.id, value: o.id }, o.name))),
          h(Btn, { onClick: () => setOpen((v) => !v), disabled: !!busy }, open ? '取消' : '新建副本'),
          // 移走入口必须列在库里：后端禁止移走"使用中"的那份，而选中某个人设就等于让它变成使用中 ——
          // 只放一个跟随当前值的按钮，这个功能永远点不到。
          available.length
            ? h(Btn, { onClick: () => setManage((v) => !v), disabled: !!busy },
                manage ? '收起管理' : `管理 · ${available.length}`)
            : null,
        ),
        manage
          ? h('div', {
              style: {
                marginTop: 10, padding: '10px 12px', borderRadius: 10,
                background: T.layer2, border: `1px solid ${T.border}`,
              },
            },
              available.map((p) => h('div', {
                key: p.id,
                style: { display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0', flexWrap: 'wrap' },
              },
                h('span', { style: { fontSize: 12.5, color: T.label } }, `${p.emoji ? `${p.emoji} ` : ''}${p.name}`),
                h('span', {
                  style: { fontSize: 11.5, color: T.label2, fontFamily: 'ui-monospace, Consolas, monospace' },
                }, p.id),
                h('span', { style: { fontSize: 11.5, color: T.label2 } }, `${p.bytes}B`),
                h('span', { style: { flex: 1 } }),
                p.id === current
                  ? h('span', { style: { fontSize: 11.5, color: T.label2 } }, '使用中')
                  : h(Btn, { onClick: () => onRemove(p.id), disabled: !!busy }, '移走'),
              )),
            )
          : null,
        open
          ? h('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('input', {
                value: draft,
                placeholder: '新 id：小写 ASCII，如 asuka',
                spellCheck: false,
                onChange: (e) => setDraft(e.target.value),
                style: {
                  padding: '6px 10px', borderRadius: 8, fontSize: 13, width: 240,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  color: T.label, background: T.layer1, border: `1px solid ${T.border}`, outline: 'none',
                },
              }),
              h(Btn, {
                primary: true,
                disabled: !!busy || !idOk,
                onClick: () => {
                  // 失败时保留表单与输入 —— 清掉等于让用户重打一遍
                  Promise.resolve(onCreate(draft)).then((ok) => {
                    if (ok) { setDraft(''); setOpen(false) }
                  })
                },
              }, '创建'),
              h('span', { style: { fontSize: 11.5, color: draft && !idOk ? T.err : T.label2 } },
                draft && !idOk
                  ? 'id 只能是小写字母/数字/._-，且以字母或数字开头结尾'
                  : '从 _template 复制一份骨架'),
            )
          : null,
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
      // 有未保存草稿时切换人设要二次确认；这里记「待确认的目标 id」
      const [pendingActivate, setPendingActivate] = React.useState('')
      const alive = React.useRef(true)
      // 体内必须重置回 true：StrictMode / dev 双调用下 cleanup 会先跑一次，
      // 只写 cleanup 会把 alive.current 永久钉成 false，面板就永远停在「读取中…」。
      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

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
          if (body.effective === false) {
            // 写成功但没生效（被 YAML 内联覆盖，或写的是库里另一份）—— 不能报「已生效」
            setNote({ kind: 'warn', text: `已写入 ${body.path}（${body.bytes} 字节），但当前未生效：${body.reason || '非当前生效的那份'}` })
            await refreshList()
          } else {
            setNote({ kind: 'ok', text: `已保存 ${body.bytes} 字节 → ${body.path}（约 2 秒内对后续请求生效）` })
            setData((s) => (s
              ? {
                  ...s,
                  [which]: {
                    ...s[which],
                    text,
                    bytes: body.bytes,
                    source: body.path,
                    persisted: true,
                    effective: true,
                    requested: '',
                    fallbackFrom: '',
                  },
                }
              : s))
          }
        } catch (e) {
          if (alive.current) setNote({ kind: 'err', text: `保存失败：${e.message}` })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      // 只刷人设列表，不动 note（load() 会清掉提示）
      const refreshList = async () => {
        try {
          const body = await call('/personas')
          if (!alive.current) return
          setData((s) => (s
            ? { ...s, active: body.active, personas: { ...(s.personas || {}), dir: body.dir, activeFile: body.activeFile, available: body.list } }
            : s))
        } catch (e) {
          // 刷新失败必须说出来：否则下拉停在旧值，已移走的人设还留在选项里
          if (alive.current) setNote({ kind: 'warn', text: `人设列表刷新失败：${e.message}（下拉可能停在旧值）` })
        }
      }

      const activate = async (id) => {
        setBusy('activate')
        try {
          const body = await postJson('/activate', { persona: id })
          if (!alive.current) return
          setPendingActivate('')
          setData((s) => (s ? { ...s, active: body.active, persona: body.persona } : s))
          setPersona((body.persona && body.persona.text) || '')
          setDirty((d) => ({ ...d, persona: false }))
          const label = id === 'legacy' ? 'legacy（直读 armor\\persona.md）' : id
          if (body.effective === false) {
            setNote({ kind: 'warn', text: `指针已切到 ${label}，但当前未生效：${body.reason || '被覆盖'}` })
          } else if (body.persisted === false) {
            setNote({ kind: 'warn', text: `已切到 ${label} 并当场生效，但 active.json 没写下去（重启后会回到旧值）。` })
          } else {
            setNote({ kind: 'ok', text: `已切到 ${label}，下一次请求即生效。` })
          }
          await refreshList()
        } catch (e) {
          if (alive.current) setNote({ kind: 'err', text: `切换失败：${e.message}` })
        } finally {
          if (alive.current) setBusy('')
        }
      }

      // 切换会覆盖编辑器内容：有未保存草稿时要求再选一次确认
      const requestActivate = (id) => {
        if (dirty.persona && pendingActivate !== id) {
          setPendingActivate(id)
          setNote({ kind: 'warn', text: `人设正文有未保存的修改。再选一次 ${id} 就切换（未保存内容会丢）。` })
          return
        }
        void activate(id)
      }

      const createPersona = async (id) => {
        setBusy('create')
        try {
          const body = await postJson('/persona/create', { id })
          if (!alive.current) return false
          setNote({ kind: 'ok', text: `已建 ${body.file}（来源 ${body.source}）。填好人设后在上方下拉里选它。` })
          await refreshList()
          return true
        } catch (e) {
          if (alive.current) setNote({ kind: 'err', text: `新建失败：${e.message}` })
          return false
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const removePersona = async (id) => {
        setBusy('remove')
        try {
          const body = await postJson('/persona/remove', { id })
          if (!alive.current) return
          setNote({ kind: 'warn', text: `已把 ${id} 移入 ${body.trashed}（没有真删除，可手动还原）。` })
          await refreshList()
        } catch (e) {
          if (alive.current) setNote({ kind: 'err', text: `移走失败：${e.message}` })
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
          const line = NOTE[key] ? NOTE[key][on ? 'on' : 'off'] : `${key} → ${on}`
          // persisted=false 时页面看起来切了、重启又回来：这种事必须当场说
          setNote({
            kind: body.persisted === false ? 'warn' : (on ? 'ok' : 'warn'),
            text: body.persisted === false ? `${line} 但 state.json 没写下去（重启后会回到旧值）。` : line,
          })
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
      const metaOf = (slot) => {
        const parts = [`${slot.source || slot.path || '(未知来源)'} · ${slot.bytes} 字节`]
        if (slot.persisted === false) parts.push('尚未落盘，保存后写入该路径')
        if (slot.inline) parts.push('来自 YAML 内联值（保存后改写到文件）')
        if (slot.kind === 'library') parts.push(`库模式 · ${slot.id}`)
        if (slot.kind === 'legacy') parts.push('legacy 直读')
        if (slot.kind === 'bundled') parts.push('内置兜底')
        if (slot.fallbackFrom) parts.push(`⚠ 指针要的 ${slot.fallbackFrom} 没生效，实际注入的是上面这一份`)
        else if (slot.requested && slot.kind !== 'library') parts.push(`⚠ 指针要的是 ${slot.requested}，被 personaFile 覆盖`)
        if (slot.composed && slot.composed.baseBytes > 0) {
          parts.push(`注入时前置 _base ${slot.composed.baseBytes} 字节 → 合计 ${slot.composed.totalBytes} 字节`)
        }
        return parts.join(' · ')
      }
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
          h('div', {}, `外部直接改人设/规则文件会在 ${data.watchIntervalMs || 2000} ms 内被读到；三个开关写在 state.json，当前人设写在 active.json —— 重启后都保持（外部直接改 state.json 要重启才读，改 active.json 不用）。`),
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

        h(PersonaPicker, {
          key: 'personas',
          data, busy,
          onActivate: (id) => requestActivate(id),
          onCreate: (id) => createPersona(id),
          onRemove: (id) => void removePersona(id),
        }),

        h(Editor, {
          key: 'persona',
          title: '人设正文',
          hint: (data.persona && data.persona.kind === 'library')
            ? `库里这一份（保存写它；_base 不在这里）`
            : '段 armor:persona，排在最前，永远先于第一方指导',
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
