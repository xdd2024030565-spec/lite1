// 纯 JS SHA3-256，用来替换 WASM
function keccak256(bytes){
  const RC=[0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,
    0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,
    0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,
    0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
    0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,
    0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n];
  const R=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
  const M=(1n<<64n)-1n;
  const rotl=(x,n)=>n===0?x:((x<<BigInt(n))|(x>>BigInt(64-n)))&M;
  const rate=136; // SHA3-256 rate
  // padding
  const msg=Array.from(bytes);
  msg.push(0x06);
  while(msg.length%rate!==0) msg.push(0);
  msg[msg.length-1]|=0x80;
  const S=new Array(25).fill(0n);
  for(let off=0;off<msg.length;off+=rate){
    for(let i=0;i<rate/8;i++){
      let v=0n;
      for(let j=7;j>=0;j--) v=(v<<8n)|BigInt(msg[off+i*8+j]);
      S[i]^=v;
    }
    // keccak-f
    for(let round=0;round<24;round++){
      const C=new Array(5);
      for(let x=0;x<5;x++) C[x]=S[x]^S[x+5]^S[x+10]^S[x+15]^S[x+20];
      for(let x=0;x<5;x++){
        const D=C[(x+4)%5]^rotl(C[(x+1)%5],1);
        for(let y=0;y<5;y++) S[x+y*5]^=D;
      }
      const B=new Array(25);
      for(let x=0;x<5;x++)for(let y=0;y<5;y++) B[y+((2*x+3*y)%5)*5]=rotl(S[x+y*5],R[x][y]);
      for(let x=0;x<5;x++)for(let y=0;y<5;y++)
        S[x+y*5]=B[x+y*5]^((~B[(x+1)%5+y*5]&M)&B[(x+2)%5+y*5]);
      S[0]^=RC[round];
    }
  }
  const out=new Uint8Array(32);
  for(let i=0;i<4;i++){
    let v=S[i];
    for(let j=0;j<8;j++){ out[i*8+j]=Number(v&0xffn); v>>=8n; }
  }
  return out;
}
// 自测：SHA3-256("abc") = 3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532
const h=keccak256(new TextEncoder().encode('abc'));
console.log('SHA3-256("abc"):', Buffer.from(h).toString('hex'));
console.log('期望            : 3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532');

// ===== 探测 wasm_solve 的正确调用方式（先确认 challenge 需要什么条件）=====
(async()=>{
  const fs=require('fs');
  const bytes=fs.readFileSync('sha3_wasm_bg.wasm');
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const e=instance.exports;
  const str=(s)=>{
    const b=new TextEncoder().encode(s);
    const p=e.__wbindgen_export_0(b.length,1);
    new Uint8Array(e.memory.buffer).set(b,p);
    return [p,b.length];
  };
  // 用极简单字符 challenge + 极低 difficulty 试
  for(const diff of [1,2,3,4]){
    const [cp,cl]=str('a');
    const [pp,pl]=str('s_1_');
    const stack=e.__wbindgen_add_to_stack_pointer(-16);
    e.wasm_solve(stack, cp, cl, pp, pl, diff);
    const dv=new DataView(e.memory.buffer);
    console.log('diff='+diff, 'ok=', dv.getInt32(stack,true), 'nonce=', dv.getFloat64(stack+8,true));
    e.__wbindgen_add_to_stack_pointer(16);
  }
})();
