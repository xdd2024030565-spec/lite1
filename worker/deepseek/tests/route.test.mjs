import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../lib/route.js';

test('站点前缀被拆出来', () => {
  assert.deepEqual(route('/deepseek/v1/chat/completions'), {
    site: 'deepseek',
    path: '/v1/chat/completions',
    legacy: false,
  });
  assert.deepEqual(route('/doubao/v1/models'), { site: 'doubao', path: '/v1/models', legacy: false });
});

test('/<site> 与 /<site>/health 都是健康检查', () => {
  assert.deepEqual(route('/doubao'), { site: 'doubao', path: '/health', legacy: false });
  assert.deepEqual(route('/doubao/health'), { site: 'doubao', path: '/health', legacy: false });
  assert.deepEqual(route('/health'), { site: 'deepseek', path: '/health', legacy: true });
  assert.deepEqual(route('/'), { site: 'deepseek', path: '/health', legacy: true });
});

test('没有站点前缀的老路径按 legacy 落到 deepseek', () => {
  assert.deepEqual(route('/v1/models'), { site: 'deepseek', path: '/v1/models', legacy: true });
  assert.deepEqual(route('/v1/sessions/messages'), {
    site: 'deepseek',
    path: '/v1/sessions/messages',
    legacy: true,
  });
});

test('未知前缀不会被当成站点', () => {
  assert.deepEqual(route('/foo/v1/models'), { site: 'deepseek', path: '/foo/v1/models', legacy: true });
});
