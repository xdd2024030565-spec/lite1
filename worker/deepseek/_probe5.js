const fs=require('fs');
// 直接看 wasm 二进制里的字符串，推断 hash 输入格式
const buf=fs.readFileSync('sha3_wasm_bg.wasm');
const s=buf.toString('latin1');
const strs=[];
let cur='';
for(let i=0;i<s.length;i++){
  const c=s.charCodeAt(i);
  if(c>=32&&c<127) cur+=s[i];
  else { if(cur.length>=4) strs.push(cur); cur=''; }
}
if(cur.length>=4) strs.push(cur);
console.log('可读字符串（去重，长度≥4）:');
[...new Set(strs)].slice(0,60).forEach(x=>console.log(' ', JSON.stringify(x)));
