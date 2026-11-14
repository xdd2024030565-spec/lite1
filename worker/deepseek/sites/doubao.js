/*
 * 豆包站点适配器。
 *
 * 上游是网页版 SAMANTHA 流式接口，这里把它翻译成 OpenAI chunk 格式，
 * 与 DeepSeek 站点共用同一套前端。
 *
 * 凭证：Cookie 里的 sessionid（网页版登录态）。
 * 注意：这里刻意不加 msToken / a_bogus 签名 —— 实测签名参数反而更容易被风控拒绝。
 */

import { jsonResp, corsHeaders } from '../lib/http.js';
import { deltaChunk, finishChunk, doneChunk, errorChunk, randomId } from '../lib/sse.js';

const ORIGIN = 'https://www.doubao.com';
const CHAT_PATH = '/samantha/chat/completion';
const AID = '497858';
const MODEL = 'doubao-chat';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

export const models = [{ id: MODEL, name: '豆包' }];

const digits = (n) => {
  let s = '';
  while (s.length < n) s += String(Math.floor(Math.random() * 10));
  return s;
};

const uuid = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// 页面设备指纹：一个 Worker 实例内固定，避免每次请求都换设备被判异常
const DEVICE = { deviceId: '7' + digits(18), webId: '7' + digits(18) };

export function buildChatRequest(opts) {
  const o = opts || {};
  const params = new URLSearchParams({
    aid: AID,
    device_id: DEVICE.deviceId,
    device_platform: 'web',
    language: 'zh',
    pc_version: '2.44.0',
    pkg_type: 'release_version',
    real_aid: AID,
    region: 'CN',
    samantha_web: '1',
    sys_region: 'CN',
    tea_uuid: DEVICE.webId,
    'use-olympus-account': '1',
    version_code: '20800',
    web_id: DEVICE.webId,
    web_tab_id: uuid(),
  });
  const body = {
    messages: [{ content: JSON.stringify({ text: o.text || '' }), content_type: 2001, attachments: [], references: [] }],
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: true,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      message_from: 0,
      action_bar_skill_id: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
      event_id: '0',
    },
    evaluate_option: { web_ab_params: '' },
    section_id: '26' + digits(16),
    conversation_id: '0',
    local_conversation_id: 'local_16' + digits(14),
    local_message_id: uuid(),
  };
  const trace = uuid();
  return {
    url: ORIGIN + CHAT_PATH + '?' + params.toString(),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': UA,
        Origin: ORIGIN,
        Referer: ORIGIN + '/chat/',
        'agw-js-conv': 'str, str',
        'X-Flow-Trace': '04-' + trace + '-' + trace.replace(/-/g, '').slice(0, 16) + '-01',
        Cookie: 'sessionid=' + (o.token || '') + '; sessionid_ss=' + (o.token || ''),
      },
      body: JSON.stringify(body),
    },
  };
}

/*
 * 把 OpenAI 风格的多轮 messages 压成豆包要的单条文本。
 * 豆包网页端只认一条 user 消息，多轮要靠 <|im_start|> 标记自己拼。
 */
export function mergeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length < 2) {
    return list
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
      .trim();
  }
  let out = '';
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    const text = typeof m.content === 'string' ? m.content : '';
    out += '<|im_start|>' + role + '\n' + text + '\n<|im_end|>\n';
  }
  return out.trim();
}

/*
 * 解析一条 SSE data 负载。
 * 返回 {content} / {finish} / {error} / null（无关事件）。
 */
export function parseEvent(raw) {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch (e) {
    return { error: '上游返回了无法解析的事件' };
  }
  if (ev && ev.code) {
    return { error: '豆包拒绝了这次请求（' + ev.code + (ev.message ? '：' + ev.message : '') + '）' };
  }
  if (ev.event_type === 2003) return { finish: 'stop' };
  if (ev.event_type !== 2001) return null;

  let data;
  try {
    data = JSON.parse(ev.event_data);
  } catch (e) {
    return { error: '上游事件内容不是合法 JSON' };
  }
  if (data && data.is_finish) return { finish: 'stop' };

  const msg = data && data.message;
  if (!msg || !msg.content) return null;
  if (msg.content_type === 2074) return null; // 图片生成事件，P1 不渲染

  let text = '';
  let parsed = null;
  try {
    parsed = JSON.parse(msg.content);
  } catch (e) {
    parsed = null;
  }
  if (typeof parsed === 'string') {
    text = parsed;
  } else if (parsed && typeof parsed === 'object') {
    if (typeof parsed.text === 'string') text = parsed.text;
    else if (parsed.delta && typeof parsed.delta.text === 'string') text = parsed.delta.text;
    else if (typeof parsed.content === 'string') text = parsed.content;
  } else if (typeof msg.content === 'string') {
    text = msg.content;
  }
  return text ? { content: text } : null;
}

async function streamChat(upstream, model) {
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
        if (!s || s.indexOf('data:') !== 0) return;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          finish();
          return;
        }
        const ev = parseEvent(payload);
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
          const parts = buf.split('\n');
          buf = parts.pop();
          for (let i = 0; i < parts.length && !ended; i++) handleLine(parts[i]);
          if (!ended) pump();
        }).catch((e) => fail('读取上游流失败：' + (e && e.message ? e.message : e)));
      };
      pump();
    },
    cancel() {
      ended = true;
      try {
        reader.cancel();
      } catch (e) {
        /* 忽略 */
      }
    },
  });
}

export async function chat(request, env, tokens, url) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ error: { message: '请求体不是合法 JSON', type: 'invalid_request' } }, 400, env, request);
  }
  const token = (tokens || [])[0];
  if (!token) {
    return jsonResp(
      {
        error: {
          message: '未配置豆包 sessionid。执行 wrangler secret put DOUBAO_TOKENS，或在设置里填豆包登录 Cookie 里的 sessionid。',
          type: 'config',
        },
      },
      503,
      env,
      request
    );
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = mergeMessages(messages);
  if (!text) {
    return jsonResp({ error: { message: '消息为空', type: 'invalid_request' } }, 400, env, request);
  }
  const req = buildChatRequest({ token: token, text: text });
  let upstream;
  try {
    upstream = await fetch(req.url, req.init);
  } catch (e) {
    return jsonResp(
      { error: { message: '连接豆包失败：' + (e && e.message ? e.message : e), type: 'upstream' } },
      502,
      env,
      request
    );
  }
  const ct = upstream.headers.get('content-type') || '';
  if (!/text\/event-stream/i.test(ct)) {
    let snippet = '';
    try {
      snippet = (await upstream.text()).slice(0, 200);
    } catch (e) {
      /* 忽略 */
    }
    return jsonResp(
      {
        error: {
          message: '豆包没有返回流式内容（' + (ct || '无 Content-Type') + '），多半是 sessionid 失效或触发风控。' + snippet,
          type: 'upstream',
        },
      },
      502,
      env,
      request
    );
  }
  const stream = await streamChat(upstream, body.model || MODEL);
  return new Response(stream, {
    status: 200,
    headers: Object.assign(
      { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
      corsHeaders(env, request)
    ),
  });
}

/* 校验 sessionid 是否还有效 */
export async function tokenCheck(token) {
  if (!token) return false;
  try {
    const res = await fetch(ORIGIN + '/passport/account/info/v2?account_sdk_source=web', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
        Origin: ORIGIN,
        Referer: ORIGIN + '/chat/',
        Cookie: 'sessionid=' + token + '; sessionid_ss=' + token,
      },
      body: '{}',
    });
    const data = await res.json();
    return !!(data && (data.user_id || (data.data && data.data.user_id)));
  } catch (e) {
    return false;
  }
}
