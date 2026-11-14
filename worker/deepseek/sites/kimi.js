/*
 * Kimi（www.kimi.ai 网页版）适配器。
 *
 * 凭证是网页端 localStorage 里的 refresh_token（数组的话用 . 拼接）。
 * 上游已经迁到 Connect RPC：先换 access_token，再按 Connect 帧格式发一次聊天请求。
 *
 * 上游接口：
 *   POST https://auth.kimi.ai/api/account.gateway.v1.AuthService/RefreshToken
 *        {"refresh_token": "..."} → {accessToken|access_token|token}
 *   POST https://www.kimi.ai/apiv2/kimi.gateway.chat.v1.ChatService/Chat
 *        application/connect+json，请求体是「5 字节帧头 + JSON」，响应是若干同样格式的帧
 */

import { deltaChunk, finishChunk, doneChunk, errorChunk, randomId } from '../lib/sse.js';

const BASE = 'https://www.kimi.ai';
const AUTH_URL = 'https://auth.kimi.ai/api/account.gateway.v1.AuthService/RefreshToken';
const CHAT_URL = BASE + '/apiv2/kimi.gateway.chat.v1.ChatService/Chat';
const MODEL = 'kimi';
const INNER_MODEL = 'k2d6-chat';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';
const HEADER_SIZE = 5;

export const models = [{ id: MODEL, name: 'Kimi' }];

// access_token 很短命，按 refresh_token 缓存 8 分钟。
const TOKEN_CACHE = new Map();
const TOKEN_TTL = 480000;

/** 解开 JWT 的载荷段（只做 base64url 解码，不验签）。 */
export function jwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const bin = atob(b64 + pad);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return null;
  }
}

/**
 * 判断凭证类型：access 直接用，refresh 先换。
 * 不是 JWT（比如手填的短串）一律按 refresh 处理。
 */
export function tokenKind(token) {
  const payload = jwtPayload(token);
  if (!payload) return 'refresh';
  if (payload.typ === 'access') return 'access';
  if (payload.typ === 'refresh') return 'refresh';
  return 'refresh';
}

function mshHeaders() {
  return {
    'x-msh-platform': 'web',
    'x-msh-version': '2.2.0',
    'x-language': 'zh-CN',
    'user-agent': UA,
    origin: BASE,
    referer: BASE + '/',
  };
}

/** 把整段对话压成一条 prompt：最后一条是用户输入的正文。 */
export function mergeMessages(messages) {
  const list = (messages || []).filter(function (m) {
    return m && typeof m.content === 'string' && m.content;
  });
  if (!list.length) return '';
  const last = list[list.length - 1];
  if (list.length === 1) return last.content;
  const head = list.slice(0, -1).map(function (m) {
    return (m.role === 'assistant' ? '你' : '用户') + '：' + m.content;
  });
  return '以下是之前的对话：\n' + head.join('\n') + '\n\n现在请回答：\n' + last.content;
}

/** Connect 请求帧：1 字节标志位 + 4 字节大端长度 + JSON 正文。 */
export function encodeFrame(obj) {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(HEADER_SIZE + body.length);
  out[0] = 0;
  new DataView(out.buffer).setUint32(1, body.length, false);
  out.set(body, HEADER_SIZE);
  return out;
}

/** 从缓冲区里切出完整的帧，返回 [事件数组, 剩余字节]。 */
export function takeFrames(buffer) {
  const events = [];
  let buf = buffer;
  while (buf && buf.length >= HEADER_SIZE) {
    const flag = buf[0];
    const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
    if (buf.length < HEADER_SIZE + len) break;
    const payload = buf.subarray(HEADER_SIZE, HEADER_SIZE + len);
    buf = buf.subarray(HEADER_SIZE + len);
    // 0x02 是流结束的 trailer，没有正文。
    if (flag === 2 || !len) continue;
    try {
      events.push(JSON.parse(new TextDecoder().decode(payload)));
    } catch (e) {
      /* 坏帧直接跳过 */
    }
  }
  return [events, buf];
}

export function buildChatBody(prompt, thinking) {
  return {
    scenario: 'SCENARIO_CHAT',
    tools: [{ type: 'TOOL_TYPE_SEARCH', search: {} }, { type: 'TOOL_TYPE_CRON_JOB' }],
    options: {
      thinking: true,
      enable_plugin: false,
      reasoning_effort: thinking ? 'REASONING_EFFORT_LOW' : 'REASONING_EFFORT_NONE',
      model: INNER_MODEL,
    },
    message: { role: 'user', blocks: [{ text: { content: prompt } }] },
  };
}

/** 帧事件 → 统一的 Delta（content / reasoning / finish / error）。 */
export function parseEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.heartbeat !== undefined) return null;
  if (ev.done !== undefined) return { finish: 'stop' };
  if (ev.error) {
    const detail = ev.error.details && ev.error.details[0] && ev.error.details[0].debug;
    const msg =
      (detail && detail.localizedMessage && detail.localizedMessage.message) ||
      ev.error.message ||
      ev.error.code ||
      '未知错误';
    return { error: 'Kimi 拒绝了这次请求：' + msg };
  }
  const block = ev.block;
  if (block) {
    if (block.text && typeof block.text.content === 'string' && block.text.content) {
      return { content: block.text.content };
    }
    if (block.think && typeof block.think.content === 'string' && block.think.content) {
      return { reasoning: block.think.content };
    }
  }
  return null;
}

/** 用 refresh_token 换 access_token（带缓存）。 */
export async function refreshToken(refresh) {
  const now = Date.now();
  const hit = TOKEN_CACHE.get(refresh);
  if (hit && now - hit.at < TOKEN_TTL) return hit.access;
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: Object.assign(
      { 'content-type': 'application/json', accept: 'application/json', 'connect-protocol-version': '1' },
      mshHeaders(),
    ),
    body: JSON.stringify({ refresh_token: refresh }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('换 token 失败（HTTP ' + res.status + '）：' + text.slice(0, 200));
  }
  const inner = data && data.data;
  const access =
    (data && (data.accessToken || data.access_token || data.token)) ||
    (inner && (inner.accessToken || inner.access_token || inner.token));
  if (!access) {
    const detail =
      data && data.details && data.details[0] && data.details[0].debug && data.details[0].debug.localizedMessage;
    const msg = (detail && detail.message) || (data && data.message) || (data && data.code) || '未知错误';
    throw new Error('Kimi 拒绝了这个 refresh_token：' + msg);
  }
  TOKEN_CACHE.set(refresh, { access: access, at: now });
  return access;
}

/** 把上游的 Connect 帧流翻成 OpenAI chunk。 */
function streamChat(upstream, model) {
  const reader = upstream.body.getReader();
  const id = randomId('chatcmpl-');
  const enc = new TextEncoder();
  let buf = new Uint8Array(0);
  let finished = false;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (!finished) controller.enqueue(enc.encode(finishChunk(id, model, 'stop') + doneChunk()));
          controller.close();
          return;
        }
        const merged = new Uint8Array(buf.length + chunk.value.length);
        merged.set(buf, 0);
        merged.set(chunk.value, buf.length);
        const parsed = takeFrames(merged);
        buf = parsed[1];
        let out = '';
        parsed[0].forEach(function (ev) {
          const d = parseEvent(ev);
          if (!d) return;
          if (d.error) {
            out += errorChunk(d.error) + doneChunk();
            finished = true;
            return;
          }
          if (d.reasoning) out += deltaChunk(id, model, { reasoning_content: d.reasoning });
          if (d.content) out += deltaChunk(id, model, { content: d.content });
          if (d.finish) {
            out += finishChunk(id, model, d.finish) + doneChunk();
            finished = true;
          }
        });
        if (out) controller.enqueue(enc.encode(out));
      },
      cancel(reason) {
        reader.cancel(reason);
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } },
  );
}

export async function chat(request, env, tokens) {
  const token = (tokens || []).find(function (t) {
    return !!t;
  });
  if (!token) {
    return new Response(JSON.stringify({ error: { message: '还没有配置 Kimi 凭证：把 refresh_token 写进 KIMI_TOKENS' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: '请求体不是合法 JSON' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  const prompt = mergeMessages(body.messages);
  if (!prompt) {
    return new Response(JSON.stringify({ error: { message: '没有可发送的内容' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }
  let access;
  if (tokenKind(token) === 'access') {
    access = token;
  } else {
    try {
      access = await refreshToken(token);
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: e.message } }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  let upstream;
  try {
    upstream = await fetch(CHAT_URL, {
      method: 'POST',
      headers: Object.assign(
        {
          authorization: 'Bearer ' + access,
          'content-type': 'application/connect+json',
          accept: 'application/connect+json',
          'connect-protocol-version': '1',
        },
        mshHeaders(),
      ),
      body: encodeFrame(buildChatBody(prompt, !!body.thinking)),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: '连接 Kimi 失败：' + e.message } }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(function () {
      return '';
    });
    return new Response(
      JSON.stringify({
        error: { message: 'Kimi 返回 HTTP ' + upstream.status + '，多半是登录态失效或被风控拦下。' + text.slice(0, 300) },
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
  return streamChat(upstream, body.model || MODEL);
}

/** 只读配置，不联网（前端每次切站都会调）。 */
export function health(env) {
  const has = !!(env && env.KIMI_TOKENS);
  return { ok: has, site: 'kimi', kind: has ? 'ok' : 'no_token' };
}
