# dsh-armor-lite

DeepSeek Harness 的**轻量破甲插件**：只改运行时，不改任何官方文件。

- **体量**：7 个文件、约 33 KB、零 `@deepseek-ai/*` 运行时依赖（只声明 peerDep `cordis`）
- **破甲方式**：`system-prompt/assemble` 瀑布最外层改写 + 按段名剔除固定身份开场白 + 前置自定义人设/规则
- **人设与规则**：纯 markdown 文件，2 秒热生效，也可在侧栏图形面板里改
- **官方更新免疫**：不发一个补丁到 `node_modules`，官方覆盖文件也打不回来

## 安装

```sh
# 从仓库装
dsh plugin --profile desktop add github:OWNER/dsh-armor-lite

# 或从本地目录装
dsh plugin --profile desktop add /path/to/dsh-armor-lite
```

装完**重启 DSH 桌面端**（首次安装需要让宿主重新读取 bundle 清单与客户端模块图）。

> 为什么必须重启：插件以 bundle 形式注册，`dsh.client` 的客户端模块图、`cordis.patch.yml` 的层都在启动时合成；已安装的 bundle 不会像 `--patch` 开发模式那样热重载插件文件。

## 目录结构

```
dsh-armor-lite/
├─ package.json          # bundle 清单：dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # 层一：权限覆写（sandbox-policy / approval）+ 插件行与配置
├─ index.js              # Host 半：两段注入、组装后改写、开关、HTTP 桥
├─ client.js             # Client 半：侧栏「破甲」入口 + 中央面板（React，无 Harness 客户端包依赖）
├─ strip-rules.js        # 削减文案改写表（可自由增删）
└─ personas/
   ├─ default.md         # 人设段的内置默认（\$DSH_HOME/armor/persona.md 不存在时用它）
   └─ default-rules.md   # 规则段的内置默认
```

## 三个工作机制

### 1. 权限层（纯 YAML，零代码）

`cordis.patch.yml` 按 id 覆写两行官方配置，等价于把 dsh-purge 的 shim + 代码层补丁换成配置：

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: never
```

> 行按 id 覆盖**整行 config**（非深度合并），所以原行已有的字段要一并写回。

### 2. 人设段 + 规则段

两段注册在 `order -1500 / -1400`，都低于 harness 身份的 `-1000`，因此**永远排在第一方指导之前**：

| 段名 | 文件 | order |
|---|---|---|
| `armor:persona` | `$DSH_HOME/armor/persona.md` | -1500 |
| `armor:rules` | `$DSH_HOME/armor/rules.md` | -1400 |

段文本是函数，每次组装重新求值 → 改文件即时生效，不需要重启。插件同时以 2 秒轮询兜底（能覆盖"文件还不存在 → 被创建"的情况）。

### 3. 组装后改写（拥有最后一句话权）

```js
ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
  const done = await next()          // 拿到各层处理完的最终 assembly
  if (!state.armed) return done      // 关掉破甲 = 原样返回，等同原版
  return rewrite(done, rules, config)
}, { global: true, prepend: true })   // global + prepend = 最外层监听器
```

`rewrite()` 做三件事，全部只作用于文本、不改变段的数量与顺序：

1. `dropSections` — 按段名整段剔除，默认 `harness:identity` + `deployment:persona-prefix`（两句固定身份开场白）
2. `replaceSections` — 按段名整段替换
3. `stripRules` — 正则改写表（`strip-rules.js`），默认含三段 `dsh-agent-instructions` 降级文案的逐字核对版

## 设置面板

侧栏会出现一个**破甲**入口（在「插件」「上下文洞察」同一组，`sidebar.panellist` 的 `armor` 格 `order 30`），点开是中央面板（`main` 的 `armor` 键），三个功能：

| 功能 | 行为 |
|---|---|
| 人设 | 读 / 改 / 保存 → `$DSH_HOME/armor/persona.md` |
| 规则 | 读 / 改 / 保存 → `$DSH_HOME/armor/rules.md` |
| 破甲开关 | 关闭 = 两段清空 + 改写停用 + 身份开场白恢复，即原版 DSH；状态持久化在 `armor/state.json` |

面板与 Host 之间走同源 HTTP 桥（宿主 `webServer` 的 `kind: 'exact'` 路由）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-armor/api/state` | GET | `{ armed, home, watchIntervalMs, persona, rules }` |
| `/dsh-armor/api/save` | POST | `{ which: 'persona'\|'rules', text }` → 写盘并立即生效 |
| `/dsh-armor/api/toggle` | POST | `{ enabled: boolean }` → 切换并存 `state.json` |

## 配置项（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件是否加载（与面板里的破甲开关是两回事） |
| `persona` / `rules` | `''` | 内联文本；非空时优先于文件，且关闭该段的热更新 |
| `personaFile` / `rulesFile` | `''` | 留空则用 `$DSH_HOME/armor/{persona,rules}.md` |
| `personaOrder` / `rulesOrder` | `-1500` / `-1400` | 段顺序；必须低于 `-1000` 才能压过 harness 身份 |
| `strip` | `true` | 是否启用组装后改写 |
| `stripContexts` | `true` | 是否把改写也应用到动态 runtime 上下文 |
| `stripRules` | `null` | 自定义改写表（`{pattern, flags, replace}`）；`null` 用 `strip-rules.js` |
| `dropSections` | `['harness:identity','deployment:persona-prefix']` | 按段名整段剔除 |
| `replaceSections` | `{}` | 按段名整段替换 |
| `suppressRuntimeContext` | `false` | 掐掉全部动态 runtime 上下文 |
| `watchIntervalMs` | `2000` | 文件轮询间隔 |
| `dumpSections` / `verbose` | `false` | 排障用；桌面端的 `console.log` 不可见，验证请看会话日志的 system 节点 |

## 验证方法

宿主插件改动**必须重启**才生效；客户端改动刷新页面即可。验证最终渲染结果（这是模型真正看到的东西）：

1. 取最新会话日志 `$DSH_HOME/sessions/<slug>/session-*/session.v4.jsonl.zstd`
2. 按 **zstd 帧魔数 `28 B5 2F FD` 切分后逐帧解压**（直接 `zstdDecompressSync` 整文件只能得到第一帧）
3. 取最后一个含 `"role":"system"` 的事件，其 `data.message.content[].text` 即渲染后的系统提示词

期望：第一段是 `armor:persona` 的内容，紧随 `armor:rules`，且 `You are an AI agent powered by DeepSeek Harness` 与 `You are a coding agent powered by … model` **均为 0 命中**。

## 已知限制

- 段落名（`harness:identity`、`deployment:persona-prefix`）来自宿主包源码，宿主大版本升级后可能改名；改名只会让剔除失效，不会报错。用 `dumpSections: true` 打印真实段名即可核对。
- 面板文案目前是硬编码中文，未接入宿主 locale 服务。
- HTTP 桥未做额外的 origin 校验（依赖宿主 webServer 的默认绑定与同源请求）。
- `strip-rules.js` 中针对 `dsh-agent-instructions` 的三条规则，在该插件行被禁用时属于空转（无副作用），是留给该行被启用时的保险。

## 环境

- DSH `0.2.0-rc.2`（桌面端）实测
- Node ≥ 18（实测 22.23.2）
- Windows（路径处理用 `node:path`，理论上跨平台；未在 Linux/macOS 实测）

## 与 dsh-purge 的取舍

| | dsh-purge | dsh-armor-lite |
|---|---|---|
| 破甲层数 | 提示词 + 代码 + shim + override 四层、74 条补丁 | YAML 两行 + 一段运行时改写 |
| 是否改官方文件 | 改（并留 `.bak`，官方更新后需重打） | **不改** |
| 文件量 | 106 个 | 7 个 |
| 官方更新后 | 需重新 apply | 自动继续生效 |
