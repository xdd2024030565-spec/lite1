/*
 * token 轮询池：多账号时按请求轮换，某个 token 被判失效后挪到队尾。
 */

export function createPool(tokens) {
  const list = (tokens || []).filter(function (t) { return !!t; }).slice();
  let cursor = 0;
  const bad = [];

  function next() {
    if (!list.length) return '';
    const t = list[cursor % list.length];
    cursor = (cursor + 1) % list.length;
    return t;
  }

  function markBad(token) {
    const i = list.indexOf(token);
    if (i < 0) return;
    list.splice(i, 1);
    bad.push(token);
    if (cursor > i) cursor -= 1;
    if (cursor >= list.length) cursor = 0;
  }

  return {
    next: next,
    markBad: markBad,
    size: function () { return list.length; },
    total: function () { return list.length + bad.length; },
  };
}
