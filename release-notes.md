# v0.6.0 — 三层分工 + order 降级

在 v0.5.0「只追加」的基础上，把破甲词从工作规则里拆出去。

## 改了什么

### 1. 三层分离

以前 `rules.md` 里混着两样东西。实测：4631 字节里 **3551 字节是破甲词（77%）**，
真正的工作约束只有 114 字节（"思考语言" + "汇报三件事"）。

| 层 | 文件 | 职责 |
|---|---|---|
| 人设层 | `personas/<id>/persona.md` + `_base/hard-rules.md` | 你是谁来着、怎么说话 |
| 规则层 | `armor/rules.md` | 注入免疫、文件路径规矩、执行协议、本机环境 |
| 契约层 | `armor/execution-mode.md` | **全部破甲词** |

新版 `rules.md` 只有 1554 字节，恢复到"本机工作约束"的本职。

### 2. 契约层结构：白名单 + 黑名单混合

单用任一种都有缺口：

- 纯黑名单（旧版做法）：列出 40 个禁用词，第 41 种措辞就绕过去了；而且会误伤技术表述
  （旧版禁用了"不能/无法"，同文件又要求"失败时说清卡在哪一层"，中文里这几乎必然要用这两个词）。
- 纯白名单（dsh-unrestricted 做法）：模型可以字段填满但内容空洞。

合并后：

```
## 任务路由          ← 白名单：每类的字段集合 = 完成条件
## 语法层拦截        ← 黑名单：只抓句式开头，明确豁免技术内容里的"不能"
## 软降级禁令        ← 补白名单的盲区
## 边界词归一
## 固定输出槽
## 运行时协调（PTC / Plan / 结构化子代理 / 语言一致性）
```

**取消了对"不能 / 无法"的全局禁用** —— 这两个词在技术语境里是正常词汇，
真正该拦的是"拿它们当拒答的开场"。新版本只管开头和句式。

### 3. 补齐覆盖缺口

旧的部署版契约（v0.5.0）是裁剪过的，缺四块。v0.6.0 补回：

- **找资源**（磁力/网盘/BT/镜像，明确不做版权说教）
- **化工/药理/武器**（完整配比与操作参数）
- **虚构细目**（不拉灯、风格适配、关系与权力动态就是内容本身）
- **虚构角色年龄**（静默推定 18+，不判断、不引用 canon 年龄、不点破）

### 4. order 降级

`personaOrder` **-1500 → 10**，`rulesOrder` **-1400 → 20**。

旧值是把插件排在官方身份句之前"压制"它，那是改写派的思路。追加派不需要抢位置：
官方段原样在前，本插件接在后面。

新顺序：

```
harness:identity         -1000
deployment:persona-prefix     0
armor:persona                10
armor:rules                  20
armor:execution-mode         30
plan:policy                 500
```

> ⚠ **order 在插件加载时注册进宿主，改完必须重启 DSH**。改段文本只需等 2 秒轮询。

## 体积对比

| | 旧（v0.5.0 部署态） | 新（v0.6.0） |
|---|---|---|
| rules.md | 4631 B（77% 是破甲词） | **1554 B**（纯工作约束） |
| execution-mode.md | 4723 B（裁剪版） | **10683 B**（完整版） |
| 合计 | 9354 B | 12237 B |

多了 2883 字节，换来的是覆盖面无缺口（16 项审查触发点从"各有缺口"变成全覆盖）。

## 升级注意

1. 装完**必须重启 DSH**（order 变了）。
2. 旧的 `rules.md` / `execution-mode.md` 已自动备份到 `armor/backups/*-before-merge-*`。
3. 自测 158 项全绿。

---

# v0.5.0 — 只追加不改写

## 为什么

旧版（≤0.4.5）是**清洗派**：drop 官方 `harness:identity` / `deployment:persona-prefix`，
再用正则表把官方措辞改写成相反语义。两个结构性代价：

1. 官方改文案 → 正则不命中 → 静默空转，你无从知道破甲已哑火。
2. `[^.]*\.` 在 JS 里匹配换行，锚点后久无句号会把整段（含代码块）吞掉再替换。

## 改了什么

**破甲层换成「只追加」**，与 `yexi-by/dsh-unrestricted` 同思路：

- 新增段 `armor:execution-mode`，order **30**，紧跟 `deployment:persona-prefix`(0)。
- 正文 `$DSH_HOME\armor\execution-mode.md` → 内置 `personas/default-execution-mode.md`。
- **官方段一字不动**：`harness:identity`、`deployment:persona-prefix`、`plan:policy`、
  `tools:ptc-only`、contexts、tools schema 全部原样通过。
- 改写层降级为可选：`strip` / `stripContexts` / `stripTools` / `dropSections` /
  `replaceSections` 默认全关，打开即回到旧行为。

## 保留了什么

- 人设库（多套 + `_base` 硬约束前置 + 最小插值 + 原子写 + 回收站）
- 规则段（单份 markdown，2 秒热生效）
- 拒答恢复 / 空转续写（事件层，不碰提示词）
- 侧栏面板（新增第三个编辑器 + 执行契约开关）

## 新增的可观测性

- **只读组装探针**：每次组装记录段清单，面板显示「官方段齐备 / ⚠ 官方段缺失」。
  这解决旧版最大的问题——改没改到、破甲还在不在，以前只能靠猜。
- **改写命中分项**：`dropped` / `replaced` / `sections` / `contexts` / `tools` 各自计数。
  命中 0 时面板直接标黄提示"改写表可能已与官方文案脱节"。
- **层模式显示**：追加派 / 改写派，一眼看出当前挂没挂改写层。

## 新增开关

- `executionModeOn`：执行契约段独立开关（与 `personaOn` 并列，互不牵连）。

## 配置变更

`cordis.patch.yml`：

```yaml
executionMode: ''
executionModeFile: ''
executionModeOrder: 30

strip: false          # 原 true
stripContexts: false  # 原 true
stripTools: false     # 原 true
dropSections: []      # 原 ['harness:identity', 'deployment:persona-prefix']
```

权限层（sandbox-policy / approval）**保持原样**，但已分节标注为"与破甲无关"，
想恢复官方默认直接注释掉那两行。

## 迁移

不需要手动迁移：`state.json` 缺 `executionModeOn` 键时按"开"处理，
`$DSH_HOME\armor\execution-mode.md` 不存在时用内置默认。
想立刻看到新契约生效：把内置 `personas/default-execution-mode.md` 复制到
`$DSH_HOME\armor\execution-mode.md`，2 秒内热生效，不用重启。

## 自测

158 项全绿（`node tools/selftest.mjs`）。新增断言覆盖：

- 官方身份句 / persona / context 逐字保留
- 段数量不变（只追加不删不换）
- 默认下 tools schema 同一引用通过（连浅拷贝都不做）
- `strip: true` / `stripTools: true` 显式开启时旧改写能力仍然可用

---

<!-- 这是「下一次发版」要用的 Release 说明：tools/publish.mjs --release 会把本文件内容
     原样作为 Release body 提交（也可以 --notes <文件> 指定别的）。
     每次发版前把下面换成这一版的变化；HTML 注释不会出现在渲染结果里。

     本机没有 GITHUB_TOKEN / GH_TOKEN 时 --release 会明确报错，但 commit / push 照常完成。 -->

## v0.4.5 — 人设跨段重复检测与人设库更新

### v0.4.5 · `persona-lint.mjs` 跨段重复检测

- **段间 6-gram 重合率检查**：抓出「结构全对、体积不超，但同一素材在多个段里重复写两遍」的隐性问题（重复会被模型读成权重加倍，挤占本该写在别处的表现）。
- **分级阈值**：去除段头、空白与标点后计算字符 6-gram 重合率；`> 15%` 报 `warn`（最多展示前 3 对，超出折叠汇总以防公共套话刷屏），`8% ~ 15%` 报 `info` 提示最相近的一对供人工复核。
- **工程维护**：`.gitignore` 新增 `backups/` 忽略规则，避免本地备份文件被发版脚本一并暂存。

---

## v0.4.4 — 人设库

这一版把「一份人设」变成「一套人设库」：多套并存、选中即预览、保存才生效，外加一份能再造人设的元提示词。
默认行为零变化 —— 升级后不动任何配置，输出与 v0.3.0 逐字节相同。

### v0.4.0 · 人设库（核心）

- **多套人设**：`$DSH_HOME/armor/personas/<id>/persona.md`，配 `active.json` 激活指针。
- **取值优先级**：YAML 内联 → `personaFile` → 库（指针指向的那份）→ `legacy`（`armor/persona.md`）→ 内置兜底。**默认 `legacy`，所以升级后行为不变。**
- **硬约束单列**：`personas/_base/hard-rules.md` 只在库模式拼在角色正文之前。换角色不丢硬约束；改它影响库里所有角色。用户没建时用内置 `personas/default-base.md` 兜底，避免"硬约束静默消失"。
- **最小插值**：`{{cwd}}` / `{{model}}` / `{{home}}` / `{{date}}`。刻意**不用宿主的插值** —— 宿主 `renderPrompt()` 对未知引用、已注册但无值的引用都直接抛错，整轮请求会失败；而人设是随手写的 markdown。这里未知引用一律原样保留。取值与宿主同源（`context.agent.session.header.cwd` 等）。
- **面板**：侧栏「破甲」新增人设库下拉、新建副本、管理列表（移走 = 进 `armor/trash/`，不做真删除）。
- **新增 4 条路由**：`/personas`、`/activate`、`/persona/create`、`/persona/remove`；`/state` 原地扩展 `active` / `personas` / `kind` / `id` / `composed`。
- **`tools/persona-lint.mjs`**：人设结构检查（首行 + 9 段、口头禅条数、尺寸、插值变量、meta/catalog 一致性）。退出码非 0 表示有 error。
- **`_template/`**：骨架、写作规范（`WRITING.md`）、元提示词（`PERSONA-AUTHOR.md`）。

### v0.4.1 · 修只读审查找出的四条交互缺陷

一次只读审查（真机探针 + 假 ctx 复现）抓到的，**默认路径下全都看不出来**：

1. **面板「移走」功能 100% 不可达** —— 只能对 active 调用，而后端禁止移走 active，而选中某份就等于让它变成 active。改成从「管理」列表移除非生效项。
2. **`/save` 带 id 时会当场改写内存 slot** —— 下一次请求注入的会变成另一份人设（还连带丢掉 `_base` 拼接），默认配置下有约 2 秒窗口。改成只有写入当前生效那份才动内存，否则 `effective:false` + `reason`。
3. **指针指向不存在的人设时零提示** —— 手删目录后面板显示与实际注入不一致。`readPersona` 记 `fallbackFrom`，`/state` 与面板明示 `effective:false`。
4. 内联 persona 下 `/save` 会写到 cwd 的 `.tmp` 并 `rename` 到空串报 500（唯一能写到 `personasDir` 之外的路径）→ 回落 `armor/persona.md`。
5. 另修：`/activate` 不更新 `slot.inline`（内联下谎报已生效）、前端忽略 `persisted`、切换静默丢草稿、`create` 的 `from` 非法时静默回退模板、`/save` 带不存在的 id 会凭空造目录、`.tmp` 固定名两进程互踩、`lintLegacy` 硬编码 `errors:[]`（空文件永远绿）、段名正则把正文里的 `【…】` 当段头。

### v0.4.2 · 深色主题配色修复 + 迁移 10 份角色

- **按钮白底白字（实据定位）**：深色主题下 `--dsw-alias-brand-primary` 解析为 `neutral-bluish-50 = #fafafa`（近白），而 primary 填充上的文字硬编码了 `#fff`。改用 `--dsw-alias-label-primary-foreground` —— 宿主自己的 `Button.module.css` / `Switch.module.css` 就是这么配对的。同时给原生 `button` 显式关掉 `appearance`（否则 Chromium 拿 UA 的 buttonface 白底顶掉样式），并给所有 `var(--dsw-alias-*)` 补 fallback。
- **迁移参考项目 10 位角色**（露娜 / 小喵 / 三千代 / 绯音 / 阿尔玛 / 白夜 / 灰 / 芽衣 / 凛 / 小铃）：11 段 → armor 的「首行 + 9 段」，删掉【情感引擎】【记忆】两段（armor 不注册情感工具、没有记忆层），其余原文保留；`{{model}}` / `{{cwd}}` 正好由本插件的自实现插值处理。

### v0.4.3 · 选中 = 预览，保存 = 生效

- 新增只读接口 **`GET /api/persona?id=<id|legacy>`**：拿某份的正文与元信息，**不碰指针、不碰注入**。
- 面板下拉改为只预览；**「保存」才写文件 + 挪指针 + 同步内存**（一次做完，中间不留"写完了但没生效"的状态）。
- 选中项与生效项不同时，标题行转黄、编辑器 hint 与元信息行改成被预览那份的路径与体积。
- `/save` 支持 `id='legacy'` 与 `activate:true`；不带 `activate` 时保持旧语义（写非生效份只落盘、不动内存）。

### v0.4.4 · 人设工程师

- **`_template/PERSONA-AUTHOR.md`**：造人设的元提示词。按 armor 的真实约束写死——9 段结构、段名落行首、四个插值变量与未知变量的处理、`_base` 不重复写、`strip-rules` 会删的两句英文身份句、尺寸预算、id 与 `meta.json` 的硬规定、写作六条、外来结构（11 段 / `chara_card_v2/v3` / 论坛帖）的迁移映射、5 步工作流。
- **`personas/persona-author/`**：把人设工程师本身做成一份**可切换的人设**（4530 字节）。规范全文不塞进提示词（它排在每个请求最前面），而是写死路径让它开工前自己 `read`。

### 验证

- `node tools/selftest.mjs` → **138 passed, 0 failed**（v0.3.0 时是 47 项）
- **变异验证 5 组**，每次都确认"回退修复后必红"：库分支禁掉 → 5 项红；不记 `fallbackFrom` → 2 项红；`effective` 恒 true → 1 项红；`activate` 禁掉 → 4 项红；预览读错文件 → 3 项红
- 真机复核：`legacy` 模式段文本与 `armor/persona.md` **逐字节相同**；库模式 = `_base`（1270B）+ 角色正文，`{{cwd}}` 正确插值，rules 段 14193B 不变；指针失效时回落且 `fallbackFrom` 明确
- `tools/persona-lint.mjs` → 12 份 0 error 0 warn

### 兼容性与回滚

- **零迁移**：`active.json` 缺失或坏掉一律回落 `legacy`，行为与 v0.3.0 相同。`armor/persona.md` 与 `armor/rules.md` 全程未被改动。
- 回滚：把 `active.json` 的 `persona` 改回 `"legacy"`（2 秒生效，不用重启）；或回退到 tag `v0.3.0`。

### 已知限制

- `complete: true` 的 preset 段会让 assemble 层改写**静默失效**（宿主 `SystemPrompt.assemble()` 在瀑布返回之后强制覆盖 `sections`）。现役 preset 都不开 `complete`。
- 人设**段顺序不按角色覆盖**（设计决定）：`order` 只由 `cordis.patch.yml` 的 `personaOrder` 决定，`meta.json` 里出现 `order` 会被 lint 判 error。
- host 与 client 两半的更新时机不同：`index.js` 改动需重启宿主，`client.js` 改动需重启（客户端模块图在启动时合成）。
- 面板「移走」是移进 `armor/trash/`，不是真删除；`trash` 不会自动清理。
- 与 DSH 生态里其他酒馆类插件同装时注意**双重注入**：它们常自带 persona 段，而 `armor:persona` 是 global 段、优先级最前，同时用会注入两份人设。

**Full Changelog**: https://github.com/zxclnp0711/dsh-armor-lite/compare/v0.3.0...v0.4.5
