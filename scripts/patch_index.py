#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「折叠小类（Folds）」功能接入 index.html。

index.html 是单文件前端（约 200KB），无法在线整体重写，
因此用本脚本对其做若干处精准锚点替换，并在 CI 中运行一次。

设计要点
- 折叠组挂在分类之下：分类 -> 折叠组 -> 网址
- 折叠态只显示堆叠图标 + 名称 + 数量，点击展开
- 刷新必折叠：每次加载一律折叠；展开状态只记在 sessionStorage
- 旧数据零迁移：无 folds / 无 foldId 时行为与升级前一致
- 网址卡片上提供轻量「折叠」入口按钮

幂等：检测到 FOLDS_MARK 即跳过。
"""
import io
import sys

PATH = "index.html"
MARK = "<!-- FOLDS_PATCHED -->"


def die(msg):
    print("::error::" + msg)
    sys.exit(1)


def rep(text, old, new, label, count=1):
    n = text.count(old)
    if n != count:
        die("锚点不匹配（%s）：期望 %d 处，实际 %d 处" % (label, count, n))
    return text.replace(old, new)


with io.open(PATH, "r", encoding="utf-8") as f:
    html = f.read()

if MARK in html:
    print("已经打过补丁，跳过。")
    sys.exit(0)

# ============================================================
# 1) 引入样式表 + 打标记
# ============================================================
html = rep(
    html,
    "</style>\n</head>",
    "</style>\n<link rel=\"stylesheet\" href=\"folds.css\">\n" + MARK + "\n</head>",
    "引入 folds.css",
)

# ============================================================
# 2) 状态对象新增 folds 字段
# ============================================================
html = rep(
    html,
    'categories:[{id:"default",name:"常用"}],links:[],curCat:"all"',
    'categories:[{id:"default",name:"常用"}],links:[],folds:[],curCat:"all"',
    "S 增加 folds 字段",
)

# ============================================================
# 3) 读写 links.json 时持久化 folds
# ============================================================
html = rep(
    html,
    "            S.categories=p.categories||[{id:\"default\",name:\"常用\"}];\n            S.links=p.links||[];",
    "            S.categories=p.categories||[{id:\"default\",name:\"常用\"}];\n"
    "            S.links=p.links||[];\n"
    "            if(window.Folds){ window.Folds.normalize(p); }else{ S.folds=p.folds||[]; }\n"
    "            if(window.Folds) window.Folds.sanitize();",
    "载入 folds",
)

html = rep(
    html,
    "    var content=b64Encode(JSON.stringify({siteName:S.siteName,settings:S.settings,categories:S.categories,links:S.links},null,2));",
    "    var content=b64Encode(JSON.stringify({siteName:S.siteName,settings:S.settings,categories:S.categories,folds:(S.folds||[]),links:S.links},null,2));",
    "保存 folds",
)

# 导出 / 导入也带上 folds
html = rep(
    html,
    "    var d={siteName:S.siteName,settings:S.settings,categories:S.categories,links:S.links};",
    "    var d={siteName:S.siteName,settings:S.settings,categories:S.categories,folds:(S.folds||[]),links:S.links};",
    "导出 folds",
)

html = rep(
    html,
    "        if(d.categories)S.categories=d.categories;\n        if(d.links)S.links=d.links;",
    "        if(d.categories)S.categories=d.categories;\n"
    "        if(d.folds){ S.folds=d.folds; if(window.Folds) window.Folds.normalize(d); }\n"
    "        if(d.links)S.links=d.links;\n"
    "        if(window.Folds) window.Folds.sanitize();",
    "导入 folds",
)

# ============================================================
# 4) 单条网址卡片：暴露给 folds.js，并加轻量「折叠」按钮
# ============================================================
html = rep(
    html,
    "  // ====== 链接/分类操作 ======\n  function addLink(){",
    "  // 供折叠小类复用单条卡片渲染\n"
    "  window.__renderCard = renderCard;\n"
    "  function linkFoldBtn(l){\n"
    "    if(!canEdit()||!window.Folds) return \"\";\n"
    "    var f=window.Folds.foldOfLink(l);\n"
    "    if(f) return '<button class=\"link-fold-btn\" data-act=\"foldpickopen\" data-id=\"'+l.id+'\" title=\"已在「'+esc(f.name)+'」，点此调整\">\\uD83D\\uDDC2 已折叠</button>';\n"
    "    return '<button class=\"link-fold-btn\" data-act=\"foldpickopen\" data-id=\"'+l.id+'\" title=\"归入折叠小类\">\\uD83D\\uDDC2 折叠</button>';\n"
    "  }\n\n"
    "  // ====== 链接/分类操作 ======\n"
    "  function addLink(){",
    "renderCard 桥接 + 折叠按钮",
)

# 把按钮插入 link-actions（普通网址卡片）
html = rep(
    html,
    "      h+='<div class=\"link-actions\"><button data-act=\"pin\" data-id=\"'+l.id+'\">'+(l.pinned?\"取消置顶\":\"置顶\")+'</button>",
    "      h+='<div class=\"link-actions\">'+linkFoldBtn(l)+'<button data-act=\"pin\" data-id=\"'+l.id+'\">'+(l.pinned?\"取消置顶\":\"置顶\")+'</button>",
    "卡片插入折叠按钮",
)

# ============================================================
# 5) 主列表渲染：区分普通网址与折叠组
# ============================================================
html = rep(
    html,
    "  function getFiltered(){var l=S.links;if(S.curCat!==\"all\")l=l.filter(function(x){return x.categoryId===S.curCat;});if(S.searchQ){var q=S.searchQ;l=l.filter(function(x){return(x.title||\"\").toLowerCase().indexOf(q)!==-1||(x.url||\"\").toLowerCase().indexOf(q)!==-1||(x.note||\"\").toLowerCase().indexOf(q)!==-1;});}return l;}",
    "  function getFiltered(){var l=S.links;if(S.curCat!==\"all\")l=l.filter(function(x){return x.categoryId===S.curCat;});if(S.searchQ){var q=S.searchQ;l=l.filter(function(x){return(x.title||\"\").toLowerCase().indexOf(q)!==-1||(x.url||\"\").toLowerCase().indexOf(q)!==-1||(x.note||\"\").toLowerCase().indexOf(q)!==-1;});}return l;}\n"
    "  // 未被折叠的普通网址（搜索时一并展示组内成员）\n"
    "  function isPlainLink(l){ return !(window.Folds && l.foldId && window.Folds.find(l.foldId)); }\n"
    "  function plainFiltered(){ return getFiltered().filter(isPlainLink); }\n"
    "  // 当前分类下需要展示的折叠组\n"
    "  function visibleFolds(){\n"
    "    if(!window.Folds) return [];\n"
    "    var out=window.Folds.folds().slice();\n"
    "    if(S.curCat!==\"all\") out=out.filter(function(f){ return f.categoryId===S.curCat; });\n"
    "    if(S.searchQ){\n"
    "      var q=S.searchQ;\n"
    "      out=out.filter(function(f){\n"
    "        if((f.name||\"\").toLowerCase().indexOf(q)!==-1) return true;\n"
    "        return window.Folds.linksInFold(f.id).some(function(l){\n"
    "          return (l.title||\"\").toLowerCase().indexOf(q)!==-1||(l.url||\"\").toLowerCase().indexOf(q)!==-1||(l.note||\"\").toLowerCase().indexOf(q)!==-1;\n"
    "        });\n"
    "      });\n"
    "    }\n"
    "    return out;\n"
    "  }",
    "筛选辅助函数",
)

# renderLinks 主体改造
html = rep(
    html,
    "  function renderLinks(){\n"
    "    var c=$(\"linkContainer\"); var links=getFiltered(); var h=\"\";\n"
    "    if(links.length===0){\n"
    "      h+='<div class=\"empty-state\">'+(S.searchQ?\"没有匹配的网址\":\"还没有网址\"+(canEdit()?\"，在下方添加吧\":\"\"))+'</div>';\n"
    "    }else{",
    "  function renderLinks(){\n"
    "    var c=$(\"linkContainer\"); var links=plainFiltered(); var fgroups=visibleFolds(); var h=\"\";\n"
    "    // 先渲染折叠小类（刷新后一律折叠态）\n"
    "    fgroups.forEach(function(f){\n"
    "      h+=window.Folds.render(f,{hideCat:(S.curCat!==\"all\")});\n"
    "    });\n"
    "    if(links.length===0&&fgroups.length===0){\n"
    "      h+='<div class=\"empty-state\">'+(S.searchQ?\"没有匹配的网址\":\"还没有网址\"+(canEdit()?\"，在下方添加吧\":\"\"))+'</div>';\n"
    "    }else if(links.length===0){\n"
    "      // 只有折叠组，无普通网址：不显示时间分组标题\n"
    "    }else{",
    "renderLinks 改造",
)

# 兜底：确保 folds 的卡片渲染能用上 renderCard
html = rep(
    html,
    "  function renderAll(){renderNav();renderCatTabs();renderLinks();renderCatList();renderSettings();renderThemes();}",
    "  function renderAll(){renderNav();renderCatTabs();renderLinks();renderCatList();renderFoldMgr();renderSettings();renderThemes();}\n"
    "  function renderFoldMgr(){ if(window.Folds) window.Folds.renderManager(); }",
    "renderAll 加入折叠管理",
)

# ============================================================
# 6) 分类管理面板：加入折叠小类管理区块
# ============================================================
html = rep(
    html,
    "    <div id=\"catListContainer\"></div>\n  </div>",
    "    <div id=\"catListContainer\"></div>\n"
    "    <div class=\"section-header\">折叠小类</div>\n"
    "    <div id=\"foldListContainer\"></div>\n"
    "  </div>",
    "分类面板加折叠区块",
)

# 新建网址表单：增加「折叠到」选择器
html = rep(
    html,
    "      h+='</select><button id=\"addBtn\">添加</button></div>';",
    "      h+='</select>';\n"
    "      if(window.Folds&&window.Folds.folds().length){\n"
    "        h+='<select id=\"addFoldSel\" title=\"归入折叠小类（可选）\"><option value=\"\">不折叠</option>';\n"
    "        window.Folds.folds().forEach(function(f2){ h+='<option value=\"'+f2.id+'\">\\uD83D\\uDDC2 '+esc(f2.name)+'</option>'; });\n"
    "        h+='</select>';\n"
    "      }\n"
    "      h+='<button id=\"addBtn\">添加</button></div>';",
    "新建表单加折叠选择器",
)

# 新建时读取 foldId
html = rep(
    html,
    "    var cid=sel?sel.value:\"default\"; safeLS('setItem','lastAddCat',cid);",
    "    var cid=sel?sel.value:\"default\"; safeLS('setItem','lastAddCat',cid);\n"
    "    var fsel=$(\"addFoldSel\"), fid=fsel?fsel.value:\"\";\n"
    "    if(fid&&window.Folds){ var ff=window.Folds.find(fid); if(ff) cid=ff.categoryId; }",
    "新建读取折叠归属",
)

html = rep(
    html,
    "      S.links.unshift({id:gid(),url:u,title:t||u,categoryId:cid,note:\"\",pinned:false,added:new Date().toISOString()});",
    "      var nl={id:gid(),url:u,title:t||u,categoryId:cid,note:\"\",pinned:false,added:new Date().toISOString()};\n"
    "      if(fid) nl.foldId=fid;\n"
    "      S.links.unshift(nl);",
    "新建写入 foldId",
)

# ============================================================
# 7) 分类删除时：连带其下的折叠组
# ============================================================
html = rep(
    html,
    "    S.categories=S.categories.filter(function(c){return c.id!==id;});\n    if(S.curCat===id) S.curCat=\"all\";",
    "    S.categories=S.categories.filter(function(c){return c.id!==id;});\n"
    "    if(window.Folds){\n"
    "      window.Folds.folds().filter(function(f){ return f.categoryId===id; }).forEach(function(f){\n"
    "        var members=window.Folds.linksInFold(f.id);\n"
    "        members.forEach(function(l){ delete l.foldId; });\n"
    "      });\n"
    "      S.folds=S.folds.filter(function(f){ return f.categoryId!==id; });\n"
    "    }\n"
    "    if(S.curCat===id) S.curCat=\"all\";",
    "删分类连带折叠组",
)

# ============================================================
# 8) 编辑面板：增加折叠归属选择
# ============================================================
html = rep(
    html,
    "      h+='</select><textarea id=\"en-'+l.id+'\" placeholder=\"备注（可选）\">'+esc(l.note||\"\")+'</textarea>",
    "      h+='</select>';\n"
    "      if(window.Folds){\n"
    "        h+='<div class=\"fold-picker\"><label>折叠到</label><select id=\"ef-'+l.id+'\">';\n"
    "        h+='<option value=\"\"'+(!l.foldId?' selected':'')+'>不折叠</option>';\n"
    "        window.Folds.folds().forEach(function(f){\n"
    "          h+='<option value=\"'+f.id+'\"'+(l.foldId===f.id?' selected':'')+'>'+esc(f.icon)+\" \"+esc(f.name)+'</option>';\n"
    "        });\n"
    "        h+='</select></div>';\n"
    "      }\n"
    "      h+='<textarea id=\"en-'+l.id+'\" placeholder=\"备注（可选）\">'+esc(l.note||\"\")+'</textarea>",
    "编辑面板加折叠选择",
)

html = rep(
    html,
    "    l.title=t; l.url=u; l.categoryId=c; l.note=n;\n    saveData().then(function(){renderAll();});",
    "    l.title=t; l.url=u; l.categoryId=c; l.note=n;\n"
    "    var fs=$(\"ef-\"+id);\n"
    "    if(fs&&window.Folds){\n"
    "      var fv=fs.value;\n"
    "      if(fv) window.Folds.addLinkToFold(id,fv); else window.Folds.removeLinkFromFold(id);\n"
    "    }\n"
    "    saveData().then(function(){renderAll();});",
    "编辑保存折叠归属",
)

# ============================================================
# 9) 事件委托：折叠相关动作
# ============================================================
html = rep(
    html,
    "    else if(act===\"engpermgo\"){engTogglePanel(false); switchPanel(\"panel-links\");}\n  });",
    "    else if(act===\"engpermgo\"){engTogglePanel(false); switchPanel(\"panel-links\");}\n"
    "    // ===== 折叠小类 =====\n"
    "    else if(act===\"foldtoggle\"){ window.Folds.toggle(id); }\n"
    "    else if(act===\"foldpickopen\"){ window.Folds.openPopForLink(id); }\n"
    "    else if(act===\"foldpopclose\"){ window.Folds.closePop(); }\n"
    "    else if(act===\"foldpick\"){\n"
    "      var target=window.__foldPopLinkId;\n"
    "      if(!target){ window.Folds.closePop(); return; }\n"
    "      if(id) window.Folds.addLinkToFold(target,id); else window.Folds.removeLinkFromFold(target);\n"
    "      window.Folds.closePop();\n"
    "      saveData().then(function(){ renderAll(); });\n"
    "    }\n"
    "    else if(act===\"foldpopnew\"){\n"
    "      var t2=window.__foldPopLinkId;\n"
    "      if(t2) window.Folds.createFoldAndAssign(t2);\n"
    "    }\n"
    "    else if(act===\"addfold\"){\n"
    "      if(!canEdit()) return;\n"
    "      var nm=$(\"newFoldName\"), ct=$(\"newFoldCat\"), ic=$(\"newFoldIcon\");\n"
    "      if(!nm||!nm.value.trim()) return;\n"
    "      var f=window.Folds.addFold(nm.value, ct?ct.value:\"\", ic?ic.value:\"\\uD83D\\uDD17\");\n"
    "      if(!f) return;\n"
    "      nm.value=\"\";\n"
    "      saveData().then(function(){ renderAll(); });\n"
    "      showToast(\"已创建折叠小类「\"+f.name+\"」\",null,null);\n"
    "    }\n"
    "    else if(act===\"foldrename\"){\n"
    "      var fr=window.Folds.find(id); if(!fr) return;\n"
    "      var nn2=prompt(\"重命名折叠小类\",fr.name);\n"
    "      if(nn2&&nn2.trim()){ window.Folds.renameFold(id,nn2.trim()); saveData().then(function(){renderAll();}); }\n"
    "    }\n"
    "    else if(act===\"foldicon\"){\n"
    "      var fi=window.Folds.find(id); if(!fi) return;\n"
    "      var ni=prompt(\"输入一个图标（emoji 即可）\",fi.icon);\n"
    "      if(ni&&ni.trim()){ window.Folds.setFoldIcon(id,ni.trim()); saveData().then(function(){renderAll();}); }\n"
    "    }\n"
    "    else if(act===\"foldmove\"){\n"
    "      var fm=window.Folds.find(id); if(!fm) return;\n"
    "      var names=S.categories.map(function(c2,i2){ return (i2+1)+\". \"+c2.name; }).join(\"  \");\n"
    "      var pickCat=prompt(\"改到哪个分类？输入序号\\n\"+names,\"1\");\n"
    "      if(!pickCat) return;\n"
    "      var idx2=parseInt(pickCat,10)-1;\n"
    "      if(!(idx2>=0&&idx2<S.categories.length)){ showToast(\"序号无效\",null,null); return; }\n"
    "      window.Folds.moveFoldToCat(id,S.categories[idx2].id);\n"
    "      S.curCat=\"all\";\n"
    "      saveData().then(function(){ renderAll(); });\n"
    "    }\n"
    "    else if(act===\"folddissolve\"){\n"
    "      if(!confirm(\"解散后组内网址会变回普通网址，确认？\")) return;\n"
    "      var n3=window.Folds.deleteFold(id,\"dissolve\");\n"
    "      saveData().then(function(){ renderAll(); });\n"
    "      showToast(\"已解散，\"+n3+\" 个网址已还原\",null,null);\n"
    "    }\n"
    "    else if(act===\"folddelall\"){\n"
    "      if(!confirm(\"这会同时删除组内所有网址，无法恢复，确认？\")) return;\n"
    "      var n4=window.Folds.deleteFold(id,\"delete\");\n"
    "      saveData().then(function(){ renderAll(); });\n"
    "      showToast(\"已删除折叠组及 \"+n4+\" 个网址\",null,null);\n"
    "    }\n"
    "  });",
    "事件委托",
)

# 记录弹层当前操作的链接 id
html = rep(
    html,
    "  // 供折叠小类复用单条卡片渲染\n  window.__renderCard = renderCard;",
    "  // 供折叠小类复用单条卡片渲染\n  window.__renderCard = renderCard;\n"
    "  // 折叠弹层当前操作的网址 id（给 folds.js 复用）\n"
    "  window.__foldPopLinkId = null;",
    "弹层链接 id 变量",
)

# ============================================================
# 10) 启动时：桥接 renderCard + 刷新即折叠
# ============================================================
html = rep(
    html,
    "  checkAuthStatus();\n})();\n</script>\n</body>",
    "  checkAuthStatus();\n"
    "})();\n"
    "</script>\n"
    "<script src=\"folds.js\"></script>\n"
    "<script>\n"
    "// ====== 折叠小类绑定层（在主逻辑之后运行）======\n"
    "(function(){\n"
    "  if(!window.Folds||!window.__S){ console.warn('[folds] 绑定失败'); return; }\n"
    "  var S=window.__S, F=window.Folds;\n"
    "\n"
    "  // 复用主逻辑的卡片渲染\n"
    "  if(typeof window.__renderCard==='function') F.bindRenderCard(window.__renderCard);\n"
    "\n"
    "  // 折叠弹层打开时记录目标链接（事件委托里用）\n"
    "  var origOpen=F.openPopForLink;\n"
    "  F.openPopForLink=function(linkId){\n"
    "    window.__foldPopLinkId=linkId;\n"
    "    return origOpen.call(F,linkId);\n"
    "  };\n"
    "\n"
    "  // 刷新必折叠：清空本次会话的展开记忆\n"
    "  F.collapseAllOnLoad();\n"
    "\n"
    "  // 数据加载完成后重新渲染一次折叠管理区\n"
    "  var origRenderAll=window.renderAll;\n"
    "  window.renderAll=function(){ if(origRenderAll) origRenderAll(); F.renderManager(); };\n"
    "\n"
    "  document.addEventListener('keydown',function(e){ if(e.key==='Escape') F.closePop(); });\n"
    "})();\n"
    "</script>\n"
    "</body>",
    "引入 folds.js",
)

with io.open(PATH, "w", encoding="utf-8") as f:
    f.write(html)

print("✓ index.html 已接入折叠小类功能")
