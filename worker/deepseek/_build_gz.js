const fs=require('fs');
let src=fs.readFileSync('deepseek-web.js','utf8');
const b64=fs.readFileSync('_wasm_gz_b64.txt','utf8').trim().replace(/\s/g,'');

const header = `// 部署变体：WASM 以 gzip+base64 内嵌，运行时用 DecompressionStream 还原。
// 与 sha3_wasm_bg.wasm 完全等价（26612 字节 -> gzip 13554 -> base64 18072）。
const WASM_GZ_B64 = '${b64}';

async function wasmBytes(){
  const bin = atob(WASM_GZ_B64);
  const gz = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('gzip');
  const out = new Response(new Blob([gz]).stream().pipeThrough(ds));
  return await out.arrayBuffer();
}`;

// 替换 import 行
src = src.replace(/^import wasmModule from '\.\/sha3_wasm_bg\.wasm';\s*$/m, header);

// instantiate 改为 await（wasmBytes 现在是 async）
src = src.replace(
  /wasmPromise = WebAssembly\.instantiate\(wasmModule, \{\}\)/,
  'wasmPromise = wasmBytes().then(function(bytes){ return WebAssembly.instantiate(bytes, {}); })'
);

fs.writeFileSync('_deploy_gz.js', src);
const check=fs.readFileSync('_deploy_gz.js','utf8');
console.log('大小:', check.length);
console.log('残留 wasmModule(仅注释):', (check.match(/wasmModule/g)||[]).length);
console.log('含 wasmBytes:', check.includes('async function wasmBytes'));
console.log('instantiate 行:', (check.match(/wasmPromise = .*/)||[''])[0].slice(0,120));
