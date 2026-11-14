/*
 * 通用 HTTP 小工具：CORS 头与 JSON 响应。
 */

export function corsHeaders(env, request) {
  // 关键：Access-Control-Allow-Origin 只能是「*」或恰好一个来源。
  // 把逗号分隔的一整串回给浏览器是非法值，前端所有请求都会被 CORS 拦掉。
  const raw = String((env && env.ALLOW_ORIGIN) || '*').trim();
  let allow = '*';
  if (raw !== '*') {
    const list = raw.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    const origin = (request && request.headers && request.headers.get('Origin')) || '';
    allow = (origin && list.indexOf(origin) >= 0) ? origin : (list[0] || '*');
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-DS-PoW-Response',
    'Access-Control-Max-Age': '86400',
    // 允许来源随请求头变化，必须声明 Vary，避免 CDN 缓存串站
    Vary: 'Origin',
  };
}

export function jsonResp(obj, status, env, request) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      corsHeaders(env, request)
    ),
  });
}
