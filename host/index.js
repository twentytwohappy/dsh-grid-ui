/**
 * dsh-grid-ui · host/index.js
 * ----------------------------------------------------------------------------
 * 插件入口（Host 半）。整体架构：
 *
 *   ┌──────────────────────── DSH Host 进程 ────────────────────────┐
 *   │ tools.register(create/update/remove_ui_window)  → AI 调用      │
 *   │ WindowRegistry（内存窗口表：坐标 + HTML + revision）            │
 *   │ webServer.register(/dsh-grid-ui/*)   ← overlay 轮询 / iframe 动作│
 *   │ webServer.tapIndex(...)              → 向首页注入 overlay 脚本   │
 *   └───────────────────────────────────────────────────────────────┘
 *                              │ 同源 HTTP
 *   ┌──────────────────────── 浏览器 ───────────────────────────────┐
 *   │ client/overlay.js：网格层 + 窗口层 + 悬浮球 + 模式切换          │
 *   │   每个窗口 = fixed + 百分比定位的 div + sandbox iframe(srcdoc) │
 *   │   iframe 内 client/bridge.js：window.dsh.* ↔ postMessage       │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * 说明：需求文档里提到「通过 shell.overlay 把窗口指令下发给 client 半」。
 * 本版本改用「Host 提供状态接口 + 注入式 overlay 轮询」，原因见 README
 * 「与需求文档的差异」一节：静态 client 插件包在当前 DSH 里无法与 Host 半
 * 建立 RPC（ModuleLoader 的 factory 只拿到 require，没有 host.call）。
 */

import { createCatalog } from './catalog.js';
import { CookieJar, attachSessionCookies } from './cookies.js';
import { electronApi, installWindowOpenRedirector, mainSession } from './electron.js';
import { createFeed } from './feed.js';
import { PAGES_RECORD_KEY, openWindowDomain, pagesToRecord, restoreInto, toRecord } from './store.js';
import { registerTools } from './tools.js';
import { BASE_PATH, registerWeb } from './web.js';
import { MAX_PAGES, MAX_WINDOWS_PER_PAGE, WindowRegistry } from './windows.js';

/** 插件名（与 cordis.patch.yml 的 row name 一致） */
export const name = 'dsh-grid-ui';

/**
 * 依赖注入：没有这两个服务就不激活插件。
 *  - webServer：注入前端脚本 + 提供 HTTP 接口
 *  - tools：向模型注册 create/update/remove_ui_window
 */
export const inject = ['webServer', 'tools'];

/** 安全日志：不同 DSH 版本的 logger 形态不同（对象或工厂函数），两种都兼容 */
function logInfo(ctx, message) {
  try {
    const logger = ctx.logger;
    if (logger && typeof logger.info === 'function') {
      logger.info(message);
      return;
    }
    if (typeof logger === 'function') {
      logger('dsh-grid-ui').info(message);
    }
  } catch (error) {
    /* 日志失败不影响功能 */
  }
}

/**
 * 插件激活入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** 窗口表：进程内有效，插件卸载时清空 */
  const registry = new WindowRegistry();

  /** 跨请求的轻量缓存：最近一次模型选择、最近一次会话 id、当前全屏面板、最近一次权限写入 */
  const cache = {
    selection: undefined,
    lastSessionId: undefined,
    /** @type {{ id: string, at: number } | null} 当前全屏打开的面板（客户端据此渲染） */
    panel: null,
    /** @type {{ sessionId: string, value: string, at: number } | null} 最近一次 set_permission 写成功的预设 */
    permission: null
  };

  /**
   * 跨窗口共享的 cookie 罐：所有网址窗口与 dsh.http 共用一份，见 host/cookies.js。
   */
  const cookies = new CookieJar();

  /**
   * 运行期句柄：窗口表 + 缓存 + 模型/权限目录 + 实时动态流 + cookie 罐。
   * 路由路径是固定的（见 web.js 顶部注释），本对象通过 registerWeb 的 `live` 暴露给
   * 已注册的 handler，因此插件重载后 handler 会自动用上新的 registry。
   */
  const runtime = { registry, cache, catalog: createCatalog(ctx), feed: createFeed(), cookies };

  // 0) 订阅会话事件流：把 turn / assistant / tool 事件收成「动态」，
  //    供 iframe 里的页面用 dsh.getFeed() 监看 AI 的输出进度
  //    （`session/event` 的用法参考已安装的 dsh-whale-widget：ctx.on('session/event', (session, event) => …)）
  if (typeof ctx.on === 'function') {
    ctx.effect(() =>
      ctx.on('session/event', (session, event) => {
        try {
          runtime.feed.ingest(session, event);
        } catch (error) {
          /* 监看流是辅助功能，任何解析异常都不该影响会话本身 */
        }
      })
    );
  }

  // 0) 持久化：把窗口表接到 DSH 的领域存储上，并把上次的窗口装回内存。
  //    失败（profile 没装 storageDomain、介质损坏等）只降级为纯内存模式，不影响其它功能。
  attachPersistence(ctx, registry);

  // 1) HTTP 接口 + 首页脚本注入（同进程内只挂载一次）
  registerWeb(ctx, runtime);

  // 2) 模型工具
  registerTools(ctx, runtime);

  // 2.5) cookie 桥：只有 Host 与 Electron 主进程同进程时才可用（见 host/electron.js）
  attachCookieBridge(ctx, runtime);

  // 2.6) 网址窗口里的 target=_blank / window.open 就地跳转，别弹系统浏览器
  attachWindowOpenRedirector(ctx);

  // 3) 卸载时释放窗口（iframe 由浏览器在页面刷新/切走时自行回收）
  ctx.effect(() => () => {
    registry.clear();
  });

  logInfo(
    ctx,
    `已就绪：overlay 注入 ${BASE_PATH}/overlay.js（每页窗口上限 ${MAX_WINDOWS_PER_PAGE} 个、最多 ${MAX_PAGES} 页）`
  );
}

/**
 * 让网址窗口里的外链跳转留在窗口里（v0.7.3）。
 *
 * DSH Desktop 自己的 window-open 处理器会把所有新窗口链接交给系统浏览器；
 * 嵌在 iframe 里的站点点一个 `target=_blank` 链接就会"跳出插件"。这里在单进程
 * 模式下替换掉那个处理器：来自网址窗口的跳转就地 load，其它情况保持原行为。
 *
 * 关键点：插件激活时 DSH 主窗口往往还没布局完（视图 bounds 为 0，甚至
 * `contentView.children` 还没挂），一次性安装会直接失败 —— 之前就是这个原因
 * 让「点了还是在系统浏览器里打开」。所以这里退避重试 + 定期巡检，直到装上为止。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function attachWindowOpenRedirector(ctx) {
  let installed = false;
  let attempts = 0;
  let lastReason = '';

  const attempt = () => {
    attempts += 1;
    const result = installWindowOpenRedirector();
    if (result.ok) {
      if (result.patched > 0) {
        installed = true;
        logInfo(
          ctx,
          `网址窗口链接已在窗口内跳转（不再弹系统浏览器；已接管 ${result.patched} 个渲染层）`
        );
      }
      return true;
    }
    lastReason = result.reason || '';
    return false;
  };

  if (attempt()) {
    /* 第一次就成功，仍然保留巡检：DSH 重建渲染进程后 webContents 会换新的 */
  }

  // 启动早期：退避重试（窗口创建 / 布局完成的时间点不确定）
  const delays = [120, 400, 900, 1600, 2600, 4200, 7000, 11000];
  const timers = delays.map((ms) =>
    setTimeout(() => {
      attempt();
    }, ms)
  );

  // 新窗口/新渲染进程创建后补装一次（DSH 在创建时同步装自己的处理器，这里稍后覆盖）
  const found = electronApi();
  if (found.ok && found.api.app && typeof found.api.app.on === 'function') {
    try {
      found.api.app.on('browser-window-created', () => {
        setTimeout(() => attempt(), 250);
      });
    } catch (error) {
      /* 事件挂不上也不影响退避重试 */
    }
  }

  // 定期巡检（5s 一次、最多 10 分钟）：渲染进程崩溃重建 / 新开窗口后自动补装
  let beats = 0;
  const heartbeat = setInterval(() => {
    beats += 1;
    if (beats > 120) {
      clearInterval(heartbeat);
      return;
    }
    attempt();
  }, 5000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer);
    clearInterval(heartbeat);
  });

  if (!installed) {
    logInfo(
      ctx,
      `网址窗口外链重定向暂未生效（${lastReason || '窗口还没创建'}），已安排重试`
    );
  }
}

/**
 * 把共享 cookie 罐接到 Electron 会话上。
 *
 * 只在「Host 跑在主进程」时成立：隔离的 utilityProcess 里 `require('electron')` 拿不到
 * session.webRequest。失败时只记一条警告 —— cookie 罐本身仍然对 dsh.http 生效，
 * 只是不能被浏览器请求自动带上了。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ registry: WindowRegistry, cookies: CookieJar }} runtime
 */
function attachCookieBridge(ctx, runtime) {
  const found = electronApi();
  if (!found.ok) {
    logInfo(ctx, `cookie 自动注入未启用（${found.reason}）；dsh.http 仍会带上共享 cookie 罐`);
    return;
  }
  const session = mainSession();
  if (!session) {
    logWarn(ctx, 'cookie 自动注入未启用：找不到 Electron 会话');
    return;
  }

  /** 只对网址窗口所在的 origin 注入 / 收集，不影响 DSH 自身的请求 */
  const origins = () => {
    const set = new Set();
    for (const win of runtime.registry.list()) {
      if (!win.url) continue;
      try {
        set.add(new URL(win.url).origin);
      } catch (error) {
        /* 忽略非法地址 */
      }
    }
    return set;
  };

  try {
    const bridge = attachSessionCookies({
      session,
      jar: runtime.cookies,
      origins,
      // 顺手写回 Chromium 自己的 cookie 存储，这样重启后登录态还在
      onSetCookie: (cookie) => {
        const url = `https://${cookie.domain}${cookie.path}`;
        Promise.resolve(
          session.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.hostOnly ? undefined : `.${cookie.domain}`,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            ...(cookie.expires === null ? {} : { expirationDate: Math.floor(cookie.expires / 1000) }),
            ...(cookie.sameSite === 'lax' || cookie.sameSite === 'strict' || cookie.sameSite === 'none'
              ? { sameSite: cookie.sameSite }
              : {})
          })
        ).catch(() => {
          /* 回写失败不影响注入链 */
        });
      }
    });
    ctx.effect(() => () => bridge.detach());
    logInfo(ctx, 'cookie 共享已启用：网址窗口与 dsh.http 共用同一份 cookie 罐');
  } catch (error) {
    logWarn(ctx, `cookie 共享挂接失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 接上持久化：注册表写盘 + 启动恢复。
 *
 * 为什么异步：`storageDomain.open()` 要读介质并逐条校验 schema，是 async 的；
 * 但 apply() 不该因此变成 async（激活阶段做 IO 会拖慢启动，且失败会影响工具注册）。
 * 所以这里先注册工具/路由，等介质就绪后自己把窗口装回来——在此期间
 * GET /state 返回空列表，装回完成后 revision 变化，浏览器下一轮轮询就会建窗口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {WindowRegistry} registry
 */
function attachPersistence(ctx, registry) {
  openWindowDomain(ctx)
    .then(async (tables) => {
      const { loaded, skipped, pages } = restoreInto(tables, registry);
      // 先装回再接管写盘，避免恢复过程触发一次无意义的全量回写
      registry.setSink({
        put: (win) => tables.windows.put(win.id, toRecord(win)),
        remove: (id) => tables.windows.delete(id),
        putPages: (list) => tables.pages.put(PAGES_RECORD_KEY, pagesToRecord(list.map((p) => p.name)))
      });
      const skippedText = skipped > 0 ? `，跳过 ${skipped} 条无法恢复的记录` : '';
      logInfo(
        ctx,
        loaded > 0 || pages > 0
          ? `已从磁盘恢复 ${loaded} 个窗口、${registry.pageCount} 页${skippedText}（storageDomain: dsh_grid_ui）`
          : `窗口持久化已就绪（当前没有已保存的窗口${skippedText}）`
      );
    })
    .catch((error) => {
      // 降级：窗口只存在于内存中，重启后丢失 —— 但插件其它功能完全可用
      logWarn(
        ctx,
        `窗口持久化不可用，已降级为纯内存模式（重启后窗口会丢失）：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
}

/** 非致命警告 */
function logWarn(ctx, message) {
  try {
    const logger = ctx.logger;
    if (logger && typeof logger.warn === 'function') logger.warn(message);
    else if (typeof logger === 'function') logger('dsh-grid-ui').warn(message);
  } catch (error) {
    /* 日志失败不影响功能 */
  }
}

export { WindowRegistry } from './windows.js';
