/*
 * Grok（grok.com 网页版）适配器。
 *
 * 凭证就是浏览器里 grok.com 的 sso cookie。免费额度有限：
 * 每条用户消息只打一次上游，失败也不自动重试，避免触发风控。
 *
 * 上游接口：POST https://grok.com/rest/app-chat/conversations/new
 * 返回逐行 JSON（NDJSON），正文在 result.response.token 里。
 */

import { jsonResp, corsHeaders } from '../lib/http.js';
import { deltaChunk, finishChunk, doneChunk, errorChunk, randomId } from '../lib/sse.js';

const HOST = 'https://grok.com';
const MODEL = 'grok-3';
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

// x-statsig-id 由网页端 statsig SDK 生成，这里给固定值；
// 被上游拒绝时可用 secret GROK_STATSIG_ID 覆盖。
const DEFAULT_STATSIG = 'ZTp0eXBlOmZlYXR1cmVfZ2F0ZTpzdGF0c2lnX2lkLGtleTphYmMxMjM';

export const models = [{ id: MODEL, name: 'Grok 3' }];

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) out += hex.charAt(Math.floor(Math.random() * 16));
  return (
    out.slice(0, 8) + '-' + out.slice(8, 12) + '-' + out.slice(12, 16) + '-' +
    out.slice(16, 20) + '-' + out.slice(20)
  );
}

/*
 * 把 OpenAI 消息数组压成一段对话文本。
 * Grok 单轮接口只认一段文本，多轮上下文由这里自己拼。
 */
export function mergeMessages(messages) {
  const list = messages || [];
  if (!list.length) return '';
  if (list.length === 1) return String(list[0].content || '');
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    parts.push('[' + role + '] ' + String(m.content || ''));
  }
  return parts.join('\n\n');
}

/*
 * 组装上游请求。opts: { token, text, model, statsig }
 * 返回 { url, init }，init 可直接喂给 fetch。
 */
export function buildChatRequest(opts) {
  const o = opts || {};
  const model = o.model && /^grok-/.test(o.model) ? o.model : MODEL;
  const body = {
    temporary: true,
    modelName: model,
    message: String(o.text || ''),
    fileAttachments: [],
    imageAttachments: [],
    disableMemory: true,
    disableSearch: false,
    disableThinking: false,
    isAsyncChat: false,
  };
  const headers = {
    'content-type': 'application/json',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: HOST,
    referer: HOST + '/',
    'user-agent': UA,
    'x-statsig-id': o.statsig || DEFAULT_STATSIG,
    'x-xai-request-id': uuid(),
    cookie: 'sso=' + String(o.token || ''),
  };
  return {
    url: HOST + '/rest/app-chat/conversations/new',
    init: { method: 'POST', headers: headers, body: JSON.stringify(body) },
  };
}

/*
 * 解析上游一行。返回 { content?, reasoning?, finish?, error? } 或 null。
 */
export function parseEvent(raw) {
  let ev;
  try {
    ev = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;

  if (ev.error) {
    return { error: 'Grok 拒绝了这次请求：' + String(ev.error.message || ev.error) };
  }

  const result = ev.result || ev;
  if (result.error) {
    return { error: 'Grok 拒绝了这次请求：' + String(result.error.message || result.error) };
  }

  // OpenAI 兼容形态（上游换实现时兜底）
  if (ev.choices && ev.choices.length) {
    const d = ev.choices[0] || {};
    const delta = d.delta || {};
    const out = {};
    if (delta.content) out.content = delta.content;
    if (delta.reasoning_content) out.reasoning = delta.reasoning_content;
    if (d.finish_reason) out.finish = d.finish_reason;
    return out.content || out.reasoning || out.finish ? out : null;
  }

  const resp = result.response;
  if (resp) {
    if (resp.error) return { error: 'Grok 拒绝了这次请求：' + String(resp.error.message || resp.error) };
    if (resp.isFinal === true || (resp.finalMetadata && resp.finalMetadata.isFinal === true)) {
      return { finish: 'stop' };
    }
    const tok = resp.token;
    if (typeof tok === 'string' && tok) {
      return resp.isThinking ? { reasoning: tok } : { content: tok };
    }
    if (typeof resp.message === 'string' && resp.message) return { content: resp.message };
    return null;
  }

  return null;
}

/*
 * 上游是逐行 JSON（不是 data: 前缀的 SSE），这里按行解析后翻成 OpenAI chunk。
 */
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
        let s = String(line || '').trim();
        if (!s) return;
        if (s.indexOf('data:') === 0) s = s.slice(5).trim();
        if (!s || s === '[DONE]') return;
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
          message: '未配置 Grok 凭证。执行 wrangler secret put GROK_TOKENS，或在设置里填 grok.com 登录 Cookie 里的 sso。',
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
  const req = buildChatRequest({
    token: token,
    text: text,
    model: body.model,
    statsig: env && env.GROK_STATSIG_ID,
  });
  let upstream;
  try {
    upstream = await fetch(req.url, req.init);
  } catch (e) {
    return jsonResp(
      { error: { message: '连接 Grok 失败：' + (e && e.message ? e.message : e), type: 'upstream' } },
      502,
      env,
      request
    );
  }
  if (!upstream.ok) {
    let snippet = '';
    try {
      snippet = (await upstream.text()).slice(0, 300);
    } catch (e) {
      /* 忽略 */
    }
    return jsonResp(
      {
        error: {
          message:
            'Grok 返回 HTTP ' + upstream.status +
            '，多半是 sso 失效或被风控拦下。' + snippet,
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

/*
 * 健康检查只汇报「配置里有没有凭证」，不打上游。
 * 前端每次切站都会调它，联网会白白给账号攒请求。
 */
export function health(env) {
  const has = !!(env && env.GROK_TOKENS);
  return { ok: has, site: 'grok', kind: has ? 'ok' : 'no_token' };
}

/*
 * 临时诊断：用调用方自己带来的 sso 去问 grok.com 的只读接口，
 * 帮助定位模型名与请求形状；不触发生成、不消耗额度。确认后删除。
 */
function probeHeaders(token) {
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: HOST,
    referer: HOST + '/',
    'user-agent': UA,
    'x-statsig-id': DEFAULT_STATSIG,
    'x-xai-request-id': uuid(),
    cookie: 'sso=' + token,
  };
}

export async function probe(token, opt) {
  if (!token) return { error: '需要在请求头带 Authorization: Bearer <grok sso>' };
  const o = opt || {};
  const one = async function (method, path, body) {
    const headers = probeHeaders(token);
    if (body) headers['content-type'] = 'application/json';
    try {
      const r = await fetch(HOST + path, {
        method: method,
        headers: headers,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      let text = '';
      try {
        text = await r.text();
      } catch (e) {
        text = '';
      }
      return { path: path, method: method, status: r.status, contentType: r.headers.get('content-type'), text: text.slice(0, 1200), length: text.length };
    } catch (e) {
      return { path: path, method: method, error: String(e && e.message ? e.message : e).slice(0, 200) };
    }
  };
  if (o.path) {
    const method = (o.method || 'GET').toUpperCase();
    return { probed: [await one(method, o.path, o.body)] };
  }
  const list = [
    ['GET', '/rest/models'],
    ['POST', '/rest/models', '{}'],
    ['POST', '/config', '{}'],
    ['GET', '/rest/config'],
    ['POST', '/rest/app-chat/conversations', { pageSize: 0 }],
  ];
  const out = [];
  for (let i = 0; i < list.length; i++) out.push(await one(list[i][0], list[i][1], list[i][2]));
  return { probed: out };
}
