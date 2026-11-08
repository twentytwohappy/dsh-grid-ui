/**
 * dsh-grid-ui · test/smoke.mjs
 * 用最小 DOM 桩在 Node 里跑一遍 client/overlay.js，验证浏览器侧的纯逻辑：
 *   1. 资源加载 → 注入 <style> → 建出 .dshgu-root / grid / windows / ball
 *   2. 轮询到窗口后，iframe 的百分比几何、sandbox 属性、srcdoc 包装是否正确
 *   3. 悬浮球能切换 body 上的 dshgu-custom-mode
 *   4. Ctrl+Shift+R 能强制回退
 *   5. 只接受自己 iframe 发来的 dsh-action，并转发为 POST /action
 *
 * 运行：node test/smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const overlaySource = readFileSync(join(ROOT, 'client', 'overlay.js'), 'utf8');
const bridgeSource = readFileSync(join(ROOT, 'client', 'bridge.js'), 'utf8');
const cssSource = readFileSync(join(ROOT, 'styles', 'grid.css'), 'utf8');

// ---------------------------------------------------------------- DOM 桩 --
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.id = '';
    this.textContent = '';
    this.srcdoc = '';
    this._listeners = {};
    this._classes = new Set();
    const self = this;
    this.classList = {
      add(name) {
        self._classes.add(name);
        self.className = [...self._classes].join(' ');
      },
      remove(name) {
        self._classes.delete(name);
        self.className = [...self._classes].join(' ');
      },
      contains(name) {
        return self._classes.has(name);
      },
      toggle(name, force) {
        const on = force === undefined ? !self._classes.has(name) : Boolean(force);
        if (on) this.add(name);
        else this.remove(name);
        return on;
      }
    };
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (!this.parentNode) return;
    const at = this.parentNode.children.indexOf(this);
    if (at >= 0) this.parentNode.children.splice(at, 1);
    this.parentNode = null;
  }

  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }

  removeEventListener() {}

  setPointerCapture() {}

  releasePointerCapture() {}

  get offsetWidth() {
    return parseFloat(this.style.width) || 44;
  }

  get offsetHeight() {
    return parseFloat(this.style.height) || 44;
  }

  getBoundingClientRect() {
    const left = parseFloat(this.style.left) || 0;
    const top = parseFloat(this.style.top) || 0;
    return {
      left,
      top,
      width: this.offsetWidth,
      height: this.offsetHeight,
      right: left + this.offsetWidth,
      bottom: top + this.offsetHeight
    };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  querySelector(selector) {
    const matches = (node) =>
      selector.startsWith('.')
        ? node.className.split(/\s+/).includes(selector.slice(1))
        : node.tagName === selector.toUpperCase();
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child)) return child;
        const deeper = walk(child);
        if (deeper) return deeper;
      }
      return null;
    };
    return walk(this);
  }

  dispatch(type, event) {
    for (const fn of this._listeners[type] ?? []) fn(event);
  }
}

const body = new FakeNode('body');
const head = new FakeNode('head');
const conversation = new FakeNode('div');
conversation.setAttribute('data-conversation-session', 'sess-smoke');

const document = {
  readyState: 'complete',
  head,
  body,
  createElement: (tag) => new FakeNode(tag),
  addEventListener() {},
  getElementById: (id) => {
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === id) return child;
        const deeper = walk(child);
        if (deeper) return deeper;
      }
      return null;
    };
    return walk(body);
  },
  querySelector: (selector) =>
    selector === '[data-conversation-session]' ? conversation : null
};

// -------------------------------------------------------------- 网络桩 --
const windows = [
  { id: 'demo', kind: 'window', page: 0, x1: 10, y1: 10, x2: 105, y2: 105, rev: 1, title: '演示' }
];
const calls = [];

function fetchStub(url, options = {}) {
  const href = String(url);
  calls.push({ url: href, options });

  if (href.endsWith('/assets/grid.css')) {
    return Promise.resolve({ ok: true, text: () => Promise.resolve(cssSource) });
  }
  if (href.endsWith('/assets/bridge.js')) {
    return Promise.resolve({ ok: true, text: () => Promise.resolve(bridgeSource) });
  }
  if (href.includes('/dsh-grid-ui/window')) {
    return Promise.resolve({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ ok: true, id: 'demo', rev: 1, html: '<div id="inner">hi</div>' })
        )
    });
  }
  if (href.endsWith('/dsh-grid-ui/state')) {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          revision: 1,
          windows,
          pages: [{ index: 0, name: '第 1 页', windows: windows.length }],
          state: {
            sessionId: 'sess-smoke',
            windows: windows.length,
            thinkingLevel: 'low',
            activeModel: { provider: 'deepseek', model: 'deepseek-chat' },
            pages: [{ index: 0, name: '第 1 页', windows: windows.length }],
            pageCount: 1,
            openPanel: null,
            capabilities: ['set_thinking_level']
          }
        })
    });
  }
  if (href.endsWith('/dsh-grid-ui/action')) {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          state: { sessionId: 'sess-smoke', thinkingLevel: 'high', activeModel: null }
        })
    });
  }
  if (href.endsWith('/dsh-grid-ui/remove')) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  }
  return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
}

// -------------------------------------------------------------- 沙箱 --
const store = new Map();
const sandbox = {
  console,
  fetch: fetchStub,
  setTimeout,
  setInterval: () => 0,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  document,
  encodeURIComponent,
  JSON,
  Promise,
  Set,
  Map,
  Math,
  Date,
  String,
  Number,
  Array,
  Object,
  Error,
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value))
  }
};
sandbox.window = sandbox;
sandbox.innerWidth = 1280;
sandbox.innerHeight = 800;
sandbox.__listeners = {};
sandbox.addEventListener = (type, fn) => {
  (sandbox.__listeners[type] ??= []).push(fn);
};
sandbox.removeEventListener = () => {};
sandbox.parent = sandbox;

vm.createContext(sandbox);
vm.runInContext(overlaySource, sandbox, { filename: 'overlay.js' });

// -------------------------------------------------------------- 断言 --
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${detail}`}`);
  }
}

await tick(80);

console.log('[1] DOM 构建');
const rootEl = document.body.children.find((node) => node.id === 'dshgu-root');
check('注入 .dshgu-root', Boolean(rootEl));
check('root 下含网格层', Boolean(rootEl && rootEl.children.some((n) => n.className === 'dshgu-grid')));
check('root 下含窗口层', Boolean(rootEl && rootEl.children.some((n) => n.className === 'dshgu-windows')));
check('root 下含悬浮球', Boolean(rootEl && rootEl.children.some((n) => n.className === 'dshgu-ball')));
check('注入 <style>', head.children.some((n) => n.id === 'dshgu-style'));
const gridRule = (cssSource.match(/\.dshgu-grid\s*\{([\s\S]*?)\}/) ?? [])[1] ?? '';
check(
  '网格层不绘制格线（逻辑网格）',
  !gridRule.includes('repeating-linear-gradient') && !gridRule.includes('background-image'),
  gridRule.trim()
);

const windowsEl = rootEl.children.find((n) => n.className === 'dshgu-windows');
const iframe = windowsEl.children[0].children.find((n) => n.tagName === 'IFRAME');

console.log('[2] 窗口几何与沙箱');
const win = windowsEl.children[0];
check('窗口 left = 5%', win.style.left === '5%', win.style.left);
check('窗口 top = 5%', win.style.top === '5%', win.style.top);
check('窗口 width = 47.5%', win.style.width === '47.5%', win.style.width);
check('窗口 height = 47.5%', win.style.height === '47.5%', win.style.height);
check('sandbox 无 allow-same-origin', iframe.attributes.sandbox === 'allow-scripts allow-forms', iframe.attributes.sandbox);
check('srcdoc 含 bridge', iframe.srcdoc.includes('window.dsh'));
check('srcdoc 含 AI 内容', iframe.srcdoc.includes('<div id="inner">hi</div>'));
check('srcdoc 是完整文档', iframe.srcdoc.startsWith('<!doctype html>'));

console.log('[3] 模式切换');
const ball = rootEl.children.find((n) => n.className === 'dshgu-ball');
check('首次有窗口自动进入自定义模式', document.body.classList.contains('dshgu-custom-mode'));
ball.dispatch('click', {});
check('点击悬浮球退出自定义模式', !document.body.classList.contains('dshgu-custom-mode'));
ball.dispatch('click', {});
check('再次点击进入自定义模式', document.body.classList.contains('dshgu-custom-mode'));
check('模式持久化到 localStorage', store.get('dsh-grid-ui.custom-mode') === '1', store.get('dsh-grid-ui.custom-mode'));

console.log('[3b] 悬浮球拖动与位置记忆');
const beforeDrag = document.body.classList.contains('dshgu-custom-mode');
ball.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 400, clientY: 100 });
ball.dispatch('pointermove', {
  pointerId: 1,
  clientX: 462,
  clientY: 164,
  cancelable: true,
  preventDefault() {}
});
check('拖动改变 left', ball.style.left === '62px', ball.style.left);
check('拖动改变 top', ball.style.top === '64px', ball.style.top);
check('拖动不切换模式', document.body.classList.contains('dshgu-custom-mode') === beforeDrag);
ball.dispatch('pointerup', { pointerId: 1 });
const storedBall = JSON.parse(store.get('dsh-grid-ui.ball-pos') || 'null');
check('拖动后位置写入 localStorage', storedBall && storedBall.x === 62 && storedBall.y === 64, JSON.stringify(storedBall));
ball.dispatch('click', {});
check('拖动紧跟的这一次 click 被吞掉', document.body.classList.contains('dshgu-custom-mode') === beforeDrag);
await tick(320);
ball.dispatch('click', {});
check('拖动结束后的正常点击仍然生效', document.body.classList.contains('dshgu-custom-mode') !== beforeDrag);
// 小位移（< 4px）应当仍被当作点击
const beforeTap = document.body.classList.contains('dshgu-custom-mode');
ball.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
ball.dispatch('pointermove', { pointerId: 2, clientX: 102, clientY: 101, cancelable: true, preventDefault() {} });
ball.dispatch('pointerup', { pointerId: 2 });
ball.dispatch('click', {});
check('微小手抖不触发拖动、按点击处理', document.body.classList.contains('dshgu-custom-mode') !== beforeTap);

console.log('[4] Ctrl+Shift+R 强制回退');
for (const fn of sandbox.__listeners.keydown ?? []) {
  fn({ ctrlKey: true, shiftKey: true, key: 'R', preventDefault() {}, stopPropagation() {} });
}
check('快捷键切回原版模式', !document.body.classList.contains('dshgu-custom-mode'));

console.log('[5] postMessage 桥');
const messageHandlers = sandbox.__listeners.message ?? [];
const contentWindow = iframe.contentWindow ?? (iframe.contentWindow = { name: 'iframe-window' });
const postedActions = () =>
  calls
    .filter((c) => c.url.endsWith('/dsh-grid-ui/action'))
    .map((c) => {
      try {
        return JSON.parse(c.options.body);
      } catch (error) {
        return {};
      }
    });

check('启动时请求 catalog 目录', postedActions().some((b) => b.action === 'catalog'));
check(
  '登记可拆解的运行时实例（热重载用）',
  sandbox.__DSH_GRID_UI__ && typeof sandbox.__DSH_GRID_UI__.teardown === 'function',
  sandbox.__DSH_GRID_UI__ && sandbox.__DSH_GRID_UI__.base
);

// 陌生来源：必须被忽略
for (const fn of messageHandlers) {
  fn({ data: { type: 'dsh-action', action: 'send_message', payload: { text: 'evil' } }, source: {} });
}
await tick();
check(
  '忽略非本插件 iframe 的 dsh-action',
  postedActions().every((b) => !(b.payload && b.payload.text === 'evil'))
);

// 自己的 iframe：应转发到 /action（含图片消息）
for (const fn of messageHandlers) {
  fn({
    data: {
      type: 'dsh-action',
      action: 'send_message',
      payload: { text: 'Hi', images: [{ data: 'AAAA', mediaType: 'image/png' }] }
    },
    source: contentWindow
  });
}
await tick(80);
const sent = postedActions().filter((b) => b.action === 'send_message' && b.payload.text === 'Hi');
check('转发 dsh-action 到 /action', sent.length === 1, sent.length);
check('请求体带 sessionId / action / payload', sent[0] && sent[0].sessionId === 'sess-smoke');
check(
  '图片原样进入 payload.images',
  sent[0] && Array.isArray(sent[0].payload.images) && sent[0].payload.images.length === 1
);

// ready 握手 + 状态回推
let pushed = null;
contentWindow.postMessage = (message) => {
  pushed = message;
};
for (const fn of messageHandlers) fn({ data: { type: 'dsh-ready' }, source: contentWindow });
await tick(120);
check('收到 dsh-ready 后回推 dsh-state', Boolean(pushed && pushed.type === 'dsh-state'), JSON.stringify(pushed));
check('回推状态含 thinkingLevel', Boolean(pushed && pushed.state && 'thinkingLevel' in pushed.state));

console.log('');
if (failures === 0) {
  console.log('全部通过 ✅');
  process.exit(0);
} else {
  console.log(`${failures} 项失败 ❌`);
  process.exit(1);
}
