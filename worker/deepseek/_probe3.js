const fs=require('fs');
const bytes=fs.readFileSync('sha3_wasm_bg.wasm');
(async()=>{
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const e=instance.exports;
  const str=(s)=>{
    const b=new TextEncoder().encode(s);
    const p=e.__wbindgen_export_0(b.length,1);
    new Uint8Array(e.memory.buffer).set(b,p);
    return [p,b.length];
  };
  // wasm_solve 可能返回 f64 而非写 stack。它的签名可能是 (chalPtr,chalLen,prePtr,preLen,diff) -> f64
  try{
    const [cp,cl]=str('a'); const [pp,pl]=str('s_1_');
    const r=e.wasm_solve(cp, cl, pp, pl, 1);
    console.log('返回值:', r, typeof r);
  }catch(err){console.log('失败A:', err.message);}
  // 或者 (stack,...) 且返回值也是 f64
  try{
    const [cp2,cl2]=str('a'); const [pp2,pl2]=str('s_1_');
    const st=e.__wbindgen_add_to_stack_pointer(-16);
    const r=e.wasm_solve(st, cp2, cl2, pp2, pl2, 1);
    console.log('带stack返回值:', r, typeof r);
    const dv=new DataView(e.memory.buffer);
    console.log('  stack int32:', dv.getInt32(st,true), 'f64:', dv.getFloat64(st+8,true));
    e.__wbindgen_add_to_stack_pointer(16);
  }catch(err){console.log('失败B:', err.message);}
})();
