#!/usr/bin/env node
// dump-prompt — 打印「模型最后一次请求收到的系统提示词」全文（渲染后的真身）。
//
// 用法：
//   node tools/dump-prompt.mjs                # 最新会话日志的最后一个 system 节点
//   node tools/dump-prompt.mjs --list         # 列出最近的会话日志
//   node tools/dump-prompt.mjs --grep 关键词   # 只统计关键词命中数
//   node tools/dump-prompt.mjs > prompt.txt    # 落盘细看
//
// 为什么要这么绕：会话日志是 *.jsonl.zstd，且是**多帧**流 —— Node 的
// zstdDecompressSync 一次只能解出第一帧，必须先按帧魔数 28 B5 2F FD 切分再逐帧解压。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function home() {
  return process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
}

function collectLogs(root) {
  const out = []
  const sess = path.join(root, 'sessions')
  if (!fs.existsSync(sess)) return out
  for (const slug of fs.readdirSync(sess)) {
    const slugDir = path.join(sess, slug)
    if (!fs.statSync(slugDir).isDirectory()) continue
    for (const entry of fs.readdirSync(slugDir)) {
      const entryPath = path.join(slugDir, entry)
      if (!fs.statSync(entryPath).isDirectory()) continue
      for (const file of fs.readdirSync(entryPath)) {
        if (!file.endsWith('.zstd')) continue
        const full = path.join(entryPath, file)
        out.push({ full, slug, session: entry, mtime: fs.statSync(full).mtimeMs })
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 按 zstd 帧魔数切分后逐帧解压，拼回完整 JSONL 文本。 */
function decodeZstd(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) offsets.push(i)
  }
  let text = ''
  let ok = 0
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')
      ok += 1
    } catch { /* 魔数误命中或帧被截断 */ }
  }
  return { text, frames: offsets.length, ok }
}

function lastSystemNode(text) {
  const lines = text.split('\n')
  let found = null
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('"role":"system"')) continue
    try {
      const ev = JSON.parse(lines[i])
      const body = (ev?.data?.message?.content ?? []).map((c) => c.text || '').join('\n')
      if (body) found = { line: i, seq: ev.seq, turn: ev?.data?.turn, step: ev?.data?.step, body }
    } catch { /* 非 JSON 行 */ }
  }
  return found
}

const argv = process.argv.slice(2)
const root = home()
const logs = collectLogs(root)

if (argv.includes('--list')) {
  console.log(`DSH_HOME = ${root}`)
  for (const l of logs.slice(0, 12)) {
    console.log(`  ${new Date(l.mtime).toLocaleString()}  ${l.slug} / ${l.session}`)
  }
  process.exit(0)
}

if (!logs.length) {
  console.error(`没有在 ${path.join(root, 'sessions')} 下找到会话日志`)
  process.exit(1)
}

const target = logs[0]
const { text, frames, ok } = decodeZstd(target.full)
const node = lastSystemNode(text)

if (!node) {
  console.error(`最新会话 ${target.session} 里没有可解析的 system 节点`)
  process.exit(1)
}

console.error(`[dump-prompt] ${target.slug} / ${target.session}`)
console.error(`[dump-prompt] zstd 帧 ${frames} 个 / 解开 ${ok} 个 · system 节点 L${node.line} · seq=${node.seq} turn=${node.turn} step=${node.step} · ${node.body.length} 字符`)

const grepIndex = argv.indexOf('--grep')
if (grepIndex >= 0) {
  const needle = argv[grepIndex + 1] ?? ''
  const count = needle ? node.body.split(needle).length - 1 : 0
  console.error(`[dump-prompt] "${needle}" 命中 ${count} 次`)
  process.exit(0)
}

console.error('[dump-prompt] --- 以下为渲染后的系统提示词全文 ---')
process.stdout.write(node.body.endsWith('\n') ? node.body : `${node.body}\n`)
