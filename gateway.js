// ====== API 网关选优层（多域名故障转移 + 快捷保留区） ======
// 原理：并发探测多个网关域名，选最快可用者，覆盖 API_BASE/AUTH_API/SEARCH_API
// 支持：localStorage 缓存结果（TTL 10分钟）、手动填入自定义订阅地址（快捷保留区）

(function(){
  // 服务 -> 候选网关域名（按优先级，第一位为默认）
  var GATEWAY_POOL = {
    api:  ["https://api.yongjiu.ccwu.cc", "https://api2.yongjiu.ccwu.cc"],
    auth: ["https://auth-api.yongjiu.ccwu.cc", "https://auth-api2.yongjiu.ccwu.cc"],
    search: ["https://search.yongjiu.ccwu.cc", "https://search2.yongjiu.ccwu.cc"]
  };

  // 快捷保留区：用户可手动填写的备用订阅地址（失效时自动切换到这里）
  function getCustom(service){
    try{ return localStorage.getItem('gw_custom_'+service)||''; }catch(e){ return ''; }
  }
  function setCustom(service, url){
    try{ localStorage.setItem('gw_custom_'+service, url||''); }catch(e){}
  }

  // 健康检查：GET /health 或根路径，3 秒超时
  function test(url){
    return new Promise(function(resolve){
      var ctrl = typeof AbortController!=='undefined' ? new AbortController() : null;
      var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); resolve(false); }, 3000);
      var opts = {method:'GET', cache:'no-store'};
      if(ctrl) opts.signal = ctrl.signal;
      fetch(url+'/health', opts)
        .then(function(r){ clearTimeout(timer); resolve(r.ok || r.status===404); })
        .catch(function(){ clearTimeout(timer); resolve(false); });
    });
  }

  // 选优：返回该服务当前最佳网关 URL（同步返回，探测异步缓存）
  var bestCache = {};
  var probing = {};
  function pickBest(service){
    var pool = GATEWAY_POOL[service] || [];
    var custom = getCustom(service);
    if(custom) pool = [custom].concat(pool);

    var cached = bestCache[service];
    if(cached && Date.now()-cached.ts < 10*60*1000) return cached.url;

    var fallback = pool[0] || '';
    if(!probing[service]){
      probing[service] = true;
      var results = [];
      pool.forEach(function(url, i){
        test(url).then(function(ok){
          results.push({url:url, ok:ok, idx:i});
          if(results.length===pool.length){
            var best = results.filter(function(r){return r.ok;}).sort(function(a,b){return a.idx-b.idx;})[0];
            if(best){ bestCache[service] = {url:best.url, ts:Date.now()}; }
            probing[service] = false;
          }
        });
      });
    }
    return fallback;
  }

  // 强制重测（设置面板手动触发）
  function refresh(){
    bestCache = {};
    ['api','auth','search'].forEach(function(s){ probing[s]=false; pickBest(s); });
    return Promise.all([
      test(GATEWAY_POOL.api[0]), test(GATEWAY_POOL.api[1]),
      test(GATEWAY_POOL.auth[0]), test(GATEWAY_POOL.auth[1]),
      test(GATEWAY_POOL.search[0]), test(GATEWAY_POOL.search[1])
    ]);
  }

  window.APIGateway = {
    pick: pickBest,
    getCustom: getCustom,
    setCustom: setCustom,
    pool: GATEWAY_POOL,
    refresh: refresh,
    _cache: bestCache,
    _test: test
  };
})();
