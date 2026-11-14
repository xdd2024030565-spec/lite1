import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatBody, parseEvent, health, models } from '../sites/kimi.js';

test('请求体带上完整对话，最后一轮是用户消息', () => {
  const body = buildChatBody({
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
    ],
    model: 'kimi',
  });
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[2].content, '第二问');
  assert.equal(body.kimiplus_id, 'kimi');
  assert.deepEqual(body.refs, []);
  assert.equal(body.use_search, false);
  assert.equal(body.extend.sidebar, true);
});

test('未知模型名回落到 kimi', () => {
  assert.equal(buildChatBody({ messages: [{ role: 'user', content: 'x' }], model: 'gpt-4o' }).kimiplus_id, 'kimi');
});

test('解析正文增量', () => {
  assert.deepEqual(parseEvent('data: {"event":"cmpl","text":"你"}'), { content: '你' });
});

test('all_done 作为结束信号', () => {
  assert.deepEqual(parseEvent('data: {"event":"all_done"}'), { finish: 'stop' });
});

test('error 事件变成可读错误', () => {
  const ev = parseEvent('data: {"event":"error","code":"x"}');
  assert.ok(ev.error.indexOf('Kimi') >= 0);
});

test('req / search_plus / length / event: 行 / 坏 JSON 都忽略', () => {
  assert.equal(parseEvent('data: {"event":"req","id":"seg-1"}'), null);
  assert.equal(parseEvent('data: {"event":"search_plus","msg":{"type":"get_res","title":"t","url":"u"}}'), null);
  assert.equal(parseEvent('data: {"event":"length"}'), null);
  assert.equal(parseEvent('event: message'), null);
  assert.equal(parseEvent('data: not-json'), null);
  assert.equal(parseEvent(''), null);
});

test('健康检查只看配置，不联网', () => {
  assert.deepEqual(health({}), { ok: false, site: 'kimi', kind: 'no_token' });
  assert.deepEqual(health({ KIMI_TOKENS: 'r1,r2' }), { ok: true, site: 'kimi', kind: 'ok' });
});

test('模型清单至少一个可用模型', () => {
  assert.ok(models.length >= 1);
  assert.equal(models[0].id, 'kimi');
});
