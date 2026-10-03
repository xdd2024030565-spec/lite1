/* ============================================================
   网址储存 · 主题与外观逻辑
   从 index.html 抽离，减小主文件体积。
   依赖：window.__S（主状态，由 app.js 注入）、localStorage
   ============================================================ */
(function(){
  "use strict";

  var S = window.__S;
  if(!S){ console.warn("[themes] 未找到主状态对象"); return; }

  var MARK = "<!-- FOLDS_PATCHED -->";
  window.__THEME_MARK = MARK;
})();
