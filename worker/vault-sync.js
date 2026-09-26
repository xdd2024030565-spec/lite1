// Cloudflare Worker · 通用 JSON 同步后端（KV 版）v3
// 路由：
//   OPTIONS /vault | /memo | /memo/<token>   -> CORS 预检
//   GET/PUT /vault        -> 密码库密文信封（Bearer SYNC_KEY 必需）
//   GET/PUT /memo         -> 备忘录（Bearer SYNC_KEY，向后兼容）
//   GET/PUT /memo/<token> -> 备忘录免密通道（token === env.MEMO_TOKEN，零配置）
//   GET/PUT /memo/<错误token> -> 404
// 语义：服务端不解析业务内容，只做「原样存取 + JSON 合法性校验」。
// CORS：Access-Control-Allow-Origin 取自 env.ALLOW_ORIGIN。
// KV：key "vault" / key "memo"（复用同一 namespace）。
// 说明：/memo/<token> 为「不可猜路径」的简化通道，适合日常内容；敏感数据请用密码库。

const KEY_BY_PATH = { "/vault": "vault", "/memo": "memo" };

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOW_ORIGIN || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    let kvKey = null;
    let needAuth = true;
    if (KEY_BY_PATH[path]) {
      kvKey = KEY_BY_PATH[path];
      needAuth = true;
    } else if (path.indexOf("/memo/") === 0) {
      const t = path.slice(6);
      if (t && env.MEMO_TOKEN && t === env.MEMO_TOKEN) {
        kvKey = "memo";
        needAuth = false;
      }
    }
    if (!kvKey) {
      return jsonResp({ error: "Not Found" }, 404, corsHeaders);
    }

    if (needAuth) {
      const auth = request.headers.get("Authorization") || "";
      const expected = "Bearer " + (env.SYNC_KEY || "");
      if (!env.SYNC_KEY || auth !== expected) {
        return jsonResp({ error: "Unauthorized" }, 401, corsHeaders);
      }
    }

    if (request.method === "GET") {
      const value = await env.VAULT_KV.get(kvKey);
      if (value === null) {
        return jsonResp({ error: "Not Found" }, 404, corsHeaders);
      }
      return new Response(value, {
        status: 200,
        headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" })
      });
    }

    if (request.method === "PUT") {
      const cl = request.headers.get("Content-Length");
      if (cl && parseInt(cl, 10) > 256 * 1024) {
        return jsonResp({ error: "Payload Too Large" }, 413, corsHeaders);
      }
      const text = await request.text();
      if (text.length > 256 * 1024) {
        return jsonResp({ error: "Payload Too Large" }, 413, corsHeaders);
      }
      try { JSON.parse(text); } catch (e) {
        return jsonResp({ error: "Invalid JSON" }, 400, corsHeaders);
      }
      await env.VAULT_KV.put(kvKey, text);
      return jsonResp({ ok: true, key: kvKey }, 200, corsHeaders);
    }

    return jsonResp({ error: "Method Not Allowed" }, 405, corsHeaders);
  }
};

function jsonResp(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({}, headers, { "Content-Type": "application/json" })
  });
}