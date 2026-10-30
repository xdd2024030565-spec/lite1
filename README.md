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

## AI 助手（ai.html）

内置多提供商对话，支持工具调用、MCP、流式输出。

### 界面与交互（2026-10-31 打磨）

- **欢迎屏**：新建/空对话不再是一片空白，而是给出当前模型、配置提示与四张入口卡（模型与提供商 / 能力市场 / 技能 / 内置工具）＋快捷操作；未配置 Key 时顶部有明确提示条
- **主题切换可用**：右上角 `◐` 在 深色 → 浅色 → 跟随系统 之间循环。此前该按钮**完全没有绑定事件**，`data-theme` 恒为 `auto`，而样式表只写了 `[data-theme=light]`，浅色主题根本进不去
- **顶栏自适应**：窄屏（≤680px）隐藏标题文字与 CTX 芯片（顶部细条已表示用量）、NEW/SETTINGS 收成图标按钮，保证不换行不溢出；按钮高度统一 ≥30px 便于点按
- **消息操作**：每条消息悬停（触屏常显）出现 复制 / 重新生成 / 删除，用户消息另有 编辑重发
- **会话列表**：显示消息条数，支持重命名；**删除前二次确认**（对话只存本机，误触即永久丢失）
- **连点新建不再堆空对话**：当前对话本来就空时直接复用
- **导出对话**：会话面板「导出」把当前对话存成 Markdown（含思考过程与工具调用）
- **快捷键**：`Enter` 发送 · `Shift+Enter` 换行 · `Esc` 停止生成 · `Ctrl/Cmd+K` 新对话 · `/` 聚焦输入框
- **回到底部**：向上翻阅历史时右下角出现悬浮按钮

### 顺带修掉的问题

- 4 个从未定义的 CSS 变量（`--danger`/`--fg2`/`--bg2`/`--border`，共 27 处引用），导致**错误提示不变红、工具结果底色透明、思考框没边框**；已统一别名为现行设计令牌，随主题切换
- 顶栏标题在窄屏被挤到折行，把 48px 顶栏撑破（`AI Console` 断成两行）；已加 `white-space:nowrap` 并在窄屏隐藏
- 状态条没有「已配置 / 未配置」的视觉区分（`.chip.off` 从未定义）；现用状态点 + 虚线边框区分，点击可直达模型页
- `#toolStatus` 元素不存在，工具数量统计永远不显示；已在模型面板补上
- 模型**返回空响应**时界面毫无反应（用户只看到自己那句话悬着）；现明确提示并给出重试
- 流式接口返回非 SSE（部分代理出错时回 200 + 普通 JSON）会抛「r.body 为空」；已兜底解析
- 只有思考过程（`reasoning_content`）的阶段没有实时反馈，界面像卡住；现在同样会刷新

### DeepSeek 网页版（内置）

`ai.html` 里内置了一个 **不可删除** 的「DeepSeek 网页版」提供商，置顶但不用作默认。
它通过自建 Cloudflare Worker 反代 `chat.deepseek.com`，把网页版免费额度转成 OpenAI 兼容接口。

- 反代代码：`worker/deepseek/deepseek-web.js`（含 PoW WASM 求解）
- 部署说明：`worker/deepseek/README.md`
- 不支持的：**function calling**（网页版没有工具能力），前端已标记 `noTools`
- **token 在 Worker 的 secret 里，不在前端**。换 token 只改 `DEEPSEEK_TOKENS`，改 `ai.html` 无效
- token 本身无有效期，只要不在网页版退出登录 / 改密码 / 被官方吊销就一直可用

```bash
cd worker/deepseek
npx wrangler secret put DEEPSEEK_TOKENS   # 网页版 token，多个用逗号分隔
npx wrangler deploy
```
