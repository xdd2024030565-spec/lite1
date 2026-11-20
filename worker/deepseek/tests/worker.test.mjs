import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../deepseek-web.js';

test('健康检查：未带口令只回能不能用', async () => {
  const res = await worker.fetch(new Request('https://worker.example/health'), { DEEPSEEK_TOKENS: 'a,b' });
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.sites.grok, 'no_token');
  assert.equal(data.tokens, undefined, '未带口令不应暴露 token 数量');

  const withKey = await worker.fetch(
    new Request('https://worker.example/health', { headers: { Authorization: 'Bearer some-key' } }),
    { DEEPSEEK_TOKENS: 'a,b', GROK_TOKENS: 'g' }
  );
  const detail = await withKey.json();
  assert.equal(detail.tokens, 2);
  assert.deepEqual(detail.sites.grok, { ok: true, kind: 'ok' });
});

test('PROXY_KEY 生效时挡住未授权请求', async () => {
  const res = await worker.fetch(new Request('https://worker.example/deepseek/v1/models'), { PROXY_KEY: 'pw' });
  assert.equal(res.status, 401);
});
