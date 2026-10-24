const fs=require('fs');
const bytes=fs.readFileSync('sha3_wasm_bg.wasm');
(async()=>{
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const e=instance.exports;
  const mk=(s)=>{const b=new TextEncoder().encode(s);const p=e.__wbindgen_export_0(b.length,1);new Uint8Array(e.memory.buffer).set(b,p);return [p,b.length];};
  // 用 wasm_solve 反推：给定已知 challenge，看它能解出什么 nonce，再从 nonce 反推哈希判定规则
  // 先试真实形态：challenge 是较长随机串
  const chal = 'A'.repeat(64);
  const [cp,cl]=mk(chal);
  const [pp,pl]=mk('salt123_1700000000_');
  for(const d of [1,5,10]){
    const st=e.__wbindgen_add_to_stack_pointer(-16);
    try{
      e.wasm_solve(st, cp, cl, pp, pl, d);
      const dv=new DataView(e.memory.buffer);
      console.log('d='+d,'ok=',dv.getInt32(st,true),'nonce=',dv.getFloat64(st+8,true));
    }catch(err){console.log('d='+d,'err:',err.message);}
    e.__wbindgen_add_to_stack_pointer(16);
  }
})();
