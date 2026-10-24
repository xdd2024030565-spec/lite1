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

### DeepSeek 网页版（内置）

`ai.html` 里内置了一个 **不可删除** 的「DeepSeek 网页版」提供商，置顶但不用作默认。
它通过自建 Cloudflare Worker 反代 `chat.deepseek.com`，把网页版免费额度转成 OpenAI 兼容接口。

- 反代代码：`worker/deepseek/deepseek-web.js`（含 PoW WASM 求解）
- 部署说明：`worker/deepseek/README.md`
- 不支持的：**function calling**（网页版没有工具能力），前端已标记 `noTools`
- token 有效期约 24 小时，过期需重新获取并更新 `DS_WEB_TOKEN`（或在 ai.html 里直接改）

```bash
cd worker/deepseek
npx wrangler secret put DEEPSEEK_TOKENS   # 网页版 token，多个用逗号分隔
npx wrangler deploy
```
