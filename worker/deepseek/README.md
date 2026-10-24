# deepseek-web —— DeepSeek 网页版反代（Cloudflare Worker）

把 `chat.deepseek.com` 的网页私有接口，反代成 **OpenAI 兼容**接口，
供 `ai.html` 里内置的「DeepSeek 网页版」提供商直接调用。

> 逻辑参考开源实现：`snake-aabb-wtf/deepseek-web2api-free`、`Fly143/deepseek-free-api`。

## 它解决什么问题

DeepSeek 官方 API（`api.deepseek.com`）要充值，而网页版 `chat.deepseek.com` 只要登录就能免费用。
但网页版接口有三道门槛，浏览器没法直接用：

1. **CORS**：`chat.deepseek.com` 不允许跨域，前端直连必被拦。
2. **PoW 工作量证明**：每次请求都要带 `X-DS-PoW-Response` 头，是 `DeepSeekHashV1` 挑战，
   需要用官方前端同款的 WASM（`sha3_wasm_bg.wasm`）现场解算，不是简单 hash。
3. **私有协议**：请求体字段（`chat_session_id` / `parent_message_id` / `prompt` …）和
   响应是自定义 SSE 事件流，不是 OpenAI 格式。

本 Worker 把这三件事全包了：**对外是标准 OpenAI 接口，对内自动 PoW + 协议转换。**

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回已配置 token 数量 |
| GET | `/v1/models` | 模型列表（`deepseek-chat`、`deepseek-reasoner`） |
| POST | `/v1/chat/completions` | 对话，支持 `stream: true/false` |

请求/响应完全遵循 OpenAI Chat Completions 规范，所以任何 OpenAI SDK 都能直接指向它。

## 模型与能力

| model | 深度思考 | 说明 |
|---|---|---|
| `deepseek-chat` | 关（`THINKING=auto` 时） | 日常对话，快 |
| `deepseek-reasoner` | 开 | 思考过程放在 `reasoning_content` 字段 |

**不支持 function calling**（工具调用）——网页版没有这个能力。
前端 `ai.html` 已把该提供商标记为 `noTools: true`，不会下发工具定义。

## 部署

```bash
cd worker/deepseek

# 1. 配置 token（换成自己的网页版 token）
npx wrangler secret put DEEPSEEK_TOKENS
#    多个 token 用英文逗号分隔，可做账号池轮询

# 2. 可选：本代理的访问口令（不设则任何拿到域名的人都能调用）
npx wrangler secret put PROXY_KEY

# 3. 部署
npx wrangler deploy
```

部署后在 Cloudflare Dashboard 给这个 Worker 加自定义域路由：

```
ai.yongjiu.ccwu.cc/dsweb*  ->  deepseek-web（路径路由，复用已有子域，无需新 DNS）
```

该域名必须和 `ai.html` 里的常量一致：

```js
const DS_WEB_BASE = 'https://ai.yongjiu.ccwu.cc/dsweb/v1';
```

### 拿网页版 token

1. 浏览器登录 `chat.deepseek.com`
2. 打开开发者工具 → Console，执行：

```js
JSON.parse(localStorage.getItem("userToken")).value
```

3. 输出形如 `xxxxxxxx...xxxx::47`。**只有 `::` 之前的部分是 token 本体**，
   `::47` 是复制时带出的噪声，不是 token 的一部分。

## 换 token 只改这一个地方

**改 `ai.html` 没有任何用。** Worker 只读自己的 `DEEPSEEK_TOKENS` secret，
前端发来的 `Authorization` 头它不看（除非你另外配了 `PROXY_KEY` 做访问口令校验）。
`ai.html` 里那个提供商的 `key` 字段保持为空是正确的。

```bash
cd worker/deepseek
npx wrangler secret put DEEPSEEK_TOKENS   # 粘贴新 token，回车
npx wrangler deploy
```

secret 是整串覆盖，不需要先删除。多个 token 用英文逗号分隔，失效一个会自动换下一个。

### token 会过期吗

**token 本身不含有效期**（解码后是 48 字节随机数据，没有时间戳）。
它失效的可能性有三种，都发生在 DeepSeek 服务端：

1. 你在网页版**退出登录** —— 立即失效
2. 你在网页版**改密码** —— 旧会话通常失效
3. 官方**主动吊销**长期不活跃的会话

没有可预测的固定时长，所以不承诺「永久有效」。判断当前 token 是否还活着：

```bash
# 1) Worker 是否部署好、secret 有没有配上（只看条数，不验证 token 有效性）
curl https://ai.yongjiu.ccwu.cc/dsweb/health
# {"status":"ok","tokens":1,"model":"deepseek-chat"}   ← tokens 为 0 说明 secret 没配

# 2) token 本身是否还有效（直连 DeepSeek，不经过 Worker）
curl -H "Authorization: Bearer <TOKEN>" https://chat.deepseek.com/api/v0/users/current
# 返回 code:0 + 账号信息 = 有效；返回 401/403 = 已失效
```

失效了就回到上面「换 token 只改这一个地方」重新设置。

## 配置项（`wrangler.toml` 的 `[vars]`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ALLOW_ORIGIN` | 见文件 | 允许跨域的前端来源，英文逗号分隔 |
| `THINKING` | `auto` | `auto` 按 model 名判断 / `enabled` / `disabled` |
| `SEARCH` | `auto` | 是否开启联网搜索：`auto` / `enabled` / `disabled` |

## 上游协议要点（改代码时看这里）

```
BASE = https://chat.deepseek.com
请求头：Authorization: Bearer <token>
        x-client-version: 2.3.0 / x-client-platform: web
        Origin + Referer: https://chat.deepseek.com
        X-DS-PoW-Response: base64(JSON{algorithm,salt,challenge,answer,signature,target_path})
```

三个端点：

1. `POST /api/v0/chat/create_pow_challenge` — 拿挑战
2. `POST /api/v0/chat_session/create` — 建会话，取 `chat_session.id`
3. `POST /api/v0/chat/completion` — 发消息，返回 SSE 事件流

**SSE 正文解析有三种形态**（`makeParser()` 已全部处理，这是最容易踩坑的地方）：

```jsonc
// 1. 快照：新 fragment 开始
{"v":{"response":{"fragments":[{"id":2,"type":"THINK","content":"We"}]}}}

// 2. 追加整个 fragment 数组（思考→正文时用它切换段）
{"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"2"}]}

// 3. 段内增量碎片
{"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
{"v":" answer"}
```

> 踩坑记录：只认第 1 种会导致正文被截断（只回「我是」就停）；
> 把第 2 种的 JSON 数组当正文追加，会让思考内容混进正文、`content` 变空。
> 两者都已修复并有回归测试覆盖。

## 本地自测（不部署也能验证）

```bash
# 模拟 Workers 环境：把 wasm 的导入方式换成本地读文件
cp deepseek-web.js _t.mjs
sed -i "s|^import wasmModule from './sha3_wasm_bg.wasm';|import { readFileSync } from 'node:fs';\nconst wasmModule = readFileSync('./sha3_wasm_bg.wasm');|" _t.mjs
sed -i "s|^export default {|const HANDLER = {|" _t.mjs
echo 'export default HANDLER;' >> _t.mjs

cat > _r.mjs <<'EOF'
import handler from './_t.mjs';
const env = { DEEPSEEK_TOKENS: '<你的token>', ALLOW_ORIGIN: '*' };
const r = await handler.fetch({
  url: 'https://w/v1/chat/completions', method: 'POST',
  headers: new Headers({}),
  json: async () => ({ model: 'deepseek-chat', stream: false,
    messages: [{ role: 'user', content: '用一句话介绍你自己' }] }),
}, env);
console.log(await r.text());
EOF

node _r.mjs
```

## 安全提醒

- `DEEPSEEK_TOKENS` 一定要走 `wrangler secret put`，**不要写进 `wrangler.toml`**（会被提交到仓库）。
- 该 token 等同你的 DeepSeek 账号登录态，泄露后请立刻在网页版退出登录使其失效。
- 建议设置 `PROXY_KEY`，避免被陌生人白嫖你的额度。
