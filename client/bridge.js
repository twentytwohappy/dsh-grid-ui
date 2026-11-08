/* ============================================================================
 * dsh-grid-ui · client/bridge.js
 * ----------------------------------------------------------------------------
 * 这个文件不是浏览器可直接执行的（不是 ES module，也不会被 Host import），
 * 它是**注入到每个沙箱 iframe 的 <head> 最前面的脚本源码字符串**。
 * host/web.js 把本文件内容作为静态资源提供，client/overlay.js 通过
 * <script> 标签原样塞进 srcdoc。
 *
 * 职责（需求 3.4 / 3.5 + v0.4 扩展）：
 *   1. 向父窗口（DSH 页面）发送 { type: 'dsh-action', action, payload, requestId? }。
 *   2. 接收父窗口推送的 { type: 'dsh-state', state } 并分发给订阅者。
 *   3. 接收 { type: 'dsh-result', requestId, result } 完成 request() 的 Promise。
 *   4. 暴露 window.dsh 给 AI 生成的 HTML 使用（覆盖 DSH 的主要能力）。
 *
 * 安全约束：iframe 的 sandbox 是 "allow-scripts allow-forms"（无 allow-same-origin），
 * 因此本脚本与父页面属于**不同源**，只能通过 postMessage 通信，targetOrigin 先用 '*'。
 * ========================================================================== */
(function () {
  'use strict';

  // 双重注入保护：AI 生成的 HTML 里若自己写了 dsh，我们优先保留我们的实现
  if (window.dsh && window.dsh.__dshGridUi === true) return;

  var listeners = [];
  var state = null;
  /** requestId → {resolve, reject, timer} */
  var pending = Object.create(null);
  var seq = 0;

  function nextRequestId() {
    seq += 1;
    return 'dsh-' + Date.now().toString(36) + '-' + seq;
  }

  /** 向 DSH 父页面发一条指令。targetOrigin 固定 '*'（v0.4 仍未收紧）。 */
  function post(action, payload, requestId) {
    var message = { type: 'dsh-action', action: action, payload: payload || {} };
    if (requestId) message.requestId = requestId;
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      console.error('[dsh] postMessage failed:', error);
    }
  }

  /**
   * 发一条指令并等父页面回 { type: 'dsh-result', requestId }。
   * @param {string} action
   * @param {object} [payload]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} resolve 的是 Host 的 action 结果对象
   */
  function request(action, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = nextRequestId();
      var timer = window.setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('DSH 没有响应（' + action + ' 超时）'));
        }
      }, typeof timeoutMs === 'number' ? timeoutMs : 20000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      post(action, payload, id);
    });
  }

  /** 把最新状态分发给所有订阅者；单个订阅者抛错不影响其他人。 */
  function dispatch(next) {
    state = next;
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](state);
      } catch (error) {
        console.error('[dsh] onState listener failed:', error);
      }
    }
  }

  // ---- 接收 DSH 推送的消息 ------------------------------------------------
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'dsh-state') {
      dispatch(data.state || null);
      return;
    }

    if (data.type === 'dsh-result' && data.requestId && pending[data.requestId]) {
      var entry = pending[data.requestId];
      delete pending[data.requestId];
      window.clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(String(data.error)));
      else entry.resolve(data.result);
    }
  });

  // ---- 对外 API -----------------------------------------------------------
  var dsh = {
    __dshGridUi: true,
    /** 库版本，便于页面做特性探测 */
    version: '0.7.6',

    // ------------------------------------------------------------ 通用
    /**
     * 发送任意 action 并等待结果（逃生通道 + 高级用法）。
     * @param {string} action
     * @param {object} [payload]
     * @returns {Promise<any>}
     */
    request: request,

    /** 只发不等（例如 toast 这类没有返回值的动作）。 */
    action: function (action, payload) {
      post(action, payload);
    },

    /**
     * 请求当前状态。立刻返回本地缓存（可能为 null），父页面随后会推回最新值。
     * @returns {object|null}
     */
    getState: function () {
      post('get_state');
      return state;
    },

    /**
     * 监听 DSH 状态更新（含画布页、当前面板、模型、权限等）。
     * @param {(state: object) => void} callback
     * @returns {() => void} 取消订阅函数
     */
    onState: function (callback) {
      if (typeof callback !== 'function') return function () {};
      listeners.push(callback);
      if (state) {
        try {
          callback(state);
        } catch (error) {
          console.error('[dsh] onState initial call failed:', error);
        }
      }
      return function () {
        var index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },

    /** 读取最近一次推送里带的目录（模型 / 权限 / 思考强度）。 */
    getCatalog: function () {
      return state && state.catalog ? state.catalog : null;
    },

    /** 顶部轻提示（不依赖 DSH，纯前端）。 */
    toast: function (text) {
      post('toast', { text: String(text == null ? '' : text) });
    },

    // ------------------------------------------------------------ 模型 / 强度 / 权限
    /** @param {string} level */
    setThinkingLevel: function (level) {
      return request('set_thinking_level', { level: String(level) });
    },

    /**
     * 切换模型。
     * @param {string} provider
     * @param {string} model
     */
    setModel: function (provider, model) {
      return request('set_model', { provider: String(provider), model: String(model) });
    },

    /**
     * 切换权限预设（取值见 state.catalog.permissions[].value）。
     * @param {string} preset
     */
    setPermission: function (preset) {
      return request('set_permission', { preset: String(preset) });
    },

    /** 刷新模型 / 权限 / 思考强度目录。 */
    refreshCatalog: function () {
      return request('catalog', { force: true });
    },

    // ------------------------------------------------------------ 会话
    /**
     * 发一条用户消息（可选带图片）。
     * @param {string} text
     * @param {Array<{data:string, mediaType:string, name?:string}>} [images] 裸 base64
     */
    sendMessage: function (text, images) {
      return request('send_message', {
        text: String(text == null ? '' : text),
        images: Array.isArray(images) ? images : []
      });
    },

    /** 中止当前会话正在进行的回合。 */
    cancelTurn: function () {
      return request('cancel', {});
    },

    /** 列出可见会话。 */
    listSessions: function () {
      return request('list_sessions', {});
    },

    /** 新建一个会话（返回 { sessionId }）。 */
    newSession: function () {
      return request('new_session', {});
    },

    /** 重命名会话。 */
    renameSession: function (sessionId, title) {
      return request('rename_session', { sessionId: sessionId, title: String(title) });
    },

    /** 搜索会话内容。 */
    searchSessions: function (query) {
      return request('search_sessions', { query: String(query) });
    },

    /**
     * 读取会话历史（最近 maxMessages 条事件）。会话需处于运行中。
     * @param {{sessionId?: string, maxMessages?: number}} [options]
     */
    readHistory: function (options) {
      var opts = options || {};
      return request('read_history', {
        sessionId: opts.sessionId,
        maxMessages: opts.maxMessages
      });
    },

    /**
     * 读取「AI 输出监看」的增量动态。
     *
     * Host 订阅了 DSH 的会话事件流，把 user / assistant / tool / tool-result /
     * turn 事件收成一条条动态；这里按 seq 增量取，适合做「实时输出面板」。
     *
     * @param {{since?: number, sessionId?: string}} [options]
     *        since 传上一次拿到的 seq（首次不传即取最近 60 条）
     * @returns {Promise<{ok: boolean, seq: number, busy: boolean, items: Array<object>}>}
     */
    getFeed: function (options) {
      var opts = options || {};
      return request('get_feed', {
        since: typeof opts.since === 'number' ? opts.since : 0,
        sessionId: opts.sessionId
      });
    },

    /** 读取一条附件（图片）的 base64：{ attachment, data }。 */
    readAttachment: function (attachmentId, sessionId) {
      return request('read_attachment', { attachmentId: attachmentId, sessionId: sessionId });
    },

    /**
     * 调外部网络接口（由 Host 代发，绕开浏览器 CORS / 页面 CSP）。
     *
     * @param {string} url http / https 地址
     * @param {{method?: string, headers?: object, body?: string, timeoutMs?: number, maxBytes?: number}} [options]
     * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: object,
     *   contentType: string, body: string, bytes: number, truncated: boolean,
     *   elapsedMs: number, finalUrl: string}>}
     *
     * @example
     *   const r = await dsh.http('https://api.github.com/repos/nodejs/node');
     *   const data = JSON.parse(r.body);
     */
    http: function (url, options) {
      var opts = options || {};
      var requestTimeout = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 20000) + 5000;
      return request(
        'http_fetch',
        {
          url: String(url),
          method: opts.method ? String(opts.method) : 'GET',
          headers: opts.headers || undefined,
          body: opts.body === undefined ? undefined : String(opts.body),
          timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
          maxBytes: typeof opts.maxBytes === 'number' ? opts.maxBytes : undefined
        },
        requestTimeout
      );
    },

    /**
     * 截取**另一个窗口**的画面（自己也可以），返回 base64 图片。
     *
     * 实现：Host 用 Electron 的 `webContents.capturePage()` 抓整个页面，再按目标
     * 窗口的百分比矩形裁剪 → 所以窗口被其它窗口盖住时截到的仍是它自己的画面，
     * 与层叠顺序无关。
     *
     * 需要 DSH Desktop 且 Host 与主进程同进程（`DSH_DESKTOP_ISOLATED_HOST=0`），
     * 否则会抛「截图不可用」的错误。
     *
     * @param {string} windowId 目标窗口 id（例如 'win1'）
     * @param {{format?: 'png'|'jpeg', quality?: number, maxWidth?: number, timeoutMs?: number}} [options]
     * @returns {Promise<{ok: boolean, windowId: string, mediaType: string, data: string,
     *   bytes: number, width: number, height: number}>}
     *
     * @example
     *   const shot = await dsh.capture('win1');
     *   await dsh.sendMessage('看看截图', [{ data: shot.data, mediaType: shot.mediaType, name: 'win1.jpg' }]);
     */
    capture: function (windowId, options) {
      var opts = options || {};
      return request(
        'capture_window',
        {
          windowId: String(windowId),
          format: opts.format === 'png' ? 'png' : 'jpeg',
          quality: typeof opts.quality === 'number' ? opts.quality : undefined,
          maxWidth: typeof opts.maxWidth === 'number' ? opts.maxWidth : undefined
        },
        typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000
      );
    },

    /**
     * 共享 cookie 罐（所有网址窗口与 dsh.http 共用同一份）。
     *
     * @param {{op: 'list'|'set'|'remove'|'clear', url?: string, domain?: string,
     *   name?: string, value?: string, path?: string, secure?: boolean,
     *   httpOnly?: boolean, expires?: number, sameSite?: string}} options
     * @returns {Promise<object>}
     *
     * @example
     *   await dsh.cookie({ op: 'list', url: 'https://www.bilibili.com' });
     */
    cookie: function (options) {
      var opts = options || {};
      return request('cookie', opts, 10000);
    },

    /**
     * 指定后续动作作用的目标会话。不传则用当前 DSH 会话。
     * 只影响本页面发出的指令（父页面记录在内存里，不持久化）。
     */
    setSession: function (sessionId) {
      return request('set_session', { sessionId: String(sessionId) });
    },

    /** 当前作用的目标会话 id（来自最近一次状态推送）。 */
    getSessionId: function () {
      return state ? state.sessionId : null;
    },

    // ------------------------------------------------------------ 画布页
    /**
     * 画布页操作。索引一律 **0 基**，与 state.pages[].index 对齐。
     *   dsh.page.next() / prev() / goto(i)   —— 纯前端翻页（立即生效）
     *   dsh.page.new(name)                   —— 新建一页（Host 持久化）
     *   dsh.page.delete(i)                   —— 删除一页及其窗口
     *   dsh.page.rename(i, name)
     *   dsh.page.current() / count() / list()
     */
    page: {
      next: function () {
        return request('page_goto', { delta: 1 });
      },
      prev: function () {
        return request('page_goto', { delta: -1 });
      },
      goto: function (index) {
        return request('page_goto', { index: Number(index) });
      },
      new: function (name) {
        return request('page_new', { name: name === undefined ? undefined : String(name) });
      },
      delete: function (index) {
        return request('page_delete', { index: Number(index) });
      },
      rename: function (index, name) {
        return request('page_rename', { index: Number(index), name: String(name) });
      },
      current: function () {
        return state ? state.currentPage : 0;
      },
      count: function () {
        return state && Array.isArray(state.pages) ? state.pages.length : 1;
      },
      list: function () {
        return state && Array.isArray(state.pages) ? state.pages : [];
      }
    },

    // ------------------------------------------------------------ 放映模式
    /**
     * 宣传片 / 演示用的自动放映：先播引子，再逐窗揭开黑幕，每页播完自动翻页。
     *   dsh.film({ spacing: 2400, hold: 3600, introMs: 3600, title, subtitle })
     *   dsh.film({ op: 'stop' })
     */
    film: function (options) {
      return request('film', options || {});
    },

    /** 是否正在放映（读本地状态，不发请求）。 */
    isFilming: function () {
      return Boolean(state && state.film && state.film.on);
    },

    // ------------------------------------------------------------ 全屏面板
    /** 全屏打开某个面板 / 窗口。 */
    openPanel: function (windowId) {
      return request('open_panel', { windowId: String(windowId) });
    },

    /** 关闭当前全屏面板。 */
    closePanel: function () {
      return request('close_panel', {});
    },

    /** 当前通过 dsh.openPanel 打开的面板 id（没有则 null）。 */
    getOpenPanel: function () {
      return state && state.openPanel ? state.openPanel.id : null;
    }
  };

  window.dsh = dsh;

  // ---- 焦点在 iframe 内时也要能强制退出自定义模式（需求 3.6） --------------
  window.addEventListener(
    'keydown',
    function (event) {
      if (event.ctrlKey && event.shiftKey && (event.key === 'R' || event.key === 'r')) {
        try {
          window.parent.postMessage({ type: 'dsh-force-exit' }, '*');
        } catch (error) {
          /* ignore */
        }
      }
    },
    true
  );

  // ---- 握手：通知父页面“脚本已就绪”，父页面据此判定 iframe 未崩溃 --------
  function ready() {
    try {
      window.parent.postMessage({ type: 'dsh-ready' }, '*');
    } catch (error) {
      /* ignore */
    }
    // 首次拉取状态
    post('get_state');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
})();
