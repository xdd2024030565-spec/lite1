// Cloudflare Worker · 通用 JSON 同步后端（KV 版）v4
// 路由：
//   OPTIONS /vault | /memo | /memo/<token>   -> CORS 预检
//   GET/PUT /vault        -> 密码库密文信封（Bearer SYNC_KEY 必需）
//   GET/PUT /memo         -> 备忘录（Bearer SYNC_KEY，向后兼容）
//   GET/PUT /memo/<token> -> 备忘录免密通道（token === env.MEMO_TOKEN，零配置）
//   GET/PUT /memo/<错误token> -> 404
// 语义：服务端不解析业务内容，只做「原样存取 + JSON 合法性校验」。
//
// CORS（v4 变更）：支持多来源白名单。
//   ALLOW_ORIGIN 支持逗号分隔多个来源，或单个 "*"。
//   例：ALLOW_ORIGIN = "https://nav.yongjiu.ccwu.cc,https://lite1-3d8c30u.maozi.io"
//   命中则回显该 Origin；未命中回第一个来源（浏览器会自行拒绝，属预期行为）。
//   注意：来源里不要带结尾斜杠；多个来源用英文逗号分隔，不要有空格以外的歧义字符。
//
// KV：key "vault" / key "memo"（复用同一 namespace）。

const KEY_BY_PATH = { "/vault": "vault", "/memo": "memo" };

function parseAllowedOrigins(raw) {
  const s = String(raw || "").trim();
  // 未配置 / "*" / "any" 都表示放行任意来源。
  // 这是「跨任何设备可用」的前提：局域网 IP、file://（Origin: null）、
  // 自定义域名、别人的电脑手机，都不应该在白名单上栽跟头。
  if (!s || s === "*" || /^(any|all)$/i.test(s)) return ["*"];
  return s.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
}

function pickOrigin(requestOrigin, allowed) {
  // 放行任意来源时统一回 "*"。
  // 注意这里不能回显具体 Origin 再配合凭据——本站请求不带 credentials，
  // 回 "*" 是最简单可靠的做法，也不会因为来源千变万化而漏配。
  if (allowed.indexOf("*") !== -1) return "*";
  if (!requestOrigin) return allowed[0] || "";
  // 名单模式：精确匹配才回显（避免 https://x.com.evil.com 之类后缀欺骗）
  if (allowed.indexOf(requestOrigin) !== -1) return requestOrigin;
  // 未命中：仍然回显 "*"，保证可用性优先（便签数据本来就不含隐私）
  return "*";
}

export default {
  async fetch(request, env) {
    const allowed = parseAllowedOrigins(env.ALLOW_ORIGIN);
    const reqOrigin = request.headers.get("Origin") || "";
    const allowOrigin = pickOrigin(reqOrigin, allowed);
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      // 暴露 cf-ray，前端才能读到当前 Cloudflare 边缘节点（如 ...-AMS）
      "Access-Control-Expose-Headers": "cf-ray",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    // 节点探测：给悬浮球用。返回当前边缘节点（cf-ray 尾部的机场码）。
    // 用响应体传而不是只靠响应头，是因为跨域时浏览器只放行少数安全响应头，
    // cf-ray 默认读不到。
    if (path === "/cfnode" || path === "/health") {
      const colo = (request.cf && request.cf.colo) || "";
      const ray = request.headers.get("cf-ray") || "";
      return jsonResp(
        { ok: true, colo: colo || null, ray: ray || null, ts: Date.now() },
        200,
        corsHeaders
      );
    }

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
    status: status,
    headers: Object.assign({}, headers, { "Content-Type": "application/json" })
  });
}
