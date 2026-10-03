/* ===== 内置主题定义 =====
   从 index.html 抽离，便于维护；由 index.html 在启动时读取 window.BUILTIN_THEMES。
   内容与原内嵌版本保持一致。
*/
window.BUILTIN_THEMES = [
  {id:"light",name:"亮色",type:"builtin",vars:null,preview:{bg:"#fff",accent:"#0071e3"}},
  {id:"dark",name:"暗色",type:"builtin",vars:null,preview:{bg:"#000",accent:"#0a84ff"}},
  {id:"auto",name:"跟随系统",type:"builtin",vars:null,preview:{bg:"#808080",accent:"#0071e3"}},
  {id:"ocean",name:"海洋蓝",type:"builtin",vars:{"--bg":"#f0f6ff","--bg2":"#dbeafe","--fg":"#0a1f3c","--fg2":"#5a7a9e","--border":"#b0c8e8","--accent":"#0066cc","--accent-bg":"rgba(0,102,204,.1)","--danger":"#e03030","--card":"#dbeafe","--sidebar-bg":"rgba(240,246,255,.98)","--topbar-bg":"rgba(255,255,255,.92)"},preview:{bg:"#f0f6ff",accent:"#0066cc"}},
  {id:"forest",name:"森林绿",type:"builtin",vars:{"--bg":"#f0faf0","--bg2":"#dcf0dc","--fg":"#1a3a1a","--fg2":"#5a7a5a","--border":"#b0d0b0","--accent":"#2e8b2e","--accent-bg":"rgba(46,139,46,.1)","--danger":"#e03030","--card":"#dcf0dc","--sidebar-bg":"rgba(240,250,240,.98)","--topbar-bg":"rgba(255,255,255,.92)"},preview:{bg:"#f0faf0",accent:"#2e8b2e"}},
  {id:"warm",name:"暖阳橙",type:"builtin",vars:{"--bg":"#fff8f0","--bg2":"#ffeed8","--fg":"#3a2a10","--fg2":"#8a7a5a","--border":"#e8d0a8","--accent":"#e07000","--accent-bg":"rgba(224,112,0,.1)","--danger":"#e03030","--card":"#ffeed8","--sidebar-bg":"rgba(255,248,240,.98)","--topbar-bg":"rgba(255,255,255,.92)"},preview:{bg:"#fff8f0",accent:"#e07000"}},
  {id:"cyber",name:"赛博紫",type:"builtin",vars:{"--bg":"#0d001a","--bg2":"#1a0a2e","--fg":"#e0d0ff","--fg2":"#8a7ab0","--border":"#3a1a5a","--accent":"#bf00ff","--accent-bg":"rgba(191,0,255,.15)","--danger":"#ff3366","--card":"#1a0a2e","--sidebar-bg":"rgba(26,10,46,.98)","--topbar-bg":"rgba(13,0,26,.92)"},preview:{bg:"#0d001a",accent:"#bf00ff"}},
  {id:"rose",name:"玫瑰粉",type:"builtin",vars:{"--bg":"#fff5f7","--bg2":"#ffe0e8","--fg":"#3a1020","--fg2":"#8a5a6a","--border":"#e8b0c0","--accent":"#e0407a","--accent-bg":"rgba(224,64,122,.1)","--danger":"#e03030","--card":"#ffe0e8","--sidebar-bg":"rgba(255,245,247,.98)","--topbar-bg":"rgba(255,255,255,.92)"},preview:{bg:"#fff5f7",accent:"#e0407a"}},
  {id:"slate",name:"石板灰",type:"builtin",vars:{"--bg":"#f0f0f2","--bg2":"#e0e0e4","--fg":"#1a1a2e","--fg2":"#5a5a6e","--border":"#c0c0c8","--accent":"#4a4a6e","--accent-bg":"rgba(74,74,110,.1)","--danger":"#e03030","--card":"#e0e0e4","--sidebar-bg":"rgba(240,240,242,.98)","--topbar-bg":"rgba(255,255,255,.92)"},preview:{bg:"#f0f0f2",accent:"#4a4a6e"}}
];
