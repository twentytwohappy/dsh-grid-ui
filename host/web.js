/**
 * dsh-grid-ui · host/web.js
 * 通过 ctx.webServer 做三件事：
 *   1. tapIndex：往 DSH Web 首页 HTML 里注入 overlay 脚本；
 *   2. 提供 overlay / bridge / grid.css 三个静态资源；
 *   3. 提供 state / window / action / remove 四个 HTTP 接口。
 *
 * 关键 API 参考（@deepseek-ai/dsh-host-webserver）：
 *   ctx.webServer.register({ kind: 'exact', path, handler: (req, res) => {} })
 *   ctx.webServer.tapIndex(html => html)
 *
 * 两个必须遵守的约束（都是踩过的坑）：
 *
 * 1) **路由路径必须稳定**。tapIndex 的注入发生在 `index.html` 被请求的那一刻；
 *    如果路径里带实例 ID，页面加载后插件再重载一次，已发出的 HTML 就指向一个
 *    不存在的路径（脚本 404，悬浮球彻底消失）。所以所有路径固定为 `/dsh-grid-ui/*`。
 *
 * 2) **每个进程只挂载一次**。cordis 重跑 `apply()` 时不会先释放上一轮注册的路由，
 *    重复注册同一个 path 会抛 `webserver: duplicate exact route`，并让**整个插件**
 *    激活失败（工具、注入一起消失）。因此用模块级 `mounted` 标记短路，重跑时只
 *    更新 `live`（handler 读取的最新 ctx/runtime），不重复注册。
 *    模块本身被 ESM 缓存，这个标记在同一进程内一直有效；进程重启后自然重新挂载。
 *
 * 已知代价：插件被禁用时路由仍然在（tapIndex 也还在注入）。对本插件可以接受——
 * 它本来就是常驻的 UI 层；要彻底拿掉就重启 DSH。
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ActionError, buildState, handleAction } from './actions.js';
import { GridUiError } from './windows.js';

/** 插件包根目录（host/ 的上一层） */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 固定的路由前缀（浏览器端 overlay 也按这个前缀拼 API 地址） */
export const BASE_PATH = '/dsh-grid-ui';

/** 磁盘上的三个静态资源 */
const FILES = {
  overlay: join(PACKAGE_ROOT, 'client', 'overlay.js'),
  bridge: join(PACKAGE_ROOT, 'client', 'bridge.js'),
  css: join(PACKAGE_ROOT, 'styles', 'grid.css')
};

const CONTENT_TYPES = new Map([
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8']
]);

/** 请求体上限：窗口 HTML 最大 200KB，但 send_message 可携带 base64 图片（最多 6 张），给到 24MB */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

/** 按 mtime 缓存的静态资源读取，改文件后刷新浏览器即可生效，无需重启 DSH */
const assetCache = new Map();

/** 本进程是否已经挂过路由（模块被缓存，apply 重跑时会命中） */
let mounted = false;
/** 当前存活的 ctx / runtime：已注册的 handler 始终读取这里，避免闭包抓住被释放的旧实例 */
let live = null;

/**
 * 自测专用：模拟「新进程」。真实重启会重新加载模块，`mounted` 自然是 false；
 * 同一个 Node 进程里连续模拟重启时用这个函数复位。
 */
export function __resetWebMountForTests() {
  mounted = false;
  live = null;
}

function readAsset(file) {
  const stat = statSync(file);
  const cached = assetCache.get(file);
  if (cached && cached.mtime === stat.mtimeMs) return cached.text;
  const text = readFileSync(file, 'utf8');
  assetCache.set(file, { mtime: stat.mtimeMs, text });
  return text;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

/** 读取并解析 JSON 请求体（带体积上限） */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new GridUiError('请求体过大', 'grid-ui/body-too-large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new GridUiError('请求体不是合法 JSON', 'grid-ui/bad-json', 400));
      }
    });
  });
}

/** 代理请求的默认/上限参数 */
const PROXY_MAX_BYTES = 2 * 1024 * 1024;
const PROXY_MAX_TIMEOUT_MS = 60_000;
const PROXY_DEFAULT_TIMEOUT_MS = 20_000;

/** 不允许被页面覆盖的请求头（避免伪造 host / 分块等） */
const PROXY_BLOCKED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer'
]);

/**
 * Host 侧代发 HTTP 请求（`POST /dsh-grid-ui/fetch` 的实现）。
 *
 * 为什么放在 Host：窗口 iframe 是 sandbox + 不透明源，页面直接 fetch 外部 API
 * 会同时撞上 CORS 和页面 CSP；由 Host 用 Node 的 fetch 代发就能拿到纯净结果，
 * 页面只需要 `await dsh.http(url, options)`。
 *
 * @param {{url?: string, method?: string, headers?: object, body?: string, timeoutMs?: number, maxBytes?: number}} input
 * @param {import('./cookies.js').CookieJar | null} [jar] 共享 cookie 罐：带上登录态、收下 Set-Cookie
 * @returns {Promise<object>} `{ ok, status, statusText, headers, body, contentType, truncated, elapsedMs, finalUrl }`
 */
async function proxyFetch(input, jar) {
  const rawUrl = typeof input?.url === 'string' ? input.url.trim() : '';
  if (!rawUrl) throw new GridUiError('url 不能为空', 'grid-ui/bad-url');
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new GridUiError(`url 不是合法地址：${rawUrl}`, 'grid-ui/bad-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GridUiError(`只支持 http / https（收到 ${parsed.protocol}）`, 'grid-ui/bad-url');
  }

  const method = (typeof input.method === 'string' ? input.method : 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new GridUiError('method 不合法', 'grid-ui/bad-request');

  const headers = {};
  if (input.headers && typeof input.headers === 'object') {
    for (const [key, value] of Object.entries(input.headers)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      if (PROXY_BLOCKED_HEADERS.has(String(key).toLowerCase())) continue;
      headers[String(key)] = String(value);
    }
  }

  // 共享 cookie：调用方没显式给 Cookie 头时，把罐里该 URL 的 cookie 补上，
  // 这样「在网页窗口里登录过」之后，dsh.http 也自动是登录态。
  if (jar && typeof jar.header === 'function') {
    const hasCookie = Object.keys(headers).some((key) => key.toLowerCase() === 'cookie');
    if (!hasCookie) {
      const jarCookie = jar.header(parsed.toString());
      if (jarCookie) headers.Cookie = jarCookie;
    }
  }

  const timeoutMs = Math.min(
    PROXY_MAX_TIMEOUT_MS,
    Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : PROXY_DEFAULT_TIMEOUT_MS
  );
  const maxBytes = Math.min(
    PROXY_MAX_BYTES,
    Number.isFinite(input.maxBytes) && input.maxBytes > 0 ? input.maxBytes : PROXY_MAX_BYTES
  );

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : input.body,
      redirect: 'follow',
      signal: controller.signal
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const truncated = buffer.length > maxBytes;
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    const outHeaders = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });

    // 收下 Set-Cookie：下次同一站点的窗口 / dsh.http 就带上了
    if (jar && typeof jar.storeHeader === 'function') {
      let rawCookies = [];
      if (typeof response.headers.getSetCookie === 'function') {
        rawCookies = response.headers.getSetCookie();
      } else {
        const single = response.headers.get('set-cookie');
        if (single) rawCookies = [single];
      }
      for (const header of rawCookies) {
        try {
          jar.storeHeader(header, response.url || parsed.toString());
        } catch (error) {
          /* 单条解析失败不影响本次请求 */
        }
      }
    }

    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
      contentType: outHeaders['content-type'] || '',
      body: slice.toString('utf8'),
      bytes: buffer.length,
      truncated,
      elapsedMs: Date.now() - started,
      finalUrl: response.url || parsed.toString()
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new GridUiError(`请求超时（${timeoutMs}ms）：${parsed.toString()}`, 'grid-ui/fetch-timeout', 504);
    }
    throw new GridUiError(
      `请求失败：${error instanceof Error ? error.message : String(error)}`,
      'grid-ui/fetch-failed',
      502
    );
  } finally {
    clearTimeout(timer);
  }
}

function queryOf(req) {
  try {
    return new URL(req.url, 'http://localhost').searchParams;
  } catch (error) {
    return new URLSearchParams();
  }
}

/** 统一的错误响应：GridUiError / ActionError 带语义，其余按 500 处理 */
function sendError(res, error) {
  if (error instanceof GridUiError) {
    sendJson(res, error.status || 400, { ok: false, error: error.message, code: error.code });
    return;
  }
  if (error instanceof ActionError) {
    sendJson(res, 400, { ok: false, error: error.message, code: error.code });
    return;
  }
  sendJson(res, 500, {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: 'grid-ui/internal'
  });
}

/** 把 overlay 脚本注入 DSH 首页：优先 </head>，其次 </body>，最后追加 */
export function injectOverlayScript(html, basePath = BASE_PATH) {
  const tag = `<script defer src="${basePath}/overlay.js"></script>`;
  if (html.includes(`${basePath}/overlay.js`)) return html; // 幂等
  if (html.includes('</head>')) return html.replace('</head>', `${tag}</head>`);
  if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`);
  return html + tag;
}

/** 记录一条非致命警告（拿不到 logger 也不能让激活失败） */
function warn(ctx, message) {
  try {
    const logger = ctx.logger;
    if (logger && typeof logger.warn === 'function') logger.warn(message);
    else if (typeof logger === 'function') logger('dsh-grid-ui').warn(message);
  } catch (error) {
    /* 日志失败不影响运行 */
  }
}

/**
 * 挂载 HTTP 层。同一进程内重复调用只会更新 live，不会重复注册路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ registry: import('./windows.js').WindowRegistry, cache: object, catalog: object }} runtime
 */
export function registerWeb(ctx, runtime) {
  // 无论是否首次挂载，都先让 handler 看到最新的 ctx / runtime
  live = { ctx, runtime };

  if (mounted) return;
  mounted = true;

  const webServer = ctx.webServer;
  if (!webServer) {
    // 没有 webServer 就不可能有 UI：让 apply 抛出去，激活日志能直接看到原因
    throw new Error('dsh-grid-ui 需要 webServer 服务：当前部署没有挂载 @deepseek-ai/dsh-host-webserver');
  }

  /** 注册一条 exact 路由；同名路由已存在时只警告，不拦死插件激活 */
  const keep = (register) => {
    try {
      register();
    } catch (error) {
      warn(ctx, `跳过路由注册：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ---- 静态资源 ----------------------------------------------------------
  const assets = [
    [`${BASE_PATH}/overlay.js`, FILES.overlay],
    [`${BASE_PATH}/assets/bridge.js`, FILES.bridge],
    [`${BASE_PATH}/assets/grid.css`, FILES.css]
  ];

  for (const [path, file] of assets) {
    keep(() =>
      webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          try {
            sendText(res, 200, readAsset(file), CONTENT_TYPES.get(extname(file)) || 'text/plain');
          } catch (error) {
            sendJson(res, 500, { ok: false, error: `无法读取插件资源：${String(error)}` });
          }
        }
      })
    );
  }

  // ---- GET <base>/state：窗口列表 + DSH 状态快照（轮询入口）-------------
  keep(() =>
    webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/state`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const sessionId = queryOf(req).get('sessionId') || undefined;
          sendJson(res, 200, {
            ok: true,
            revision: live.runtime.registry.revision,
            windows: live.runtime.registry.list(),
            pages: live.runtime.registry.listPages(),
            state: await buildState(live.ctx, live.runtime, sessionId)
          });
        } catch (error) {
          sendError(res, error);
        }
      }
    })
  );

  // ---- GET <base>/feed：AI 输出监看（增量）-----------------------------
  // 为什么单独一条路由而不是塞进 /state：动态可能有几十条、每轮都在变，
  // 放进 700ms 的状态轮询会把带宽烧掉。这里支持 ?since=<seq> 只取增量。
  keep(() =>
    webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/feed`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const query = queryOf(req);
          const sessionId = query.get('sessionId') || live.runtime.cache.lastSessionId || undefined;
          const since = Number(query.get('since') || '0');
          sendJson(res, 200, {
            ok: true,
            ...live.runtime.feed.snapshot(sessionId, Number.isFinite(since) ? since : 0)
          });
        } catch (error) {
          sendError(res, error);
        }
      }
    })
  );

  // ---- POST <base>/fetch：网络请求代理（给 iframe 调外部 API 用）-----------
  // 为什么需要它：窗口 iframe 是 sandbox + 不透明源，直接 fetch 外部 API 会被
  // CORS 与页面 CSP 双重拦截。由 Host 代发就绕开了这两件事。
  keep(() =>
    webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/fetch`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await proxyFetch(body, live.runtime.cookies);
          sendJson(res, 200, result);
        } catch (error) {
          sendError(res, error);
        }
      }
    })
  );

  // ---- GET <base>/window?id=：按需拉取单个窗口的 HTML ------------------
  keep(() =>
    webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/window`,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const id = queryOf(req).get('id') || '';
          const window = live.runtime.registry.get(id);
          if (!window) {
            sendJson(res, 404, { ok: false, error: `窗口不存在: ${id}` });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            id: window.id,
            rev: window.rev,
            title: window.title,
            kind: window.kind,
            text: window.text,
            targetId: window.targetId,
            page: window.page,
            url: window.url || '',
            html: window.html
          });
        } catch (error) {
          sendError(res, error);
        }
      }
    })
  );

  // ---- POST <base>/action：iframe 的 dsh-action 落点 --------------------
  keep(() =>
    webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/action`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await handleAction(live.ctx, live.runtime, body);
          sendJson(res, 200, result);
        } catch (error) {
          sendError(res, error);
        }
      }
    })
  );

  // ---- POST <base>/remove：窗口右上角 × 按钮 ----------------------------
  keep(() =>
    webServer.register({
      kind: 'exact',
      path: `${BASE_PATH}/remove`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const removed = live.runtime.registry.remove(String(body.id || ''));
          sendJson(res, 200, {
            ok: true,
            removed,
            revision: live.runtime.registry.revision,
            windows: live.runtime.registry.list()
          });
        } catch (error) {
          sendError(res, error);
        }
      }
    })
  );

  // ---- 首页注入 ----------------------------------------------------------
  keep(() => webServer.tapIndex((html) => injectOverlayScript(html)));
}
