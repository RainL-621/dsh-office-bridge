# dsh-office-bridge

[English](README.md) | 简体中文

**在 DSH Desktop 侧边栏里，用本机安装的 ONLYOFFICE Document Server 直接打开并编辑
Office 文件，保存写回原文件。**

- 支持格式：`.xlsx` / `.xls` / `.csv` / `.tsv` / `.docx` / `.pptx`
- 运行平台：**DSH Desktop（Windows）** 侧边栏插件
- 许可证：**MIT**（本插件）；编辑引擎 ONLYOFFICE Document Server 为独立产品，**AGPLv3 / 商业双授权，需自行安装并自行确认许可接受**
- 零运行时依赖，源码即发布物，无构建步骤

> **编辑引擎不是本插件的一部分。** 本插件只是一个 MIT 零依赖的集成层，**不含
> ONLYOFFICE Document Server 的任何代码**。你必须自行下载安装 ONLYOFFICE
> Document Server（Windows 版安装包约 873MB），并在安装前自行阅读并接受其
> AGPLv3 或商业许可条款。

---

## 它能做什么

在 DSH 会话里点开一个 Office 文件，DSH 右侧边栏会打开 ONLYOFFICE 编辑器标签页：

- **原格式编辑、原文件写回** —— 没有影子文件、没有格式转换，编辑的就是磁盘上那个文件。
- **磁盘改动一律先问**：文件被外部（例如 AI 智能体、脚本）改动时，编辑器**不会自动刷新**，而是弹出横幅「文件已在磁盘上被修改（可能是 AI）」+「重新加载」按钮。你未保存的修改绝不会在你没点按钮的情况下被丢掉。这是刻意的设计：ONLYOFFICE 上报的编辑状态不可靠，分不清你有没有未保存内容。
- **写回备份**：每次保存写回前，自动在原文件同目录留一份 `文件名.扩展名.bak`（保存前的版本）。
- **安全加固**：写回 URL 限域（仅接受本机 DS 地址）、`fileLimitMb` 体积上限（默认 100MB）、本地服务仅绑定 127.0.0.1、HMAC token 校验。详见 `SECURITY.md`。
- **会话记忆**：打开过的文件记录持久化在 registry.json（最多 128 条），DSH 重启后可恢复。

### ⚠️ 写回行为（务必阅读）

- **保存时机**：ONLYOFFICE 在你**关闭文档标签页**（或手动保存）时才把内容回传，由本插件写回原文件。
- **整文件覆盖**：写回是**整个文件覆盖**原文件，不做增量合并。
- **自动留 .bak**：每次写回前会把旧版本存为同目录 `文件名.扩展名.bak`。**只保留最近一次**，再保存就会覆盖上一份。
- **重启 DSH 前先关标签**：未保存的内容在 ONLYOFFICE 服务端，靠回调送到本插件。DSH 正在重启时回调无处落地，这次编辑就丢了（服务端重试几次后放弃，日志 `backoff limit exceeded`）。请先保存/关闭。
- **重要文件请自行再做版本管理或备份**，写回覆盖的风险由使用者自担。

## 安装前置条件

1. **DSH Desktop（Windows）**：本插件是 DSH Desktop 的侧边栏插件。
2. **ONLYOFFICE Document Server（Windows 版）**：
   - 从 ONLYOFFICE 官网下载 Windows 安装包（约 873MB）并安装；
   - 安装后访问 `http://localhost/healthcheck` 应返回 `{"error":false}`；
   - 其许可为 AGPLv3 / 商业双授权，**是否安装、是否接受许可是你自己的决定与责任**；
   - 默认地址 `http://127.0.0.1:80`，若端口不同见下方配置。
3. 把本包放入 DSH desktop profile（`profiles/desktop/node_modules/dsh-office-bridge/`）并在 profile `package.json` 的 `dsh.profile.bundles` 加入 `"dsh-office-bridge"`，重启 DSH Desktop。

### JWT 配置

DS 启用 JWT 时，插件会**自动探测** DS 的
`C:\Program Files\ONLYOFFICE\DocumentServer\config\local.json` 中的 secret
（HS256 零依赖自实现，按文件 mtime 缓存）；探测不到则省略 token。
也可在配置里手动指定 `dsSecret`。

## 配置项（profile 配置，均可省略）

| 键 | 默认 | 说明 |
|---|---|---|
| `office-bridge.dsBaseUrl` | `http://127.0.0.1:80` | DS 地址（也是写回 URL 白名单的基准）；80 被占时改这里 |
| `office-bridge.bridgePort` | `17890` | 本地文件交换端口，被占自动 +1 重试至多 10 次 |
| `office-bridge.dsSecret` | 自动探测 | 手动指定 JWT secret |
| `office-bridge.lang` | `zh-CN` | 编辑器语言，降级链 zh-CN → zh → en |
| `office-bridge.defaultMode` | `edit` | `edit` 可编辑 / `view` 只读预览 |
| `office-bridge.fileLimitMb` | `100` | 文件体积上限（超过拒绝下发/写回） |

## 排查

- `GET /office-bridge/api/health` — `dsReachable`、实际 `bridgePort`、`jwt` 状态、版本号。
- `GET /office-bridge/api/config` — 当前生效配置。
- 编辑器页加载失败时页面标题带 `ERR-` 前缀；侧边栏报「无法打开编辑器」先确认 DS 已启动，再点重试。

## 与 dsh-sidebar-onlyoffice 的差异

社区另有 `dsh-sidebar-onlyoffice`（dsh web 形态插件）。本项目面向 **DSH Desktop
（本地桌面端）**：文件在本地磁盘，编辑直接写回原文件，无需上传下载；本项目额外提供
磁盘改动横幅、.bak 备份与 registry 会话恢复。若你在纯 web 形态使用 dsh，请用后者。

## 许可与商标

- 本插件以 **MIT** 发布（见 `LICENSE`），不包含 ONLYOFFICE Document Server 的任何源代码。
- **ONLYOFFICE 是 Ascensio System SIA 的商标**。本项目与 ONLYOFFICE / Ascensio System SIA 无 affiliation，也未经其认可。
- 无遥测：本插件不收集、不上传任何数据；所有通信仅发生在本机进程之间。

## 免责声明

本软件按「现状」提供（MIT 许可第 3-6 条）。**写回行为会覆盖原文件**，尽管有 .bak
备份机制，对重要文档请自行做好备份与版本管理；因使用本软件导致的任何数据丢失或
损坏，风险由使用者自担。

## 贡献

源码即发布物（ESM 直出、零构建、零运行时依赖），欢迎 issue 与 PR：
改动 `host/index.js` / `dist/client.js` 后请跑 `node --test test/smoke.test.mjs`，
并保持 `SECURITY.md` 中的安全边界。
