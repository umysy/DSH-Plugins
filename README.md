# DSH Plugins

[![test](https://github.com/umysy/DSH-Plugins/actions/workflows/test.yml/badge.svg)](https://github.com/umysy/DSH-Plugins/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件集合。

| 插件 | 作用 | 平台 |
| --- | --- | --- |
| [`dsh-quota-card`](packages/dsh-quota-card/) | 侧边栏左下角常驻卡片：余额 / 今日用量 / 本月用量 / 缓存命中 / 峰谷时段与价格倍率，可选读取开放平台账号历史（累计消费 / 累计用量），高度可拖拽 | Web（桌面端 / `dsh web`） |

---

## 安装

每个子目录都是一个**独立的 DSH bundle 包**。安装 = 把它挂到某个 profile 上。

### 方式一：命令行（`dsh web`）

```bash
# 跟随 main（总拿最新）
dsh plugin --profile web add "github:umysy/DSH-Plugins"

# 固定版本（推荐给正式使用）
dsh plugin --profile web add "github:umysy/DSH-Plugins#v0.3.1"
```

装完**重启 Harness**（插件发现按进程缓存），刷新页面即可。

> 固定版本的 tag 见 [Releases](https://github.com/umysy/DSH-Plugins/releases)。`v0.2.0`、`v0.3.0`、`v0.3.1` 均可用于 `#<tag>` 形式。

### 方式二：桌面端 App

官方桌面端独占 `desktop` profile，命令行的 `--profile desktop` 会被拒绝。走 App 内：

`设置 → 插件 → 添加插件`，source 填：

```
github:umysy/DSH-Plugins
```

### 方式三：本地克隆（开发用）

```bash
git clone https://github.com/umysy/DSH-Plugins
dsh plugin --profile web add "file:/绝对路径/DSH-Plugins"
```

> 说明：这些包都是**纯 JavaScript、无构建步骤**，源码即产物，因此不需要 `pnpm build`，也不会被包管理器的构建脚本门挡住。

### 卸载

```bash
dsh plugin --profile web remove <包名>
```

---

## 通用约定

本仓库里的插件遵循同一套约定，也正因为如此才能「装上就能用」：

- **双面（dual-face）Cordis 插件**：`lib/index.js` 是 Host 半部分（调服务、持有凭据、注册 HTTP 路由），`lib/client.js` 是浏览器 bundle（渲染 UI，只读同源接口）
- **零第三方 import**：Host 半部分只用 `node:` 内置模块和包内相对导入，因此不依赖 profile 的依赖树，能被 bare Node 直接 import 校验
- **软探针**：所有可选服务都通过 `ctx.inject([name], child => child.effect(...))` 接入，宿主缺哪个服务都照常启动，不会把插件树卡在 pending
- **失败不外溢**：模型调用路径上的任何记账、IO、网络失败都只记日志，绝不影响宿主
- **无构建**：只用 ES5 + 平台 API 写浏览器半边（`window.__ModuleLoader__.load({ id, factory })`，`require('react')`），不需要 JSX 编译

## 新增一个插件

1. 复制现有插件的骨架到 `packages/<你的插件名>/`：
   - `package.json`（`type: module`、`exports` 里 `"."` 指 Host、`"./client"` 指浏览器半边、`dsh.bundle.patch`、`dsh.client.platform`）
   - `cordis.patch.yml`（顶层数组：`- insert: [{ id, name, config }]`）
   - `lib/index.js`、`lib/client.js`
2. 在本 README 的表格里加一行。
3. 自测（无需宿主）：

```bash
node --check packages/<你的插件名>/lib/client.js
node --input-type=module -e "import('./packages/<你的插件名>/lib/index.js').then(m => console.log(m.name))"
node --test packages/<你的插件名>/test/logic.test.mjs
```

## 许可

MIT，见 [LICENSE](LICENSE)。各插件目录内不再单独放许可证文件。
