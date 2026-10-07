#!/usr/bin/env node
// publish — 提交、推送，可选创建 GitHub Release。
//
// 用法：
//   node tools/publish.mjs --status                        # 看状态（含 origin / 分支 / token 是否就位）
//   node tools/publish.mjs "描述这次改动"                    # add -A + commit + push
//   node tools/publish.mjs --release "描述这次改动"           # 上面那套 + 建 Release
//   node tools/publish.mjs --release --draft "..."          # 建草稿（不公开）
//   node tools/publish.mjs --release --prerelease "..."     # 标记预发布
//   node tools/publish.mjs --release --tag v0.3.1 "..."     # 指定 tag（默认 v<package.json version>）
//   node tools/publish.mjs --release --notes 路径.md "..."   # 指定说明文件（默认 release-notes.md）
//   node tools/publish.mjs --release --direct "..."         # 不走代理（默认经 127.0.0.1:7890）
//   node tools/publish.mjs --remote git@github.com:me/repo.git "首次提交"
//   node tools/publish.mjs --branch main "..."
//
// 凭证：只从环境变量 GITHUB_TOKEN / GH_TOKEN 读。不打印值、不写文件、不进命令行参数。
// 没有 token 时 --release 会明确报错，但 commit / push 照常完成。
// 需要的权限：fine-grained → Contents: Read and write；classic → 勾 repo。
//
// 两点实现说明，别改回去：
//  1. git 一律 stdio:'inherit' —— DSH 受限模式下管道的 stdio 会 EPERM，
//     需要读取的东西（origin、分支）直接从 .git 里读文件。
//  2. GitHub API 用 node:http 的 CONNECT 隧道手写，不用内置 fetch：fetch 不认
//     HTTPS_PROXY，而这里要过本地代理；手写也顺带避免了把 token 塞进 curl 的 argv。

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

/**
 * 取 token：先看进程环境，再（Windows）查用户级注册表。
 *
 * 为什么必须有第二条：`setx` 只写注册表，而新进程是从**父进程**继承环境的，
 * Explorer 的环境块又经常不刷新 —— 于是从托盘/开始菜单启动的 DSH 继承不到，
 * 表现为「明明 setx 成功了却读不到」。这一步就是给这个经典坑兜底。
 * 值只在内存里流转：不打印、不落盘、不进 argv。
 *
 * @returns {{ value: string, from: string | null }}
 */
function readToken() {
  if (process.env.GITHUB_TOKEN) return { value: process.env.GITHUB_TOKEN, from: 'env:GITHUB_TOKEN' }
  if (process.env.GH_TOKEN) return { value: process.env.GH_TOKEN, from: 'env:GH_TOKEN' }
  if (process.platform !== 'win32') return { value: '', from: null }
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    try {
      const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' })
      if (r.status !== 0 || !r.stdout) continue
      const m = new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$`, 'm').exec(r.stdout)
      const v = m && m[1] ? m[1].trim() : ''
      if (v) return { value: v, from: `注册表 HKCU\\Environment\\${name}` }
    } catch { /* reg 不可用就当没有 */ }
  }
  return { value: '', from: null }
}

const TOKEN_INFO = readToken()
const TOKEN = TOKEN_INFO.value

const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(name)

/** 带值的开关：这些后面的词不算进提交信息。 */
const VALUE_FLAGS = new Set(['--remote', '--branch', '--tag', '--notes'])
const message = argv
  .filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]))
  .join(' ')
  .trim()

function git(args) {
  const r = spawnSync('git', ['-C', repo, ...args], { stdio: 'inherit' })
  return r.status ?? 1
}

function readOrigin() {
  try {
    const cfg = fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8')
    const m = /\[remote "origin"\][^\[]*?url\s*=\s*(.+)/.exec(cfg)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

function readBranch() {
  try {
    const head = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function hasCommits() {
  return fs.existsSync(path.join(repo, '.git', 'refs', 'heads', readBranch() ?? 'main'))
}

function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** origin URL → owner/repo。同时认 git@github.com:o/r.git 和 https://github.com/o/r.git。 */
function readSlug() {
  const url = readOrigin()
  if (!url) return null
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

function readNotes() {
  const file = flag('--notes') || 'release-notes.md'
  const fp = path.resolve(repo, file)
  if (fs.existsSync(fp)) {
    console.log(`[publish] release notes <- ${fp}`)
    return fs.readFileSync(fp, 'utf8').trim()
  }
  console.log(`[publish] 没有 ${file}，退回用 git log 生成说明`)
  const r = spawnSync('git', ['-C', repo, 'log', '--no-merges', '--oneline', '-20'], { encoding: 'utf8' })
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    return `### Changes\n\n${r.stdout.trim().split('\n').map((l) => `- ${l}`).join('\n')}`
  }
  return ''
}

/**
 * 一次 GitHub API 调用。proxy 为 null 时直连。
 * @returns {Promise<{status:number, text:string}>}
 */
function githubRequest(method, apiPath, body, proxy) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const headers = {
    'user-agent': 'dsh-armor-lite-publish',
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${TOKEN}`,
  }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.length)
  }
  const target = { hostname: 'api.github.com', port: 443, path: apiPath, method, headers }

  const send = (socket) => {
    const opts = { ...target, agent: false }
    if (socket) opts.createConnection = () => socket
    const req = https.request(opts, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, text: data }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  }

  let resolve
  let reject
  const done = new Promise((res, rej) => { resolve = res; reject = rej })

  if (!proxy) {
    send(undefined)
    return done
  }

  let p
  try {
    p = new URL(proxy)
  } catch {
    reject(new Error(`HTTPS_PROXY 不是合法 URL：${proxy}`))
    return done
  }
  const connectReq = http.request({
    hostname: p.hostname,
    port: p.port || 80,
    method: 'CONNECT',
    path: 'api.github.com:443',
    headers: { host: 'api.github.com:443' },
  })
  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy()
      reject(new Error(`代理 CONNECT 被拒：HTTP ${res.statusCode}`))
      return
    }
    send(socket)
  })
  connectReq.on('error', reject)
  connectReq.end()
  return done
}

// ── 主流程 ────────────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(repo, '.git'))) {
  console.error(`[publish] ${repo} 不是 git 仓库`)
  process.exit(1)
}

const branch = flag('--branch') || readBranch() || 'main'

if (has('--status')) {
  console.log(`[publish] repo   = ${repo}`)
  console.log(`[publish] branch = ${branch}`)
  console.log(`[publish] origin = ${readOrigin() ?? '(未设置，用 --remote <url> 设置)'}`)
  console.log(`[publish] slug   = ${readSlug() ?? '(还不是 GitHub 地址)'}`)
  console.log(`[publish] token  = ${TOKEN ? `已设置（来源：${TOKEN_INFO.from}）` : '(未设置，--release 用不了)'}`)
  console.log(`[publish] 本地 tag = ${(() => {
    const r = spawnSync('git', ['-C', repo, 'tag', '-l'], { encoding: 'utf8' })
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split('\n').join(', ') : '(无)'
  })()}`)
  console.log('[publish] --- git status --short ---')
  git(['status', '--short'])
  process.exit(0)
}

const remote = flag('--remote')
if (remote) {
  if (readOrigin()) {
    console.log(`[publish] 已有 origin：${readOrigin()}（改用 git remote set-url 才能换）`)
  } else {
    console.log(`[publish] 添加 origin -> ${remote}`)
    if (git(['remote', 'add', 'origin', remote]) !== 0) process.exit(1)
  }
}

if (!readOrigin()) {
  console.error('[publish] 没有 origin。先跑：node tools/publish.mjs --remote git@github.com:<你>/<仓库>.git "首次提交"')
  process.exit(1)
}

if (!message) {
  console.error('[publish] 缺少提交信息。用法：node tools/publish.mjs "这次改了什么"')
  process.exit(1)
}

console.log('[publish] add -A')
if (git(['add', '-A']) !== 0) process.exit(1)

const dirty = spawnSync('git', ['-C', repo, 'diff', '--cached', '--quiet'], { stdio: 'ignore' }).status
if (dirty === 0) {
  console.log('[publish] 暂存区没有改动，跳过 commit')
} else {
  console.log(`[publish] commit -m ${JSON.stringify(message)}`)
  if (git(['commit', '-m', message]) !== 0) process.exit(1)
}

if (!hasCommits()) {
  console.error('[publish] 仍然没有任何提交，终止')
  process.exit(1)
}

if (!has('--no-push')) {
  console.log(`[publish] push -u origin ${branch}`)
  if (git(['push', '-u', 'origin', branch]) !== 0) process.exit(1)
}

// ── 可选：建 Release ──────────────────────────────────────────────────────
if (has('--release')) {
  const slug = readSlug()
  if (!slug) {
    console.error(`[publish] 从 origin 解析不出 owner/repo：${readOrigin()}`)
    process.exit(1)
  }

  const pkg = readPkg()
  const tag = flag('--tag') || (pkg.version ? `v${pkg.version}` : null)
  if (!tag) {
    console.error('[publish] 没有 tag：package.json 里没有 version，用 --tag 指定')
    process.exit(1)
  }

  if (!TOKEN) {
    console.error('[publish] --release 需要凭证，但 GITHUB_TOKEN / GH_TOKEN 都没设置。')
    console.error('          在你自己的终端里跑：setx GITHUB_TOKEN "..."')
    console.error('          然后重启 DSH（子进程只在创建时继承环境变量）。')
    console.error('          权限：fine-grained → Contents: Read and write；classic → 勾 repo。')
    process.exit(1)
  }

  const proxy = has('--direct')
    ? null
    : (process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7890')

  const tagExists = spawnSync('git', ['-C', repo, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdio: 'ignore' }).status === 0
  if (!tagExists) {
    console.log(`[publish] tag ${tag} 不存在，本地创建`)
    if (git(['tag', '-a', tag, '-m', tag]) !== 0) process.exit(1)
  }
  console.log(`[publish] push tag ${tag}`)
  if (git(['push', 'origin', tag]) !== 0) process.exit(1)

  const notes = readNotes()
  const name = flag('--title') || tag
  console.log(`[publish] POST /repos/${slug}/releases${proxy ? `（经 ${proxy}）` : '（直连）'}`)

  let res
  try {
    res = await githubRequest('POST', `/repos/${slug}/releases`, {
      tag_name: tag,
      name,
      body: notes,
      draft: has('--draft'),
      prerelease: has('--prerelease'),
    }, proxy)
  } catch (error) {
    console.error(`[publish] 请求失败：${String((error && error.message) || error)}`)
    process.exit(1)
  }

  if (res.status === 201) {
    let url = '(响应里没有 html_url)'
    try { url = JSON.parse(res.text).html_url ?? url } catch { /* 保持兜底 */ }
    console.log(`[publish] Release 已建：${url}`)
  } else if (res.status === 422 && /already_exists/.test(res.text)) {
    console.log('[publish] 这个 tag 已经有 Release 了（422 already_exists），跳过')
  } else {
    console.error(`[publish] 建 Release 失败：HTTP ${res.status}`)
    console.error(res.text.slice(0, 600))
    process.exit(1)
  }
}

console.log('[publish] 完成')
