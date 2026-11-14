import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatBody,
  buildMessages,
  chat,
  chatMode,
  generateSign,
  models,
  parseEvent,
  refreshToken,
} from '../sites/glm.js';
import { md5 } from '../lib/md5.js';

const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

test('buildMessages 只保留有文本的消息，助手用 assistant 角色', () => {
  const out = buildMessages([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在的' },
    { role: 'user', content: '' },
    { role: 'system', content: '忽略这条' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '在的' }] },
    { role: 'user', content: [{ type: 'text', text: '忽略这条' }] },
  ]);
});

test('buildChatBody 带默认助手与联网开关，思考模型走 zero 模式', () => {
  const normal = buildChatBody({ messages: [{ role: 'user', content: 'hi' }], model: 'glm-4-plus' });
  assert.equal(normal.assistant_id, '65940acff94777010aa6b796');
  assert.equal(normal.chat_type, 'user_chat');
  assert.equal(normal.conversation_id, '');
  assert.equal(normal.meta_data.is_networking, true);
  assert.equal(normal.meta_data.chat_mode, undefined);

  const think = buildChatBody({ messages: [{ role: 'user', content: 'hi' }], model: 'glm-4-think' });
  assert.equal(think.meta_data.chat_mode, 'zero');
});

test('chatMode 认 think / zero / deepresearch', () => {
  assert.equal(chatMode('glm-4-plus'), undefined);
  assert.equal(chatMode('glm-4-think'), 'zero');
  assert.equal(chatMode('glm-4-zero'), 'zero');
  assert.equal(chatMode('glm-deepresearch'), 'deep_research');
});

test('generateSign 的时间戳把校验位写进倒数第二位', () => {
  const s = generateSign();
  assert.match(s.timestamp, /^\d{13}$/);
  assert.match(s.nonce, /^[0-9a-f]{32}$/);
  assert.equal(s.sign, md5(s.timestamp + '-' + s.nonce + '-' + SIGN_SECRET));

  const digits = s.timestamp.split('').map(Number);
  const sum = digits.reduce((a, b) => a + b, 0);
  assert.equal((sum - digits[digits.length - 2]) % 10, digits[digits.length - 2]);
});

test('parseEvent 对全量快照算增量', () => {
  const state = { text: '', reasoning: '' };
  const first = parseEvent(JSON.stringify({ parts: [{ content: [{ type: 'text', text: '你' }] }] }), state);
  assert.deepEqual(first, { content: '你' });
  const second = parseEvent(JSON.stringify({ parts: [{ content: [{ type: 'text', text: '你好' }] }] }), state);
  assert.deepEqual(second, { content: '好' });
  const same = parseEvent(JSON.stringify({ parts: [{ content: [{ type: 'text', text: '你好' }] }] }), state);
  assert.equal(same, null);
});

test('parseEvent 把 think 段落单独给 reasoning，finish 收尾', () => {
  const state = { text: '', reasoning: '' };
  const r = parseEvent(
    JSON.stringify({ parts: [{ content: [{ type: 'think', think: '先想一想' }] }] }),
    state
  );
  assert.deepEqual(r, { reasoning: '先想一想' });

  const done = parseEvent(JSON.stringify({ status: 'finish', parts: [] }), state);
  assert.equal(done.finish, 'stop');
});

test('parseEvent 把上游错误码翻成可读错误', () => {
  const e = parseEvent(JSON.stringify({ code: 1002, message: '额度不足' }), { text: '', reasoning: '' });
  assert.equal(e.error, '智谱拒绝了这次请求（1002）：额度不足');
});

test('refreshToken 拿 result.access_token 并缓存', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ code: 0, result: { access_token: 'acc-1', refresh_token: 'r-2' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    assert.equal(await refreshToken('r-1'), 'acc-1');
    assert.equal(await refreshToken('r-1'), 'acc-1');
    assert.equal(calls, 1);
    assert.equal(await refreshToken('r-2'), 'acc-1');
    assert.equal(calls, 1);
  } finally {
    delete globalThis.fetch;
  }
});

test('chat 没有凭证时返回 503 提示', async () => {
  const res = await chat(
    new Request('https://x/glm/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: '在吗' }] }),
    }),
    {},
    []
  );
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.match(data.error.message, /GLM_TOKENS/);
});

test('chat 把上游 SSE 翻成 OpenAI chunk 并以 [DONE] 收尾', async () => {
  const sse = [
    'data: {"parts":[{"content":[{"type":"text","text":"你"}]}]}',
    'data: {"parts":[{"content":[{"type":"text","text":"你好"}]}]}',
    'data: {"status":"finish","parts":[]}',
  ].join('\n\n');
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: init.body });
    if (String(url).includes('/user/refresh')) {
      return new Response(JSON.stringify({ code: 0, result: { access_token: 'acc-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const res = await chat(
      new Request('https://x/glm/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'glm-4-plus', messages: [{ role: 'user', content: '你好' }] }),
      }),
      { GLM_TOKENS: 'refresh-1' },
      ['refresh-1']
    );
    assert.equal(res.headers.get('content-type').indexOf('text/event-stream'), 0);
    const text = await res.text();
    assert.match(text, /"content":"你"/);
    assert.match(text, /"content":"好"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.ok(text.trim().endsWith('data: [DONE]'));

    const upstream = seen[seen.length - 1];
    assert.match(upstream.url, /assistant\/stream$/);
    assert.equal(upstream.headers['x-sign'].length, 32);
    assert.match(upstream.headers['x-timestamp'], /^\d{13}$/);
    assert.match(upstream.body, /"assistant_id":"65940acff94777010aa6b796"/);
  } finally {
    delete globalThis.fetch;
  }
});

test('chat 遇到非流式响应时给出可读错误', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/user/refresh')) {
      return new Response(JSON.stringify({ code: 0, result: { access_token: 'acc-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const res = await chat(
      new Request('https://x/glm/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      }),
      { GLM_TOKENS: 'refresh-2' },
      ['refresh-2']
    );
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error.message, /非流式/);
  } finally {
    delete globalThis.fetch;
  }
});
