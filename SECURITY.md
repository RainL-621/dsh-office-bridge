# SECURITY — dsh-office-bridge

版本 2.1.0。本插件面向**单机本地使用**（DSH Desktop + 本机 ONLYOFFICE Document Server），
安全模型围绕「本机回环 + 白名单」设计，不适用于直接暴露到局域网/公网的场景。

## 攻击面与对策

| 攻击面 | 对策 |
|---|---|
| 本地桥接服务（127.0.0.1:<bridgePort>）被非本机进程访问 | 仅绑定 `127.0.0.1`，并校验 `request.socket.remoteAddress` 为回环地址，否则 403。 |
| 伪造 `/download/:fileKey` 拉取任意文件 | `fileKey` 是进程内随机 hex，必须附带 `?token=`，token 为 `HMAC-SHA256(进程级随机密钥, absPath:mtimeMs)`，进程重启即失效；下载侧还有 `fileLimitMb` 体积上限。 |
| 会话越权（拿别人的 session 打开任意路径） | 打开文件必须提供有效 `sessionId`，文件 realpath 必须落在该 session 工作区内，越界 403（`FILE_OUT_OF_SCOPE`）。 |
| 回调 SSRF / 恶意写回来源 | `callback body.url` 必须为 http(s) 且以配置的 `dsBaseUrl`（默认 `http://127.0.0.1`）开头，否则 403 并记日志（拒绝原因含原始 url）。 |
| 写回破坏原文件 | 写回先在同目录生成 `<文件名>.<ext>.bak`（覆盖旧 bak，失败仅记日志不阻塞），再经临时文件 + rename 落盘。 |
| 外部改动冲掉用户未保存的编辑 | 不做自动重载：磁盘变化只显示横幅 + 「重新加载」按钮，用户点了才刷新。 |
| 超大文件 | `fileLimitMb`（默认 100）：download 侧拒绝下发（403）；callback 侧拒绝写回但回 `error:0` 防 DS 重试风暴。 |
| 浏览器侧接口被未登录页面访问 | webServer 路由全部过 DSH `connection.requestRejection` 栅栏，未认证请求直接拒绝。 |

## 已知取舍

- `fileKey`/`urlToken` 仅存在于进程内存（registry.json 只恢复 fileKey→路径映射，token 每次按当前
  进程密钥重算），不做跨进程持久防伪——本机单用户场景下可接受。
- `dsBaseUrl` 默认 `http://127.0.0.1`（限域前缀），若把 ONLYOFFICE DS 部署到其他地址，
  务必把 `dsBaseUrl` 配成该地址，否则写回会被 403 拒绝（这是有意为之的失败关闭）。
- `.bak` 文件与原文件同目录，继承原目录权限；不额外加密。**只保留最近一次**：再保存即覆盖上一份
  `.bak`，因此它防的是「这一次写坏了」，不是「改错了想回滚到三天前」——长期版本请用你自己的
  版本管理。
- 编辑器不做自动重载：磁盘变化只弹横幅，等用户点「重新加载」。这是安全取舍而非缺陷——ONLYOFFICE
  的 `onDocumentStateChange` 上报不稳定（同一操作时而触发时而静默），若据此自动刷新，会在用户
  不知情时丢掉未保存的编辑（2026-10-28 实测复现）。
- DSH 重启期间无法接收 ONLYOFFICE 的保存回调（回调端口随宿主进程消失），未保存的编辑会丢失
  （DS 侧日志 `commandSfcCallback backoff limit exceeded` → `storeForgotten`）。重启前先关闭文档
  标签页。
- JWT secret 自动探测读取 DS `local.json`（本机管理员可读文件），未做额外加固。
