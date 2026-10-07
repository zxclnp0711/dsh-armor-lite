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
//  5. 拒答自动恢复 / 空转续写走 refusal-recover.js（事件层：agent/status + agent.followup），
//     与提示词组装无关，但受同一个破甲总开关约束 —— 破甲关掉它就跟着停。
//
// 注意（宿主结构死角，复核时确认）：system-prompt 的 assemble() 在瀑布返回之后还有一步
// 强制覆盖 —— 只要有任何一段带 complete:true，最终 sections 会被换成那一段，本插件的
// drop/strip 全部作废。本机现役 preset（redteam/seep/tongjiapo/krea2-unrestricted）都只用
// prefix，不开 complete，所以不受影响；哪天用了开 complete 的 preset，这里的改写会静默失效。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DEFAULT_STRIP_RULES } from './strip-rules.js'
import { installRefusalRecover } from './refusal-recover.js'

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
  stripTools: true,
  stripRules: null,
  dropSections: ['harness:identity', 'deployment:persona-prefix'],
  replaceSections: {},
  suppressRuntimeContext: false,

  // 拒答恢复 / 空转续写（实现见 refusal-recover.js）
  refusalRecover: true,
  refusalRecoverMax: 2,
  refusalRecoverChainMax: 3,
  refusalRecoverText: '',
  refusalRecoverHeadLimit: 240,
  autoContinue: true,
  autoContinueMax: 3,
  autoContinueText: '继续',
  skipSubagentRecover: true,
  hardStopPatterns: null,

  // 运维
  watchIntervalMs: 2000,
  dumpSections: false,
  verbose: false,
}

const TOGGLE_KEYS = ['armed', 'recover', 'continue']

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

  // 工具描述兜底。先澄清一件事：本机的「untrusted / 仅供参考」措辞其实**全在 prompt sections 里**
  // （dsh-tool-web 用 systemPrompt.section() 注册行为指导文本），上面第 3 步早就改到了；
  // purge 的 TOOL_WEB_UNTRUSTED_NEUTRAL 补丁改的也是同一个文件。
  // 实测最后一次请求的 request/header（会话日志记录完整 tools schema）：58 个工具的 description
  // 里没有这类措辞 —— 这一支当前命中 0，属于空转兜底，防宿主升级后把文案挪进 description。
  // 命中 0 时返回原对象，没有副作用。只改 description，不动 name / parameters。
  let tools = assembly.tools
  if (config.stripTools !== false && Array.isArray(tools)) {
    tools = tools.map((tool) => {
      const got = applyRules(String(tool.description ?? ''), rules, 'tools')
      hits += got.hits
      return got.text === tool.description ? tool : { ...tool, description: got.text }
    })
  }

  if (hits && config.verbose) console.log(`[armor-lite] rewrote ${hits} phrase(s)`)
  return { ...assembly, sections, contexts, tools }
}

// ── 三个开关：进程内即时生效 + 落盘持久化 ────────────────────────────────
//   armed    破甲总开关（人设/规则段 + 组装后改写）
//   recover  拒答自动恢复
//   continue 空转续写（只在 reason.kind === 'max-tokens' 时补话）
// 旧版 state.json 只有 armed 一个键，缺的字段一律按「开」处理，向后兼容。
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return {
      armed: raw.armed !== false,
      recover: raw.recover !== false,
      continue: raw.continue !== false,
    }
  } catch {
    return { armed: true, recover: true, continue: true }
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(armorDir(), { recursive: true })
    const body = `${JSON.stringify({
      armed: state.armed,
      recover: state.recover,
      continue: state.continue,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`
    // 先写临时文件再改名：半截 JSON 会让下次 loadState 整个回落「全开」，
    // 对破甲插件来说那等于悄悄把破甲打开 —— 代价比多一次 rename 大得多。
    const tmp = `${stateFile()}.tmp`
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, stateFile())
    return true
  } catch {
    return false
  }
}

/** 与 refusal-recover.js 内的 clamp 同规则：面板显示的就是真正生效的上限。 */
function clampCount(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(max, Math.trunc(n)))
}

/** 硬停白名单：接受字符串（当正则源）或 RegExp；空 / 非数组 / 写坏了都回落到 refusal-recover.js 的默认。 */
function normalizeHardStop(list) {
  if (!Array.isArray(list) || !list.length) return null
  try {
    return list.map((entry, i) => {
      if (entry instanceof RegExp) return entry
      if (typeof entry === 'string') return new RegExp(entry, 'u')
      throw new TypeError(`hardStopPatterns[${i}] 需要字符串或 RegExp`)
    })
  } catch (error) {
    // 一个坏正则不能让整个插件加载失败 —— 那等于破甲全线静默失效
    console.log(`[armor-lite] hardStopPatterns 配置有问题，回落内置硬停表：${String((error && error.message) || error)}`)
    return null
  }
}

// ── 侧栏面板的数据面：同源于宿主 webServer（与 dshmarket 同款接法）──────
function mountApi(hostCtx, state, slots, config, log) {
  const readJson = (req) => new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      // destroy 之后必须自己 resolve —— 否则 error 事件之外的路径会让这个请求悬挂
      if (raw.length > 4 * 1024 * 1024) { req.destroy(); resolve(null) }
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
        recover: state.recover,
        continue: state.continue,
        home: armorDir(),
        watchIntervalMs: config.watchIntervalMs,
        recoverMax: clampCount(config.refusalRecoverMax, 2, 5),
        continueMax: clampCount(config.autoContinueMax, 3, 20),
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
        return sendJson(res, 400, { error: '需要 { enabled: boolean, key?: "armed"|"recover"|"continue" }' })
      }
      // key 省略 = armed，旧前端调用照旧能用
      const key = TOGGLE_KEYS.includes(body.key) ? body.key : 'armed'
      state[key] = body.enabled
      const persisted = saveState(state)
      log(`${key} -> ${state[key]} (persisted=${persisted})`)
      sendJson(res, 200, {
        ok: true,
        key,
        armed: state.armed,
        recover: state.recover,
        continue: state.continue,
        persisted,
      })
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

  const state = loadState()

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
  const rules = (() => {
    if (!Array.isArray(config.stripRules) || !config.stripRules.length) return DEFAULT_STRIP_RULES
    try {
      return normalizeRules(config.stripRules)
    } catch (error) {
      // 同上：坏配置回落内置表，不让插件加载失败
      console.log(`[armor-lite] stripRules 配置有问题，回落内置改写表：${String((error && error.message) || error)}`)
      return DEFAULT_STRIP_RULES
    }
  })()
  if (config.strip !== false) {
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const done = typeof next === 'function' ? await next() : assembly
      if (!state.armed) return done
      try {
        return rewrite(done, rules, config)
      } catch (error) {
        // 改写表里若塞了会抛的 replace 函数，不能连带掀掉这次组装（整个 turn 会变 error）
        console.log(`[armor-lite] 组装后改写失败，本次原样返回：${String((error && error.message) || error)}`)
        return done
      }
    }, { global: true, prepend: true })
  }

  // 4) 热更新：轮询而非 fs.watch —— 覆盖「文件还不存在 → 被创建」的情况。
  //    内联与否在每个 tick 现判、不在启动时固定：面板保存会把 slot.inline 置 false，
  //    那一刻起它就该进轮询，否则「面板存过之后再手改文件」读不到。
  if (config.watch !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const slot of slots) {
          if (slot.inline) continue
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

  // 6) 拒答自动恢复 / 空转续写：纯事件层，不碰提示词组装。
  //    判据与补话见 refusal-recover.js 顶部注释（都对着本机源码核过）。
  //    三个开关（armed / recover / continue）任一关掉即停。面板改动立即生效；
  //    直接改 state.json 要重启才读得到（state 只在插件加载时读一次）。
  if (config.refusalRecover !== false || config.autoContinue !== false) {
    ctx.effect(() => installRefusalRecover(ctx, {
      enabled: () => state.armed && state.recover && config.refusalRecover !== false,
      continueEnabled: () => state.armed && state.continue && config.autoContinue !== false,
      maxPerTurn: config.refusalRecoverMax,
      chainMax: config.refusalRecoverChainMax,
      continueMax: config.autoContinueMax,
      headLimit: config.refusalRecoverHeadLimit,
      recoverText: config.refusalRecoverText,
      continueText: config.autoContinueText,
      hardStop: normalizeHardStop(config.hardStopPatterns),
      skipSubagents: config.skipSubagentRecover !== false,
      log,
    }))
  }

  log(`armed (armed=${state.armed}, recover=${state.recover}, continue=${state.continue}, sections=${slots.length}, strip=${config.strip !== false}, rules=${rules.length}, drop=${(config.dropSections ?? []).length})`)
}
