// deploy-api.mjs —— 不依赖 wrangler 的部署脚本（走 Cloudflare REST API）
//
// 为什么需要它：wrangler 依赖 esbuild，其 postinstall 在部分环境（如 Termux/Android）
// 装不上，`npm i -g wrangler` 会直接失败。本脚本只用 Node 标准库的 fetch + FormData
// 调 PUT /accounts/{acct}/workers/scripts/{name}，上传 main_module 与依赖模块（.js/.wasm），
// 并顺带写入 DEEPSEEK_TOKENS secret。
//
// 用法（token 只走环境变量，不要写进文件）：
//   CF_TOKEN=<Cloudflare API Token，需 Workers Scripts:Edit> \
//   DS_TOKEN=<DeepSeek 网页版 token，可选> \
//   node deploy-api.mjs
//
// 部署后自检：
//   curl https://deepseek-web.yongjiu.ccwu.cc/health
import fs from 'fs';

const TOKEN = process.env.CF_TOKEN;
const DS = process.env.DS_TOKEN;
const AC = process.env.CF_ACCOUNT || 'b9865b22dc4d64174713371c293e700f';
const NAME = 'deepseek-web';
const DIR = '/storage/emulated/0/dsh/lite1-clean/worker/deepseek/';

const js = fs.readFileSync(DIR + 'deepseek-web.js', 'utf8');
const wasm = fs.readFileSync(DIR + 'sha3_wasm_bg.wasm');

const metadata = {
  main_module: 'deepseek-web.js',
  compatibility_date: '2024-11-01',
  bindings: [
    { type: 'plain_text', name: 'ALLOW_ORIGIN', text: 'https://nav.yongjiu.ccwu.cc,https://lite1-3d8c30u.maozi.io,https://xdd2024030565-spec.github.io,https://lite-3d8c30u.maozi.io' },
    { type: 'plain_text', name: 'THINKING', text: 'auto' },
    { type: 'plain_text', name: 'SEARCH', text: 'auto' },
  ],
};
if (DS) metadata.bindings.push({ type: 'secret_text', name: 'DEEPSEEK_TOKENS', text: DS });

const fd = new FormData();
fd.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
fd.append('deepseek-web.js', new Blob([js], { type: 'application/javascript+module' }), 'deepseek-web.js');
fd.append('sha3_wasm_bg.wasm', new Blob([wasm], { type: 'application/wasm' }), 'sha3_wasm_bg.wasm');

// 强制给每个 part 加上 filename（Workers 上传接口依赖它）
const parts = [];
for (const [name, value] of fd.entries()) {
  if (typeof value === 'string') { parts.push({ name, value }); continue; }
  parts.push({ name, blob: value, filename: value.name || name });
}
const fd2 = new FormData();
for (const p of parts) {
  if (p.blob) fd2.append(p.name, p.blob, p.filename);
  else fd2.append(p.name, p.value);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${AC}/workers/scripts/${NAME}`;
const res = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd2 });
const text = await res.text();
let j = null; try { j = JSON.parse(text); } catch (e) {}
if (res.ok && j && j.success) {
  console.log('✅ 部署成功  script=' + NAME + '  http=' + res.status);
  console.log('   js=' + js.length + 'B  wasm=' + wasm.length + 'B  secret=' + (DS ? '已写入 DEEPSEEK_TOKENS' : '未写'));
} else {
  console.log('❌ 部署失败 http=' + res.status);
  console.log(text.slice(0, 600));
  process.exit(1);
}

// PUT /accounts/{acct}/workers/scripts/{name}  multipart: metadata + 模块文件
import fs from 'fs';

const TOKEN = process.env.CF_TOKEN;
const DS = process.env.DS_TOKEN;
const AC = process.env.CF_ACCOUNT || 'b9865b22dc4d64174713371c293e700f';
const NAME = 'deepseek-web';
const DIR = '/storage/emulated/0/dsh/lite1-clean/worker/deepseek/';

const js = fs.readFileSync(DIR + 'deepseek-web.js', 'utf8');
const wasm = fs.readFileSync(DIR + 'sha3_wasm_bg.wasm');

const metadata = {
  main_module: 'deepseek-web.js',
  compatibility_date: '2024-11-01',
  bindings: [
    { type: 'plain_text', name: 'ALLOW_ORIGIN', text: 'https://nav.yongjiu.ccwu.cc,https://lite1-3d8c30u.maozi.io,https://xdd2024030565-spec.github.io,https://lite-3d8c30u.maozi.io' },
    { type: 'plain_text', name: 'THINKING', text: 'auto' },
    { type: 'plain_text', name: 'SEARCH', text: 'auto' },
  ],
};
if (DS) metadata.bindings.push({ type: 'secret_text', name: 'DEEPSEEK_TOKENS', text: DS });

const fd = new FormData();
fd.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
fd.append('deepseek-web.js', new Blob([js], { type: 'application/javascript+module' }), 'deepseek-web.js');
fd.append('sha3_wasm_bg.wasm', new Blob([wasm], { type: 'application/wasm' }), 'sha3_wasm_bg.wasm');

// 强制给每个 part 加上 filename（Workers 上传接口依赖它）
const parts = [];
for (const [name, value] of fd.entries()) {
  if (typeof value === 'string') { parts.push({ name, value }); continue; }
  parts.push({ name, blob: value, filename: value.name || name });
}
const fd2 = new FormData();
for (const p of parts) {
  if (p.blob) fd2.append(p.name, p.blob, p.filename);
  else fd2.append(p.name, p.value);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${AC}/workers/scripts/${NAME}`;
const res = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN }, body: fd2 });
const text = await res.text();
let j = null; try { j = JSON.parse(text); } catch (e) {}
if (res.ok && j && j.success) {
  console.log('✅ 部署成功  script=' + NAME + '  http=' + res.status);
  console.log('   js=' + js.length + 'B  wasm=' + wasm.length + 'B  secret=' + (DS ? '已写入 DEEPSEEK_TOKENS' : '未写'));
} else {
  console.log('❌ 部署失败 http=' + res.status);
  console.log(text.slice(0, 600));
  process.exit(1);
}
