/*
 * Kimi（kimi.moonshot.cn 网页版）适配器。
 *
 * 凭证是网页端 localStorage 里的 refresh_token（数组的话用 . 拼接）。
 * 每次请求先拿它换一个短期 access_token，再建会话、发消息。
 *
 * 上游接口：
 *   GET  /api/auth/token/refresh                refresh_token → access_token
 *   GET  /api/user                              取用户 id（放进 X-Traffic-Id）
 *   POST /api/chat                              建会话
 *   POST /api/chat/{id}/completion/stream       发消息（SSE，event: cmpl / data: {...}）
 *   DELETE /api/chat/{id}                       收尾删掉临时会话
 */

import { deltaChunk, finishChunk, doneChunk, errorChunk, randomId } from '../lib/sse.js';

const HOST = 'https://kimi.moonshot.cn';
const MODEL = 'kimi';
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

export const models = [{ id: 'kimi', name: 'Kimi' }];

// access_token 有效期约 15 分钟，按 refresh_token 缓存 8 分钟。
const TOKEN_CACHE = new Map();
const TOKEN_TTL = 480000;

function baseHeaders(token) {
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: HOST,
    referer: HOST + '/',
    'user-agent': UA,
    'content-type': 'application/json',
    authorization: 'Bearer ' + token,
    'r-timezone': 'Asia/Shanghai',
  };
}

/* refresh_token 换 access_token，并顺手拿到 userId。 */
export async function refreshToken(refresh) {
  const cached = TOKEN_CACHE.get(refresh);
  if (cached && Date.now() - cached.at < TOKEN_TTL) return cached;

  const r = await fetch(HOST + '/api/auth/token/refresh', {
    method: 'GET',
    headers: baseHeaders(refresh),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('换 token 失败（HTTP ' + r.status + '）：' + text.slice(0, 200));
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('换 token 返回的不是 JSON：' + text.slice(0, 200));
  }
  const access = data && data.access_token;
  const next = (data && data.refresh_token) || refresh;
  if (!access) throw new Error('换 token 没拿到 access_token：' + text.slice(0, 200));

  let userId = '';
  try {
    const ur = await fetch(HOST + '/api/user', { method: 'GET', headers: baseHeaders(access) });
    if (ur.ok) {
      const u = await ur.json();
      userId = String((u && u.id) || '');
    }
  } catch (e) {
    /* userId 拿不到就先留空，X-Traffic-Id 可以不发 */
  }

  const out = { access: access, refresh: next, userId: userId, at: Date.now() };
  TOKEN_CACHE.set(refresh, out);
  return out;
}

export async function createConversation(access, userId) {
  const headers = baseHeaders(access);
  if (userId) headers['x-traffic-id'] = userId;
  const r = await fetch(HOST + '/api/chat', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      enter_method: 'new_chat',
      is_example: false,
      kimiplus_id: MODEL,
      name: '网页聊天',
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('建会话失败（HTTP ' + r.status + '）：' + text.slice(0, 200));
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('建会话返回的不是 JSON：' + text.slice(0, 200));
  }
  if (!data || !data.id) throw new Error('建会话没拿到 id：' + text.slice(0, 200));
  return data.id;
}

export function buildChatBody({ messages, model }) {
  const list = (Array.isArray(messages) ? messages : []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));
  return {
    kimiplus_id: model === 'kimi-k1' ? 'kimi-k1' : MODEL,
    messages: list,
    refs: [],
    use_math: false,
    use_research: false,
    use_search: false,
    extend: { sidebar: true },
  };
}

/* 上游一帧：SSE 里既有 event: 行也有 data: 行，只认 data 里的 JSON。 */
export function parseEvent(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (s.indexOf('data:') === 0) s = s.slice(5).trim();
  if (!s || s.indexOf('event:') === 0 || s === '[DONE]') return null;
  let chunk = null;
  try {
    chunk = JSON.parse(s);
  } catch (e) {
    return null;
  }
  if (!chunk || typeof chunk !== 'object') return null;
  if (chunk.event === 'cmpl' && chunk.text) return { content: String(chunk.text) };
  if (chunk.event === 'req') return null;
  if (chunk.event === 'search_plus' && chunk.msg && chunk.msg.type === 'get_res') return null;
  if (chunk.event === 'length') return null;
  if (chunk.event === 'all_done') return { finish: 'stop' };
  if (chunk.event === 'error') return { error: 'Kimi 中断了这次生成，换个说法再试' };
  return null;
}

function streamChat(upstream, model, access, userId, convId) {
  const id = randomId();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ended = false;

  const cleanup = () => {
    const headers = baseHeaders(access);
    if (userId) headers['x-traffic-id'] = userId;
    fetch(HOST + '/api/chat/' + convId, { method: 'DELETE', headers: headers }).catch(() => {});
  };

  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const push = (s) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch (e) {
          /* 下游已断开 */
        }
      };
      const finish = () => {
        if (ended) return;
        ended = true;
        push(finishChunk(id, model, 'stop'));
        push(doneChunk());
        try {
          controller.close();
        } catch (e) {
          /* 已关闭 */
        }
        cleanup();
      };
      const fail = (msg) => {
        if (ended) return;
        ended = true;
        push(errorChunk(msg));
        push(doneChunk());
        try {
          controller.close();
        } catch (e) {
          /* 已关闭 */
        }
        cleanup();
      };
      const handleLine = (line) => {
        const s = String(line || '').trim();
        if (!s || s === '[DONE]') return;
        const ev = parseEvent(s);
        if (!ev) return;
        if (ev.error) {
          fail(ev.error);
          return;
        }
        if (ev.content) push(deltaChunk(id, model, { content: ev.content }));
        if (ev.finish) finish();
      };
      const pump = () => {
        reader.read().then((r) => {
          if (r.done) {
            if (buf.trim()) handleLine(buf);
            finish();
            return;
          }
          buf += decoder.decode(r.value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const ln of lines) handleLine(ln);
          if (!ended) pump();
        }).catch((e) => fail('读取 Kimi 响应失败：' + (e && e.message ? e.message : String(e))));
      };
      pump();
    },
  });
}

export async function chat(request, env, tokens) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const refresh = tokens && tokens[0];
  if (!refresh) {
    return new Response(
      JSON.stringify({ error: { message: '还没有配置 Kimi 凭证：请在反代仓库 secret 里加 KIMI_TOKENS，或在前端设置里填 refresh_token' } }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return new Response(JSON.stringify({ error: { message: '消息为空' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  let tk = null;
  try {
    tk = await refreshToken(refresh);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: 'Kimi 换 token 失败，多半是 refresh_token 失效了：' + (e && e.message ? e.message : String(e)) } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  let convId = '';
  try {
    convId = await createConversation(tk.access, tk.userId);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: 'Kimi 建会话失败：' + (e && e.message ? e.message : String(e)) } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  const headers = baseHeaders(tk.access);
  if (tk.userId) headers['x-traffic-id'] = tk.userId;
  headers.referer = HOST + '/chat/' + convId;

  let upstream = null;
  try {
    upstream = await fetch(HOST + '/api/chat/' + convId + '/completion/stream', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(buildChatBody({ messages: messages, model: body.model })),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: '连接 Kimi 失败：' + (e && e.message ? e.message : String(e)) } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(
      JSON.stringify({
        error: {
          message: 'Kimi 返回 HTTP ' + upstream.status + '，多半是 refresh_token 失效或被风控拦下。' + text.slice(0, 300),
        },
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(streamChat(upstream, MODEL, tk.access, tk.userId, convId), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

export function health(env) {
  const list = String((env && env.KIMI_TOKENS) || '')
    .split(',')
    .filter(Boolean);
  return { ok: list.length > 0, site: 'kimi', kind: list.length ? 'ok' : 'no_token' };
}
