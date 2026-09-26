// search-api · 站内搜索 + 站内预览 Worker（v1）
// 路由：
//   GET /search?q=关键词[&n=20]   -> 多源搜索聚合（Bing RSS 主源 → 百度 HTML → Bing HTML）
//   GET /browse?url=<绝对URL>     -> iframe 内嵌代理（去 XFO/CSP、注入 <base>、编码兼容、反 frame-busting）
//   GET /read?url=<绝对URL>       -> 阅读模式兜底（服务端抽取正文，返回极简可读 HTML）
//   GET /health                   -> {ok:true}
// 说明：不依赖 KV / 不依赖第三方 npm；ES module。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, ts: Date.now() });
      if (url.pathname === "/search") return await handleSearch(url);
      if (url.pathname === "/browse") return await handleBrowse(url);
      if (url.pathname === "/read") return await handleRead(url);
      return json({ error: "Not found", routes: ["/search?q=", "/browse?url=", "/read?url=", "/health"] }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS)
  });
}

function timedFetch(target, opt, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, ms);
  const o = Object.assign({ redirect: "follow", signal: ctl.signal }, opt || {});
  return fetch(target, o).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
}

function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(new RegExp("&"+"quot;","gi"), String.fromCharCode(34)).replace(new RegExp("&"+"#39;|&"+"apos;","gi"), String.fromCharCode(39))
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/\s+/g, " ").trim();
}

function displayUrl(u) {
  try { const x = new URL(u); return x.hostname + (x.pathname && x.pathname !== "/" ? x.pathname : ""); }
  catch (e) { return u || ""; }
}

// ---------- 解析器 ----------

function parseBingRSS(xml) {
  if (!xml) return null;
  const head = xml.slice(0, 400).toLowerCase();
  if (head.indexOf("<?xml") < 0 && xml.indexOf("<rss") < 0) return null;
  if (head.indexOf("<!doctype html") >= 0 || xml.indexOf("b_results") >= 0) return null;
  const out = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    const g = function (t) {
      const m = b.match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">", "i"));
      return m ? decodeEntities(m[1]) : "";
    };
    const title = g("title"), link = g("link"), desc = g("description");
    if (title && /^https?:\/\//.test(link)) out.push({ title: title, url: link, snippet: desc });
  }
  return out.length ? out : null;
}

function bingDecodeCk(u) {
  try {
    const x = new URL(u);
    const p = x.searchParams.get("u");
    if (!p) return u;
    let b64 = p.indexOf("a1") === 0 ? p.slice(2) : p;
    b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const dec = decodeURIComponent(escape(atob(b64)));
    return /^https?:\/\//.test(dec) ? dec : u;
  } catch (e) { return u; }
}

function parseBingHTML(html) {
  if (!html) return null;
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const m = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    let href = m[1].replace(/&amp;/g, "&");
    if (/bing\.com\/ck\/a/.test(href)) href = bingDecodeCk(href);
    const title = decodeEntities(m[2]);
    const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (title && /^https?:\/\//.test(href)) out.push({ title: title, url: href, snippet: sn ? decodeEntities(sn[1]) : "" });
  }
  return out.length ? out : null;
}

function parseBaidu(html) {
  if (!html) return null;
  if (html.indexOf("class=\"result") < 0 && html.indexOf("class='result") < 0) return null;
  const parts = html.split(/class=["']result/).slice(1);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i].slice(0, 6000);
    const mu = b.match(/mu=["'](https?:\/\/[^"']+)["']/i);
    const h3 = b.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    let snap = "";
    const hs = b.match(/<h3[^>]*>[\s\S]*?<\/h3>/i);
    if (hs) b.slice(hs.index + hs[0].length, hs.index + hs[0].length + 400);
    const sn = b.replace(/[\s\S]*?<\/h3>/, "").match(/^([\s\S]{20,400}?)(<div|<span class="c-color|<\/div>)/i);
    if (sn) snap = decodeEntities(sn[1]);
    if (!mu || !h3) continue;
    const title = decodeEntities(h3[1]);
    if (title && /^https?:\/\//.test(mu[1])) out.push({ title: title, url: mu[1], snippet: snap.slice(0, 300) });
  }
  return out.length ? out : null;
}

// ---------- /search ----------

async function handleSearch(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "missing q" }, 400);
  const limit = Math.min(parseInt(url.searchParams.get("n") || "20", 10) || 20, 30);

  const steps = [
    { name: "bing-rss", run: function () { return timedFetch("https://www.bing.com/search?q=" + encodeURIComponent(q) + "&format=rss&count=20", { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } }, 8000).then(function (r) { return r.text(); }).then(parseBingRSS); } },
    { name: "baidu", run: function () { return timedFetch("https://www.baidu.com/s?wd=" + encodeURIComponent(q) + "&rn=20", { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" } }, 9000).then(function (r) { return r.text(); }).then(parseBaidu); } },
    { name: "bing-html", run: function () { return timedFetch("https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setlang=zh-CN", { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" } }, 9000).then(function (r) { return r.text(); }).then(parseBingHTML); } }
  ];

  const merged = [], seenHost = {}, tried = [];
  for (let i = 0; i < steps.length; i++) {
    if (merged.length >= limit) break;
    const s = steps[i];
    try {
      const items = await s.run();
      const n = items ? items.length : 0;
      tried.push(s.name + ":" + n);
      if (!items) continue;
      for (let k = 0; k < items.length && merged.length < limit; k++) {
        const it = items[k];
        const key = displayUrl(it.url).replace(/\/$/, "");
        if (seenHost[key]) continue;
        seenHost[key] = 1;
        merged.push({ title: it.title, url: it.url, displayUrl: key, snippet: (it.snippet || "").slice(0, 300) });
      }
    } catch (e) {
      tried.push(s.name + ":ERR");
    }
  }
  return json({ q: q, engine: tried[0] || "", tried: tried, count: merged.length, results: merged });
}

// ---------- 通用：取页面 + 解码 ----------

function isBlockedHost(host) {
  if (!host) return true;
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

async function fetchPage(target, ms) {
  const res = await timedFetch(target, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  }, ms || 12000);
  const ct = res.headers.get("Content-Type") || "";
  const buf = await res.arrayBuffer();
  let charset = "utf-8";
  const m1 = ct.match(/charset=([\w-]+)/i);
  if (m1) charset = m1[1].toLowerCase();
  if (charset === "utf-8" || charset === "utf8") {
    const head = new TextDecoder("utf-8").decode(buf.slice(0, 4096));
    const m2 = head.match(/charset=["']?([\w-]+)/i);
    if (m2) charset = m2[1].toLowerCase();
  }
  let html = "";
  try {
    if (/gb2312|gbk|gb18030/.test(charset)) html = new TextDecoder("gb18030").decode(buf);
    else html = new TextDecoder("utf-8").decode(buf);
  } catch (e) {
    html = new TextDecoder("utf-8").decode(buf);
  }
  return { res: res, ct: ct, html: html, bytes: buf.byteLength, charset: charset };
}

// ---------- /browse（iframe 代理） ----------

async function handleBrowse(url) {
  const target = url.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) return json({ error: "missing/invalid url" }, 400);
  let host = "";
  try { host = new URL(target).hostname; } catch (e) { return json({ error: "bad url" }, 400); }
  if (isBlockedHost(host)) return json({ error: "blocked host" }, 403);

  let page;
  try { page = await fetchPage(target, 12000); }
  catch (e) { return json({ error: "fetch failed: " + String((e && e.message) || e), url: target }, 502); }

  if (page.ct && page.ct.indexOf("text/html") < 0) {
    return new Response(page.html, {
      status: 200,
      headers: Object.assign({ "Content-Type": page.ct || "application/octet-stream", "Cache-Control": "public, max-age=600", "X-Preview": "proxy-raw" }, CORS)
    });
  }

  let html = page.html;
  html = html.replace(/<base\s+[^>]*>/gi, "");
  html = html.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, "");
  // 反 frame-busting：中和顶层跳转
  html = html.replace(/top\s*\.\s*location\s*(\.href)?\s*=/gi, "void 0&&(0)=");
  html = html.replace(/(window\s*\.\s*)?top\s*\.\s*document\s*\.\s*location\s*(\.href)?\s*=/gi, "void 0&&(0)=");
  html = html.replace(/parent\s*\.\s*location\s*(\.href)?\s*=/gi, "void 0&&(0)=");
  html = html.replace(/self\s*!==?\s*top/g, "false");
  html = html.replace(/top\s*!==?\s*self/g, "false");
  html = html.replace(/window\s*\.\s*top\s*!==?\s*window\s*\.\s*self/g, "false");

  const ATTRQ=String.fromCharCode(38)+"quot;";
  const baseTag = '<base href="' + target.split(String.fromCharCode(34)).join(ATTRQ) + '">';
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + baseTag; });
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, function (m) { return m + "<head>" + baseTag + "</head>"; });
  else html = baseTag + html;

  return new Response(html, {
    status: 200,
    headers: Object.assign({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Preview": "proxy",
      "X-Preview-Len": String(page.bytes),
      "X-Preview-Charset": page.charset
    }, CORS)
  });
}

// ---------- /read（阅读模式兜底） ----------

async function handleRead(url) {
  const target = url.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) return json({ error: "missing/invalid url" }, 400);
  let host = "";
  try { host = new URL(target).hostname; } catch (e) { return json({ error: "bad url" }, 400); }
  if (isBlockedHost(host)) return json({ error: "blocked host" }, 403);

  let page;
  try { page = await fetchPage(target, 12000); }
  catch (e) { return json({ error: "fetch failed: " + String((e && e.message) || e), url: target }, 502); }

  const html = page.html;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1];
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [, ""])[1];
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [, ""])[1];

  let body = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const area = (body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i) || [body])[0];
  const paras = (area.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []);
  let lines = [];
  for (let i = 0; i < paras.length; i++) {
    const t = decodeEntities(paras[i]);
    if (t && t.length >= 18) lines.push(t);
    if (lines.join("").length > 14000) break;
  }
  if (lines.length < 3) {
    const h = decodeEntities(area.replace(/<(h[1-3]|li)[^>]*>/gi, "\n### "));
    const chunks = h.split(/\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return x.length >= 20; });
    lines = chunks.slice(0, 200);
  }
  const imgs = [];
  const im = (area.match(/<img[^>]+src=["']([^"']+)["']/gi) || []).slice(0, 8);
  for (let i = 0; i < im.length; i++) {
    const m = im[i].match(/src=["']([^"']+)["']/i);
    if (!m) continue;
    let src = m[1];
    try { src = new URL(src, target).href; } catch (e) { continue; }
    if (/^https?:\/\//.test(src)) imgs.push(src);
  }

  const text = lines.join("\n\n");
  const esc = function (s) { return String(s).replace(/&/g, String.fromCharCode(38)+"amp;").replace(/</g, String.fromCharCode(38)+"lt;").replace(/>/g, String.fromCharCode(38)+"gt;").replace(new RegExp(String.fromCharCode(34), "g"), String.fromCharCode(38)+"quot;"); };
  const page2 = '<!doctype html><html lang="zh"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(decodeEntities(title) || target) + '</title>' +
    '<style>body{margin:0;padding:18px;font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#fff;color:#111}' +
    'h1{font-size:22px;line-height:1.4;margin:0 0 6px}.src{font-size:12px;color:#888;word-break:break-all;margin-bottom:16px}' +
    'p{margin:0 0 14px;white-space:pre-wrap}.desc{background:#f6f6f6;border-left:3px solid #0071e3;padding:8px 12px;color:#444;font-size:14px;margin-bottom:16px}' +
    'img{max-width:100%;height:auto;border-radius:8px;margin:6px 0}a{color:#0071e3}' +
    '@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.desc{background:#1c1c1e;color:#aaa}}</style></head><body>' +
    '<h1>' + esc(decodeEntities(h1) || decodeEntities(title) || "(无标题)") + '</h1>' +
    '<div class="src">阅读模式 · ' + esc(target) + ' · <a href="' + esc(target) + '" target="_blank" rel="noreferrer">打开原网页</a></div>' +
    (desc ? '<div class="desc">' + esc(decodeEntities(desc)) + '</div>' : "") +
    text.split("\n\n").map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("") +
    imgs.map(function (s) { return '<img src="' + esc(s) + '" loading="lazy" alt="">'; }).join("") +
    '</body></html>';

  return new Response(page2, { status: 200, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8", "X-Preview": "read" }, CORS) });
}