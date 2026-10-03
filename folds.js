/* ===== 折叠小类（Folds）逻辑层 =====
   设计要点：
   1) 折叠组挂在分类之下：分类 → 折叠组 → 网址（三层）
   2) 刷新必折叠：加载时一律按折叠态渲染，展开状态只记在 sessionStorage
   3) 旧数据零迁移：无 folds / 无 foldId 时行为与升级前完全一致
   4) 游客可折叠展开，但不能编辑组
*/
(function(){
  "use strict";

  var S = window.__S;                    // 主状态对象（由 index.html 注入）
  if(!S) { console.warn("[folds] 未找到主状态对象，跳过初始化"); return; }

  // ===== 常量 =====
  var FOLD_ICONS = ["🔗","📁","🧩","⚙️","🧪","🎮","📚","☁️","🛰️","🧭","💠","🧱","🪄","📦"];
  var SESSION_KEY = "fold_open_session";   // 本次会话的展开状态（不写入线上数据）

  // ===== 工具 =====
  function gid(){ return "f_" + Date.now().toString(36) + Math.random().toString(36).substr(2,5); }
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
  function getDomain(u){ try{ return new URL(u).hostname.replace(/^www\./,""); }catch(e){ return String(u||""); } }
  function getFavUrl(u){ return "https://www.google.com/s2/favicons?domain=" + getDomain(u) + "&sz=64"; }
  function getLetter(t){ return String(t||"?").charAt(0).toUpperCase(); }

  // ===== 会话级展开状态 =====
  function loadOpenSet(){
    try{
      var raw = sessionStorage.getItem(SESSION_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    }catch(e){ return []; }
  }
  function saveOpenSet(set){
    try{ sessionStorage.setItem(SESSION_KEY, JSON.stringify(set)); }catch(e){}
  }
  var openSet = loadOpenSet();
  function isOpen(id){ return openSet.indexOf(id) !== -1; }
  function setOpen(id, open){
    var i = openSet.indexOf(id);
    if(open && i === -1) openSet.push(id);
    if(!open && i !== -1) openSet.splice(i,1);
    saveOpenSet(openSet);
  }
  // 折叠态渲染时清空（刷新即折叠）
  function resetAllClosed(){ openSet = []; saveOpenSet(openSet); }

  // ===== 数据访问 =====
  function folds(){ if(!Array.isArray(S.folds)) S.folds = []; return S.folds; }
  function findFold(id){ var f = folds(); for(var i=0;i<f.length;i++){ if(f[i] && f[i].id===id) return f[i]; } return null; }
  function linksInFold(id){ return (S.links||[]).filter(function(l){ return l && l.foldId === id; }); }
  function foldsOfCat(catId){ return folds().filter(function(f){ return f && f.categoryId === catId; }); }
  function foldOfLink(l){ return (l && l.foldId) ? findFold(l.foldId) : null; }

  function normalizeFolds(payload){
    var src = payload && Array.isArray(payload.folds) ? payload.folds : [];
    var out = [];
    for(var i=0;i<src.length;i++){
      var f = src[i];
      if(!f || typeof f !== "object") continue;
      var id = String(f.id || "").trim();
      if(!id) continue;
      out.push({
        id: id,
        name: String(f.name || "未命名折叠").slice(0,60),
        categoryId: String(f.categoryId || (payload&&payload.categories&&payload.categories[0]&&payload.categories[0].id) || "default"),
        icon: String(f.icon || "🔗").slice(0,4),
        collapsed: f.collapsed !== false,
        order: (typeof f.order === "number" && isFinite(f.order)) ? f.order : i
      });
    }
    out.sort(function(a,b){ return (a.order||0) - (b.order||0); });
    S.folds = out;
    return out;
  }

  // 清理孤儿 foldId（分类/组被删后）
  function sanitizeLinkFoldIds(){
    var ids = {};
    folds().forEach(function(f){ ids[f.id] = 1; });
    (S.links||[]).forEach(function(l){
      if(l && l.foldId && !ids[l.foldId]) delete l.foldId;
    });
  }

  // ===== 折叠组操作 =====
  function addFold(name, categoryId, icon){
    name = String(name||"").trim();
    if(!name) return null;
    var cats = S.categories || [];
    if(!categoryId) categoryId = (cats[0] && cats[0].id) || "default";
    var f = {
      id: gid(),
      name: name.slice(0,60),
      categoryId: categoryId,
      icon: String(icon||"🔗").slice(0,4),
      collapsed: true,
      order: folds().length
    };
    folds().push(f);
    return f;
  }
  function renameFold(id, name){
    var f = findFold(id); if(!f) return false;
    name = String(name||"").trim(); if(!name) return false;
    f.name = name.slice(0,60);
    return true;
  }
  function setFoldIcon(id, icon){
    var f = findFold(id); if(!f) return false;
    f.icon = String(icon||"🔗").slice(0,4);
    return true;
  }
  function moveFoldToCat(id, categoryId){
    var f = findFold(id); if(!f) return false;
    f.categoryId = categoryId;
    // 组内链接的 categoryId 跟随组归属，避免出现「组在 A 分类、链接算 B 分类」的错位
    linksInFold(id).forEach(function(l){ l.categoryId = categoryId; });
    return true;
  }
  function deleteFold(id, mode){
    var f = findFold(id); if(!f) return 0;
    var members = linksInFold(id);
    if(mode === "delete") {
      // 连同组内网址一起删除
      var ids = {};
      members.forEach(function(l){ ids[l.id] = 1; });
      S.links = (S.links||[]).filter(function(l){ return !ids[l.id]; });
    }else{
      // 只解散组，网址变回普通网址
      members.forEach(function(l){ delete l.foldId; });
    }
    S.folds = folds().filter(function(x){ return x.id !== id; });
    setOpen(id, false);
    return members.length;
  }
  function addLinkToFold(linkId, foldId){
    var l = null;
    (S.links||[]).forEach(function(x){ if(x.id===linkId) l = x; });
    if(!l) return false;
    var f = findFold(foldId);
    if(!f) return false;
    l.foldId = foldId;
    l.categoryId = f.categoryId;   // 归组即归分类，避免计数错位
    return true;
  }
  function removeLinkFromFold(linkId){
    var l = null;
    (S.links||[]).forEach(function(x){ if(x.id===linkId) l = x; });
    if(!l) return false;
    delete l.foldId;
    return true;
  }

  // ===== 渲染：折叠卡片 =====
  function renderStack(members){
    var chips = members.slice(0,3);
    if(chips.length === 0){
      return '<div class="fold-stack"><div class="fold-chip">∅</div></div>';
    }
    var h = '<div class="fold-stack">';
    // 倒序输出，保证第 1 个成员视觉在最上层（z-index 由 CSS 控制）
    for(var i=0;i<chips.length;i++){
      var l = chips[i];
      h += '<div class="fold-chip">' + esc(getLetter(l.title||getDomain(l.url)));
      h += '<img src="' + esc(getFavUrl(l.url)) + '" loading="lazy" alt="" onerror="this.remove()">';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  function renderFold(f, opts){
    opts = opts || {};
    var members = linksInFold(f.id);
    var open = isOpen(f.id);
    var cat = (S.categories||[]).filter(function(c){ return c.id===f.categoryId; })[0];
    var catName = cat ? cat.name : "未分类";
    var editable = !!(window.canEdit && window.canEdit());

    var h = '<div class="fold-card' + (open ? " open" : "") + '" data-fold-id="' + esc(f.id) + '">';
    h += '<button class="fold-head" data-act="foldtoggle" data-id="' + esc(f.id) + '" aria-expanded="' + (open?"true":"false") + '">';
    h += renderStack(members);
    h += '<div class="fold-info">';
    h += '<div class="fold-name"><span class="fold-emoji">' + esc(f.icon) + '</span>' + esc(f.name) + '</div>';
    h += '<div class="fold-meta"><span>' + members.length + ' 个网址</span>';
    if(!opts.hideCat){ h += '<span class="dot">·</span><span>' + esc(catName) + '</span>'; }
    h += '</div></div>';
    h += '<span class="fold-chevron">▶</span>';
    h += '</button>';
    h += '<div class="fold-body" data-fold-body="' + esc(f.id) + '"><div class="fold-body-inner">';
    if(members.length === 0){
      h += '<div class="fold-empty">这个折叠小类还是空的' + (editable ? '，可在下方添加网址后点「折叠」归入' : '') + '</div>';
    }else{
      h += '<ul class="link-list">';
      members.forEach(function(l){ h += renderCard(l); });
      h += '</ul>';
    }
    h += '</div></div></div>';
    return h;
  }

  // 由 index.html 提供（渲染单条网址卡片）
  var renderCard = function(){ return ""; };
  function bindRenderCard(fn){ if(typeof fn === "function") renderCard = fn; }

  // ===== 展开/折叠动画（与侧栏同一套 max-height 写法）=====
  function applyFoldBodyHeight(card, body, open, animate){
    if(!card || !body) return;
    if(!animate){ body.style.transition = "none"; }
    if(open){
      body.style.maxHeight = body.scrollHeight + "px";
      var done = false;
      var finish = function(){
        if(done) return; done = true;
        if(card.classList.contains("open")) body.style.maxHeight = "none";
        body.removeEventListener("transitionend", finish);
      };
      body.addEventListener("transitionend", finish);
      setTimeout(finish, 300);
    }else{
      if(body.style.maxHeight === "none" || !body.style.maxHeight){
        body.style.maxHeight = body.scrollHeight + "px";
        void body.offsetHeight;
      }
      body.style.maxHeight = "0px";
    }
    if(!animate){ void body.offsetHeight; body.style.transition = ""; }
  }

  function toggleFold(id){
    var f = findFold(id); if(!f) return;
    var card = document.querySelector('.fold-card[data-fold-id="' + id + '"]');
    var body = document.querySelector('.fold-body[data-fold-body="' + id + '"]');
    if(!card || !body) return;
    var willOpen = !card.classList.contains("open");
    card.classList.toggle("open", willOpen);
    setOpen(id, willOpen);
    var head = card.querySelector(".fold-head");
    if(head) head.setAttribute("aria-expanded", willOpen ? "true" : "false");
    applyFoldBodyHeight(card, body, willOpen, true);
  }

  // 刷新页面后：所有折叠组按折叠态渲染（展开状态不保留）
  function collapseAllOnLoad(){
    resetAllClosed();
  }

  // ===== 「折叠到」弹层 =====
  function closePop(){
    var el = document.getElementById("foldPopOverlay");
    if(el) el.remove();
  }
  function openPopForLink(linkId){
    closePop();
    var l = null;
    (S.links||[]).forEach(function(x){ if(x.id===linkId) l = x; });
    if(!l) return;
    var editable = !!(window.canEdit && window.canEdit());
    if(!editable) return;

    var h = '<div class="fold-pop-overlay" id="foldPopOverlay">';
    h += '<div class="fold-pop-mask" data-act="foldpopclose"></div>';
    h += '<div class="fold-pop" role="dialog" aria-label="折叠到">';
    h += '<div class="fold-pop-head"><span>🗂 折叠到…</span><button data-act="foldpopclose" title="关闭">✕</button></div>';
    var cur = foldOfLink(l);
    h += '<div class="fold-pop-body">';
    h += '<div class="fold-pop-sec">' + esc(l.title || getDomain(l.url)) + '</div>';

    var list = folds();
    if(list.length){
      h += '<div class="fold-pop-sec">选择折叠小类</div>';
      list.forEach(function(f){
        var cat = (S.categories||[]).filter(function(c){ return c.id===f.categoryId; })[0];
        var cnt = linksInFold(f.id).length;
        h += '<button class="fold-pop-item" data-act="foldpick" data-id="' + esc(f.id) + '">';
        h += '<span>' + esc(f.icon) + '</span>';
        h += '<span class="fold-pop-name">' + esc(f.name) + '</span>';
        h += '<span class="fold-pop-sub">' + esc(cat ? cat.name : "未分类") + ' · ' + cnt + '</span>';
        if(cur && cur.id === f.id) h += '<span class="fold-pop-sub">✓</span>';
        h += '</button>';
      });
    }else{
      h += '<div class="fold-pop-sec">还没有折叠小类</div>';
    }
    if(cur){
      h += '<button class="fold-pop-item" data-act="foldpick" data-id=""><span>↩️</span><span class="fold-pop-name">移出折叠，变回普通网址</span></button>';
    }
    h += '<button class="fold-pop-new" data-act="foldpopnew">＋ 新建折叠小类并放入</button>';
    h += '</div></div></div>';

    var wrap = document.createElement("div");
    wrap.innerHTML = h;
    document.body.appendChild(wrap.firstChild);
  }
  function createFoldAndAssign(linkId){
    var name = prompt("折叠小类名称（例如：API 中转站）");
    if(name === null) return;
    name = String(name).trim();
    if(!name){ if(window.showToast) window.showToast("名称不能为空", null, null); return; }
    var l = null;
    (S.links||[]).forEach(function(x){ if(x.id===linkId) l = x; });
    var catId = l ? l.categoryId : ((S.categories[0]&&S.categories[0].id)||"default");
    var f = addFold(name, catId, FOLD_ICONS[folds().length % FOLD_ICONS.length]);
    if(!f) return;
    addLinkToFold(linkId, f.id);
    closePop();
    if(window.saveData) window.saveData().then(function(){ if(window.renderAll) window.renderAll(); });
    if(window.showToast) window.showToast("已创建「" + f.name + "」并放入", null, null);
  }

  // ===== 折叠小类管理 =====
  function renderFoldManager(){
    var box = document.getElementById("foldListContainer");
    if(!box) return;
    var editable = !!(window.canEdit && window.canEdit());
    var h = "";

    if(editable){
      h += '<div class="fold-add-form">';
      h += '<input type="text" id="newFoldName" placeholder="折叠小类名称..." maxlength="60">';
      h += '<select id="newFoldCat">';
      (S.categories||[]).forEach(function(c){
        h += '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
      });
      h += '</select>';
      h += '<select id="newFoldIcon">';
      FOLD_ICONS.forEach(function(ic){ h += '<option value="' + ic + '">' + ic + '</option>'; });
      h += '</select>';
      h += '<button data-act="addfold">添加</button>';
      h += '</div>';
    }

    var list = folds();
    if(list.length === 0){
      h += '<div class="empty-state">还没有折叠小类' + (editable ? '，在上方添加' : '') + '</div>';
      box.innerHTML = h;
      return;
    }

    list.forEach(function(f){
      var members = linksInFold(f.id);
      var cat = (S.categories||[]).filter(function(c){ return c.id===f.categoryId; })[0];
      h += '<div class="fold-item">';
      h += '<div class="fold-item-info">';
      h += '<div class="fold-item-name"><span>' + esc(f.icon) + '</span>' + esc(f.name) + '</div>';
      h += '<div class="fold-item-sub">' + esc(cat ? cat.name : "未分类") + ' · ' + members.length + ' 个网址</div>';
      h += '</div>';
      if(editable){
        h += '<div class="fold-item-actions">';
        h += '<button data-act="foldrename" data-id="' + esc(f.id) + '">重命名</button>';
        h += '<button data-act="foldicon" data-id="' + esc(f.id) + '">换图标</button>';
        h += '<button data-act="foldmove" data-id="' + esc(f.id) + '">改分类</button>';
        h += '<button class="danger" data-act="folddissolve" data-id="' + esc(f.id) + '">解散</button>';
        h += '<button class="danger" data-act="folddelall" data-id="' + esc(f.id) + '">删除组及网址</button>';
        h += '</div>';
      }
      h += '</div>';
    });
    box.innerHTML = h;
  }

  // ===== 供 index.html 调用的对外接口 =====
  window.Folds = {
    // 生命周期
    normalize: normalizeFolds,
    sanitize: sanitizeLinkFoldIds,
    collapseAllOnLoad: collapseAllOnLoad,
    resetAllClosed: resetAllClosed,

    // 渲染
    render: renderFold,
    renderManager: renderFoldManager,
    bindRenderCard: bindRenderCard,
    toggle: toggleFold,
    applyBodyHeight: applyFoldBodyHeight,

    // 弹层
    openPopForLink: openPopForLink,
    closePop: closePop,
    createFoldAndAssign: createFoldAndAssign,

    // 数据
    folds: folds,
    find: findFold,
    linksInFold: linksInFold,
    foldsOfCat: foldsOfCat,
    foldOfLink: foldOfLink,
    addFold: addFold,
    renameFold: renameFold,
    setFoldIcon: setFoldIcon,
    moveFoldToCat: moveFoldToCat,
    deleteFold: deleteFold,
    addLinkToFold: addLinkToFold,
    removeLinkFromFold: removeLinkFromFold,
    isOpen: isOpen,
    icons: FOLD_ICONS
  };
})();
