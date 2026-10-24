// 探测 WASM 的哈希：wasm_deepseek_hash_v1 接收什么、返回什么
const fs=require('fs');
const bytes=fs.readFileSync('sha3_wasm_bg.wasm');
(async()=>{
  const {instance}=await WebAssembly.instantiate(bytes,{});
  const e=instance.exports;
  console.log('exports:', Object.keys(e));
  // 试 wasm_deepseek_hash_v1(stack?, ptr, len)
  const mem=new Uint8Array(e.memory.buffer);
  const test=new TextEncoder().encode('abc');
  const ptr=e.__wbindgen_export_0(test.length,1);
  new Uint8Array(e.memory.buffer).set(test,ptr);
  const stack=e.__wbindgen_add_to_stack_pointer(-64);
  // 试签名 1: hash(stack, ptr, len)
  try{
    e.wasm_deepseek_hash_v1(stack, ptr, test.length);
    const dv=new DataView(e.memory.buffer);
    const bytesOut=[];
    for(let i=0;i<32;i++) bytesOut.push(dv.getUint8(stack+i));
    console.log('hash("abc") 前16字节:', Buffer.from(bytesOut.slice(0,16)).toString('hex'));
  }catch(err){ console.log('调用1失败:', err.message); }
  e.__wbindgen_add_to_stack_pointer(64);
})();
