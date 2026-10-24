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
  // wasm_solve(stack, chalPtr, chalLen, prefixPtr, prefixLen, difficulty) -> 写 stack
  const [cp,cl]=str('challenge'); const [pp,pl]=str('salt_123_');
  const stack=e.__wbindgen_add_to_stack_pointer(-16);
  e.wasm_solve(stack, cp, cl, pp, pl, 100);
  const dv=new DataView(e.memory.buffer);
  console.log('solve 返回 ok:', dv.getInt32(stack,true), 'nonce:', dv.getFloat64(stack+8,true));
  e.__wbindgen_add_to_stack_pointer(16);

  // 试探 hash 的正确签名：可能是 (retptr, strptr, strlen)
  const [hp,hl]=str('abc');
  const st2=e.__wbindgen_add_to_stack_pointer(-16);
  try{
    e.wasm_deepseek_hash_v1(st2, hp, hl);
    const dv2=new DataView(e.memory.buffer);
    const out=[];
    for(let i=0;i<32;i++) out.push(dv2.getUint8(st2+i));
    console.log('hash(abc) hex:', Buffer.from(out).toString('hex'));
  }catch(err){console.log('签名2失败:',err.message);}
  e.__wbindgen_add_to_stack_pointer(16);
})();
