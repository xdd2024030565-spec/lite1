import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConversations,
  normalizeSessions,
  normalizeMessages,
  extractText,
  listConversations,
  listResponseNodes,
  loadResponses,
  sessionMessages,
} from '../sites/grok-sessions.js';

/* 用一次性 stub 顶掉全局 fetch，记录调用参数供断言 */
function stubFetch(handler) {
  const calls = [];
  const origin = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    calls.push({ url: String(url), init: init || {} });
    return handler(String(url), init || {}, calls.length - 1);
  };
  return {
    calls,
    restore() { globalThis.fetch = origin; },
  };
}

function jsonRes(obj, status) {
  return {
    ok: (status || 200) >= 200 && (status || 200) < 300,
    status: status || 200,
    json: async () => obj,
  };
}

test('列表响应认 conversations 字段', () => {
  const list = parseConversations({ conversations: [{ conversationId: 'c1' }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, 'c1');
});

test('列表响应认 data.items 与直接数组', () => {
  assert.equal(parseConversations({ data: { items: [{ id: 'a' }] } })[0].id, 'a');
  assert.equal(parseConversations([{ id: 'b' }])[0].id, 'b');
});

test('拿不到数组时返回空数组而不是抛错', () => {
  assert.deepEqual(parseConversations({ whatever: 1 }), []);
  assert.deepEqual(parseConversations(null), []);
});

test('会话归一化：补标题、时间戳、标记位', () => {
  const out = normalizeSessions([
    { conversationId: 'c1', title: '问天气', updateTime: '2026-01-02T03:04:05Z' },
    { id: 'c2' },
    { title: '没有 id 的丢掉' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'c1');
  assert.equal(out[0].title, '问天气');
  assert.equal(out[0].updated_at, Date.parse('2026-01-02T03:04:05Z'));
  assert.equal(out[0].pinned, false);
  assert.equal(out[0].tagged, false);
  assert.equal(out[1].title, '(无标题)');
});

test('会话归一化按上限截断', () => {
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ id: 'c' + i });
  assert.equal(normalizeSessions(many, 3).length, 3);
});

test('norm 数值型 updateTime 直接当时间戳用', () => {
  const out = normalizeSessions([{ id: 'x', updateTime: 1795230743.789 }]);
  assert.equal(out[0].updated_at, 1795230743.789);
});

test('正文取 message，思考取 thinking_trace', () => {
  const ex = extractText({ message: '答案', thinking_trace: '推理' });
  assert.equal(ex.text, '答案');
  assert.equal(ex.reasoning, '推理');
});

test('思考过程也能从 agent_thinking_traces 拼出来', () => {
  const ex = extractText({
    message: '答案',
    agent_thinking_traces: [{ thinking_trace: '第一段' }, { thinking_trace: '第二段' }],
  });
  assert.equal(ex.reasoning, '第一段\n第二段');
});

test('没有正文也没有思考的条目被跳过', () => {
  const nodes = [
    { responseId: 'r1', sender: 'human' },
    { responseId: 'r2', sender: 'assistant' },
  ];
  const out = normalizeMessages(
    [
      { responseId: 'r1', sender: 'human', message: '问题' },
      { responseId: 'r2', sender: 'assistant' },
    ],
    nodes,
    10
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { role: 'user', content: '问题', reasoning: undefined });
});

test('消息按骨架顺序排回去，不受上游返回顺序影响', () => {
  const nodes = [
    { responseId: 'r1', sender: 'human' },
    { responseId: 'r2', sender: 'assistant' },
    { responseId: 'r3', sender: 'human' },
  ];
  const out = normalizeMessages(
    [
      { responseId: 'r3', sender: 'human', message: '第二问' },
      { responseId: 'r1', sender: 'human', message: '第一问' },
      { responseId: 'r2', sender: 'assistant', message: '第一答' },
    ],
    nodes,
    10
  );
  assert.deepEqual(out.map(function (m) { return m.content; }), ['第一问', '第一答', '第二问']);
});

test('超出 limit 时只保留最近若干条', () => {
  const nodes = [];
  const resp = [];
  for (let i = 0; i < 6; i++) {
    nodes.push({ responseId: 'r' + i, sender: 'human' });
    resp.push({ responseId: 'r' + i, sender: 'human', message: 'm' + i });
  }
  const out = normalizeMessages(resp, nodes, 2);
  assert.deepEqual(out.map(function (m) { return m.content; }), ['m4', 'm5']);
});

test('没有凭证时列表直接返回 no_token，不发请求', async () => {
  const s = stubFetch(function () { throw new Error('不应该发请求'); });
  try {
    const r = await listConversations('', 10);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'no_token');
    assert.deepEqual(r.list, []);
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test('列表请求带 pageSize 与 sso cookie', async () => {
  const s = stubFetch(function () {
    return jsonRes({ conversations: [{ conversationId: 'c1', title: 'T' }] });
  });
  try {
    const r = await listConversations('tok-9', 20);
    assert.equal(r.ok, true);
    assert.equal(r.list.length, 1);
    assert.equal(r.list[0].id, 'c1');
    assert.match(s.calls[0].url, /\/rest\/app-chat\/conversations\?pageSize=20/);
    assert.equal(s.calls[0].init.headers.cookie, 'sso=tok-9');
    assert.equal(s.calls[0].init.method, 'GET');
  } finally {
    s.restore();
  }
});

test('列表 401 判成凭证失效', async () => {
  const s = stubFetch(function () { return jsonRes({}, 401); });
  try {
    const r = await listConversations('tok', 10);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'expired');
  } finally {
    s.restore();
  }
});

test('网络异常不抛错，归为 network', async () => {
  const s = stubFetch(function () { throw new Error('boom'); });
  try {
    const r = await listConversations('tok', 10);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'network');
    assert.equal(r.error, 'boom');
  } finally {
    s.restore();
  }
});

test('骨架接口解析 responseId 与 sender', async () => {
  const s = stubFetch(function () {
    return jsonRes({
      responseNodes: [
        { responseId: 'r1', sender: 'human', parentResponseId: null },
        { responseId: 'r2', sender: 'assistant', parentResponseId: 'r1' },
      ],
      inflightResponses: [],
    });
  });
  try {
    const r = await listResponseNodes('tok', 'conv-1');
    assert.equal(r.ok, true);
    assert.equal(r.nodes.length, 2);
    assert.equal(r.nodes[1].sender, 'assistant');
    assert.equal(r.nodes[1].parentResponseId, 'r1');
    assert.equal(r.inflight, false);
    assert.match(s.calls[0].url, /\/conversations\/conv-1\/response-node\?includeThreads=true/);
  } finally {
    s.restore();
  }
});

test('load-responses 用 POST 发 responseIds', async () => {
  const s = stubFetch(function () { return jsonRes({ responses: [{ responseId: 'r1' }] }); });
  try {
    const r = await loadResponses('tok', 'conv-1', ['r1', 'r2']);
    assert.equal(r.ok, true);
    assert.equal(r.list.length, 1);
    assert.equal(s.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(s.calls[0].init.body), { responseIds: ['r1', 'r2'] });
    assert.match(s.calls[0].url, /\/conversations\/conv-1\/load-responses$/);
  } finally {
    s.restore();
  }
});

test('responseIds 为空时不发请求', async () => {
  const s = stubFetch(function () { throw new Error('不应该发请求'); });
  try {
    const r = await loadResponses('tok', 'conv-1', []);
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'bad_request');
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test('两步取数：先拉骨架再按尾部 id 取正文', async () => {
  const s = stubFetch(function (url) {
    if (url.indexOf('/response-node') >= 0) {
      const nodes = [];
      for (let i = 0; i < 80; i++) nodes.push({ responseId: 'r' + i, sender: i % 2 ? 'assistant' : 'human' });
      return jsonRes({ responseNodes: nodes });
    }
    return jsonRes({
      responses: [
        { responseId: 'r78', sender: 'human', message: '问' },
        { responseId: 'r79', sender: 'assistant', message: '答' },
      ],
    });
  });
  try {
    const r = await sessionMessages('tok', 'conv-1', 5);
    assert.equal(r.ok, true);
    assert.ok(r.messages.length >= 1);
    const body = JSON.parse(s.calls[1].init.body);
    assert.ok(body.responseIds.indexOf('r79') >= 0, '应带上最后一条');
    assert.ok(body.responseIds.indexOf('r0') < 0, '不应带最早那条');
  } finally {
    s.restore();
  }
});

test('骨架很多时按 50 一批分批取正文', async () => {
  const s = stubFetch(function (url) {
    if (url.indexOf('/response-node') >= 0) {
      const nodes = [];
      for (let i = 0; i < 200; i++) nodes.push({ responseId: 'r' + i, sender: i % 2 ? 'assistant' : 'human' });
      return jsonRes({ responseNodes: nodes });
    }
    return jsonRes({ responses: [] });
  });
  try {
    const r = await sessionMessages('tok', 'conv-1', 100);
    assert.equal(r.ok, true);
    // 1 次骨架 + N 次 load-responses，每批不超过 50
    const posts = s.calls.filter((c) => c.url.indexOf('/load-responses') >= 0);
    assert.ok(posts.length >= 2, '应分成多批, 实际 ' + posts.length);
    for (const p of posts) {
      const body = JSON.parse(p.init.body);
      assert.ok(body.responseIds.length <= 50, '单批不得超过 50, 实际 ' + body.responseIds.length);
    }
  } finally {
    s.restore();
  }
});

test('空会话返回 empty，不调第二步', async () => {
  const s = stubFetch(function () { return jsonRes({ responseNodes: [] }); });
  try {
    const r = await sessionMessages('tok', 'conv-1', 5);
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'empty');
    assert.deepEqual(r.messages, []);
    assert.equal(s.calls.length, 1);
  } finally {
    s.restore();
  }
});
