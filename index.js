// dsh-armor-lite — 轻量提示词增强层（Host 半）
//
// 设计要点：
//  1. 不 import 任何 @deepseek-ai/* 运行时包（只声明 peerDep cordis），避免 profile 里
//     resolve 不到 schemastery/tools；因此不导出 Config schema，配置由 normalize 处理。
//  2. 人设 / 本地规则走 $DSH_HOME\armor\*.md 文件，段文本用函数，改文件下次组装即生效。
//  3. 提示词增强靠 system-prompt/assemble 瀑布（{global:true, prepend:true} = 最外层）。
//     v0.5.0 起改成「只追加不改写」：官方段一个字不动，提示词增强正文由 armor:execution-mode
//     段插入（order 30，紧跟 deployment:persona-prefix）。改写层（strip/drop/replace）
//     保留为可选开关，默认全关 —— 官方升级改措辞时本插件不会静默空转，也不会吞正文。
//  4. 侧栏「提示词增强」面板（Client 半）通过 /dsh-armor/api/* 读写本文件持有的状态。
//  5. 拒答自动恢复 / 空转续写走 refusal-recover.js（事件层：agent/status + agent.followup），
//     与提示词组装无关，但受同一个提示词增强总开关约束 —— 提示词增强关掉它就跟着停。
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
  // v0.6.0：降级到 10/20，排在官方身份句(-1000)与 persona-prefix(0)之后。
  // 旧值 -1500 是改写模式"抢位置"的残留；追加模式不需要抢。
  personaOrder: 10,

  // 执行契约段（追加层，等价 dsh-unrestricted 的 unrestricted:execution-mode）
  //   正文走 $DSH_HOME\\armor\\execution-mode.md → 内置 personas/default-execution-mode.md
  //   order 30：紧跟 deployment:persona-prefix(0)，在第一方工具指导之前
  executionMode: '',
  executionModeFile: '',
  executionModeOrder: 30,

  // 人设库（多套人设 + 激活指针）
  //   指针缺失 / JSON 坏 / persona 字段非法 → 一律按 'legacy' 处理（读 armor\persona.md），
  //   也就是升级后默认行为与旧版逐字节相同，不需要迁移任何东西。
  personaDir: '',
  activeFile: '',
  // 硬约束片段目录（相对 personas\）：'default' = _base；'' = 不拼
  baseFragment: 'default',
  // {{cwd}} / {{model}} / {{home}} / {{date}} 的最小替换；未知引用原样保留
  interpolateVars: true,

  // 本地规则段（接 AGENTS.md 那套的活）
  rules: '',
  rulesFile: '',
  rulesOrder: 20,

  // 组装后处理 —— v0.5.0 起默认全关：提示词增强层改成「只追加不改写」。
  //   strip / stripTools / stripContexts 保留为可选开关（想回到改写模式就打开），
  //   dropSections 默认空 = 官方身份句与 preset persona 原样保留。
  //   这样官方升级改了措辞，本插件不会静默空转，也不会把正文吞掉。
  strip: false,
  stripContexts: false,
  stripTools: false,
  stripRules: null,
  dropSections: [],
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

const TOGGLE_KEYS = ['armed', 'personaOn', 'executionModeOn', 'recover', 'continue']

// 最近一次改写层的命中情况（只在 wantsRewrite 时被写；面板据此判断「是不是在空转」）
const lastRewrite = { hits: 0, by: null, at: '', error: '' }

const SECTION_SPECS = [
  {
    key: 'persona',
    section: 'armor:persona',
    orderKey: 'personaOrder',
    defaultFile: 'persona.md',
    bundledFile: './personas/default.md',
    label: '人设',
    // 走人设库（active.json 指针 + _base 拼接 + 插值）；rules 段不走，保持逐字节旧行为
    compose: true,
  },
  {
    key: 'rules',
    section: 'armor:rules',
    orderKey: 'rulesOrder',
    defaultFile: 'rules.md',
    bundledFile: './personas/default-rules.md',
    label: '规则',
  },
  {
    // 追加层：官方段一个不动，只在 persona 之后插这一块。
    // 不给 compose：执行契约是单文件正文，没有 _base 那套拼接。
    key: 'executionMode',
    section: 'armor:execution-mode',
    orderKey: 'executionModeOrder',
    defaultFile: 'execution-mode.md',
    bundledFile: './personas/default-execution-mode.md',
    label: '执行契约',
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

// ── 人设库：多套人设 + 激活指针 ──────────────────────────────────────────
//  取值优先级：YAML 内联 → personaFile → 库（active.json 指向的目录）
//              → legacy（$DSH_HOME/armor/persona.md）→ 内置默认
//  段文本 = _base/hard-rules.md（仅库模式拼，平台无关的硬约束）+ 角色正文。
//  面板读写的是「角色正文」，_base 只读 —— 否则保存一次就把 base 抄进角色文件，越拼越长。
//  末尾不许是 '.' / '-'：Windows 会保留尾点（'beta.' 与 'beta' 并列存在，资源管理器里难处理），
//  保留设备名（con/nul…）也靠这条+"必须含字母数字"挡掉大半。最长 63。
const PERSONA_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/
const LEGACY_ID = 'legacy'

/** id 白名单。拼路径前必须过这道闸，否则 '..' 能写到 armor 目录外。 */
function isValidPersonaId(id) {
  return typeof id === 'string' && id !== LEGACY_ID && PERSONA_ID_RE.test(id)
}

/** 临时文件名带 pid + 随机串：桌面端与 web profile 若共享同一个 $DSH_HOME，固定 `.tmp` 会互相踩。 */
function tmpNameOf(file) {
  return `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
}

function personasDirOf(config) {
  return config.personaDir ? path.resolve(config.personaDir) : path.join(armorDir(), 'personas')
}
function activeFileOf(config) {
  return config.activeFile ? path.resolve(config.activeFile) : path.join(armorDir(), 'active.json')
}
function personaFileOf(config, id) {
  return path.join(personasDirOf(config), id, 'persona.md')
}

/** 读激活指针。任何异常都回落 legacy —— 宁可少做事，也不能因为一个坏 JSON 把人设整段清空。 */
function loadActive(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(activeFileOf(config), 'utf8'))
    return { schema: Number(raw.schema) || 1, persona: isValidPersonaId(raw.persona) ? raw.persona : LEGACY_ID }
  } catch {
    return { schema: 1, persona: LEGACY_ID }
  }
}

/** 与 saveState 同款：先写临时文件再改名，半截 JSON 不会出现。 */
function saveActive(config, next) {
  try {
    const file = activeFileOf(config)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const body = `${JSON.stringify({ schema: 1, persona: next.persona, updatedAt: new Date().toISOString() }, null, 2)}\n`
    const tmp = tmpNameOf(file)
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function readBaseFragment(config) {
  if (!config.baseFragment) return { text: '', file: '' }
  const name = config.baseFragment === 'default' ? '_base' : config.baseFragment
  // 配置里写 `..` 或绝对路径会读到库外的文件 —— 不是攻击面，是"打错字读到别的东西还不报错"
  if (typeof name !== 'string' || name.includes('..') || path.isAbsolute(name)) return { text: '', file: '' }
  const dir = path.join(personasDirOf(config), name)
  const file = path.join(dir, 'hard-rules.md')
  try {
    return { text: fs.readFileSync(file, 'utf8'), file }
  } catch {
    // 用户还没建 _base → 用内置兜底。缺了这一层，库模式会在「硬约束静默消失」的情况下运行，
    // 而这正是本插件历史上最贵的一类故障（功能没了却不报错）。
    try {
      return { text: fs.readFileSync(bundled('./personas/default-base.md'), 'utf8'), file: '内置默认 ./personas/default-base.md', builtin: true }
    } catch {
      return { text: '', file }
    }
  }
}

function readCatalog(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(personasDirOf(config), 'catalog.json'), 'utf8'))
    const list = Array.isArray(raw.personas) ? raw.personas : []
    return new Map(list.filter((row) => row && isValidPersonaId(row.id)).map((row) => [row.id, row]))
  } catch {
    return new Map()
  }
}

/** 列出库里的人设。只在 API 调用时跑 —— 不进 2 秒轮询，目录扫描不该按轮询频率发生。 */
function listPersonas(config) {
  const dir = personasDirOf(config)
  const catalog = readCatalog(config)
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && isValidPersonaId(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch { /* 目录还不存在：库是空的，不是错误 */ }
  return names.map((id) => {
    const file = personaFileOf(config, id)
    let bytes = 0
    let mtime = 0
    try { const stat = fs.statSync(file); bytes = stat.size; mtime = stat.mtimeMs } catch { /* 缺 person.md */ }
    const meta = catalog.get(id) ?? {}
    return {
      id,
      name: typeof meta.displayName === 'string' ? meta.displayName : id,
      tagline: typeof meta.tagline === 'string' ? meta.tagline : '',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      emoji: typeof meta.emoji === 'string' ? meta.emoji : '',
      accent: typeof meta.accent === 'string' ? meta.accent : '',
      bytes,
      mtime,
      valid: bytes > 0,
    }
  })
}

/** 解析人设段该读哪个文件 → { file, kind, id }。 */
function resolvePersonaTarget(config, active) {
  if (active.persona !== LEGACY_ID) {
    const file = personaFileOf(config, active.persona)
    if (fs.existsSync(file)) return { file, kind: 'library', id: active.persona }
  }
  return { file: path.join(armorDir(), 'persona.md'), kind: LEGACY_ID, id: LEGACY_ID }
}

function bundledPersona() {
  try {
    return { text: fs.readFileSync(bundled('./personas/default.md'), 'utf8'), src: '内置默认 ./personas/default.md' }
  } catch {
    return { text: '', src: '无内容' }
  }
}

/**
 * 读人设。ownText 与 text 分开存：
 *   ownText = 角色正文（面板编辑与保存的对象）
 *   text    = 真正注入模型的东西（库模式下 = _base + ownText）
 * legacy 模式不拼 _base，所以升级后默认输出与旧版逐字节相同。
 */
function readPersona(config, active) {
  const inline = typeof config.persona === 'string' && config.persona.trim()
  if (inline) {
    return { ownText: config.persona, text: config.persona, file: '', src: 'YAML 内联 config.persona', inline: true, kind: 'inline', id: '', requested: '', fallbackFrom: '', persisted: false, baseFile: '', baseBytes: 0 }
  }

  let target = config.personaFile
    ? { file: path.resolve(config.personaFile), kind: 'file', id: '' }
    : resolvePersonaTarget(config, active)

  // 指针要的是哪一份。它和实际生效的那份不一致时（目录被手删、被 personaFile 覆盖），
  // 必须一路带到面板上 —— 否则面板显示 "active: ghost" 而实际注入 legacy，等于说谎。
  const requested = active.persona !== LEGACY_ID ? active.persona : ''
  let fallbackFrom = ''

  let ownText = null
  try { ownText = fs.readFileSync(target.file, 'utf8') } catch { ownText = null }

  if (ownText === null) {
    const legacyFile = path.join(armorDir(), 'persona.md')
    try {
      ownText = fs.readFileSync(legacyFile, 'utf8')
      target = { file: legacyFile, kind: LEGACY_ID, id: LEGACY_ID }
      fallbackFrom = requested
    } catch {
      const fallback = bundledPersona()
      return { ownText: fallback.text, text: fallback.text, file: legacyFile, src: fallback.src, inline: false, kind: 'bundled', id: '', requested, fallbackFrom: requested, persisted: false, baseFile: '', baseBytes: 0 }
    }
  } else if (requested && target.kind !== 'library') {
    // 读到的是文件，但不是指针要的那份（personaFile 覆盖，或库目录里那份已消失）
    fallbackFrom = requested
  }

  // _base 是「角色正文的硬约束前缀」。正文为空时它就成了孤儿：
  // 既不是人设、也不受 personaOn 控制，白白往每轮请求里塞 ~321 token 的约束。
  // 所以只在正文非空时才拼 —— 空正文的语义应该是「这段不注入」，不是「只注入前缀」。
  const wantsBase = target.kind === 'library' && ownText.trim() !== ''
  const base = wantsBase ? readBaseFragment(config) : { text: '', file: '' }
  const text = base.text.trim() ? `${base.text.trimEnd()}\n\n${ownText.trimEnd()}\n` : ownText
  return {
    ownText,
    text,
    file: target.file,
    src: target.file,
    inline: false,
    kind: target.kind,
    id: target.id,
    requested,
    fallbackFrom,
    persisted: true,
    // 正文为空时如实报 0：面板据此显示「注入时前置 _base 0 字节」，不骗人
    baseFile: base.file,
    baseBytes: Buffer.byteLength(base.text, 'utf8'),
    baseSkipped: !wantsBase && target.kind === 'library',
  }
}

// ── 最小插值：只为「人设不用手写死路径」服务 ────────────────────────────
//  刻意不用宿主插值：宿主的 renderPrompt 是严格模式，未知引用、已注册但无值的引用都会抛错，
//  整轮请求直接失败；而人设是随手写的 markdown，出现 {{...}} 的概率不低。
//  这里未知引用一律原样保留，替换只做一轮、不递归。
function expandVars(text, context, config) {
  if (config.interpolateVars === false || !text) return text
  const agent = (context && context.agent) || null
  const cwd = (agent && agent.session && agent.session.header && agent.session.header.cwd) || process.cwd()
  const model = (agent && agent.options && agent.options.model) || ''
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const values = {
    cwd: String(cwd),
    model: String(model),
    home: armorDir(),
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  }
  return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match
  ))
}

/** 移入 armor\trash\（应用级回收站，可手动还原）。插件运行时不做真删除。 */
function moveToTrash(config, id) {
  const from = path.join(personasDirOf(config), id)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const to = path.join(armorDir(), 'trash', `${stamp}-${id}`)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
  return to
}

function createPersona(config, id, from) {
  const dir = path.join(personasDirOf(config), id)
  if (fs.existsSync(dir)) {
    const error = new Error(`已存在：${dir}`)
    error.code = 'EEXIST_PERSONA'
    throw error
  }
  // from 显式给了就必须真的存在：静默回退模板会让调用方以为"复制了某个角色"，
  // 拿到的却是一张空骨架 —— 这类"看起来成功了"的失败比报错贵得多。
  if (from !== undefined && from !== null && from !== '') {
    if (!isValidPersonaId(from)) {
      const error = new Error(`非法来源 id：${JSON.stringify(from)}`)
      error.code = 'EBAD_FROM'
      throw error
    }
    if (!fs.existsSync(personaFileOf(config, from))) {
      const error = new Error(`来源人设不存在：${from}`)
      error.code = 'ENOENT_FROM'
      throw error
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  const source = from
    ? personaFileOf(config, from)
    : path.join(personasDirOf(config), '_template', 'persona.md')
  // 回退链：用户库的 _template → 插件内置模板 → 硬编码最小骨架。
  // 少了中间这层，换个环境装插件就会退化成一段没有写作规范的裸骨架。
  let body
  let actualSource = source
  try {
    body = fs.readFileSync(source, 'utf8')
  } catch {
    try {
      body = fs.readFileSync(bundled('./personas/_template/persona.md'), 'utf8')
      actualSource = '内置 ./personas/_template/persona.md'
    } catch {
      body = `你是「${id}」，{一句话身份}。工作目录是 {{cwd}}。\n\n【身份】\n【人设】\n【口头禅】\n【行为模式】\n【反差萌】\n【思考模式】\n【表达技巧】\n【调节底线】\n【工作守则】\n`
      actualSource = '硬编码骨架'
    }
  }
  const meta = {
    schema: 1,
    id,
    displayName: id,
    note: '段顺序不在本文件：order 只由 cordis.patch.yml 的 personaOrder 决定。',
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(dir, 'persona.md'), body, 'utf8')
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return { dir, file: path.join(dir, 'persona.md'), source: actualSource }
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

function rewrite(assembly, rules, config, stats) {
  const drop = new Set(config.dropSections ?? [])
  const replace = config.replaceSections ?? {}
  let hits = 0
  // 分项命中：只用于面板诊断（哪一层真的改到了东西 / 哪一层在空转）
  const hitBy = { dropped: 0, replaced: 0, sections: 0, contexts: 0, tools: 0 }

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
      hitBy.dropped += 1
      continue
    }
    if (Object.prototype.hasOwnProperty.call(replace, section.name)) {
      hits += 1
      hitBy.replaced += 1
      sections.push({ ...section, text: replace[section.name], interpolate: false })
      continue
    }
    const got = applyRules(String(section.text ?? ''), rules, 'sections')
    hits += got.hits
    hitBy.sections += got.hits
    sections.push(got.text === section.text ? section : { ...section, text: got.text })
  }

  const contexts = config.stripContexts === false
    ? assembly.contexts
    : (assembly.contexts ?? []).map((entry) => {
        const got = applyRules(String(entry.text ?? ''), rules, 'contexts')
        hits += got.hits
        hitBy.contexts += got.hits
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
      hitBy.tools += got.hits
      return got.text === tool.description ? tool : { ...tool, description: got.text }
    })
  }

  if (stats) { stats.hits = hits; stats.by = hitBy }
  if (hits && config.verbose) console.log(`[armor-lite] rewrote ${hits} phrase(s)`)
  return { ...assembly, sections, contexts, tools }
}

// ── 四个开关：进程内即时生效 + 落盘持久化 ────────────────────────────────
//   armed     提示词增强总开关（人设/规则段 + 组装后改写）
//   personaOn 人设段独立开关：只掐 armor:persona，rules 段与提示词改写照跑
//   recover   拒答自动恢复
//   continue  空转续写（只在 reason.kind === 'max-tokens' 时补话）
// 旧版 state.json 只有 armed 一个键，缺的字段一律按「开」处理，向后兼容。
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    return {
      armed: raw.armed !== false,
      personaOn: raw.personaOn !== false,
      // 新增键：旧 state.json 没有它，缺省按「开」处理（与其余键一致）
      executionModeOn: raw.executionModeOn !== false,
      recover: raw.recover !== false,
      continue: raw.continue !== false,
    }
  } catch {
    return { armed: true, personaOn: true, executionModeOn: true, recover: true, continue: true }
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(armorDir(), { recursive: true })
    const body = `${JSON.stringify({
      armed: state.armed,
      personaOn: state.personaOn,
      executionModeOn: state.executionModeOn,
      recover: state.recover,
      continue: state.continue,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`
    // 先写临时文件再改名：半截 JSON 会让下次 loadState 整个回落「全开」，
    // 对提示词增强插件来说那等于悄悄把提示词增强打开 —— 代价比多一次 rename 大得多。
    const tmp = tmpNameOf(stateFile())
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
    // 一个坏正则不能让整个插件加载失败 —— 那等于提示词增强全线静默失效
    console.log(`[armor-lite] hardStopPatterns 配置有问题，回落内置硬停表：${String((error && error.message) || error)}`)
    return null
  }
}

// ── 侧栏面板的数据面：同源于宿主 webServer（与 dshmarket 同款接法）──────
//  active 是从 apply() 传进来的可变指针对象（属性会被 /activate 与轮询改写），
//  不能靠闭包捕获 —— mountApi 是模块级函数，拿不到 apply 里的局部变量。
function mountApi(hostCtx, state, slots, config, log, active, diag = {}) {
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
    // compose 段（人设）返回的是角色正文，不含 _base —— 面板存回去才不会把 base 抄进角色文件
    const body = slot.spec.compose ? slot.ownText : slot.text
    return {
      text: body,
      path: slot.watchFile,
      source: persisted ? slot.watchFile : slot.src,
      persisted,
      inline: slot.inline,
      bytes: Buffer.byteLength(body, 'utf8'),
      ...(slot.spec.compose
        ? {
            kind: slot.kind,
            id: slot.id,
            requested: slot.requested || '',
            // 非空 = 指针要的那份没生效，实际注入的是别的。面板必须把它说出来，否则显示与实际不符
            fallbackFrom: slot.fallbackFrom || '',
            effective: !slot.inline && !slot.fallbackFrom,
            composed: {
              baseFile: slot.baseFile,
              baseBytes: slot.baseBytes,
              totalBytes: Buffer.byteLength(slot.text, 'utf8'),
            },
          }
        : {}),
    }
  }

  /**
   * 把生效指针切到 id 并立即同步 slot（不等轮询）。
   * /activate 与 /save(activate:true) 共用 —— 写完盘再调它，会重新从文件读一遍，
   * 所以「写文件」和「改内存」不会各读一次旧内容。
   */
  const switchActive = (id) => {
    active.persona = id
    const persisted = saveActive(config, active)
    const got = readPersona(config, active)
    const slot = slotOf('persona')
    if (slot) {
      slot.ownText = got.ownText
      slot.text = got.text
      slot.watchFile = got.file
      slot.src = got.src
      slot.kind = got.kind
      slot.id = got.id
      slot.requested = got.requested
      slot.fallbackFrom = got.fallbackFrom
      slot.baseFile = got.baseFile
      slot.baseBytes = got.baseBytes
      // 内联时 readPersona 返回的就是内联值：指针变了但注入内容没变
      slot.inline = got.inline
    }
    return { persisted, got, slot }
  }

  const routes = [
    ['/dsh-armor/api/state', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      sendJson(res, 200, {
        armed: state.armed,
        personaOn: state.personaOn,
        executionModeOn: state.executionModeOn,
        recover: state.recover,
        continue: state.continue,
        // 追加模式诊断：改写层是否在跑、命中多少、最近一次组装的官方段清单
        layer: {
          mode: config.strip !== false || config.stripTools === true || config.stripContexts === true ? 'rewrite' : 'append',
          rewriteWired: config.strip !== false || config.stripTools === true || config.stripContexts === true
            || (Array.isArray(config.dropSections) && config.dropSections.length > 0)
            || Boolean(config.replaceSections && Object.keys(config.replaceSections).length > 0),
          lastRewrite: diag.lastRewrite ?? null,
          lastAssembly: diag.lastAssembly ?? null,
        },
        home: armorDir(),
        watchIntervalMs: config.watchIntervalMs,
        recoverMax: clampCount(config.refusalRecoverMax, 2, 5),
        continueMax: clampCount(config.autoContinueMax, 3, 20),
        // injecting：段里有内容 ≠ 段会被注入。面板要能说出这个差别，否则就是在骗自己
        persona: { ...describe(slotOf('persona')), injecting: state.armed && state.personaOn },
        rules: { ...describe(slotOf('rules')), injecting: state.armed },
        executionMode: { ...describe(slotOf('executionMode')), injecting: state.armed && state.executionModeOn },
        active: { persona: active.persona },
        personas: {
          dir: personasDirOf(config),
          activeFile: activeFileOf(config),
          available: listPersonas(config),
        },
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

      // 写哪一份：显式 id（库里那一份，或 legacy）→ 该段当前绑定的文件 → 内联时回落到常规路径。
      // 内联 persona 的 slot.watchFile 是空串，直接拼会得到 "<cwd>.<pid>...tmp" 再 rename 到 ""，
      // 那是本文件里唯一能写到 personasDir 之外的路径。
      const explicitId = typeof body.id === 'string' && body.id ? body.id : ''
      const isPersona = Boolean(slot.spec.compose)
      if (explicitId && !isPersona) return sendJson(res, 400, { error: `${body.which} 段不支持 id` })
      if (explicitId && explicitId !== LEGACY_ID && !isValidPersonaId(explicitId)) {
        return sendJson(res, 400, { error: `非法人设 id：${JSON.stringify(explicitId)}` })
      }
      // 显式 id 必须已存在：否则递归 mkdir 会凭空造出一个没有 meta.json 的"人设"目录。
      // legacy 例外 —— 那份文件允许被首次创建。
      if (explicitId && explicitId !== LEGACY_ID && !fs.existsSync(personaFileOf(config, explicitId))) {
        return sendJson(res, 404, { error: `人设不存在：${explicitId}` })
      }
      const file = explicitId === LEGACY_ID
        ? path.join(armorDir(), 'persona.md')
        : explicitId
          ? personaFileOf(config, explicitId)
          : (slot.watchFile || path.join(armorDir(), slot.spec.defaultFile))

      // activate:true = 面板「保存」的语义：写盘 + 把这份设为生效（一次做完）,
      // 中间不留"写完了但没生效"的状态。缺省保持旧行为：只有写的是当前生效那份才动内存。
      const wantsActivate = isPersona && body.activate === true && explicitId !== ''

      // 这次写入是否作用于「当前正在注入的那份」。写别的份时绝不能动内存 ——
      // 否则下一次请求会当场换成另一份人设（库→非库切换还会连带丢掉 _base 拼接）。
      const writesActive = explicitId
        ? explicitId === (slot.inline ? '' : (slot.id || LEGACY_ID))
        : !slot.inline
      const skipReason = explicitId
        ? `写的是库里的另一份（${explicitId}），当前注入的仍是 ${slot.inline ? 'YAML 内联值' : (slot.id || LEGACY_ID)}`
        : 'YAML 内联 config.persona 优先，保存文件不改变当前注入内容'

      // 空正文护栏：写的是「当前正在生效的那份」且正文全空白 → 拒绝。
      // 起因是一次真实事故：面板重启后编辑器还没回填，点保存把 116 字节的人设抹成 0 字节，
      // 而且这种损坏是静默的（注入没报错，只是人设没了）。清空应该是显式意图，
      // 所以要求带 confirmEmpty: true 才放行。
      // 防截断护栏：这是第二次踩同一个坑 —— 一次保存把 1554B 的规则写成 67B。
      // 判据：新内容比磁盘上的存量少 40% 以上，且调用方没说这是有意的 -> 拒绝。
      // 「有意的缩减」用 shrink:true 放行（比如真的在精简提示词）。
      let diskBytes = 0
      try { diskBytes = fs.statSync(file).size } catch { /* 文件不存在：首次创建，放行 */ }
      const newBytes = Buffer.byteLength(body.text, 'utf8')
      if (diskBytes > 200 && newBytes < diskBytes * 0.6 && body.shrink !== true) {
        return sendJson(res, 409, {
          error: `拒绝大幅缩减：磁盘上 ${diskBytes} 字节，这次要写 ${newBytes} 字节（少 ${Math.round((1 - newBytes / diskBytes) * 100)}%）。真有意图请带 shrink: true`,
          which: body.which,
          path: file,
          diskBytes,
          newBytes,
        })
      }

      const willWriteActive = wantsActivate || writesActive
      if (willWriteActive && !body.text.trim() && body.confirmEmpty !== true) {
        return sendJson(res, 409, {
          error: '拒绝把正在生效的这份写成空正文。确实要清空请带 confirmEmpty: true',
          which: body.which,
          path: file,
          hint: '清空后人设段会只剩 _base（或完全消失），这个操作不可从插件内撤销',
        })
      }

      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        // 原子写：人设是注入文本，半截文件会让模型读到被截断的指令
        const tmp = tmpNameOf(file)
        fs.writeFileSync(tmp, body.text, 'utf8')
        fs.renameSync(tmp, file)

        let effective = false
        let reason = ''
        if (wantsActivate) {
          const committed = switchActive(explicitId)
          effective = true
          reason = committed.persisted ? '' : 'active.json 没写下去（重启后会回到旧值）'
        } else if (writesActive) {
          // 立刻生效，不等下一次轮询；并让位给文件（内联值不再优先）
          slot.inline = false
          slot.src = file
          slot.watchFile = file
          if (isPersona) {
            slot.ownText = body.text
            // 只有库模式才拼 _base：legacy 下保存必须保持与旧版逐字节相同的输出
            const base = slot.kind === 'library' ? readBaseFragment(config) : { text: '', file: '' }
            slot.text = base.text.trim() ? `${base.text.trimEnd()}\n\n${body.text.trimEnd()}\n` : body.text
            slot.baseFile = base.file
            slot.baseBytes = Buffer.byteLength(base.text, 'utf8')
          } else {
            slot.text = body.text
          }
          effective = true
        } else {
          reason = skipReason
        }

        const bytes = Buffer.byteLength(body.text, 'utf8')
        log(`${slot.spec.section} saved <- ${file} (${bytes} bytes, effective=${effective}, activate=${wantsActivate})`)
        sendJson(res, 200, {
          ok: true,
          path: file,
          bytes,
          effective,
          ...(effective ? {} : { reason }),
          ...(wantsActivate ? { active: { persona: active.persona } } : {}),
        })
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    }],

    ['/dsh-armor/api/toggle', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const body = await readJson(req)
      if (!body || typeof body.enabled !== 'boolean') {
        return sendJson(res, 400, { error: '需要 { enabled: boolean, key?: "armed"|"personaOn"|"recover"|"continue" }' })
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
        personaOn: state.personaOn,
        executionModeOn: state.executionModeOn,
        recover: state.recover,
        continue: state.continue,
        persisted,
      })
    }],

    // ── 人设库 ──────────────────────────────────────────────────────────
    // 列表只在被调用时扫目录：目录扫描不进 2 秒轮询。
    ['/dsh-armor/api/personas', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      const base = readBaseFragment(config)
      const legacyFile = path.join(armorDir(), 'persona.md')
      sendJson(res, 200, {
        active: { persona: active.persona },
        dir: personasDirOf(config),
        activeFile: activeFileOf(config),
        base: { file: base.file, bytes: Buffer.byteLength(base.text, 'utf8') },
        legacy: { file: legacyFile, exists: fs.existsSync(legacyFile) },
        list: listPersonas(config),
      })
    }],

    // 切换人设：写指针 + 立即重读，不等下一次轮询
    ['/dsh-armor/api/activate', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const body = await readJson(req)
      const id = body && typeof body.persona === 'string' ? body.persona : ''
      if (id !== LEGACY_ID && !isValidPersonaId(id)) {
        return sendJson(res, 400, { error: `非法人设 id：${JSON.stringify(id)}` })
      }
      if (id !== LEGACY_ID && !fs.existsSync(personaFileOf(config, id))) {
        return sendJson(res, 404, { error: `人设不存在：${id}` })
      }
      const committed = switchActive(id)
      const slot = committed.slot
      const persisted = committed.persisted
      // 「生效」= 注入内容确实来自被切的那一份。内联覆盖 / 指针目标缺失时都不算生效
      const effective = slot
        ? (slot.inline
            ? false
            : (id === LEGACY_ID ? slot.kind === LEGACY_ID : (slot.kind === 'library' && slot.id === id)))
        : false
      const reason = effective
        ? ''
        : (slot && slot.inline
            ? 'YAML 内联 config.persona 优先，改指针不会改变注入内容'
            : (slot && slot.fallbackFrom ? `${slot.fallbackFrom} 读不到，实际注入的是 ${slot.kind}` : '未生效'))
      log(`active.persona -> ${id} (persisted=${persisted}, effective=${effective})`)
      sendJson(res, 200, { ok: true, active: { persona: id }, persisted, effective, persona: describe(slot), ...(effective ? {} : { reason }) })
    }],

    // 只读预览：拿某个 id 的角色正文，**不碰指针**。
    // 面板下拉的语义是「选中=预览，保存才生效」，所以需要一个不改任何状态的读接口。
    ['/dsh-armor/api/persona', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' })
      let id = ''
      try {
        id = new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams.get('id') ?? ''
      } catch { /* url 坏了就当没给 */ }
      if (id !== LEGACY_ID && !isValidPersonaId(id)) {
        return sendJson(res, 400, { error: `需要 ?id=<人设 id | legacy>（实得 ${JSON.stringify(id)}）` })
      }
      const file = id === LEGACY_ID ? path.join(armorDir(), 'persona.md') : personaFileOf(config, id)
      let text = null
      try { text = fs.readFileSync(file, 'utf8') } catch { text = null }
      if (text === null) return sendJson(res, 404, { error: `人设不存在：${id}` })
      const base = id === LEGACY_ID ? { text: '', file: '' } : readBaseFragment(config)
      const meta = readCatalog(config).get(id) ?? null
      const total = base.text.trim() ? `${base.text.trimEnd()}\n\n${text.trimEnd()}\n` : text
      sendJson(res, 200, {
        id,
        path: file,
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        kind: id === LEGACY_ID ? LEGACY_ID : 'library',
        meta: meta
          ? {
              name: typeof meta.displayName === 'string' ? meta.displayName : id,
              tagline: typeof meta.tagline === 'string' ? meta.tagline : '',
              emoji: typeof meta.emoji === 'string' ? meta.emoji : '',
              accent: typeof meta.accent === 'string' ? meta.accent : '',
              tags: Array.isArray(meta.tags) ? meta.tags : [],
            }
          : null,
        composed: {
          baseFile: base.file,
          baseBytes: Buffer.byteLength(base.text, 'utf8'),
          totalBytes: Buffer.byteLength(total, 'utf8'),
        },
      })
    }],

    ['/dsh-armor/api/persona/create', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const body = await readJson(req)
      if (!body || !isValidPersonaId(body.id)) {
        return sendJson(res, 400, { error: '需要 { id: 小写 ASCII 标识, from?: 已有 id }' })
      }
      try {
        const created = createPersona(config, body.id, body.from)
        log(`persona created <- ${created.file} (来源 ${created.source})`)
        sendJson(res, 200, { ok: true, ...created, list: listPersonas(config) })
      } catch (e) {
        const code = e && e.code
        if (code === 'EEXIST_PERSONA') return sendJson(res, 409, { error: String(e.message) })
        if (code === 'EBAD_FROM') return sendJson(res, 400, { error: String(e.message) })
        if (code === 'ENOENT_FROM') return sendJson(res, 404, { error: String(e.message) })
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
    }],

    // 移入 armor\trash\（应用级回收站）——插件运行时不做真删除
    ['/dsh-armor/api/persona/remove', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
      const body = await readJson(req)
      if (!body || !isValidPersonaId(body.id)) {
        return sendJson(res, 400, { error: '需要 { id: 小写 ASCII 标识 }' })
      }
      if (body.id === active.persona) {
        return sendJson(res, 409, { error: `${body.id} 正在使用中，先切到别的再移走` })
      }
      const from = path.join(personasDirOf(config), body.id)
      if (!fs.existsSync(from)) return sendJson(res, 404, { error: `人设不存在：${body.id}` })
      try {
        const trashed = moveToTrash(config, body.id)
        log(`persona trashed <- ${trashed}`)
        sendJson(res, 200, { ok: true, trashed, list: listPersonas(config) })
      } catch (e) {
        sendJson(res, 500, { error: String((e && e.message) || e) })
      }
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
  const active = loadActive(config)

  const slots = SECTION_SPECS.map((spec) => {
    if (spec.compose) {
      const got = readPersona(config, active)
      log(`${spec.section} <- ${got.src} (${got.text.length} chars, kind=${got.kind})`)
      return {
        spec,
        watchFile: got.file,
        inline: got.inline,
        ownText: got.ownText,
        text: got.text,
        src: got.src,
        kind: got.kind,
        id: got.id,
        requested: got.requested,
        fallbackFrom: got.fallbackFrom,
        baseFile: got.baseFile,
        baseBytes: got.baseBytes,
      }
    }
    const inline = typeof config[spec.key] === 'string' && config[spec.key].trim()
    const custom = config[`${spec.key}File`]
    const watchFile = custom ? path.resolve(custom) : path.join(armorDir(), spec.defaultFile)
    const got = loadText(spec, config)
    log(`${spec.section} <- ${got.src} (${got.text.length} chars)`)
    return { spec, watchFile, inline: Boolean(inline), text: got.text, src: got.src }
  })

  // 1) 人设段 + 本地规则段。order 都低于 HARNESS_IDENTITY(-1000)，永远排在第一方指导之前。
  //    text 是函数 → 每次组装重新求值；关掉提示词增强或文本为空时该段自动消失。
  for (const slot of slots) {
    ctx.systemPrompt.section({
      name: slot.spec.section,
      order: config[slot.spec.orderKey],
      interpolate: false,
      // 段文本收 context：compose 段（人设）用它做 {{cwd}}/{{model}} 替换。
      // 保持 interpolate:false 是刻意的 —— 宿主插值遇未知引用会抛错、整轮失败。
      // compose 段就是人设（SECTION_SPECS 里只有 persona 带 compose: true）。
      // personaOn 只掐人设段；rules 段仍由 armed 单独决定，两者互不牵连。
      // 三个独立闸：armed 总管；personaOn 只管人设；executionModeOn 只管执行契约。
      // rules 段只受 armed 管（它装的是本机工作约束，不该被人设开关牵动）。
      text: (context) => {
        if (!state.armed) return ''
        if (slot.spec.key === 'persona' && !state.personaOn) return ''
        if (slot.spec.key === 'executionMode' && !state.executionModeOn) return ''
        return slot.spec.compose ? expandVars(slot.text, context, config) : slot.text
      },
    })
  }

  // 2) 可选：掐掉全部动态 runtime 上下文
  if (config.suppressRuntimeContext) ctx.systemPrompt.suppressRuntimeContext()

  // 3) 组装后改写：global + prepend = 最外层监听器，拥有最后一句话权。
  //    提示词增强关掉时原样返回、什么都不动 = 原版行为。
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
  // v0.5.0：默认「只追加不改写」。改写层只在真的有诉求时才挂监听器 ——
  // 没诉求还挂一个原样返回的全局监听器，等于每次组装多一层空转，也会让
  // 「本次到底改没改」这件事在日志里无从分辨。
  const wantsRewrite = config.strip !== false
    || config.stripTools === true
    || config.stripContexts === true
    || (Array.isArray(config.dropSections) && config.dropSections.length > 0)
    || (config.replaceSections && Object.keys(config.replaceSections).length > 0)

  if (wantsRewrite) {
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const done = typeof next === 'function' ? await next() : assembly
      if (!state.armed) return done
      const stats = {}
      try {
        const out = rewrite(done, rules, config, stats)
        lastRewrite.hits = stats.hits ?? 0
        lastRewrite.by = stats.by ?? null
        lastRewrite.at = new Date().toISOString()
        return out
      } catch (error) {
        // 改写表里若塞了会抛的 replace 函数，不能连带掀掉这次组装（整个 turn 会变 error）
        console.log(`[armor-lite] 组装后改写失败，本次原样返回：${String((error && error.message) || error)}`)
        lastRewrite.error = String((error && error.message) || error)
        return done
      }
    }, { global: true, prepend: true })
  }

  // 只读探针：把「本次组装里官方段都还在不在」记下来给面板看。
  // 它不是改写，只是观察 —— 用来证明「只追加」真的没动官方文本。
  const lastAssembly = { at: '', sections: [], injected: {} }
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const done = typeof next === 'function' ? await next() : assembly
    try {
      lastAssembly.at = new Date().toISOString()
      lastAssembly.sections = (done.sections ?? []).map((s) => ({ name: s.name, bytes: Buffer.byteLength(String(s.text ?? ''), 'utf8') }))
      lastAssembly.injected = {
        persona: Boolean(state.armed && state.personaOn),
        rules: Boolean(state.armed),
        executionMode: Boolean(state.armed && state.executionModeOn),
      }
    } catch { /* 探针失败不影响组装 */ }
    return done
  }, { global: true, prepend: true })

  // 4) 热更新：轮询而非 fs.watch —— 覆盖「文件还不存在 → 被创建」的情况。
  //    内联与否在每个 tick 现判、不在启动时固定：面板保存会把 slot.inline 置 false，
  //    那一刻起它就该进轮询，否则「面板存过之后再手改文件」读不到。
  if (config.watch !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        // 先看激活指针：手改 active.json 也该在 2 秒内生效，不用等重启
        const nextActive = loadActive(config)
        if (nextActive.persona !== active.persona) {
          active.persona = nextActive.persona
          log(`active.persona -> ${active.persona}`)
        }
        for (const slot of slots) {
          if (slot.inline) continue
          if (slot.spec.compose) {
            // 人设段：指针 / _base / 角色文件任一变化都要重算（readPersona 每次把两个文件读一遍）
            const got = readPersona(config, active)
            // fallbackFrom 也要参与比较：指针目标被手删时 text 可能一字不变，但"生效来源"变了
            if (got.text !== slot.text || got.file !== slot.watchFile || got.kind !== slot.kind || got.fallbackFrom !== slot.fallbackFrom) {
              slot.ownText = got.ownText
              slot.text = got.text
              slot.watchFile = got.file
              slot.src = got.src
              slot.kind = got.kind
              slot.id = got.id
              slot.requested = got.requested
              slot.fallbackFrom = got.fallbackFrom
              slot.baseFile = got.baseFile
              slot.baseBytes = got.baseBytes
              log(`${slot.spec.section} reloaded <- ${got.src} (kind=${got.kind}${got.fallbackFrom ? `, fallbackFrom=${got.fallbackFrom}` : ''})`)
            }
            continue
          }
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
      () => mountApi(hostCtx, state, slots, config, log, active, { lastRewrite, lastAssembly }),
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

  log(`armed (armed=${state.armed}, personaOn=${state.personaOn}, executionModeOn=${state.executionModeOn}, recover=${state.recover}, continue=${state.continue}, sections=${slots.length}, layer=${wantsRewrite ? 'replace' : 'append'}, rules=${rules.length}, drop=${(config.dropSections ?? []).length})`)
}
