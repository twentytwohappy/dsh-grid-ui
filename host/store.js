/**
 * dsh-grid-ui · host/store.js
 * ----------------------------------------------------------------------------
 * 持久化：把「窗口表 + 画布页」落到磁盘，重启 DSH 后自动恢复。
 *
 * 存储介质的选择：用 DSH 自带的领域数据形式（@deepseek-ai/dsh-storage-domain），
 * 即 `ctx.storageDomain.open(spec)`，而不是自己 fs.writeFile 到一个私有路径。
 * 理由（都是官方约定，见 dsh-storage-domain/README.zh.md）：
 *   1. 每次写入在 resolve 之前就已经落到介质上 —— 不需要自己防抖/刷盘；
 *   2. 打开时按 zod schema 校验每条已存记录，损坏的记录会被挪走并跳过，
 *      不会因为一个坏字段让整个插件起不来；
 *   3. 路由（落到哪个后端、哪个根目录）由 profile 的基础层决定，插件不硬编码路径。
 *      当前 profile 的 dsh-base 把 domain 路由到 json 后端，根目录为
 *      `dshHomePath('storages')`，于是数据落在 `~/.dsh/storages/dsh_grid_ui.json`
 *      —— 单文件、可直接备份或手工编辑。
 *
 * 表结构（v0.4）：
 *   windows  窗口 / 按钮 / 面板，主键 = windowId
 *   pages    画布页顺序与名字，单条记录（id 固定为 'order'）
 *
 * 领域与表名必须匹配 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/（它会成为文件名与
 * 表键），因此用 `dsh_grid_ui` 而不是 `dsh-grid-ui`。
 *
 * 兼容性：领域版本仍为 1，新增字段一律给默认值 —— 旧版记录（没有 kind/page/
 * text/targetId）能被直接读进来，不需要迁移脚本；旧文件里没有 pages 表就是
 * 「只有一页」。
 *
 * 关于依赖：zod 与 storage-domain 用「带降级的动态 import」。插件是 link 进 profile
 * 的，开发目录里没有 node_modules；运行时 Node 从真实文件路径往上找，能解析到
 * profile 的 node_modules，但 `node test/xxx.mjs` 这种离线自测就解析不到。
 * 因此加载失败时降级为「纯内存模式」，而不是让整个插件起不来。
 * 另外支持 `globalThis.__DSH_GRID_UI_DEPS__` 注入（自测里用来固定到 DSH 安装目录的
 * 同一份包 —— 与 storage-domain 用到的 zod 必须是同一个实例）。
 */

/** 领域名常量（不依赖任何包，先导出，便于自测与日志使用） */
export const DOMAIN_NAME = 'dsh_grid_ui';

/** schema 版本：记录结构发生**不兼容**变化时 +1（新增可选字段不算） */
const DOMAIN_VERSION = 1;

/** pages 表里唯一那条记录的主键 */
export const PAGES_RECORD_KEY = 'order';

/**
 * 取依赖：优先用外部注入（自测），否则正常 import。
 * @param {string} spec
 */
function loadDependency(spec) {
  const injected = globalThis.__DSH_GRID_UI_DEPS__;
  if (injected && injected[spec]) return Promise.resolve(injected[spec]);
  return import(spec);
}

/** 领域声明：首次 openWindowDomain 时惰性构造（需要 zod） */
let domainSpec = null;

/**
 * 构造领域声明（供运行时与自测共用）。
 *
 * 单独导出是为了让 test/storage-real.mjs 能用**真实的** zod +
 * @deepseek-ai/dsh-storage-domain 校验这份 schema —— 测试里不需要起后端，
 * 只验证「旧记录能读、新字段有默认值、坏记录会被拒」这三件事。
 *
 * @param {object} z zod 命名空间
 * @param {{ defineDomain: Function, domainTable: Function }} domainModule
 * @returns {object} defineDomain 的返回值
 */
export function buildDomainSpec(z, domainModule) {
  const { defineDomain, domainTable } = domainModule;

  /**
   * 窗口记录。字段说明见 README「持久化」一节。
   * 新增字段全部带默认值，因此旧记录（v0.3 及更早写入的）可以直接读入。
   * 注意 zod 默认会丢弃未知字段、类型不符时抛错 —— 后者正好让损坏记录在
   * open 阶段被识别并按 invalidRecords 策略跳过。
   */
  const windowRecord = z.object({
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    html: z.string(),
    title: z.string(),
    rev: z.number().int().nonnegative(),
    /** ISO-8601，最后写入时间 */
    updatedAt: z.string(),
    /** v0.4：window / button / panel */
    kind: z.string().default('window'),
    /** v0.4：所属画布页（0 基） */
    page: z.number().int().nonnegative().default(0),
    /** v0.4：按钮文字（kind === 'button' 时使用） */
    text: z.string().default(''),
    /** v0.4：按钮点击后打开的面板 windowId */
    targetId: z.string().nullable().default(null),
    /** v0.6：远程网址窗口的地址（非空时用 iframe src 加载，html 不参与渲染） */
    url: z.string().default('')
  });

  /** 画布页：单条记录，保存页名顺序 */
  const pagesRecord = z.object({
    names: z.array(z.string()),
    updatedAt: z.string()
  });

  return defineDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    tables: {
      windows: domainTable(windowRecord),
      pages: domainTable(pagesRecord)
    }
  });
}

/** 模块级缓存：领域句柄 + 最近一次加载失败的原因（供日志说明） */
let opening = null;
let loadError = null;

/**
 * 取得（必要时打开）窗口领域的表句柄。
 *
 * 进程内只打开一次：cordis 重跑 apply() 时（热重载）会再次调用 open()，而设施
 * 对同名领域只允许同时打开一个（`already-open`）。窗口数据与进程无关，复用同
 * 一个句柄是安全的；真正的「重启」会换新进程，那时自然重新加载。
 *
 * 自测专用：`__resetWindowDomainForTests()` 清掉模块级缓存，让同一个 Node 进程
 * 能连续模拟多次 DSH 重启。
 *
 * @returns {Promise<{ windows: object, pages: object }>} 两张表的句柄
 * @throws 当 profile 没有挂载 storageDomain，或依赖不可用，或介质损坏时
 */
export function openWindowDomain(ctx) {
  const facility = ctx.get('storageDomain');
  // 句柄属于「某个进程里的某个设施」：换了设施实例（= 模拟重启）就必须重新打开，
  // 否则会拿上一个进程已经关闭的句柄，写入直接以 `closed` 失败。
  if (opening && opening.facility === facility) return opening.promise;
  if (!facility || typeof facility.open !== 'function') {
    return Promise.reject(
      new Error('当前 profile 没有挂载 storageDomain（@deepseek-ai/dsh-storage-domain）')
    );
  }

  const promise = (async () => {
    // 惰性加载：只有在真正要用持久化时才触碰这两个包
    const [zodModule, storageDomainModule] = await Promise.all([
      loadDependency('zod'),
      loadDependency('@deepseek-ai/dsh-storage-domain')
    ]).catch((error) => {
      loadError = error;
      throw new Error(`窗口持久化依赖加载失败：${error instanceof Error ? error.message : String(error)}`);
    });
    const { z } = zodModule;

    if (!domainSpec) domainSpec = buildDomainSpec(z, storageDomainModule);

    const domain = await facility.open(domainSpec);
    // 领域句柄按进程缓存（热重载复用）。注意它**不能**挂进 ctx.effect：
    // cordis 重跑 apply() 时旧 fiber 会释放资源，若把 close() 挂上去，重载后
    // 句柄就被关掉，下一次 put 会以 `closed` 失败。进程退出时句柄自然消失。
    return { windows: domain.table('windows'), pages: domain.table('pages') };
  })();

  opening = { facility, promise };
  // 打开失败时不要缓存失败的 Promise，否则热重载后永远没机会重试
  promise.catch(() => {
    if (opening && opening.promise === promise) opening = null;
  });
  return promise;
}

/** 自测专用：清掉模块级缓存，让同一 Node 进程能模拟多次重启 */
export function __resetWindowDomainForTests() {
  opening = null;
  loadError = null;
}

/** 最近一次依赖/介质失败的原因（自测与启动日志用） */
export function lastStorageError() {
  return loadError;
}

/** 把注册表里的窗口实体转成可存盘记录 */
export function toRecord(win) {
  return {
    x1: win.x1,
    y1: win.y1,
    x2: win.x2,
    y2: win.y2,
    html: win.html,
    title: win.title || win.id,
    rev: win.rev,
    updatedAt: new Date().toISOString(),
    kind: win.kind || 'window',
    page: Number.isInteger(win.page) ? win.page : 0,
    text: typeof win.text === 'string' ? win.text : '',
    targetId: typeof win.targetId === 'string' && win.targetId ? win.targetId : null,
    url: typeof win.url === 'string' ? win.url : ''
  };
}

/** 把页列表转成可存盘记录 */
export function pagesToRecord(names) {
  return { names: names.slice(), updatedAt: new Date().toISOString() };
}

/**
 * 启动时把磁盘上的窗口与画布页装回注册表。
 *
 * 读的是领域句柄的同步内存视图（`entries()`），因此不需要 await 逐条读取；
 * 先恢复页（窗口的 page 依赖它），再按 updatedAt 升序恢复窗口 ——
 * 这样单页窗口超限时保留「最近更新的那一批」。
 *
 * @param {{ windows: object, pages: object }} tables 两张表的句柄
 * @param {import('./windows.js').WindowRegistry} registry
 * @returns {{ loaded: number, skipped: number, pages: number }}
 */
export function restoreInto(tables, registry) {
  const empty = { loaded: 0, skipped: 0, pages: 0 };
  if (!tables || !tables.windows || registry.size > 0) return empty;

  // 1) 页
  let pages = 0;
  try {
    const stored = tables.pages && tables.pages.get(PAGES_RECORD_KEY);
    if (stored && Array.isArray(stored.names) && stored.names.length > 0) {
      pages = registry.restorePages(stored.names);
    }
  } catch (error) {
    /* 页记录坏了就退回默认单页，不影响窗口恢复 */
  }

  // 2) 窗口
  const rows = Array.from(tables.windows.entries());
  rows.sort((a, b) => String(a[1].updatedAt).localeCompare(String(b[1].updatedAt)));

  let loaded = 0;
  let skipped = 0;
  for (const [id, record] of rows) {
    try {
      registry.restore(id, record);
      loaded += 1;
    } catch (error) {
      skipped += 1;
    }
  }
  return { loaded, skipped, pages };
}
