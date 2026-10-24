const DEEPSEEK_BASE = 'https://chat.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
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
function loadTokens(env) {
  const raw = (env && env.DEEPSEEK_TOKENS) || '';
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
const sessionPool = new Map(); // token -> { id, lastUsed, busy }
async function acquireSession(token) {
  const now = Date.now();
  let s = sessionPool.get(token);
  if (!s || now - s.lastUsed > 30 * 60 * 1000) {
    s = { id: await createSession(token), lastUsed: now };
    sessionPool.set(token, s);
  }
  s.lastUsed = now;
  return s.id;
}
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
      parts.push('[assistant 之前的回答]\n' + c);
    }
  }
  return parts.join('\n\n');
}
function makeParser() {
  let current = null; // { id, type, content }
  return function feed(eventName, data) {
    if (!data || typeof data !== 'object') return null;
    if (eventName === 'close') return null;
    if (eventName === 'ready') {
      current = null;
      return null;
    }
    if (data.v === undefined && data.p === undefined) return null;
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
    if (typeof data.p === 'string') {
      if (/^response\/fragments$/.test(data.p)) {
        const frag = Array.isArray(data.v) ? data.v[0] : data.v;
        if (frag && typeof frag === 'object' && typeof frag.content === 'string') {
          current = { id: frag.id, type: frag.type || 'RESPONSE', content: frag.content };
          return { content: frag.content, type: current.type, append: frag.content };
        }
        return null;
      }
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
function corsHeaders(env) {
  const allow = (env && env.ALLOW_ORIGIN) || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function jsonResp(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, '');
    path = path.replace(/^\/dsweb/, '') || '/';
    if (path === '') path = '/';
    path = path.replace(/\/+$/, '') || '/';
    if (path === '') path = '/health';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (path === '/health' || path === '') {
      const tokens = loadTokens(env);
      return jsonResp({ status: 'ok', tokens: tokens.length, model: DEFAULT_MODEL }, 200, env);
    }
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
  const thinking =
    body.thinking_mode === true ||
    /reasoner/i.test(model) ||
    (env && env.THINKING === 'enabled');
  const search = body.search_enabled === true || (env && env.SEARCH === 'enabled');
  const prompt = buildPrompt(messages, body.system);
  let lastErr = null;
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
      if (stream) return streamResponse(upstream, model, env, thinking);
      return await aggregateResponse(upstream, model, env, thinking);
    } catch (e) {
      lastErr = e;
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
    env
  );
}
async function aggregateResponse(upstream, model, env, thinking) {
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
    env
  );
}
function streamResponse(upstream, model, env, thinking) {
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
