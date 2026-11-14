import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatBody, parseEvent, health, models } from '../sites/qwen.js';

test('请求体带上会话 id、模型与增量输出开关', () => {
  const body = buildChatBody({
    messages: [{ role: 'user', content: '你好' }],
    model: 'qwen3.7-max',
    chatId: 'chat-1',
  });
  assert.equal(body.chat_id, 'chat-1');
  assert.equal(body.model, 'qwen3.7-max');
  assert.equal(body.stream, true);
  assert.equal(body.incremental_output, true);
  assert.equal(body.chat_mode, 'normal');
  assert.equal(body.parent_id, null);
});

test('最后一轮进 messages，之前的轮次作为上文一起带上', () => {
  const body = buildChatBody({
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ],
    model: 'qwen3.7-max',
    chatId: 'c',
  });
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].content, '第一问');
  assert.equal(body.messages[1].role, 'assistant');
  const last = body.messages[2];
  assert.equal(last.role, 'user');
  assert.equal(last.content, '第二问');
  assert.equal(last.chat_type, 't2t');
  assert.deepEqual(last.models, ['qwen3.7-max']);
  assert.deepEqual(last.feature_config, { thinking_enabled: false, output_schema: 'phase' });
});

test('模型名缺失时回落到默认模型', () => {
  const body = buildChatBody({ messages: [{ role: 'user', content: 'x' }], chatId: 'c' });
  assert.equal(body.model, 'qwen3.7-max');
});

test('解析正文增量', () => {
  const ev = parseEvent('data: {"choices":[{"index":0,"delta":{"content":"你"}}]}');
  assert.deepEqual(ev, { content: '你' });
});

test('解析思考增量', () => {
  const ev = parseEvent('data: {"choices":[{"index":0,"delta":{"reasoning_content":"想一下"}}]}');
  assert.deepEqual(ev, { reasoning: '想一下' });
});

test('finish_reason 作为结束信号', () => {
  const ev = parseEvent('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}');
  assert.deepEqual(ev, { finish: 'stop' });
});

test('上游错误码变成可读错误', () => {
  const ev = parseEvent('data: {"code":"RateLimited","detail":"too many"}');
  assert.ok(ev.error.indexOf('RateLimited') >= 0);
});

test('[DONE]、心跳和坏 JSON 都忽略', () => {
  assert.equal(parseEvent('[DONE]'), null);
  assert.equal(parseEvent('data: [DONE]'), null);
  assert.equal(parseEvent('data: {"response.created":{"response_id":"x"}}'), null);
  assert.equal(parseEvent('data: not-json'), null);
  assert.equal(parseEvent(''), null);
});

test('健康检查只看配置，不联网', () => {
  assert.deepEqual(health({}), { ok: false, site: 'qwen', kind: 'no_token' });
  assert.deepEqual(health({ QWEN_TOKENS: 'a,b' }), { ok: true, site: 'qwen', kind: 'ok' });
});

test('模型清单有两个可选模型', () => {
  assert.ok(models.length >= 2);
  assert.ok(models.every((m) => m.id && m.name));
});
