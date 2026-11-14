import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../deepseek-web.js';

const SSE = [
  'data: ' +
    JSON.stringify({
      event_type: 2001,
      event_data: JSON.stringify({ message: { content_type: 2001, content: JSON.stringify({ text: '你' }) } }),
    }),
  '',
  'data: ' +
    JSON.stringify({
      event_type: 2001,
      event_data: JSON.stringify({ message: { content_type: 2001, content: JSON.stringify({ text: '好' }) } }),
    }),
  '',
  'data: ' + JSON.stringify({ event_type: 2003 }),
  '',
].join('\n');

function mockUpstream(contentType, body) {
  return async (url, init) => {
    assert.ok(String(url).indexOf('doubao.com/samantha/chat/completion') >= 0, '应当请求豆包上游: ' + url);
    assert.equal(init.method, 'POST');
    return new Response(body, { status: 200, headers: { 'content-type': contentType } });
  };
}

function chatRequest(path, body, headers) {
  return new Request('https://worker.example' + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
}

test('豆包对话：上游 SSE 被翻成 OpenAI chunk', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockUpstream('text/event-stream; charset=utf-8', SSE);
  try {
    const res = await worker.fetch(
      chatRequest('/doubao/v1/chat/completions', { model: 'doubao-chat', messages: [{ role: 'user', content: '你好' }] }),
      { DOUBAO_TOKENS: 'tk-1' }
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"你"/);
    assert.match(text, /"content":"好"/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.ok(text.indexOf('data: [DONE]') >= 0, '应当以 [DONE] 收尾');
    assert.match(text, /"model":"doubao-chat"/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('豆包对话：上游返回 HTML 时给出可读错误', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockUpstream('text/html', '<html>login</html>');
  try {
    const res = await worker.fetch(
      chatRequest('/doubao/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }),
      { DOUBAO_TOKENS: 'tk-1' }
    );
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error.message, /没有返回流式内容/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('豆包对话：上游错误码翻译成 SSE error 事件', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockUpstream(
    'text/event-stream',
    'data: ' + JSON.stringify({ code: 710022004, message: 'blocked' }) + '\n\n'
  );
  try {
    const res = await worker.fetch(
      chatRequest('/doubao/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }),
      { DOUBAO_TOKENS: 'tk-1' }
    );
    const text = await res.text();
    assert.match(text, /710022004/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('豆包对话：没有凭证时 503 并说明怎么配', async () => {
  const res = await worker.fetch(
    chatRequest('/doubao/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }),
    {}
  );
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.match(data.error.message, /DOUBAO_TOKENS/);
});

test('豆包模型列表与空会话列表', async () => {
  const models = await worker.fetch(new Request('https://worker.example/doubao/v1/models'), {});
  const body = await models.json();
  assert.equal(body.object, 'list');
  assert.equal(body.data[0].id, 'doubao-chat');

  const sessions = await worker.fetch(new Request('https://worker.example/doubao/v1/sessions'), {});
  assert.deepEqual(await sessions.json(), { object: 'list', data: [] });
});

test('健康检查：未带口令只回能不能用', async () => {
  const res = await worker.fetch(new Request('https://worker.example/health'), { DEEPSEEK_TOKENS: 'a,b' });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.sites.doubao, 'no_token');
  assert.equal(data.tokens, undefined, '未带口令不应暴露 token 数量');

  const withKey = await worker.fetch(
    new Request('https://worker.example/health', { headers: { Authorization: 'Bearer some-key' } }),
    { DEEPSEEK_TOKENS: 'a,b', DOUBAO_TOKENS: 'd' }
  );
  const detail = await withKey.json();
  assert.equal(detail.tokens, 2);
  assert.deepEqual(detail.sites.doubao, { ok: true, kind: 'ok' });
});

test('PROXY_KEY 生效时挡住未授权请求', async () => {
  const res = await worker.fetch(new Request('https://worker.example/deepseek/v1/models'), { PROXY_KEY: 'pw' });
  assert.equal(res.status, 401);
});
