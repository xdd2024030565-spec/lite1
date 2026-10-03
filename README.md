# 网址储存项目

用于储存和管理网址。

## 访问地址

- 🚀 **国内加速地址（帽子云）**: https://lite1-3d8c30u.maozi.io/
- 📦 GitHub Pages 原始地址: https://xdd2024030565-spec.github.io/lite1/

## 加速方案

通过帽子云（maoziyun）部署，国内访问速度大幅提升。
- 帽子云部署地址: https://lite1-3d8c30u.maozi.io/

## Cloudflare 加速（备用）

通过 Cloudflare Worker 反向代理 + CDN 缓存加速。
- Worker 代理地址: https://wangzhi-proxy.xdd2024030565.workers.dev/
- 自定义域名: https://nav.yongjiu.ccwu.cc/

## 折叠小类（Folds）

在分类之下提供一层「折叠小类」，用于收纳不重要 / 重复的网址。

- **折叠态**：只显示堆叠的网站图标 + 折叠小类名称 + 数量，点击展开。
- **展开态**：就地渲染组内网址卡片，操作与普通网址完全一致。
- **刷新后自动折叠**：每次加载一律按折叠态渲染；展开状态仅记忆在本次会话（sessionStorage），不会写回线上数据。

### 数据结构

`links.json` 在 `categories` 之平级新增 `folds` 数组：

```json
"folds": [
  {
    "id": "f_xxxxxxxx",
    "name": "API 中转站",
    "categoryId": "mtpf5a1lzn0d3",
    "icon": "🔗",
    "collapsed": true,
    "order": 0
  }
]
```

网址对象新增可选字段 `foldId`（为空或缺省 = 普通网址，行为与升级前完全一致）：

```json
{ "id": "...", "url": "...", "title": "...", "categoryId": "...", "foldId": "f_xxxxxxxx" }
```

旧数据无需迁移，缺失 `folds` / `foldId` 时自动按普通网址处理。
