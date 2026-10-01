// search-api · 站内搜索 + 站内预览 Worker（v3）
// 路由：
//   GET /search?q=关键词[&n=20][&page=1]   -> 多源搜索聚合（支持翻页）
//        · 中文查询：手机百度(可翻页) → DuckDuckGo（Bing 对中文结果质量差，中文时跳过）
//        · 非中文查询：Bing RSS → Bing HTML → DuckDuckGo → 手机百度
//        · page 翻页：每源每页前进 10 条（STEP=10），各源带自己的偏移参数
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
    const p = url.pathname;
    // 兼容 /search-api/*、/v3/* 之类的路径前缀（与原版一致的“后缀匹配”）
    const hit = function (s) { return p === s || p.slice(-1 - s.length) === s; };
    try {
      if (hit("/health")) return json({ ok: true, ts: Date.now() });
      if (hit("/search")) return await handleSearch(url);
      if (hit("/browse")) return await handleBrowse(url);
      if (hit("/read")) return await handleRead(url);
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

function hasCJK(q) {
  for (let i = 0; i < q.length; i++) {
    const c = q.charCodeAt(i);
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) return true;
  }
  return false;
}

// 取某标签后第一段可见文字（自动跳过嵌套的开始标签）
function textAfterTag(s, j) {
  let g = s.indexOf(">", j);
  if (g < 0) return "";
  let p = g + 1;
  while (p < s.length && s.charCodeAt(p) === 60) {
    const gt = s.indexOf(">", p);
    if (gt < 0) break;
    p = gt + 1;
  }
  let e = p;
  while (e < s.length && s.charCodeAt(e) !== 60) e++;
  const t = decodeEntities(s.slice(p, e));
  return t ? t.slice(0, 160) : "";
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

// DuckDuckGo html 版（可能返回 202 反爬页，解析为空即可）
function parseDDG(html) {
  if (!html || html.indexOf("result__a") < 0) return null;
  const QT = String.fromCharCode(34);
  const out = [];
  const segs = html.split("result__a");
  for (let i = 1; i < segs.length && out.length < 40; i++) {
    const s = segs[i].slice(0, 4000);
    const g = s.indexOf(">");
    if (g < 0) continue;
    const e = s.indexOf("</a>", g);
    if (e < 0) continue;
    const title = decodeEntities(s.slice(g + 1, e));
    let url = "";
    const hk = s.indexOf("href=");
    if (hk >= 0) {
      const q1 = s.indexOf(QT, hk);
      const q2 = s.indexOf(QT, q1 + 1);
      if (q1 >= 0 && q2 >= 0) url = s.slice(q1 + 1, q2);
    }
    if (url.indexOf("uddg=") >= 0) {
      const k = url.indexOf("uddg=");
      let v = url.slice(k + 5);
      const amp = v.indexOf("&");
      if (amp >= 0) v = v.slice(0, amp);
      try { v = decodeURIComponent(v); } catch (err) { }
      url = v;
    }
    if (url.indexOf("//") === 0) url = "https:" + url;
    if (url.indexOf("y.js") >= 0 || url.indexOf("ad_provider") >= 0) continue;
    if (!title || !/^https?:\/\//.test(url)) continue;
    out.push({ title: title, url: url, snippet: "" });
  }
  return out.length ? out : null;
}

// 手机百度：结果块的 data-log 里带 mu=真实URL；标题取 c-title / cos-line-clamp 后的文字
function parseMbaidu(html) {
  if (!html) return null;
  const out = [];
  const segs = html.split("data-log");
  for (let i = 1; i < segs.length && out.length < 40; i++) {
    const s = segs[i].slice(0, 9000);
    let url = "";
    let p = 0;
    while (true) {
      const k = s.indexOf("mu", p);
      if (k < 0) break;
      p = k + 1;
      const hh = s.indexOf("http", k);
      if (hh < 0 || hh - k > 90) continue;
      let e = hh;
      while (e < s.length) {
        const c = s.charCodeAt(e);
        if (c === 38 || c === 34 || c === 39 || c === 60 || c === 92 || c === 62 || c === 32) break;
        e++;
      }
      const v = s.slice(hh, e);
      if (v.length > 10) { url = v; break; }
    }
    if (!url || !/^https?:\/\//.test(url)) continue;
    if (/^https?:\/\/(m|www)\.baidu\.com\//i.test(url)) continue;
    if (/bdstatic|bdimg|\.bdstatic\./i.test(url)) continue;
    let title = "";
    let j = s.indexOf("c-title");
    if (j >= 0) title = textAfterTag(s, j);
    if (!title) { const j2 = s.indexOf("cos-line-clamp"); if (j2 >= 0) title = textAfterTag(s, j2); }
    if (!title) { const j3 = s.indexOf("c-line-clamp"); if (j3 >= 0) title = textAfterTag(s, j3); }
    if (!title) continue;
    out.push({ title: title, url: url, snippet: "" });
  }
  return out.length ? out : null;
}

// ---------- /search ----------

async function handleSearch(url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return json({ error: "missing q" }, 400);
  const limit = Math.min(parseInt(url.searchParams.get("n") || "20", 10) || 20, 30);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const STEP = 10;                       // 每个源每页前进 10 条（与各源自身分页粒度对齐）
  const skip = (page - 1) * STEP;
  const cjk = hasCJK(q);
  const Q2 = encodeURIComponent(q);

  const mk = function (name, target, ms, parser) {
    return {
      name: name,
      run: function () {
        return timedFetch(target, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" } }, ms)
          .then(function (r) { return r.text(); })
          .then(parser);
      }
    };
  };

  const steps = [];
  if (cjk) {
    // 中文：Bing 从数据中心 IP 拿到的中文结果经常是无关/垃圾内容，直接不用
    steps.push(mk("baidu-m", "https://m.baidu.com/s?word=" + Q2 + "&pn=" + skip, 6500, parseMbaidu));
    steps.push(mk("duckduckgo", "https://html.duckduckgo.com/html/?q=" + Q2 + (skip > 0 ? "&s=" + skip : ""), 6000, parseDDG));
  } else {
    if (page === 1) steps.push(mk("bing-rss", "https://www.bing.com/search?q=" + Q2 + "&format=rss&count=20", 8000, parseBingRSS));
    steps.push(mk("bing-html", "https://www.bing.com/search?q=" + Q2 + "&setlang=zh-CN" + (skip > 0 ? "&first=" + (skip + 1) : ""), 9000, parseBingHTML));
    steps.push(mk("duckduckgo", "https://html.duckduckgo.com/html/?q=" + Q2 + (skip > 0 ? "&s=" + skip : ""), 6000, parseDDG));
    steps.push(mk("baidu-m", "https://m.baidu.com/s?word=" + Q2 + "&pn=" + skip, 6500, parseMbaidu));
  }

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
  return json({ q: q, engine: tried[0] || "", tried: tried, count: merged.length, page: page, results: merged });
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

  const ATTRQ = String.fromCharCode(38) + "quot;";
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
  const esc = function (s) { return String(s).replace(/&/g, String.fromCharCode(38) + "amp;").replace(/</g, String.fromCharCode(38) + "lt;").replace(/>/g, String.fromCharCode(38) + "gt;").replace(new RegExp(String.fromCharCode(34), "g"), String.fromCharCode(38) + "quot;"); };
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
