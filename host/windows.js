/**
 * dsh-grid-ui · host/windows.js
 * 窗口注册表：坐标、HTML 内容、窗口类型、所属画布页、revision。
 *
 * 权威状态在**内存**（读取同步、无 IO），磁盘只作为持久投影：
 * 每次变更后通过可选的 `onChange` 回调把整条记录写进 DSH 的领域存储
 * （见 host/store.js），进程重启时再由 store.restore() 装回来。
 * 这样读写路径互不阻塞：存盘失败只会让「重启后恢复」失效，当前会话照常工作。
 *
 * ---- 窗口类型（v0.4） ------------------------------------------------------
 *   window  浮动窗口：网格矩形内嵌一个 iframe（v0.1 的行为）
 *   button  浮动按钮：网格矩形内画一个可点击按钮，显示 text；点击后打开它的面板
 *   panel   全屏面板：平时不显示，只能被按钮 / open_ui_panel / dsh.openPanel(id) 打开；
 *           打开时铺满整个 DSH 窗口，右上角有原生关闭按钮，内部 iframe 与普通窗口一样
 *           可以通过 bridge 控制 DSH。
 *
 * ---- 画布页（v0.4） --------------------------------------------------------
 * 所有窗口都属于某一页（page 为 **0 基**索引）。页本身只有名字，页 0 永远存在。
 * 悬浮球在自定义模式下纵向拉长，多出来的部分就是翻页 / 新建页 / 删除页的操作区。
 */

/** 逻辑网格边长（格点范围 0..200，共 200 x 200 格） */
export const GRID_SIZE = 200;

/** 性能约束：**每一页**同时存在的窗口不超过 10 个（需求「约束与注意」） */
export const MAX_WINDOWS_PER_PAGE = 10;

/** 画布页数量上限：每页 10 个窗口，20 页足够做一份「PPT」 */
export const MAX_PAGES = 20;

/** 单个窗口 HTML 的最大字节数，防止一次工具调用塞进几十 MB */
export const MAX_HTML_BYTES = 200 * 1024;

/** 合法窗口类型 */
export const WINDOW_KINDS = ['window', 'button', 'panel'];

/** 页 0 的默认名字 */
const DEFAULT_PAGE_NAME = '第 1 页';

/** 带上语义的错误类型，便于 web 层区分「参数错误」和「内部错误」 */
export class GridUiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'GridUiError';
    this.code = code || 'grid-ui/invalid';
    this.status = status || 400;
  }
}

/** 去掉 html 后的窗口元数据（发给浏览器的列表） */
function metaOf(window) {
  return {
    id: window.id,
    kind: window.kind,
    page: window.page,
    x1: window.x1,
    y1: window.y1,
    x2: window.x2,
    y2: window.y2,
    rev: window.rev,
    title: window.title,
    text: window.text,
    targetId: window.targetId,
    /** v0.6：远程网址窗口（非空时浏览器用 iframe src 直接加载，而不是 srcdoc） */
    url: window.url || ''
  };
}

function assertWindowId(id) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new GridUiError('windowId 必须是非空字符串', 'grid-ui/bad-window-id');
  }
  if (id.length > 64) {
    throw new GridUiError('windowId 长度不能超过 64 个字符', 'grid-ui/bad-window-id');
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new GridUiError(
      'windowId 只能包含字母、数字、下划线、点、冒号和中划线',
      'grid-ui/bad-window-id'
    );
  }
  return id;
}

function assertCoord(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GridUiError(`${label} 必须是数字`, 'grid-ui/bad-coordinate');
  }
  if (value < 0 || value > GRID_SIZE) {
    throw new GridUiError(`${label} 必须在 0-${GRID_SIZE} 之间`, 'grid-ui/bad-coordinate');
  }
  return value;
}

/** 校验并归一化四个格点；要求 x2 > x1、y2 > y1 */
export function assertRect(rect) {
  const x1 = assertCoord(rect.x1, 'gridX1');
  const y1 = assertCoord(rect.y1, 'gridY1');
  const x2 = assertCoord(rect.x2, 'gridX2');
  const y2 = assertCoord(rect.y2, 'gridY2');
  if (x2 <= x1 || y2 <= y1) {
    throw new GridUiError(
      '右下角格点必须在左上角格点的右侧且下方（gridX2 > gridX1 且 gridY2 > gridY1）',
      'grid-ui/inverted-rect'
    );
  }
  return { x1, y1, x2, y2 };
}

/** 校验窗口类型（缺省为 window） */
export function assertKind(kind) {
  if (kind === undefined || kind === null || kind === '') return 'window';
  if (typeof kind !== 'string' || !WINDOW_KINDS.includes(kind)) {
    throw new GridUiError(
      `kind 必须是 ${WINDOW_KINDS.join(' / ')} 之一`,
      'grid-ui/bad-kind'
    );
  }
  return kind;
}

/** 校验页索引（0 基，必须已存在） */
function assertPageIndex(value, label, pageCount) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GridUiError(`${label} 必须是整数（0 基页索引）`, 'grid-ui/bad-page');
  }
  if (value < 0 || value >= pageCount) {
    throw new GridUiError(
      `${label} 超出范围：当前共 ${pageCount} 页，合法值为 0-${pageCount - 1}`,
      'grid-ui/bad-page'
    );
  }
  return value;
}

/** 面板默认铺满整屏 */
const FULL_SCREEN_RECT = { x1: 0, y1: 0, x2: GRID_SIZE, y2: GRID_SIZE };

/** 网址窗口的最大长度 */
export const MAX_URL_LENGTH = 2048;

/**
 * 校验「网址窗口」的地址：只允许 http / https。
 *
 * 用 `URL` 解析而不是正则，避免 `javascript:` / `data:` / `file:` 这类
 * 伪协议混进来（iframe src 里 `javascript:` 会被当成脚本执行）。
 *
 * @param {unknown} value
 * @returns {string} 归一化后的地址（空字符串表示「不是网址窗口」）
 */
export function assertUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new GridUiError('url 必须是字符串', 'grid-ui/bad-url');
  }
  const raw = value.trim();
  if (raw === '') return '';
  if (raw.length > MAX_URL_LENGTH) {
    throw new GridUiError(`url 长度不能超过 ${MAX_URL_LENGTH} 个字符`, 'grid-ui/bad-url');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new GridUiError(`url 不是合法地址：${raw}`, 'grid-ui/bad-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GridUiError(
      `url 只支持 http / https（收到的是 ${parsed.protocol}）`,
      'grid-ui/bad-url'
    );
  }
  return parsed.toString();
}

export class WindowRegistry {
  /**
   * @type {Map<string, {
   *   id:string, kind:string, page:number, x1:number, y1:number, x2:number, y2:number,
   *   html:string, title:string, text:string, targetId:string|null, rev:number
   * }>}
   */
  #windows = new Map();

  /** @type {Array<{name: string}>} 画布页（索引即 page，0 基） */
  #pages = [{ name: DEFAULT_PAGE_NAME }];

  /** 全局单调递增的 revision，浏览器据此判断是否需要重新拉取内容 */
  #revision = 0;

  /**
   * 持久化钩子：`{ put(window), remove(id), putPages(pages) }`，由 Host 入口注入。
   * 未注入时注册表退化为纯内存（自测、或 profile 没装存储层时）。
   * @type {{ put?: (win: object) => void, remove?: (id: string) => void, putPages?: (pages: object[]) => void } | null}
   */
  #sink = null;

  /** 把存盘变更排进 Promise 队列，避免并发写打乱顺序；错误只记录不抛出 */
  #writes = Promise.resolve();

  setSink(sink) {
    this.#sink = sink || null;
  }

  /** 当前是否接上了持久化（诊断用：启动日志会打印） */
  get persistedEnabled() {
    return this.#sink !== null;
  }

  /** 串行执行一次存盘操作；任何异常都吞掉（不拖垮工具调用） */
  #persist(task) {
    if (!this.#sink) return;
    const sink = this.#sink;
    this.#writes = this.#writes.then(() => task(sink)).catch(() => {});
  }

  get revision() {
    return this.#revision;
  }

  get size() {
    return this.#windows.size;
  }

  // ---------------------------------------------------------------- 画布页

  get pageCount() {
    return this.#pages.length;
  }

  /** 每页窗口数 */
  #countOnPage(index) {
    let count = 0;
    this.#windows.forEach((win) => {
      if (win.page === index) count += 1;
    });
    return count;
  }

  /** 页列表（index 为 0 基；展示时可以 +1） */
  listPages() {
    return this.#pages.map((page, index) => ({
      index,
      name: page.name,
      windows: this.#countOnPage(index)
    }));
  }

  #persistPages() {
    // 存盘时复制一份，避免异步任务读到后续变更
    const snapshot = this.#pages.map((page) => ({ name: page.name }));
    this.#persist((sink) => sink.putPages && sink.putPages(snapshot));
  }

  /**
   * 自动命名的页（「第 N 页」）在增删后重新按顺序编号。
   * 否则删掉前几页后会出现「1/1 第 4 页」这种自相矛盾的标签；
   * 用户手动命名的页（名字不符合该模式）保持不动。
   * @returns {boolean} 是否发生了改名
   */
  #renumberAutoPages() {
    let changed = false;
    this.#pages = this.#pages.map((page, index) => {
      const auto = /^第\s*\d+\s*页$/.test(page.name);
      if (!auto) return page;
      const next = `第 ${index + 1} 页`;
      if (next === page.name) return page;
      changed = true;
      return { name: next };
    });
    if (changed) this.#revision += 1;
    return changed;
  }

  /** 新建一页，返回新页的索引（0 基） */
  addPage(name) {
    if (this.#pages.length >= MAX_PAGES) {
      throw new GridUiError(
        `画布页数已达上限 ${MAX_PAGES} 页，请先删除不用的页`,
        'grid-ui/too-many-pages'
      );
    }
    const index = this.#pages.length;
    const label =
      typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 40) : `第 ${index + 1} 页`;
    this.#pages.push({ name: label });
    this.#revision += 1;
    this.#renumberAutoPages();
    this.#persistPages();
    return index;
  }

  renamePage(index, name) {
    const pageIndex = assertPageIndex(index, 'page', this.pageCount);
    if (typeof name !== 'string' || name.trim() === '') {
      throw new GridUiError('页名不能为空', 'grid-ui/bad-page-name');
    }
    this.#pages[pageIndex] = { name: name.trim().slice(0, 40) };
    this.#revision += 1;
    this.#persistPages();
    return this.listPages()[pageIndex];
  }

  /**
   * 删除一页（连同它上面的所有窗口）。
   * 规则不是「最后一页不能删」，而是「画布只剩一页时不能删」—— 四页时删第 4 页是允许的。
   * 删完后：后面的页索引整体前移、受影响窗口的 page 一并修正、自动命名的页重新编号。
   * @returns {{ removedWindows: number }}
   */
  removePage(index) {
    const pageIndex = assertPageIndex(index, 'page', this.pageCount);
    if (this.#pages.length <= 1) {
      throw new GridUiError('画布只剩一页了，不能删除；至少保留一页', 'grid-ui/last-page');
    }

    let removedWindows = 0;
    const moved = [];
    for (const win of Array.from(this.#windows.values())) {
      if (win.page === pageIndex) {
        this.#windows.delete(win.id);
        removedWindows += 1;
        this.#persist((sink) => sink.remove && sink.remove(win.id));
      } else if (win.page > pageIndex) {
        const next = { ...win, page: win.page - 1 };
        this.#windows.set(win.id, next);
        moved.push(next);
      }
    }

    this.#pages.splice(pageIndex, 1);
    this.#revision += 1;
    this.#renumberAutoPages();
    for (const win of moved) {
      this.#persist((sink) => sink.put && sink.put(win));
    }
    this.#persistPages();
    return { removedWindows };
  }

  // ---------------------------------------------------------------- 窗口

  /**
   * 只返回元数据，不带 html（html 走按需拉取）；page 可选过滤。
   * 面板（kind === 'panel'）不参与画布渲染，因此默认不出现 —— 它们只在被
   * open_ui_panel / 按钮点开时由 overlay 以全屏形式加载。
   */
  list(page) {
    const all = Array.from(this.#windows.values(), metaOf).filter((meta) => meta.kind !== 'panel');
    return typeof page === 'number' ? all.filter((meta) => meta.page === page) : all;
  }

  get(id) {
    return this.#windows.get(id);
  }

  /** 同页窗口数是否已达上限 */
  #assertPageCapacity(page, windowId) {
    const count = this.#countOnPage(page);
    if (count >= MAX_WINDOWS_PER_PAGE) {
      throw new GridUiError(
        `第 ${page + 1} 页的窗口数量已达上限 ${MAX_WINDOWS_PER_PAGE} 个，请先删除不用的窗口`,
        'grid-ui/too-many-windows'
      );
    }
    // 同 id 的窗口换页时不算新增
    const existing = this.#windows.get(windowId);
    if (existing && existing.page === page) return;
  }

  /** 创建或整体更新一个窗口 */
  upsert({ id, kind, html, title, text, targetId, rect, page, url }) {
    const windowId = assertWindowId(id);
    const kindValue = assertKind(kind);
    const pageIndex = page === undefined ? 0 : page;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new GridUiError(
        `page 超出范围：当前共 ${this.pageCount} 页，合法值为 0-${this.pageCount - 1}`,
        'grid-ui/bad-page'
      );
    }

    const previous = this.#windows.get(windowId);
    if (!previous || previous.page !== pageIndex) {
      this.#assertPageCapacity(pageIndex, windowId);
    }

    const area =
      kindValue === 'panel'
        ? rect
          ? assertRect(rect)
          : { ...FULL_SCREEN_RECT }
        : assertRect(rect);

    const next = {
      id: windowId,
      kind: kindValue,
      page: pageIndex,
      x1: area.x1,
      y1: area.y1,
      x2: area.x2,
      y2: area.y2,
      html: typeof html === 'string' ? html : previous ? previous.html : '',
      title: title || (previous && previous.title) || windowId,
      text: typeof text === 'string' && text !== '' ? text.slice(0, 200) : (previous && previous.text) || '',
      targetId:
        typeof targetId === 'string' && targetId !== ''
          ? targetId
          : (previous && previous.targetId) || null,
      // v0.6：给了 url 就是「网址窗口」，此时 html 不参与渲染
      url: url === undefined ? (previous && previous.url) || '' : assertUrl(url),
      rev: (previous ? previous.rev : 0) + 1
    };

    this.#windows.set(windowId, next);
    this.#revision += 1;
    this.#persist((sink) => sink.put && sink.put(next));
    return metaOf(next);
  }

  /** 局部更新：html / 位置 / 文案 / 目标面板 / 所属页 */
  patch(id, patch) {
    const windowId = assertWindowId(id);
    const previous = this.#windows.get(windowId);
    if (!previous) {
      throw new GridUiError(`窗口不存在: ${windowId}`, 'grid-ui/unknown-window', 404);
    }

    const kindValue = patch.kind === undefined ? previous.kind : assertKind(patch.kind);
    const rect = patch.rect
      ? patch.rect
      : { x1: previous.x1, y1: previous.y1, x2: previous.x2, y2: previous.y2 };
    const area = assertRect(rect);

    let page = previous.page;
    if (patch.page !== undefined) {
      if (!Number.isInteger(patch.page) || patch.page < 0 || patch.page >= this.pageCount) {
        throw new GridUiError(
          `page 超出范围：当前共 ${this.pageCount} 页，合法值为 0-${this.pageCount - 1}`,
          'grid-ui/bad-page'
        );
      }
      page = patch.page;
      if (page !== previous.page) this.#assertPageCapacity(page, windowId);
    }

    const next = {
      id: windowId,
      kind: kindValue,
      page,
      x1: area.x1,
      y1: area.y1,
      x2: area.x2,
      y2: area.y2,
      html: patch.html === undefined ? previous.html : patch.html,
      title: patch.title === undefined ? previous.title : patch.title || previous.title,
      text: patch.text === undefined ? previous.text : String(patch.text).slice(0, 200),
      targetId: patch.targetId === undefined ? previous.targetId : patch.targetId || null,
      url: patch.url === undefined ? previous.url || '' : assertUrl(patch.url),
      rev: previous.rev + 1
    };

    this.#windows.set(windowId, next);
    this.#revision += 1;
    this.#persist((sink) => sink.put && sink.put(next));
    return metaOf(next);
  }

  remove(id) {
    const windowId = assertWindowId(id);
    const existed = this.#windows.delete(windowId);
    if (existed) {
      this.#revision += 1;
      this.#persist((sink) => sink.remove && sink.remove(windowId));
    }
    return existed;
  }

  /**
   * 启动恢复：把磁盘记录装回内存。
   * 走与 upsert 相同的校验（格点范围、坐标合法性），因此损坏或越界的记录
   * 会被抛出的 GridUiError 挡住，由 store.restore() 计数并跳过；
   * 这里**不**触发存盘（否则会把恢复动作又写回介质）。
   */
  restore(id, record) {
    const windowId = assertWindowId(id);
    const page = Number.isInteger(record.page) ? record.page : 0;
    if (page < 0 || page >= this.#pages.length) {
      throw new GridUiError(`窗口 ${windowId} 的页索引越界`, 'grid-ui/bad-record');
    }
    if (this.#countOnPage(page) >= MAX_WINDOWS_PER_PAGE) {
      throw new GridUiError(`恢复时第 ${page + 1} 页窗口数已达上限`, 'grid-ui/too-many-windows');
    }
    const rect = assertRect(record);
    if (typeof record.html !== 'string') {
      throw new GridUiError(`窗口 ${windowId} 的 HTML 不是字符串`, 'grid-ui/bad-record');
    }
    const kind = WINDOW_KINDS.includes(record.kind) ? record.kind : 'window';
    this.#windows.set(windowId, {
      id: windowId,
      kind,
      page,
      x1: rect.x1,
      y1: rect.y1,
      x2: rect.x2,
      y2: rect.y2,
      html: record.html,
      title: typeof record.title === 'string' && record.title ? record.title : windowId,
      text: typeof record.text === 'string' ? record.text : '',
      targetId: typeof record.targetId === 'string' && record.targetId ? record.targetId : null,
      url: typeof record.url === 'string' ? record.url : '',
      // 恢复时 revision 从磁盘值继续递增，浏览器不会误判为「内容未变」
      rev: Number.isInteger(record.rev) && record.rev > 0 ? record.rev : 1
    });
    this.#revision += 1;
    return this.#windows.get(windowId);
  }

  /** 恢复画布页（只在窗口之前调用一次；页 0 已存在时覆盖它） */
  restorePages(names) {
    if (!Array.isArray(names) || names.length === 0) return 0;
    const clean = names
      .slice(0, MAX_PAGES)
      .map((name, index) =>
        typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 40) : `第 ${index + 1} 页`
      );
    this.#pages = clean.map((name) => ({ name }));
    this.#revision += 1;
    return this.#pages.length;
  }

  clear() {
    this.#windows.clear();
    this.#pages = [{ name: DEFAULT_PAGE_NAME }];
    this.#revision += 1;
  }
}
