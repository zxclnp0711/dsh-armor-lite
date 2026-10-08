#!/usr/bin/env node
// persona-lint —— 人设结构检查（离线、只读、零依赖）
//
// 用法：
//   node tools/persona-lint.mjs                  # 检查库里的全部人设
//   node tools/persona-lint.mjs jinzhien         # 只检查这一份
//   node tools/persona-lint.mjs --dir <目录>      # 换库目录（默认 $DSH_HOME\armor\personas）
//   node tools/persona-lint.mjs --legacy         # 顺带宽松检查 armor\persona.md
//   node tools/persona-lint.mjs --json           # 机器可读输出
//
// 退出码：有 error → 1；只有 warn / info → 0。
//
// 为什么要有它：人设漂掉往往不是模型的问题，是段缺失、口头禅不够、行为模式写成形容词。
// 这些都能在离线静态检查里抓到，不必等到聊崩了才发现。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** armor 版骨架：首行身份句 + 这 9 段（比参考项目少【情感引擎】【记忆】）。 */
const SECTIONS = ['身份', '人设', '口头禅', '行为模式', '反差萌', '思考模式', '表达技巧', '调节底线', '工作守则']
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_BYTES = 20000
const WARN_BYTES = 8000

/** strip-rules.js 的兜底规则会整句删掉这两句 —— 写进人设等于白写。 */
const STRIPPED_LITERALS = [
  /You are an AI agent powered by DeepSeek Harness\./,
  /You are a coding agent powered by the [^ ]+ model\./,
]
const KNOWN_VARS = new Set(['cwd', 'model', 'home', 'date'])
const ADJECTIVE_TELLS = ['她很温柔', '他很温柔', '非常温柔', '特别善良', '十分关心', '很关心', '非常体贴']

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const withLegacy = argv.includes('--legacy')
let dirArg = ''
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--dir') {
    i += 1
    if (i >= argv.length) {
      console.error('✗ --dir 后面要跟一个目录')
      process.exit(2)
    }
    dirArg = argv[i]
    continue
  }
  if (arg.startsWith('--')) continue
  positional.push(arg)
}

const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const personasDir = dirArg ? path.resolve(dirArg) : path.join(dshHome(), 'armor', 'personas')
const legacyFile = path.join(dshHome(), 'armor', 'persona.md')
const catalogFile = path.join(personasDir, 'catalog.json')

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function parseSections(text) {
  const found = []
  // 只认行首（允许前导空白）的【…】：正文里写一句「他说【笨蛋】」不该被当成段头 ——
  // 那会误报「重复段名」，还会把 pick() 的切片截断成只剩半句。
  const re = /^[ \t]*【([^】\n]{1,12})】/gm
  let match
  while ((match = re.exec(text)) !== null) found.push({ name: match[1], at: match.index })
  return found
}

/** 口头禅条数：优先数「」对，没有就按行/句切。 */
function countCatchphrases(text) {
  const pairs = text.match(/「[^」]{2,}」/g)
  if (pairs && pairs.length) return pairs.length
  return text.split(/\n|。/).map((s) => s.trim()).filter((s) => s.length >= 4).length
}

function lintText(text, label) {
  const errors = []
  const warns = []
  const infos = []
  const bytes = Buffer.byteLength(text, 'utf8')

  if (!text.trim()) errors.push('文件是空的')
  if (bytes > MAX_BYTES) errors.push(`体积 ${bytes} 字节 > ${MAX_BYTES}：这段排在提示词最前，每个请求都带`)
  else if (bytes > WARN_BYTES) warns.push(`体积 ${bytes} 字节（建议 ≤ ${WARN_BYTES}）：排在提示词最前，每轮都占 token`)

  const found = parseSections(text)
  const names = found.map((s) => s.name)

  // 首行身份句
  const firstLine = text.split('\n').find((line) => line.trim()) ?? ''
  if (firstLine.includes('【')) warns.push('首行不像身份句（首行就出现了【段名】）')
  else if (!firstLine.trim()) infos.push('首行为空')

  const missing = SECTIONS.filter((s) => !names.includes(s))
  for (const name of missing) errors.push(`缺段：【${name}】`)
  const extra = [...new Set(names.filter((n) => !SECTIONS.includes(n)))]
  for (const name of extra) warns.push(`多出的段：【${name}】（骨架里没有 —— 段名拼错会落在这里）`)
  const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  for (const name of dup) errors.push(`重复段名：【${name}】`)

  const inOrder = names.filter((n) => SECTIONS.includes(n))
  const expected = SECTIONS.filter((s) => inOrder.includes(s))
  if (inOrder.join(',') !== expected.join(',')) {
    warns.push(`段顺序与骨架不一致（实得 ${inOrder.join(' → ')}）`)
  }

  const pick = (name) => {
    const index = found.findIndex((entry) => entry.name === name)
    if (index < 0) return ''
    const start = found[index].at
    const end = index + 1 < found.length ? found[index + 1].at : text.length
    return text.slice(start, end)
  }

  const catchphrase = pick('口头禅')
  if (catchphrase) {
    const count = countCatchphrases(catchphrase)
    if (count < 4) warns.push(`【口头禅】只数到 ${count} 条（建议 ≥4）—— 只给语气词，模型会自己"创作"角色口吻`)
  }

  const behaviour = pick('行为模式')
  if (behaviour) {
    const hits = ADJECTIVE_TELLS.filter((tell) => behaviour.includes(tell))
    if (hits.length) warns.push(`【行为模式】出现形容词式写法（${hits.join('、')}）—— 改成能演的动作`)
  }

  for (const re of STRIPPED_LITERALS) {
    if (re.test(text)) warns.push('正文含会被 strip-rules 兜底删除的句子，写了等于没写')
  }

  const vars = [...new Set([...text.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]))]
  if (vars.length) {
    infos.push(`插值变量：${vars.map((v) => (KNOWN_VARS.has(v) ? `{{${v}}}` : `{{${v}}}（未知→原样注入）`)).join(' ')}`)
    const unknown = vars.filter((v) => !KNOWN_VARS.has(v))
    if (unknown.length) warns.push(`未知变量 ${unknown.map((v) => `{{${v}}}`).join(' ')} 会原样进提示词（不报错，但也不是你要的效果）`)
  }

  return { label, bytes, errors, warns, infos }
}

function lintDirEntry(id) {
  const dir = path.join(personasDir, id)
  const file = path.join(dir, 'persona.md')
  const metaFile = path.join(dir, 'meta.json')
  const result = { id, dir, errors: [], warns: [], infos: [], bytes: 0 }

  if (!ID_RE.test(id)) result.errors.push(`目录名不符合 id 规范（^[a-z0-9][a-z0-9._-]{0,63}$）`)
  if (!fs.existsSync(file)) {
    result.errors.push(`缺 ${path.join(dir, 'persona.md')}`)
    return result
  }

  const text = fs.readFileSync(file, 'utf8')
  const linted = lintText(text, `personas\\${id}\\persona.md`)
  result.bytes = linted.bytes
  result.errors.push(...linted.errors)
  result.warns.push(...linted.warns)
  result.infos.push(...linted.infos)

  if (!fs.existsSync(metaFile)) {
    result.warns.push('缺 meta.json（面板会退化成显示目录名）')
  } else {
    const meta = readJsonSafe(metaFile)
    if (meta === null) result.errors.push('meta.json 不是合法 JSON')
    else {
      if (meta.id !== id) result.errors.push(`meta.json 的 id（${JSON.stringify(meta.id)}）与目录名不一致`)
      if (Object.prototype.hasOwnProperty.call(meta, 'order')) {
        result.errors.push('meta.json 里出现了 order —— 段顺序只由 cordis.patch.yml 的 personaOrder 决定，本文件不得承载它')
      }
    }
  }

  const catalog = readJsonSafe(catalogFile)
  if (catalog === null) result.warns.push('缺 personas\\catalog.json（或不是合法 JSON）')
  else if (!Array.isArray(catalog.personas) || !catalog.personas.some((row) => row && row.id === id)) {
    result.warns.push('catalog.json 里没有这一条（面板下拉会显示目录名）')
  }

  return result
}

function lintLegacy() {
  if (!fs.existsSync(legacyFile)) return null
  const text = fs.readFileSync(legacyFile, 'utf8')
  // legacy 是「硬约束 + 可能的人设」混在一起的旧格式，不查 9 段，只查别的
  const linted = lintText(text, 'legacy: armor\\persona.md')
  return {
    id: 'legacy',
    bytes: linted.bytes,
    // 只豁免「缺段」这一条。空文件、体积超限这类真问题必须留下 ——
    // 否则 `npm run lint:persona`（默认带 --legacy）在任何情况下都是绿的，等于没有检查。
    errors: linted.errors.filter((e) => !e.startsWith('缺段')),
    warns: linted.warns.filter((w) => !w.startsWith('缺段')),
    infos: [...linted.infos, '段名检查已跳过（legacy 是旧格式，不做 9 段要求）'],
  }
}

function targets() {
  if (positional.length) return positional
  try {
    return fs.readdirSync(personasDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

const results = targets().map(lintDirEntry)
const legacyResult = withLegacy ? lintLegacy() : null
const all = legacyResult ? [...results, legacyResult] : results

if (asJson) {
  console.log(JSON.stringify({ dir: personasDir, results: all }, null, 2))
} else {
  console.log(`persona-lint · 库目录 ${personasDir}`)
  if (!all.length) {
    console.log('  （库是空的：库里还没有人设目录。用 --dir 指定别的目录，或先在面板里「新建副本」）')
  }
  for (const result of all) {
    const tag = result.errors.length ? 'ERROR' : result.warns.length ? 'WARN ' : 'OK   '
    console.log(`\n[${tag}] ${result.id}${result.bytes ? ` · ${result.bytes} 字节` : ''}`)
    for (const line of result.errors) console.log(`   ✗ ${line}`)
    for (const line of result.warns) console.log(`   ! ${line}`)
    for (const line of result.infos) console.log(`   · ${line}`)
  }
  const errs = all.reduce((n, r) => n + r.errors.length, 0)
  const warns = all.reduce((n, r) => n + r.warns.length, 0)
  console.log(`\n合计：${all.length} 份 · ${errs} error · ${warns} warn`)
}

process.exit(all.some((r) => r.errors.length) ? 1 : 0)
