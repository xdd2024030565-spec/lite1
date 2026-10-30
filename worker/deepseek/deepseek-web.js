// deepseek-web —— DeepSeek 网页版反代（Cloudflare Worker）
// 把 chat.deepseek.com 的私有接口反代为 OpenAI 兼容接口，供前端 ai.html 直接调用。
//
// 核心能力：
//   1. PoW 自动求解（DeepSeekHashV1，用官方 sha3_wasm_bg.wasm，与网页端同源算法）
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


import * as wasmNs from './sha3_wasm_bg.wasm';
// Cloudflare CompiledWasm：命名空间里是 { default: WebAssembly.Module }
// Node --experimental-wasm-modules：命名空间就是 wasm 的导出对象本身
const wasmModule = (wasmNs && wasmNs.default) ? wasmNs.default : wasmNs;

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

// ===== PoW 求解器（官方 WASM，wasm_solve）=====
// 说明：这里必须用官方 WASM。曾经改成「纯 JS SHA3 + 自己判定阈值」的实现，
// 结果是服务端一律回 40301 INVALID_POW_RESPONSE —— 难点在于官方把 challenge 与
// salt_expire_ 前缀分开传入、并在 WASM 内部按特定打包方式比较，外部无法可靠复刻。
// WASM 由 wrangler 的 CompiledWasm 规则在**部署时**预编译，不涉及运行时编译，Workers 允许。
let wasmPromise = null;
function getWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      // Cloudflare 的 CompiledWasm 规则给到的是 WebAssembly.Module（需实例化）；
      // 某些运行时（如 Node 的 --experimental-wasm-modules）直接给已实例化的导出对象。
      if (wasmModule && typeof wasmModule.wasm_solve === 'function') return wasmModule;
      const r = await WebAssembly.instantiate(wasmModule, {});
      return (r.instance || r).exports;
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
  const [prePtr, preLen] = encodeInto(e, challenge.salt + '_' + challenge.expire_at + '_');
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

// 每个 token 一个会话池，同一会话复用可保证多轮上下文
const sessionPool = new Map(); // token -> { id, lastUsed, busy }

async function acquireSession(token) {
  const now = Date.now();
  let s = sessionPool.get(token);
  // 会话 30 分钟过期（上游 ttl_seconds 为 259200，这里保守取 30 分钟）
  if (!s || now - s.lastUsed > 30 * 60 * 1000) {
    s = { id: await createSession(token), lastUsed: now };
    sessionPool.set(token, s);
  }
  s.lastUsed = now;
  return s.id;
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

// ===== 上游 SSE 解析 =====
// DeepSeek 事件流的正文有三种形态（已用真实流量核对）：
//   1. 快照：{"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"We"}]}}}
//      —— 每个新 fragment 开始时发一次，type 为 THINK（思考）或 RESPONSE（正文）
//   2. 补丁：{"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
//      —— "-1" 表示「追加一个新 fragment」，它开启下一段；"0"/"1" 表示续写已有段
//   3. 碎片：{"v":" answer"}  —— 追加到当前段
// 注意：思考模式下会先来 THINK 段，再来 RESPONSE 段；若始终复用同一个 current，
// 正文会被混进思考里、RESPONSE 为空（曾实测到 content="" 的 bug）。
function makeParser() {
  let current = null; // { id, type, content }

  return function feed(eventName, data) {
    if (!data || typeof data !== 'object') return null;
    if (eventName === 'close') return null;
    // 新消息开始：重置分段
    if (eventName === 'ready') {
      current = null;
      return null;
    }
    // 协议层的其它事件（update_session 等）跳过
    if (data.v === undefined && data.p === undefined) return null;

    // --- 形态 1：快照（含 fragments 数组）---
    if (data.v && typeof data.v === 'object' && data.v.response) {
      const frags = data.v.response.fragments || [];
      let out = null;
      for (const f of frags) {
        if (typeof f.content !== 'string') continue;
        current = { id: f.id, type: f.type || 'RESPONSE', content: f.content };
        out = { content: f.content, type: current.type, append: f.content };
      }
      return out;
    }

    // --- 形态 2：JSON Patch ---
    if (typeof data.p === 'string') {
      // 2a. 追加整个 fragment 数组：{"p":"response/fragments","o":"APPEND","v":[{id,type,content}]}
      //     思考模式下 THINK 段结束后，正文段就是这样出现的。务必先于下面判断。
      if (/^response\/fragments$/.test(data.p)) {
        const frag = Array.isArray(data.v) ? data.v[0] : data.v;
        if (frag && typeof frag === 'object' && typeof frag.content === 'string') {
          current = { id: frag.id, type: frag.type || 'RESPONSE', content: frag.content };
          return { content: frag.content, type: current.type, append: frag.content };
        }
        return null;
      }
      // 2b. 段内文本补丁：{"p":"response/fragments/-1/content","v":" need"}
      const m = data.p.match(/fragments\/(-?\d+)\/content$/);
      if (m && typeof data.v === 'string') {
        if (m[1] === '-1') {
          current = { id: null, type: 'RESPONSE', content: data.v };
          return { content: current.content, type: current.type, append: data.v };
        }
        if (!current) current = { id: m[1], type: 'RESPONSE', content: '' };
        current.content += data.v;
        return { content: current.content, type: current.type, append: data.v };
      }
      return null; // 其它 patch（elapsed_secs 等）忽略
    }

    // --- 形态 3：裸碎片，追加到当前段 ---
    if (typeof data.v === 'string') {
      if (!current) {
        current = { id: null, type: 'RESPONSE', content: data.v };
      } else {
        current.content += data.v;
      }
      return { content: current.content, type: current.type, append: data.v };
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
function corsHeaders(env, request) {
  // 关键：Access-Control-Allow-Origin 只能是「*」或**恰好一个**来源。
  // 早先这里直接把 ALLOW_ORIGIN 那一整串（逗号分隔）回给浏览器，
  // 浏览器判定为非法值 → 前端所有请求都会被 CORS 拦掉（curl 不看 CORS 所以测不出来）。
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

function jsonResp(obj, status, env, request) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env, request) },
  });
}

// ===== 主处理 =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/^\/dsweb/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    // 健康检查：放在鉴权之前，方便排障
    if (path === '/health' || path === '') {
      const tk = loadTokens(env);
      const hdr = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      const pk = env && env.PROXY_KEY;
      const headerIsToken = !!hdr && (!pk || hdr !== pk);
      return jsonResp(
        {
          status: 'ok',
          service: 'deepseek-web',
          runtime: 'wasm-sha3',
          tokens: tk.length,
          tokenSource: tk.length ? 'secret' : headerIsToken ? 'header' : 'none',
          proxyKeyRequired: !!pk,
          model: DEFAULT_MODEL,
        },
        200,
        env, request
      );
    }

    // 访问口令校验（设置了 PROXY_KEY 才启用）
    const auth = request.headers.get('Authorization') || '';
    const clientKey = auth.replace(/^Bearer\s+/i, '').trim();
    const proxyKey = env && env.PROXY_KEY;
    if (proxyKey && clientKey !== proxyKey) {
      return jsonResp({ error: { message: 'Unauthorized: PROXY_KEY 不匹配', type: 'auth' } }, 401, env, request);
    }

    // 模型列表：纯静态数据，不需要 token。
    // （以前 token 检查排在路由前面，导致没配 token 时连 /v1/models 都返回 503，
    //   前端和 OpenAI SDK 探活时会误判成「服务不可用」。）
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
        env, request
      );
    }

    // 对话：只有这条路径需要 token
    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      // token 有两个来源，按优先级取：
      //   1) Worker secret DEEPSEEK_TOKENS —— 推荐，token 不落到浏览器
      //   2) 请求头 Authorization: Bearer <网页版 token> —— 没配 secret 时兜底，
      //      在前端把 token 填进该提供商的「API Key」即可直接用，不必重新部署
      let tokens = loadTokens(env);
      if (!tokens.length && clientKey && !proxyKey) tokens = [clientKey];
      if (!tokens.length) {
        return jsonResp(
          {
            error: {
              message:
                '未配置 DeepSeek token。两种方式任选：① wrangler secret put DEEPSEEK_TOKENS；' +
                '② 在前端把网页版 token 填进「DeepSeek 网页版」提供商的 API Key 字段。',
              type: 'config',
            },
          },
          503,
          env, request
        );
      }
      return handleChat(request, env, tokens);
    }

    return jsonResp({ error: { message: 'Not Found: ' + url.pathname, type: 'not_found' } }, 404, env, request);
  },
};

async function handleChat(request, env, tokens) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ error: { message: '请求体不是合法 JSON', type: 'invalid_request' } }, 400, env, request);
  }

  const messages = body.messages || [];
  if (!messages.length) {
    return jsonResp({ error: { message: 'messages 不能为空', type: 'invalid_request' } }, 400, env, request);
  }

  const model = body.model || DEFAULT_MODEL;
  const stream = !!body.stream;
  // 模型名带 reasoner 或显式 thinking_mode 时开启深度思考
  const thinking =
    body.thinking_mode === true ||
    /reasoner/i.test(model) ||
    (env && env.THINKING === 'enabled');
  const search = body.search_enabled === true || (env && env.SEARCH === 'enabled');

  const prompt = buildPrompt(messages, body.system);
  let lastErr = null;

  // 账号池轮询：任意一个 token 成功即可
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    try {
      const sid = await acquireSession(token);
      const pow = await getPowHeader(token);
      const upstream = await fetch(DEEPSEEK_BASE + '/api/v0/chat/completion', {
        method: 'POST',
        headers: authHeaders(token, {
          'X-DS-PoW-Response': pow,
          ...(stream ? { Accept: 'text/event-stream' } : {}),
        }),
        body: JSON.stringify({
          chat_session_id: sid,
          parent_message_id: null,
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

      if (stream) return streamResponse(upstream, model, env, thinking, request);
      return await aggregateResponse(upstream, model, env, thinking, request);
    } catch (e) {
      lastErr = e;
      // 会话可能失效，清掉让它重建
      sessionPool.delete(token);
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
    env, request
  );
}

// 非流式：把上游 SSE 聚合成一次性响应
async function aggregateResponse(upstream, model, env, thinking, request) {
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
    const delta = feed(eventName, data);
    if (delta) {
      if (delta.type === 'THINK') reasoning = delta.content;
      else content = delta.content;
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
    env, request
  );
}

// 流式：逐块转发 OpenAI chunk
function streamResponse(upstream, model, env, thinking, request) {
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
            const d = feed(eventName, data);
            if (!d) continue;
            // 优先用解析器给出的增量；退化时按累积长度求差
            const inc =
              d.append !== undefined
                ? d.append
                : d.content.slice((d.type === 'THINK' ? sentReasoning : sentContent).length);
            if (!inc) continue;
            if (d.type === 'THINK') {
              sentReasoning = d.content;
              push(openaiChunk(id, model, { reasoning_content: inc }));
            } else {
              sentContent = d.content;
              push(openaiChunk(id, model, { content: inc }));
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
      ...corsHeaders(env, request),
    },
  });
}
