const fs=require('fs');
const bytes=fs.readFileSync('sha3_wasm_bg.wasm');
(async()=>{
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const e=instance.exports;
  // 判断 wasm_deepseek_hash_v1 是否返回 i32（长度）并写 retptr
  // 试：stack 为 retptr，参数为 (retptr, ptr, len)
  const b=new TextEncoder().encode('abc');
  for (const argOrder of ['retptr,ptr,len', 'ptr,len']) {
    try {
      const st = e.__wbindgen_add_to_stack_pointer(-32);
      let r;
      if (argOrder === 'retptr,ptr,len') {
        const p = e.__wbindgen_export_0(b.length,1);
        new Uint8Array(e.memory.buffer).set(b, p);
        r = e.wasm_deepseek_hash_v1(st, p, b.length);
      }
      const dv = new DataView(e.memory.buffer);
      const hex = [];
      for (let i=0;i<32;i++) hex.push(dv.getUint8(st+i).toString(16).padStart(2,'0'));
      console.log(argOrder, 'returnType=', typeof r, 'ret=', r, 'retptr hex=', hex.join(''));
      e.__wbindgen_add_to_stack_pointer(32);
    } catch(err) { console.log(argOrder, 'err:', err.message); }
  }
})();
