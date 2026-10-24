const fs=require('fs');
const bytes=fs.readFileSync('sha3_wasm_bg.wasm');
(async()=>{
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const e=instance.exports;
  const mk=(s)=>{const b=new TextEncoder().encode(s);const p=e.__wbindgen_export_0(b.length,1);new Uint8Array(e.memory.buffer).set(b,p);return [p,b.length];};
  // 先用 d=4（之前能跑）拿 nonce，逐个试真实的 solve
  const chal='A'.repeat(64);
  const [cp,cl]=mk(chal);
  const [pp,pl]=mk('salt123_1700000000_');
  for(const d of [2,3,4]){
    const st=e.__wbindgen_add_to_stack_pointer(-16);
    try{
      e.wasm_solve(st, cp, cl, pp, pl, d);
      const dv=new DataView(e.memory.buffer);
      const ok=dv.getInt32(st,true), nonce=dv.getFloat64(st+8,true);
      console.log('d='+d,'ok=',ok,'nonce=',nonce);
      e.__wbindgen_add_to_stack_pointer(16);
    }catch(err){console.log('d='+d,'err:',err.message); try{e.__wbindgen_add_to_stack_pointer(16);}catch(_){}}
  }
})();
