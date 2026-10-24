import handler from './_g.mjs';
const env={DEEPSEEK_TOKENS:'cGeBOiwxOGF/9X1/eB0iGLlXdm74AiQPvYhuyQFjNV4AJkQ/bO9c0GWVYEZqxXB2',ALLOW_ORIGIN:'*'};
const r=await handler.fetch({url:'https://w/v1/chat/completions',method:'POST',
  headers:new Headers({}),json:async()=>({model:'deepseek-chat',stream:false,
  messages:[{role:'user',content:'只回答两个字：可用'}]})},env);
const j=await r.json();
console.log('status:',r.status);
console.log('结果:', j.choices? JSON.stringify(j.choices[0].message.content) : JSON.stringify(j).slice(0,300));
