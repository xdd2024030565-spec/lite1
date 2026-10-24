const fs=require('fs');
const code=fs.readFileSync('_deploy_gz.js','utf8');
const meta={main_module:'worker.js',compatibility_date:'2024-11-01',bindings:[
 {type:'plain_text',name:'ALLOW_ORIGIN',text:'*'},
 {type:'plain_text',name:'THINKING',text:'auto'},
 {type:'plain_text',name:'SEARCH',text:'auto'}]};
const boundary='dshbndX9';
const body='--'+boundary+'\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify(meta)+'\r\n'+
 '--'+boundary+'\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n'+code+'\r\n'+
 '--'+boundary+'--\r\n';
const out=[
 'async () => {',
 '  const boundary = '+JSON.stringify(boundary)+';',
 '  const body = '+JSON.stringify(body)+';',
 '  const r = await cloudflare.request({',
 '    method: "PUT",',
 '    path: "/accounts/" + accountId + "/workers/scripts/deepseek-web",',
 '    body, rawBody: true,',
 '    contentType: "multipart/form-data; boundary=" + boundary',
 '  });',
 '  return { success: r.success, status: r.status, errors: r.errors };',
 '}'
].join('\n');
fs.writeFileSync('_mcp5.js', out);
console.log('mcp5 chars:', out.length);
