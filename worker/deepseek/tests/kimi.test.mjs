import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeMessages,
  encodeFrame,
  takeFrames,
  buildChatBody,
  parseEvent,
  chat,
  refreshToken,
  health,
  models,
} from '../sites/kimi.js';

test('多轮对话压成一段 prompt，最后一轮是当前问题', () => {
  const prompt = mergeMessages([
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]);
  assert.ok(prompt.includes('用户：第一问'));
  assert.ok(prompt.includes('你：第一答'));
  assert.ok(prompt.endsWith('现在请回答：\n第二问'));
});

test('单轮对话直接发送原文', () => {
  assert.equal(mergeMessages([{ role: 'user', content: '你好' }]), '你好');
});

test('请求帧是 1 字节标志位加 4 字节大端长度', () => {
  const frame = encodeFrame({ a: 1 });
  assert.equal(frame[0], 0);
  const len = new DataView(frame.buffer).getUint32(1, false);
  assert.equal(len, frame.length - 5);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(frame.subarray(5))), { a: 1 });
});

test('切帧：不足一帧时不消费，trailer 帧被跳过', () => {
  const one = encodeFrame({ block: { text: { content: '你' } } });
  const trailer = new Uint8Array([2, 0, 0, 0, 0]);
  const all = new Uint8Array(one.length + trailer.length);
  all.set(one, 0);
  all.set(trailer, one.length);

  const [events1, rest1] = takeFrames(all.subarray(0, one.length - 2));
  assert.equal(events1.length, 0);
  assert.equal(rest1.length, one.length - 2);

  const [events2, rest2] = takeFrames(all);
  assert.equal(events2.length, 1);
  assert.equal(events2[0].block.text.content, '你');
  assert.equal(rest2.length, 0);
});

test('请求体：场景固定为对话，思考开关只影响 reasoning_effort', () => {
  const off = buildChatBody('问题', false);
  assert.equal(off.scenario, 'SCENARIO_CHAT');
  assert.equal(off.options.model, 'k2d6-chat');
  assert.equal(off.options.thinking, true);
  assert.equal(off.options.reasoning_effort, 'REASONING_EFFORT_NONE');
  assert.equal(off.message.role, 'user');
  assert.equal(off.message.blocks[0].text.content, '问题');
  assert.equal(buildChatBody('问题', true).options.reasoning_effort, 'REASONING_EFFORT_LOW');
});

test('解析事件：正文、思考、结束、心跳与错误', () => {
  assert.deepEqual(parseEvent({ block: { text: { content: '你好' } } }), { content: '你好' });
  assert.deepEqual(parseEvent({ block: { think: { content: '想一下' } } }), { reasoning: '想一下' });
  assert.deepEqual(parseEvent({ done: true }), { finish: 'stop' });
  assert.equal(parseEvent({ heartbeat: {} }), null);
  const err = parseEvent({
    error: {
      code: 'unauthenticated',
      details: [{ type: 'x', debug: { localizedMessage: { locale: 'zh-CN', message: '登录态失效' } } }],
    },
  });
  assert.ok(err.error.includes('登录态失效'));
});

test('凭证缺失时直接 503', async () => {
  const res = await chat(new Request('https://x/kimi/v1/chat/completions', { method: 'POST' }), {}, []);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(body.error.message.includes('KIMI_TOKENS'));
});

test('完整链路：换 token 后按帧读流，正文与结束都翻成 OpenAI chunk', async () => {
  const calls = [];
  const parts = [
    encodeFrame({ chat: { id: 'c1' } }),
    encodeFrame({ block: { think: { content: '想一想' } } }),
    encodeFrame({ block: { text: { content: '你' } } }),
    encodeFrame({ block: { text: { content: '好' } } }),
    encodeFrame({ done: true }),
  ];
  const frames = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    frames.set(part, offset);
    offset += part.length;
  }
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('RefreshToken')) {
      return new Response(JSON.stringify({ accessToken: 'at-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(frames, { status: 200, headers: { 'content-type': 'application/connect+json' } });
  };
  try {
    const res = await chat(
      new Request('https://x/kimi/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'kimi', messages: [{ role: 'user', content: '说点啥' }] }),
      }),
      { KIMI_TOKENS: 'refresh-1' },
      ['refresh-1'],
    );
    const text = await res.text();
    assert.ok(calls[0].includes('auth.kimi.ai'));
    assert.ok(calls[1].includes('ChatService/Chat'));
    assert.ok(text.includes('"reasoning_content":"想一想"'));
    assert.ok(text.includes('"content":"你"'));
    assert.ok(text.includes('"content":"好"'));
    assert.ok(text.includes('"finish_reason":"stop"'));
    assert.ok(text.includes('[DONE]'));
  } finally {
    delete globalThis.fetch;
  }
});

test('access 类型的凭证直接用，不再换 token', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const accessToken = `${b64({ alg: 'HS512' })}.${b64({ typ: 'access', exp: 9999999999 })}.sig`;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const frame = encodeFrame({ block: { text: { content: '好' } } });
    return new Response(frame, { status: 200, headers: { 'content-type': 'application/connect+json' } });
  };
  try {
    const res = await chat(
      new Request('https://x/kimi/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: '在吗' }] }),
      }),
      { KIMI_TOKENS: accessToken },
      [accessToken],
    );
    const text = await res.text();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('ChatService/Chat'));
    assert.ok(text.includes('"content":"好"'));
  } finally {
    delete globalThis.fetch;
  }
});

test('聊天接口返回非 2xx 时给出可读错误', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('RefreshToken')) {
      return new Response(JSON.stringify({ token: 'at-2' }), { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  };
  try {
    const res = await chat(
      new Request('https://x/kimi/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
      { KIMI_TOKENS: 'refresh-2' },
      ['refresh-2'],
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error.message.includes('HTTP 403'));
  } finally {
    delete globalThis.fetch;
  }
});

test('换 token 失败时提示 refresh_token 失效', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 'unauthenticated',
        details: [{ type: 'x', debug: { localizedMessage: { message: 'Session expired. Please log in again.' } } }],
      }),
      { status: 401 },
    );
  try {
    await assert.rejects(
      () => refreshToken('bad-token'),
      /Session expired/,
    );
  } finally {
    delete globalThis.fetch;
  }
});

test('健康检查只看配置，不发请求', () => {
  assert.equal(health({}).kind, 'no_token');
  assert.equal(health({ KIMI_TOKENS: 'x' }).ok, true);
  assert.equal(models[0].id, 'kimi');
});
