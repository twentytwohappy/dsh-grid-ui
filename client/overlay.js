/* ============================================================================
 * dsh-grid-ui · client/overlay.js
 * ----------------------------------------------------------------------------
 * 这是**注入到 DSH Web 页面**的浏览器端脚本（由 Host 半通过
 * `ctx.webServer.tapIndex(html => ...)` 注入 <script defer src>）。
 *
 * 结构（对应需求 3.2 / 3.3 / 3.6 + v0.4 的画布分页与全屏面板）：
 *   .dshgu-root               全屏、pointer-events:none 的最外层容器
 *   ├─ .dshgu-grid            200x200 逻辑网格锚点（不画线）
 *   ├─ .dshgu-windows         窗口层：当前页的窗口 / 按钮（fixed + 百分比定位）
 *   ├─ .dshgu-panel           全屏面板层：按需创建，铺满整个 DSH 窗口
 *   └─ .dshgu-ball            悬浮球：切换模式；自定义模式下纵向拉长，带翻页 / 新建 / 删除
 *
 * 数据来源：轮询 Host 的 GET /dsh-grid-ui/state，按 revision 增量更新窗口与页。
 * 与 iframe 的通信：window.postMessage（见 client/bridge.js）。
 * ========================================================================== */
(function () {
  'use strict';

  /**
   * 本实例的 API 根路径。Host 把路由固定在 `/dsh-grid-ui/*`（见 host/web.js 顶部
   * 注释：路径带实例 ID 会让已注入的 index.html 指向不存在的地址）。
   * 这里仍然从自己的 <script src> 反推前缀，便于将来换前缀时不改客户端。
   */
  var BASE = (function () {
    try {
      var script = document.currentScript;
      if (script && script.src) {
        var path = new URL(script.src, window.location.href).pathname;
        var at = path.lastIndexOf('/overlay.js');
        if (at > 0) return path.slice(0, at);
      }
    } catch (error) {
      /* 回退到默认前缀 */
    }
    return '/dsh-grid-ui';
  })();

  // 同一路径重复注入：说明本实例已经跑起来了，直接跳过
  var previous = window.__DSH_GRID_UI__;
  if (previous && previous.base === BASE) return;

  // 不同路径（插件刚热重载）：先拆掉旧实例的 DOM / 定时器 / 监听器，再接管
  if (previous && typeof previous.teardown === 'function') {
    try {
      previous.teardown();
    } catch (error) {
      /* 旧实例已损坏也不该拦住新实例 */
    }
  }

  var POLL_INTERVAL_MS = 700;
  var READY_TIMEOUT_MS = 8000;
  /** 翻页时最多保留多少个「隐藏窗口」（保住 iframe 里的音频/定时器/状态） */
  var MAX_HIDDEN_WINDOWS = 40;
  var STORAGE_KEY = 'dsh-grid-ui.custom-mode';
  /** 当前画布页（0 基），按浏览器本地记忆 */
  var PAGE_KEY = 'dsh-grid-ui.page';
  /** 悬浮球位置（像素，相对视口左上角） */
  var BALL_POS_KEY = 'dsh-grid-ui.ball-pos';
  /** 悬浮球离视口边缘的最小间距 */
  var BALL_MARGIN = 6;
  /** 指针移动超过这个距离才算「拖动」，否则算「点击」 */
  var DRAG_THRESHOLD = 4;

  /** 上次保存的模式：true / false，从未保存过则为 null */
  var storedMode = loadMode();

  /** 运行时状态 */
  var ui = {
    custom: storedMode === true,
    /** 用户是否显式切换过模式（未显式切换时才允许“有窗口就自动进入自定义模式”） */
    explicit: storedMode !== null,
    /** 当前页（0 基） */
    page: loadPage(),
    /** 服务端页列表 [{index,name,windows}] */
    pages: [],
    /** @type {Map<string, object>} 当前页已渲染的窗口 */
    windows: new Map(),
    /** 最近一次 /state 的完整 payload（翻页时据此重建） */
    lastPayload: null,
    serverState: null,
    revision: -1,
    polling: false,
    cssText: '',
    bridgeText: '',
    broken: false,
    /** 轮询被拒（例如桌面端关闭了「普通浏览器访问」）时只提示一次 */
    pollBlocked: false,
    /** 模型 / 权限 / 思考强度目录（由 Host 的 catalog action 提供） */
    catalog: null,
    catalogAt: 0,
    catalogLoading: false,
    /** 最近一次 action 的结果，供页面展示错误（例如权限切换失败） */
    lastError: null,
    lastAction: null,
    /** 全屏面板：{ id, runtime } */
    panel: null,
    /** 已应用过的 openPanel.at（避免重复打开/关闭） */
    panelAt: 0,
    /** 已应用过的 focusPage.at（AI 新建窗口时自动翻页） */
    focusAt: 0,
    /** dsh.setSession() 指定的目标会话（优先于 DOM 上的当前会话） */
    sessionOverride: undefined
  };

  /** 轮询定时器句柄（teardown 时要清掉） */
  var pollTimer = 0;

  /** @type {HTMLDivElement} */ var rootEl = null;
  /** @type {HTMLDivElement} */ var gridEl = null;
  /** @type {HTMLDivElement} */ var windowsEl = null;
  /** @type {HTMLDivElement} */ var panelEl = null;
  /** @type {HTMLButtonElement} */ var ballEl = null;
  /** @type {HTMLSpanElement} */ var ballCountEl = null;
  /** @type {HTMLSpanElement} */ var ballPageEl = null;

  // ==========================================================================
  // 小工具
  // ==========================================================================

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function loadMode() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === '1') return true;
      if (raw === '0') return false;
      return null; // 从未保存过：交给首次创建窗口时自动切换
    } catch (error) {
      return null;
    }
  }

  function saveMode(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch (error) {
      /* 隐私模式下写入可能失败，忽略即可 */
    }
  }

  function loadPage() {
    try {
      var raw = window.localStorage.getItem(PAGE_KEY);
      var value = raw === null ? 0 : parseInt(raw, 10);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch (error) {
      return 0;
    }
  }

  function savePage(index) {
    try {
      window.localStorage.setItem(PAGE_KEY, String(index));
    } catch (error) {
      /* ignore */
    }
  }

  /**
   * 用户显式切换模式时调用：落 localStorage（真正的持久化），同时给 Host 发一条
   * set_mode 让本次进程内的 runtime.config 也知道当前模式（热重载后不丢）。
   *
   * 为什么偏好不放 Host：dsh-settings 的 SettingsForms 只有 update/replace/mutate/write
   * 这组「插件条目配置表单」接口（签名 (ns, patch|ops, expectedRevision)），
   * 没有 ctx.settings.set()，也不适合存纯界面偏好。所以窗口「内容」走领域存储
   * （host/store.js），界面偏好走 localStorage，两者分工明确。
   */
  function rememberMode(value) {
    saveMode(value);
    fetch(BASE + '/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set_mode', payload: { mode: value ? 'custom' : 'native' } })
    }).catch(function () {
      /* Host 侧记不上不影响本地行为（localStorage 才是权威） */
    });
  }

  /** 从会话视图读取当前会话 id（DSH 在对话容器上暴露的数据属性）。 */
  function currentSessionId() {
    if (ui.sessionOverride) return ui.sessionOverride;
    try {
      var node = document.querySelector('[data-conversation-session]');
      return node ? node.getAttribute('data-conversation-session') : undefined;
    } catch (error) {
      return undefined;
    }
  }

  /** 轻量提示：3 秒后自动消失 */
  function toast(message) {
    var existing = document.getElementById('dshgu-toast');
    if (existing) existing.remove();
    var node = el('div', 'dshgu-toast');
    node.id = 'dshgu-toast';
    node.textContent = message;
    node.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;' +
      'max-width:80vw;padding:8px 16px;border-radius:8px;font:13px/1.5 system-ui,sans-serif;' +
      'color:#fff;background:rgba(15,23,42,.9);box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:none;' +
      'opacity:0;transition:opacity .18s ease';
    document.body.appendChild(node);
    // 下一帧再改 opacity，确保过渡生效
    requestAnimationFrame(function () {
      node.style.opacity = '1';
    });
    window.setTimeout(function () {
      node.style.opacity = '0';
      window.setTimeout(function () {
        node.remove();
      }, 220);
    }, 3000);
  }

  // ==========================================================================
  // 悬浮球：可拖动 + 位置记忆（点击 = 切换模式，拖动 = 移动）
  // ==========================================================================

  /** 拖动状态：移动超过 DRAG_THRESHOLD 才算拖动，否则视为一次点击 */
  var ballDrag = {
    active: false,
    moved: false,
    pointerId: null,
    offsetX: 0,
    offsetY: 0,
    startX: 0,
    startY: 0,
    suppressClick: false
  };

  function loadBallPosition() {
    try {
      var raw = window.localStorage.getItem(BALL_POS_KEY);
      if (!raw) return null;
      var pos = JSON.parse(raw);
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') return pos;
    } catch (error) {
      /* 存储内容损坏时忽略 */
    }
    return null;
  }

  function saveBallPosition(x, y) {
    try {
      window.localStorage.setItem(BALL_POS_KEY, JSON.stringify({ x: x, y: y }));
    } catch (error) {
      /* 隐私模式下写入可能失败，忽略 */
    }
  }

  /** 把坐标夹到视口内，并写回 inline style（改用 left/top，覆盖 CSS 里的 right） */
  function placeBall(x, y) {
    if (!ballEl) return null;
    var width = ballEl.offsetWidth || 44;
    var height = ballEl.offsetHeight || 44;
    var maxX = Math.max(BALL_MARGIN, window.innerWidth - width - BALL_MARGIN);
    var maxY = Math.max(BALL_MARGIN, window.innerHeight - height - BALL_MARGIN);
    var nextX = Math.min(Math.max(BALL_MARGIN, x), maxX);
    var nextY = Math.min(Math.max(BALL_MARGIN, y), maxY);
    ballEl.style.left = nextX + 'px';
    ballEl.style.top = nextY + 'px';
    ballEl.style.right = 'auto';
    ballEl.style.bottom = 'auto';
    return { x: nextX, y: nextY };
  }

  function restoreBallPosition() {
    var saved = loadBallPosition();
    if (saved) placeBall(saved.x, saved.y);
  }

  /** 页控件：上一次 / 下一页 / 新建 / 删除（删除需要 2 秒内点两次） */
  var deleteArmed = 0;

  function wireBallInteractions() {
    if (!ballEl) return;

    // 点击：切换模式。拖动刚结束时吞掉随之而来的这一次 click。
    // 点的是页控件（.dshgu-ball-pager）时不切换模式。
    ballEl.addEventListener('click', function (event) {
      if (event.target && event.target.closest && event.target.closest('.dshgu-ball-pager')) return;
      if (ballDrag.suppressClick) {
        ballDrag.suppressClick = false;
        return;
      }
      setCustom(!ui.custom);
    });

    ballEl.addEventListener('pointerdown', function (event) {
      // 页控件上的按下不启动拖动，否则按钮点不中
      if (event.target && event.target.closest && event.target.closest('.dshgu-ball-pager')) return;
      if (event.button !== undefined && event.button !== 0) return;
      var rect = ballEl.getBoundingClientRect();
      ballDrag.active = true;
      ballDrag.moved = false;
      ballDrag.pointerId = event.pointerId;
      ballDrag.startX = event.clientX;
      ballDrag.startY = event.clientY;
      ballDrag.offsetX = event.clientX - rect.left;
      ballDrag.offsetY = event.clientY - rect.top;
      try {
        ballEl.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 不支持 pointer capture 时降级为普通拖动 */
      }
    });

    ballEl.addEventListener('pointermove', function (event) {
      if (!ballDrag.active) return;
      var dx = event.clientX - ballDrag.startX;
      var dy = event.clientY - ballDrag.startY;
      if (!ballDrag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      if (!ballDrag.moved) {
        ballDrag.moved = true;
        ballEl.classList.add('dshgu-ball-dragging');
      }
      placeBall(event.clientX - ballDrag.offsetX, event.clientY - ballDrag.offsetY);
      if (event.cancelable) event.preventDefault();
    });

    function endDrag() {
      if (!ballDrag.active) return;
      ballDrag.active = false;
      ballEl.classList.remove('dshgu-ball-dragging');
      try {
        if (ballDrag.pointerId !== null) ballEl.releasePointerCapture(ballDrag.pointerId);
      } catch (error) {
        /* ignore */
      }
      if (ballDrag.moved) {
        ballDrag.suppressClick = true;
        window.setTimeout(function () {
          ballDrag.suppressClick = false;
        }, 260);
        saveBallPosition(
          parseFloat(ballEl.style.left) || BALL_MARGIN,
          parseFloat(ballEl.style.top) || BALL_MARGIN
        );
      }
      ballDrag.pointerId = null;
    }

    ballEl.addEventListener('pointerup', endDrag);
    ballEl.addEventListener('pointercancel', endDrag);

    // 视口变化（窗口缩放/分栏）时把球拉回可见区域
    window.addEventListener('resize', function () {
      var left = parseFloat(ballEl.style.left);
      var top = parseFloat(ballEl.style.top);
      if (!isFinite(left) || !isFinite(top)) return;
      var placed = placeBall(left, top);
      if (placed) saveBallPosition(placed.x, placed.y);
    });

    // 恢复上次的位置
    restoreBallPosition();
  }

  // ==========================================================================
  // 资源加载（CSS 与 bridge 源码由 Host 从插件目录直接提供）
  // ==========================================================================

  function fetchText(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
      return response.text();
    });
  }

  /** 带退避的重试，避免 DSH 刚启动时 webServer 尚未就绪。 */
  async function loadAssets(attempt) {
    attempt = attempt || 0;
    try {
      var results = await Promise.all([
        fetchText(BASE + '/assets/grid.css'),
        fetchText(BASE + '/assets/bridge.js')
      ]);
      ui.cssText = results[0];
      // 防止 bridge 源码中出现 </script> 破坏内联注入
      ui.bridgeText = results[1].replace(/<\/script/gi, '<\\/script');
      ui.broken = false;
      return true;
    } catch (error) {
      if (attempt < 5) {
        await new Promise(function (resolve) {
          window.setTimeout(resolve, 300 * Math.pow(2, attempt));
        });
        return loadAssets(attempt + 1);
      }
      ui.broken = true;
      console.error('[dsh-grid-ui] 无法加载插件资源：', error);
      toast('dsh-grid-ui：无法加载插件资源（/dsh-grid-ui/*），请查看控制台');
      return false;
    }
  }

  function injectCss() {
    if (!ui.cssText) return;
    var style = el('style');
    style.id = 'dshgu-style';
    style.textContent = ui.cssText;
    document.head.appendChild(style);
  }

  // ==========================================================================
  // DOM 构建
  // ==========================================================================

  function buildDom() {
    rootEl = el('div', 'dshgu-root');
    rootEl.id = 'dshgu-root';

    gridEl = el('div', 'dshgu-grid');

    windowsEl = el('div', 'dshgu-windows');

    ballEl = el('button', 'dshgu-ball');
    ballEl.id = 'dshgu-ball';
    ballEl.type = 'button';
    ballEl.title = '切换自定义 UI 模式（Ctrl+Shift+R 强制回退）';
    ballEl.setAttribute('aria-label', '切换自定义 UI 模式');

    var head = el('div', 'dshgu-ball-head');
    var icon = el('span');
    icon.textContent = '⌗';
    icon.style.fontSize = '17px';
    icon.style.lineHeight = '1';
    ballCountEl = el('span', 'dshgu-ball-count');
    ballCountEl.textContent = '0';
    head.appendChild(icon);
    head.appendChild(ballCountEl);

    // 页控件：只在自定义模式下显示（CSS 控制），因此这里全部建好
    var pager = el('div', 'dshgu-ball-pager');
    var prevBtn = el('button', 'dshgu-page-btn');
    prevBtn.type = 'button';
    prevBtn.textContent = '▲';
    prevBtn.title = '上一页';
    prevBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      gotoPage(ui.page - 1);
    });

    ballPageEl = el('span', 'dshgu-page-label');
    ballPageEl.textContent = '1';

    var nextBtn = el('button', 'dshgu-page-btn');
    nextBtn.type = 'button';
    nextBtn.textContent = '▼';
    nextBtn.title = '下一页';
    nextBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      gotoPage(ui.page + 1);
    });

    var addBtn = el('button', 'dshgu-page-btn dshgu-page-add');
    addBtn.type = 'button';
    addBtn.textContent = '＋';
    addBtn.title = '新建一页（空白页）';
    addBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      void newPage();
    });

    var delBtn = el('button', 'dshgu-page-btn dshgu-page-del');
    delBtn.type = 'button';
    delBtn.textContent = '🗑';
    delBtn.title = '删除当前页（2 秒内再点一次确认）';
    delBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      void deleteCurrentPage(delBtn);
    });

    pager.appendChild(prevBtn);
    pager.appendChild(ballPageEl);
    pager.appendChild(nextBtn);
    pager.appendChild(addBtn);
    pager.appendChild(delBtn);

    ballEl.appendChild(head);
    ballEl.appendChild(pager);

    rootEl.appendChild(gridEl);
    rootEl.appendChild(windowsEl);
    rootEl.appendChild(ballEl);
    document.body.appendChild(rootEl);

    // 拖动 + 点击切换（内部会恢复上次保存的位置）
    wireBallInteractions();
    updateBallLabel();
  }

  function updateBallLabel() {
    // 只有一页时，▲▼/页码/删除都没有意义：隐藏，只留「＋新建页」
    var single = ui.pages.length <= 1;
    if (rootEl) rootEl.classList.toggle('dshgu-single-page', single);
    if (ballPageEl) {
      var page = ui.pages[ui.page];
      var name = page && typeof page.name === 'string' ? page.name : '';
      ballPageEl.textContent = single ? '1 页' : (ui.page + 1) + '/' + pageCount() + (name ? ' ' + name : '');
      ballPageEl.title = name || '第 ' + (ui.page + 1) + ' 页';
    }
    if (ballCountEl) {
      var count = 0;
      ui.windows.forEach(function (runtime) {
        if (runtime.kind !== 'panel') count += 1;
      });
      ballCountEl.textContent = String(count);
    }
  }

  // ==========================================================================
  // 模式切换
  // ==========================================================================

  /**
   * 切换模式。
   * @param {boolean} next 是否进入自定义模式
   * @param {boolean} [persist] 是否把这次切换记成「用户的偏好」。
   *   自动切换（首次出现窗口）传 false —— 那种情况不该覆盖用户手动选择过的原版模式。
   */
  function setCustom(next, persist) {
    ui.custom = Boolean(next);
    if (persist !== false) {
      ui.explicit = true;
      rememberMode(ui.custom);
    }
    // 需求 3.6：自定义模式隐藏 DSH 原版界面（CSS 类 + display:none）
    rootEl.classList.toggle('dshgu-custom', ui.custom);
    document.body.classList.toggle('dshgu-custom-mode', ui.custom);
    if (!ui.custom) closePanel(false);
    if (ui.custom) pollNow();
  }

  /** 需求 3.6 / 验收 7：任何情况下强制回到原版界面 */
  function forceExit(reason) {
    if (!ui.custom) return;
    setCustom(false);
    toast(reason || '已切回 DSH 原版界面');
  }

  // ==========================================================================
  // 画布页
  // ==========================================================================

  function pageCount() {
    return ui.pages.length > 0 ? ui.pages.length : 1;
  }

  function applyPages(pages) {
    if (!Array.isArray(pages)) return;
    ui.pages = pages;
    if (ui.page >= ui.pages.length) ui.page = Math.max(0, ui.pages.length - 1);
    updateBallLabel();
  }

  /** 切到某一页（纯前端操作，立即重绘） */
  function gotoPage(index) {
    var target = Math.min(Math.max(0, index), pageCount() - 1);
    if (target === ui.page) return;
    ui.page = target;
    savePage(target);
    // 翻页不再销毁窗口：其它页的窗口留在 DOM 里只是隐藏 —— 这样正在播放的
    // 音频 / 定时器（宣传片自动翻页、实时监看）在切页后不会断掉。
    if (ui.lastPayload) applyServerState(ui.lastPayload, true);
    updateBallLabel();
    // 放映中：翻到新页就重新安排这一页的上幕顺序与自动翻页
    if (filmBase().on) filmEnterPage();
    if (ui.serverState) broadcast();
  }

  async function newPage() {
    try {
      var response = await postAction('page_new', {}, { local: false });
      if (response && response.ok && typeof response.pages !== 'undefined') {
        applyPages(response.pages);
      }
      // 跳到新页（如果服务端返回了页索引就用它，否则用末尾）
      var target =
        response && typeof response.state === 'object' && Array.isArray(response.state.pages)
          ? response.state.pages.length - 1
          : pageCount() - 1;
      gotoPage(target);
      toast('已新建第 ' + (target + 1) + ' 页');
    } catch (error) {
      toast('新建页失败：' + (error && error.message ? error.message : error));
    }
  }

  async function deleteCurrentPage(button) {
    if (pageCount() <= 1) {
      toast('至少保留一页，无法删除');
      return;
    }
    var now = Date.now();
    if (now - deleteArmed > 2000) {
      deleteArmed = now;
      if (button) {
        button.classList.add('dshgu-page-del-armed');
        window.setTimeout(function () {
          button.classList.remove('dshgu-page-del-armed');
        }, 2000);
      }
      toast('再点一次删除第 ' + (ui.page + 1) + ' 页（该页窗口会一起删除）');
      return;
    }
    deleteArmed = 0;
    if (button) button.classList.remove('dshgu-page-del-armed');
    try {
      var response = await postAction('page_delete', { index: ui.page }, { local: false });
      if (response && response.ok) {
        if (response.state && Array.isArray(response.state.pages)) {
          applyPages(response.state.pages);
        }
        ui.page = Math.min(ui.page, pageCount() - 1);
        savePage(ui.page);
        teardownWindows();
        await pollNow();
        toast('已删除一页' + (response.removedWindows ? '（含 ' + response.removedWindows + ' 个窗口）' : ''));
      } else {
        toast((response && response.error) || '删除页失败');
      }
    } catch (error) {
      toast('删除页失败：' + (error && error.message ? error.message : error));
    }
  }

  // ==========================================================================
  // 窗口生命周期
  // ==========================================================================

  function positionWindow(runtime, meta) {
    runtime.meta = meta;
    var style = runtime.el.style;
    // 需求 3.1：left/top/width/height 全部按 200 格换算成百分比
    style.left = (meta.x1 / 200) * 100 + '%';
    style.top = (meta.y1 / 200) * 100 + '%';
    style.width = ((meta.x2 - meta.x1) / 200) * 100 + '%';
    style.height = ((meta.y2 - meta.y1) / 200) * 100 + '%';
  }

  /** 把 AI 生成的 HTML 包装成完整文档，并在 <head> 最前面注入 bridge。 */
  function wrapHtml(html) {
    var bridgeTag = '<script>' + ui.bridgeText + '</' + 'script>';
    var head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';

    if (/<html[\s>]/i.test(html)) {
      if (/<head[^>]*>/i.test(html)) {
        return html.replace(/<head[^>]*>/i, function (match) {
          return match + head + bridgeTag;
        });
      }
      // 有 <html> 但没有 <head>：补一个
      return html.replace(/<html[^>]*>/i, function (match) {
        return match + '<head>' + head + bridgeTag + '</head>';
      });
    }

    // 只给了 body 内部内容：包成完整文档
    return (
      '<!doctype html><html><head>' +
      head +
      bridgeTag +
      '</head><body>' +
      html +
      '</body></html>'
    );
  }

  function markReady(runtime) {
    if (!runtime) return;
    runtime.ready = true;
    if (runtime.timer) {
      window.clearTimeout(runtime.timer);
      runtime.timer = null;
    }
    runtime.el.classList.remove('dshgu-window-broken');
    if (ui.serverState) pushState(runtime, ui.serverState);
    // 页面可能一上来就要渲染模型/权限下拉框：目录还没拉过就补一次
    if (!ui.catalog) void refreshCatalog();
  }

  function showError(runtime, message) {
    runtime.el.classList.add('dshgu-window-broken');
    var existing = runtime.el.querySelector('.dshgu-window-error');
    if (existing) existing.remove();
    var panel = el('div', 'dshgu-window-error');
    var text = el('div');
    text.textContent = message;
    var retry = el('button');
    retry.type = 'button';
    retry.textContent = '重新加载';
    retry.addEventListener('click', function () {
      panel.remove();
      // 重置 revision 强制重新拉取 HTML
      runtime.rev = -1;
      pollNow();
    });
    panel.appendChild(text);
    panel.appendChild(retry);
    runtime.el.appendChild(panel);
  }

  function makeIframe(meta) {
    var iframe = el('iframe', 'dshgu-window-iframe');
    if (meta.url) {
      // 远程网页窗口：这是别人的站点，给它 allow-same-origin 才能正常跑
      // （它的源是站点自己的源，拿不到 DSH 的 DOM，父子之间互不可见）。
      // allow-popups 保留：target=_blank 的链接由 Host 侧（主进程）改写成就地跳转，
      // 见 host/electron.js 的 installWindowOpenRedirector()。
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
      iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      iframe.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');
      iframe.classList.add('dshgu-window-iframe-remote');
    } else {
      // 需求 3.3：sandbox 只给 allow-scripts allow-forms，绝不加 allow-same-origin
      iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
      iframe.setAttribute('referrerpolicy', 'no-referrer');
    }
    iframe.title = 'DSH 自定义窗口 ' + meta.id;
    return iframe;
  }

  /** 网址窗口的「回起始页」小工具条：只给真的有 url 的窗口用 */
  function makeUrlbar(runtime) {
    var bar = el('div', 'dshgu-urlbar');
    var host = '';
    try {
      host = new URL(runtime.meta && runtime.meta.url ? runtime.meta.url : '').host;
    } catch (error) {
      host = '';
    }
    var label = el('span', 'dshgu-urlbar-host');
    label.textContent = host;
    label.title = runtime.meta && runtime.meta.url ? runtime.meta.url : '';

    var home = el('button', 'dshgu-urlbar-btn');
    home.type = 'button';
    home.textContent = '⌂';
    home.title = '回到最初传入的网址（迷路了就点这里）';
    home.addEventListener('click', function (event) {
      event.stopPropagation();
      reopenRemote(runtime);
    });

    bar.appendChild(label);
    bar.appendChild(home);
    return bar;
  }

  /** 丢掉当前 iframe，按最初传入的 url 重新开一个（跨域页面读不到 location，只能重建） */
  function reopenRemote(runtime) {
    var meta = runtime.meta;
    if (!meta || !meta.url || !runtime.iframe) return;
    var next = makeIframe(meta);
    try {
      if (runtime.iframe.parentNode) runtime.iframe.parentNode.replaceChild(next, runtime.iframe);
    } catch (error) {
      /* 测试桩没有 replaceChild */
    }
    runtime.iframe = next;
    runtime.ready = true;
    next.src = meta.url;
    toast('已回到起始页 ' + (function () {
      try {
        return new URL(meta.url).host;
      } catch (error) {
        return '';
      }
    })());
  }

  /** 窗口内容来源变化时同步「回起始页」按钮的可见性 */
  function syncUrlbar(runtime, meta) {
    runtime.meta = meta;
    var hasUrl = Boolean(meta.url);
    if (!runtime.urlbar && hasUrl) {
      runtime.urlbar = makeUrlbar(runtime);
      runtime.el.appendChild(runtime.urlbar);
    }
    if (!runtime.urlbar) return;
    runtime.urlbar.style.display = hasUrl ? '' : 'none';
    if (hasUrl) {
      var label = runtime.urlbar.querySelector('.dshgu-urlbar-host');
      if (label) {
        try {
          label.textContent = new URL(meta.url).host;
          label.title = meta.url;
        } catch (error) {
          label.textContent = '';
        }
      }
    }
  }

  /** 创建当前页上的一个窗口 / 按钮 */
  function createWindow(meta) {
    var kind = meta.kind || 'window';
    var container = el('div', 'dshgu-window');
    container.dataset.id = meta.id;
    container.dataset.kind = kind;

    var runtime = {
      id: meta.id,
      kind: kind,
      el: container,
      iframe: null,
      rev: -1,
      ready: false,
      timer: null,
      html: ''
    };

    if (kind === 'button') {
      container.classList.add('dshgu-window-button');
      var button = el('button', 'dshgu-btn');
      button.type = 'button';
      button.textContent = meta.text || meta.title || meta.id;
      button.title = '点击打开面板：' + (meta.targetId || meta.id);
      button.addEventListener('click', function () {
        void openPanel(meta.targetId || meta.id);
      });
      container.appendChild(button);

      var closeBtn = el('button', 'dshgu-window-close');
      closeBtn.type = 'button';
      closeBtn.textContent = '×';
      closeBtn.title = '删除该按钮';
      closeBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        removeWindowOnHost(meta.id);
      });
      container.appendChild(closeBtn);

      windowsEl.appendChild(container);
      positionWindow(runtime, meta);
      ui.windows.set(meta.id, runtime);
      if (filmBase().on && meta.page === ui.page) addCurtain(runtime);
      return runtime;
    }

    // 普通窗口
    var iframe = makeIframe(meta);
    runtime.iframe = iframe;

    var close = el('button', 'dshgu-window-close');
    close.type = 'button';
    close.textContent = '×';
    close.title = '删除该窗口';
    close.addEventListener('click', function () {
      removeWindowOnHost(meta.id);
    });

    var tag = el('span', 'dshgu-window-tag');
    tag.textContent = meta.id;

    container.appendChild(iframe);
    container.appendChild(close);
    container.appendChild(tag);
    syncUrlbar(runtime, meta);
    windowsEl.appendChild(container);

    positionWindow(runtime, meta);
    ui.windows.set(meta.id, runtime);
    // 放映中新建的窗口先盖上黑幕，等它自己的上幕时间点再揭开
    if (filmBase().on && meta.page === ui.page) addCurtain(runtime);
    loadWindowHtml(runtime, meta);
    return runtime;
  }

  /** 在 srcdoc 窗口与网址窗口之间切换时，换一个新的 iframe（沙箱策略不同） */
  function ensureIframeMode(runtime, meta) {
    var wantRemote = Boolean(meta.url);
    var isRemote = Boolean(runtime.remote);
    if (!runtime.iframe || wantRemote === isRemote) return;
    var next = makeIframe(meta);
    try {
      if (runtime.iframe.parentNode) runtime.iframe.parentNode.replaceChild(next, runtime.iframe);
    } catch (error) {
      /* 测试桩没有 replaceChild 时跳过，直接换引用 */
    }
    runtime.iframe = next;
  }

  function loadWindowHtml(runtime, meta) {
    if (runtime.rev === meta.rev) return;
    if (!runtime.iframe) return;
    runtime.rev = meta.rev;
    runtime.ready = false;
    ensureIframeMode(runtime, meta);
    syncUrlbar(runtime, meta);

    // 网址窗口：不拉 HTML、不注入 bridge，直接让浏览器加载远程页面。
    // 这类窗口不能调 dsh.*（页面不属于我们），把 ready 直接置真，免得超时兜底误报。
    if (meta.url) {
      if (runtime.timer) {
        window.clearTimeout(runtime.timer);
        runtime.timer = null;
      }
      runtime.html = '';
      runtime.remote = meta.url;
      try {
        runtime.iframe.removeAttribute('srcdoc');
      } catch (error) {
        /* 老 DOM / 测试桩没有 removeAttribute */
      }
      runtime.iframe.src = meta.url;
      runtime.ready = true;
      return;
    }
    runtime.remote = '';
    try {
      runtime.iframe.removeAttribute('src');
    } catch (error) {
      /* 同上 */
    }

    var url = BASE + '/window?id=' + encodeURIComponent(meta.id) + '&rev=' + meta.rev;
    fetchText(url)
      .then(function (text) {
        var payload;
        try {
          payload = JSON.parse(text);
        } catch (error) {
          throw new Error('窗口数据解析失败');
        }
        if (!payload.ok) throw new Error(payload.error || '窗口数据不可用');
        runtime.html = payload.html;
        runtime.iframe.srcdoc = wrapHtml(payload.html);

        // 崩溃兜底：超过 READY_TIMEOUT_MS 仍未收到 dsh-ready，就判定 iframe 挂了
        if (runtime.timer) window.clearTimeout(runtime.timer);
        runtime.timer = window.setTimeout(function () {
          if (runtime.ready) return;
          showError(runtime, '窗口内容加载超时（可能包含无法执行的脚本）。');
        }, READY_TIMEOUT_MS);
      })
      .catch(function (error) {
        showError(runtime, '窗口加载失败：' + (error && error.message ? error.message : error));
      });
  }

  function destroyWindow(id) {
    var runtime = ui.windows.get(id);
    if (!runtime) return;
    if (runtime.timer) window.clearTimeout(runtime.timer);
    // 需求 7：安全销毁 —— 先把 srcdoc 置空，再移除节点
    try {
      if (runtime.iframe) runtime.iframe.srcdoc = '<!doctype html><html><body></body></html>';
    } catch (error) {
      /* ignore */
    }
    runtime.el.remove();
    ui.windows.delete(id);
  }

  /** 清掉所有已渲染窗口（重建时用） */
  function teardownWindows() {
    Array.from(ui.windows.keys()).forEach(destroyWindow);
    ui.windows.clear();
  }

  /**
   * 淘汰多余的「隐藏窗口」。
   *
   * 翻页保留窗口是为了让音频/定时器活下来，但不能无限留着 —— 每个 iframe
   * 都是一份真实的文档。超过 MAX_HIDDEN_WINDOWS 就按隐藏时间先淘汰最老的。
   */
  function evictHiddenWindows() {
    var hidden = [];
    ui.windows.forEach(function (runtime, id) {
      if (runtime.hiddenPage) hidden.push({ id: id, at: runtime.hiddenAt || 0 });
    });
    if (hidden.length <= MAX_HIDDEN_WINDOWS) return;
    hidden.sort(function (a, b) {
      return a.at - b.at;
    });
    var overflow = hidden.length - MAX_HIDDEN_WINDOWS;
    for (var i = 0; i < overflow; i += 1) destroyWindow(hidden[i].id);
  }

  function removeWindowOnHost(id) {
    fetch(BASE + '/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id, sessionId: currentSessionId() })
    })
      .then(function () {
        return pollNow();
      })
      .catch(function (error) {
        toast('删除窗口失败：' + error);
      });
  }

  // ==========================================================================
  // 全屏面板
  // ==========================================================================

  /** 打开一个窗口 / 面板到全屏层 */
  async function openPanel(id, notifyHost) {
    if (ui.panel && ui.panel.id === id) return;
    closePanel(false);

    var layer = el('div', 'dshgu-panel');
    var body = el('div', 'dshgu-panel-body');
    var meta = { id: id };
    var iframe = makeIframe(meta);
    var close = el('button', 'dshgu-panel-close');
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭面板（Esc）';
    close.addEventListener('click', function () {
      closePanel(true);
    });

    var title = el('div', 'dshgu-panel-title');
    title.textContent = id;

    body.appendChild(iframe);
    body.appendChild(title);
    body.appendChild(close);
    layer.appendChild(body);
    rootEl.insertBefore(layer, ballEl);

    var runtime = {
      id: id,
      kind: 'panel',
      el: layer,
      iframe: iframe,
      rev: -1,
      ready: false,
      timer: null,
      html: ''
    };
    ui.panel = { id: id, runtime: runtime, el: layer };

    if (notifyHost) {
      void postAction('open_panel', { windowId: id }, { local: false }).catch(function () {});
    }

    try {
      var text = await fetchText(BASE + '/window?id=' + encodeURIComponent(id));
      var payload = JSON.parse(text);
      if (!payload.ok) throw new Error(payload.error || '面板内容不可用');
      // 安全边界：只有 kind=panel 的窗口允许全屏打开，普通窗口想全屏必须由用户点击按钮触发
      if (payload.kind && payload.kind !== 'panel') {
        throw new Error('「' + (payload.title || id) + '」不是面板（kind=panel），不能全屏打开');
      }
      runtime.rev = payload.rev;
      runtime.html = payload.html;
      title.textContent = payload.title || id;
      if (payload.url) {
        // 网址型面板：直接加载远程页面（不注入 bridge，ready 直接置真）
        runtime.remote = payload.url;
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
        iframe.classList.add('dshgu-window-iframe-remote');
        iframe.removeAttribute('srcdoc');
        iframe.src = payload.url;
        runtime.ready = true;
      } else {
        iframe.srcdoc = wrapHtml(payload.html);
        runtime.timer = window.setTimeout(function () {
          if (runtime.ready) return;
          showPanelError('面板内容加载超时。');
        }, READY_TIMEOUT_MS);
      }
    } catch (error) {
      showPanelError('面板加载失败：' + (error && error.message ? error.message : error));
    }
  }

  function showPanelError(message) {
    if (!ui.panel) return;
    var node = el('div', 'dshgu-panel-error');
    node.textContent = message;
    ui.panel.el.appendChild(node);
  }

  /** 关闭全屏面板 */
  function closePanel(notifyHost) {
    if (!ui.panel) return;
    try {
      if (ui.panel.runtime.iframe) {
        ui.panel.runtime.iframe.srcdoc = '<!doctype html><html><body></body></html>';
      }
    } catch (error) {
      /* ignore */
    }
    if (ui.panel.runtime.timer) window.clearTimeout(ui.panel.runtime.timer);
    ui.panel.el.remove();
    ui.panel = null;
    if (notifyHost) void postAction('close_panel', {}, { local: false }).catch(function () {});
  }

  // ==========================================================================
  // 与 Host 的同步
  // ==========================================================================

  function applyServerState(payload, force) {
    if (!payload || payload.ok !== true) return;
    // force 只影响「是否用服务端页号覆盖本地页号」，历史参数保留以免调用方改动
    void force;
    ui.lastPayload = payload;
    ui.serverState = payload.state || null;
    ui.revision = payload.revision;

    // 页列表：state.pages 优先（含名字），payload.pages 兜底
    var pages =
      payload.state && Array.isArray(payload.state.pages)
        ? payload.state.pages
        : Array.isArray(payload.pages)
          ? payload.pages
          : [];
    if (pages.length > 0) applyPages(pages);

    // AI 刚在某页创建了窗口：自动翻到那一页，免得用户「什么都看不到」
    var focus = ui.serverState && ui.serverState.focusPage;
    if (focus && typeof focus.at === 'number' && focus.at !== ui.focusAt) {
      ui.focusAt = focus.at;
      if (typeof focus.page === 'number' && focus.page !== ui.page) {
        gotoPage(focus.page);
        return; // gotoPage 内部会用同一份 payload 重绘，避免重复渲染
      }
    }

    var list = Array.isArray(payload.windows) ? payload.windows : [];
    var seen = new Set();

    for (var i = 0; i < list.length; i += 1) {
      var meta = list[i];
      // 面板类型不在网格上渲染
      if (meta.kind === 'panel') continue;
      var runtime = ui.windows.get(meta.id);
      var onCurrentPage = meta.page === ui.page;

      // 只「按需创建」当前页的窗口，但已经创建过的窗口切页后不销毁（隐藏起来）。
      // 这样既保住了 iframe 里的音频 / 定时器 / 状态，又不会在打开时就为
      // 20 页 × 10 个窗口全部建 iframe。
      if (!runtime) {
        if (!onCurrentPage) continue;
        seen.add(meta.id);
        createWindow(meta);
        runtime = ui.windows.get(meta.id);
      } else if (runtime.kind !== (meta.kind || 'window')) {
        destroyWindow(meta.id);
        if (!onCurrentPage) continue;
        seen.add(meta.id);
        createWindow(meta);
        runtime = ui.windows.get(meta.id);
      } else {
        seen.add(meta.id);
        positionWindow(runtime, meta);
        if (runtime.iframe && runtime.rev !== meta.rev) loadWindowHtml(runtime, meta);
      }

      // 非当前页的窗口只隐藏（不销毁）：保住 iframe 里的音频、定时器和状态
      if (runtime && runtime.el) {
        if (runtime.hiddenPage !== !onCurrentPage) {
          runtime.hiddenPage = !onCurrentPage;
          runtime.el.style.display = onCurrentPage ? '' : 'none';
          if (!onCurrentPage) runtime.hiddenAt = Date.now();
        }
      }
    }

    Array.from(ui.windows.keys()).forEach(function (id) {
      if (!seen.has(id)) destroyWindow(id);
    });

    // 藏起来的窗口不占画面，但会吃内存：超过上限时按「最后可见时间」淘汰
    evictHiddenWindows();

    updateBallLabel();

    // 首次出现窗口时自动进入自定义模式（用户从未手动切换过的情况下），
    // 否则 AI 创建窗口后用户会“什么都看不到”。自动切换不写偏好（persist=false），
    // 免得把用户手动选过的「原版模式」覆盖掉。
    if (!ui.explicit && list.length > 0 && !ui.custom) {
      setCustom(true, false);
      toast('已自动进入自定义 UI 模式（Ctrl+Shift+R 或点击悬浮球返回原版界面）');
    }

    // 应用 Host 侧的面板打开状态（AI 通过 open_ui_panel / dsh.openPanel 触发）
    var openPanelState = ui.serverState && ui.serverState.openPanel;
    if (openPanelState && openPanelState.at && openPanelState.at !== ui.panelAt) {
      ui.panelAt = openPanelState.at;
      if (!ui.panel || ui.panel.id !== openPanelState.id) void openPanel(openPanelState.id, false);
    } else if (!openPanelState && ui.panelAt !== 0) {
      // Host 侧关闭了面板（AI 调了 close_ui_panel）——本地也要收起
      ui.panelAt = 0;
      if (ui.panel) closePanel(false);
    }

    // 把最新状态广播给所有已就绪的 iframe（含全屏面板）
    broadcast();

    // 目录 5 分钟刷新一次（模型/权限很少变化），保证下拉框不会永远停在旧列表
    if (ui.windows.size > 0 && Date.now() - ui.catalogAt > 300000) void refreshCatalog();
  }

  async function pollNow() {
    if (ui.polling) return;
    ui.polling = true;
    try {
      var response = await fetch(BASE + '/state', { cache: 'no-store' });
      if (!response.ok) {
        if (!ui.pollBlocked) {
          ui.pollBlocked = true;
          console.warn('[dsh-grid-ui] /state 被拒绝：HTTP ' + response.status);
          toast('dsh-grid-ui：状态接口返回 HTTP ' + response.status + '（详见控制台）');
        }
        return;
      }
      ui.pollBlocked = false;
      var payload = await response.json();
      applyServerState(payload);
    } catch (error) {
      // Host 暂时不可用：保持现状，等下一轮
    } finally {
      ui.polling = false;
    }
  }

  /** 当前状态快照（在 Host 推送的基础上叠加纯前端字段） */
  // ==========================================================================
  // 放映模式（宣传片）：先黑屏「引子」，再逐窗上幕，最后自动翻页
  // ==========================================================================
  var filmTimerIds = [];
  var filmIntroEl = null;

  function filmBase() {
    if (!ui.film) ui.film = { on: false, spacing: 2400, hold: 3600 };
    return ui.film;
  }

  function filmClearTimers() {
    filmTimerIds.forEach(function (id) {
      window.clearTimeout(id);
    });
    filmTimerIds = [];
  }

  function filmLater(fn, ms) {
    var id = window.setTimeout(function () {
      filmTimerIds = filmTimerIds.filter(function (x) {
        return x !== id;
      });
      fn();
    }, ms);
    filmTimerIds.push(id);
    return id;
  }

  /** 当前页要上幕的窗口，按「从上到下、从左到右」排序 */
  function filmOrder() {
    var found = [];
    ui.windows.forEach(function (runtime) {
      if (runtime.meta && runtime.meta.page === ui.page) found.push(runtime);
    });
    found.sort(function (a, b) {
      var ay = a.meta.y1 || 0;
      var by = b.meta.y1 || 0;
      if (ay !== by) return ay - by;
      return (a.meta.x1 || 0) - (b.meta.x1 || 0);
    });
    return found;
  }

  function addCurtain(runtime) {
    if (!runtime || !runtime.el || runtime.curtain) return;
    var curtain = el('div', 'dshgu-curtain');
    runtime.el.appendChild(curtain);
    runtime.curtain = curtain;
  }

  function dropCurtain(runtime) {
    if (!runtime || !runtime.curtain) return;
    var node = runtime.curtain;
    runtime.curtain = null;
    node.classList.add('dshgu-curtain-out');
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 620);
  }

  function removeFilmIntro() {
    if (!filmIntroEl) return;
    var node = filmIntroEl;
    filmIntroEl = null;
    if (node.parentNode) node.parentNode.removeChild(node);
  }

  function showFilmIntro(title, subtitle, ms) {
    removeFilmIntro();
    var wrap = el('div', 'dshgu-film-intro');
    var t = el('div', 'dshgu-film-intro-title');
    t.textContent = title;
    var s = el('div', 'dshgu-film-intro-sub');
    s.textContent = subtitle;
    wrap.appendChild(t);
    wrap.appendChild(s);
    // 必须挂在 dshgu-root 里面：自定义模式会把 body 的其它子节点全部 display:none
    (rootEl || document.body).appendChild(wrap);
    filmIntroEl = wrap;
    filmLater(function () {
      if (wrap.classList) wrap.classList.add('dshgu-film-intro-out');
    }, Math.max(0, ms - 700));
    filmLater(removeFilmIntro, ms);
  }

  /** 给当前页的每个窗口安排「上幕」时间点，并在最后收尾后自动翻页 */
  function filmEnterPage() {
    var film = filmBase();
    if (!film.on) return;
    filmClearTimers();
    var items = filmOrder();
    var spacing = Math.max(400, film.spacing || 2400);
    items.forEach(function (runtime, index) {
      addCurtain(runtime);
      filmLater(function () {
        dropCurtain(runtime);
      }, 240 + index * spacing);
    });
    var hold = Math.max(800, film.hold || 3600);
    filmLater(filmAdvance, 240 + Math.max(0, items.length - 1) * spacing + hold);
  }

  function filmAdvance() {
    var film = filmBase();
    if (!film.on) return;
    if (ui.page < pageCount() - 1) {
      gotoPage(ui.page + 1);
    } else {
      filmStop('放映结束');
    }
  }

  function filmStart(payload) {
    var film = filmBase();
    if (film.on) return { ok: true, film: { on: true }, page: ui.page, pageCount: pageCount() };
    var options = payload || {};
    film.spacing = typeof options.spacing === 'number' ? options.spacing : 2400;
    film.hold = typeof options.hold === 'number' ? options.hold : 3600;
    // 指定起始页时先跳过去（放映总是从第一幕开始）
    if (typeof options.page === 'number') {
      gotoPage(options.page);
    }
    film.on = true;
    var introMs = typeof options.introMs === 'number' ? options.introMs : 3600;
    showFilmIntro(
      options.title || 'dsh-grid-ui',
      options.subtitle || '把界面，捏成任何形状',
      introMs
    );
    if (introMs > 0) filmLater(filmEnterPage, introMs);
    else filmEnterPage();
    broadcast();
    return { ok: true, film: { on: true }, page: ui.page, pageCount: pageCount() };
  }

  function filmStop(reason) {
    var film = filmBase();
    var wasOn = film.on;
    film.on = false;
    filmClearTimers();
    removeFilmIntro();
    ui.windows.forEach(function (runtime) {
      dropCurtain(runtime);
    });
    if (reason && wasOn) toast(reason);
    if (wasOn) broadcast();
    return { ok: true, film: { on: false } };
  }

  function stateFor(runtime) {
    var base = ui.serverState ? Object.assign({}, ui.serverState) : {};
    base.pages = ui.pages;
    base.currentPage = ui.page;
    base.pageCount = pageCount();
    base.windowId = runtime && runtime.id ? runtime.id : undefined;
    base.windowKind = runtime && runtime.kind ? runtime.kind : undefined;
    base.sessionId = currentSessionId() || base.sessionId || null;
    base.openPanel = ui.panel ? { id: ui.panel.id } : null;
    base.film = {
      on: Boolean(filmBase().on),
      spacing: filmBase().spacing,
      hold: filmBase().hold
    };
    if (ui.catalog) base.catalog = ui.catalog;
    base.lastAction = ui.lastAction;
    if (ui.lastError) base.lastError = ui.lastError;
    return base;
  }

  function broadcast() {
    ui.windows.forEach(function (runtime) {
      if (runtime.ready) pushState(runtime, ui.serverState);
    });
    if (ui.panel && ui.panel.runtime.ready) pushState(ui.panel.runtime, ui.serverState);
  }

  function pushState(runtime, state) {
    var payload = stateFor(runtime);
    try {
      if (runtime.iframe && runtime.iframe.contentWindow) {
        runtime.iframe.contentWindow.postMessage({ type: 'dsh-state', state: payload }, '*');
      }
    } catch (error) {
      /* iframe 可能已被销毁 */
    }
  }

  /** 拉取模型 / 权限目录（Host 侧有 30s 缓存），完成后立刻广播给所有 iframe */
  async function refreshCatalog() {
    if (ui.catalogLoading) return;
    ui.catalogLoading = true;
    try {
      var response = await fetch(BASE + '/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId(),
          action: 'catalog',
          payload: {}
        })
      });
      if (!response.ok) return;
      var result = await response.json();
      if (result && result.catalog) {
        ui.catalog = result.catalog;
        ui.catalogAt = Date.now();
      }
      if (result && result.state) ui.serverState = result.state;
      broadcast();
    } catch (error) {
      /* 目录拉取失败不致命，下一轮再试 */
    } finally {
      ui.catalogLoading = false;
    }
  }

  // ==========================================================================
  // 消息桥：只接受我们自己的 iframe 发来的消息
  // ==========================================================================

  function findRuntimeBySource(source) {
    var found = null;
    ui.windows.forEach(function (runtime) {
      // 网址窗口加载的是别人的页面，不允许它驱动 dsh.* 指令
      if (runtime.remote) return;
      if (!found && runtime.iframe && runtime.iframe.contentWindow === source) found = runtime;
    });
    if (!found && ui.panel && !ui.panel.runtime.remote && ui.panel.runtime.iframe && ui.panel.runtime.iframe.contentWindow === source) {
      found = ui.panel.runtime;
    }
    return found;
  }

  /**
   * 统一的动作入口：先处理纯前端的动作（toast / 翻页 / 指定会话 / 面板），
   * 其余转发给 Host 的 POST /action。
   * @returns {Promise<object>} 结果对象
   */
  async function postAction(action, payload, options) {
    var local = options && options.local === true;

    if (action === 'toast') {
      toast(String((payload && payload.text) || ''));
      return { ok: true };
    }

    if (action === 'page_goto') {
      var target = ui.page;
      if (payload && typeof payload.delta === 'number') target = ui.page + payload.delta;
      else if (payload && typeof payload.index === 'number') target = payload.index;
      gotoPage(target);
      return { ok: true, page: ui.page, pageCount: pageCount() };
    }

    if (action === 'film') {
      var filmOp = (payload && payload.op) || 'start';
      if (filmOp === 'stop') return filmStop('已停止放映');
      if (filmOp === 'state') return { ok: true, film: { on: Boolean(filmBase().on) } };
      // 只认 start/play，别的一律拒绝：页面里拼错 op 不该意外启动整片
      if (filmOp !== 'start' && filmOp !== 'play') {
        return { ok: false, error: '未知的放映指令：' + filmOp, code: 'grid-ui/bad-film-op' };
      }
      return filmStart(payload || {});
    }

    if (action === 'set_session') {
      var next = payload && payload.sessionId ? String(payload.sessionId) : undefined;
      ui.sessionOverride = next || undefined;
      return { ok: true, sessionId: ui.sessionOverride || currentSessionId() || null };
    }

    if (action === 'get_state') {
      // 本地即可回答，省一次 Host 往返；Host 的状态仍在轮询里持续更新
      return { ok: true, state: stateFor(null) };
    }

    // AI 输出监看：iframe 里的 dsh.getFeed() 走这条本地分支，
    // 直接打 Host 的 /feed（增量），不经过 /action，避免和动作队列互相阻塞
    if (action === 'get_feed') {
      var since = payload && typeof payload.since === 'number' ? payload.since : 0;
      var feedSid = (payload && payload.sessionId) || currentSessionId() || '';
      var feedUrl = BASE + '/feed?since=' + encodeURIComponent(String(since));
      if (feedSid) feedUrl += '&sessionId=' + encodeURIComponent(feedSid);
      var feedResponse = await fetch(feedUrl);
      var feedRaw = await feedResponse.text();
      var feedJson;
      try {
        feedJson = JSON.parse(feedRaw);
      } catch (error) {
        throw new Error('读取监看流失败：Host 返回了非 JSON 响应（HTTP ' + feedResponse.status + '）');
      }
      return feedJson;
    }

    // 网络请求代理：iframe 里的 dsh.http() 走这条本地分支 —— 页面自己在沙箱里
    // fetch 外部 API 会被 CORS + CSP 挡住，交给 Host 用 Node 代发最省事。
    if (action === 'http_fetch') {
      var fetchHttp = await fetch(BASE + '/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      var fetchHttpRaw = await fetchHttp.text();
      var fetchHttpJson;
      try {
        fetchHttpJson = JSON.parse(fetchHttpRaw);
      } catch (error) {
        throw new Error('网络请求失败：Host 返回了非 JSON 响应（HTTP ' + fetchHttp.status + '）');
      }
      if (!fetchHttp.ok || (fetchHttpJson && fetchHttpJson.ok === false)) {
        throw new Error((fetchHttpJson && fetchHttpJson.error) || '网络请求失败');
      }
      return fetchHttpJson;
    }

    if (action === 'open_panel' && local) {
      await openPanel(String((payload && payload.windowId) || ''), false);
      return { ok: true, openPanel: ui.panel ? { id: ui.panel.id } : null };
    }

    if (action === 'close_panel' && local) {
      closePanel(false);
      return { ok: true };
    }

    try {
      var response = await fetch(BASE + '/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId(),
          action: action,
          payload: payload || {}
        })
      });
      var raw = await response.text();
      var result;
      try {
        result = JSON.parse(raw);
      } catch (error) {
        throw new Error('Host 返回了非 JSON 响应（HTTP ' + response.status + '）');
      }
      if (result && result.catalog) {
        ui.catalog = result.catalog;
        ui.catalogAt = Date.now();
      }
      if (result && result.state) ui.serverState = result.state;
      if (result && result.ok === false) {
        ui.lastError = result.error || '操作失败：' + action;
        ui.lastAction = { action: action, ok: false, at: Date.now() };
        toast(ui.lastError);
        // Host 已经明确说「没做成」：必须让调用方的 Promise 失败，
        // 否则页面会把空结果当成成功（例如把 0 字节截图当附件发出去）。
        var denied = new Error(ui.lastError);
        denied.code = result.code;
        throw denied;
      } else {
        ui.lastError = null;
        ui.lastAction = { action: action, ok: true, at: Date.now() };
      }
      // 页操作会改变页列表：顺手应用一下，避免等到下一轮轮询
      if (result && result.state && Array.isArray(result.state.pages)) {
        applyPages(result.state.pages);
      }
      broadcast();
      return result;
    } catch (error) {
      // Host 明确拒绝的情况已经提示过（toast + lastError），原样往上抛，
      // 别再套一层「通信失败」，否则页面看到的原因会被带偏。
      if (error && error.code) throw error;
      ui.lastError = '与 DSH 主进程通信失败：' + error;
      ui.lastAction = { action: action, ok: false, at: Date.now() };
      toast(ui.lastError);
      throw error;
    }
  }

  /** 把动作结果回给发起的 iframe（bridge 的 request() 靠这个 resolve） */
  function replyResult(runtime, requestId, result, error) {
    if (!requestId || !runtime || !runtime.iframe) return;
    try {
      var frame = runtime.iframe.contentWindow;
      if (!frame) return;
      frame.postMessage(
        error
          ? { type: 'dsh-result', requestId: requestId, error: error }
          : { type: 'dsh-result', requestId: requestId, result: result },
        '*'
      );
    } catch (e) {
      /* iframe 可能已被销毁 */
    }
  }

  function onWindowMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'dsh-force-exit') {
      forceExit();
      return;
    }

    if (data.type === 'dsh-ready') {
      markReady(findRuntimeBySource(event.source));
      return;
    }

    if (data.type !== 'dsh-action') return;
    var runtime = findRuntimeBySource(event.source);
    if (!runtime) return; // 非本插件 iframe 的消息一律忽略

    var action = String(data.action || '');
    var payload = data.payload || {};
    var requestId = data.requestId;

    postAction(action, payload, { local: true })
      .then(function (result) {
        adoptActionResult(result);
        replyResult(runtime, requestId, result, null);
      })
      .catch(function (error) {
        replyResult(runtime, requestId, null, error && error.message ? error.message : String(error));
      });
  }

  /**
   * 动作结果里若带回了新状态（Host 的多数 action 都会带 `state`），
   * 立即采纳，免得页面里点了「新建页」要等下一轮轮询才看到变化。
   */
  function adoptActionResult(result) {
    if (!result || typeof result !== 'object') return;
    var changed = false;
    if (Array.isArray(result.pages)) {
      applyPages(result.pages);
      changed = true;
    }
    if (result.state && typeof result.state === 'object') {
      ui.serverState = result.state;
      if (Array.isArray(result.state.pages)) applyPages(result.state.pages);
      changed = true;
    }
    if (changed && ui.serverState) broadcast();
  }

  // 需求 3.6 / 验收 7：全局快捷键，捕获阶段拦截，避免被浏览器刷新吃掉
  function onWindowKeydown(event) {
    if (event.ctrlKey && event.shiftKey && (event.key === 'R' || event.key === 'r')) {
      event.preventDefault();
      event.stopPropagation();
      forceExit('已通过 Ctrl+Shift+R 强制切回 DSH 原版界面');
      return;
    }
    if (event.key === 'Escape' && ui.panel) {
      closePanel(true);
    }
  }

  window.addEventListener('message', onWindowMessage);
  window.addEventListener('keydown', onWindowKeydown, true);

  // ==========================================================================
  // 启动
  // ==========================================================================

  async function boot() {
    var ok = await loadAssets(0);
    if (!ok) return;
    injectCss();
    buildDom();
    // 恢复上次的模式；但首次进入时 DSH 原版界面必须可见
    rootEl.classList.toggle('dshgu-custom', ui.custom);
    document.body.classList.toggle('dshgu-custom-mode', ui.custom);
    await pollNow();
    void refreshCatalog();
    pollTimer = window.setInterval(pollNow, POLL_INTERVAL_MS);

    // 登记当前实例：插件热重载后新实例会先调用这里的 teardown 拆掉旧实例
    window.__DSH_GRID_UI__ = {
      base: BASE,
      teardown: function () {
        if (pollTimer) window.clearInterval(pollTimer);
        pollTimer = 0;
        window.removeEventListener('message', onWindowMessage);
        window.removeEventListener('keydown', onWindowKeydown, true);
        if (rootEl && rootEl.parentNode) rootEl.remove();
        try {
          document.body.classList.remove('dshgu-custom-mode');
        } catch (error) {
          /* ignore */
        }
        var style = document.getElementById('dshgu-style');
        if (style) style.remove();
        rootEl = null;
        gridEl = null;
        windowsEl = null;
        panelEl = null;
        ballEl = null;
        ballCountEl = null;
        ballPageEl = null;
        ui.windows.clear();
        ui.panel = null;
        window.__DSH_GRID_UI__ = undefined;
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    void boot();
  }
})();
