// ====== DeepSeek 网页版反向代理（Cloudflare Worker） ======
// 把 chat.deepseek.com 的私有接口反代为 OpenAI 兼容接口，供前端 ai.html 直接调用。
//
// 核心能力：
//   1. PoW 自动求解（DeepSeekHashV1，内嵌 sha3_wasm_bg.wasm，与官方前端同源算法）
//   2. OpenAI 兼容：POST /v1/chat/completions、GET /v1/models
//   3. SSE 流式转发：把 DeepSeek 的 event/data 流实时转成 OpenAI chunk 流
//   4. 会话管理：一次对话复用同一个 chat_session，多轮上下文靠 prompt 拼接
//   5. 多账号池：DEEPSEEK_TOKENS 支持逗号分隔多个 token，轮询 + 失败自动切换
//
// 鉴权：本 Worker 自身可用 PROXY_KEY 保护（客户端 Authorization 填 PROXY_KEY，
//       Wrangler secret 必须改名存放，避免把 DeepSeek token 直接暴露给前端）。
//
// 部署：
//   wrangler secret put DEEPSEEK_TOKENS     # 粘贴 token（多个用英文逗号分隔）
//   wrangler secret put PROXY_KEY           # 可选，本代理的访问口令
//   wrangler deploy


const DEEPSEEK_BASE = 'https://chat.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

// 浏览器指纹头：与官方前端保持一致，降低风控概率
const BROWSER_HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Origin': DEEPSEEK_BASE,
  'Referer': DEEPSEEK_BASE + '/',
  'x-client-version': '2.3.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '28800',
  'x-client-bundle-id': 'com.deepseek.chat',
};

// ===== PoW 求解器（WASM 实例按 isolate 复用）=====
// WASM 不再内嵌：运行时从静态资源拉 base64 再解码。
// 这么做是因为通过 Cloudflare API 上传含二进制的 multipart 很容易失败，
// 而 Worker 自身的 fetch 可以正常访问 GitHub Pages（已实测 200/35484 字节）。
const WASM_URL =
  'https://xdd2024030565-spec.github.io/lite1/assets/sha3_wasm_b64.txt';

let wasmPromise = null;
function getWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const r = await fetch(WASM_URL, { cf: { cacheTtl: 86400 } });
      if (!r.ok) throw new Error('拉取 WASM 失败: HTTP ' + r.status);
      const b64 = (await r.text()).trim();
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const inst = await WebAssembly.instantiate(bytes, {});
      return (inst.instance || inst).exports;
    })().catch((e) => {
      wasmPromise = null; // 允许下次重试
      throw e;
    });
  }
  return wasmPromise;
}

function encodeInto(exports, str) {
  const bytes = new TextEncoder().encode(str);
  const ptr = exports.__wbindgen_export_0(bytes.length, 1);
  new Uint8Array(exports.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

// 解 PoW：输入 challenge 对象，返回可直接放进 X-DS-PoW-Response 的 base64 串
async function solvePow(challenge) {
  const e = await getWasm();
  const stack = e.__wbindgen_add_to_stack_pointer(-16);
  const [chalPtr, chalLen] = encodeInto(e, challenge.challenge);
  const [prePtr, preLen] = encodeInto(
    e,
    challenge.salt + '_' + challenge.expire_at + '_'
  );
  try {
    e.wasm_solve(stack, chalPtr, chalLen, prePtr, preLen, challenge.difficulty);
    const view = new DataView(e.memory.buffer);
    const ok = view.getInt32(stack, true);
    if (!ok) throw new Error('PoW 求解失败（WASM 未找到解）');
    const nonce = view.getFloat64(stack + 8, true);
    const payload = JSON.stringify({
      algorithm: 'DeepSeekHashV1',
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: Math.floor(nonce),
      signature: challenge.signature,
      target_path: challenge.target_path,
    });
    return btoa(payload);
  } finally {
    e.__wbindgen_add_to_stack_pointer(16);
  }
}

// ===== 上游调用 =====
function authHeaders(token, extra) {
  return {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    ...(extra || {}),
  };
}

async function getPowHeader(token, targetPath = '/api/v0/chat/completion') {
  const r = await fetch(DEEPSEEK_BASE + '/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ target_path: targetPath }),
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error('challenge 响应非 JSON: HTTP ' + r.status + ' ' + text.slice(0, 200));
  }
  if (j.code !== 0) {
    throw new Error('challenge 失败: ' + JSON.stringify(j).slice(0, 300));
  }
  return solvePow(j.data.biz_data.challenge);
}

async function createSession(token) {
  const pow = await getPowHeader(token);
  const r = await fetch(DEEPSEEK_BASE + '/api/v0/chat_session/create', {
    method: 'POST',
    headers: authHeaders(token, { 'X-DS-PoW-Response': pow }),
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('建会话失败: ' + JSON.stringify(j).slice(0, 300));
  const biz = j.data.biz_data;
  return biz.id || (biz.chat_session && biz.chat_session.id);
}

// ===== 账号池 =====
function loadTokens(env) {
  const raw = (env && env.DEEPSEEK_TOKENS) || '';
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 会话池：key = token + 用途，value = { id, lastUsed, lastResponseId }
// 用途（scope）很关键：增量模式靠 lastResponseId 串上下文，若 lite 与 lite1、
// 或多个标签页共用一个 key，它们的对话会互相污染（A 的追问会接到 B 的上一轮）。
const sessionPool = new Map(); // key -> { id, lastUsed, lastResponseId }

function poolKey(token, scope) {
  return String(token) + '|' + (scope ? String(scope).slice(0, 64) : '');
}

async function acquireSession(token, opts) {
  const now = Date.now();
  // persistent=true：需要稳定会话（单次对话，或增量模式要 parent 有处可放）
  // 锚点必须放在上游（Workers 模块级变量跨实例会丢）：
  //   ① 前端传来的固定 session id（pin） ② 会话列表里带本 scope 标记的那条
  //   都没有就新建一条并打标记，之后一直用它，不会每轮增生。
  const persistent = !!(opts && opts.persistent);
  const key = poolKey(token, opts && opts.scope);
  let s = sessionPool.get(key);
  const ctx = opts && opts.ctx;

  // 前端指定了固定会话（用户在「新建对话」里选了某个上游会话）：
  // 这是**绑定**语义，必须无条件生效——不能因为用户没开“单次对话”就失效，
  // 否则新消息会落到别的会话里，用户选的那个对话根本没被写入。
  const pin = String((opts && opts.pin) || '').trim();
  if (pin) return { id: pin, lastUsed: now, needMark: false };

  if (persistent) {
    const c = persistCache.get(key);
    if (c && now - c.at < 10 * 60 * 1000 && s && s.id === c.sid) {
      s.lastUsed = now;
      return s;
    }
    // 一次列表查询同时完成「找标记」和「取最新」两件事，避免多花一次 PoW
    const marker = buildSessionMarker(opts && opts.scope);
    const list = ctx ? await ctx.listSessions() : [];
    let found = null;
    for (const it of list) {
      if (it && typeof it.title === 'string' && it.title.indexOf(marker) >= 0) { found = it.id; break; }
    }
    if (found) {
      s = { id: found, lastUsed: now };
      sessionPool.set(key, s); persistCache.set(key, { sid: found, at: now });
      return s;
    }
    // 还没有带标记的会话：直接复用最新那条（保证不额外增生）。
    // ⚠️ 此时**不能**打标记：上游对空会话自增标题返回 biz_code=5
    //    "empty chat session"，且空会话根本不在 fetch_page 列表里，
    //    打完标记也查不到，于是每轮都会再新建一条（实测造出 15 条带标记的僵尸会话）。
    //    正确做法是等这轮对话落库后再贴标记（见 markSessionIfNeeded）。
    const base = list.length ? list[0].id : (ctx ? await ctx.createSession() : await createSession(token));
    s = { id: base, lastUsed: now, needMark: true };
    sessionPool.set(key, s); persistCache.set(key, { sid: base, at: now });
    return s;
  }

  const stale = s && now - s.lastUsed > 30 * 60 * 1000;
  if (!s || stale) {
    s = { id: ctx ? await ctx.createSession() : await createSession(token), lastUsed: now };
    sessionPool.set(key, s);
  }
  s.lastUsed = now;
  return s;
}

const persistCache = new Map(); // key -> { sid, at } 仅作短期加速

// ===== 单次会话内的上游上下文（一次请求只付一次 PoW）=====
// ⚠️ 性能红线：solvePow 跑 WASM，是 CPU 大头。早期版本一次请求里为了
// 「查列表 / 查标记 / 查历史 / 发对话」各算一遍 PoW，累计 4 次，直接把
// Workers 的 CPU 预算打爆 —— 线上表现为 Cloudflare error 1102，且**多次调用后
// 才出现**（前一两次侥幸过关）。因此这里必须收敛：一个请求内只算 1~2 次 PoW。
function makeUpstreamCtx(token) {
  let powCache = null;   // 复用：同一次请求里 fetch_page / update_title 共用
  return {
    get powCacheValue() { return powCache; },
    async pow(targetPath) {
      if (powCache) return powCache;
      powCache = await getPowHeader(token, targetPath || '/api/v0/chat/completion');
      return powCache;
    },
    async listSessions() {
      const pow = await this.pow();
      const r = await fetch(DEEPSEEK_BASE + '/api/v0/chat_session/fetch_page', {
        method: 'GET', headers: authHeaders(token, { 'X-DS-PoW-Response': pow }),
      });
      const j = await r.json();
      return (j && j.data && j.data.biz_data && j.data.biz_data.chat_sessions) || [];
    },
    async setTitle(sessionId, title) {
      try {
        const pow = await this.pow();
        const r = await fetch(DEEPSEEK_BASE + '/api/v0/chat_session/update_title', {
          method: 'POST',
          headers: authHeaders(token, { 'X-DS-PoW-Response': pow }),
          body: JSON.stringify({ chat_session_id: sessionId, title }),
        });
        return r.ok;
      } catch (e) { return false; }
    },
    async createSession() {
      const pow = await this.pow();
      const r = await fetch(DEEPSEEK_BASE + '/api/v0/chat_session/create', {
        method: 'POST',
        headers: authHeaders(token, { 'X-DS-PoW-Response': pow }),
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      });
      const j = await r.json();
      if (j.code !== 0) throw new Error('建会话失败: ' + JSON.stringify(j).slice(0, 200));
      const biz = j.data.biz_data;
      return biz.id || (biz.chat_session && biz.chat_session.id);
    },
    async historyMessages(sessionId) {
      if (!sessionId) return [];
      try {
        const pow = await this.pow();
        const r = await fetch(
          DEEPSEEK_BASE + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId),
          { method: 'GET', headers: authHeaders(token, { 'X-DS-PoW-Response': pow }) }
        );
        const j = await r.json();
        return (j && j.data && j.data.biz_data && j.data.biz_data.chat_messages) || [];
      } catch (e) { return []; }
    },
    async lastAssistantId(sessionId) {
      if (!sessionId) return null;
      try {
        const pow = await this.pow();
        const r = await fetch(
          DEEPSEEK_BASE + '/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId),
          { method: 'GET', headers: authHeaders(token, { 'X-DS-PoW-Response': pow }) }
        );
        const j = await r.json();
        const msgs = (j && j.data && j.data.biz_data && j.data.biz_data.chat_messages) || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.role === 'ASSISTANT' && m.message_id != null) return m.message_id;
        }
        return null;
      } catch (e) { return null; }
    },
  };
}

// 会话标记：把 scope 摘要成短串，写进上游会话标题，用于认领「本设备的固定会话」
function buildSessionMarker(scope) {
  const sc = String(scope || 'default');
  let h = 0;
  for (let i = 0; i < sc.length; i++) h = (h * 31 + sc.charCodeAt(i)) & 0xffff;
  return '[DSH#' + h.toString(16) + ']';
}

// ===== 消息拼接：DeepSeek 网页版只接受单个 prompt 字符串 =====
function buildPrompt(messages, systemPrompt) {
  const sys = systemPrompt || '';
  const parts = [];
  if (sys) parts.push('[system]\n' + sys);
  for (const m of messages || []) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (!c) continue;
    if (m.role === 'system') {
      parts.push('[system]\n' + c);
    } else if (m.role === 'user') {
      parts.push(c);
    } else if (m.role === 'assistant') {
      // 用标记区分历史回答，避免被当成新的用户输入
      parts.push('[assistant 之前的回答]\n' + c);
    }
  }
  // 多轮时把历史压成一段，末尾是当前问题
  return parts.join('\n\n');
}

// ===== 增量模式：裁掉历史，只留本轮 =====
// 上游会话本身记着前文，因此不必每轮重发全部历史，只要本轮 user 消息即可。
function buildIncrementalMessages(messages, hasParent) {
  const list = Array.isArray(messages) ? messages : [];
  if (!hasParent) return list; // 首轮：上游没有任何上下文，必须给全量
  const tail = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') break;
    tail.unshift(m);
  }
  if (tail.length) return tail;
  return list.length ? list.slice(-1) : list;
}

// ===== 上游 SSE 解析 =====
// 上游事件流（已用真实抓包核对，/tmp/raw_think.txt）：
//
//   形态1 快照  {"v":{"response":{"fragments":[{id:2,type:"THINK",content:"我们需要"}]}}}
//   形态2a 数组 {"p":"response/fragments","v":[{id:2,type:"THINK",content:"我们需要回答中文..."},
//                                              {id:3,type:"RESPONSE",content:"量子"},
//                                              {id:4,type:"TIP",content:"This response is AI-generated"}]}
//   形态2b 追加 {"p":"response/fragments/-1/content","v":"回答"}
//   形态3 碎片  {"v":"中文"}
//
// 两个致命细节（都踩过坑）：
//   ① 数组补丁里的 content 是**该片段的累积全文**，不是增量，且一次会带回多个片段
//      （THINK + RESPONSE + TIP）。只取 v[0] 会丢掉 RESPONSE，正文整段消失，
//      表现为「正文全被包进思考里」。
//   ② fragments/-1 指「当前最后一个片段」，是续写而非新建；类型必须沿用该片段。
//
// 因此解析器不再依赖"当前 fragment"的游标，而是**按类型分别记录累积内容**，
// 每收到一次快照就把累积值与上次的值比对，只输出新增的尾巴。
// THINK 归思考、RESPONSE 归正文，TIP 是页脚提示（丢弃）。
function makeParser() {
  let acc = { THINK: '', RESPONSE: '' }; // 各类型的累积全文
  let lastFrags = [];                     // 上一次已知的 fragments（用于 2b 定位）

  function reset() {
    acc = { THINK: '', RESPONSE: '' };
    lastFrags = [];
  }

  // 把一份完整的 fragments 列表与已记录的累积值对齐，产出增量
  function sync(frags) {
    const out = [];
    let seqIdx = 0;
    for (const f of frags || []) {
      if (!f || typeof f !== 'object') continue;
      const type = f.type === 'THINK' ? 'THINK' : f.type === 'RESPONSE' ? 'RESPONSE' : null;
      const content = typeof f.content === 'string' ? f.content : '';
      if (type) {
        const prev = acc[type] || '';
        // 累积内容：只取比上次多出来的部分
        const inc = content.length >= prev.length ? content.slice(prev.length) : content;
        if (content.length >= prev.length) acc[type] = content;
        else acc[type] = content; // 上游重写（如重新生成），整体替换
        if (inc) out.push({ type, append: inc, content: acc[type], seq: seqIdx++ });
      }
      // TIP 及其它类型：仅记录位置，不输出
    }
    lastFrags = frags || [];
    return out;
  }

  return function feed(eventName, data) {
    if (!data || typeof data !== 'object') return null;
    if (eventName === 'close') return null;
    if (eventName === 'ready') { reset(); return null; }
    if (data.v === undefined && data.p === undefined) return null;

    // 形态1：完整快照 —— 可能一次带来全部片段，逐个求差
    if (data.v && typeof data.v === 'object' && data.v.response) {
      const outs = sync(data.v.response.fragments || []);
      return outs.length ? outs : null;
    }

    if (typeof data.p === 'string') {
      // 形态2a：数组补丁 —— 内容可能整体是累积值，按类型求差即可
      if (/^response\/fragments$/.test(data.p)) {
        const arr = Array.isArray(data.v) ? data.v : (data.v ? [data.v] : []);
        const outs = sync(arr);
        return outs.length ? outs : null;
      }

      // 形态2b：fragments/<idx>/content —— 往某个片段追加文本
      const m2 = data.p.match(/fragments\/(-?\d+)\/content$/);
      if (m2 && typeof data.v === 'string') {
        // -1 = 当前最后一个片段；否则按索引取
        let frag = null;
        if (m2[1] === '-1') frag = lastFrags.length ? lastFrags[lastFrags.length - 1] : null;
        else {
          const idx = parseInt(m2[1], 10);
          frag = (idx >= 0 && lastFrags[idx]) ? lastFrags[idx] : null;
          if (idx < 0) frag = lastFrags[lastFrags.length + idx] || null;
        }
        // 该补丁本身也可能携带该片段的累积值，交给 sync 求差最稳
        const type = frag && frag.type === 'THINK' ? 'THINK'
                   : frag && frag.type === 'RESPONSE' ? 'RESPONSE' : null;
        if (type) {
          const prev = acc[type] || '';
          // data.v 若是累积全文，用它；否则当增量拼接
          const looksCumulative = frag && typeof frag.content === 'string'
            && data.v.length > 0 && frag.content.endsWith(data.v) && data.v.length >= prev.length;
          const next = looksCumulative ? data.v : prev + data.v;
          const inc = next.length >= prev.length ? next.slice(prev.length) : next;
          acc[type] = next;
          if (frag) frag.content = next;
          if (inc) return [{ type, append: inc, content: next, seq: 0 }];
          return null;
        }
        return null;
      }
      return null;
    }

    // 形态3：裸碎片 —— 追加到"最后出现的非 TIP 片段"
    if (typeof data.v === 'string') {
      let target = null;
      for (let i = lastFrags.length - 1; i >= 0; i--) {
        const f = lastFrags[i];
        if (f && (f.type === 'THINK' || f.type === 'RESPONSE')) { target = f; break; }
      }
      const type = target ? (target.type === 'THINK' ? 'THINK' : 'RESPONSE') : 'RESPONSE';
      acc[type] = (acc[type] || '') + data.v;
      if (target) target.content = acc[type];
      return [{ type, append: data.v, content: acc[type], seq: 0 }];
    }

    return null;
  };
}

// ===== OpenAI 响应组装 =====
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomId() {
  return 'chatcmpl-' + Math.random().toString(36).slice(2, 14);
}

function openaiChunk(id, model, delta, finish) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: nowSec(),
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null }],
  };
}

function sseChunk(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

// ===== CORS =====
function corsHeaders(env) {
  const allow = (env && env.ALLOW_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    // 允许来源随请求头变化，必须声明 Vary，避免 CDN 缓存串站
    Vary: 'Origin',
  };
}

function jsonResp(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

// ===== 主处理 =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 路由挂在 /dsweb/* 下时，剥掉前缀再匹配
    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/^\/dsweb/, '') || '/';
    if (path === '') path = '/';
    path = path.replace(/\/+$/, '') || '/';
    // /health 保持可访问
    if (path === '') path = '/health';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // 健康检查
    if (path === '/health' || path === '') {
      const tokens = loadTokens(env);
      return jsonResp({ status: 'ok', tokens: tokens.length, model: DEFAULT_MODEL }, 200, env);
    }

    // 访问口令校验（设置了 PROXY_KEY 才启用）
    const auth = request.headers.get('Authorization') || '';
    const clientKey = auth.replace(/^Bearer\s+/i, '').trim();
    if (env && env.PROXY_KEY && clientKey !== env.PROXY_KEY) {
      return jsonResp({ error: { message: 'Unauthorized: PROXY_KEY 不匹配', type: 'auth' } }, 401, env);
    }

    const tokens = loadTokens(env);
    if (!tokens.length) {
      return jsonResp(
        { error: { message: '未配置 DEEPSEEK_TOKENS，请先 wrangler secret put DEEPSEEK_TOKENS', type: 'config' } },
        503,
        env
      );
    }

    // 模型列表
    if (path === '/v1/models' || path === '/models') {
      return jsonResp(
        {
          object: 'list',
          data: [
            { id: DEFAULT_MODEL, object: 'model', created: 1700000000, owned_by: 'deepseek-web' },
            { id: 'deepseek-reasoner', object: 'model', created: 1700000000, owned_by: 'deepseek-web' },
          ],
        },
        200,
        env
      );
    }

    // 对话
    // ===== 固定对话选择：列出上游会话 =====
    // 用途：前端「新建对话」时可选「绑定到某个已存在的网页版会话」，
    // 只拉取该会话最近若干轮作为上下文，之后的对话仍留在浏览器本地。
    if (path === '/v1/sessions') {
      const tokens = loadTokens(env);
      const token = tokens[0];
      if (!token) return jsonResp({ error: { message: '未配置 token' } }, 503, env, request);
      try {
        const ctx = makeUpstreamCtx(token);
        const list = await ctx.listSessions();
        const items = list.slice(0, 50).map(function (it) {
          return {
            id: it.id,
            title: it.title || '(无标题)',
            pinned: !!it.pinned,
            updated_at: it.updated_at || 0,
            // 带 [DSH#xxx] 标记的是本服务给固定会话贴的标记，前端可高亮
            tagged: typeof it.title === 'string' && it.title.indexOf('[DSH#') >= 0,
          };
        });
        return jsonResp({ object: 'list', data: items }, 200, env, request);
      } catch (e) {
        return jsonResp({ error: { message: '拉取会话失败: ' + (e && e.message ? e.message : e) } }, 502, env, request);
      }
    }

    // ===== 固定对话选择：读取某个会话的消息（供导入前几条）=====
    // query: id=会话id&limit=N（默认 5，最多 20）
    if (path === '/v1/sessions/messages') {
      const tokens = loadTokens(env);
      const token = tokens[0];
      if (!token) return jsonResp({ error: { message: '未配置 token' } }, 503, env, request);
      const sid = url.searchParams.get('id') || '';
      if (!sid) return jsonResp({ error: { message: '缺少 id' } }, 400, env, request);
      let limit = parseInt(url.searchParams.get('limit') || '5', 10);
      if (isNaN(limit) || limit <= 0) limit = 5;
      if (limit > 20) limit = 20;
      try {
        const ctx = makeUpstreamCtx(token);
        const msgs = await ctx.historyMessages(sid);
        // 只取最近 limit 条，且过滤 TIP / 系统提示等非对话片段
        const picked = [];
        for (let i = msgs.length - 1; i >= 0 && picked.length < limit; i--) {
          const m = msgs[i];
          if (!m) continue;
          const role = m.role === 'USER' ? 'user' : m.role === 'ASSISTANT' ? 'assistant' : null;
          if (!role) continue;
          // 只取 RESPONSE 片段作为正文；THINK 是思考过程，混进正文会污染导入内容
          const frags = m.fragments || [];
          const resp = frags.filter(function (f) { return f && f.type === 'RESPONSE'; })
            .map(function (f) { return f.content || ''; }).join('').trim();
          const think = frags.filter(function (f) { return f && f.type === 'THINK'; })
            .map(function (f) { return f.content || ''; }).join('').trim();
          // 老数据可能没有 RESPONSE 类型，退化取所有非 TIP 片段
          const text = resp || (frags.filter(function (f) {
            return f && f.type !== 'TIP' && f.type !== 'THINK' && typeof f.content === 'string';
          }).map(function (f) { return f.content; }).join('').trim());
          if (!text) continue;
          picked.unshift({ role: role, content: text, reasoning: think || undefined, message_id: m.message_id });
        }
        return jsonResp({ id: sid, count: picked.length, messages: picked }, 200, env, request);
      } catch (e) {
        return jsonResp({ error: { message: '读取会话失败: ' + (e && e.message ? e.message : e) } }, 502, env, request);
      }
    }

    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      return handleChat(request, env, tokens);
    }

    return jsonResp({ error: { message: 'Not Found: ' + url.pathname, type: 'not_found' } }, 404, env);
  },
};

async function handleChat(request, env, tokens) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ error: { message: '请求体不是合法 JSON', type: 'invalid_request' } }, 400, env);
  }

  const messages = body.messages || [];
  if (!messages.length) {
    return jsonResp({ error: { message: 'messages 不能为空', type: 'invalid_request' } }, 400, env);
  }

  const model = body.model || DEFAULT_MODEL;
  const stream = !!body.stream;
  // 模型名带 reasoner 或显式 thinking_mode 时开启深度思考
  const thinking =
    body.thinking_mode === true ||
    /reasoner/i.test(model) ||
    (env && env.THINKING === 'enabled');
  const search = body.search_enabled === true || (env && env.SEARCH === 'enabled');

  // ===== 两个独立开关（都可单独开关，互不依赖）=====
  // incremental：增量模式，只发本轮输入，上下文靠 parent_message_id 串接；
  // singleChat ：单次对话，反代侧永远复用同一个 chat_session。
  const incremental = body.incremental === true || (env && env.INCREMENTAL === 'enabled');
  const singleChat = body.single_chat === true || (env && env.SINGLE_CHAT === 'enabled');

  let prompt = buildPrompt(messages, body.system);
  let lastErr = null;

  // 账号池轮询：任意一个 token 成功即可
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    try {
      const needStable = singleChat || incremental;
      const scope = (body && (body.conversation_scope || body.session_scope)) || '';
      const pin = String(body.chat_session_id || body.pinned_session_id || '').trim();
      // 一个请求内共用同一个 ctx：PoW 只算一次（否则会撞 Workers CPU 上限，返回 1102）
      const ctx = makeUpstreamCtx(token);
      const sess = await acquireSession(token, { persistent: needStable, scope, pin, ctx });
      const sid = sess.id;
      const needMark = !!sess.needMark;
      // 增量模式的 parent 必须持久：直接从上游历史读最后一条 ASSISTANT 的 message_id。
      // 绑定固定会话（pin）时也必须读：往已存在的会话追加消息要挂到它最后一条上，
      // 否则上游会把它当成孤立消息，甚至落到别的会话里。
      let parentId = null;
      if (incremental || pin) {
        parentId = await ctx.lastAssistantId(sid);
      }
      if (incremental) {
        prompt = buildPrompt(buildIncrementalMessages(messages, parentId != null), body.system);
      }
      // 复用 ctx 已经解出的 PoW（target_path 相同，可直接用），省掉一次 WASM 计算
      const pow = ctx.powCacheValue || (await ctx.pow('/api/v0/chat/completion'));
      const upstream = await fetch(DEEPSEEK_BASE + '/api/v0/chat/completion', {
        method: 'POST',
        headers: authHeaders(token, {
          'X-DS-PoW-Response': pow,
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        }),
        body: JSON.stringify({
          chat_session_id: sid,
          parent_message_id: parentId,
          model_type: 'default',
          prompt,
          ref_file_ids: [],
          thinking_enabled: thinking,
          search_enabled: search,
          preempt: false,
          stream: true, // 上游统一用流式，非流式也在本地聚合
        }),
      });

      if (!upstream.ok) {
        const t = await upstream.text();
        lastErr = new Error('上游 HTTP ' + upstream.status + ': ' + t.slice(0, 200));
        continue; // 换下一个账号
      }

      // 上游消息 id 由 history_messages 持久保存，这里不需要再写回内存
      const onResponseId = null;
      // 本轮落库后给会话贴上标记（订阅式，不阻塞响应）：
      // 空会话改标题会被上游拒绝，必须等这条消息写进去之后再贴。
      if (needMark) {
        const mctx = makeUpstreamCtx(token);
        const mark = buildSessionMarker(scope);
        const doMark = () => mctx.setTitle(sid, mark + ' 固定会话').catch(() => {});
        try { request.waitUntil(doMark()); } catch (e) { doMark(); }
      }
      if (stream) return streamResponse(upstream, model, env, thinking, onResponseId);
      return await aggregateResponse(upstream, model, env, thinking, onResponseId);
    } catch (e) {
      lastErr = e;
      // 会话可能失效，清掉让它重建（按同样的 key，避免误删别的会话）
      sessionPool.delete(poolKey(token, (body && (body.conversation_scope || body.session_scope)) || ''));
    }
  }

  return jsonResp(
    {
      error: {
        message: '所有账号均失败: ' + (lastErr ? lastErr.message : '未知错误'),
        type: 'upstream_error',
      },
    },
    502,
    env
  );
}

// 非流式：把上游 SSE 聚合成一次性响应
async function aggregateResponse(upstream, model, env, thinking, onResponseId) {
  const text = await upstream.text();
  const feed = makeParser();
  let content = '';
  let reasoning = '';

  for (const block of text.split('\n\n')) {
    let eventName = '';
    let dataStr = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataStr += line.slice(6);
    }
    if (!dataStr) continue;
    let data;
    try {
      data = JSON.parse(dataStr);
    } catch (e) {
      continue;
    }
    const parts = feed(eventName, data);
    if (parts) {
      for (const d of (Array.isArray(parts) ? parts : [parts])) {
        if (!d || d.append === undefined) continue;
        if (d.type === 'THINK') reasoning += d.append;
        else content += d.append;
      }
    }
  }

  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;

  return jsonResp(
    {
      id: randomId(),
      object: 'chat.completion',
      created: nowSec(),
      model,
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    200,
    env
  );
}

// 流式：逐块转发 OpenAI chunk
function streamResponse(upstream, model, env, thinking, onResponseId) {
  const id = randomId();
  const encoder = new TextEncoder();
  const feed = makeParser();
  let sentContent = '';
  let sentReasoning = '';

  const stream = new ReadableStream({
    async start(controller) {
      const push = (obj) => controller.enqueue(encoder.encode(sseChunk(obj)));
      push(openaiChunk(id, model, { role: 'assistant', content: '' }));

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const blocks = buf.split('\n\n');
          buf = blocks.pop() || '';
          for (const block of blocks) {
            let eventName = '';
            let dataStr = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) eventName = line.slice(7).trim();
              else if (line.startsWith('data: ')) dataStr += line.slice(6);
            }
            if (!dataStr) continue;
            let data;
            try {
              data = JSON.parse(dataStr);
            } catch (e) {
              continue;
            }
            const parts = feed(eventName, data);
            if (!parts) continue;
            for (const d of (Array.isArray(parts) ? parts : [parts])) {
              if (!d || d.append === undefined || !d.append) continue;
              const inc = d.append;
              if (d.type === 'THINK') {
                sentReasoning = d.content;
                push(openaiChunk(id, model, { reasoning_content: inc }));
              } else {
                sentContent = d.content;
                push(openaiChunk(id, model, { content: inc }));
              }
            }
          }
        }
      } catch (e) {
        // 上游中断：补一条错误事件，前端可感知
        push({ error: { message: '上游流中断: ' + (e && e.message ? e.message : e) } });
      } finally {
        try {
          push(openaiChunk(id, model, {}, 'stop'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (e) {}
        try {
          controller.close();
        } catch (e) {}
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...corsHeaders(env),
    },
  });
}
