/**
 * dsh-grid-ui · test/cookies.mjs
 * 纯单元测试：cookie 解析 + 共享 cookie 罐（不依赖 Electron、不联网）。
 */

import { strict as assert } from 'node:assert';

import { CookieJar, parseSetCookie } from '../host/cookies.js';

let passed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
    return;
  }
  console.error(`  FAIL ${name}${detail === undefined ? '' : ` → ${detail}`}`);
  process.exitCode = 1;
}

console.log('[1] Set-Cookie 解析');

{
  const cookie = parseSetCookie(
    'SESSDATA=abc%2C123; Path=/; Domain=.Bilibili.com; Secure; HttpOnly; SameSite=Lax',
    'https://www.bilibili.com/video/BV1'
  );
  check('解析 name/value', cookie && cookie.name === 'SESSDATA' && cookie.value === 'abc%2C123');
  check('domain 去掉前导点并小写', cookie.domain === 'bilibili.com' && cookie.hostOnly === false);
  check('path 保留', cookie.path === '/');
  check('secure / httpOnly', cookie.secure === true && cookie.httpOnly === true);
  check('sameSite 小写', cookie.sameSite === 'lax');
}

{
  const cookie = parseSetCookie('a=1', 'https://example.com/dir/page.html?x=1');
  check('没有 Domain 时按请求主机名 + hostOnly', cookie.domain === 'example.com' && cookie.hostOnly === true);
  check('默认 path 是目录部分', cookie.path === '/dir', cookie.path);
  check('默认不 secure', cookie.secure === false);
}

{
  const root = parseSetCookie('a=1', 'https://example.com/');
  check('根路径默认 /', root.path === '/');
}

{
  const future = parseSetCookie('a=1; Max-Age=3600', 'https://example.com/');
  check('Max-Age 转成绝对过期时间', Number.isFinite(future.expires) && future.expires > Date.now());
  const past = parseSetCookie('a=1; Max-Age=0', 'https://example.com/');
  check('Max-Age=0 视为立即过期', past.expires === 0);
  const date = parseSetCookie('a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT', 'https://example.com/');
  check('Expires 解析为时间戳', Number.isFinite(date.expires) && date.expires > Date.now());
}

{
  check('空头返回 null', parseSetCookie('', 'https://example.com/') === null);
  check('没有等号返回 null', parseSetCookie('novalue', 'https://example.com/') === null);
  check('非法请求地址返回 null', parseSetCookie('a=1', 'not a url') === null);
  check('超长值丢弃', parseSetCookie(`a=${'x'.repeat(9000)}`, 'https://example.com/') === null);
}

console.log('[2] cookie 罐');

{
  const jar = new CookieJar();
  jar.storeHeader('sid=1; Path=/; Domain=example.com', 'https://example.com/x');
  jar.storeHeader('theme=dark; Path=/app', 'https://example.com/app/y');

  check('同一域名都能取到', jar.match('https://example.com/app/x').length === 2);
  check('Cookie 头按 path 长度降序', jar.header('https://example.com/app/z') === 'theme=dark; sid=1', jar.header('https://example.com/app/z'));
  check('路径不匹配取不到 theme', jar.header('https://example.com/other') === 'sid=1');
  check('子域能拿到 Domain cookie', jar.header('https://sub.example.com/') === 'sid=1');
  check('别的域名拿不到', jar.header('https://other.org/') === '');
}

{
  const jar = new CookieJar();
  jar.storeHeader('h=1', 'https://example.com/');
  check('hostOnly 不进子域', jar.header('https://sub.example.com/') === '');
  check('hostOnly 精确匹配', jar.header('https://example.com/') === 'h=1');
}

{
  const jar = new CookieJar();
  jar.storeHeader('sec=1; Secure', 'https://example.com/');
  check('Secure cookie 只在 https 发送', jar.header('https://example.com/') === 'sec=1');
  check('Secure cookie 不在 http 发送', jar.header('http://example.com/') === '');
}

{
  const jar = new CookieJar();
  jar.store({ name: 'gone', value: '1', domain: 'example.com', hostOnly: true, path: '/', secure: false, httpOnly: false, expires: Date.now() - 1000, sameSite: null });
  check('过期 cookie 不发送', jar.header('https://example.com/') === '');
  check('过期 cookie 不出现在 list', jar.list({ url: 'https://example.com/' }).length === 0);
}

{
  const jar = new CookieJar();
  jar.storeHeader('a=1', 'https://example.com/');
  check('同名同域覆盖而不是新增', jar.store({ name: 'a', value: '2', domain: 'example.com', hostOnly: true, path: '/', secure: false, httpOnly: false, expires: null, sameSite: null }) && jar.header('https://example.com/') === 'a=2');
  check('Max-Age=0 删除已有 cookie', jar.storeHeader('a=1; Max-Age=0', 'https://example.com/') === true && jar.header('https://example.com/') === '');
}

{
  const jar = new CookieJar();
  jar.storeHeader('a=1', 'https://example.com/');
  jar.storeHeader('b=2', 'https://example.com/');
  check('list 按 domain 过滤', jar.list({ domain: 'example.com' }).length === 2);
  check('remove 指定名字只删一个', jar.remove('https://example.com/', 'a') === 1 && jar.header('https://example.com/') === 'b=2');
  check('clear 清空并返回条数', jar.clear() === 1 && jar.map.size === 0);
}

{
  const jar = new CookieJar();
  let accepted = 0;
  for (let i = 0; i < 2100; i += 1) {
    if (jar.storeHeader(`k${i}=v`, 'https://example.com/')) accepted += 1;
  }
  check('cookie 总数有上限（2000）', jar.map.size === 2000 && accepted === 2000, `${jar.map.size}/${accepted}`);
}

console.log('');
if (process.exitCode) {
  console.error('有失败项 ❌');
} else {
  console.log(`全部通过 ✅（${passed} 项）`);
}
assert.ok(passed > 0);
