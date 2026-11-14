/*
 * 通义千问（chat.qwen.ai 网页版）适配器。
 *
 * 凭证是网页端 localStorage 里的 token（JWT），用 Authorization: Bearer 发送。
 * 上游先建一个会话，再往这个会话里发一条消息，返回的是标准 SSE。
 *
 * 上游接口：
 *   POST https://chat.qwen.ai/api/v2/chats/new          建会话
 *   POST https://chat.qwen.ai/api/v2/chat/completions   发消息（?chat_id=）
 */

import { deltaChunk, finishChunk, doneChunk, errorChunk, randomId } from '../lib/sse.js';

const HOST = 'https://chat.qwen.ai';
const MODEL = 'qwen3.7-max';
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

export const models = [
  { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
];

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function baseHeaders(token) {
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: HOST,
    referer: HOST + '/',
    'user-agent': UA,
    'content-type': 'application/json',
    authorization: 'Bearer ' + token,
  };
}

/* 新建一个会话，返回会话 id。 */
export async function createChat(token, model) {
  const body = {
    title: '网页聊天',
    models: [model || MODEL],
    chat_mode: 'normal',
    chat_type: 't2t',
    timestamp: Date.now(),
  };
  const r = await fetch(HOST + '/api/v2/chats/new', {
    method: 'POST',
    headers: baseHeaders(token),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('建会话失败（HTTP ' + r.status + '）：' + text.slice(0, 200));
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('建会话返回的不是 JSON：' + text.slice(0, 200));
  }
  const id = data && data.data && data.data.id;
  if (!id) throw new Error('建会话没拿到 id：' + text.slice(0, 200));
  return id;
}

/*
 * 组装发消息的请求体。qwen 的字段比别家多，但都是固定值：
 * 一条 user 消息 + 增量输出开关。
 */
export function buildChatBody({ messages, model, chatId }) {
  const list = Array.isArray(messages) ? messages : [];
  const last = list.length ? list[list.length - 1] : { content: '' };
  const history = list.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));
  const now = Math.floor(Date.now() / 1000);
  const msg = {
    fid: uuid(),
    parentId: null,
    parent_id: null,
    role: 'user',
    content: String(last.content || ''),
    chat_type: 't2t',
    sub_chat_type: 't2t',
    timestamp: now,
    user_action: 'chat',
    models: [model || MODEL],
    files: [],
    childrenIds: [uuid()],
    extra: { meta: { subChatType: 't2t' } },
    feature_config: { thinking_enabled: false, output_schema: 'phase' },
  };
  return {
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: 'normal',
    messages: history.concat([msg]),
    model: model || MODEL,
    parent_id: null,
    timestamp: now,
  };
}

/* 把上游一帧 SSE 翻成 {content|reasoning|finish|error}。 */
export function parseEvent(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (s.indexOf('data:') === 0) s = s.slice(5).trim();
  if (!s || s === '[DONE]') return null;
  let chunk = null;
  try {
    chunk = JSON.parse(s);
  } catch (e) {
    return null;
  }
  if (!chunk || typeof chunk !== 'object') return null;
  if (chunk.code && chunk.code !== 'ok') {
    return { error: 'Qwen 拒绝了这次请求（' + chunk.code + '）：' + (chunk.detail || '无详情') };
  }
  if (chunk.error && !chunk.choices) {
    return { error: 'Qwen 返回错误：' + String(chunk.error.message || chunk.error).slice(0, 200) };
  }
  const choice = chunk.choices && chunk.choices[0];
  if (choice) {
    const d = choice.delta || {};
    if (d.reasoning_content) return { reasoning: String(d.reasoning_content) };
    if (d.content) return { content: String(d.content) };
    if (choice.finish_reason) return { finish: choice.finish_reason };
  }
  if (chunk['response.created']) return null;
  return null;
}

/*
 * 把上游 SSE 转成 OpenAI 格式。qwen 的流是标准 `data: {...}`，
 * 正文在 choices[0].delta.content。
 */
function streamChat(upstream, model) {
  const id = randomId();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let ended = false;

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
      };
      const handleLine = (line) => {
        const s = String(line || '').trim();
        if (!s) return;
        if (s === '[DONE]' || s.indexOf('[DONE]') >= 0) {
          finish();
          return;
        }
        const ev = parseEvent(s);
        if (!ev) return;
        if (ev.error) {
          fail(ev.error);
          return;
        }
        if (ev.reasoning) push(deltaChunk(id, model, { reasoning_content: ev.reasoning }));
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
        }).catch((e) => fail('读取 Qwen 响应失败：' + (e && e.message ? e.message : String(e))));
      };
      pump();
    },
  });
}

/*
 * 处理一次对话请求：建会话 → 发消息 → 转发 SSE。
 * 和别家一样，一次用户消息只打一次上游，失败不自动重试。
 */
export async function chat(request, env, tokens) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const token = tokens && tokens[0];
  if (!token) {
    return new Response(
      JSON.stringify({ error: { message: '还没有配置通义凭证：请在反代仓库 secret 里加 QWEN_TOKENS，或在前端设置里填 token' } }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
  }
  const model = body.model && models.some((m) => m.id === body.model) ? body.model : MODEL;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return new Response(JSON.stringify({ error: { message: '消息为空' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  let chatId = '';
  try {
    chatId = await createChat(token, model);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: '通义建会话失败：' + (e && e.message ? e.message : String(e)) } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  const payload = buildChatBody({ messages: messages, model: model, chatId: chatId });
  let upstream = null;
  try {
    upstream = await fetch(HOST + '/api/v2/chat/completions?chat_id=' + encodeURIComponent(chatId), {
      method: 'POST',
      headers: baseHeaders(token),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: '连接通义失败：' + (e && e.message ? e.message : String(e)) } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(
      JSON.stringify({
        error: {
          message:
            '通义返回 HTTP ' + upstream.status + '，多半是 token 失效或被风控拦下。' + text.slice(0, 300),
        },
      }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('text/event-stream') < 0) {
    const text = await upstream.text();
    return new Response(
      JSON.stringify({ error: { message: '通义没有返回流式内容：' + text.slice(0, 300) } }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(streamChat(upstream, model), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/* 只读配置，不联网（前端切站就会调一次，避免打扰上游）。 */
export function health(env) {
  const list = String((env && env.QWEN_TOKENS) || '')
    .split(',')
    .filter(Boolean);
  return { ok: list.length > 0, site: 'qwen', kind: list.length ? 'ok' : 'no_token' };
}
