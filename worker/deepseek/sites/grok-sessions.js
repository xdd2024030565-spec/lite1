/*
 * Grok（grok.com 网页版）只读接口：对话列表与历史消息。
 *
 * 与 grok.js 分开的原因：chat 那部分是「发消息」，这里是「读列表 / 读历史」，
 * 两者共用 sso cookie 但请求头、失败处理、返回结构都完全不同；
 * 分开也让每个文件都留在可读的长度内。
 *
 * 上游取历史分两步（Grok 没有一次性给全部消息的接口）：
 *   1. GET  /rest/app-chat/conversations/{id}/response-node?includeThreads=true
 *      → 只有 responseId 与 sender 的骨架，用来定顺序
 *   2. POST /rest/app-chat/conversations/{id}/load-responses  body {"responseIds":[...]}
 *      → 正文与思考过程
 *
 * 免费额度有限：读接口失败一律不重试，降级成空列表/空消息返回。
 */

import { jsonResp } from '../lib/http.js';

const HOST = 'https://grok.com';
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';
// load-responses 单个请求最多带多少个 responseId（第三方导出脚本普遍按 50 一批）
const BATCH = 50;

// 与 grok.js 的聊天请求保持同一套指纹头，避免读接口被单独风控；
// 聊天被拒时用户会用 secret GROK_STATSIG_ID 换一个有效值，读接口必须跟着换
const DEFAULT_STATSIG = 'ZTp0eXBlOmZlYXR1cmVfZ2F0ZTpzdGF0c2lnX2lkLGtleTphYmMxMjM';

function statsigId(env) {
  const v = env && env.GROK_STATSIG_ID;
  return v ? String(v) : DEFAULT_STATSIG;
}

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

/* 只读接口共用的请求头：读 JSON 比读 NDJSON 更容易判断失败 */
function apiHeaders(token, env) {
  return {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: HOST,
    referer: HOST + '/',
    'user-agent': UA,
    'content-type': 'application/json',
    'x-statsig-id': statsigId(env),
    'x-xai-request-id': uuid(),
    cookie: 'sso=' + String(token || ''),
  };
}

function pick(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj && obj[keys[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/*
 * 从列表响应里挑出对话数组。
 * grok.com 的返回结构换过几轮（camelCase REST 与导出脚本的 snake_case 并存），
 * 按候选顺序找，找不到返回空数组，不抛错。
 */
export function parseConversations(data) {
  if (Array.isArray(data)) return data;
  const d = data || {};
  const cands = [
    d.conversations,
    d.items,
    d.data && d.data.conversations,
    d.data && d.data.items,
    d.data,
    d.result && d.result.conversations,
    d.result && d.result.items,
    d.results,
  ];
  for (let i = 0; i < cands.length; i++) {
    if (Array.isArray(cands[i])) return cands[i];
  }
  return [];
}

/* 统一成前端要的 { id, title, pinned, updated_at, tagged } */
export function normalizeSessions(list, max) {
  const out = [];
  const arr = list || [];
  const limit = max > 0 ? max : 50;
  for (let i = 0; i < arr.length && out.length < limit; i++) {
    const it = arr[i];
    if (!it || typeof it !== 'object') continue;
    const id = pick(it, ['conversationId', 'conversation_id', 'id', 'uuid']);
    if (!id) continue;
    const title = pick(it, ['title', 'name', 'displayTitle', 'display_title']);
    const updated = pick(it, ['updateTime', 'update_time', 'updatedAt', 'updated_at', 'createdAt', 'createTime']);
    const ts = typeof updated === 'number' ? updated : Date.parse(updated || '') || 0;
    out.push({
      id: String(id),
      title: title ? String(title) : '(无标题)',
      pinned: !!pick(it, ['pinned', 'isPinned', 'is_pinned']),
      updated_at: ts,
      tagged: false,
    });
  }
  return out;
}

/*
 * 列出网页版对话。
 * 返回 kind 便于路由层分档：ok / no_token / expired / network / http_xxx / bad_json。
 */
export async function listConversations(token, pageSize, env) {
  if (!token) return { ok: false, kind: 'no_token', list: [] };
  const size = pageSize > 0 ? pageSize : 50;
  const url =
    HOST + '/rest/app-chat/conversations?pageSize=' + encodeURIComponent(String(size)) +
    '&orderBy=LAST_UPDATE';
  let r;
  try {
    r = await fetch(url, { method: 'GET', headers: apiHeaders(token, env) });
  } catch (e) {
    return { ok: false, kind: 'network', error: e && e.message ? e.message : String(e), list: [] };
  }
  if (!r.ok) {
    return {
      ok: false,
      kind: r.status === 401 || r.status === 403 ? 'expired' : 'http_' + r.status,
      list: [],
    };
  }
  let data;
  try {
    data = await r.json();
  } catch (e) {
    return { ok: false, kind: 'bad_json', list: [] };
  }
  return { ok: true, kind: 'ok', list: normalizeSessions(parseConversations(data), size) };
}

/* 取会话骨架：只有 responseId 与 sender，没有正文 */
export async function listResponseNodes(token, conversationId, env) {
  if (!token || !conversationId) return { ok: false, kind: 'bad_request', nodes: [] };
  const url =
    HOST + '/rest/app-chat/conversations/' + encodeURIComponent(conversationId) +
    '/response-node?includeThreads=true';
  let r;
  try {
    r = await fetch(url, { method: 'GET', headers: apiHeaders(token, env) });
  } catch (e) {
    return { ok: false, kind: 'network', error: e && e.message ? e.message : String(e), nodes: [] };
  }
  if (!r.ok) {
    return { ok: false, kind: r.status === 401 || r.status === 403 ? 'expired' : 'http_' + r.status, nodes: [] };
  }
  let data;
  try {
    data = await r.json();
  } catch (e) {
    return { ok: false, kind: 'bad_json', nodes: [] };
  }
  const raw = Array.isArray(data && data.responseNodes)
    ? data.responseNodes
    : parseConversations(data);
  const nodes = [];
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    if (!n || typeof n !== 'object') continue;
    const responseId = pick(n, ['responseId', 'response_id', 'id']);
    if (!responseId) continue;
    nodes.push({
      responseId: String(responseId),
      sender: String(pick(n, ['sender', 'role']) || '').toLowerCase(),
      parentResponseId: pick(n, ['parentResponseId', 'parent_response_id']) || null,
    });
  }
  const inflight = !!(data && Array.isArray(data.inflightResponses) && data.inflightResponses.length > 0);
  return { ok: true, kind: 'ok', nodes: nodes, inflight: inflight };
}

/* 按 responseIds 批量取正文 */
export async function loadResponses(token, conversationId, responseIds, env) {
  const ids = (responseIds || []).filter(Boolean);
  if (!token || !conversationId || !ids.length) return { ok: false, kind: 'bad_request', list: [] };
  const url =
    HOST + '/rest/app-chat/conversations/' + encodeURIComponent(conversationId) + '/load-responses';
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: apiHeaders(token, env),
      body: JSON.stringify({ responseIds: ids }),
    });
  } catch (e) {
    return { ok: false, kind: 'network', error: e && e.message ? e.message : String(e), list: [] };
  }
  if (!r.ok) {
    return { ok: false, kind: r.status === 401 || r.status === 403 ? 'expired' : 'http_' + r.status, list: [] };
  }
  let data;
  try {
    data = await r.json();
  } catch (e) {
    return { ok: false, kind: 'bad_json', list: [] };
  }
  const arr = Array.isArray(data && data.responses) ? data.responses : [];
  return { ok: true, kind: 'ok', list: arr };
}

/*
 * 抽出正文与思考过程。
 * 正文统一在 message 字段；思考过程在不同版本里叫 thinking_trace /
 * agent_thinking_traces[].thinking_trace，取不到就当没有，不报错。
 */
export function extractText(item) {
  const it = item || {};
  const text = pick(it, ['message', 'content', 'text', 'response']) || '';
  let reasoning = pick(it, ['thinking_trace', 'thinkingTrace', 'reasoning']) || '';
  if (!reasoning && Array.isArray(it.agent_thinking_traces)) {
    const parts = [];
    for (let i = 0; i < it.agent_thinking_traces.length; i++) {
      const tr = it.agent_thinking_traces[i];
      const t = pick(tr || {}, ['thinking_trace', 'thinkingTrace', 'content']);
      if (t) parts.push(String(t));
    }
    reasoning = parts.join('\n');
  }
  return { text: typeof text === 'string' ? text : '', reasoning: String(reasoning || '') };
}

/* 把上游 response 数组翻成前端要的 { role, content, reasoning }，并排回骨架顺序 */
export function normalizeMessages(responses, nodes, limit) {
  const byId = {};
  const nodeList = nodes || [];
  for (let i = 0; i < nodeList.length; i++) byId[nodeList[i].responseId] = nodeList[i];
  const items = [];
  const list = responses || [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || typeof it !== 'object') continue;
    const rid = String(pick(it, ['responseId', 'response_id', 'id']) || '');
    const node = byId[rid] || {};
    const sender = String(pick(it, ['sender', 'role']) || node.sender || '').toLowerCase();
    const role = sender === 'human' || sender === 'user' ? 'user' : 'assistant';
    const ex = extractText(it);
    if (!ex.text && !ex.reasoning) continue;
    items.push({ rid: rid, role: role, content: ex.text, reasoning: ex.reasoning || undefined });
  }
  // 上游不保证顺序，按骨架顺序排回去；骨架里没有的保持原序垫后
  const order = {};
  for (let i = 0; i < nodeList.length; i++) order[nodeList[i].responseId] = i;
  items.sort(function (a, b) {
    const ai = order[a.rid] === undefined ? 1e9 : order[a.rid];
    const bi = order[b.rid] === undefined ? 1e9 : order[b.rid];
    return ai - bi;
  });
  const out = items.map(function (m) {
    return { role: m.role, content: m.content, reasoning: m.reasoning };
  });
  const max = limit > 0 ? limit : 5;
  return out.length > max ? out.slice(out.length - max) : out;
}

/* 两步取数的整合入口，供路由层一句调用 */
export async function sessionMessages(token, conversationId, limit, env) {
  const max = limit > 0 ? limit : 5;
  const nodesRes = await listResponseNodes(token, conversationId, env);
  if (!nodesRes.ok) {
    return { ok: false, kind: nodesRes.kind || 'failed', messages: [] };
  }
  const nodes = nodesRes.nodes || [];
  if (!nodes.length) return { ok: true, kind: 'empty', messages: [] };
  /*
   * Grok 没有服务端 limit 参数，只取尾部：少要一条就少一分风控风险。
   * includeThreads 会把 thread 节点也塞进骨架，多留一倍余量，保证正文被稀释后
   * 仍够 limit 条。id 太多时下面按 BATCH 分批，不一次把几百个 id 塞进一个请求。
   */
  const take = Math.min(nodes.length, Math.max(max * 4, 40));
  const ids = nodes.slice(nodes.length - take).map(function (n) { return n.responseId; });
  const list = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const res = await loadResponses(token, conversationId, ids.slice(i, i + BATCH), env);
    if (!res.ok) return { ok: false, kind: res.kind || 'failed', messages: [] };
    for (let j = 0; j < res.list.length; j++) list.push(res.list[j]);
  }
  return { ok: true, kind: 'ok', messages: normalizeMessages(list, nodes, max) };
}

/*
 * 路由层的两个入口。
 * 凭证从调用方传入（路由层已经从 env 拆好），这里只负责查询参数解析与状态码映射。
 */
export async function sessionsResponse(tokens, env, request, url) {
  if (!tokens || !tokens.length) {
    return jsonResp({ error: { message: '未配置 Grok 凭证' } }, 503, env, request);
  }
  const q = parseInt((url && url.searchParams.get('limit')) || '50', 10);
  const size = isNaN(q) || q <= 0 ? 50 : Math.min(q, 100);
  try {
    const res = await listConversations(tokens[0], size, env);
    if (!res.ok) {
      if (res.kind === 'expired') {
        return jsonResp({ error: { message: 'Grok 凭证已失效，请重新登录后更新 sso cookie' } }, 401, env, request);
      }
      /*
       * 不能把失败伪装成空列表：那样前端会显示「网页版里还没有对话」，
       * 用户没法区分「真没有」「额度用完」「被风控」。这里回非 2xx，
       * 前端 remote.js 的 HTTP 分支会显示「读取失败 + 重试」。
       */
      return jsonResp(
        { error: { message: '拉取会话列表失败: ' + (res.kind || 'upstream') }, kind: res.kind || 'failed' },
        502, env, request
      );
    }
    return jsonResp({ object: 'list', data: res.list || [] }, 200, env, request);
  } catch (e) {
    return jsonResp({ error: { message: '拉取会话失败: ' + (e && e.message ? e.message : e) } }, 502, env, request);
  }
}

export async function messagesResponse(tokens, env, request, url) {
  if (!tokens || !tokens.length) {
    return jsonResp({ error: { message: '未配置 Grok 凭证' } }, 503, env, request);
  }
  const sid = (url && url.searchParams.get('id')) || '';
  if (!sid) return jsonResp({ error: { message: '缺少 id' } }, 400, env, request);
  let limit = parseInt((url && url.searchParams.get('limit')) || '5', 10);
  if (isNaN(limit) || limit <= 0) limit = 5;
  if (limit > 200) limit = 200;
  try {
    const res = await sessionMessages(tokens[0], sid, limit, env);
    if (!res.ok) {
      const code = res.kind === 'expired' ? 401 : 502;
      return jsonResp({ error: { message: '读取会话失败: ' + (res.kind || res.error || 'upstream') } }, code, env, request);
    }
    return jsonResp({ id: sid, messages: { count: res.messages.length, messages: res.messages } }, 200, env, request);
  } catch (e) {
    return jsonResp({ error: { message: '读取会话失败: ' + (e && e.message ? e.message : e) } }, 502, env, request);
  }
}
