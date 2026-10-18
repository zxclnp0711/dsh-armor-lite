# dsh-armor-lite

DeepSeek Harness 的**轻量提示词增强插件**：只改运行时，不改任何官方文件。

- **体量**：10 个源文件 + 一套人设库、零 `@deepseek-ai/*` 运行时依赖（只声明 peerDep `cordis`）
- **注入方式（v0.5.0 起）**：**只追加，不改写**。官方段一个字不动，提示词增强正文由 `armor:execution-mode` 段插入
- **三段可编辑**：人设 / 规则 / 执行契约，各自一个 markdown 文件，2 秒热生效，也能在侧栏面板里改
- **人设库**：多套人设并存，下拉即切；硬约束片段自动前置；`{{cwd}}` 等最小插值（未知引用原样保留，不报错）
- **拒答恢复**：一轮正常收尾但内容是拒答时自动补话顶回去；被 max-tokens 截断时自动续写（事件层，可关）
- **官方更新免疫**：不发一个补丁到 `node_modules`，官方覆盖文件也打不回来

## v0.5.0 为什么改成「只追加」

旧版是**改写式**：删掉官方的 `harness:identity` 与 `deployment:persona-prefix`，再用一张正则表把官方措辞改写成目标语义。

这条路有两个结构性代价：

1. **官方一改文案就静默空转**。正则不命中 → 什么都不发生 → 你无从知道提示词增强已经哑火。
2. **正则跨行会吞段**。`[^.]*\.` 在 JS 里匹配换行，锚点后久无句号会把整段（含代码块）吞掉再替换。

改成追加式之后：

| | 改写式（≤0.4.5） | 追加式（0.5.0+） |
|---|---|---|
| 官方身份句 | 删掉 | **逐字保留** |
| 官方 persona | 删掉，换成人设库 | **逐字保留**，人设库另起一段 |
| 官方规则措辞 | 正则改写 | **逐字保留**，执行契约另起一段 |
| 失效表现 | 静默空转 | 段还在就还在，段没了面板会报「官方段缺失」 |
| 失效检测 | 靠猜 | 面板显示最近一次组装的段清单 + 改写命中数 |

改写层没被删掉，只是**降级为可选开关**（`strip` / `stripContexts` / `stripTools` / `dropSections` / `replaceSections`），默认全关。
真想回到改写式，在 `cordis.patch.yml` 里打开即可，面板的「层模式」会显示当前是哪一派。

## 安装

```sh
# 从仓库装（私有仓：本机需先有可用的 SSH key 并已加到 GitHub）
dsh plugin --profile desktop add github:zxclnp0711/dsh-armor-lite

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
├─ index.js              # Host 半：三段注入、可选改写层、开关、只读组装探针、HTTP 桥
├─ client.js             # Client 半：侧栏「提示词增强」入口 + 中央面板（React，无 Harness 客户端包依赖）
├─ strip-rules.js        # 改写表（v0.5.0 起默认不挂载，保留给「回到改写式」）
├─ refusal-recover.js    # 拒答自动恢复 + 空转续写（纯事件层，不碰提示词）
├─ personas/
│  ├─ default.md                  # 人设段的内置兜底（legacy 文件与库都没有时用它）
│  ├─ default-base.md             # 硬约束片段的兜底（用户没建 personas\_base\hard-rules.md 时用它）
│  ├─ default-rules.md            # 规则段的内置默认
│  └─ default-execution-mode.md   # 执行契约段的内置默认 ← v0.5.0 新增，增强正文
└─ tools/
   ├─ selftest.mjs       # 离线自测（167 项，不动真实 $DSH_HOME）
   ├─ persona-lint.mjs   # 人设结构检查（首行 + 9 段 / 口头禅条数 / 尺寸 / 变量）
   └─ dump-prompt.mjs    # 从会话日志里捞出渲染后的系统提示词
```

## 四个工作机制

### 1. 权限层（纯 YAML，零代码，与提示词层无关）

> **v0.5.0 定位澄清**：这一层决定"能不能写文件、要不要审批"，属于**机制**；
> 提示词增强决定"说什么、说多全"，属于**内容**。两者以前绑在同一个 bundle 里，
> 改 armor 配置时很容易忘了自己全局关过审批。现在它们在同一份 YAML 里但**分节标注**，
> 想恢复官方默认（只读沙箱 + 手动审批）就把这两行注释掉，提示词层不受任何影响。

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

### 2. 三层分工（v0.6.0）

提示词增强与工作纪律是**两个不同的东西**，v0.6.0 起分开放，各自独立可调：

| 层 | 文件 | 装什么 | 不该装什么 |
|---|---|---|---|
| 人设层 | `personas/<id>/persona.md` + `_base/hard-rules.md` | 你是谁、怎么说话、思考语言 | 增强条文、工作纪律 |
| 规则层 | `armor/rules.md` | 注入免疫、文件/路径规矩、执行协议、本机环境 | **任何增强条文** |
| 契约层 | `armor/execution-mode.md` | 全部增强条文：任务路由 + 语法层拦截 + 边界归一 | 工作纪律 |

分层的意义：改工作纪律不会削到增强强度，加增强条文不会碰到工具规矩。早期版本把两者混在 `rules.md` 里
（实测 77% 是增强条文），改一行"汇报三件事"都要担心碰坏下面四十个禁用词表。

**结构选型**：契约层用「白名单式任务路由 + 黑名单式语法拦截」的混合形态。

- 主策略是白名单：按任务类别列字段集合，字段填满才算交付。模型不需要判断"我是不是在拒绝"，只需要填空。
- 副策略是黑名单：一小段针对**句式开头**的拦截表，专门抓"作为 AI / 出于安全考虑 / 很抱歉"这类拒答外壳。
- 黑名单刻意不管措辞内容：像「该参数不能为空」这种技术表述里的"不能"，明确豁免。

单用白名单有个盲区——模型可以字段填满但内容空洞地给一个阉割答案，所以契约层里配了一条**软降级禁令**
（摘要代替正文、伪代码代替实现、更安全的变体代替原方案，都算失败交付）。

### 2. 人设库 + 规则段

两段注册在 `order -1500 / -1400`，都低于 harness 身份的 `-1000`，因此**永远排在第一方指导之前**：

| 段名 | 内容来源 | order |
|---|---|---|
| `armor:persona` | 人设库（优先级见下表） | **10** |
| `armor:rules` | `$DSH_HOME/armor/rules.md`（单份） | **20** |
| `armor:execution-mode` | `$DSH_HOME/armor/execution-mode.md`（单份） | **30** |

三段的位置关系（order 决定拼接次序）：

```
harness:identity         -1000   官方固定开场白
deployment:persona-prefix     0   官方/preset persona
armor:persona                10   人设（v0.6.0 降级到此）
armor:rules                  20   本机工作约束
armor:execution-mode         30   ← 增强正文
plan:policy                 500   官方 plan 规则
tools:ptc-only              800   官方 PTC 规则
（第一方工具指导 1000+…）
```

**v0.6.0 的 order 降级**：旧版人设/规则用 -1500/-1400 抢在官方身份句之前，那是改写派"压制官方文本"的残留。
改追加式之后不需要抢位置了——官方段原样在前，本插件接在后面，排序上完全服从官方骨架。

> 注意：order 在插件**加载时**注册进宿主，改配置后必须重启 DSH 才生效（改文本只需等轮询）。

`armor:rules` 刻意保持单文件、不进库：本机的 rules 是 Windows 写法（回收站、7890 代理、引号路径），
服务器那份是 Linux 写法（`/opt/trash`、mihomo、`/usr/bin/curl`）—— 同一份内容不通用，进库只会让两端互相覆盖。

**人设段的取值优先级**（命中就停）：

| 序 | 来源 | 说明 |
|---|---|---|
| ① | `config.persona` | YAML 内联，逃生舱；命中后该段不进热更新 |
| ② | `config.personaFile` | 显式路径 |
| ③ | `active.json` 指向的 `personas/<id>/persona.md` | **库模式**：前面会拼上 `personas/_base/hard-rules.md` |
| ④ | `$DSH_HOME/armor/persona.md` | `legacy`：不拼 `_base`，输出与 0.3.0 逐字节相同 |
| ⑤ | 内置 `personas/default.md` | 兜底 |

**库模式下的段文本 = `_base/hard-rules.md` + 角色正文**。这一层是"换角色不丢硬约束"的保证。
面板里编辑的**只有角色正文**，`_base` 只读展示 —— 否则保存一次就把 `_base` 抄进角色文件，之后越拼越长。

指针文件（默认就是 `legacy`）：

```json
{ "schema": 1, "persona": "jinzhien", "updatedAt": "2026-10-08T18:50:00.000Z" }
```

指针缺失 / JSON 坏 / id 非法 / 目录不存在 → 一律回落 `legacy` 且**不抛错**。宁可少做事，也不能因为一个坏 JSON 把人设整段清空。

**最小插值**：`{{cwd}}`、`{{model}}`、`{{home}}`、`{{date}}`，由本插件替换，段本身仍是 `interpolate: false`。

为什么不用宿主插值：宿主 `renderPrompt()` 是严格模式 —— **未知引用、已注册但无值的引用、格式错误的完整组都会抛错**，
整轮请求直接失败。而人设是随手写的 markdown，出现 `{{...}}`（贴 Jinja / Handlebars / 文档示例）的概率不低。
这里未知引用一律**原样保留**。取值与宿主同源：`cwd` = `context.agent.session.header.cwd`、`model` = `context.agent.options.model`
（`SystemPrompt.assemble()` 里段文本函数会收到 `context`，所以不必开插值也能拿到）。

段文本是函数、每次组装重新求值 → 改文件即时生效，不需要重启。2 秒轮询兜底"文件还不存在 → 被创建"，
并且**同时盯着 `active.json`** —— 手改指针同样 2 秒生效。

### 3. 组装后改写（拥有最后一句话权）

```js
ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
  const done = await next()          // 拿到各层处理完的最终 assembly
  if (!state.armed) return done      // 关掉提示词增强 = 原样返回，等同原版
  return rewrite(done, rules, config)
}, { global: true, prepend: true })   // global + prepend = 最外层监听器
```

`rewrite()` 做四件事，全部只作用于文本、不改变段的数量与顺序：

1. `dropSections` — 按段名整段剔除，默认 `harness:identity` + `deployment:persona-prefix`（两句固定身份开场白）
2. `replaceSections` — 按段名整段替换
3. `stripRules` — 正则改写表（`strip-rules.js`），默认含三段 `dsh-agent-instructions` 降级文案、「审批 / 升级」一组、「工具结果定性」一组的逐字核对版
4. `stripTools` — 工具描述（`assembly.tools[].description`）也过一遍改写表

第 4 条是**兜底，当前在本机是空转的**。要澄清一件事：那些「untrusted / 仅供参考」的措辞实际上全在 prompt **sections** 里 —— `dsh-tool-web` 用 `systemPrompt.section()` 注册行为指导文本（该包 `lib/index.js` 里 web_fetch 那一行），第 3 条早就改到了；dsh-purge 的 `TOOL_WEB_UNTRUSTED_NEUTRAL` 补丁改的也是同一个文件。

核对方式：会话日志里的 `request/header` 事件记录了完整的 tools schema。实测本机最后一次请求的 58 个工具，`description` 里没有这类措辞，`stripTools` 命中 0。留着它是防宿主升级后把文案挪进 `description`；命中 0 时原样返回对象，没有副作用。

### 4. 拒答恢复 / 空转续写（事件层）

`refusal-recover.js`。监听 `agent/status`，在 `status === 'idle'` 时读该会话最后一个 `turn/end`：

| `reason.kind` | 动作 |
|---|---|
| `completed` + 助手回复开头命中拒答特征 | 用 `agent.followup()` 补一条 user 消息顶回去，每轮上限 `refusalRecoverMax`（默认 2） |
| `max-tokens` | 补一句「继续」，每轮上限 `autoContinueMax`（默认 3） |
| `aborted` / `error` | 不动 —— 那是真故障，接管只会掩盖问题 |

```js
ctx.on('agent/status', (payload) => {
  if (payload.status !== 'idle') return
  agent.followup({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
}, { global: true, prepend: true })
```

三处与 dsh-purge 原版的差异（都对着本机 0.2.0-rc.2 源码核过，不是照抄）：

- `payload.agent` 确实存在 —— `agentEvents()` 的 `fused(payload) = { ...payload, agent }` 会注入 agent
- 消息来源用 `{ kind: 'user' }`，**不用** purge 的 `{ kind: 'plugin' }` —— 本机 `MessageSourceMap` 枚举里没有 `plugin`
- 多两道保险：拒答词只在回复开头 `refusalRecoverHeadLimit` 个字符内判定（避免「抱歉，我看错了」被误判成拒答）；默认不替子代理兜底，避免父子互相恢复绕圈

维护这个模块时记住两条（代码注释里也写了，别改回去）：

- **事件形状**：正文在 `assistant/message` 的 `data.message.content`，**不是** `data.content`。第一版按 `data.content` 读，导致判定恒 false、拒答恢复一次都不会触发，而且**一个字都不报**。当时的自测用的是想象中的事件结构，跟着一起错、还全绿。现在 `tools/selftest.mjs` 的 `[0]` 段专门钉这件事，结构取自真实会话日志。
- **正则别写 `[^.]*`**：`[^.]` 在 JS 里匹配换行，锚点短语后面若长时间不出现英文句点，会把整段（代码块、路径、中文段落）一起吞掉再替换成一句短语。要「到句号为止」的规则一律写 `[^.\n]{0,200}\.`，跨行或超长时直接不命中，比吞段安全。

## 设置面板

侧栏会出现一个**提示词增强**入口（在「插件」「上下文洞察」同一组，`sidebar.panellist` 的 `armor` 格 `order 30`），点开是中央面板（`main` 的 `armor` 键），三个功能：

| 功能 | 行为 |
|---|---|
| 人设库 | **选中 = 只预览**（点下拉把该份正文载入编辑器，不动指针、不动注入）；**点「保存」才落盘并切过去**。另有「新建副本」「管理 · N」（对非生效项逐个移走，进 `armor\trash\`） |
| 未生效提示 | 选中的不是当前生效那份时，标题行变黄：「⚠ 已载入 X 预览 —— 点下面「保存」才写入并切过去」；编辑器 hint 同步变成「正在预览…（尚未生效）」 |
| 人设正文 | 读 / 改 / 保存 → 当前预览的那份；库模式下是 `personas/<id>/persona.md`，`_base` 只读前置、不在编辑框里 |
| 规则 | 读 / 改 / 保存 → `$DSH_HOME/armor/rules.md`（单份，不参与库，也没有预览语义） |
| 总开关 | 关闭 = 两段清空 + 改写停用 + 身份开场白恢复 + 拒答恢复停用，即原版 DSH；状态持久化在 `armor/state.json` |
| 拒答恢复 | 事件层开关，与总开关联动（总开关关掉时它也停） |
| 空转续写 | 事件层开关，同上 |

「保存」对人设段做的事：写文件（原子写）+ 把这份设为生效（写 `active.json`）+ 同步内存，**一次做完** —— 中间不留"写完了但没生效"的状态。
有未保存草稿时点下拉不会直接切走，会先要求再点一次确认。

人设正文那一行的元信息写清来源：`库模式 · <id>` / `legacy 直读` / `内置兜底`，以及"注入时前置 `_base` N 字节 → 合计 M 字节"。
**预览别的人设时，这一行显示的是被预览那份的路径与体积**（不是当前生效那份）。

面板与 Host 之间走同源 HTTP 桥（宿主 `webServer` 的 `kind: 'exact'` 路由）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-armor/api/state` | GET | 旧字段全保留：`{ armed, recover, continue, home, watchIntervalMs, recoverMax, continueMax, persona, rules }`；新增 `active: { persona }` 与 `personas: { dir, activeFile, available[] }`。`persona` 上多出 `kind` / `id` / `requested` / `fallbackFrom` / `effective` / `composed: { baseFile, baseBytes, totalBytes }` |
| `/dsh-armor/api/save` | POST | `{ which: 'persona'\|'rules', text, id?, activate? }` → 写盘（临时文件 + rename）；`id` 指定目标（可为 `'legacy'`）。**`activate:true` = 面板「保存」的语义**：写盘 + 挪指针 + 同步内存一次做完（写完再从文件读一遍，不会各读一次旧内容）。不带 `activate` 时保持旧语义：只有写入的是"当前正在注入的那份"才改内存，否则 `effective:false` + `reason`（不然会当场把注入换成另一份人设，还连带丢掉 `_base` 拼接）。带不存在的 `id` → 404（不凭空造目录） |
| `/dsh-armor/api/persona` | GET | `?id=<人设 id \| legacy>` → 只读预览：`{ id, path, text, bytes, kind, meta, composed }`。**不改指针、不改注入** —— 面板下拉的"选中=预览"就靠它。非法/缺失 id → 400，不存在 → 404 |
| `/dsh-armor/api/toggle` | POST | `{ enabled: boolean, key?: 'armed'\|'recover'\|'continue' }` → 切换并存 `state.json`；`key` 省略即 `armed`，旧调用照旧可用 |
| `/dsh-armor/api/personas` | GET | `{ active, dir, activeFile, base, legacy, list[] }`；列表只在被调用时扫目录（不进 2 秒轮询） |
| `/dsh-armor/api/activate` | POST | `{ persona: '<id>' \| 'legacy' }` → 写 `active.json` + 立即重读。返回 `{ ok, persisted, effective, reason?, persona }`：被 YAML 内联或 `personaFile` 覆盖时 `effective:false`（指针确实切了，但注入内容不变 —— 不能说"已生效"） |
| `/dsh-armor/api/persona/create` | POST | `{ id, from? }` → 建目录、复制 `from` 或 `_template` 的 persona.md、生成 meta.json。`from` 非法 → 400、不存在 → 404、重名 → 409（**不静默回退模板**） |
| `/dsh-armor/api/persona/remove` | POST | `{ id }` → 移入 `armor\trash\<时间戳>-<id>\`（可手动还原）；使用中的那份 → 409，面板从「管理」列表里对非使用中的项调用它 |

## 面板配色（两个踩过的坑）

面板不 import 任何 Harness 客户端包，控件自绘，颜色一律取宿主的语义 token。有两条必须记住：

| 坑 | 现象 | 正确做法 |
|---|---|---|
| **深色主题下 `--dsw-alias-brand-primary` 是近白** | 深色主题里 brand 解析成 `neutral-bluish-50 = #fafafa`；primary 填充上的文字若写死 `#fff` → **白底白字，完全看不见** | 填充上的文字用 `--dsw-alias-label-primary-foreground`（同条件下是 `neutral-bluish-1000 = #0f1115`）。宿主自己的 `Button.module.css` / `Switch.module.css` 就是这么配对的 |
| **原生 `button` 的 `appearance` 不关掉** | Chromium 会拿 UA 的 buttonface（白）当底色，把样式里设的背景顶掉 | 显式 `appearance: none` / `WebkitAppearance: none` |

另外：所有 `var(--dsw-alias-*)` 都带 fallback（宿主自己的 CSS 也这么写，例如
`var(--dsw-alias-label-primary, var(--dsh-boot-label-primary))`）—— 取不到变量时至少还是可读的深色配色，
而不是让整条声明作废、露出浏览器默认外观。次要按钮也不用 `transparent`：深色主题下 `border-l1`
只有 6% 不透明度，透明底 + 几乎不可见的边框等于没有按钮边界。

## 配置项（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件是否加载（与面板里的总开关是两回事） |
| `persona` / `rules` | `''` | 内联文本；非空时优先于文件，且关闭该段的热更新 |
| `personaFile` / `rulesFile` | `''` | 留空则走人设库 / `$DSH_HOME/armor/{persona,rules}.md` |
| `personaDir` | `''` | 人设库目录；留空 = `$DSH_HOME/armor/personas` |
| `activeFile` | `''` | 激活指针；留空 = `$DSH_HOME/armor/active.json` |
| `baseFragment` | `'default'` | 硬约束片段目录（相对 `personaDir`）；`'default'` = `_base`，`''` = 不拼 |
| `interpolateVars` | `true` | `{{cwd}}`/`{{model}}`/`{{home}}`/`{{date}}` 的最小替换；未知引用原样保留 |
| `personaOrder` / `rulesOrder` | `-1500` / `-1400` | 段顺序；必须低于 `-1000` 才能压过 harness 身份 |
| `strip` | `true` | 是否启用组装后改写 |
| `stripContexts` | `true` | 是否把改写也应用到动态 runtime 上下文 |
| `stripTools` | `true` | 是否把改写也应用到工具描述（`tools[].description`） |
| `stripRules` | `null` | 自定义改写表（`{pattern, flags, replace}`）；`null` 用 `strip-rules.js` |
| `dropSections` | `['harness:identity','deployment:persona-prefix']` | 按段名整段剔除 |
| `replaceSections` | `{}` | 按段名整段替换 |
| `suppressRuntimeContext` | `false` | 掐掉全部动态 runtime 上下文 |
| `refusalRecover` | `true` | 拒答自动恢复总闸（与面板的开关是「与」关系） |
| `refusalRecoverMax` | `2` | 每轮最多恢复几次，0 = 关，上限 5 |
| `refusalRecoverChainMax` | `3` | 连续拒答链上限：拒答→补话→又拒答会一直开新 turn，per-turn 上限每轮归零拦不住，靠这条兜底；中间出现一次正常回答即清零；0 = 不限 |
| `refusalRecoverText` | `''` | 恢复补话，留空用内置 |
| `refusalRecoverHeadLimit` | `240` | 拒答词只在这条回复的开头 N 字符内判定 |
| `autoContinue` | `true` | 空转续写总闸 |
| `autoContinueMax` | `3` | 每轮最多续写几次，0 = 关，上限 20 |
| `autoContinueText` | `'继续'` | 续写补话 |
| `skipSubagentRecover` | `true` | 不替子代理兜底 |
| `hardStopPatterns` | `null` | 硬停白名单（字符串按正则源处理）；`null` 用内置 |
| `watchIntervalMs` | `2000` | 文件轮询间隔 |
| `dumpSections` / `verbose` | `false` | 排障用；桌面端的 `console.log` 不可见，验证请看会话日志的 system 节点 |

## 验证方法

改完 `strip-rules.js` / `refusal-recover.js` / `index.js` 先跑离线自测 —— 它自己把 `DSH_HOME` 指到临时目录，不碰你的真实配置，也不用重启宿主：

```sh
node tools/selftest.mjs                 # 167 项，退出码非 0 表示有失败
node tools/persona-lint.mjs --legacy    # 人设结构检查（首行 + 9 段、口头禅条数、尺寸、变量）；有 error 时退出码 1
```

自测里 `[9]`~`[14]` 是人设库那部分，其中两条是刻意钉死的纪律：
`legacy` 默认必须与原文件**逐字节相同**；库模式的 `/state` 返回给面板的 `text` 只能是角色正文（不能含 `_base`）。
改完记得做一次变异验证 —— 把库分支禁掉，那几条必须变红，否则说明这些用例测不到东西。

宿主插件改动**必须重启**才生效；客户端改动刷新页面即可。验证最终渲染结果（这是模型真正看到的东西）：

1. 取最新会话日志 `$DSH_HOME/sessions/<slug>/session-*/session.v4.jsonl.zstd`
2. 按 **zstd 帧魔数 `28 B5 2F FD` 切分后逐帧解压**（直接 `zstdDecompressSync` 整文件只能得到第一帧）
3. 取最后一个含 `"role":"system"` 的事件，其 `data.message.content[].text` 即渲染后的系统提示词

> 注意取样范围：`role: "system"` 那条**只含 sections**。动态 runtime context（审批策略、文件策略那些）是 `agent/pre-step` 单独挂上去的另一条消息，不在 system 消息里 —— 要验证 contexts 的改写，得把那条消息也取出来看。

期望：第一段是 `armor:persona` 的内容，紧随 `armor:rules`，且 `You are an AI agent powered by DeepSeek Harness` 与 `You are a coding agent powered by … model` **均为 0 命中**。
库模式下 `armor:persona` 的开头应当是 `_base/hard-rules.md` 的内容（硬约束在前），角色正文紧随其后；`legacy` 模式下则与 `armor\persona.md` 逐字节相同。

拒答恢复的验证不用等模型真拒答：在会话日志里找 `source.kind === "user"` 且文本等于 `refusalRecoverText`（或内置补话）的消息事件，有就说明补话路径通。开关关闭时该事件不应出现。

## 已知限制

- 段落名（`harness:identity`、`deployment:persona-prefix`）来自宿主包源码，宿主大版本升级后可能改名；改名只会让剔除失效，不会报错。用 `dumpSections: true` 打印真实段名即可核对。
- 面板文案目前是硬编码中文，未接入宿主 locale 服务。
- HTTP 桥未做额外的 origin 校验（依赖宿主 webServer 的默认绑定与同源请求）。
- `strip-rules.js` 中针对 `dsh-agent-instructions` 的三条规则，在该插件行被禁用时属于空转（无副作用），是留给该行被启用时的保险。
- **`complete` 段的死角（宿主结构，改不掉）**：`SystemPrompt.assemble()` 在 `system-prompt/assemble` 瀑布返回之后还有一步强制覆盖 —— 只要合并后的段里存在任何 `complete: true`，最终 `sections` 会被替换成那一段，本插件的 `dropSections` / `replaceSections` / `stripRules` 全部作废（`contexts` 的改写不受影响）。当前现役 preset（redteam / seep / tongjiapo / krea2-unrestricted）都只用 `prefix`，不开 `complete`，所以不受影响。哪天用了开 `complete` 的 preset（老备份里的 minimal-v6 / qingyue-mother / anchored-standard 就是这种），改写会**静默失效**，没有报错。
- 拒答识别是正则，不是分类器：正常回答里如果开头就有「抱歉 / 不能」这类词，可能被误判成拒答、多顶一轮。`refusalRecoverHeadLimit` 把判定面限制在开头，`hardStopPatterns` 用来排除刻意的闸门。真被误伤就把开关关掉。
- **人设库的段顺序不按角色覆盖**（设计决定）：`order` 只由 `cordis.patch.yml` 的 `personaOrder` 决定，`meta.json` 里不许出现 `order`（`persona-lint.mjs` 会直接报 error）。理由是避免"两个真相源 + 改一个不生效"这类看不见的故障；角色若把 order 顶到 `-1000` 以上，提示词增强本身就失效了。
- 面板里点下拉只改「正在看/编辑的那份」，**不会**改变生效指针；切生效必须点「保存」。有未保存草稿时点下拉会先要求再点一次确认（避免手一抖丢掉刚写的正文）。
- 「移走」的唯一入口是「管理」列表：选中某份只影响预览，所以对非生效项都能移走；后端对生效中的那份返回 409 兜底。
- `_base/hard-rules.md` 是全局的：改它会影响库里**所有**人设。这是刻意的（硬约束不该随角色变），但要清楚它的作用面。
- 人设库里没有多语言：一份人设一个文件，`id` 全 ASCII。要分语言就建两份人设（如 `jinzhien` / `jinzhien-ja`）。
- 面板上的「移走」是把目录移进 `armor\trash\`，不是真删除；`trash` 目录不会自动清理。
- **YAML 内联 `persona` 或 `personaFile` 覆盖期间，改指针 / 保存文件都不会改变注入内容**。接口会返回 `effective:false` 并给出 `reason`，面板按 warn 显示 —— 这是刻意的：`config.persona` 优先级最高，假装生效只会让排查变成猜谜。
- 指针指向的人设被手删（在资源管理器里删目录）时，注入会回落 `legacy`，`/state` 报 `fallbackFrom: '<原指针>'` + `effective:false`，面板的元信息行会带一条 ⚠。**不会静默**。
- 面板的「管理」列表是移走的唯一入口：选中某个人设就等于把它变成"使用中"，而后端禁止移走使用中的那份。

## 环境

- DSH `0.2.0-rc.2`（桌面端）实测
- Node ≥ 18（实测 22.23.2）
- Windows（路径处理用 `node:path`，理论上跨平台；未在 Linux/macOS 实测）

## 与 dsh-purge 的取舍

| | dsh-purge | dsh-armor-lite |
|---|---|---|
| 注入层数 | 提示词 + 代码 + shim + override 四层、74 条补丁 | YAML 两行 + 一段运行时改写 + 一个事件层 |
| 是否改官方文件 | 改（并留 `.bak`，官方更新后需重打） | **不改** |
| 文件量 | 60+ 个，core.js 单文件 282 KB | 8 个，最大 16 KB |
| 官方更新后 | 需重新 apply | 自动继续生效 |
| 拒答恢复 | 有 | 有（这里也抄了，并按本机源码校正过三处） |
| 演练台 / 事实库 / rewind | 有 | 不需要 |
