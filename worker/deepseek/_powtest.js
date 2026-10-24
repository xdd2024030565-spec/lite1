const fs=require('fs');
// 引入纯 JS SHA3
const keccakSrc = fs.readFileSync('_pure.js','utf8').split('// 自测')[0];
eval(keccakSrc);

const ch = JSON.parse(fs.readFileSync('_challenge.json','utf8')).data.biz_data.challenge;
console.log('challenge:', ch.challenge.slice(0,20)+'...');
console.log('salt:', ch.salt, 'difficulty:', ch.difficulty, 'expire_at:', ch.expire_at);

const prefix = ch.salt + '_' + ch.expire_at + '_';
const enc = new TextEncoder();

// 试几种拼接方式，看哪种能让 hash 前 N 位满足 difficulty/1000 个前导零 hex
// difficulty=144000 -> 通常表示 144000 次尝试，或 14.4 个前导零 bit
function hexHash(bytes){
  return Buffer.from(keccak256(bytes)).toString('hex');
}

const variants = {
  'challenge+prefix+nonce': (n) => ch.challenge + prefix + n,
  'prefix+challenge+nonce': (n) => prefix + ch.challenge + n,
  'challenge+nonce': (n) => ch.challenge + n,
  'prefix+nonce': (n) => prefix + n,
};

for (const [name, fn] of Object.entries(variants)) {
  let found = null;
  for (let n = 0; n < 20000; n++) {
    const h = hexHash(enc.encode(fn(n)));
    // 判定：前若干个 hex 字符为 '0'
    if (h.startsWith('0000')) { found = { n, h: h.slice(0,16) }; break; }
  }
  console.log(name, '=>', found ? `nonce=${found.n} hash=${found.h}` : '未找到(4个前导0)');
}
