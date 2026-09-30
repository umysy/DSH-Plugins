# dsh-quota-card

[![test](https://github.com/umysy/DSH-Plugins/actions/workflows/test.yml/badge.svg)](https://github.com/umysy/DSH-Plugins/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/umysy/DSH-Plugins?label=release)](https://github.com/umysy/DSH-Plugins/releases)

DeepSeek Harness（DSH）侧边栏左下角的一张常驻卡片：**余额 / 今日用量 / 本月用量 / 缓存命中 / 峰谷时段与价格倍率**。

```
┌──────────────────────────────────┐
│ 额度概览                    ⟳  ⚙ │
│ 余额                        ¥9.66 │   ← 绿色
│ ──────────────────────────────── │
│ 今日用量                    15.5M │
│ ──────────────────────────────── │
│ 本月用量                    20.4M │
│ ──────────────────────────────── │
│ 缓存命中                    99.2% │
│ ──────────────────────────────── │
│        高峰时段：周一至周五        │
│   9:00-12:00  14:00-18:00        │   ← 橙黄色
│        （其余为空闲时段）          │
│     空闲价格为高峰价格的一半       │
│        空闲时段（5 折）· 剩余 2h 14m │   ← 按时段变色
│       ● 更新于 21:03:41           │
└──────────────────────────────────┘
```

位置：`sidebar.footer.action` 槽位，`order: -1`，即**在侧边栏底部的 Settings 之上**。侧边栏收起成 56px 窄条（rail）时卡片自动隐藏。`⟳` 立即刷新，`⚙` 切换是否显示估算费用行（写入 `localStorage`，不涉及 Host）。

---

## 安装

本包是一个**双面（dual-face）Cordis bundle**，无构建步骤（`lib/` 里的 JS 就是最终产物），无 `install`/`postinstall` 脚本，因此不会被 pnpm 的 `allowBuilds` 门挡住。

它住在 [`umysy/DSH-Plugins`](https://github.com/umysy/DSH-Plugins) 这个插件集合仓库的 `packages/dsh-quota-card/` 下。

### 从 GitHub 安装（推荐）

```bash
# dsh web：跟随 main
dsh plugin --profile web add "github:umysy/DSH-Plugins"

# dsh web：固定版本
dsh plugin --profile web add "github:umysy/DSH-Plugins#v0.3.1"
```

装完**重启 Harness**（插件发现按进程缓存），刷新页面。可用版本见 [Releases](https://github.com/umysy/DSH-Plugins/releases)。

桌面端 App 独占 `desktop` profile，命令行会被拒绝，改用 App 内的 `设置 → 插件 → 添加插件`，source 填 `github:umysy/DSH-Plugins`。

安装会把包同时写进 profile 的 `dependencies` 与 `dsh.profile.bundles`，并自动应用包内 `dsh.bundle.patch` 指向的 `cordis.patch.yml` —— **不需要**手改 profile 的 `cordis.patch.yml`。

### 从本地克隆安装（开发用）

```powershell
git clone https://github.com/umysy/DSH-Plugins
dsh plugin --profile desktop add "link:<克隆路径>\packages\dsh-quota-card"
```

`link:` 是符号链接安装，改源码后重启即可生效，不用重装。

> 桌面端若拒绝命令行安装，手工两步同样可行：在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加 `"dsh-quota-card": "link:<克隆路径>\\packages\\dsh-quota-card"`，再把 `dsh-quota-card` 追加进 `dsh.profile.bundles`，然后在 `~/.dsh/profiles/desktop` 跑一次 `pnpm install`。

### 卸载

```bash
dsh plugin --profile web remove dsh-quota-card
```

账本文件（`$DSH_HOME/quota-card/usage.json`）不会被删除，需要时手动删除即可。

---

## 配置

插件的 `cordis.patch.yml` 是本包的 bundle 补丁层，其中的 `config:` 就是**默认值层**（base layer）。改它会通过 patch 层 HMR 生效，**无需重启**。字段缺失或非法时逐个回退到内置默认值，所以写错不会让 Harness 起不来。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `timezone` | `Asia/Shanghai` | 峰谷判定与"今日/本月"分桶所用时区；**与机器时区无关** |
| `peakWindows` | `[["09:00","12:00"],["14:00","18:00"]]` | 高峰窗口（该时区的墙钟时间）；结束点不包含在内，故 `18:00` 已是空闲 |
| `peakDays` | `[1,2,3,4,5]` | 高峰星期，1=周一 … 7=周日（ISO） |
| `peakMultiplier` | `2` | 空闲 = 高峰 ÷ 该值；`2` 即「空闲价格为高峰价格的一半」 |
| `holidays` | 省略 → 用内置表 | 中国法定节假日，全天按空闲。**省略该键 = 使用 `lib/holidays.js` 里的内置表**；给非空映射 = 覆盖内置表；给空映射 `{}` 或空数组 `[]` = 清空（规则退化为"仅按周一至周五"，卡片显示「节假日表：未知」）；给不合法值（数字、`null`、无日期的对象）＝ **回退到内置表**，不会静默清空。接受 `{名称: ["02-17"]}`、`{"2026": ["02-17"]}`、`["2026-02-17"]` 三种写法 |
| `makeupWorkdays` | 省略 → 用内置表 | 调休上班的周末，语义与 `holidays` 相同 |
| `countMakeupAsPeak` | `false` | 调休上班日是否按高峰计。官方文字未提及调休，故默认**不算**高峰；若你观察到账单按高峰计费，改成 `true` |
| `showCost` | `false` | 是否默认显示估算费用行（卡片上的 ⚙ 可在浏览器本地覆盖） |
| `showTotalTokens` | `false` | 用量口径：`false` = **计费 token**（不含缓存读取）；`true` = token 总量（含缓存读取）。卡片上的 `¥/Σ` 按钮可在浏览器本地覆盖，见「用量口径」一节 |
| `note` | `空闲价格为高峰价格的一半` | 卡片底部小字；设为 `""` 可隐藏 |
| `prices` | `deepseek-flash` / `deepseek-v4-pro` | 高峰价（**CNY / 百万 token**），仅用于费用估算 |
| `balancePollMs` | `60000` | 余额最短刷新间隔（Host 侧缓存，避免频繁打接口） |
| `locale` | `zh_CN` | 随账号余额查询一起发送的身份信息，仅用于标记请求 |
| `clientVersion` | `dsh-quota-card/0.3.1` | 同上 |
| `platformHistory` | `false` | 是否读取**开放平台账号历史**（累计消费 / 累计用量）。开启需要控制台 token，见下节 |
| `platformTokenRef` | `DEEPSEEK_USER_TOKEN` | 控制台 token 的凭据名（环境变量 / DSH 凭据存储都按这个名字解析） |
| `platformHistoryMonths` | `48` | 最多回溯多少个月（上限 120）；连续 3 个零消费月会提前停止 |
| `platformHistoryTtlMs` | `600000` | 历史扫描的缓存时长（10 分钟） |

---

## 数据来源与口径（重要）

### 余额 —— 官方接口

**优先走 DSH 已登录账号**：调用官方 `ctx.deepseekAccount.getBalance()`，**不需要任何配置**，余额与赠送额度都来自平台返回。只有当账号不可用（未登录 / 凭据过期 / 该 profile 没有账号服务）时，才回退到**环境变量 `DEEPSEEK_API_KEY`** 调 `GET https://api.deepseek.com/user/balance`。

无论走哪条路，请求都只在 Host 侧发出，**凭据永不进入浏览器**（浏览器只 fetch 本机同源的 `/quota-card/snapshot`）。两个来源都会解析出总额与赠送额度：卡片显示总额，悬停可见拆分。

两条路都不可用时，余额行显示灰字「未登录 · 未配置 API Key」，其余指标照常工作。接口失败时保留上一次成功读数（状态点转黄），不会闪成错误。`/quota-card/health` 的 `balance` 字段会告诉你当前用的是哪条路（`accountService` / `hasApiKey` / `lastAccountError`）。

### 累计消费 / 累计用量 —— 开放平台历史（可选，默认关闭）

默认情况下，卡片上的「累计消费 / 累计用量」来自**本地账本**，起点是你**安装本插件那天**，悬停会写明这一点。

想看到**账号创建至今**的真实总额，需要开启 `platformHistory`。它读的是开放平台用量页自己的接口：

```
GET https://platform.deepseek.com/api/v0/usage/cost?month=M&year=Y      → 该月消费
GET https://platform.deepseek.com/api/v0/usage/amount?month=M&year=Y    → 该月 token 与请求数
```

**开启步骤**

1. 浏览器登录 `https://platform.deepseek.com/usage`
2. **F12 → Network**，筛选 `api/v0`，刷新页面
3. 点任意一条 `usage/…` 请求 → **Headers → Request Headers**，复制 **`Authorization`** 的值（形如 `Bearer Y2w1…`）
4. 让 Harness 保存它。**推荐走文件**：把值（可含 `Bearer ` 前缀，脚本会自动剥掉）写进一个临时文件，终端完全不参与，因此不受任何粘贴行为影响：

   ```powershell
   # 用记事本写：notepad .token.tmp   —— 粘贴要保存的值，保存后关闭
   node "F:\DSH Plugins\packages\dsh-quota-card\tools\set-platform-token.mjs" --from-file "F:\DSH Plugins\.token.tmp"
   Remove-Item -LiteralPath "F:\DSH Plugins\.token.tmp" -Force
   ```

   期望输出 `stored : Y2w1Y5****prVh`（6 位前缀 + `****` + 4 位后缀）。`.token*` 已在 `.gitignore` 里，不会被误提交。

   另两种入口：

   ```powershell
   # 静默提示（终端会把粘贴交给程序时可用；写库前会校验长度与字符集）
   node "F:\DSH Plugins\packages\dsh-quota-card\tools\set-platform-token.mjs" --prompt

   # 环境变量（脚本化场景）
   $env:DEEPSEEK_USER_TOKEN = 'Bearer …'
   node "F:\DSH Plugins\packages\dsh-quota-card\tools\set-platform-token.mjs"
   Remove-Item Env:\DEEPSEEK_USER_TOKEN -ErrorAction SilentlyContinue
   ```

   或者直接在 Harness 页面控制台里 POST（只回显遮蔽片段）：

   ```js
   await (await fetch('/quota-card/token', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ token: 'Bearer …' }),
   })).json()
   ```

   > **不要用 `Read-Host -AsSecureString`**：PowerShell 在 SecureString 提示里会把**粘贴的多字符内容截成 1 个字符**；部分终端还会把粘贴送给 shell 提示符而不是程序（表现为 `Bearer : The term ... is not recognized`）。这两种情况都会静默存进一个无效 token，之后所有扫描都以 `auth-failed` 结束，看起来像"token 过期"。细节见文末[排障笔记](#排障笔记这个接口真实存在的九个坑)第 8、9 条。

5. 在插件 `cordis.patch.yml` 里把 `platformHistory` 改成 `true`，重启 Harness
6. 用 `--check-only` 确认扫描状态：

   ```powershell
   node "F:\DSH Plugins\packages\dsh-quota-card\tools\set-platform-token.mjs" --check-only
   ```

**注意**

- 该 token 是**可复用的控制台会话凭据**，与推理 API Key 是两种东西（实测：API Key 与 DSH 账号凭据都被控制台拒绝，只有这个 token 被接受）
- 它由 DSH 凭据服务保管（`ctx.credentials`，键名 `DEEPSEEK_USER_TOKEN`）；也可以用同名环境变量覆盖
- 写入前会做**合理性校验**（长度 16–4096、不含空白）：`PASTE` 这类占位符或整条命令行会被拒绝，不会让后续扫描以「认证失败」掩盖真实原因
- **「累计用量」显示的是计费 token**（总和 − 缓存读取）。缓存读取占原始总和约 98%，却只按 cache-miss 的约 2% 计价，直接显示总和会让「用量」与「消费」严重不成比例；悬停可看「计费 / 缓存读取 / 总和」三层明细
- `/quota-card/token` 是**唯一会写入的路由**：只接受回环地址且**非跨站**的请求（用 `Sec-Fetch-Site` 防 DNS-rebinding），写完后只回显遮蔽片段，绝不回显 token 本身
- **这些接口是未公开的**，DeepSeek 改版即可能失效。失效时 `snapshot.platform` 整体缺失，卡片**静默退回**本地账本口径 —— 余额、今日/本月、峰谷判定永远不受影响
- 扫描为逐月请求，最多 48 个月（可配），连续 3 个零消费月提前停止；结果缓存 10 分钟并落盘 `$DSH_HOME/quota-card/platform.json`，重启后立刻可见
- 扫描失败会记成**具名原因**（`auth-failed` / `http-429` / `failed:2026-07:TimeoutError`）：`/quota-card/health` 的 `platform.history.lastError` 与 `lastFailure` 能直接指出哪个月、什么原因，而不是只给一个失败计数

### 卡片高度可拖动

卡片底部有一条细手柄：**上下拖动**调整卡片高度（90–680px），松手后大小存在浏览器本地、刷新后保持；**双击手柄**恢复「自适应内容高度」。高度不足时卡片内部自动出现滚动条，不会把行挤掉。自适应模式下卡片还会自动避开窗口底部，不会长到被侧边栏裁掉。

### 用量口径 —— 计费 token 还是 token 总量

缓存命中率高的账户里，**缓存读取会占 token 总数的 98% 以上**，而它只按 cache-miss 的约 2% 计价。所以「token 总量」和「花了多少钱」几乎是两个独立的量：同一个账户可能显示「4.34B tokens / ¥297」，按总量看贵得离谱，按计费量看只有约 6360 万。

卡片因此提供**两种口径，且三行（今日 / 本月 / 累计）永远用同一种**，避免并排的数字互相不可比：

| 口径 | 含义 | 适合看什么 |
| --- | --- | --- |
| **计费 token**（`¥`，默认） | `未命中缓存 + 缓存写入 + 输出`，即真正按 token 计费的部分 | 「花了多少钱、烧了多少计费量」 |
| **token 总量**（`Σ`） | `计费 + 缓存读取`，即上下文实际处理过的量 | 「对话有多长、上下文规模」 |

切换方式：

- 卡片标题栏的 **`¥ / Σ`** 按钮（写入浏览器本地，刷新后保持）
- 或默认值 `showTotalTokens: false | true`

`缓存命中` 那一行与口径无关，始终是 `cacheRead ÷ (未命中 + 缓存读取 + 缓存写入)`。

### 今日 / 本月用量、缓存命中 —— 本地账本

今日与本月这两个数字**始终**来自 DSH 自己的链路：Host 侧挂 `llm/stream` waterfall，读每次模型调用 provider 实报的 `usage`。这是刻意选择 —— 它零凭据、零私有接口、每笔调用都精确。

- `inputTokens` = **未命中缓存的输入**（DSH 的 `TokenUsage` 明确说明各类计数互不重叠）
- `cacheReadTokens` = 命中缓存读取，`cacheWriteTokens` = 缓存写入，`outputTokens` = 输出
- 按**北京时间**自然日落桶，`今日` = 当日桶，`本月` = 当月所有桶之和

**口径**
- 「缓存命中」= `cacheRead ÷ (input + cacheRead + cacheWrite)`
- 「用量」按上面的**用量口径**取计费量或总量
- 会话标题、压缩等辅助调用的 `purpose` 会**单独打标**存进 `days[date].byPurpose`，便于排查；但**仍然计入**今日/本月总量（它们确实花了 token）。如果你希望只统计对话用量，可以基于该字段扩展。

**已知边界**
- 只统计经过本 Harness 的调用；其它客户端/网页端产生的用量不在其中（要看账号全量请开 `platformHistory`）
- 「累计消费 / 累计用量」默认就是这个账本的区间（自安装起）；开启 `platformHistory` 后才切换为账号历史
- 账本落盘在 `$DSH_HOME/quota-card/usage.json`：原子写（临时文件 + rename）、5 秒节流 + **尾部补偿写入**（一波请求结束后仍会落盘一次）、保留 400 天
- 文件损坏时改名隔离（`.corrupt-<时间戳>`）后从空账本继续；若连隔离都失败，插件会**拒绝写盘**并在内存里继续工作，以免用空账本覆盖真实数据。写盘失败一律降级为纯内存账本，绝不影响模型调用
- 落盘发生在启动时首次读取**之后**，且读入的数据与读入期间已记录的调用会**合并**而不是互相覆盖

### 峰谷判定 —— 官方规则（含节假日）

官方定价页原文：

> Off-peak rates are half of the peak rates. Peak hours are **01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays**. All other hours are off-peak, **including weekends and Chinese public holidays in full**.
> — <https://api-docs.deepseek.com/quick_start/pricing>

UTC 01:00–04:00 / 06:00–10:00 即北京时间 **09:00–12:00 / 14:00–18:00**，周一至周五。注意 12:00–14:00 是空闲。

`lib/holidays.js` 内置 **2026 年**法定节假日（33 天，来源：国务院办公厅关于2026年部分节假日安排的通知，国办发明电〔2025〕7号，<https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>）与 6 个调休上班日。两张表都是 `{ "YYYY": ["MM-DD", …] }` 的**扁平**结构——`lib/config.js` 会把它和用户配置一起过同一个归一化函数，所以无论哪一层提供，`config.holidays` 的形状都一致。每年 11 月国务院公布次年安排后更新该文件（或直接在插件 `config.holidays` 里覆盖）；**当年份缺表时规则退化为"仅按周一至周五"**，卡片底部显示「节假日表：未知」，并且**不会把上一年的日期套到新的一年**（跨年时 Host 与卡片给出一致的判定）。

---

## 架构

| 端 | 文件 | 作用 |
| --- | --- | --- |
| Host | `lib/index.js` | 软探针接入 `llm`（用量 tap）与 `webServer`（路由）；代理官方余额接口；输出 `GET /quota-card/snapshot`、`GET /quota-card/health` |
| Host | `lib/config.js` | 配置归一化（零依赖纯函数） |
| Host | `lib/pricing.js` | 峰谷判定、价目表、费用估算、格式化（零依赖纯函数） |
| Host | `lib/holidays.js` | 法定节假日 / 调休表（纯数据） |
| Host | `lib/ledger.js` | 按日/模型/档位记账 + 原子落盘 + 容量裁剪 |
| Client | `lib/client.js` | 注册 `sidebar.footer.action`；渲染卡片；60 秒轮询 + 5 秒本地倒计时 |

```
Browser ──fetch /quota-card/snapshot──▶ Host route ─┬─ 本地账本（llm/stream 采集）
                                                   └─ api.deepseek.com/user/balance（Key 留在 Host）
```

浏览器侧只读同源路由，不做任何鉴权、不接触凭据；Host 侧路由为 `kind: 'exact'` 且只响应精确路径。

### Authoring contract（本插件依据的 DSH 插件契约）

- `package.json`：`type: module`、`main`/`exports["."]` 指 Host 半部分、`exports["./client"]` 指浏览器 bundle、`dsh.bundle.patch` 指本包补丁、`dsh.client.platform: "web"`、`dsh.client.inject` 列出提供 `slots`/`locale` 服务并声明该槽位的客户端包
- `cordis.patch.yml`：顶层 YAML 数组，`- insert: [{ id, name, config }]`
- Host 半部分：ESM，`apply(ctx, config)`；可选服务一律 `ctx.inject([name], child => child.effect(...))` 软探针，清理用 `ctx.effect(() => disposer, label)`
- 浏览器 bundle：`window.__ModuleLoader__.load({ id, factory })`，`module.exports = { apply(ctx), inject: ['slots','locale'] }`；组件用 `require('react').createElement`（无 JSX、无构建）
- 槽位：`slots.inject(key, () => slots.register({ name, id, order, locale }, props => element))`

参考实现（本插件的契约来源）：[Choi-Peng/dsh-deepseek-balance](https://github.com/Choi-Peng/dsh-deepseek-balance)、[Daniel92Q/dsh-sidebar-footer-stack](https://github.com/Daniel92Q/dsh-sidebar-footer-stack)。

---

## 验证

在本目录（`packages/dsh-quota-card`）下执行：

```bash
# 纯逻辑测试（无需 Host、无需浏览器、无网络）
node --test test/logic.test.mjs

# 语法检查（无输出即通过）
node --check lib/client.js
node --check lib/index.js

# Host 半部分可被 bare Node 干净导入（验证"零第三方 import"这一硬性约束）
node --input-type=module -e "import('./lib/index.js').then(m => console.log(m.name, typeof m.apply))"
```

安装后还可以在 Harness 页面里自检（浏览器控制台）：

```js
await (await fetch('/quota-card/health', { cache: 'no-store' })).json()
await (await fetch('/quota-card/snapshot', { cache: 'no-store' })).json()
```

`health` 里的 `counters.usageBlocks` 会随对话增长（用量采集生效），`balance` 会告诉你余额走的是账号还是 API Key。

> Node 24 上 `node --test <目录>` 会把目录当模块解析并报 `Cannot find module`，所以这里直接指向测试文件。
> 在 PowerShell 里请**分行**执行，多行粘贴会被当成续行、合并成一条命令。

牌面上的东西是否真的到位，看这三处即可：卡片出现在 Settings 上方（槽位与整宽堆叠生效）、`/quota-card/health` 的 `counters.usageBlocks` 随对话增长（用量 tap 生效）、`balance.balance` 与官网余额一致（凭据链路生效）。

---

## 已知限制

1. 用量历史从安装开始累计，不回溯；跨设备/网页端的用量不计入。
2. 「本月用量」在月初第一天等于当天累计，属预期行为。
3. 费用行是**估算**：按每笔请求发生时的档位计价，价目表需随官方调价更新（2026-08、2026-09 各调过一次）；模型名以最长前缀匹配价目表，未精确命中时该行带 `*` 标记。官方账单以控制台为准。
4. 法定节假日表需要每年 11 月更新一次。
5. 卡片仅在侧边栏展开时显示；窄条状态不显示任何数字。

---

## 排障笔记：这个接口真实存在的九个坑

以下每一条都是在本插件开发过程中**实际踩到并修掉**的，症状与根因都保留了第一手记录。它们不是假想风险 —— 如果你要自己改这个插件、或写另一个接同样接口的插件，这几条能省掉大量时间。

### 1. 控制台接口不认 API Key，也不认 DSH 账号凭据

**症状**：`GET /api/v0/usage/cost` 返回 HTTP 200 + `{"code":40003,"msg":"Authorization Failed (invalid token)"}`。

**根因**：该接口要的是**网页登录态 token**（`platform.deepseek.com` 页面发出的 `Authorization: Bearer …`），与推理 API Key、与 DSH 凭据库里 `deepseek-account-platform/default` 的 grant 都是不同签发方。两种写法（`Bearer xxx` 与裸 `Authorization: xxx`）都试过，都被拒。

**做法**：只认页面实际使用的那种 token；插件把它存进 DSH 凭据服务，键名 `DEEPSEEK_USER_TOKEN`。

### 2. 缺浏览器形态的请求头也会被拒

**症状**：即使 token 正确，仍返回 40003 或空响应。

**根因**：控制台请求带着 `User-Agent`（Chrome）与 `Referer: https://platform.deepseek.com/usage`，接口会校验。

**做法**：`platformRequestHeaders()` 始终带上这两项。

### 3. 两个端点的 `biz_data` 形状不同

**症状**：token 统计正确，消费恒为 0。

**根因**：实测

```
usage/cost   → data.biz_data 是【数组】: [{ total, days, currency }]
usage/amount → data.biz_data 是【对象】: { total, days }
```

只按其中一种解析，另一个必然静默归零。

**做法**：`costRecord()` 同时兼容数组与对象。

### 4. `billed` 必须用加法算，不能用减法

**症状**：计费 token 与金额严重不成比例。

**根因**：`billed = tokens − cacheHits` 这种减法**默认「缓存读取占大头」**。但控制台里还报了一个 `PROMPT_TOKEN` 桶（实测 1.44 亿），减法会把它一起算进计费量。

**做法**：改为**按类型累加**（跳过 `PROMPT_CACHE_HIT_TOKEN`），不依赖任何"占比假设"。

### 5. 缓存读取占总量 98%，但只按 2% 计价 → 必须区分口径

**症状**：卡片显示「4.34B tokens / ¥296」，按总量看贵得离谱。

**根因**：缓存读取（`PROMPT_CACHE_HIT_TOKEN`）占了 token 总数的约 98%，而它只按 cache-miss 的约 2% 计价。官方口径里没计费含混 —— 输入只分**命中**与**未命中**两类。

**做法**：卡片提供两种口径（`¥` 计费 / `Σ` 总量），且**今日/本月/累计三行永远同口径**，避免并排数字互不可比。

### 6. 缓存 schema 演进：旧 payload 必须拒收重扫

**症状**：新版本上线后，「累计用量」显示原始总和（4.26B）而不是计费量，且 `scans: 0`。

**根因**：落盘的 `platform.json` 是**旧版本**写的，缺 `billed`/`cacheHits` 字段；`seed()` 原样读回，新客户端拿不到 `billed` 就退回显示 `tokens`。而且缓存"新鲜"（TTL 内）导致根本不会重扫。

**做法**：`historyPayloadComplete()` 校验必需字段，不合格就**拒收**并让下次刷新重扫；计数 `refusedSeed` 记录拒了几次，避免静默。

### 7. 凭据文件是分层块结构，`payload:` 不能当记录头

**症状**：解析 `.credentials.yaml` 取平台 token 时，token 行明明存在（64 字符）却返回 `null`。

**根因**：原实现按「缩进是否回到基级」判断记录边界：

```yaml
records:
  deepseek-account-platform/default:   # 记录头（缩进 2）
    kind: grant                        # 缩进 4
    payload:                           # ← 缩进 4，被误判为新记录头
      token: <64 字符>                  # 于是这一行被跳过
```

**做法**：改为**按缩进栈追踪完整路径**，只在 `records → deepseek-account-platform/* → payload → token` 这条路径上取值 —— 这也顺带保证 `refs:` 里的 API Key 永远不会被误取。

### 8. `Read-Host -AsSecureString` 会把粘贴截成 1 个字符

**症状**：输入后 `captured length = 1`；若没校验，就会**静默存进一个无效 token**，之后所有扫描都以 `auth-failed` 结束，看起来像"token 过期"。

**根因**：PowerShell 在 SecureString 提示里把粘贴的多字符内容当成单个安全字符处理。

**做法**：不要用它。插件提供 `--from-file`（最可靠，终端完全不参与）与环境变量两种入口，并在写入前校验长度 ≥16、无空白。

### 9. 有些终端会把粘贴送给 shell 而不是程序

**症状**：运行 `--prompt` 后，`Bearer Y2w1…` 出现在 PowerShell 提示符上并报 `The term 'Bearer' is not recognized`，程序只收到 1 个字符。

**根因**：该终端的粘贴事件没有进入程序的标准输入，而是被 shell 抢先解释。

**做法**：`--from-file <path>` —— 把值写进文件再让脚本读，完全绕开终端输入系统；脚本读完后会提示你立即删除该文件。

### 附：诊断入口

装好之后，这两个命令能回答绝大多数"数字不对"的问题：

```powershell
# 扫描状态：凭据是否就位、扫了几个月、失败原因、两种口径的合计
node tools/set-platform-token.mjs --check-only

# 接口实测：结构大纲 + 本包解析结果 + 逐月消费轮廓（从不打印凭据）
node tools/probe-platform-usage.mjs --year 2026 --month 9 --scan 6
```

`/quota-card/health` 的 `platform.history` 里有 `scans` / `failures` / `requestFailures` / `lastError` / `lastFailure` / `refusedSeed`，以及 `billedTokens` 与 `rawTokens`。

## License

MIT
