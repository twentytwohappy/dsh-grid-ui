/**
 * dsh-grid-ui · host/electron.js
 * ----------------------------------------------------------------------------
 * 只有「Host 跑在 Electron 主进程里」时才可能用到的能力：
 *   1. 截图：webContents.capturePage() 抓页面，再按窗口的百分比矩形裁剪；
 *   2. 会话：拿到窗口所在的 Electron session，把 cookie 罐挂到 webRequest 上。
 *
 * 为什么需要主进程：`capturePage` 与 `session.webRequest` 都只存在于 Electron 的
 * 主/渲染进程 API 里。DSH Desktop 从某个版本起默认把插件 Host 放进**隔离子进程**
 * （`--type=utility` 的 utilityProcess），那里 `require('electron')` 拿不到这些东西。
 * 本模块因此对每条能力都做**运行期探测**，拿不到就返回明确的错误，而不是在
 * 模块加载阶段抛异常（那会让整个插件激活失败）。
 *
 * 想打开完整能力：启动 DSH 前设置环境变量 DSH_DESKTOP_ISOLATED_HOST=0，
 * 让 Host 与 Electron 主进程同进程（README「截图与 cookie」一节有说明）。
 *
 * 截图的坑（v0.7.1 修）：Windows 上 `capturePage()` 对**某个**窗口可能返回空图
 * （不可见 / 被遮挡 / 刚启动还没首帧）。所以这里不再只盯「最大的那个窗口」，而是
 * 逐个候选窗口尝试「按矩形直接抓」→「整页抓完再裁」两条路，并把每次尝试的状态
 * 拼进错误信息，方便定位到底是哪个窗口抓不到。
 */

import { createRequire } from 'node:module';

import { GridUiError } from './windows.js';

/** 探测结果缓存：进程内不变（主进程 / 隔离子进程是启动时决定的） */
let probeCache;

/**
 * 探测 Electron API 是否可用。
 * @returns {{ ok: true, api: any } | { ok: false, reason: string }}
 */
export function electronApi() {
  if (probeCache !== undefined) return probeCache;
  if (!process.versions || !process.versions.electron) {
    probeCache = {
      ok: false,
      reason:
        'Host 不在 Electron 里运行（纯 Node 部署）。截图与 cookie 共享需要 DSH Desktop 且 Host 与主进程同进程。'
    };
    return probeCache;
  }
  try {
    const require = createRequire(import.meta.url);
    const api = require('electron');
    if (!api || !api.BrowserWindow || !api.session) {
      probeCache = {
        ok: false,
        reason:
          'Electron API 不可用（Host 处于隔离子进程）。请设置环境变量 DSH_DESKTOP_ISOLATED_HOST=0 后重启 DSH。'
      };
      return probeCache;
    }
    probeCache = { ok: true, api };
    return probeCache;
  } catch (error) {
    probeCache = {
      ok: false,
      reason: `加载 Electron API 失败：${
        error instanceof Error ? error.message : String(error)
      }。请设置环境变量 DSH_DESKTOP_ISOLATED_HOST=0 后重启 DSH。`
    };
    return probeCache;
  }
}

/**
 * 列出所有可截图的候选窗口（按内容面积从大到小，最大的usually就是主界面）。
 * @returns {Array<{win: any, wc: any, width: number, height: number, area: number, kind: string}>}
 */
export function candidateWindows() {
  const found = electronApi();
  if (!found.ok) return [];
  let list;
  try {
    list = found.api.BrowserWindow.getAllWindows();
  } catch (error) {
    return [];
  }
  const out = [];
  for (const win of Array.isArray(list) ? list : []) {
    try {
      if (!win || win.isDestroyed()) continue;

      // DSH Desktop 2.x 的界面不是画在窗口自己的 webContents 上，而是挂在
      // `window.contentView` 里的若干 WebContentsView（chromeView 标题栏 +
      // content 主内容）。对窗口的 webContents 调 capturePage() 只会得到
      // 一张全透明的空图 —— 这正是 v0.7.0 截图永远为空的原因。
      // 所以优先枚举子视图，把它们当作候选。
      let views = [];
      try {
        views = win.contentView && win.contentView.children ? win.contentView.children : [];
      } catch (error) {
        views = [];
      }
      // 启动早期视图的 bounds 可能还是 0×0，这时候别把候选丢掉 —— 只把尺寸
      // 记成 0，等真正用的时候（截图 / 装 window-open 处理器）再取实时值。
      let windowSize = [0, 0];
      try {
        const size = win.getContentSize();
        windowSize = [Number(size[0]) || 0, Number(size[1]) || 0];
      } catch (error) {
        windowSize = [0, 0];
      }
      let added = 0;
      for (const view of Array.isArray(views) ? views : []) {
        try {
          const wc = view && view.webContents;
          if (!wc || wc.isDestroyed()) continue;
          let width = 0;
          let height = 0;
          try {
            const bounds = view.getBounds ? view.getBounds() : null;
            width = bounds && bounds.width > 0 ? bounds.width : 0;
            height = bounds && bounds.height > 0 ? bounds.height : 0;
          } catch (error) {
            width = 0;
            height = 0;
          }
          if (!width || !height) {
            width = windowSize[0];
            height = windowSize[1];
          }
          out.push({ win, wc, width, height, area: width * height, kind: 'view' });
          added += 1;
        } catch (error) {
          /* 单个视图探测失败不影响其它候选 */
        }
      }
      if (added > 0) continue;

      // 退路：老式窗口（内容直接画在窗口 webContents 上）
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const [width, height] = windowSize;
      out.push({ win, wc, width, height, area: width * height, kind: 'window' });
    } catch (error) {
      /* 单个窗口探测失败不影响其它窗口 */
    }
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

/**
 * 找到 DSH 主窗口的 webContents（候选里面积最大的那个）。
 * @returns {any | null}
 */
export function mainWebContents() {
  const first = candidateWindows()[0];
  return first ? first.wc : null;
}

/** 主窗口所在的 Electron session（cookie 桥要挂到它上面） */
export function mainSession() {
  const wc = mainWebContents();
  if (wc && wc.session) return wc.session;
  const found = electronApi();
  if (!found.ok) return null;
  try {
    return found.api.session.defaultSession || null;
  } catch (error) {
    return null;
  }
}

/**
 * 把百分比矩形换算成像素矩形（并裁到画面范围内）。
 * @param {{x1:number,y1:number,x2:number,y2:number}} rect
 * @param {number} width 画面宽（像素）
 * @param {number} height 画面高（像素）
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function pixelRect(rect, width, height) {
  const scaleX = width / 200;
  const scaleY = height / 200;
  const x = Math.max(0, Math.min(width - 1, Math.round(rect.x1 * scaleX)));
  const y = Math.max(0, Math.min(height - 1, Math.round(rect.y1 * scaleY)));
  let w = Math.max(1, Math.round((rect.x2 - rect.x1) * scaleX));
  let h = Math.max(1, Math.round((rect.y2 - rect.y1) * scaleY));
  if (x + w > width) w = width - x;
  if (y + h > height) h = height - y;
  return { x, y, width: Math.max(1, w), height: Math.max(1, h) };
}

/**
 * 把 nativeImage 编码成 base64 buffer（并按 maxWidth 缩放）。
 * @returns {{buffer: Buffer, mediaType: string, width: number, height: number}}
 */
function encodeImage(image, options) {
  let out = image;
  const maxWidth =
    Number.isFinite(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : 1600;
  const size = out.getSize();
  if (size.width > maxWidth) {
    out = out.resize({ width: Math.round(maxWidth), quality: 'good' });
  }
  const format = options.format === 'png' ? 'png' : 'jpeg';
  const buffer =
    format === 'png'
      ? out.toPNG()
      : out.toJPEG(Math.min(100, Math.max(30, Number(options.quality) || 85)));
  const finalSize = out.getSize();
  return {
    buffer,
    mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
    width: finalSize.width,
    height: finalSize.height
  };
}

/** 等一会儿（重试截图前给页面一个出首帧的机会）。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取候选窗口的实时尺寸（启动早期拿到的可能是 0，用的时候再问一次）。 */
function liveSize(entry) {
  if (entry.width > 0 && entry.height > 0) return { width: entry.width, height: entry.height };
  for (const read of [
    () => {
      const views = entry.win.contentView ? entry.win.contentView.children || [] : [];
      for (const view of views) {
        if (view && view.webContents === entry.wc && view.getBounds) {
          const bounds = view.getBounds();
          if (bounds && bounds.width > 0 && bounds.height > 0) {
            return { width: bounds.width, height: bounds.height };
          }
        }
      }
      return null;
    },
    () => {
      const size = entry.win.getContentSize();
      const width = Number(size[0]) || 0;
      const height = Number(size[1]) || 0;
      return width > 0 && height > 0 ? { width, height } : null;
    }
  ]) {
    try {
      const got = read();
      if (got) return got;
    } catch (error) {
      /* 继续下一个探测方式 */
    }
  }
  return { width: entry.width || 1, height: entry.height || 1 };
}

/**
 * 截图某个矩形区域（百分比坐标 0..200，相对整个页面视口）。
 *
 * 尝试顺序（对每个候选窗口）：
 *   1. `capturePage(pixelRect)` —— 直接抓目标矩形，最省内存；
 *   2. `capturePage()` 整页 + `crop()` —— 有些平台只支持整页抓；
 *   3. 等一下重来一轮（刚启动/刚切换页面时首帧可能还没出来）。
 *
 * @param {{x1: number, y1: number, x2: number, y2: number}} rect
 * @param {{format?: 'png'|'jpeg', quality?: number, maxWidth?: number}} [options]
 * @returns {Promise<{buffer: Buffer, mediaType: string, width: number, height: number}>}
 */
export async function captureRegion(rect, options = {}) {
  const found = electronApi();
  if (!found.ok) throw new GridUiError(found.reason, 'grid-ui/no-electron', 501);

  const windows = candidateWindows();
  if (windows.length === 0) {
    throw new GridUiError('找不到可截图的 DSH 窗口（窗口可能还没创建）', 'grid-ui/no-window', 503);
  }

  const notes = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const entry of windows) {
      const { win, wc, kind } = entry;
      const { width, height } = liveSize(entry);
      const crop = pixelRect(rect, width, height);

      // 第一次尝试：直接按矩形抓
      try {
        const image = await wc.capturePage(crop);
        if (image && !image.isEmpty()) return encodeImage(image, options);
      } catch (error) {
        notes.push(
          `#${wc.id} rect: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // 第二次尝试：整页抓完再裁
      try {
        const full = await wc.capturePage();
        if (full && !full.isEmpty()) {
          const size = full.getSize();
          return encodeImage(full.crop(pixelRect(rect, size.width, size.height)), options);
        }
      } catch (error) {
        notes.push(`#${wc.id} full: ${error instanceof Error ? error.message : String(error)}`);
      }

      let state = 'unknown';
      try {
        state = `visible=${win.isVisible()} minimized=${win.isMinimized()} ${width}x${height}`;
      } catch (error) {
        /* 状态探测失败也不影响重试 */
      }
      notes.push(`#${wc.id}(${kind}) 空图（${state}）`);
    }
    if (attempt < 3) await delay(150 * attempt);
  }

  throw new GridUiError(
    `截图为空：${notes.slice(0, 8).join('；') || '没有可用窗口'}`,
    'grid-ui/capture-empty',
    503
  );
}

/* ------------------------------------------------------------------------- */
/* 网址窗口的 target=_blank / window.open 落地到窗口自身（v0.7.3）            */
/* ------------------------------------------------------------------------- */

/** 已经装过重定向器的 webContents（重复激活插件时避免层层套娃） */
const patchedContents = new WeakSet();

/** 递归收集 webContents 里的所有 frame（Electron 各版本字段不完全一致，做兜底）。 */
function framesOf(wc) {
  const out = [];
  let main = null;
  try {
    main = wc.mainFrame || null;
  } catch (error) {
    main = null;
  }
  if (!main) return out;
  const seen = new Set();
  const walk = (frame, depth) => {
    if (!frame || depth > 4 || seen.has(frame)) return;
    seen.add(frame);
    out.push(frame);
    let kids = [];
    try {
      kids = typeof frame.framesInSubtree === 'function'
        ? Array.from(frame.framesInSubtree).filter((item) => item !== frame)
        : Array.from(frame.frames || []);
    } catch (error) {
      kids = [];
    }
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(main, 0);
  // 有些环境（或测试桩）拿不到 frames 列表，但 focusedFrame 仍然可用
  try {
    const focused = wc.focusedFrame;
    if (focused && !seen.has(focused)) out.push(focused);
  } catch (error) {
    /* 没有焦点帧就算了 */
  }
  return out;
}

function urlOf(frame) {
  try {
    return String(frame.url || '');
  } catch (error) {
    return '';
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (error) {
    return '';
  }
}

/**
 * 找一个「来自网址窗口」的发起帧：优先级
 *   1. 焦点所在的子 frame（Electron 记录的 focusedFrame）；
 *   2. 与目标地址同 host 的子 frame（焦点丢失时的兜底）；
 *   3. 唯一的那个 http(s) 子 frame。
 * 主 frame（DSH 自己的界面）永远跳过，交回给原来的外链行为。
 *
 * @param {any} wc 宿主 webContents
 * @param {string} [targetHref] 目标地址（可选，用于同源兜底）
 * @returns {any | null}
 */
function openerFrame(wc, targetHref) {
  let main = null;
  try {
    main = wc.mainFrame || null;
  } catch (error) {
    main = null;
  }
  const webFrames = framesOf(wc).filter((frame) => {
    if (frame === main) return false;
    return /^https?:/i.test(urlOf(frame));
  });
  if (webFrames.length === 0) return null;

  let focused = null;
  try {
    focused = wc.focusedFrame || null;
  } catch (error) {
    focused = null;
  }
  if (focused && webFrames.includes(focused)) return focused;

  const wantedHost = targetHref ? hostOf(targetHref) : '';
  if (wantedHost) {
    const sameHost = webFrames.filter((frame) => hostOf(urlOf(frame)) === wantedHost);
    if (sameHost.length > 0) return sameHost[0];
  }
  return webFrames.length === 1 ? webFrames[0] : null;
}

/** 让某个 frame 就地跳到目标地址（不新开窗口，也不甩给系统浏览器） */
function navigateFrameInPlace(frame, href) {
  try {
    if (!frame || typeof frame.executeJavaScript !== 'function') return false;
    const code = `location.assign(${JSON.stringify(href)})`;
    Promise.resolve(frame.executeJavaScript(code, true)).catch(() => {});
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 造一个 window-open 处理器（纯函数，便于单测）。
 *
 * @param {any} wc 宿主 webContents（只用到 focusedFrame / mainFrame）
 * @param {{openExternal?: (url: string) => any} | null} shell
 * @returns {(details: {url?: string}) => {action: 'deny'}}
 */
export function createWindowOpenHandler(wc, shell) {
  return (details) => {
    let target = null;
    try {
      target = new URL(String((details && details.url) || ''));
    } catch (error) {
      target = null;
    }
    if (!target) return { action: 'deny' };

    const web = target.protocol === 'http:' || target.protocol === 'https:';
    const frame = web ? openerFrame(wc, target.href) : null;
    if (frame && navigateFrameInPlace(frame, target.href)) return { action: 'deny' };

    // 其余情况：复刻 DSH 原来的行为（外链交给系统浏览器），不破坏原有体验
    if ((web || target.protocol === 'mailto:') && shell && typeof shell.openExternal === 'function') {
      Promise.resolve(shell.openExternal(target.href)).catch(() => {});
    }
    return { action: 'deny' };
  };
}

/**
 * 把 DSH 主界面的 window-open 处理器换成「网址窗口原地跳转」版。
 *
 * 背景：DSH Desktop 自己的处理器（lib/electron-runtime-*.js）对所有
 * `window.open` / `target=_blank` 一律 `shell.openExternal()` + deny，
 * 于是嵌在网址窗口里的链接会把**系统默认浏览器**弹出来。
 *
 * 这里的策略：
 *   - 发起帧是网址窗口（焦点所在的子 frame）且目标是 http/https → 让该 frame
 *     自己 `location.assign()`，链接就在窗口里展开；
 *   - 其它情况（DSH 自己的界面）→ 保持原来的开外部浏览器行为；
 *   - 一律 deny 新窗口。
 *
 * 注意：插件激活时 DSH 主窗口可能还没布局完（视图 bounds 还是 0），所以
 * 必须能被反复调用：已经装过的 webContents 会跳过。
 *
 * @returns {{ok: boolean, patched?: number, reason?: string}}
 */
export function installWindowOpenRedirector() {
  const found = electronApi();
  if (!found.ok) return { ok: false, reason: found.reason };

  const candidates = candidateWindows();
  if (candidates.length === 0) {
    return { ok: false, reason: '找不到 DSH 主界面（窗口可能还没创建）' };
  }

  let patched = 0;
  const problems = [];
  for (const entry of candidates) {
    const wc = entry.wc;
    if (!wc || wc.isDestroyed()) continue;
    if (patchedContents.has(wc)) continue;
    try {
      wc.setWindowOpenHandler(createWindowOpenHandler(wc, found.api.shell));
      patchedContents.add(wc);
      patched += 1;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (patched === 0 && problems.length > 0) {
    return { ok: false, reason: `安装 window-open 重定向失败：${problems[0]}` };
  }
  return { ok: true, patched };
}

