/*
 * OpenAI chunk 线格式：各站点适配器统一用这几个函数产出 SSE 行。
 */

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function randomId(prefix) {
  return (prefix || 'chatcmpl-') + Math.random().toString(36).slice(2, 14);
}

export function chunkLine(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

export function openaiChunk(id, model, delta, finish) {
  return {
    id: id,
    object: 'chat.completion.chunk',
    created: nowSec(),
    model: model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null }],
  };
}

export function deltaChunk(id, model, delta) {
  return chunkLine(openaiChunk(id, model, delta, null));
}

export function finishChunk(id, model, reason) {
  return chunkLine(openaiChunk(id, model, {}, reason || 'stop'));
}

export function doneChunk() {
  return 'data: [DONE]\n\n';
}

export function errorChunk(message) {
  return chunkLine({ error: { message: String(message || '上游错误'), type: 'upstream' } });
}
