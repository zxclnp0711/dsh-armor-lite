#!/usr/bin/env node
// publish — 把本地改动提交并推送到 origin。只调用 git，不读取、不传递任何令牌。
//
// 用法：
//   node tools/publish.mjs --status                       # 看当前状态与 origin
//   node tools/publish.mjs "描述这次改动"                   # add -A + commit + push
//   node tools/publish.mjs --remote git@github.com:me/repo.git "首次提交"   # 顺带设 origin
//   node tools/publish.mjs --branch main "..."            # 指定分支（默认取当前 HEAD）
//
// 为什么不用 child_process 捕获输出：DSH 的受限模式下管道的 stdio 会 EPERM，
// 所以这里一律 stdio:'inherit'，需要读取的东西（origin、分支）直接从 .git 里读文件。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(name)
const message = argv.filter((a, i) => {
  const prev = argv[i - 1]
  return !a.startsWith('--') && prev !== '--remote' && prev !== '--branch'
}).join(' ').trim()

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

if (!fs.existsSync(path.join(repo, '.git'))) {
  console.error(`[publish] ${repo} 不是 git 仓库`)
  process.exit(1)
}

const branch = flag('--branch') || readBranch() || 'main'

if (has('--status')) {
  console.log(`[publish] repo   = ${repo}`)
  console.log(`[publish] branch = ${branch}`)
  console.log(`[publish] origin = ${readOrigin() ?? '(未设置，用 --remote <url> 设置)'}`)
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

console.log('[publish] 完成')
