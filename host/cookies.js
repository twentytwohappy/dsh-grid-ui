/**
 * dsh-grid-ui · host/cookies.js
 * ----------------------------------------------------------------------------
 * 跨窗口共享的 cookie 罐（cookie jar）+ 把罐子接到 Electron 会话上的桥。
 *
 * 为什么需要它：
 *   - 网址窗口（iframe.src）与 `dsh.http` 是两条完全不同的网络路径。iframe 的
 *     cookie 归 Chromium 会话管，dsh.http 走 Node 的 fetch，两边默认互不相干；
 *     而且 127.0.0.1 页面里嵌第三方站点属于「第三方 cookie」，现代 Chromium 默认
 *     就拦掉一部分。
 *   - 这里维护一份进程内的 cookie 罐：所有窗口、所有 dsh.http 请求共用同一份。
 *     同时在 Electron 主进程里挂两个 webRequest 监听（仅当 Host 跑在主进程）：
 *       onBeforeSendHeaders → 把罐里该 URL 的 cookie 塞进请求头
 *       onHeadersReceived   → 把响应的 Set-Cookie 收进罐（并写回 Electron 会话，
 *                             这样下次启动还在）
 *     于是 A 窗口登录、B 窗口直接是登录态；dsh.http 也带上同一份登录态。
 *
 * 纯函数（parseSetCookie / CookieJar）不依赖 Electron，可在测试里直接跑。
 */

/** 单个 cookie 的上限，防止某个站点无限灌数据 */
const MAX_COOKIES = 2000;
/** 单条 cookie 值的上限 */
const MAX_VALUE_LENGTH = 8192;

/**
 * 解析一条 `Set-Cookie` 头。
 * @param {string} header 例如 `SESSDATA=abc; Path=/; Domain=.bilibili.com; Secure; HttpOnly`
 * @param {string} requestUrl 收到这条响应的请求地址（用来补默认 domain / path）
 * @returns {{name: string, value: string, domain: string, hostOnly: boolean, path: string,
 *   secure: boolean, httpOnly: boolean, expires: number|null, sameSite: string|null} | null}
 */
export function parseSetCookie(header, requestUrl) {
  if (typeof header !== 'string') return null;
  const parts = header.split(';');
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name || name.length > 256) return null;
  if (value.length > MAX_VALUE_LENGTH) return null;

  let url;
  try {
    url = new URL(requestUrl);
  } catch (error) {
    return null;
  }

  let domain = '';
  let hostOnly = true;
  let path = '';
  let secure = false;
  let httpOnly = false;
  let expires = null;
  let sameSite = null;

  for (const raw of parts) {
    const part = raw.trim();
    const pivot = part.indexOf('=');
    const key = (pivot === -1 ? part : part.slice(0, pivot)).trim().toLowerCase();
    const val = pivot === -1 ? '' : part.slice(pivot + 1).trim();
    if (key === 'domain' && val) {
      domain = val.replace(/^\./, '').toLowerCase();
      hostOnly = false;
    } else if (key === 'path' && val.startsWith('/')) {
      path = val;
    } else if (key === 'secure') {
      secure = true;
    } else if (key === 'httponly') {
      httpOnly = true;
    } else if (key === 'samesite') {
      sameSite = val.toLowerCase() || null;
    } else if (key === 'max-age') {
      const seconds = Number(val);
      if (Number.isFinite(seconds)) expires = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
    } else if (key === 'expires') {
      const at = Date.parse(val);
      if (Number.isFinite(at)) expires = at;
    }
  }

  if (!domain) domain = url.hostname.toLowerCase();
  if (!path) path = defaultPath(url.pathname);

  return { name, value, domain, hostOnly, path, secure, httpOnly, expires, sameSite };
}

/** RFC 6265 的默认路径：目录部分 */
function defaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return pathname.slice(0, lastSlash);
}

/** cookie 的 domain 是否覆盖某个主机名 */
function domainMatches(hostname, cookie) {
  const host = String(hostname || '').toLowerCase();
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

/** cookie 的 path 是否覆盖某个路径 */
function pathMatches(pathname, cookiePath) {
  if (cookiePath === '/') return true;
  if (!pathname.startsWith(cookiePath)) return false;
  if (pathname.length === cookiePath.length) return true;
  return pathname[cookiePath.length] === '/' || cookiePath.endsWith('/');
}

/** 跨窗口共享的 cookie 罐 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, ReturnType<typeof parseSetCookie>>} key = `${domain}\u0000${path}\u0000${name}` */
    this.map = new Map();
  }

  /** 存一条（同 name+domain+path 覆盖；Max-Age<=0 / 已过期则删除） */
  store(cookie) {
    if (!cookie || !cookie.name) return false;
    const key = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`;
    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      return this.map.delete(key);
    }
    if (this.map.size >= MAX_COOKIES && !this.map.has(key)) return false;
    this.map.set(key, cookie);
    return true;
  }

  /** 用一条原始 Set-Cookie 头写入 */
  storeHeader(header, requestUrl) {
    return this.store(parseSetCookie(header, requestUrl));
  }

  /** 返回覆盖该 URL 且未过期的 cookie（按 path 长度降序，符合 RFC 的发送顺序） */
  match(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return [];
    }
    const found = [];
    for (const cookie of this.map.values()) {
      if (!domainMatches(parsed.hostname, cookie)) continue;
      if (!pathMatches(parsed.pathname, cookie.path)) continue;
      if (cookie.secure && parsed.protocol !== 'https:') continue;
      if (cookie.expires !== null && cookie.expires <= Date.now()) continue;
      found.push(cookie);
    }
    found.sort((a, b) => b.path.length - a.path.length);
    return found;
  }

  /** 该 URL 应带的 `Cookie` 头（没有则空串） */
  header(url) {
    return this.match(url)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  /** 列出 cookie；`filter.url` 或 `filter.domain` 二选一 */
  list(filter = {}) {
    const out = [];
    const domain = typeof filter.domain === 'string' ? filter.domain.replace(/^\./, '').toLowerCase() : '';
    let targetHost = '';
    if (typeof filter.url === 'string' && filter.url) {
      try {
        targetHost = new URL(filter.url).hostname.toLowerCase();
      } catch (error) {
        targetHost = '';
      }
    }
    for (const cookie of this.map.values()) {
      if (domain && cookie.domain !== domain && !cookie.domain.endsWith(`.${domain}`)) continue;
      if (targetHost && !domainMatches(targetHost, cookie)) continue;
      if (cookie.expires !== null && cookie.expires <= Date.now()) continue;
      out.push({ ...cookie });
    }
    return out;
  }

  /** 删除某 URL 下的 cookie（可按名字） */
  remove(url, name) {
    const victims = this.match(url).filter((cookie) => !name || cookie.name === name);
    for (const cookie of victims) {
      this.map.delete(`${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`);
    }
    return victims.length;
  }

  clear() {
    const size = this.map.size;
    this.map.clear();
    return size;
  }
}

/**
 * 把 cookie 罐接到 Electron 会话上（主进程才有 webRequest）。
 * 只对「已挂接的站点」生效：只给我们的网址窗口所在的 origin 注入 / 收集，
 * 不影响 DSH 自身与其它站点的请求。
 *
 * @param {{ session: any, jar: CookieJar, origins: () => Set<string>, onSetCookie?: (cookie: object, url: string) => void }} options
 * @returns {{ detach: () => void }}
 */
export function attachSessionCookies(options) {
  const { session, jar, origins } = options;
  if (!session || !session.webRequest) {
    return { detach: () => {} };
  }

  const matches = (url) => {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch (error) {
      return false;
    }
    return origins().has(origin);
  };

  const onBeforeSendHeaders = (details, callback) => {
    try {
      if (!matches(details.url)) {
        callback({});
        return;
      }
      const jarHeader = jar.header(details.url);
      if (!jarHeader) {
        callback({});
        return;
      }
      const headers = { ...(details.requestHeaders || {}) };
      const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'cookie');
      if (existingKey) {
        const merged = `${headers[existingKey]}; ${jarHeader}`;
        headers[existingKey] = merged;
      } else {
        headers.Cookie = jarHeader;
      }
      callback({ requestHeaders: headers });
    } catch (error) {
      callback({});
    }
  };

  const onHeadersReceived = (details, callback) => {
    try {
      if (matches(details.url)) {
        const raw = details.responseHeaders || {};
        for (const [key, value] of Object.entries(raw)) {
          if (key.toLowerCase() !== 'set-cookie') continue;
          const list = Array.isArray(value) ? value : [value];
          for (const header of list) {
            const cookie = parseSetCookie(header, details.url);
            if (!cookie) continue;
            jar.store(cookie);
            if (typeof options.onSetCookie === 'function') {
              try {
                options.onSetCookie(cookie, details.url);
              } catch (error) {
                /* 回写会话失败不影响注入链 */
              }
            }
          }
        }
      }
      callback({});
    } catch (error) {
      callback({});
    }
  };

  const filter = { urls: ['http://*/*', 'https://*/*'] };
  session.webRequest.onBeforeSendHeaders(filter, onBeforeSendHeaders);
  session.webRequest.onHeadersReceived(filter, onHeadersReceived);

  return {
    detach() {
      try {
        session.webRequest.onBeforeSendHeaders(null);
        session.webRequest.onHeadersReceived(null);
      } catch (error) {
        /* 会话正在销毁时忽略 */
      }
    }
  };
}
