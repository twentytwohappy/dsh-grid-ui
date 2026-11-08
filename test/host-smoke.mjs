/**
 * dsh-grid-ui · test/host-smoke.mjs
 * 在 Node 里用假 ctx 跑一遍 Host 半（host/index.js），不依赖真实 DSH 进程。
 *
 * 覆盖：
 *   1. apply(ctx) 能正常装起来（路由 7 条、工具 3 个、tapIndex 1 个）
 *   2. 路由路径都带本实例的 basePath 前缀（热重载不撞名）
 *   3. GET  <base>/state     → 窗口列表 + activeModel / thinkingLevel / permission / efforts
 *   4. POST <base>/action    → catalog（模型 + 权限）/ set_permission / send_message（含图片）
 *   5. 持久化：工具创建/更新/删除会同步写进领域存储；restoreInto 能把记录装回注册表并跳过损坏记录
 *   6. 卸载后再 apply 一次：旧路由被释放，新实例换新 basePath，不抛 duplicate route
 *
 * 运行：node test/host-smoke.mjs
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------- 假服务 --
const calls = { prompt: [], selectModel: [], setPermission: [], register: [], permissionNow: 'default' };

const fakeSession = { id: 'sess-host-smoke' };

const services = {
  llm: {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async (provider) => [
      { provider, id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text', 'image'] },
      { provider, id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
    ],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' }
        ],
        defaultEffort: 'low'
      }
    })
  },
  sessions: {
    get: (id) => (id === fakeSession.id ? fakeSession : undefined)
  },
  sessionProjections: {
    stateOf: (session, key) => {
      if (session !== fakeSession) return undefined;
      if (key === 'modelSelection') {
        return {
          lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
          pending: null
        };
      }
      if (key === 'permissions') return { preset: null, sandbox: null, approval: null };
      return undefined;
    }
  },
  permissionPresets: {
    catalog: () => ({
      options: [
        { value: 'default', name: 'Default' },
        { value: 'auto', name: 'Auto', description: '自动批准' }
      ],
      defaultPreset: 'default'
    }),
    current: () => calls.permissionNow,
    set: (session, name) => {
      calls.setPermission.push({ session, name });
      // 真实服务里 set() 会写 session 的权限投影，current() 随之变化；
      // 这里同步模拟，set_permission 的「读回确认」才有东西可等。
      calls.permissionNow = name;
    }
  },
  sessionController: {
    selectModel: async (request) => {
      calls.selectModel.push(request);
      return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } };
    },
    prompt: async (request, signal) => {
      // 真实实现是 prompt(request, signal) + signal.throwIfAborted()（session-controller/lib/index.js:3096），
      // 少传 signal 会抛 TypeError，这里复刻该前置检查作为回归护栏。
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      signal.throwIfAborted();
      calls.prompt.push(request);
      return { accepted: true };
    }
  },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' })
  },
  // 假的领域存储：与真实 KvTable 同接口（get/put/delete/entries/keys/size），
  // windows 表共享 store.records，其它表各自一份 Map，用来验证
  // 「写盘 → 重启 → 恢复」这条链路以及 v0.4 的 pages 表。
  storageDomain: {
    open: async (spec) => {
      store.opened.push(spec.name);
      return {
        name: spec.name,
        table: (name) => {
          store.tableName = name;
          if (name === 'windows') return store.table;
          if (!store.extra.has(name)) store.extra.set(name, fakeTable(new Map()));
          return store.extra.get(name);
        },
        close: async () => {}
      };
    }
  }
};

/** 假介质：模拟 ~/.dsh/storages/dsh_grid_ui.json 里的 records，接口与 KvTable 一致 */
function fakeTable(records) {
  return {
    get(key) {
      return records.get(key);
    },
    entries() {
      return [...records.entries()][Symbol.iterator]();
    },
    keys() {
      return [...records.keys()][Symbol.iterator]();
    },
    get size() {
      return records.size;
    },
    async put(key, value) {
      records.set(key, value);
    },
    async delete(key) {
      return records.delete(key);
    }
  };
}

const store = {
  opened: [],
  tableName: '',
  records: new Map(),
  /** 非 windows 表（v0.4 的 pages 表落在这里） */
  extra: new Map(),
  table: fakeTable(new Map())
};
// windows 表与 store.records 共享同一份 Map（测试里直接读它断言）
store.table = fakeTable(store.records);

// ---------------------------------------------------------------- 假 ctx --
function createCtx() {
  const routes = new Map();
  const taps = [];
  const tools = [];
  const disposers = [];
  /** 事件总线：记录 ctx.on 的订阅，测试里用 emit 主动触发 */
  const handlers = new Map();

  const ctx = {
    get: (name) => services[name],
    logger: { info() {}, warn() {} },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
      return () => {
        const list = handlers.get(name) || [];
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      };
    },
    webServer: {
      register: (route) => {
        if (routes.has(route.path)) {
          throw new Error(`webserver: duplicate exact route "${route.path}"`);
        }
        routes.set(route.path, route);
        calls.register.push(route.path);
        return () => routes.delete(route.path);
      },
      tapIndex: (fn) => {
        taps.push(fn);
        return () => {
          const at = taps.indexOf(fn);
          if (at >= 0) taps.splice(at, 1);
        };
      }
    },
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
      schemas: () => tools
    }
  };

  return {
    ctx,
    routes,
    taps,
    tools,
    /** 触发一次事件总线（模拟 DSH 的 session/event） */
    emit: (name, ...args) => {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
    dispose: () => {
      while (disposers.length > 0) {
        const disposer = disposers.pop();
        try {
          disposer();
        } catch (error) {
          /* ignore */
        }
      }
    }
  };
}

// ------------------------------------------------------------ 假 req/res --
function makeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = body === undefined ? '' : String(body);
    }
  };
  return res;
}

function makeReq(method, url, body) {
  const listeners = {};
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:43120' },
    on(type, fn) {
      (listeners[type] ??= []).push(fn);
      return req;
    },
    destroy() {}
  };
  if (body !== undefined) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    setTimeout(() => {
      for (const fn of listeners.data ?? []) fn(payload);
      for (const fn of listeners.end ?? []) fn();
    }, 0);
  }
  return req;
}

async function call(route, method, url, body) {
  const res = makeRes();
  await route.handler(makeReq(method, url, body), res);
  const text = res.body;
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    json = undefined;
  }
  return { status: res.status, text, json };
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${detail}`}`);
  }
}

// ---------------------------------------------------------------- 第一实例 --
const plugin = await import(pathToFileURL(join(ROOT, 'host', 'index.js')).href);
const first = createCtx();
plugin.apply(first.ctx);
await new Promise((resolve) => setTimeout(resolve, 10));

const basePath = '/dsh-grid-ui';
console.log('[1] 激活');
check('注册 7 个工具', first.tools.length === 7, first.tools.map((t) => t.name).join(','));
check(
  '工具名正确',
  [
    'create_ui_window',
    'update_ui_window',
    'remove_ui_window',
    'create_ui_page',
    'delete_ui_page',
    'open_ui_panel',
    'close_ui_panel'
  ].every((name) =>
    first.tools.some((tool) => tool.name === name)
  )
);
check('注册 9 条路由', first.routes.size === 9, [...first.routes.keys()].join(' '));
check(
  '路由路径固定（不带实例 ID）',
  JSON.stringify([...first.routes.keys()].sort()) ===
    JSON.stringify(
      [
        '/dsh-grid-ui/overlay.js',
        '/dsh-grid-ui/assets/bridge.js',
        '/dsh-grid-ui/assets/grid.css',
        '/dsh-grid-ui/state',
        '/dsh-grid-ui/feed',
        '/dsh-grid-ui/fetch',
        '/dsh-grid-ui/window',
        '/dsh-grid-ui/action',
        '/dsh-grid-ui/remove'
      ].sort()
    ),
  [...first.routes.keys()].join(' ')
);
check('注入 overlay 脚本', first.taps.length === 1);
const html = first.taps[0]('<html><head></head><body></body></html>');
check('注入标签指向固定路径', html.includes('<script defer src="/dsh-grid-ui/overlay.js"></script>'), html.slice(-80));

console.log('[2] GET state');
const stateRes = await call(first.routes.get(`${basePath}/state`), 'GET', `${basePath}/state?sessionId=sess-host-smoke`);
check('返回 200', stateRes.status === 200, stateRes.status);
check('ok=true', stateRes.json && stateRes.json.ok === true);
const state = stateRes.json && stateRes.json.state;
check('activeModel 来自会话投影', state && state.activeModel && state.activeModel.model === 'deepseek-chat', JSON.stringify(state && state.activeModel));
check('thinkingLevel 来自投影', state && state.thinkingLevel === 'low', state && state.thinkingLevel);
check('permission 来自 permissionPresets', state && state.permission === 'default', state && state.permission);
check('efforts 来自 resolveModelInfo', state && Array.isArray(state.efforts) && state.efforts.length === 2, JSON.stringify(state && state.efforts));
check('窗口列表为空数组', stateRes.json && Array.isArray(stateRes.json.windows) && stateRes.json.windows.length === 0);

console.log('[3] POST action');
const actionRoute = first.routes.get(`${basePath}/action`);

const catalogRes = await call(actionRoute, 'POST', `${basePath}/action`, {
  sessionId: 'sess-host-smoke',
  action: 'catalog',
  payload: {}
});
check('catalog 返回 2 个模型', catalogRes.json && catalogRes.json.catalog.models.length === 2);
check('catalog 返回 2 个权限预设', catalogRes.json && catalogRes.json.catalog.permissions.length === 2);
check(
  'catalog 含 defaultPreset',
  catalogRes.json && catalogRes.json.catalog.defaultPreset === 'default'
);

const permRes = await call(actionRoute, 'POST', `${basePath}/action`, {
  sessionId: 'sess-host-smoke',
  action: 'set_permission',
  payload: { preset: 'auto' }
});
check('set_permission 调到 permissionPresets.set', calls.setPermission.length === 1 && calls.setPermission[0].name === 'auto');
check('set_permission 返回 ok', permRes.json && permRes.json.ok === true);

const modelRes = await call(actionRoute, 'POST', `${basePath}/action`, {
  sessionId: 'sess-host-smoke',
  action: 'set_model',
  payload: { provider: 'deepseek', model: 'deepseek-reasoner' }
});
check('set_model 调到 selectModel', calls.selectModel.length === 1 && calls.selectModel[0].model === 'deepseek-reasoner');
check('set_model 返回 selected', modelRes.json && modelRes.json.selected.model === 'deepseek-reasoner');

const sendRes = await call(actionRoute, 'POST', `${basePath}/action`, {
  sessionId: 'sess-host-smoke',
  action: 'send_message',
  payload: {
    text: '看看这张图',
    images: [{ data: 'data:image/png;base64,AAAA', mediaType: 'image/png', name: 'shot.png' }]
  }
});
const prompt = calls.prompt.at(-1);
check('send_message 调到 prompt', Boolean(prompt));
check('文本进入 content', prompt && prompt.content[0].type === 'text' && prompt.content[0].text === '看看这张图');
check('图片进入 content 且去掉 data URL 前缀', prompt && prompt.content[1].type === 'image' && prompt.content[1].data === 'AAAA', prompt && JSON.stringify(prompt.content[1]));
check('返回 ok 与图片数', sendRes.json && sendRes.json.ok === true && sendRes.json.images === 1);

const emptyRes = await call(actionRoute, 'POST', `${basePath}/action`, {
  sessionId: 'sess-host-smoke',
  action: 'send_message',
  payload: { text: '   ' }
});
check('空消息被拒绝', emptyRes.status === 400 && emptyRes.json && emptyRes.json.ok === false);

console.log('[4] 持久化');
// 说明：本测试是 `node test/host-smoke.mjs` 直接跑的，插件目录里没有 node_modules，
// host/store.js 的动态 import('zod') 会失败并降级为纯内存模式 —— 这是刻意设计的降级路径
// （真实运行时 Node 从插件文件路径往上能找到 profile 的 node_modules）。
// 因此这里用公开接口把 sink 手工接到假介质上，验证「注册表 → 介质」这段逻辑本身。
const { restoreInto, toRecord } = await import(pathToFileURL(join(ROOT, 'host', 'store.js')).href);
const { WindowRegistry } = await import(pathToFileURL(join(ROOT, 'host', 'windows.js')).href);

const probeRegistry = new WindowRegistry();
probeRegistry.setSink({
  put: (win) => {
    store.records.set(win.id, toRecord(win));
    return Promise.resolve();
  },
  remove: (id) => store.records.delete(id)
});
const createTool2 = first.tools.find((tool) => tool.name === 'create_ui_window');
void createTool2;
// 直接驱动注册表（工具的 execute 写的是它自己那份 registry，这里验证的是 sink 契约）
probeRegistry.upsert({ id: 'persist-probe', html: '<p>hi</p>', rect: { x1: 0, y1: 0, x2: 10, y2: 10 } });
await new Promise((resolve) => setTimeout(resolve, 0));
const saved = store.records.get('persist-probe');
check('窗口写入领域存储', saved && saved.html === '<p>hi</p>', JSON.stringify(saved));
check('记录带完整坐标与 revision', saved && saved.x2 === 10 && saved.rev === 1);
check('记录带 updatedAt 时间戳', saved && typeof saved.updatedAt === 'string' && saved.updatedAt.includes('T'));

// 覆盖写：同一窗口再 patch 一次，记录应被替换而不是堆积
probeRegistry.patch('persist-probe', { rect: { x1: 0, y1: 0, x2: 20, y2: 20 } });
await new Promise((resolve) => setTimeout(resolve, 0));
const patched = store.records.get('persist-probe');
check('patch 后记录被更新（revision+1、坐标变化）', patched && patched.rev === 2 && patched.x2 === 20, JSON.stringify(patched));
check('patch 保留原 HTML', patched && patched.html === '<p>hi</p>');

// 删除：记录同步移除
probeRegistry.remove('persist-probe');
await new Promise((resolve) => setTimeout(resolve, 0));
check('删除窗口后记录同步移除', store.records.has('persist-probe') === false);
void createTool2;

// 降级路径：没有 storageDomain 时 openWindowDomain 必须给出可读的错误
const { openWindowDomain } = await import(pathToFileURL(join(ROOT, 'host', 'store.js')).href);
let degradeError = null;
try {
  await openWindowDomain({ get: () => undefined });
} catch (error) {
  degradeError = error;
}
check('缺少 storageDomain 时给出明确报错', Boolean(degradeError && /storageDomain/.test(degradeError.message)), degradeError && degradeError.message);

// 模拟重启：把两条记录预置进介质，再用一个全新的实例激活，窗口应自动装回
store.records.set('keep-a', {
  x1: 0,
  y1: 0,
  x2: 100,
  y2: 100,
  html: '<b>A</b>',
  title: 'A',
  rev: 3,
  updatedAt: '2026-01-01T00:00:00.000Z'
});
store.records.set('keep-b', {
  x1: 100,
  y1: 100,
  x2: 200,
  y2: 200,
  html: '<b>B</b>',
  title: 'B',
  rev: 7,
  updatedAt: '2026-01-02T00:00:00.000Z'
});
store.records.set('broken', {
  x1: 0,
  y1: 0,
  x2: 0,
  y2: 0, // 非法矩形：恢复时必须被跳过而不是让插件崩掉
  html: '<b>X</b>',
  title: 'X',
  rev: 1,
  updatedAt: '2026-01-03T00:00:00.000Z'
});

// store.js 里对领域是「进程内只打开一次」，所以直接验证 restoreInto + registry 的组合
const restored = new WindowRegistry();
const result = restoreInto({ windows: store.table }, restored);
check('恢复 2 个合法窗口', result.loaded === 2, JSON.stringify(result));
check('跳过 1 条非法记录', result.skipped === 1, JSON.stringify(result));
check('恢复后窗口数正确', restored.size === 2, String(restored.size));
check('恢复保留原 revision', restored.get('keep-b').rev === 7, String(restored.get('keep-b').rev));
check('恢复保留坐标与 HTML', restored.get('keep-a').x2 === 100 && restored.get('keep-a').html === '<b>A</b>');
check('toRecord 会把 title 回填为 id', toRecord({ id: 'x', title: '', html: '<i></i>', x1: 0, y1: 0, x2: 1, y2: 1, rev: 1 }).title === 'x');

// 装回后再改一次：应该写回介质（sink 已接上）
restored.setSink({ put: (win) => store.table.put(win.id, toRecord(win)), remove: (id) => store.table.delete(id) });
restored.patch('keep-a', { rect: { x1: 0, y1: 0, x2: 50, y2: 50 } });
await new Promise((resolve) => setTimeout(resolve, 0));
check('恢复后的窗口可继续写盘', store.records.get('keep-a').x2 === 50 && store.records.get('keep-a').rev === 4, JSON.stringify(store.records.get('keep-a')));

console.log('[5] 重新激活（模拟热重载）');
const oldPaths = [...first.routes.keys()];

const second = createCtx();
let reloadError;
try {
  plugin.apply(second.ctx);
} catch (error) {
  reloadError = error;
}
check('重新激活不抛错（不撞 duplicate route）', reloadError === undefined, reloadError && reloadError.message);
check('不重复注册路由（复用第一轮）', second.routes.size === 0, [...second.routes.keys()].join(' '));
check('旧路由仍在服务', first.routes.size === 9 && oldPaths.every((path) => first.routes.has(path)));

// handler 必须看到新的 runtime：第二个实例里新建窗口，第一个实例的 state 也应立刻反映
const secondTool2 = second.tools.find((tool) => tool.name === 'create_ui_window');
await secondTool2.execute({ windowId: 'reload-probe2', gridX1: 0, gridY1: 0, gridX2: 10, gridY2: 10, html: '<p>hi2</p>' });
const stateAfter = await call(first.routes.get(`${basePath}/state`), 'GET', `${basePath}/state?sessionId=sess-host-smoke`);
check(
  'handler 读取到最新 runtime',
  stateAfter.json && stateAfter.json.windows.some((w) => w.id === 'reload-probe2'),
  JSON.stringify(stateAfter.json && stateAfter.json.windows)
);
console.log('[6] v0.4 分页 / 按钮 / 面板');
// 注意：/state 路由的 handler 读到的是「第二次 apply」的 runtime，
// 因此这一节必须用 second.tools 操作，才能和 /state 看到同一份注册表。
const toolOf = (name) => second.tools.find((t) => t.name === name);
const stateOf = async () =>
  (await call(first.routes.get(`${basePath}/state`), 'GET', `${basePath}/state?sessionId=sess-host-smoke`)).json;

let v4state = await stateOf();
check('默认 1 页', Array.isArray(v4state.pages) && v4state.pages.length === 1, JSON.stringify(v4state.pages));
check('pageCount 与 pages 一致', v4state.state && v4state.state.pageCount === 1, String(v4state.state && v4state.state.pageCount));

const pageText = await toolOf('create_ui_page').execute({ name: '数据' });
check('create_ui_page 新建成功', /已新建第 2 页/.test(pageText), pageText);
v4state = await stateOf();
check(
  '新页进入 pages 且名字正确',
  v4state.pages.length === 2 && v4state.pages[1].name === '数据',
  JSON.stringify(v4state.pages)
);

// 按钮放在第 2 页，点击目标是面板 panel-1
const btnText = await toolOf('create_ui_window').execute({
  windowId: 'btn-1',
  kind: 'button',
  text: '打开面板',
  gridX1: 10,
  gridY1: 10,
  gridX2: 40,
  gridY2: 20,
  targetId: 'panel-1',
  page: 2
});
check('按钮创建成功', /已创建按钮/.test(btnText), btnText);
await toolOf('create_ui_window').execute({ windowId: 'panel-1', kind: 'panel', html: '<h1>panel</h1>' });

v4state = await stateOf();
const btnMeta = v4state.windows.find((win) => win.id === 'btn-1');
check(
  '按钮元数据完整',
  btnMeta && btnMeta.kind === 'button' && btnMeta.text === '打开面板' && btnMeta.targetId === 'panel-1' && btnMeta.page === 1,
  JSON.stringify(btnMeta)
);
check('面板不出现在画布列表', !v4state.windows.some((win) => win.id === 'panel-1'));

// 面板只能由 open_panel 打开，且必须是 kind=panel
const openText = await toolOf('open_ui_panel').execute({ windowId: 'panel-1' });
check('open_ui_panel 成功', /已打开面板/.test(openText), openText);
const notPanelRes = await call(actionRoute, 'POST', `${basePath}/action`, {
  sessionId: 'sess-host-smoke',
  action: 'open_panel',
  payload: { windowId: 'btn-1' }
});
check(
  '普通窗口不能经 action 全屏打开',
  notPanelRes.json && notPanelRes.json.ok === false && notPanelRes.json.code === 'grid-ui/not-a-panel',
  JSON.stringify(notPanelRes.json)
);
const closeText = await toolOf('close_ui_panel').execute({});
check('close_ui_panel 成功', /已关闭全屏面板/.test(closeText), closeText);

// 删除第 2 页会连带删除该页窗口；最后一页不允许删除
const delText = await toolOf('delete_ui_page').execute({ page: 2 });
check('delete_ui_page 连带窗口删除', /已删除第 2 页/.test(delText), delText);
v4state = await stateOf();
check('删除后回到 1 页且该页窗口清空', v4state.pages.length === 1 && v4state.windows.every((win) => win.page === 0), JSON.stringify(v4state.pages));
let lastPageErr = '';
try {
  await toolOf('delete_ui_page').execute({ page: 1 });
} catch (error) {
  lastPageErr = String(error && error.message);
}
check('最后一页不允许删除', /至少保留一页/.test(lastPageErr), lastPageErr);

// ==========================================================================
// [7] AI 输出监看（session/event → /feed）
// ==========================================================================
console.log('[7] AI 输出监看');
const feedRoute = first.routes.get(`${basePath}/feed`);
check('注册了 /feed 路由', Boolean(feedRoute), feedRoute && feedRoute.path);

const feedSession = { id: 'sess-host-smoke' };
second.emit('session/event', feedSession, { type: 'turn/start', data: { turn: 1 } });
second.emit('session/event', feedSession, {
  type: 'user/message',
  data: { message: { content: [{ type: 'text', text: '帮我把这页做成深色' }] } }
});
second.emit('session/event', feedSession, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: {
      content: [
        { type: 'reasoning', text: '先读一下现有颜色' },
        { type: 'text', text: '好的，我先把背景换成深色。' },
        { type: 'tool-call', id: 'c1', name: 'update_ui_window', input: { windowId: 'w1' } }
      ]
    }
  }
});
second.emit('session/event', feedSession, {
  type: 'tool/result',
  data: { message: { content: [{ type: 'text', text: '已更新窗口 w1' }] } }
});
second.emit('session/event', feedSession, { type: 'turn/end', data: { turn: 1 } });

let feedRes = await call(feedRoute, 'GET', `${basePath}/feed?sessionId=sess-host-smoke&since=0`);
check('GET /feed 返回 ok', feedRes.json && feedRes.json.ok === true, JSON.stringify(feedRes.json && feedRes.json.ok));
const feedItems = (feedRes.json && feedRes.json.items) || [];
check('收了 6 条动态（turn 起止 + 用户 + 助手 + 工具 + 工具结果）', feedItems.length === 6, `实际 ${feedItems.length} 条`);
check('有 user 动态', feedItems.some((item) => item.kind === 'user'), JSON.stringify(feedItems.map((i) => i.kind)));
check('有 assistant 动态', feedItems.some((item) => item.kind === 'assistant' && /深色/.test(item.text)), '');
check('有 tool 动态且带工具名', feedItems.some((item) => item.kind === 'tool' && item.tool === 'update_ui_window'), '');
check('tool-call 的 input 进了 text', feedItems.some((item) => item.kind === 'tool' && /windowId/.test(item.text)), '');
check('有 tool-result 动态', feedItems.some((item) => item.kind === 'tool-result' && /已更新窗口/.test(item.text)), '');
check('turn/end 后 busy=false', feedRes.json.busy === false, String(feedRes.json.busy));
const lastSeq = feedRes.json.seq;
check('seq 随动态递增', lastSeq === 6, String(lastSeq));

feedRes = await call(feedRoute, 'GET', `${basePath}/feed?sessionId=sess-host-smoke&since=${lastSeq - 1}`);
check('since 增量只返回最后 1 条', (feedRes.json.items || []).length === 1, JSON.stringify(feedRes.json.items));
check('增量条目是 turn 结束', feedRes.json.items[0].kind === 'turn' && feedRes.json.items[0].phase === 'end', JSON.stringify(feedRes.json.items[0]));

feedRes = await call(feedRoute, 'GET', `${basePath}/feed?sessionId=nobody&since=0`);
check('未知会话返回空动态', (feedRes.json.items || []).length === 0 && feedRes.json.busy === false, JSON.stringify(feedRes.json));

// ==========================================================================
// [8] 权限显示兜底（投影读不到时用最近一次写入）
// ==========================================================================
console.log('[8] 权限显示兜底');
const setPermRes = await call(actionRoute, 'POST', `${basePath}/action`, {
  sessionId: 'sess-host-smoke',
  action: 'set_permission',
  payload: { preset: 'auto' }
});
check(
  'set_permission 返回写入的预设',
  setPermRes.json && setPermRes.json.ok === true && setPermRes.json.permission === 'auto',
  JSON.stringify(setPermRes.json && setPermRes.json.permission)
);
check(
  'set_permission 回读确认字段存在',
  typeof (setPermRes.json && setPermRes.json.permissionConfirmed) === 'boolean',
  String(setPermRes.json && setPermRes.json.permissionConfirmed)
);

// 模拟「投影读回为空」：这时应该用刚才缓存的值，而不是跳回默认预设
calls.permissionNow = undefined;
let permState = await stateOf();
check('投影读不到时用缓存值', permState.state.permission === 'auto', String(permState.state.permission));
check('并且标记来源为 cache', permState.state.permissionSource === 'cache', String(permState.state.permissionSource));

// 投影恢复后以投影为准
calls.permissionNow = 'default';
permState = await stateOf();
check(
  '投影恢复后以会话为准',
  permState.state.permission === 'default' && permState.state.permissionSource === 'session',
  `${permState.state.permission}/${permState.state.permissionSource}`
);

// ==========================================================================
// [9] 读历史的游标兜底（throughSeq 超过持久化光标时自动降级）
// ==========================================================================
console.log('[9] 读历史游标兜底');
const { readHistoryPage } = await import(pathToFileURL(join(ROOT, 'host/actions.js')).href);

const pageSeqs = [];
const fakeController = {
  page: async (request) => {
    pageSeqs.push(request.throughSeq);
    if (request.throughSeq > 5) {
      throw new Error(
        `gateway/bad-request: session page through seq ${request.throughSeq} is past cursor 5`
      );
    }
    return { records: [{ event: { type: 'assistant/message', seq: request.throughSeq } }], hasMore: false };
  }
};

const pageResult = await readHistoryPage(fakeController, 'sess-x', 9, 50);
check(
  'past cursor 时自动用真实光标重读',
  pageResult.records.length === 1 && pageSeqs[0] === 9 && pageSeqs[1] === 5,
  JSON.stringify(pageSeqs)
);

pageSeqs.length = 0;
const okResult = await readHistoryPage(fakeController, 'sess-x', 3, 50);
check('光标之内只读一次', okResult.records.length === 1 && pageSeqs.length === 1 && pageSeqs[0] === 3, JSON.stringify(pageSeqs));

pageSeqs.length = 0;
const noHeadResult = await readHistoryPage(fakeController, 'sess-x', undefined, 20);
check('没有 head 时退化为 -1', noHeadResult && pageSeqs[0] === -1, JSON.stringify(pageSeqs));

let cursorlessError = '';
try {
  await readHistoryPage(
    { page: async () => { throw new Error('boom: something else'); } },
    'sess-x',
    1,
    10
  );
} catch (error) {
  cursorlessError = String(error && error.message);
}
check('非游标错误原样抛出', /boom/.test(cursorlessError), cursorlessError);

// ==========================================================================
// [10] 网址窗口 + 网络请求代理
// ==========================================================================
console.log('[10] 网址窗口与网络代理');

async function postJson(route, path, body) {
  return call(route, 'POST', path, body);
}

const createTool = toolOf('create_ui_window');
await createTool.execute({
  windowId: 'web-embed',
  kind: 'window',
  url: 'https://example.com/index.html',
  gridX1: 0,
  gridY1: 0,
  gridX2: 100,
  gridY2: 100,
  page: 1
});
const embedMeta = first.routes && (await first.runtimeState?.registry?.get?.('web-embed'));
const embedState = await call(first.routes.get(`${basePath}/state`), 'GET', `${basePath}/state`);
const embedWindow = (embedState.json.windows || []).find((item) => item.id === 'web-embed');
check('state 里带 url 字段', Boolean(embedWindow && embedWindow.url), JSON.stringify(embedWindow));
check(
  'url 被归一化',
  embedWindow && embedWindow.url === 'https://example.com/index.html',
  embedWindow && embedWindow.url
);

const embedWindowRes = await call(
  first.routes.get(`${basePath}/window`),
  'GET',
  `${basePath}/window?id=web-embed`
);
check(
  'GET /window 返回 url',
  embedWindowRes.json.url === 'https://example.com/index.html',
  embedWindowRes.json.url
);

let badUrlError = '';
try {
  await createTool.execute({
    windowId: 'web-bad',
    kind: 'window',
    url: 'javascript:alert(1)',
    gridX1: 0,
    gridY1: 0,
    gridX2: 10,
    gridY2: 10
  });
} catch (error) {
  badUrlError = String(error && error.message);
}
check('拒绝非 http(s) 地址', /只支持 http/.test(badUrlError), badUrlError);

// 用假的 global fetch 验证代理：不真的联网，只断言请求被正确组装、响应被正确解析
const realFetch = globalThis.fetch;
let seenUrl = '';
let seenInit = null;
globalThis.fetch = async (url, init) => {
  seenUrl = String(url);
  seenInit = init;
  return {
    status: 201,
    statusText: 'Created',
    url: String(url),
    headers: new Map([['content-type', 'application/json']]),
    arrayBuffer: async () => Buffer.from('{"hello":"world"}', 'utf8')
  };
};
try {
  const proxied = await postJson(first.routes.get(`${basePath}/fetch`), `${basePath}/fetch`, {
    url: 'https://api.example.com/v1/echo',
    method: 'POST',
    headers: { 'x-test': 'yes', host: 'ignored' },
    body: '{"a":1}'
  });
  check('代理返回远端状态码', proxied.json.status === 201, proxied.text.slice(0, 120));
  check('代理返回响应体文本', proxied.json.body === '{"hello":"world"}', proxied.json.body);
  check(
    '代理带上了 method 与 body',
    seenInit && seenInit.method === 'POST' && seenInit.body === '{"a":1}'
  );
  check(
    '代理不允许伪造 host 头',
    seenInit && seenInit.headers['x-test'] === 'yes' && !('host' in seenInit.headers),
    JSON.stringify(seenInit && seenInit.headers)
  );
  check('代理目标地址正确', seenUrl === 'https://api.example.com/v1/echo', seenUrl);

  const rejected = await postJson(first.routes.get(`${basePath}/fetch`), `${basePath}/fetch`, {
    url: 'file:///etc/passwd'
  });
  check(
    '代理拒绝 file://',
    rejected.json && rejected.json.ok === false && /只支持 http/.test(rejected.json.error || ''),
    rejected.text.slice(0, 120)
  );
} finally {
  globalThis.fetch = realFetch;
}

// ------------------------------------------------------------ 截图 / cookie --
console.log('[11] 截图与 cookie 共享');

await createTool.execute({
  windowId: 'shotme',
  kind: 'window',
  html: '<b>hi</b>',
  gridX1: 0,
  gridY1: 0,
  gridX2: 20,
  gridY2: 20
});

const shotMissing = await postJson(first.routes.get(`${basePath}/action`), `${basePath}/action`, {
  action: 'capture_window',
  payload: { windowId: 'no-such-window' }
});
check(
  '截图：窗口不存在时报错',
  shotMissing.json && shotMissing.json.ok === false && /窗口不存在/.test(shotMissing.json.error || ''),
  shotMissing.text.slice(0, 160)
);

const shotNoElectron = await postJson(first.routes.get(`${basePath}/action`), `${basePath}/action`, {
  action: 'capture_window',
  payload: { windowId: 'shotme' }
});
check(
  '截图：非 Electron 环境给出可读错误',
  shotNoElectron.json &&
    shotNoElectron.json.ok === false &&
    (shotNoElectron.json.code === 'grid-ui/no-electron' ||
      /截图|Electron/.test(shotNoElectron.json.error || '')),
  shotNoElectron.text.slice(0, 200)
);

const cookieSet = await postJson(first.routes.get(`${basePath}/action`), `${basePath}/action`, {
  action: 'cookie',
  payload: { op: 'set', url: 'https://example.com/a/b', name: 'sid', value: 'abc123' }
});
check('cookie：写入成功', cookieSet.json && cookieSet.json.ok === true && cookieSet.json.stored === true, cookieSet.text);

const cookieList = await postJson(first.routes.get(`${basePath}/action`), `${basePath}/action`, {
  action: 'cookie',
  payload: { op: 'list', url: 'https://example.com/a/c' }
});
check(
  'cookie：按 URL 列出（path=/ 覆盖子路径）',
  Array.isArray(cookieList.json && cookieList.json.cookies) &&
    cookieList.json.cookies.some((item) => item.name === 'sid' && item.value === 'abc123'),
  cookieList.text.slice(0, 200)
);

const cookieListOther = await postJson(first.routes.get(`${basePath}/action`), `${basePath}/action`, {
  action: 'cookie',
  payload: { op: 'list', url: 'https://other.example.org/' }
});
check(
  'cookie：不同站点取不到',
  Array.isArray(cookieListOther.json && cookieListOther.json.cookies) &&
    cookieListOther.json.cookies.length === 0,
  cookieListOther.text.slice(0, 200)
);

// 代理带上共享 cookie：用假 fetch 看请求头
const realFetch2 = globalThis.fetch;
let cookieHeader = '';
globalThis.fetch = async (url, init) => {
  cookieHeader = String((init && init.headers && (init.headers.Cookie || init.headers.cookie)) || '');
  return {
    status: 200,
    statusText: 'OK',
    url: String(url),
    headers: new Map([['content-type', 'text/plain']]),
    arrayBuffer: async () => Buffer.from('ok', 'utf8')
  };
};
try {
  await postJson(first.routes.get(`${basePath}/fetch`), `${basePath}/fetch`, {
    url: 'https://example.com/api/list'
  });
  check('代理自动带上共享 cookie', cookieHeader === 'sid=abc123', cookieHeader);
  const manual = await postJson(first.routes.get(`${basePath}/fetch`), `${basePath}/fetch`, {
    url: 'https://example.com/api/list',
    headers: { Cookie: 'custom=1' }
  });
  check(
    '代理不覆盖调用方显式给的 Cookie',
    cookieHeader === 'custom=1' && manual.json && manual.json.ok === true,
    cookieHeader
  );
} finally {
  globalThis.fetch = realFetch2;
}

const cookieRemove = await postJson(first.routes.get(`${basePath}/action`), `${basePath}/action`, {
  action: 'cookie',
  payload: { op: 'remove', url: 'https://example.com/' }
});
check('cookie：删除成功', cookieRemove.json && cookieRemove.json.removed >= 1, cookieRemove.text);

const cookieClear = await postJson(first.routes.get(`${basePath}/action`), `${basePath}/action`, {
  action: 'cookie',
  payload: { op: 'clear' }
});
check('cookie：清空成功', cookieClear.json && cookieClear.json.ok === true, cookieClear.text);

const stateForCaps = await call(first.routes.get(`${basePath}/state`), 'GET', `${basePath}/state`);
const caps = (stateForCaps.json && stateForCaps.json.state && stateForCaps.json.state.capabilities) || [];
check(
  '能力清单包含 capture_window 与 cookie',
  caps.includes('capture_window') && caps.includes('cookie'),
  caps.join(',')
);

// ---------------------------------------------------------- 12. 外链重定向 --
// 网址窗口里的 target=_blank：应该让发起的子 frame 就地 load，而不是弹系统浏览器。
const { createWindowOpenHandler } = await import(
  pathToFileURL(join(ROOT, 'host', 'electron.js')).href
);

function fakeWc(frameUrl) {
  const mainFrame = { url: 'file:///app/index.html' };
  const frame = {
    url: frameUrl,
    assign: [],
    executeJavaScript(code) {
      this.assign.push(code);
      return Promise.resolve();
    }
  };
  return { mainFrame, focusedFrame: frame, frame };
}

const openedExternal = [];
const shell = {
  openExternal(url) {
    openedExternal.push(url);
    return Promise.resolve();
  }
};

// 1) 子 frame 发起的 http 链接 → 原地跳转，不开外部浏览器
const childWc = fakeWc('https://www.bilibili.com/');
const childHandler = createWindowOpenHandler(childWc, shell);
const childResult = childHandler({ url: 'https://www.bilibili.com/video/BV1xx' });
check(
  '外链：网址窗口里的链接就地跳转',
  childResult.action === 'deny' &&
    childWc.frame.assign.length === 1 &&
    childWc.frame.assign[0].includes('location.assign("https://www.bilibili.com/video/BV1xx")') &&
    openedExternal.length === 0,
  JSON.stringify(childWc.frame.assign)
);

// 2) 主 frame（DSH 自己的界面）发起 → 保持原来的开外部浏览器
const mainWc = fakeWc('file:///app/index.html');
mainWc.focusedFrame = mainWc.mainFrame;
const mainHandler = createWindowOpenHandler(mainWc, shell);
openedExternal.length = 0;
mainHandler({ url: 'https://example.com/docs' });
check('外链：DSH 界面自己开链接仍走系统浏览器', openedExternal[0] === 'https://example.com/docs', openedExternal.join(','));

// 3) 子 frame 里的 mailto → 系统邮件客户端
openedExternal.length = 0;
openedExternal.length = 0;
childHandler({ url: 'mailto:hey@example.com' });
check('外链：mailto 交给系统处理', openedExternal[0] === 'mailto:hey@example.com', openedExternal.join(','));

// 4) 非法 URL / 非 web 协议 → 直接 deny，不做任何事
openedExternal.length = 0;
const before = childWc.frame.assign.length;
const bad = childHandler({ url: 'javascript:alert(1)' });
childHandler({ url: 'not a url' });
check(
  '外链：javascript: 与非法地址被拦下',
  bad.action === 'deny' && openedExternal.length === 0 && childWc.frame.assign.length === before,
  JSON.stringify(openedExternal)
);

// 5) 没有 executeJavaScript 的 frame → 退回系统浏览器，不崩
const crippled = fakeWc('https://example.com/');
delete crippled.frame.executeJavaScript;
openedExternal.length = 0;
createWindowOpenHandler(crippled, shell)({ url: 'https://example.com/next' });
check('外链：frame 无法执行脚本时退回系统浏览器', openedExternal[0] === 'https://example.com/next', openedExternal.join(','));

// 6) 焦点丢失（focusedFrame 为空）但存在唯一 http 子 frame → 仍然就地跳转
const mainOnly = { url: 'file:///app/index.html' };
const loneFrame = {
  url: 'https://www.bilibili.com/list',
  assign: [],
  executeJavaScript(code) {
    this.assign.push(code);
    return Promise.resolve();
  }
};
mainOnly.frames = [loneFrame];
const noFocusWc = { mainFrame: mainOnly, focusedFrame: null };
openedExternal.length = 0;
const noFocusResult = createWindowOpenHandler(noFocusWc, shell)({
  url: 'https://www.bilibili.com/video/BV2yy'
});
check(
  '外链：没有焦点帧时按唯一子 frame 就地跳转',
  noFocusResult.action === 'deny' &&
    loneFrame.assign.length === 1 &&
    loneFrame.assign[0].includes('BV2yy') &&
    openedExternal.length === 0,
  JSON.stringify(loneFrame.assign)
);

// 7) 完全没有 http 子 frame（纯 DSH 界面）→ 系统浏览器
const bareWc = { mainFrame: { url: 'file:///app/index.html' }, focusedFrame: null };
openedExternal.length = 0;
createWindowOpenHandler(bareWc, shell)({ url: 'https://example.com/x' });
check(
  '外链：没有网址窗口时行为不变',
  openedExternal[0] === 'https://example.com/x',
  openedExternal.join(',')
);

// 8) 同源兜底：多个子 frame 时优先挑与目标同 host 的那个
const biliFrame = {
  url: 'https://www.bilibili.com/',
  assign: [],
  executeJavaScript(code) {
    this.assign.push(code);
    return Promise.resolve();
  }
};
const otherFrame = {
  url: 'https://example.org/',
  assign: [],
  executeJavaScript(code) {
    this.assign.push(code);
    return Promise.resolve();
  }
};
const multiMain = { url: 'file:///app/index.html', frames: [otherFrame, biliFrame] };
openedExternal.length = 0;
createWindowOpenHandler({ mainFrame: multiMain, focusedFrame: null }, shell)({
  url: 'https://www.bilibili.com/video/BV3zz'
});
check(
  '外链：多窗口时按同源挑发起 frame',
  biliFrame.assign.length === 1 && otherFrame.assign.length === 0 && openedExternal.length === 0,
  `${biliFrame.assign.length}/${otherFrame.assign.length}`
);

void toolOf;
second.dispose();

console.log('');
if (failures === 0) {
  console.log('全部通过 ✅');
  process.exit(0);
} else {
  console.log(`${failures} 项失败 ❌`);
  process.exit(1);
}
