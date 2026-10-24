const fs=require('fs');
const raw=fs.readFileSync('_mp.txt','utf8');
const i=raw.indexOf('\n');
const boundary=raw.slice(0,i);
const body=raw.slice(i+1);
const lines=[
 'async () => {',
 '  const boundary = '+JSON.stringify(boundary)+';',
 '  const body = '+JSON.stringify(body)+';',
 '  const r = await cloudflare.request({',
 '    method: "PUT",',
 '    path: "/accounts/" + accountId + "/workers/scripts/deepseek-web",',
 '    body, rawBody: true,',
 '    contentType: "multipart/form-data; boundary=" + boundary',
 '  });',
 '  return { success: r.success, status: r.status, errors: r.errors,',
 '    result: r.result && { id: r.result.id, etag: r.result.etag, modified_on: r.result.modified_on } };',
 '}'
];
fs.writeFileSync('_mcp_upload.js', lines.join('\n'));
console.log('MCP code 长度:', fs.statSync('_mcp_upload.js').size);
