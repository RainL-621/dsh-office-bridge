// dsh-office-bridge v2.1 — host entry (OnlyOffice Document Server route).
// The v1 Univer shadow-file path is retired. v2 bridges original office files
// straight into a locally installed ONLYOFFICE Document Server:
//   - webServer prefix routes `/office-bridge/…` serve the editor HTML page,
//     the JSON API the sidebar client talks to, and the SSE watch stream;
//   - a local node:http service on 127.0.0.1:<bridgePort> serves
//     GET /download/:fileKey (DS pulls the file) and
//     POST /callback/:fileKey (DS saves: status 2/6 → write new bytes back).
//
// Consumed services (declared via `inject`):
//   ctx.sessions   — DSH session registry (sessionId -> header.cwd)
//   ctx.webServer  — prefix route registration
//   ctx.connection — browser request admission (requestRejection fence)
// Zero runtime dependencies: node:crypto / node:http / node:path / node:fs / node:os only.

import { createHmac, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const name = 'office-bridge';
export const inject = ['sessions', 'webServer', 'connection'];

const VERSION = '2.1.0';
const ROUTE_PREFIX = '/office-bridge';
const DEFAULT_DS_BASE_URL = 'http://127.0.0.1:80';
const DEFAULT_BRIDGE_PORT = 17890;
const MAX_PORT_ATTEMPTS = 10;
const DEFAULT_LANG = 'zh-CN';
const LANG_FALLBACK_CHAIN = ['zh-CN', 'zh', 'en'];
const DS_LOCAL_JSON = 'C:/Program Files/ONLYOFFICE/DocumentServer/config/local.json';
const FETCH_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 500;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// v2.1 additions
const DEFAULT_FILE_LIMIT_MB = 100;
const WATCH_DEBOUNCE_MS = 300;
const SELF_SAVE_WINDOW_MS = 3_000;
// Diagnostic sink for the editor page (see debugRoute).
const DEBUG_LOG_PATH = path.join(os.homedir(), '.dsh', 'office-bridge-debug.jsonl');
const SSE_HEARTBEAT_MS = 15_000;
const REGISTRY_MAX = 128;

const DOCUMENT_TYPES = {
  '.xlsx': 'cell', '.xls': 'cell', '.csv': 'cell', '.tsv': 'cell',
  '.docx': 'word',
  '.pptx': 'slide',
};

class BridgeError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log('[office-bridge]', ...args);
}

function b64url(input) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BridgeError(`${field} is required`, 'INVALID_REQUEST');
  }
  return value;
}

async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new BridgeError('request body is too large', 'INVALID_REQUEST');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError('request body must be valid JSON', 'INVALID_REQUEST');
  }
}

function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

// ---------------------------------------------------------------------------
// pure helpers (exported for node:test smoke coverage)
// ---------------------------------------------------------------------------

/** fileSignature — the "did the file actually change" identity. */
export function fileSignature(stat) {
  return stat ? `${stat.size}:${stat.mtimeMs}` : null;
}

/** computeUrlToken — HMAC urlToken for /download/:fileKey (pure). */
export function computeUrlToken(secret, absPath, mtimeMs) {
  return createHmac('sha256', secret).update(`${absPath}:${mtimeMs}`).digest('hex');
}

/** parseLocalAction — parse "/download/<fileKey>" style local-service paths. */
export function parseLocalAction(pathname) {
  const parts = String(pathname ?? '').split('/').filter(Boolean); // [action, fileKey]
  if (parts.length !== 2) return null;
  return { action: parts[0], fileKey: parts[1] };
}

/**
 * isAllowedCallbackUrl — P1 hardening: DS callback body.url must be http(s)
 * AND live under the configured dsBaseUrl origin (default loopback only).
 */
export function isAllowedCallbackUrl(url, base) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    const b = new URL(String(base ?? '').trim());
    if (u.protocol !== b.protocol || !/^https?:$/.test(u.protocol)) return false;
    if (u.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false;
    if (u.port !== b.port) return false;
    const basePath = b.pathname.replace(/\/+$/, '');
    return u.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JWT (HS256, zero-dependency)
// ---------------------------------------------------------------------------

function jwtSign(secret, payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

// ---------------------------------------------------------------------------
// DS JWT secret auto-probe (cached on local.json mtime)
// ---------------------------------------------------------------------------

function createSecretProbe() {
  let cache = { mtimeMs: null, secret: null, enabled: false };

  // DS config values may be wrapped: { string: "value" } (10.x), plain strings,
  // or the legacy nested shape secret.inbox.outbox.
  function unwrapSecretValue(value) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value && typeof value === 'object') {
      const inner = value.string ?? value.inbox ?? value.outbox;
      if (typeof inner === 'string' && inner.length > 0) return inner;
    }
    return null;
  }

  function readSecretFromConfig(parsed) {
    const secret = parsed?.services?.CoAuthoring?.secret;
    if (!secret || typeof secret !== 'object') return null;
    // Browser-submitted DocsAPI config tokens are verified against secret.browser.
    const browser = unwrapSecretValue(secret.browser);
    if (browser) return browser;
    const legacy = unwrapSecretValue(secret.inbox?.outbox) ?? unwrapSecretValue(secret.inbox);
    return legacy ?? unwrapSecretValue(secret.outbox) ?? unwrapSecretValue(secret.session);
  }

  return async function probe() {
    let mtimeMs = null;
    let stat = null;
    try {
      stat = await fsp.stat(DS_LOCAL_JSON);
      mtimeMs = stat.mtimeMs;
    } catch {
      // not installed or not readable — report jwt disabled
    }
    if (mtimeMs !== null && cache.mtimeMs === mtimeMs) return cache;
    let secret = null;
    if (stat) {
      try {
        const parsed = JSON.parse(await fsp.readFile(DS_LOCAL_JSON, 'utf8'));
        secret = readSecretFromConfig(parsed);
      } catch (error) {
        log(`failed to read ${DS_LOCAL_JSON}:`, error?.message ?? error);
      }
    }
    cache = { mtimeMs, secret, enabled: secret !== null };
    if (secret) log('JWT secret detected from DS local.json');
    else log('JWT secret not found — tokens will be omitted (jwt: false)');
    return cache;
  };
}

// ---------------------------------------------------------------------------
// session scope resolution (pattern copied from v1 / dsh-univer-office)
// ---------------------------------------------------------------------------

function isMissingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function resolveScopeFile(ctx, sessionId, file) {
  const session = ctx.sessions.get(requireString(sessionId, 'sessionId'));
  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new BridgeError('session is unavailable or has no workspace', 'SESSION_SCOPE_UNAVAILABLE', 403);
  }
  let workspace;
  try {
    workspace = await fsp.realpath(cwd);
  } catch {
    throw new BridgeError('session workspace cannot be resolved', 'SESSION_SCOPE_UNAVAILABLE', 403);
  }
  const raw = requireString(file, 'file');
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  let source;
  try {
    source = await fsp.realpath(candidate);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new BridgeError(`file does not exist: ${raw}`, 'FILE_NOT_FOUND', 404);
    }
    throw error;
  }
  // Escape guard: the resolved file must stay inside the session workspace.
  const rel = path.relative(workspace, source);
  const inside = rel === '' || (rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  if (!inside) {
    throw new BridgeError('file escapes the session workspace', 'FILE_OUT_OF_SCOPE', 403);
  }
  const ext = path.extname(source).toLowerCase();
  const documentType = DOCUMENT_TYPES[ext];
  if (!documentType) {
    throw new BridgeError(`unsupported file type: ${ext || '(none)'}`, 'UNSUPPORTED_TYPE');
  }
  return { workspace, source, ext, documentType };
}

// ---------------------------------------------------------------------------
// editor document config
// ---------------------------------------------------------------------------

function pickLang(configured) {
  const lang = typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_LANG;
  if (LANG_FALLBACK_CHAIN.includes(lang)) return lang;
  // unknown lang: fall down the chain
  return LANG_FALLBACK_CHAIN.find((candidate) => candidate.startsWith(lang.slice(0, 2))) ?? DEFAULT_LANG;
}

function buildEditorBootstrap({ fileKey, session, documentType, lang, jwtEnabled, bridgeBaseUrl, secret, mode }) {
  // fileKey is the editSessions map KEY, not a field on the session object —
  // it must be passed in explicitly (v3 bug: destructuring it from `session`
  // yielded undefined, producing /download/undefined URLs that DS got 403 on).
  const { absPath, dsKey, urlToken } = session;
  const title = path.basename(absPath);
  const fileType = path.extname(absPath).slice(1).toLowerCase();
  const document = {
    fileType,
    key: dsKey,
    title,
    url: `${bridgeBaseUrl}/download/${fileKey}?token=${encodeURIComponent(urlToken)}`,
    permissions: { edit: mode !== 'view', download: true, print: true },
  };
  const editorConfig = {
    callbackUrl: `${bridgeBaseUrl}/callback/${fileKey}`,
    mode: mode === 'view' ? 'view' : 'edit',
    lang,
    user: { id: 'dsh-local', name: 'DSH' },
  };
  const bootstrap = {
    document,
    documentType,
    editorConfig,
    type: 'desktop',
    customization: { compactHeader: true, toolbarNoTabs: false },
  };
  if (jwtEnabled && secret) {
    bootstrap.token = jwtSign(secret, { document, documentType, editorConfig });
  }
  return bootstrap;
}

function editorHtml(bootstrap, dsBaseUrl, fileKey) {
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  const fileKeyJson = JSON.stringify(fileKey);
  return `<!DOCTYPE html>
<html lang="${bootstrap.editorConfig.lang}">
<head>
<meta charset="utf-8">
<title>office-bridge editor</title>
<style>
  html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#fff}
  #holder{position:absolute;inset:0}
  #ob-banner{position:absolute;top:0;left:0;right:0;z-index:9999;display:none;align-items:center;gap:10px;
    padding:8px 12px;background:#fff7e0;border-bottom:1px solid #e0c060;color:#5a4300;
    font:13px/1.4 system-ui,sans-serif}
  #ob-banner button{appearance:none;border:1px solid #b09030;background:#fff;border-radius:6px;
    padding:3px 12px;font-size:12px;cursor:pointer;color:#5a4300}
  #ob-banner button:hover{background:#fdf3d0}
</style>
</head>
<body>
<div id="ob-banner"><span id="ob-banner-text"></span><button id="ob-banner-btn" style="display:none"></button></div>
<div id="holder"><div id="placeholder"></div></div>
<script src="${dsBaseUrl}/web-apps/apps/api/documents/api.js" onerror="try{document.title='ERR- api.js failed to load (is ONLYOFFICE DS running?)'}catch(e){}"></script>
<script>
window.onerror = function (message) {
  try { document.title = 'ERR- ' + String(message); } catch (e) {}
};
(function () {
  var FILEKEY = ${fileKeyJson};
  // Two different questions, deliberately kept apart:
  //   dirty  - is the DS engine holding edits that are not in the DS cache yet?
  //            DS clears this itself within ~1s of every keystroke, so it is only
  //            true for a blink and is useless for "did the user touch anything".
  //   touched - did the user edit this document in this tab at all?
  //            Latched on the first dirty=true and kept until the editor is
  //            remounted, so a disk change arriving a minute later still knows
  //            that reloading would throw the user's work away.
  var dirty = false;
  var touched = false;

  function setDirty(next) {
    next = !!next;
    if (next && !touched) {
      touched = true;
      report('touched');
    }
    if (dirty === next) return;
    dirty = next;
    report('dirty:' + String(dirty));
    if (!next && !touched) hideBanner();
  }

  function resetTouched() {
    touched = false;
    dirty = false;
  }

  // --- diagnostic channel: mirror what the page sees into a host-side file ---
  var unreported = [];
  function report(kind, extra) {
    try {
      unreported.push({ k: kind, x: extra === undefined ? null : extra, t: Date.now() });
      if (unreported.length > 200) unreported.shift();
    } catch (e) {}
  }
  function flush() {
    if (!unreported.length) return;
    var batch = unreported;
    unreported = [];
    try {
      fetch('/office-bridge/api/debug?fileKey=' + encodeURIComponent(FILEKEY), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ua: navigator.userAgent, items: batch })
      }).catch(function () {});
    } catch (e) {}
  }
  setInterval(flush, 1200);
  report('page', { href: location.href, framed: window.parent !== window });

  // --- dirty tracking, channel 1: raw postMessage from the DS editor frame ---
  // The editor iframe posts {"event":"onDocumentStateChange","data":<bool>,...}
  // as a JSON string to window.parent (see DocumentServer Gateway._postMessage).
  // We parse it here directly instead of relying on api.js dispatch, which
  // gates on frameEditorId/frameOrigin and silently drops events when the
  // parent page differs from the classic embedding shape.
  window.addEventListener('message', function (ev) {
    var payload = ev && ev.data;
    var rawType = typeof payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (e) {
        report('msg:unparsed', { origin: ev.origin, head: String(ev.data).slice(0, 120) });
        return;
      }
    }
    if (!payload || typeof payload !== 'object') {
      report('msg:nonobject', { origin: ev.origin, rawType: rawType });
      return;
    }
    report('msg', {
      origin: ev.origin,
      event: payload.event === undefined ? null : String(payload.event),
      type: payload.type === undefined ? null : String(payload.type),
      dataType: payload.data === undefined ? 'undef' : typeof payload.data,
      data: payload.data === undefined ? null : payload.data
    });
    if (payload.event === 'onDocumentStateChange') setDirty(payload.data);
  }, false);

  // --- dirty tracking, channel 2: documented events object (belt and braces) ---
  // DS reads handlers from the TOP-LEVEL events object of the editor config
  // (api.js checks _config.events && !!_config.events.onXxx), not from
  // editorConfig.events - putting them inside editorConfig never fires.
  function withEvents(cfg) {
    cfg.events = {
      onDocumentStateChange: function (event) {
        report('api-event', { data: event && event.data });
        setDirty(event && event.data);
      }
    };
    return cfg;
  }

  // --- banner helpers ---
  var banner = document.getElementById('ob-banner');
  var bannerText = document.getElementById('ob-banner-text');
  var bannerBtn = document.getElementById('ob-banner-btn');
  function showBanner(text, buttonText, onClick) {
    bannerText.textContent = text;
    if (buttonText) {
      bannerBtn.style.display = '';
      bannerBtn.textContent = buttonText;
      bannerBtn.onclick = onClick;
    } else {
      bannerBtn.style.display = 'none';
      bannerBtn.onclick = null;
    }
    banner.style.display = 'flex';
  }
  function hideBanner() { banner.style.display = 'none'; }

  // --- editor mount / remount (iframe never reloads) ---
  function mount(cfg) {
    var holder = document.getElementById('holder');
    holder.innerHTML = '<div id="placeholder"></div>';
    resetTouched();
    try {
      window.docEditor = new DocsAPI.DocEditor('placeholder', withEvents(cfg));
    } catch (e) {
      document.title = 'ERR- ' + String(e);
    }
  }

  function reloadEditor() {
    hideBanner();
    fetch('/office-bridge/api/bootstrap?fileKey=' + encodeURIComponent(FILEKEY), { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.message) || 'bootstrap failed');
        try { if (window.docEditor) window.docEditor.destroyEditor(); } catch (e) {}
        mount(data.bootstrap);
      })
      .catch(function (err) {
        showBanner('重新加载失败：' + String(err && err.message ? err.message : err), '重试', reloadEditor);
      });
  }

  // --- disk-change subscription (SSE) ---
  // Never reload on our own. DS does not reliably report onDocumentStateChange
  // (observed to fire on one edit and stay silent on the next for the same
  // file), so a self-reload can silently throw away edits the user still has in
  // the editor. An external change therefore always asks first.
  try {
    var es = new EventSource('/office-bridge/api/watch?fileKey=' + encodeURIComponent(FILEKEY));
    es.addEventListener('change', function () {
      showBanner(
        touched
          ? '文件已在磁盘上被修改（可能是 AI）。你在这里还有未保存的修改，重新加载将丢弃它们。'
          : '文件已在磁盘上被修改（可能是 AI）。重新加载以查看最新内容。',
        '重新加载',
        reloadEditor
      );
    });
    es.addEventListener('removed', function () {
      showBanner('文件已从磁盘上删除。', '重新加载', reloadEditor);
    });
  } catch (e) {
    try { document.title = 'ERR- watch: ' + String(e); } catch (e2) {}
  }

  window.__OB_BOOTSTRAP__ = ${json};
  mount(window.__OB_BOOTSTRAP__);
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// watch hub — fs.watch on open files' parent dirs, debounced + signature
// filtered, with a self-save suppression window (P0-1 / P0-3)
// ---------------------------------------------------------------------------

function createWatchHub() {
  const dirWatchers = new Map(); // dir -> fs.FSWatcher
  const dirRefs = new Map();     // dir -> Set<fileKey>
  const subs = new Map();        // fileKey -> { absPath, dir, timer, lastSig, send }
  const suppress = new Map();    // signature -> suppressUntilEpochMs

  function pruneSuppress() {
    const now = Date.now();
    for (const [sig, until] of suppress) {
      if (until <= now) suppress.delete(sig);
    }
  }

  /** P0-3: register a freshly written signature so the echo is not pushed. */
  function suppressSignature(signature) {
    if (signature) suppress.set(signature, Date.now() + SELF_SAVE_WINDOW_MS);
  }

  function check(fileKey) {
    const sub = subs.get(fileKey);
    if (!sub) return;
    sub.timer = null;
    pruneSuppress();
    let stat = null;
    try { stat = fs.statSync(sub.absPath); } catch { /* deleted */ }
    const sig = fileSignature(stat);
    if (sig === sub.lastSig) return; // signature filter: no real change
    if (sig === null) {
      sub.lastSig = null;
      try { sub.send('removed', { fileKey }); } catch { /* subscriber gone */ }
      return;
    }
    if (suppress.has(sig)) {
      // self-save echo inside the suppression window — adopt, do not push
      sub.lastSig = sig;
      return;
    }
    sub.lastSig = sig;
    try { sub.send('change', { fileKey, signature: sig }); } catch { /* subscriber gone */ }
  }

  function schedule(fileKey) {
    const sub = subs.get(fileKey);
    if (!sub) return;
    if (sub.timer) clearTimeout(sub.timer);
    sub.timer = setTimeout(() => check(fileKey), WATCH_DEBOUNCE_MS);
  }

  function ensureDirWatcher(dir) {
    if (dirWatchers.has(dir)) return true;
    try {
      // Windows: ReadDirectoryChangesW — reliable for writes and renames
      // (our write-back path lands via rename, which dir watch catches).
      const watcher = fs.watch(dir, { persistent: false }, () => {
        const refs = dirRefs.get(dir);
        if (!refs) return;
        for (const fileKey of refs) schedule(fileKey);
      });
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* already closed */ }
        dirWatchers.delete(dir);
        dirRefs.delete(dir);
      });
      dirWatchers.set(dir, watcher);
      return true;
    } catch (error) {
      log('fs.watch failed for', dir, '-', error?.message ?? error);
      return false;
    }
  }

  /** lastSig seeds the signature filter so the very first poll never fires. */
  function subscribe(fileKey, absPath, lastSig, send) {
    unsubscribe(fileKey);
    const dir = path.dirname(absPath);
    if (!ensureDirWatcher(dir)) return false;
    subs.set(fileKey, { absPath, dir, timer: null, lastSig: lastSig ?? null, send });
    let refs = dirRefs.get(dir);
    if (!refs) { refs = new Set(); dirRefs.set(dir, refs); }
    refs.add(fileKey);
    return true;
  }

  function unsubscribe(fileKey) {
    const sub = subs.get(fileKey);
    if (!sub) return;
    if (sub.timer) clearTimeout(sub.timer);
    subs.delete(fileKey);
    const refs = dirRefs.get(sub.dir);
    if (refs) {
      refs.delete(fileKey);
      if (refs.size === 0) {
        const watcher = dirWatchers.get(sub.dir);
        try { watcher?.close(); } catch { /* already closed */ }
        dirWatchers.delete(sub.dir);
        dirRefs.delete(sub.dir);
      }
    }
  }

  function disposeAll() {
    for (const fileKey of [...subs.keys()]) unsubscribe(fileKey);
    for (const watcher of dirWatchers.values()) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    dirWatchers.clear();
    dirRefs.clear();
    subs.clear();
    suppress.clear();
  }

  return { subscribe, unsubscribe, suppressSignature, disposeAll, isSubscribed: (k) => subs.has(k) };
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  // Boot marker: proves which build is live after a reload (HMR is silent on success,
  // and console.log does not reach the desktop log file).
  try {
    const marker = JSON.stringify({ build: '2026-10-28-never-autoreload', pid: process.pid, at: new Date().toISOString() });
    fs.writeFileSync(path.join(os.tmpdir(), 'office-bridge-boot.json'), marker, 'utf8');
  } catch (e) {}
  const connection = ctx.connection;
  const dsBaseUrl = (typeof config.dsBaseUrl === 'string' && config.dsBaseUrl.trim())
    ? config.dsBaseUrl.trim().replace(/\/+$/, '') : DEFAULT_DS_BASE_URL;
  const preferredPort = Number.isInteger(config.bridgePort) && config.bridgePort > 0
    ? config.bridgePort : DEFAULT_BRIDGE_PORT;
  const lang = pickLang(config.lang);
  // P2: 'edit' (default) | 'view' — view mode is read-only preview
  const defaultMode = config.defaultMode === 'view' ? 'view' : 'edit';
  // P1: size cap, checked on both /download and /callback sides
  const fileLimitMb = Number.isFinite(config.fileLimitMb) && config.fileLimitMb > 0
    ? config.fileLimitMb : DEFAULT_FILE_LIMIT_MB;
  const fileLimitBytes = Math.floor(fileLimitMb * 1024 * 1024);
  const configuredSecret = typeof config.dsSecret === 'string' && config.dsSecret.trim()
    ? config.dsSecret.trim() : null;
  const probeSecret = createSecretProbe();
  const watchHub = createWatchHub();

  // fileKey -> { absPath, sessionId, dsKey, mtimeMs, urlToken }
  const editSessions = new Map();
  // per-process random secret; urlToken = HMAC(urlSecret, absPath + ':' + mtimeMs)
  const urlSecret = randomBytes(16).toString('hex');

  // P2: registry.json persistence (<home>/plugins/dsh-office-bridge/registry.json)
  const registryPath = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'plugins', 'dsh-office-bridge', 'registry.json',
  );

  let bridgePort = null;
  let server = null;

  async function resolveJwt() {
    if (configuredSecret) return { secret: configuredSecret, enabled: true };
    return probeSecret();
  }

  function urlTokenFor(absPath, mtimeMs) {
    return computeUrlToken(urlSecret, absPath, mtimeMs);
  }

  function dsKeyFor(absPath, stat) {
    return createHash('sha1').update(`${absPath}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 20);
  }

  // ----- registry.json persistence (P2) -----

  function registryEntries() {
    const entries = [];
    for (const [fileKey, s] of editSessions) {
      entries.push({ fileKey, absPath: s.absPath, sessionId: s.sessionId, mtimeMs: s.mtimeMs });
    }
    return entries.slice(-REGISTRY_MAX);
  }

  async function persistRegistry() {
    try {
      await fsp.mkdir(path.dirname(registryPath), { recursive: true });
      const payload = JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        sessions: registryEntries(),
      }, null, 2);
      await fsp.writeFile(registryPath, payload, 'utf8');
    } catch (error) {
      log('registry persist failed:', error?.message ?? error);
    }
  }

  async function restoreRegistry() {
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(registryPath, 'utf8'));
    } catch {
      return; // first run or unreadable — nothing to restore
    }
    const list = Array.isArray(parsed?.sessions) ? parsed.sessions.slice(-REGISTRY_MAX) : [];
    let restored = 0;
    for (const entry of list) {
      try {
        if (typeof entry?.fileKey !== 'string' || typeof entry?.absPath !== 'string'
          || typeof entry?.sessionId !== 'string') continue;
        if (editSessions.has(entry.fileKey)) continue;
        if (!ctx.sessions.get(entry.sessionId)?.header?.cwd) continue; // session gone
        const stat = await fsp.stat(entry.absPath).catch(() => null);
        if (!stat) continue; // file gone
        // mtime revalidation: the file changed since the session was saved → stale, drop
        if (typeof entry.mtimeMs === 'number' && Math.abs(stat.mtimeMs - entry.mtimeMs) > 1) continue;
        editSessions.set(entry.fileKey, {
          absPath: entry.absPath,
          sessionId: entry.sessionId,
          dsKey: dsKeyFor(entry.absPath, stat),
          mtimeMs: stat.mtimeMs,
          urlToken: urlTokenFor(entry.absPath, stat.mtimeMs),
        });
        restored += 1;
      } catch { /* skip bad entry */ }
    }
    if (restored > 0) log(`registry: restored ${restored} edit session(s) from ${registryPath}`);
  }

  /** Resolve + register (or refresh) an edit session for one file. */
  async function openDocument(ctxLocal, sessionId, file) {
    const { source, documentType } = await resolveScopeFile(ctxLocal, sessionId, file);
    const stat = await fsp.stat(source);
    const dsKey = dsKeyFor(source, stat);
    // Look for an existing session for the same path in the same shape.
    let fileKey = null;
    for (const [key, value] of editSessions) {
      if (value.absPath === source && value.sessionId === sessionId) { fileKey = key; break; }
    }
    if (fileKey) {
      // Refresh version identity on every open: an externally modified file must
      // get a new dsKey (DS cache-buster) and a matching urlToken.
      const existing = editSessions.get(fileKey);
      existing.dsKey = dsKey;
      existing.mtimeMs = stat.mtimeMs;
      existing.urlToken = urlTokenFor(source, stat.mtimeMs);
    } else {
      fileKey = randomBytes(16).toString('hex');
      editSessions.set(fileKey, {
        absPath: source,
        sessionId,
        dsKey,
        mtimeMs: stat.mtimeMs,
        urlToken: urlTokenFor(source, stat.mtimeMs),
      });
    }
    persistRegistry(); // fire-and-forget (P2)
    return { fileKey, session: editSessions.get(fileKey), documentType };
  }

  async function editorRoute(url, response) {
    const { fileKey, session, documentType } = await openDocument(ctx, url.searchParams.get('sessionId'), url.searchParams.get('file'));
    const { secret, enabled } = await resolveJwt();
    const bootstrap = buildEditorBootstrap({
      fileKey, session, documentType, lang, jwtEnabled: enabled, secret,
      bridgeBaseUrl: `http://127.0.0.1:${bridgePort}`,
      mode: url.searchParams.get('mode') === 'view' ? 'view' : defaultMode,
    });
    const html = editorHtml(bootstrap, dsBaseUrl, fileKey);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
    log(`editor page served for ${path.basename(session.absPath)} (fileKey=${fileKey})`);
  }

  async function apiEditorRoute(url, response) {
    const { fileKey, session } = await openDocument(ctx, url.searchParams.get('sessionId'), url.searchParams.get('file'));
    sendJson(response, 200, {
      ok: true,
      url: `${ROUTE_PREFIX}/editor?file=${encodeURIComponent(url.searchParams.get('file'))}&sessionId=${encodeURIComponent(url.searchParams.get('sessionId'))}`,
      fileKey,
      mtimeMs: session.mtimeMs,
    });
  }

  /** P0-1 companion: fresh bootstrap JSON for the in-page hot reload path. */
  async function apiBootstrapRoute(url, response) {
    const fileKey = requireString(url.searchParams.get('fileKey'), 'fileKey');
    const session = editSessions.get(fileKey);
    if (!session) throw new BridgeError('unknown fileKey', 'UNKNOWN_FILEKEY', 403);
    const stat = await fsp.stat(session.absPath).catch(() => null);
    if (!stat) throw new BridgeError('file is gone from disk', 'FILE_NOT_FOUND', 404);
    session.dsKey = dsKeyFor(session.absPath, stat);
    session.mtimeMs = stat.mtimeMs;
    session.urlToken = urlTokenFor(session.absPath, stat.mtimeMs);
    const { secret, enabled } = await resolveJwt();
    const ext = path.extname(session.absPath).toLowerCase();
    const bootstrap = buildEditorBootstrap({
      fileKey, session, documentType: DOCUMENT_TYPES[ext] ?? 'cell', lang,
      jwtEnabled: enabled, secret,
      bridgeBaseUrl: `http://127.0.0.1:${bridgePort}`,
      mode: defaultMode,
    });
    sendJson(response, 200, { ok: true, bootstrap, mtimeMs: stat.mtimeMs });
  }

  /** P0-1: SSE stream of disk changes for one opened file. */
  function watchRoute(request, url, response) {
    const fileKey = url.searchParams.get('fileKey') ?? '';
    const session = editSessions.get(fileKey);
    if (!session) {
      sendJson(response, 403, { ok: false, code: 'UNKNOWN_FILEKEY', message: 'unknown or expired fileKey' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    response.write(':ok\n\n');
    const send = (event, data) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // seed lastSig from the current on-disk identity so no echo fires on connect
    let lastSig = null;
    try { lastSig = fileSignature(fs.statSync(session.absPath)); } catch { /* deleted */ }
    watchHub.subscribe(fileKey, session.absPath, lastSig, send);
    log(`watch subscribed for ${path.basename(session.absPath)} (fileKey=${fileKey})`);
    const heartbeat = setInterval(() => {
      try { response.write(':ping\n\n'); } catch { /* closed */ }
    }, SSE_HEARTBEAT_MS);
    request.on('close', () => {
      clearInterval(heartbeat);
      watchHub.unsubscribe(fileKey);
      log(`watch unsubscribed for ${path.basename(session.absPath)}`);
    });
  }

  /**
   * Diagnostic sink: the editor page posts what it receives (iframe messages,
   * API events, dirty flips) so we can inspect the real wire format from disk
   * instead of guessing at ONLYOFFICE's postMessage contract.
   */
  async function debugRoute(request, url, response) {
    const fileKey = url.searchParams.get('fileKey') ?? '';
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 512 * 1024) break;
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        fileKey,
        ua: parsed?.ua ?? null,
        items: parsed?.items ?? raw.slice(0, 2000),
      });
      await fsp.appendFile(DEBUG_LOG_PATH, line + '\n', 'utf8');
    } catch (error) {
      log('debug sink write failed:', error?.message ?? error);
    }
    sendJson(response, 200, { ok: true });
  }

  async function healthRoute(response) {
    let dsReachable = false;
    try {
      const res = await fetchWithTimeout(`${dsBaseUrl}/healthcheck`, { timeoutMs: HEALTH_TIMEOUT_MS });
      dsReachable = res.ok;
    } catch {
      dsReachable = false;
    }
    const { enabled } = await resolveJwt();
    sendJson(response, 200, {
      ok: true,
      dsReachable,
      dsBaseUrl,
      bridgePort,
      jwt: enabled,
      version: VERSION,
    });
  }

  async function configRoute(response) {
    const { enabled } = await resolveJwt();
    sendJson(response, 200, {
      ok: true,
      dsBaseUrl,
      bridgePort,
      jwt: enabled,
      lang,
      defaultMode,
      fileLimitMb,
      version: VERSION,
    });
  }

  // ----- local http service (DS ↔ host file exchange) -----

  async function handleDownload(request, response, fileKey, url) {
    const session = editSessions.get(fileKey);
    if (!session) {
      sendJson(response, 403, { error: 1, message: 'unknown fileKey' });
      return;
    }
    if (url.searchParams.get('token') !== session.urlToken) {
      sendJson(response, 403, { error: 1, message: 'bad token' });
      return;
    }
    // P1: fileLimitMb on the download side — refuse to serve oversized files
    let stat = null;
    try {
      stat = await fsp.stat(session.absPath);
    } catch (error) {
      sendJson(response, 404, { error: 1, message: 'file unreadable' });
      return;
    }
    if (stat.size > fileLimitBytes) {
      log(`download refused: ${path.basename(session.absPath)} is ${(stat.size / 1048576).toFixed(1)} MB > fileLimitMb=${fileLimitMb}`);
      sendJson(response, 403, { error: 1, message: `file exceeds fileLimitMb=${fileLimitMb}` });
      return;
    }
    const stream = fs.createReadStream(session.absPath);
    stream.on('error', (error) => {
      log('download stream error:', error?.message ?? error);
      if (!response.headersSent) sendJson(response, 404, { error: 1, message: 'file unreadable' });
      else response.destroy();
    });
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(session.absPath))}`,
      'cache-control': 'no-store',
    });
    stream.pipe(response);
  }

  /** P1: write the previous version aside as <name>.<ext>.bak (best-effort). */
  async function backupBeforeWrite(absPath) {
    try {
      await fsp.copyFile(absPath, `${absPath}.bak`);
      return true;
    } catch (error) {
      log('bak backup failed (write-back continues):', error?.message ?? error);
      return false;
    }
  }

  async function handleCallback(request, response, fileKey) {
    const session = editSessions.get(fileKey);
    if (!session) {
      sendJson(response, 403, { error: 1, message: 'unknown fileKey' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: 1, message: 'bad JSON body' });
      return;
    }
    const status = Number(body?.status);
    log(`callback for ${path.basename(session.absPath)} status=${status}`);
    if (status === 2 || status === 6) {
      const url = typeof body?.url === 'string' ? body.url : '';
      // P1: URL allowlist — must be http(s) AND under the configured dsBaseUrl.
      if (!isAllowedCallbackUrl(url, dsBaseUrl)) {
        log(`callback url rejected (must be http(s) under ${dsBaseUrl}): ${url || '(empty)'}`);
        sendJson(response, 403, { error: 1, message: 'callback url outside allowed origin' });
        return;
      }
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new BridgeError(`download from DS failed: HTTP ${res.status}`, 'CALLBACK_DOWNLOAD_FAILED', 502);
      const buffer = Buffer.from(await res.arrayBuffer());
      // P1: fileLimitMb on the write-back side. Reply error:0 so DS does not
      // retry-storm; the on-disk file keeps its pre-save content.
      if (buffer.length > fileLimitBytes) {
        log(`write-back refused: ${path.basename(session.absPath)} is ${(buffer.length / 1048576).toFixed(1)} MB > fileLimitMb=${fileLimitMb}`);
        sendJson(response, 200, { error: 0 });
        return;
      }
      await backupBeforeWrite(session.absPath); // P1: .bak (best-effort)
      const tmp = `${session.absPath}.obtmp-${randomBytes(6).toString('hex')}`;
      try {
        await fsp.writeFile(tmp, buffer);
        try {
          await fsp.rename(tmp, session.absPath);
        } catch (error) {
          if (error?.code === 'EXDEV' || error?.code === 'EPERM') {
            await fsp.copyFile(tmp, session.absPath);
            await fsp.unlink(tmp).catch(() => {});
          } else {
            throw error;
          }
        }
      } catch (error) {
        await fsp.unlink(tmp).catch(() => {});
        throw error;
      }
      const after = await fsp.stat(session.absPath);
      session.mtimeMs = after.mtimeMs;
      session.dsKey = dsKeyFor(session.absPath, after);
      session.urlToken = urlTokenFor(session.absPath, after.mtimeMs);
      // P0-3: suppress the self-save echo so the editor is not refreshed by
      // our own write-back (cursor loss / focus steal prevention).
      watchHub.suppressSignature(fileSignature(after));
      persistRegistry(); // fire-and-forget (P2)
      log(`wrote back ${path.basename(session.absPath)} (${buffer.length} bytes)`);
    }
    sendJson(response, 200, { error: 0 });
  }

  function startLocalService() {
    const localHandler = async (request, response) => {
      try {
        if (!isLoopback(request.socket?.remoteAddress)) {
          response.writeHead(403);
          response.end();
          return;
        }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const parsed = parseLocalAction(url.pathname);
        if (!parsed) { response.writeHead(404); response.end(); return; }
        const { action, fileKey } = parsed;
        if (action === 'download' && request.method === 'GET') {
          await handleDownload(request, response, fileKey, url);
          return;
        }
        if (action === 'callback' && request.method === 'POST') {
          await handleCallback(request, response, fileKey);
          return;
        }
        response.writeHead(404);
        response.end();
      } catch (error) {
        log('local service error:', error?.message ?? error);
        if (!response.headersSent) {
          sendJson(response, error instanceof BridgeError ? error.status : 500, { error: 1, message: String(error?.message ?? error) });
        } else {
          response.end();
        }
      }
    };

    return new Promise((resolve, reject) => {
      let attempt = 0;
      let candidatePort = preferredPort;
      const tryListen = () => {
        const srv = http.createServer(localHandler);
        srv.on('error', (error) => {
          if (error?.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS - 1) {
            attempt += 1;
            candidatePort += 1;
            srv.close?.();
            tryListen();
          } else {
            reject(error);
          }
        });
        srv.listen(candidatePort, '127.0.0.1', () => {
          srv.removeAllListeners('error');
          srv.on('error', (error) => log('local service runtime error:', error?.message ?? error));
          bridgePort = candidatePort;
          resolve(srv);
        });
      };
      tryListen();
    });
  }

  // ----- webServer router -----

  function webRouter(request, response) {
    return (async () => {
      const reject = connection?.requestRejection?.(request);
      if (reject !== undefined) {
        sendJson(response, reject, {
          ok: false,
          code: reject === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
          message: 'DSH browser authentication is required',
        });
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const { pathname } = url;
      if (request.method === 'GET' && pathname === `${ROUTE_PREFIX}/editor`) {
        await editorRoute(url, response);
        return;
      }
      if (request.method === 'GET' && pathname === `${ROUTE_PREFIX}/api/editor`) {
        await apiEditorRoute(url, response);
        return;
      }
      if (request.method === 'GET' && pathname === `${ROUTE_PREFIX}/api/bootstrap`) {
        await apiBootstrapRoute(url, response);
        return;
      }
      if (request.method === 'GET' && pathname === `${ROUTE_PREFIX}/api/watch`) {
        watchRoute(request, url, response);
        return;
      }
      if (request.method === 'POST' && pathname === `${ROUTE_PREFIX}/api/debug`) {
        await debugRoute(request, url, response);
        return;
      }
      if (request.method === 'GET' && pathname === `${ROUTE_PREFIX}/api/health`) {
        await healthRoute(response);
        return;
      }
      if (request.method === 'GET' && pathname === `${ROUTE_PREFIX}/api/config`) {
        await configRoute(response);
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch((error) => {
      const known = error instanceof BridgeError;
      const status = known ? error.status : 500;
      log('route error:', error?.message ?? error);
      if (!response.headersSent) {
        sendJson(response, status, {
          ok: false,
          code: known ? error.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    });
  }

  ctx.effect(() => {
    let disposeRoutes = () => {};
    let started = false;
    (async () => {
      server = await startLocalService();
      log(`local service listening on http://127.0.0.1:${bridgePort}`);
      disposeRoutes = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: webRouter,
      });
      started = true;
      await restoreRegistry(); // P2
    })().catch((error) => {
      log('startup failed:', error?.message ?? error);
    });
    return () => {
      disposeRoutes?.();
      watchHub.disposeAll();
      if (started && server) {
        server.close();
        server = null;
        bridgePort = null;
      }
    };
  }, 'office-bridge: routes + local service');
}

// HMR-BUST-v23 never-autoreload+sticky-touched+watch+sse marker 2026-10-28
