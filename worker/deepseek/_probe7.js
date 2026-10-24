const fs=require('fs');
const bytes=fs.readFileSync('sha3_wasm_bg.wasm');
(async()=>{
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const e=instance.exports;
  // 关键：wasm_deepseek_hash_v1 可能接收 (retptr, chalPtr, chalLen, prePtr, preLen) 5 参数
  const mk=(s)=>{const b=new TextEncoder().encode(s);const p=e.__wbindgen_export_0(b.length,1);new Uint8Array(e.memory.buffer).set(b,p);return [p,b.length];};
  const [cp,cl]=mk('abc');
  const [pp,pl]=mk('xyz_');
  const st=e.__wbindgen_add_to_stack_pointer(-64);
  try{
    e.wasm_deepseek_hash_v1(st, cp, cl, pp, pl);
    const dv=new DataView(e.memory.buffer);
    const hex=[]; for(let i=0;i<32;i++) hex.push(dv.getUint8(st+i).toString(16).padStart(2,'0'));
    console.log('5参数 retptr hex:', hex.join(''));
  }catch(err){console.log('5参数 err:', err.message);}
  e.__wbindgen_add_to_stack_pointer(64);
})();
