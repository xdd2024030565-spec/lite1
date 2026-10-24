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
  // 真正正式测试：抓一个真实 challenge 看 difficulty 和字段
  // 先看 wasm_solve 对 difficulty=0 的反应
  for (const d of [0, 8, 16, 20]) {
    try{
      const [cp,cl]=str('a'); const [pp,pl]=str('s_1_');
      const st=e.__wbindgen_add_to_stack_pointer(-16);
      e.wasm_solve(st, cp, cl, pp, pl, d);
      const dv=new DataView(e.memory.buffer);
      console.log('d='+d, 'ok=', dv.getInt32(st,true), 'f64=', dv.getFloat64(st+8,true));
      e.__wbindgen_add_to_stack_pointer(16);
    }catch(err){console.log('d='+d,'err:',err.message);}
  }
})();
