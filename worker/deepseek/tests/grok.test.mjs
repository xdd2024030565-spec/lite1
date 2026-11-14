import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, mergeMessages, parseEvent, health } from '../sites/grok.js';

test('单条消息直接透传文本', () => {
  assert.equal(mergeMessages([{ role: 'user', content: '你好' }]), '你好');
});

test('多轮消息带上角色前缀拼成一段', () => {
  const out = mergeMessages([
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]);
  assert.equal(out, '[user] 第一问\n\n[assistant] 第一答\n\n[user] 第二问');
});

test('请求打到 Grok 网页版新增会话接口，带 sso cookie 与固定头', () => {
  const { url, init } = buildChatRequest({ token: 'sso-1', text: 'hi' });
  assert.equal(url, 'https://grok.com/rest/app-chat/conversations/new');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.cookie, 'sso=sso-1');
  assert.equal(init.headers.origin, 'https://grok.com');
  assert.equal(init.headers.referer, 'https://grok.com/');
  assert.ok(init.headers['x-statsig-id'], '应有 x-statsig-id');
  assert.match(init.headers['x-xai-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('请求体字段与规范一致', () => {
  const { init } = buildChatRequest({ token: 't', text: '你好', model: 'grok-3' });
  const body = JSON.parse(init.body);
  assert.equal(body.modelName, 'grok-3');
  assert.equal(body.message, '你好');
  assert.equal(body.temporary, true);
  assert.equal(body.isAsyncChat, false);
  assert.deepEqual(body.fileAttachments, []);
});

test('不认识的模型名回落到 grok-3', () => {
  const body = JSON.parse(buildChatRequest({ token: 't', text: 'x', model: 'gpt-4o' }).init.body);
  assert.equal(body.modelName, 'grok-3');
});

test('正文 token 解析成 content', () => {
  const raw = JSON.stringify({ result: { response: { token: '你好', responseId: 'r1', isThinking: false } } });
  assert.deepEqual(parseEvent(raw), { content: '你好' });
});

test('思考 token 解析成 reasoning', () => {
  const raw = JSON.stringify({ result: { response: { token: '在想', isThinking: true } } });
  assert.deepEqual(parseEvent(raw), { reasoning: '在想' });
});

test('isFinal 与 finalMetadata.isFinal 都算结束', () => {
  assert.deepEqual(parseEvent(JSON.stringify({ result: { response: { isFinal: true } } })), { finish: 'stop' });
  assert.deepEqual(
    parseEvent(JSON.stringify({ result: { response: { finalMetadata: { isFinal: true } } } })),
    { finish: 'stop' }
  );
});

test('上游报错转成可读错误', () => {
  const raw = JSON.stringify({ result: { error: { message: 'rate limited' } } });
  assert.match(parseEvent(raw).error, /rate limited/);
});

test('OpenAI 兼容形态也能解析', () => {
  const raw = JSON.stringify({ choices: [{ delta: { content: '嗨' }, finish_reason: '' }] });
  assert.deepEqual(parseEvent(raw), { content: '嗨' });
});

test('坏 JSON 与无关事件返回 null', () => {
  assert.equal(parseEvent('not json'), null);
  assert.equal(parseEvent(JSON.stringify({ result: { conversation: { id: 'c1' } } })), null);
});

test('健康检查只看配置，不打上游', () => {
  const saved = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => {
    called += 1;
    throw new Error('不该联网');
  };
  try {
    assert.deepEqual(health({}), { ok: false, site: 'grok', kind: 'no_token' });
    assert.deepEqual(health({ GROK_TOKENS: 'a,b' }), { ok: true, site: 'grok', kind: 'ok' });
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(called, 0);
});

test('模型清单带 modelMode，聊天请求要一起发', async () => {
  const { buildChatRequest } = await import('../sites/grok.js');
  const req = buildChatRequest({ token: 't', text: 'hi', model: 'grok-3', mode: 'MODEL_MODE_FAST' });
  const body = JSON.parse(req.init.body);
  assert.equal(body.modelName, 'grok-3');
  assert.equal(body.modelMode, 'MODEL_MODE_FAST');
});
