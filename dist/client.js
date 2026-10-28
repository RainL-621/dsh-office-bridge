/* dsh-office-bridge client bundle v3 — classic script, loaded by dsh-client-modules.
 *
 * 协议（源码考证 @deepseek-ai/dsh-client-modules lib/client.js + dsh-pet / dsh-better-sidebar 样本）：
 *   1. 脚本执行期只做注册：window.__ModuleLoader__.load({ id: <包名>, factory })
 *   2. factory 签名 (require) => exports；require('react')/require('react/jsx-runtime') 是平台种子
 *   3. exports 必须 { apply(ctx), inject: <服务名数组>, name } —— inject 是 cordis 服务名
 *      （如 'slots'、'sidebarRightTabs'），不是包名；写包名会永远等待不存在的服务，
 *      apply 静默不执行（v1/v2 未生效的根因）。
 *   4. package.json 的 dsh.client.inject 才是包名数组，负责浏览器模块图的装载顺序。
 *
 * v3 行为不变：sidebarRightTabs.register 注册 office 文件 tab 类型（自造 kind 'office-bridge'，
 * extension 级 patterns 命中 xlsx/xls/csv/tsv/docx/pptx）+ slots.inject('sidebar.right.pane.tab')
 * 注册 tab 正文组件；组件 fetch {origin}/office-bridge/api/editor 取编辑器页 URL 后 iframe。
 */
window.__ModuleLoader__.load({
  id: 'dsh-office-bridge',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    const name = 'office-bridge';
    // cordis 客户端服务名：slots 用于注册 tab 正文，sidebarRightTabs 是
    // @deepseek-ai/dsh-client-ui-sidebar-right 提供的 tab 类型注册表。
    const inject = ['slots', 'sidebarRightTabs'];

    const TAB_ID = 'dsh-office-bridge';
    const TAB_KIND = 'office-bridge';
    const PATTERNS = ['*.xlsx', '*.xls', '*.csv', '*.tsv', '*.docx', '*.pptx'];

    // CSS with a random class prefix per load, so we never pollute host styles.
    const P = 'ob' + Math.random().toString(36).slice(2, 8);
    const CSS = `
.${P}-root{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--dsh-bg,#fff);color:var(--dsh-fg,#222);font:13px/1.45 var(--dsh-font,system-ui,sans-serif)}
.${P}-toolbar{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:1px solid rgba(125,125,125,.25);flex:0 0 auto;min-height:34px}
.${P}-name{font-weight:600;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:50%}
.${P}-badge{font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(64,120,192,.14);color:#3a6ea5;text-transform:uppercase;letter-spacing:.04em;flex:0 0 auto}
.${P}-btn{appearance:none;border:1px solid rgba(125,125,125,.4);background:transparent;border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;color:inherit;flex:0 0 auto}
.${P}-btn:hover:not(:disabled){background:rgba(125,125,125,.12)}
.${P}-btn:disabled{opacity:.5;cursor:default}
.${P}-body{position:relative;flex:1 1 auto;min-height:0}
.${P}-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#fff}
.${P}-msg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:inherit}
.${P}-msg h4{margin:0;font-size:14px}
.${P}-msg code{font-size:12px;opacity:.75;word-break:break-all;max-width:80%}
.${P}-msg a.${P}-btn{text-decoration:none;display:inline-block}
.${P}-probe{font-size:12px;opacity:.65;max-width:80%}
.${P}-probe.on{opacity:1;color:#2e7d32}
`;

    // --- resource address parsing (self-contained, mirrors host conventions) ---

    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    function isDriveSegment(segment) {
      return segment !== undefined && /^[A-Za-z]:$/.test(segment);
    }
    function parseFileAddress(address) {
      try {
        if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/');
        if (scope === 'session') {
          const [id, ...segments] = rest;
          if (id === undefined || id === '' || segments.length === 0) return undefined;
          return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
        }
        if (scope === 'absolute') {
          const unc = rest[0] === '' && rest.length > 1;
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
          if (segments.length === 0 || segments[0] === '') return undefined;
          if (unc) return { scope, path: `//${segments.join('/')}` };
          return { scope, path: isDriveSegment(segments[0]) ? segments.join('/') : `/${segments.join('/')}` };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }
    function fileAddressBasename(address) {
      const parsed = parseFileAddress(address);
      const segments = (parsed?.path ?? address).split('/').filter((segment) => segment.length > 0);
      return segments[segments.length - 1] ?? address;
    }

    // --- tab body ---

    function BridgeTabBody(props) {
      const { tab } = props.useTabInfo();
      const address = parseFileAddress(tab?.contentId);
      if (address === undefined || address.scope !== 'session') return null;

      const query = React.useMemo(() => {
        const params = new URLSearchParams({ file: address.path, sessionId: address.sessionId });
        return params.toString();
      }, [address.path, address.sessionId]);

      const [url, setUrl] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [attempt, setAttempt] = React.useState(0);
      const [dsOk, setDsOk] = React.useState(null); // null=检测中 / false=未检出 DS / true=DS 就绪
      const autoRetry = React.useRef(0); // 同一失败周期内自动重开次数上限，防死循环

      const open = React.useCallback(async () => {
        setLoading(true);
        setError(null);
        setUrl(null);
        try {
          const res = await fetch(`${location.origin}/office-bridge/api/editor?${query}`, { credentials: 'same-origin' });
          const data = await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }));
          if (!res.ok || !data.ok) throw new Error(data.message || data.code || `HTTP ${res.status}`);
          autoRetry.current = 0;
          setUrl(data.url);
        } catch (err) {
          setError(String(err?.message ?? err));
        } finally {
          setLoading(false);
        }
      }, [query]);

      React.useEffect(() => { open(); }, [open, attempt]);

      // 失败态下的 DS 探测：每 5s 查 /api/health；DS 从未就绪变为就绪时自动重开编辑器。
      const dsMissing = !url && !loading && !!error;
      React.useEffect(() => {
        if (!dsMissing) return undefined;
        let alive = true;
        const check = async () => {
          try {
            const res = await fetch(`${location.origin}/office-bridge/api/health`, { credentials: 'same-origin' });
            const data = await res.json().catch(() => null);
            if (!alive) return;
            const ok = !!(data && data.ok && data.dsReachable);
            setDsOk(ok);
            if (ok && autoRetry.current < 3) {
              autoRetry.current += 1;
              setAttempt((n) => n + 1);
            }
          } catch {
            if (alive) setDsOk(false);
          }
        };
        check();
        const timer = setInterval(check, 5000);
        return () => { alive = false; clearInterval(timer); };
      }, [dsMissing]);

      const label = fileAddressBasename(tab.contentId);
      const ext = (address.path.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() ?? '';

      return jsx('div', { className: P + '-root', children: [
        jsxs('div', { className: P + '-toolbar', children: [
          jsx('span', { className: P + '-name', title: address.path, children: label }),
          ext ? jsx('span', { className: P + '-badge', children: ext }) : null,
          jsx('button', {
            type: 'button',
            className: P + '-btn',
            title: '关闭当前编辑器并重新打开该文件',
            onClick: () => { setAttempt((n) => n + 1); },
            children: '重新打开',
          }),
        ] }),
        jsx('div', { className: P + '-body', children:
          url
            ? jsx('iframe', {
                className: P + '-frame',
                src: url,
                title: 'office-bridge: ' + label,
                allow: 'clipboard-read; clipboard-write',
              })
            : loading
              ? jsx('div', { className: P + '-msg', children: jsx('h4', { children: '正在打开编辑器…' }) })
              : jsxs('div', { className: P + '-msg', children: [
                  jsx('h4', { children: '无法打开编辑器' }),
                  jsx('code', { children: error }),
                  dsOk === true
                    ? jsx('span', { className: P + '-probe on', children: 'Document Server 已就绪，正在重新打开…' })
                    : jsx('span', { className: P + '-probe', children: dsOk === false ? '未检测到 Document Server — 每 5 秒自动探测，装好后无需手动刷新' : '正在检测 Document Server…' }),
                  dsOk !== true
                    ? jsx('span', { children: '本插件用本机安装的 ONLYOFFICE Document Server 做编辑引擎（不随插件附带，需管理员权限安装）。' })
                    : null,
                  dsOk !== true
                    ? jsx('a', { className: P + '-btn', href: 'https://download.onlyoffice.com/install/documentserver/windows/onlyoffice-documentserver.exe', target: '_blank', rel: 'noreferrer', children: '下载 ONLYOFFICE Document Server（约 873MB）' })
                    : null,
                  jsx('button', { type: 'button', className: P + '-btn', onClick: () => { autoRetry.current = 0; setAttempt((n) => n + 1); }, children: '重试' }),
                ] }),
        }),
      ] });
    }

    // --- registration (native sidebar-right tab API) ---

    function registerSidebarTab(ctx) {
      const tabs = ctx.get('sidebarRightTabs');
      if (tabs === undefined) return () => undefined;
      const slots = ctx.slots;
      const disposeBody = slots.inject(
        'sidebar.right.pane.tab',
        () => slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            inject: () => ({ ctx }),
          },
          BridgeTabBody
        )
      );
      const disposeType = tabs.register({
        id: TAB_ID,
        kind: TAB_KIND, // self-made kind — never 'text'
        patterns: PATTERNS,
        priority: 'extension', // beats builtin(2) ties off / fallback(1)
        canOpen: (address) => parseFileAddress(address)?.scope === 'session',
        title: fileAddressBasename,
      });
      return () => {
        disposeType();
        disposeBody();
      };
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.append(style);
        return () => style.remove();
      }, 'office-bridge: styles');

      // inject 已声明 ['slots','sidebarRightTabs']，apply 执行时两服务必然就绪。
      ctx.effect(() => registerSidebarTab(ctx), 'office-bridge: sidebar tab type');
    }

    module.exports = { apply, inject, name };
    return module.exports;
  },
});
