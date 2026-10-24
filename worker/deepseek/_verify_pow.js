const fs=require('fs');
const keccakSrc = fs.readFileSync('_pure.js','utf8').split('// 自测')[0];
eval(keccakSrc);

const ch = JSON.parse(fs.readFileSync('_challenge.json','utf8')).data.biz_data.challenge;
const prefix = ch.salt + '_' + ch.expire_at + '_';
const enc = new TextEncoder();

// difficulty=144000 -> 需要多少个前导零 hex? 16^5=1048576 ≈ 1.05e6，144000 更接近 16^4.4
// 实测：001 的难度约 1/16，后面继续找
function solve(ch, prefix, maxN){
  for (let n = 0; n < maxN; n++) {
    const h = Buffer.from(keccak256(enc.encode(ch + prefix + n))).toString('hex');
    return { h, n };
  }
}
// 找出满足不同前导零数的最小 nonce
for (const zeros of [3,4,5,6]) {
  const target = '0'.repeat(zeros);
  let found = null;
  for (let n = 0; n < 3000000; n++) {
    const h = Buffer.from(keccak256(enc.encode(ch.challenge + prefix + n))).toString('hex');
    if (h.startsWith(target)) { found = { n, h: h.slice(0, 12) }; break; }
  }
  console.log(zeros+'个前导0:', found ? `nonce=${found.n} hash=${found.h}` : `300万次内未找到`);
}
