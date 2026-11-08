/**
 * storage-real.test —— 用**真实的** zod 与 @deepseek-ai/dsh-storage-domain
 * 校验持久化 schema（不需要起存储后端）。
 *
 * 目的：确认三件事
 *   1. 领域声明本身合法（defineDomain 的全部约束都过）；
 *   2. v0.3 时代的旧记录（没有 kind/page/text/targetId）能照常读入，新字段
 *      落到默认值 —— 这是「升级不丢数据」的保证；
 *   3. 新记录（按钮/面板/页）能过，坏记录（类型错、负数页号）会被拒 ——
 *      坏记录在 open 阶段会被 DomainFacility 识别并按 invalidRecords 策略处理。
 *
 * 依赖从 DSH 安装目录加载，与运行期完全同一份包：
 *   DSH_APP_DIR=<app dir> node test/storage-real.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDomainSpec } from '../host/store.js';

// 找一份装着真实依赖的 DSH 安装目录；找不到就跳过（CI / 别人的机器上没有这个路径）。
const APP_DIR = (() => {
  const candidates = [
    process.env.DSH_APP_DIR,
    'E:/PCL/dsh/DSH Desktop/resources/app',
    path.join(process.env.LOCALAPPDATA || '', 'Programs/DSH/resources/app'),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {}
  }
  return null;
})();

if (!APP_DIR) {
  console.log('\nstorage-real —— 跳过：找不到 DSH 安装目录（设置 DSH_APP_DIR 可启用真实依赖校验）\n');
  process.exit(0);
}

const requireFromApp = createRequire(path.join(APP_DIR, 'package.json'));

const load = async (specifier) => {
  const resolved = requireFromApp.resolve(specifier);
  return import(pathToFileURL(resolved).href);
};

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
};

console.log(`\nstorage-real —— 真实 zod + dsh-storage-domain（${APP_DIR}）\n`);

let z;
let domainModule;
try {
  ({ z } = await load('zod'));
  domainModule = await load('@deepseek-ai/dsh-storage-domain');
} catch (error) {
  console.log(
    `\nstorage-real —— 跳过：${APP_DIR} 里找不到 zod 或 dsh-storage-domain\n` +
      `  （${error instanceof Error ? error.message : String(error)}）\n`,
  );
  process.exit(0);
}
const { descriptorOf } = domainModule;

const spec = buildDomainSpec(z, domainModule);

/** 领域声明合法，且两张表都在 */
test('defineDomain 接受声明，表为 windows + pages', () => {
  const descriptor = descriptorOf(spec);
  assert.equal(descriptor.name, 'dsh_grid_ui');
  assert.equal(descriptor.version, 1);
  assert.deepEqual([...descriptor.tables].sort(), ['pages', 'windows']);
  assert.equal(typeof spec.tables.windows.valueSchema.parse, 'function');
  assert.equal(typeof spec.tables.pages.valueSchema.parse, 'function');
});

const parseWindow = (record) => spec.tables.windows.valueSchema.parse(record);
const parsePages = (record) => spec.tables.pages.valueSchema.parse(record);

/** v0.3 旧记录：新字段必须落到默认值（kind=window / page=0 / text='' / targetId=null） */
test('v0.3 旧记录可读入，v0.4 新字段落默认值', () => {
  const legacy = {
    x1: 10,
    y1: 20,
    x2: 90,
    y2: 120,
    html: '<p>hello</p>',
    title: 'old',
    rev: 1,
    updatedAt: '2026-08-01T10:00:00.000Z'
  };
  const parsed = parseWindow(legacy);
  assert.equal(parsed.x1, 10);
  assert.equal(parsed.x2, 90);
  assert.equal(parsed.html, '<p>hello</p>');
  assert.equal(parsed.kind, 'window');
  assert.equal(parsed.page, 0);
  assert.equal(parsed.text, '');
  assert.equal(parsed.targetId, null);
});

/** v0.4 按钮/面板记录完整过 schema */
test('v0.4 按钮/面板记录可过', () => {
  const button = parseWindow({
    x1: 5,
    y1: 5,
    x2: 25,
    y2: 15,
    html: '',
    title: '打开设置',
    rev: 2,
    updatedAt: '2026-08-20T10:00:00.000Z',
    kind: 'button',
    page: 2,
    text: '打开设置',
    targetId: 'panel_settings'
  });
  assert.equal(button.kind, 'button');
  assert.equal(button.page, 2);
  assert.equal(button.text, '打开设置');
  assert.equal(button.targetId, 'panel_settings');

  const panel = parseWindow({
    x1: 0,
    y1: 0,
    x2: 200,
    y2: 200,
    html: '<div>full</div>',
    title: 'panel_settings',
    rev: 1,
    updatedAt: '2026-08-20T10:01:00.000Z',
    kind: 'panel'
  });
  assert.equal(panel.kind, 'panel');
  assert.equal(panel.targetId, null);
});

/** 坏记录必须被拒：类型错、负页号、非整数 rev、缺字段 */
test('坏记录被拒', () => {
  const base = {
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 10,
    html: '',
    title: 't',
    rev: 0,
    updatedAt: 'now'
  };
  assert.throws(() => parseWindow({ ...base, x1: '10' }), '坐标字符串应被拒');
  assert.throws(() => parseWindow({ ...base, page: -1 }), '负页号应被拒');
  assert.throws(() => parseWindow({ ...base, rev: 1.5 }), '非整数 rev 应被拒');
  assert.throws(() => parseWindow({ ...base, targetId: 123 }), 'targetId 非字符串应被拒');
  assert.throws(() => parseWindow({ x1: 0 }), '缺字段应被拒');
});

/** 画布页记录 */
test('画布页记录可读入，坏结构被拒', () => {
  const parsed = parsePages({ names: ['首页', '数据', '设置'], updatedAt: '2026-08-20T10:02:00.000Z' });
  assert.deepEqual(parsed.names, ['首页', '数据', '设置']);
  assert.equal(parsed.updatedAt, '2026-08-20T10:02:00.000Z');

  assert.throws(() => parsePages({ names: '首页' }), 'names 非数组应被拒');
  assert.throws(() => parsePages({ names: [1, 2] }), 'names 非字符串应被拒');
});

/** 未知字段被丢弃（zod 默认行为）—— 前向兼容的基础 */
test('未知字段被丢弃，不影响已声明字段', () => {
  const parsed = parseWindow({
    x1: 0,
    y1: 0,
    x2: 10,
    y2: 10,
    html: '',
    title: 't',
    rev: 0,
    updatedAt: 'now',
    futureField: { nested: true }
  });
  assert.equal(parsed.futureField, undefined);
  assert.equal(parsed.kind, 'window');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
