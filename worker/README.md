# vault-sync Worker（Cloudflare Workers KV）· 部署说明

密码库密文同步后端。**只存密文**，服务端不做任何解密。

部署步骤：

npm i -g wrangler && wrangler login

wrangler kv namespace create VAULT_KV → 复制返回的 id 填入 wrangler.toml

把 vault-sync.js 与 wrangler.toml 放在同一目录，wrangler deploy

wrangler secret put SYNC_KEY → 粘贴一个高强度随机串（例如 openssl rand -hex 32 的输出）

记录部署后的 URL，例如 https://vault-sync.<你的子域>.workers.dev/vault

在密码库面板点同步栏的 ⚙️，URL 填上一步的地址，密钥填第 4 步的 SYNC_KEY

之后所有同步优先走这个 Worker；一旦它 401/超时/断网，前端自动回落到 GitHub 通道

手动验证清单
1. 上传：云端确实只存密文

管理员登录 → 密码库 → 创建主密码 → 新建一条 GitHub / myuser / mypassword123。

点「⬆️ 上传到云端」。等 ✅ 已上传到云端。

通道一：打开 https://github.com/xdd2024030565-spec/lite1/blob/main/vault.json，或直接 https://raw.githubusercontent.com/xdd2024030565-spec/lite1/main/vault.json。

应看到 meta.salt（base64）、meta.iter（600000）、meta.ver.iv/ct、cipher.iv/ct、updatedAt。

全文搜索 mypassword123、myuser、GitHub 必须 0 命中。

通道二：若配置了 Worker，curl -H "Authorization: Bearer <KEY>" https://<worker>/vault 返回同一份 JSON，内容同样是密文。用 curl 不带 Authorization 应返回 {"error":"Unauthorized"} 401。

2. 拉取：模拟多设备

上传完成后，在浏览器 DevTools Console 执行：

js
复制
下载
localStorage.removeItem('vault_cipher');
localStorage.removeItem('vault_meta');
location.reload();

重新进入密码库 → 显示「创建密码库」（因为本地 meta 被清了）。不要创建。

回到 Console 手工恢复 meta（模拟“第二台设备已用相同主密码创建过”）——或者更简单：直接测试下列路径。

更真实的测试：用另一个浏览器 profile（或隐身窗口）打开同一站点，管理员登录 → 密码库 → 先创建一次主密码（生成本地 meta） → 点「⬇️ 从云端拉取」。

若两边主密码相同：应该弹「本地与云端时间接近…」或直接覆盖，随后列表出现 GitHub 条目，说明密文成功解密。

若两边主密码不同：会提示「云端使用不同加密参数，请用主密码重新解锁」，然后回到上锁状态，输入正确主密码后可见条目。

3. 冲突选择

在同一浏览器：解锁密码库，记下当前时间。

上传到云端（云端 updatedAt=T1）。

立刻在本地新建一条，保存（本地 updatedAt=T2，T2−T1 < 5s）。

点「⬇️ 从云端拉取」→ 必须弹出 confirm 框询问是否用云端覆盖；点取消则不改变本地数据。

把本地时间戳往前调（DevTools 里 localStorage.vault_local_ts = String(Date.now() - 3600000)），再拉取 → 因为本地更旧，不再弹框，直接覆盖。

4. 离线降级

DevTools → Network → 切到 Offline。

新建/编辑/删除条目 → 本地照常保存（vault_cipher 更新，vault_local_ts 更新），不得卡 UI。

点「⬆️ 上传到云端」→ 顶部 toast 提示 上传失败：...，本地数据仍在。

关闭 Offline → 点「⬆️ 上传到云端」→ 成功。

若开启了「☁️ 自动同步」，离线时保存触发的自动同步静默失败（无 toast），恢复网络后再编辑一次即会同步。

5. 自动同步

打开「☁️ 自动同步」→ 同步栏右侧出现 本地更新：<时间> 且变为 accent 色。

新建一条，保存 → 3 秒内应在 Network 面板看到一次 GET .../vault.json 或 GET <worker>/vault 与一次 PUT。

关闭开关 → 再新建一条，等待 5 秒，Network 面板不应有任何同步请求。

上锁 → 自动同步停止（因为 V.unlocked=false）。

6. 零知识红线复核

在 Network 面板过滤所有请求，逐一查看 request/response body。

全文搜索主密码、任意条目明文（如 mypassword123）→ 任何请求的 body 都不得命中。

localStorage 里只应有：vault_meta（salt/iter + 密文验证块）、vault_cipher（密文）、vault_local_ts（明文时间戳）、vault_sync_enabled、可选的 vault_sync_url、vault_sync_key。没有明文条目，没有派生密钥。

上锁后再看 DevTools Console：V.key、V.items 应为 null。
