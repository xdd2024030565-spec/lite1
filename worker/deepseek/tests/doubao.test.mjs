import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, mergeMessages, parseEvent } from '../sites/doubao.js';

test('单条消息直接透传文本', () => {
  assert.equal(mergeMessages([{ role: 'user', content: '你好' }]), '你好');
});

test('多轮消息拼成 im_start/im_end 标记', () => {
  const out = mergeMessages([
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' },
  ]);
  assert.equal(
    out,
    '<|im_start|>user\n第一问\n<|im_end|>\n' +
      '<|im_start|>assistant\n第一答\n<|im_end|>\n' +
      '<|im_start|>user\n第二问\n<|im_end|>\n'.trim()
  );
});

test('请求 URL 带齐固定查询参数', () => {
  const { url, init } = buildChatRequest({ token: 'tk-1', text: 'hi' });
  assert.ok(url.startsWith('https://www.doubao.com/samantha/chat/completion?'), url);
  for (const kv of ['aid=497858', 'samantha_web=1', 'device_platform=web', 'version_code=20800', 'region=CN']) {
    assert.ok(url.indexOf(kv) >= 0, '缺少 ' + kv);
  }
  assert.equal(init.headers.Cookie, 'sessionid=tk-1; sessionid_ss=tk-1');
  assert.equal(init.headers.Referer, 'https://www.doubao.com/chat/');
  assert.match(init.headers['X-Flow-Trace'], /^04-[0-9a-f-]{36}-[0-9a-f]{16}-01$/);
});

test('请求体是单条 2001 文本块 + 自动建会话', () => {
  const body = JSON.parse(buildChatRequest({ token: 't', text: '你好呀' }).init.body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content_type, 2001);
  assert.equal(body.messages[0].content, JSON.stringify({ text: '你好呀' }));
  assert.equal(body.completion_option.need_create_conversation, true);
  assert.equal(body.conversation_id, '0');
  assert.match(body.section_id, /^26\d{16}$/);
  assert.match(body.local_conversation_id, /^local_16\d{14}$/);
});

test('文本事件：content 里是 JSON({text})', () => {
  const raw = JSON.stringify({
    event_type: 2001,
    event_data: JSON.stringify({ message: { content_type: 2001, content: JSON.stringify({ text: '你' }) } }),
  });
  assert.deepEqual(parseEvent(raw), { content: '你' });
});

test('文本事件：content 里是 delta.text', () => {
  const raw = JSON.stringify({
    event_type: 2001,
    event_data: JSON.stringify({ message: { content: JSON.stringify({ delta: { text: '好' } }) } }),
  });
  assert.deepEqual(parseEvent(raw), { content: '好' });
});

test('文本事件：content 是裸字符串', () => {
  const raw = JSON.stringify({
    event_type: 2001,
    event_data: JSON.stringify({ message: { content: '直接文本' } }),
  });
  assert.deepEqual(parseEvent(raw), { content: '直接文本' });
});

test('结束事件：event_type 2003 与 is_finish 都算结束', () => {
  assert.deepEqual(parseEvent(JSON.stringify({ event_type: 2003 })), { finish: 'stop' });
  assert.deepEqual(
    parseEvent(JSON.stringify({ event_type: 2001, event_data: JSON.stringify({ is_finish: true }) })),
    { finish: 'stop' }
  );
});

test('无关事件返回 null（图片等）', () => {
  assert.equal(parseEvent(JSON.stringify({ event_type: 2000 })), null);
  const img = JSON.stringify({
    event_type: 2001,
    event_data: JSON.stringify({ message: { content_type: 2074, content: '{}' } }),
  });
  assert.equal(parseEvent(img), null);
});

test('上游错误码转成可读错误', () => {
  const ev = parseEvent(JSON.stringify({ code: 710022004, message: 'blocked' }));
  assert.match(ev.error, /710022004/);
});

test('坏 JSON 不抛异常', () => {
  assert.match(parseEvent('{不是 json').error, /无法解析/);
});
