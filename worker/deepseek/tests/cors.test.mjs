import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../deepseek-web.js';

/*
 * 浏览器端能用的前提：所有响应都要带 CORS 头。
 * 曾经踩过的坑：智谱/Kimi 适配器自己 new Response 时漏了 Access-Control-Allow-Origin，
 * curl 测着一切正常，真浏览器却报 "blocked by CORS policy"。
 */
const ORIGIN = 'https://xdd2024030565-spec.github.io';

function post(site) {
  return new Request(`https://worker.example/${site}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
}

test('OPTIONS 预检返回 204 且带 CORS 头', async () => {
  for (const site of ['deepseek', 'doubao', 'grok', 'glm', 'kimi']) {
    const res = await worker.fetch(
      new Request(`https://worker.example/${site}/v1/chat/completions`, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      }),
      {}
    );
    assert.equal(res.status, 204, site);
    assert.ok(res.headers.get('access-control-allow-origin'), site + ' 缺 CORS 头');
    assert.match(res.headers.get('access-control-allow-headers') || '', /Content-Type/i, site);
  }
});

test('缺凭证时的错误响应同样带 CORS 头（浏览器才能读到原因）', async () => {
  for (const site of ['glm', 'kimi']) {
    const res = await worker.fetch(post(site), {});
    assert.equal(res.status, 503, site);
    assert.ok(res.headers.get('access-control-allow-origin'), site + ' 的错误响应缺 CORS 头');
    const data = await res.json();
    assert.ok(data.error.message, site);
  }
});

test('模型列表与健康检查都带 CORS 头', async () => {
  for (const site of ['glm', 'kimi']) {
    const models = await worker.fetch(
      new Request(`https://worker.example/${site}/v1/models`, { headers: { Origin: ORIGIN } }),
      {}
    );
    assert.equal(models.status, 200, site);
    assert.ok(models.headers.get('access-control-allow-origin'), site + ' models 缺 CORS 头');

    const health = await worker.fetch(
      new Request(`https://worker.example/${site}/health`, { headers: { Origin: ORIGIN } }),
      {}
    );
    assert.equal(health.status, 200, site);
    assert.ok(health.headers.get('access-control-allow-origin'), site + ' health 缺 CORS 头');
  }
});
