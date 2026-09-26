// Cloudflare Worker · 密码库密文同步后端（KV 版）
// 只做一件事：把请求体里的字符串原样存进 KV，或把 KV 里的字符串原样返回。
// 服务端不解析、不解密、不合并任何条目内容。
//
// 路由：
//   OPTIONS /vault   -> CORS 预检
//   GET     /vault   -> 返回已存储的密文信封 JSON（不存在返回 404）
//   PUT     /vault   -> 覆盖写入密文信封 JSON（body > 256KB 返回 413）
//
// 鉴权：Authorization: Bearer <env.SYNC_KEY>，不匹配 401。
// CORS：Access-Control-Allow-Origin 取自 env.ALLOW_ORIGIN。
//
// KV 结构：单个 key = "vault"，value = 前端上传的密文信封字符串。

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
    const path = url.pathname;
    if (path !== "/vault" && path !== "/vault/") {
      return jsonResp({ error: "Not Found" }, 404, corsHeaders);
    }

    const auth = request.headers.get("Authorization") || "";
    const expected = "Bearer " + (env.SYNC_KEY || "");
    if (!env.SYNC_KEY || auth !== expected) {
      return jsonResp({ error: "Unauthorized" }, 401, corsHeaders);
    }

    if (request.method === "GET") {
      const value = await env.VAULT_KV.get("vault");
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
      await env.VAULT_KV.put("vault", text);
      return jsonResp({ ok: true }, 200, corsHeaders);
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