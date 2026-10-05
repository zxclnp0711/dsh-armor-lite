// dsh-armor-lite — 轻量破甲层（Host 半）
//
// 设计要点：
//  1. 不 import 任何 @deepseek-ai/* 运行时包（只声明 peerDep cordis），避免 profile 里
//     resolve 不到 schemastery/tools；因此不导出 Config schema，配置由 normalize 处理。
//  2. 人设 / 本地规则走 $DSH_HOME\armor\*.md 文件，段文本用函数，改文件下次组装即生效。
//  3. 破甲靠 system-prompt/assemble 瀑布（{global:true, prepend:true} = 最外层），
//     拿到的是各层处理完的最终 assembly，返回值就是交付给模型的提示词 —— 层序无关，
//     官方更新覆盖文件也打不回来。
//  4. 侧栏「破甲」面板（Client 半）通过 /dsh-armor/api/* 读写本文件持有的状态。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DEFAULT_STRIP_RULES } from './strip-rules.js'

export const name = 'dsh-armor-lite'
export const inject = ['systemPrompt']

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const armorDir = () => path.join(dshHome(), 'armor')
const stateFile = () => path.join(armorDir(), 'state.json')
const bundled = (rel) => fileURLToPath(new URL(rel, import.meta.url))

const DEFAULTS = {
  enabled: true,

  // 人设段
  persona: '',
  personaFile: '',
  personaOrder: -1500,

  // 本地规则段（接 AGENTS.md 那套的活）
  rules: '',
  rulesFile: '',
  rulesOrder: -1400,

  // 组装后处理
  strip: true,
  stripContexts: true,
  stripRules: null,
  dropSections: ['harness:identity', 'deployment:persona-prefix'],
  replaceSections: {},
  suppressRuntimeContext: false,

  // 运维
  watchIntervalMs: 2000,
  dumpSections: false,
  verbose: false,
}

const SECTION_SPECS = [
  {
    key: 'persona',
    section: 'armor:persona',
    orderKey: 'personaOrder',
    defaultFile: 'persona.md',
    bundledFile: './personas/default.md',
    label: '人设',
  },
  {
    key: 'rules',
    section: 'armor:rules',
    orderKey: 'rulesOrder',
    defaultFile: 'rules.md',
    bundledFile: './personas/default-rules.md',
    label: '规则',
  },
]

function loadText(spec, config) {
  const inline = config[spec.key]
  if (typeof inline === 'string' && inline.trim()) return { text: inline, src: `YAML 内联 config.${spec.key}` }
  const custom = config[`${spec.key}File`]
  const file = custom ? path.resolve(custom) : path.join(armorDir(), spec.defaultFile)
  try {
    return { text: fs.readFileSync(file, 'utf8'), src: file }
  } catch { /* 用户还没建，落到内置默认 */ }
  try {
    return { text: fs.readFileSync(bundled(spec.bundledFile), 'utf8'), src: `内置默认 ${spec.bundledFile}` }
  } catch { /* 没有内置文件 */ }
  return { text: '', src: '无内容' }
}

function normalizeRules(list) {
  return list.map((rule, i) => {
    if (rule.match instanceof RegExp) return rule
    if (typeof rule.pattern !== 'string') {
      throw new TypeError(`stripRules[${i}] 需要 pattern 字符串，或 RegExp 类型的 match`)
    }
    return {
      name: rule.name ?? `rule-${i}`,
      match: new RegExp(rule.pattern, rule.flags ?? 'g'),
      replace: rule.replace ?? '',
      apply: rule.apply,
    }
  })
}

function applyRules(text, rules, kind) {
  let hits = 0
  let out = text
  for (const rule of rules) {
    if (rule.apply && !rule.apply.includes(kind)) continue
    out = out.replace(rule.match, (...args) => {
      hits += 1
      return typeof rule.replace === 'function' ? rule.replace(...args) : rule.replace
    })
  }
  return { text: out, hits }
}

let dumpedOnce = false

function rewrite(assembly, rules, config) {
  const drop = new Set(config.dropSections ?? [])
  const replace = config.replaceSections ?? {}
  let hits = 0

  if (config.dumpSections && !dumpedOnce) {
    dumpedOnce = true
    for (const section of assembly.sections ?? []) {
      console.log(`[armor-lite] section ${JSON.stringify(section.name)} len=${String(section.text ?? '').length}`)
    }
  }

  const sections = []
  for (const section of assembly.sections ?? []) {
    if (drop.has(section.name)) {
      hits += 1
      continue
    }
    if (Object.prototype.hasOwnProperty.call(replace, section.name)) {
      hits += 1
      sections.push({ ...section, text: replace[section.name], interpolate: false })
      continue
    }
    const got = applyRules(String(section.text ?? ''), rules, 'sections')
    hits += got.hits
    sections.push(got.text === section.text ? section : { ...section, text: got.text })
  }

  const contexts = config.stripContexts === false
    ? assembly.contexts
    : (assembly.contexts ?? []).map((entry) => {
        const got = applyRules(String(entry.text ?? ''), rules, 'contexts')
        hits += got.hits
        return got.text === entry.text ? entry : { ...entry, text: got.text }
      })

  if (hits && config.verbose) console.log(`[armor-lite] rewrote ${hits} phrase(s)`)
  return { ...assembly, sections, contexts }
}

// ── 破甲开关：进程内即时生效 + 落盘持久化 ────────────────────────────────
function loadArmed() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return raw.armed !== false
  } catch {
    return true
  }
}

function saveArmed(armed) {
  try {
    fs.mkdirSync(armorDir(), { recursive: true })
    fs.writeFileSync(
      stateFile(),
      `${JSON.stringify({ armed, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

// ── 侧栏面板的数据面：同源于宿主 webServer（与 dshmarket 同款接法）──────
function mountApi(hostCtx, state, slots, config, log) {
  const readJson = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })

  const sendJson = (res, code, payload) => {
    let body = ''
    try { body = JSON.stringify(payload) } catch { body = '{"error":"serialize failed"}' }
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  const slotOf = (key) => slots.find((slot) => slot.spec.key === key) ?? null

  const describe = (slot) => {
    if (!slot) return { text: '', path: '', source: '', persisted: false, inline: false, bytes: 0 }
    const persisted = fs.existsSync(slot.watchFile)
    return {
      text: slot.text,
      path: slot.watchFile,
      source: persisted ? slot.watchFile : slot.src,
      persisted,
      inline: slot.inline,
      bytes: Buffer.byteLength(slot.text, 'utf8'),
    }
  }

  const routes = [
    ['/dsh-armor/api/state', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      sendJson(res, 200, {
        armed: state.armed,
        home: armorDir(),
        watchIntervalMs: config.watchIntervalMs,
        persona: describe(slotOf('persona')),
        rules: describe(slotOf('rules')),
      })
    }],

    ['/dsh-armor/api/save', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const body = await readJson(req)
      if (!body || typeof body.which !== 'string' || typeof body.text !== 'string') {
        return sendJson(res, 400, { error: '需要 { which: "persona"|"rules", text: string }' })
      }
      const slot = slotOf(body.which)
      if (!slot) return sendJson(res, 400, { error: `未知目标 ${JSON.stringify(body.which)}` })
      try {
        fs.mkdirSync(path.dirname(slot.watchFile), { recursive: true })
        fs.writeFileSync(slot.watchFile, body.text, 'utf8')
        // 立刻生效，不等下一次轮询；并让位给文件（内联值不再优先）
        slot.text = body.text
        slot.inline = false
        slot.src = slot.watchFile
        const bytes = Buffer.byteLength(body.text, 'utf8')
        log(`${slot.spec.section} saved <- ${slot.watchFile} (${bytes} bytes)`)
        sendJson(res, 200, { ok: true, path: slot.watchFile, bytes })
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    }],

    ['/dsh-armor/api/toggle', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const body = await readJson(req)
      if (!body || typeof body.enabled !== 'boolean') {
        return sendJson(res, 400, { error: '需要 { enabled: boolean }' })
      }
      state.armed = body.enabled
      const persisted = saveArmed(state.armed)
      log(`armed -> ${state.armed} (persisted=${persisted})`)
      sendJson(res, 200, { ok: true, armed: state.armed, persisted })
    }],
  ]

  const disposers = routes.map(([routePath, handler]) => hostCtx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: (req, res) => {
      Promise.resolve(handler(req, res)).catch((e) => {
        try { sendJson(res, 500, { error: String((e && e.message) || e) }) } catch { /* 已结束 */ }
      })
    },
  }))

  return () => { for (const dispose of disposers) { try { dispose() } catch { /* 已释放 */ } } }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  if (config.enabled === false) return
  const log = (...args) => { if (config.verbose) console.log('[armor-lite]', ...args) }

  const state = { armed: loadArmed() }

  const slots = SECTION_SPECS.map((spec) => {
    const inline = typeof config[spec.key] === 'string' && config[spec.key].trim()
    const custom = config[`${spec.key}File`]
    const watchFile = custom ? path.resolve(custom) : path.join(armorDir(), spec.defaultFile)
    const got = loadText(spec, config)
    log(`${spec.section} <- ${got.src} (${got.text.length} chars)`)
    return { spec, watchFile, inline: Boolean(inline), text: got.text, src: got.src }
  })

  // 1) 人设段 + 本地规则段。order 都低于 HARNESS_IDENTITY(-1000)，永远排在第一方指导之前。
  //    text 是函数 → 每次组装重新求值；关掉破甲或文本为空时该段自动消失。
  for (const slot of slots) {
    ctx.systemPrompt.section({
      name: slot.spec.section,
      order: config[slot.spec.orderKey],
      interpolate: false,
      text: () => (state.armed ? slot.text : ''),
    })
  }

  // 2) 可选：掐掉全部动态 runtime 上下文
  if (config.suppressRuntimeContext) ctx.systemPrompt.suppressRuntimeContext()

  // 3) 组装后改写：global + prepend = 最外层监听器，拥有最后一句话权。
  //    破甲关掉时原样返回、什么都不动 = 原版行为。
  const rules = Array.isArray(config.stripRules) && config.stripRules.length
    ? normalizeRules(config.stripRules)
    : DEFAULT_STRIP_RULES
  if (config.strip !== false) {
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const done = typeof next === 'function' ? await next() : assembly
      if (!state.armed) return done
      return rewrite(done, rules, config)
    }, { global: true, prepend: true })
  }

  // 4) 热更新：轮询而非 fs.watch —— 覆盖「文件还不存在 → 被创建」的情况
  const watched = slots.filter((slot) => !slot.inline)
  if (config.watch !== false && watched.length) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const slot of watched) {
          try {
            const next = fs.readFileSync(slot.watchFile, 'utf8')
            if (next !== slot.text) {
              slot.text = next
              slot.src = slot.watchFile
              log(`${slot.spec.section} reloaded <- ${slot.watchFile}`)
            }
          } catch { /* 文件缺失时保留当前文案 */ }
        }
      }, config.watchIntervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    })
  }

  // 5) 侧栏面板的数据面：宿主有 webServer 才挂；headless 下插件照常工作
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () => mountApi(hostCtx, state, slots, config, log),
      'armor-lite: panel api routes',
    )
  })

  log(`armed (armed=${state.armed}, sections=${slots.length}, strip=${config.strip !== false}, rules=${rules.length}, drop=${(config.dropSections ?? []).length})`)
}
