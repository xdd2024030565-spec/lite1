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
  // persistent=true（单次对话）：始终钉在同一个 chat_session 上，
  // 让 chat.deepseek.com 里永远只有这一个对话，而不是越开越多。
  const persistent = !!(opts && opts.persistent);
  const key = poolKey(token, opts && opts.scope);
  let s = sessionPool.get(key);

  if (persistent) {
    // 内存缓存只在同一实例内有效（通常几百毫秒内连续请求能命中），
    // 真正的锚点是上游会话列表，这样换实例、过很久都不会漂移。
    const c = persistCache.get(key);
    if (c && now - c.at < 5 * 60 * 1000 && s && s.id === c.id) {
      s.lastUsed = now;
      return s;
    }
    const existId = await findLatestSession(token);
    if (existId) {
      s = { id: existId, lastUsed: now, lastResponseId: s ? s.lastResponseId : null };
      sessionPool.set(key, s);
      persistCache.set(key, { id: existId, at: now });
      return s;
    }
    // 列表为空（账号全新）时才真正新建
    s = { id: await createSession(token), lastUsed: now, lastResponseId: null };
    sessionPool.set(key, s);
    persistCache.set(key, { id: s.id, at: now });
    return s;
  }

  const stale = s && now - s.lastUsed > 30 * 60 * 1000;
  // 会话 30 分钟过期（上游 ttl_seconds 为 259200，这里保守取 30 分钟）
  if (!s || stale) {
    s = { id: await createSession(token), lastUsed: now, lastResponseId: null };
    sessionPool.set(key, s);
  }
  s.lastUsed = now;
  return s;
}

// ===== 持久会话锚定（单次对话）=====
// ⚠️ Cloudflare Workers 的模块级变量**不保证跨请求存活**：隔离环境下每个请求可能拿到
// 全新实例，sessionPool 里的 Map 会凭空消失，于是每次请求都新建 chat_session，
// 「单次对话」形同虚设（实测连发 4 次在上游造出 4 条对话）。
// 因此真正的锚点不能放在内存里 —— 这里改用**上游自己的会话列表**：
//   GET /api/v0/chat_session/fetch_page 返回该账号最近的全部会话，
//   取最新的那条作为固定会话。上游持久，所以换实例也不会丢。
// 内存里仍保留一份短期缓存，命中时省掉一次列表请求。
const persistCache = new Map(); // key -> { id, at }

async function findLatestSession(token) {
  try {
    const pow = await getPowHeaderFor(token, '/api/v0/chat_session/fetch_page');
    const r = await fetch(DEEPSEEK_BASE + '/api/v0/chat_session/fetch_page', {
      method: 'GET',
      headers: authHeaders(token, { 'X-DS-PoW-Response': pow }),
    });
    const j = await r.json();
    const list = (j && j.data && j.data.biz_data && j.data.biz_data.chat_sessions) || [];
    return list.length ? list[0].id : null;
  } catch (e) {
    return null;
  }
}

// 为任意 path 申请 PoW（fetch_page 与 completion 的 target_path 不同）
async function getPowHeaderFor(token, targetPath) {
  const r = await fetch(DEEPSEEK_BASE + '/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ target_path: targetPath }),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch (e) {
    throw new Error('challenge 响应非 JSON: HTTP ' + r.status + ' ' + text.slice(0, 200));
  }
  if (j.code !== 0) throw new Error('challenge 失败: ' + JSON.stringify(j).slice(0, 300));
  return solvePow(j.data.biz_data.challenge);
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
      const scope = (body && (body.conversation_scope || body.session_scope)) || '';
      const sess = await acquireSession(token, { persistent: singleChat, scope });
      const sid = sess.id;
      const parentId = incremental ? sess.lastResponseId || null : null;
      if (incremental) {
        prompt = buildPrompt(buildIncrementalMessages(messages, !!sess.lastResponseId), body.system);
      }
      const pow = await getPowHeader(token);
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

      const onResponseId = function (rid) {
        if (rid) sess.lastResponseId = rid;
      };
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
