/**
 * dsh-grid-ui / test/persist-e2e.mjs
 * ----------------------------------------------------------------------------
 * 端到端验证「窗口自动存盘 + 重启自动恢复」的真实链路 —— 不需要浏览器。
 *
 * 用真实的 host/index.js（真工具、真路由、真注册表）+ 真实的
 * @deepseek-ai/dsh-storage-json 后端 + 真实 DomainFacility，只把「一个 DSH
 * 进程」抽象成 makeProcess()，于是在一个 Node 进程里可以连续模拟多次重启。
 *
 *   [A] 用 AI 工具建两个窗口 -> 断言磁盘文件里出现两条记录
 *   [B] 重启（新注册表 + 同一份磁盘）-> 断言窗口被装回，坐标/HTML/revision/title
 *       都对，且恢复动作本身不重复回写
 *   [C] 删掉其中一个 -> 断言磁盘同步删除，再重启只剩一个
 *   [D] 手工把坐标改成越界 -> 断言该记录被跳过，其余照常恢复
 *
 * 依赖真实包，位置可用 DSH_APP_DIR 覆盖（默认当前安装的 DSH Desktop）。
 * 运行：node test/persist-e2e.mjs
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const APP_DIR = process.env.DSH_APP_DIR || 'E:/PCL/dsh/DSH Desktop/resources/app';
const MODULES = path.join(APP_DIR, 'node_modules');
const DOMAIN_FILE = 'dsh_grid_ui.json';
const STATE_ROUTE = '/dsh-grid-ui/state';

const pkg = (name) => pathToFileURL(path.join(MODULES, '@deepseek-ai', name, 'lib', 'index.js')).href;
const storageDomain = await import(pkg('dsh-storage-domain'));
const { JsonStorageBackend } = await import(pkg('dsh-storage-json'));
const { DomainFacility } = storageDomain;

// zod 必须与 storage-domain 内部用的是同一个实例（schema 的 instanceof 判断），
// 所以从 DSH 安装目录解析；然后注入给 host/store.js 的惰性依赖加载器。
const appRequire = createRequire(path.join(MODULES, 'noop.js'));
const zod = appRequire('zod');
globalThis.__DSH_GRID_UI_DEPS__ = { zod, '@deepseek-ai/dsh-storage-domain': storageDomain };

const { apply } = await import('../host/index.js');
const { __resetWindowDomainForTests } = await import('../host/store.js');
const { __resetWebMountForTests } = await import('../host/web.js');

let failures = 0;
let total = 0;
function check(label, ok, detail) {
  total += 1;
  if (ok) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' -> ' + detail));
  }
}
const eq = (label, actual, expected) =>
  check(label, actual === expected, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDomain(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, DOMAIN_FILE), 'utf8'));
  } catch (error) {
    return null;
  }
}

/**
 * 取出单布局单元里的记录对象。
 * 磁盘格式（dsh-storage-json 的 single 布局）：
 *   { "unit": { "name": "dsh_grid_ui", "version": 1 }, "global": null, "tables": { "windows": { "<id>": {...} } } }
 */
function recordsOf(doc) {
  const unit = doc && doc.unit;
  const tables = doc && doc.tables;
  if (!unit || !tables) return {};
  return tables.windows || {};
}

/** 一个合法的窗口页面（内容只用于比对，不参与渲染） */
function page(tag) {
  return '<!DOCTYPE html><html><body><h1>' + tag + '</h1></body></html>';
}

/** 收集启动日志，用来断言恢复提示 */
const logLines = [];

/**
 * 造一个「DSH 进程」：假 ctx（效果/日志/工具注册/路由表/存储设施）。
 * @param {{ dir: string, routes?: Map<string, Function> }} options
 *        dir   —— 磁盘根目录（= DSH_HOME/storages）
 *        routes —— 复用同一份路由表，模拟「模块被缓存、只重跑 apply」
 */
async function makeProcess({ dir, routes: inheritedRoutes }) {
  // 全新「进程」：模块级缓存（领域句柄、mounted）都复位；真实重启会重新加载模块
  __resetWindowDomainForTests();
  if (!inheritedRoutes) __resetWebMountForTests();
  const routes = inheritedRoutes || new Map();

  // DomainFacility 直接读 ctx.storage.backend.get(name).kv，所以这里把
  // JsonStorageBackend 原样交给它（真实 DSH 里由 storage 中枢登记同一个对象）。
  // 注意不能包一层适配对象：facility 的 ctx 是 cordis 上下文，对 service 访问有
  // 代理语义，包一层会拿不到 kv facet。
  const backend = new JsonStorageBackend(dir);
  const facility = new DomainFacility(
    {
      storage: { backend: { get: () => backend } },
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      emit() {}
    },
    { backend: 'json' }
  );

  const tools = new Map();
  const ctx = {
    get(name) {
      if (name === 'storageDomain') return facility;
      return undefined;
    },
    effect(fn) {
      const dispose = fn();
      return dispose;
    },
    logger() {
      return {
        info: (msg) => logLines.push('I ' + msg),
        warn: (msg) => logLines.push('W ' + msg),
        debug: () => {},
        error: (msg) => logLines.push('E ' + msg)
      };
    },
    webServer: {
      register(route) {
        // 真 DSH 的重复路径规则：一个 path 只允许一条**完全匹配**的路由，
        // 但带查询串的子路径按前缀匹配，重复注册只是追加（与 dsh-host-webserver 一致）
        const exact = (route.path || '').split('?')[0];
        if (route.kind === 'exact' && routes.has(exact)) {
          throw new Error('webserver: duplicate exact route "' + exact + '"');
        }
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
      tapIndex(transform) {
        return () => {};
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
      }
    }
  };

  apply(ctx);
  // attachPersistence 是异步的：只是等它把上次的窗口装回来。
  // 不能等「文件出现」—— 磁盘上还没有记录时 json 后端不会建文件。
  await sleep(150);

  /** 发一个 HTTP 请求，返回 {status, json} */
  function call(method, pathname, body) {
    // 真实 webServer 允许路径带查询串；测试里按去掉查询串的路径匹配
    const handler = routes.get(pathname) || routes.get(pathname.split('?')[0]);
    if (!handler) return Promise.reject(new Error('no route ' + pathname));
    return new Promise((resolve) => {
      const chunks = [];
      const req = {
        method,
        headers: { 'content-type': 'application/json' },
        url: pathname,
        on(event, cb) {
          if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
          if (event === 'end') cb();
          return this;
        }
      };
      const res = {
        statusCode: 0,
        headers: {},
        setHeader(key, value) {
          this.headers[key.toLowerCase()] = value;
        },
        writeHead(status, headers) {
          this.statusCode = status;
          if (headers && typeof headers === 'object') {
            for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
          }
          return this;
        },
        end(chunk) {
          if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            json = undefined;
          }
          resolve({ status: this.statusCode, json });
        }
      };
      Promise.resolve(handler(req, res)).catch((error) => {
        resolve({ status: 599, json: { error: String(error) } });
      });
    });
  }

  return { ctx, facility, tools, routes, call, dir };
}

/** 用真实的 create_ui_window 工具建窗口，返回工具输出文本 */
async function createViaTool(p, { id, x1, y1, x2, y2, html, title }) {
  const tool = p.tools.get('create_ui_window');
  if (!tool) throw new Error('create_ui_window 未注册');
  const result = await tool.execute({
    gridX1: x1,
    gridY1: y1,
    gridX2: x2,
    gridY2: y2,
    html,
    windowId: id,
    ...(title ? { title } : {})
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

const settle = () => sleep(250);

const DATA_DIR = await mkdtemp(path.join(tmpdir(), 'dshgu-persist-'));
const BROKEN_DIR = await mkdtemp(path.join(tmpdir(), 'dshgu-broken-'));

try {
  console.log('[A] 建两个窗口，检查磁盘');
  const p1 = await makeProcess({ dir: DATA_DIR });
  const sharedRoutes = p1.routes;
  const text1 = await createViaTool(p1, {
    id: 'alpha',
    x1: 8,
    y1: 170,
    x2: 192,
    y2: 198,
    html: page('alpha'),
    title: 'input bar'
  });
  check('create_ui_window alpha 成功', text1.includes('alpha') && !/失败|错误/.test(text1), text1);
  const text2 = await createViaTool(p1, {
    id: 'beta',
    x1: 20,
    y1: 20,
    x2: 80,
    y2: 60,
    html: page('beta')
  });
  check('create_ui_window beta 成功', text2.includes('beta') && !/失败|错误/.test(text2), text2);

  await settle();
  const disk1 = await readDomain(DATA_DIR);
  check('磁盘文件 dsh_grid_ui.json 已生成', disk1 !== null);
  eq('磁盘里有两条窗口记录', Object.keys(recordsOf(disk1)).length, 2);
  const raw1 = await readFile(path.join(DATA_DIR, DOMAIN_FILE), 'utf8');
  check('落盘内容包含 alpha 的 HTML', raw1.includes('<h1>alpha</h1>'));
  check('落盘内容包含自定义 title', raw1.includes('input bar'));

  console.log('[B] 重启：窗口被自动装回');
  // web.js 用模块级 mounted 保证「一个进程只挂一次路由」，所以重启必须换进程；
  // 这里复用路由表 + 新注册表，等价于插件重跑 apply()。
  const p2 = await makeProcess({ dir: DATA_DIR, routes: sharedRoutes });
  const state2 = await p2.call('GET', STATE_ROUTE, undefined);
  const ids2 = (state2.json.windows || []).map((w) => w.id).sort();
  eq('重启后窗口数量', ids2.length, 2);
  eq('重启后窗口 id', ids2.join(','), 'alpha,beta');
  const alphaMeta = (state2.json.windows || []).find((w) => w.id === 'alpha') || {};
  check(
    '坐标原样恢复',
    alphaMeta.x1 === 8 && alphaMeta.y1 === 170 && alphaMeta.x2 === 192 && alphaMeta.y2 === 198,
    JSON.stringify(alphaMeta)
  );
  eq('title 原样恢复', alphaMeta.title, 'input bar');
  check('revision 被保留', Number(alphaMeta.rev) >= 1, String(alphaMeta.rev));
  const html2 = await p2.call('GET', '/dsh-grid-ui/window?id=alpha', undefined);
  eq('恢复后仍能取到同一份 HTML', html2.json && html2.json.html, page('alpha'));
  check(
    '启动日志记录了恢复数量',
    logLines.some((line) => line.indexOf('I 已从磁盘恢复 2 个窗口') === 0),
    logLines.join(' | ')
  );
  const disk2 = await readDomain(DATA_DIR);
  eq('恢复过程没有额外写盘（记录仍为 2）', Object.keys(recordsOf(disk2)).length, 2);

  console.log('[C] 删掉 beta，磁盘同步删除');
  const p3 = await makeProcess({ dir: DATA_DIR, routes: sharedRoutes });
  const removed = await p3.call('POST', '/dsh-grid-ui/remove', { id: 'beta' });
  check('删除 beta 成功', removed.status === 200 && removed.json.ok === true, JSON.stringify(removed.json));
  await settle();
  const rawAfter = await readFile(path.join(DATA_DIR, DOMAIN_FILE), 'utf8');
  check('磁盘上 alpha 仍在', rawAfter.includes('alpha'));
  check('磁盘上 beta 已消失', rawAfter.indexOf('"beta"') === -1, rawAfter.slice(0, 300));

  const p4 = await makeProcess({ dir: DATA_DIR, routes: sharedRoutes });
  const state4 = await p4.call('GET', STATE_ROUTE, undefined);
  eq('再次重启后只剩 alpha', (state4.json.windows || []).map((w) => w.id).join(','), 'alpha');

  console.log('[D] 损坏数据：越界坐标被跳过，其余照常恢复');
  const p5 = await makeProcess({ dir: BROKEN_DIR });
  const brokenRoutes = p5.routes;
  await createViaTool(p5, { id: 'good', x1: 1, y1: 1, x2: 50, y2: 50, html: page('good') });
  await createViaTool(p5, { id: 'bad', x1: 2, y1: 2, x2: 60, y2: 60, html: page('bad') });
  await settle();

  const brokenPath = path.join(BROKEN_DIR, DOMAIN_FILE);
  const brokenDoc = JSON.parse(await readFile(brokenPath, 'utf8'));
  recordsOf(brokenDoc).bad.x2 = 999; // 越界：恢复时必须被跳过
  await writeFile(brokenPath, JSON.stringify(brokenDoc), 'utf8');

  const p6 = await makeProcess({ dir: BROKEN_DIR, routes: brokenRoutes });
  const state6 = await p6.call('GET', STATE_ROUTE, undefined);
  const ids6 = (state6.json.windows || []).map((w) => w.id);
  check('损坏记录被跳过，只剩 good', ids6.length === 1 && ids6[0] === 'good', ids6.join(','));
  check(
    '跳过日志出现',
    logLines.some((line) => line.indexOf('跳过 1 条无法恢复的记录') !== -1),
    logLines.filter((l) => l.indexOf('I 已从磁盘恢复') === 0).join(' | ')
  );
} finally {
  await rm(DATA_DIR, { recursive: true, force: true });
  await rm(BROKEN_DIR, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部 ' + total + ' 项通过。' : '\n' + failures + '/' + total + ' 项失败。');
process.exitCode = failures === 0 ? 0 : 1;
