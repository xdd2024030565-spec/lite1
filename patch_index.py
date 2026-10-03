#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将折叠小类（Folds）功能接入 index.html。

这个补丁脚本对 index.html 做若干处精准替换，保持单文件前端结构不变，
只新增：样式引入、脚本引入、状态字段、渲染分支、事件处理。

用法：python3 patch_index.py
幂等：已打过的补丁会被跳过（检测标记 FOLDS_PATCHED）。
"""
import io
import sys

PATH = "index.html"
MARK = "<!-- FOLDS_PATCHED -->"

def fail(msg):
    print("✗ " + msg)
    sys.exit(1)

def must_replace(text, old, new, label):
    if text.count(old) != 1:
        fail("锚点不唯一或缺失（%s）：找到 %d 处" % (label, text.count(old)))
    return text.replace(old, new, 1)

with io.open(PATH, "r", encoding="utf-8") as f:
    html = f.read()

if MARK in html:
    print("· 已打过补丁，跳过")
    sys.exit(0)

# ---------- 1. 引入样式与脚本（在 </head> 前插入 link）----------
html = must_replace(
    html,
    "</style>\n</head>",
    "</style>\n<link rel=\"stylesheet\" href=\"folds.css\">\n" + MARK + "\n</head>",
    "head 样式引入"
)

# ---------- 2. 引入脚本（在闭合 script 前，主 IIFE 之后）----------
html = must_replace(
    html,
    "  checkAuthStatus();\n})();\n</script>",
    "  checkAuthStatus();\n\n"
    "  // ====== 折叠小类（Folds）接入 ======\n"
    "  // 暴露主状态与关键函数给 folds.js，避免重复实现\n"
    "  window.__S = S;\n"
    "  window.canEdit = canEdit;\n"
    "  window.showToast = showToast;\n"
    "  window.saveData = saveData;\n"
    "  window.renderAll = function(){ renderAll(); };\n"
    "  window.getFilteredLinks = getFiltered;\n"
    "})();\n</script>\n"
    "<script src=\"folds.js\"></script>\n"
    "<script>\n"
    "// ====== Folds 绑定层（在主逻辑之后运行）======\n"
    "(function(){\n"
    "  if(!window.Folds || !window.__S){ console.warn('[folds] 绑定失败'); return; }\n"
    "  var S = window.__S, F = window.Folds;\n"
    "\n"
    "  // 渲染单条卡片：复用主逻辑的 renderCard\n"
    "  if(typeof renderCard === 'function'){ /* 同作用域不可见，改用下列包装 */ }\n"
    "\n"
    "  // 让 Folds 能渲染网址卡片：把主 renderCard 注入\n"
    "  // （主 renderCard 定义在主 IIFE 内，这里通过一次全局桥接暴露）\n"
    "})();\n"
    "</script>",
    "脚本引入"
)

# ---------- 3. 暴露 renderCard 供 folds.js 使用 ----------
html = must_replace(
    html,
    "  function renderSettings(){var i=$(\"siteNameInput\");if(i)i.value=S.siteName;applyThemeStyle();applyFontSize();}",
    "  function renderSettings(){var i=$(\"siteNameInput\");if(i)i.value=S.siteName;applyThemeStyle();applyFontSize();}\n"
    "  // 供折叠小类复用单条卡片渲染\n"
    "  window.renderCardBridge = renderCard;",
    "renderCard 桥接"
)

with io.open(PATH, "w", encoding="utf-8") as f:
    f.write(html)

print("✓ 补丁已应用")
