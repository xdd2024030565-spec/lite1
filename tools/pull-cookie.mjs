// 从共享浏览器（DSH 侧栏「共享浏览器」标签）里取某个站点已登录状态下的凭证。
// 前提：那个标签里已经打开了对应站点并已登录。
//
// 用法：
//   node tools/pull-cookie.mjs chatglm.cn chatglm_refresh_token /tmp/glm.txt
//   node tools/pull-cookie.mjs kimi.ai ls:access_token /tmp/kimi.txt
//   node tools/pull-cookie.mjs doubao.com sessionid            （不给输出文件就只打印长度与前 8 位）
//
// 取值口径：`<cookie名>` 读 document.cookie；`ls:<键>` 读 localStorage。
// 默认连 http://127.0.0.1:9240 的 CDP，可用 SB_CDP_PORT 覆盖。

import { writeFileSync } from 'node:fs';

const [urlPart, target, outFile] = process.argv.slice(2);
if (!urlPart || !target) {
  console.error('用法: node tools/pull-cookie.mjs <页面地址片段> <cookie名|ls:键> [输出文件]');
  process.exit(2);
}

const CDP = 'http://127.0.0.1:' + (process.env.SB_CDP_PORT || '9240');

const list = await (await fetch(CDP + '/json/list')).json();
const pages = list.filter((t) => t.type === 'page');
const page = pages.find((t) => String(t.url || '').indexOf(urlPart) >= 0);
if (!page) {
  console.error('没有找到地址里含「' + urlPart + '」的页面，当前页面：');
  for (const p of pages) console.error('  ' + p.url);
  process.exit(1);
}

const expr = target.indexOf('ls:') === 0
  ? 'localStorage.getItem(' + JSON.stringify(target.slice(3)) + ')'
  : `(() => {
      const want = ${JSON.stringify(target)} + '=';
      const hit = document.cookie.split('; ').find((s) => s.indexOf(want) === 0);
      return hit ? decodeURIComponent(hit.slice(want.length)) : null;
    })()`;

const ws = new WebSocket(page.webSocketDebuggerUrl);
const waiters = new Map();
let id = 0;

function call(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    waiters.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => {
      if (waiters.has(mid)) {
        waiters.delete(mid);
        reject(new Error('超时: ' + method));
      }
    }, 15000);
  });
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  const w = msg.id && waiters.get(msg.id);
  if (!w) return;
  waiters.delete(msg.id);
  if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
  else w.resolve(msg.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('连不上 CDP：' + CDP + '，共享浏览器没起来？')), { once: true });
});

const res = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
ws.close();

const value = res && res.result ? res.result.value : null;
if (!value) {
  console.error('取到空值：' + target + '（页面 ' + page.url + '，可能没登录或键名不对）');
  process.exit(1);
}

if (outFile) {
  writeFileSync(outFile, value, { mode: 0o600 });
  console.log('已写入 ' + outFile + '（' + value.length + ' 字符）');
} else {
  console.log('长度 ' + value.length + '，开头：' + String(value).slice(0, 8) + '…');
}
