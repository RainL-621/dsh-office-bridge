# dsh-office-bridge

English | [简体中文](README.zh-CN.md)

> 中文简介：你和 AI 智能体在 DSH 侧边栏里编辑同一个 Office 文件，保存直接写回原文件——不上传、不转格式。完整中文文档见 [README.zh-CN.md](README.zh-CN.md)。

**You and your AI agent edit the same Office file in the DSH sidebar — ONLYOFFICE
does the heavy lifting, saves land back on the original file, no uploading files
around.**

- Supported formats: `.xlsx` / `.xls` / `.csv` / `.tsv` / `.docx` / `.pptx`
- Platform: sidebar plugin for **DSH Desktop (Windows)**
- License: **MIT** (this plugin). The editing engine, ONLYOFFICE Document
  Server, is a separate product under **AGPLv3 / commercial dual licensing —
  you install it yourself and accept its license yourself**.
- Zero runtime dependencies. Source is the artifact; no build step.

> **The editing engine is not part of this plugin.** This plugin is an
> MIT-licensed, zero-dependency integration layer and contains **no ONLYOFFICE
> Document Server code**. You must download and install ONLYOFFICE Document
> Server for Windows yourself (installer is about 873 MB), and read and accept
> its AGPLv3 or commercial license terms before installing.

---

## What it does

Click an Office file in a DSH session and the right sidebar opens an ONLYOFFICE
editor tab:

- **Original-format edit and write-back** — no shadow files, no format
  conversion. The file you edit is the file on disk.
- **Disk changes always ask first** — when the file changes on disk (for
  example by an AI agent or a script), the editor shows a banner instead of
  reloading by itself: "The file was modified on disk (possibly by AI)" with a
  Reload button. Your unsaved edits are never thrown away without you clicking
  it. This is deliberate — ONLYOFFICE does not report edit state reliably
  enough to distinguish "you have unsaved work" from "you do not".
- **Backup before write-back** — every save keeps the previous version as
  `filename.ext.bak` in the same directory.
- **Security hardening** — write-back URLs are restricted to the configured
  DS address (loopback by default); `fileLimitMb` size cap (default 100 MB);
  the local exchange service binds to 127.0.0.1 only; HMAC token validation on
  download URLs. See `SECURITY.md`.
- **Session persistence** — opened files are recorded in registry.json (max
  128 entries) and restored after a DSH restart.

### ⚠️ Write-back behavior (read this)

- **Save timing**: ONLYOFFICE sends the content back when you **close the
  document tab** (or save manually); this plugin then writes the file.
- **Whole-file overwrite**: write-back **replaces the entire file**. No merge.
- **Automatic .bak**: each write-back first stores the old version as
  `filename.ext.bak` in the same directory. **Only the most recent previous
  version is kept** — a second save overwrites it.
- **Close the tab before restarting DSH.** Unsave content lives in the
  ONLYOFFICE server and reaches this plugin by callback. If DSH is restarting,
  the callback has nowhere to land and the edit is lost (the server retries
  briefly, then gives up with `backoff limit exceeded`). Save/close first.
- **Keep your own backups or version control for important files.** The risk
  of write-back overwrite is the user's own.

## Prerequisites

1. **DSH Desktop (Windows)** — this is a DSH Desktop sidebar plugin.
2. **ONLYOFFICE Document Server (Windows)**:
   - Download and install the Windows package from the ONLYOFFICE website
     (about 873 MB);
   - After install, `http://localhost/healthcheck` should return
     `{"error":false}`;
   - It is licensed AGPLv3 / commercial dual licensing. **Installing it and
     accepting its license are your own decision and responsibility**;
   - Default address `http://127.0.0.1:80`; if your port differs, see the
     configuration table.
3. Put this package into the DSH desktop profile
   (`profiles/desktop/node_modules/dsh-office-bridge/`), add
   `"dsh-office-bridge"` to `dsh.profile.bundles` in the profile
   `package.json`, and restart DSH Desktop.

### JWT configuration

When DS enables JWT, the plugin **auto-detects** the secret from DS's
`C:\Program Files\ONLYOFFICE\DocumentServer\config\local.json`
(zero-dependency HS256 implementation, cached on file mtime). If detection
fails, tokens are omitted. You can also set `dsSecret` manually.

## Configuration (profile config, all optional)

| Key | Default | Description |
|---|---|---|
| `office-bridge.dsBaseUrl` | `http://127.0.0.1:80` | DS address (also the base of the write-back URL allow-list); change if port 80 is taken |
| `office-bridge.bridgePort` | `17890` | Local file-exchange port; auto +1 retry up to 10 times if taken |
| `office-bridge.dsSecret` | auto-detect | Manual JWT secret |
| `office-bridge.lang` | `zh-CN` | Editor language; fallback chain zh-CN → zh → en |
| `office-bridge.defaultMode` | `edit` | `edit` (editable) / `view` (read-only preview) |
| `office-bridge.fileLimitMb` | `100` | File size limit (oversize refuses download / write-back) |

## Troubleshooting

- `GET /office-bridge/api/health` — `dsReachable`, actual `bridgePort`, `jwt`
  status, version.
- `GET /office-bridge/api/config` — effective configuration.
- If the editor page fails to load, the page title gets an `ERR-` prefix. If
  the sidebar shows "cannot open editor", check that DS is running, then retry.

## Difference from dsh-sidebar-onlyoffice

The community also has `dsh-sidebar-onlyoffice` (a plugin for dsh web
deployments). This project targets **DSH Desktop**: files are on local disk,
edits write straight back to the original file, no upload/download step, plus
disk-change banners, .bak backups, and registry session restore.
If you run dsh as a web service, use that project instead.

## License and trademarks

- This plugin is released under **MIT** (see `LICENSE`) and contains no source
  code from ONLYOFFICE Document Server.
- **ONLYOFFICE is a trademark of Ascensio System SIA.** This project is not
  affiliated with, or endorsed by, ONLYOFFICE / Ascensio System SIA.
- No telemetry: this plugin collects and uploads nothing. All communication
  stays between local processes.

## Disclaimer

This software is provided "as is" (MIT License, sections 3–6). **Write-back
overwrites the original file.** Despite the .bak mechanism, keep your own
backups and version control for important documents. Any data loss or damage
caused by using this software is at the user's own risk.

## Contributing

Source is the artifact (direct ESM, zero build, zero runtime dependencies).
Issues and PRs are welcome. After changing `host/index.js` or
`dist/client.js`, run `node --test test/smoke.test.mjs` and keep the security
boundary documented in `SECURITY.md`.
