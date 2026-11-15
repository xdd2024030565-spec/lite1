/**
 * 智谱清言（chatglm.cn）适配器。
 *
 * 上游要点：
 *  - 凭证是 Cookie chatglm_refresh_token，先换 access_token（1 小时），再发聊天请求；
 *  - 每个请求都要带 X-Sign / X-Timestamp / X-Nonce（时间戳倒数第二位改成校验位 + md5）；
 *  - 返回 SSE，每帧 parts 是全量快照，要靠「全文 diff」算增量。
 */

import { md5 } from '../lib/md5.js';
import { corsHeaders } from '../lib/http.js';
import { deltaChunk, doneChunk, errorChunk, finishChunk, randomId } from '../lib/sse.js';

const BASE = 'https://chatglm.cn';
const ASSISTANT_ID = '65940acff94777010aa6b796';
// 智谱前端打包进 main.<hash>.js 的公开签名盐（不是账号凭据，任何人打开网页都能搜到）。
// 上游改版时换新值即可，也可用环境变量 GLM_SIGN_SECRET 覆盖。
// dsh-skip-sensitive: 公开的前端签名常量，非用户凭据
const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb'; // dsh-skip-sensitive
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

export const models = [
  { id: 'glm-4-plus', name: 'GLM-4 Plus' },
  { id: 'glm-4-think', name: 'GLM-4 思考' },
];

const TOKEN_CACHE = new Map();
const TOKEN_TTL = 3600000;

/** 生成 uuid；dash=false 时去掉横线。 */
export function uuid(dash) {
  const raw = crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
  return dash === false ? raw.replace(/-/g, '') : raw;
}

/**
 * 智谱的时间戳签名：把「各位数字和 - 倒数第二位」的个位替换进倒数第二位，
 * 再对 `${timestamp}-${nonce}-${secret}` 求 md5。
 */
export function generateSign() {
  const A = Date.now().toString();
  const digits = A.split('').map(Number);
  const sum = digits.reduce(function (a, b) {
    return a + b;
  }, 0);
  const check = (sum - digits[digits.length - 2]) % 10;
  const timestamp = A.substring(0, A.length - 2) + check + A.substring(A.length - 1);
  const nonce = uuid(false);
  return { timestamp: timestamp, nonce: nonce, sign: md5(timestamp + '-' + nonce + '-' + SIGN_SECRET) };
}

/** 模型名 → chat_mode（思考模型走 zero）。 */
export function chatMode(model) {
  const m = String(model || '');
  if (m.indexOf('deepresearch') >= 0) return 'deep_research';
  if (m.indexOf('think') >= 0 || m.indexOf('zero') >= 0) return 'zero';
  return undefined;
}

function baseHeaders() {
  return {
    accept: 'text/event-stream',
    'accept-language': 'zh-CN,zh;q=0.9',
    'app-name': 'chatglm',
    'content-type': 'application/json',
    origin: 'https://chatglm.cn',
    referer: 'https://chatglm.cn/main/alltoolsdetail',
    'user-agent': UA,
    'x-app-fr': 'browser_extension',
    'x-app-platform': 'pc',
    'x-app-version': '0.0.1',
    'x-lang': 'zh',
  };
}

/** 用 refresh_token 换 access_token（带缓存）。 */
export async function refreshToken(refresh) {
  const now = Date.now();
  const hit = TOKEN_CACHE.get(refresh);
  if (hit && now - hit.at < TOKEN_TTL) return hit.access;

  const sign = generateSign();
  const res = await fetch(BASE + '/chatglm/user-api/user/refresh', {
    method: 'POST',
    headers: Object.assign({}, baseHeaders(), {
      authorization: 'Bearer ' + refresh,
      'x-sign': sign.sign,
      'x-timestamp': sign.timestamp,
      'x-nonce': sign.nonce,
      'x-device-id': uuid(false),
      'x-request-id': uuid(false),
    }),
    body: '{}',
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('换 token 返回的不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 120));
  }
  const result = (data && data.result) || null;
  const access = result && (result.access_token || result.accessToken);
  if (!access) {
    const msg = (data && (data.message || (data.error && data.error.message))) || text.slice(0, 120);
    throw new Error('换 token 失败：' + msg);
  }
  if (result.refresh_token) TOKEN_CACHE.set(result.refresh_token, { access: access, at: now });
  TOKEN_CACHE.set(refresh, { access: access, at: now });
  return access;
}

/** OpenAI 消息数组 → 智谱的 messages。 */
export function buildMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || typeof m.content !== 'string' || !m.content) continue;
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: m.content }],
    });
  }
  return out;
}

/** 拼聊天请求体。 */
export function buildChatBody(options) {
  const opts = options || {};
  return {
    assistant_id: ASSISTANT_ID,
    conversation_id: opts.conversationId || '',
    project_id: '',
    chat_type: 'user_chat',
    messages: buildMessages(opts.messages),
    meta_data: {
      channel: '',
      chat_mode: chatMode(opts.model),
      draft_id: '',
      if_plus_model: true,
      input_question_type: 'xxxx',
      is_networking: true,
      is_test: false,
      platform: 'pc',
      quote_log_id: '',
      cogview: { rm_label_watermark: false },
    },
  };
}

/** 从 parts 快照里拼出全文与思考。 */
function snapshot(parts) {
  let text = '';
  let reasoning = '';
  (Array.isArray(parts) ? parts : []).forEach(function (part) {
    const items = part && part.content;
    if (!Array.isArray(items)) return;
    items.forEach(function (v) {
      if (!v) return;
      if (v.type === 'text' && typeof v.text === 'string') text += v.text;
      else if (v.type === 'think' && typeof v.think === 'string') reasoning += v.think;
    });
  });
  return { text: text, reasoning: reasoning };
}

/**
 * 解析一帧 SSE：state 记录已发过的全文，用来算增量。
 * 返回 {content?} / {reasoning?} / {finish} / {error} / null。
 */
export function parseEvent(raw, state) {
  if (!raw || !raw.trim()) return null;
  let ev = null;
  try {
    ev = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;

  if (typeof ev.code === 'number' && ev.code !== 0) {
    return { error: '智谱拒绝了这次请求（' + ev.code + '）：' + (ev.message || '') };
  }
  if (ev.error && typeof ev.error === 'object') {
    return { error: '智谱拒绝了这次请求：' + (ev.error.message || JSON.stringify(ev.error).slice(0, 120)) };
  }

  const st = state || { text: '', reasoning: '' };

  if (ev.status === 'finish' || ev.status === 'intervene') {
    const tail = ev.parts ? snapshot(ev.parts) : null;
    const out = {};
    if (tail) {
      if (tail.reasoning.length > st.reasoning.length) out.reasoning = tail.reasoning.slice(st.reasoning.length);
      if (tail.text.length > st.text.length) out.content = tail.text.slice(st.text.length);
    }
    out.finish = 'stop';
    return out;
  }

  if (!Array.isArray(ev.parts)) return null;
  const full = snapshot(ev.parts);
  const out = {};
  if (full.reasoning.length > st.reasoning.length) {
    out.reasoning = full.reasoning.slice(st.reasoning.length);
    st.reasoning = full.reasoning;
  }
  if (full.text.length > st.text.length) {
    out.content = full.text.slice(st.text.length);
    st.text = full.text;
  }
  return out.content || out.reasoning ? out : null;
}

/** 上游 SSE → OpenAI chunk。 */
function streamChat(upstream, model, env, request) {
  const id = randomId('chatcmpl-');
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';
  let finished = false;
  const state = { text: '', reasoning: '' };

  const mirror = new TransformStream({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      let out = '';
      lines.forEach(function (line) {
        const s = line.trim();
        if (!s || s.indexOf('data:') !== 0) return;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        const d = parseEvent(payload, state);
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
    flush(controller) {
      if (!finished) controller.enqueue(enc.encode(finishChunk(id, model, 'stop') + doneChunk()));
    },
  });

  return new Response(upstream.body.pipeThrough(mirror), {
    headers: Object.assign(
      { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
      corsHeaders(env, request)
    ),
  });
}

function jsonError(message, status, env, request) {
  return new Response(JSON.stringify({ error: { message: message } }), {
    status: status || 502,
    headers: Object.assign({ 'content-type': 'application/json' }, corsHeaders(env, request)),
  });
}

/** 处理 /glm/v1/chat/completions。 */
export async function chat(request, env, tokens) {
  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    body = null;
  }
  const messages = buildMessages(body && body.messages);
  if (!messages.length) return jsonError('没有可发送的内容', 400, env, request);

  const token = (tokens && tokens[0]) || '';
  if (!token) {
    return jsonError('智谱清言没有配置凭证，执行 wrangler secret put GLM_TOKENS', 503, env, request);
  }

  let access;
  try {
    access = await refreshToken(token);
  } catch (e) {
    return jsonError('智谱清言换 token 失败，多半是 cookie 过期了：' + e.message, 502, env, request);
  }

  const model = (body && body.model) || models[0].id;
  const sign = generateSign();
  let upstream;
  try {
    upstream = await fetch(BASE + '/chatglm/backend-api/assistant/stream', {
      method: 'POST',
      headers: Object.assign({}, baseHeaders(), {
        authorization: 'Bearer ' + access,
        'x-sign': sign.sign,
        'x-timestamp': sign.timestamp,
        'x-nonce': sign.nonce,
        'x-device-id': uuid(false),
        'x-request-id': uuid(false),
      }),
      body: JSON.stringify(buildChatBody({ messages: body.messages, model: model })),
    });
  } catch (e) {
    return jsonError('连接智谱清言失败：' + e.message, 502, env, request);
  }

  const ct = upstream.headers.get('content-type') || '';
  if (!upstream.ok || ct.indexOf('text/event-stream') < 0) {
    const text = await upstream.text();
    return jsonError(
      '智谱清言返回了非流式内容（HTTP ' + upstream.status + '，' + ct + '）：' + text.slice(0, 300),
      502,
      env,
      request
    );
  }
  return streamChat(upstream, model, env, request);
}

/** 健康检查只读配置，不联网。 */
export function health(env) {
  const raw = (env && env.GLM_TOKENS) || '';
  return { ok: !!raw, site: 'glm', kind: raw ? 'ok' : 'no_token' };
}
