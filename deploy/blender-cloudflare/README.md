# Blender Cloudflare 控制服务

2026-10-11：用户选择此方案，ECS 购买已搁置。实现和本机 workerd 验证已完成，**尚未部署到 Cloudflare，也未接入网站公开入口**。首次部署被 Wrangler 的必需凭据检查拦住，没有创建 Worker 或域名。真实 TOS、火山暂停/恢复和两个实例并行仍待验收。

## 分工

- 网站保留 Vercel 部署和现有匿名工作区身份；服务端签发短期 API/桌面票据。
- Workers 接收短请求；`BlenderPool` Durable Object 的 SQLite 保存一个受限资源池的会话、操作、检查点指针、批次和额度。当前全局 4 个、每工作区 3 个活跃名额。
- 每会话一个 `BlenderDesktop` Durable Object，转发桌面 HTTP 和二进制 WebSocket；一个手工写入连接或两个批次只读连接。不会把桌面流量串到资源池协调器。
- 定制 Blender 仍从固定 managed 镜像在火山 veFaaS 沙箱启动。程序放镜像仓库，工程和 GLB 放现有私有 TOS 桶。
- 原 `deploy/blender-service` 是 Bun/Node/Linux 适配器，继续可用，但不是此方案的部署前置条件。

平台 Alarm 在外部 I/O 前持久化下一次唤醒；Cron 每分钟从平台调用资源池 `wake`。它们驱动任务闸门中止超时请求，不依赖浏览器心跳或本进程 `setTimeout` 才能纠错。操作先落盘后发请求；结果未知时核对回执或隔离，不自动重发可能付费的创建、规划和 Python 命令。服务重新加载时读取 SQLite 和沙箱回执恢复。

桌面资产请求限制为 4 MiB（HTML 2 MiB）、每会话最多 8 个同时请求；画面走 WebSocket。HTTP/握手预算 30 秒，桌面 Alarm 和资源池 Cron 都会驱动超时中止。保存前撤销旧桌面连接，保存期间拒绝新连接。

文件采用分块传输，不把最大 256 MiB 工程装入 Workers 内存：先校验沙箱不可变文件，再以定长流上传 TOS，再下载核对 SHA-256，最后保存和回读 manifest，才提交检查点或产物指针。GLB 限定自包含三角形和 FLOAT/VEC3 顶点，检查有限坐标、边界和非空几何；拒绝外部纹理、稀疏顶点、压缩扩展与非三角图元。JSON 元数据最多 2 MiB。现有 managed 镜像的文件 GET/PUT 接口可复用，无需为了 Cloudflare 更换定制 Blender。

## 生产配置

`wrangler.jsonc` 已填写实际北京应用、预热镜像 ID、摘要、APIG 入口和 TOS 桶。`BLENDER_PAUSE_ENABLED=0` 是生产分配闸门；未经真实暂停/恢复验收，不将其改为 1。

首次部署必须提供以下服务端 Secrets，不能提交 Git、发到聊天或使用 `VITE_` 前缀：

| Secret | 用途 |
| --- | --- |
| `BLENDER_SERVICE_SECRET` | 至少 32 字符随机值，用于短期身份签名和沙箱凭据加密；Vercel 服务端必须使用相同值，保留安全备份 |
| `VOLC_ACCESSKEY` / `VOLC_SECRETKEY` | 专用 IAM 用户，用于沙箱创建、列表、暂停、恢复和生命周期管理；先在官方控制台确认动作与资源范围 |
| `TOS_ACCESS_KEY` / `TOS_SECRET_KEY` | 专用桶范围凭据，只需要该桶 Blender 对象前缀的 GetObject/PutObject；禁止公共 ACL |
| `VOLC_KEY` | 方舟模型调用密钥，用于后台批次规划；使用既有模型和每日调用准入 |

不要授予账号管理员或全产品权限来绕过访问失败。`iam-policy.review.json` 记录已获用户批准的策略：五个沙箱动作已在官方编辑器确认，但选择指定资源时没有可选资源，故沙箱 `Resource=*` 配合北京地域条件，不能宣称只授权 ChatSpace。TOS 则限定本桶 `blender/*` 的 GetObject/PutObject。北京条件与对象权限需用实际服务调用验收；授权失败时不自动扩大范围。2026-10-11 已创建 `ChatSpaceBlenderCloudflare`，专用用户 `chatspace-blender-cloudflare`（96763875）只绑定此策略，控制台登录关闭，密钥列表为空；密钥创建已交由用户亲自完成。本机已存在模型凭据，尚无沙箱/TOS 服务凭据，也没有上传任何凭据。

新 Worker 的必需 Secrets 要和首次部署同时提供。用仓库外的权限 0600 JSON/ dotenv 文件保存真实值，然后运行：

```sh
cd deploy/blender-cloudflare
../../node_modules/.bin/wrangler deploy --secrets-file /absolute/path/outside/repo/blender-secrets.json
```

部署脚本不会自动购买套餐。2026-10-11 控制台确认当前 Workers Free；SQLite Durable Objects 可用于受限试用。正式扩容前核对当日 CPU、请求、存储和桌面连接时长用量，避免免费额度耗尽后任务推进受阻。桌面使用常规双向代理而非 Hibernation，不能宣称长连接没有计算费用；Cloudflare 也不是火山费用的人民币账单封顶。参考[平台限制](https://developers.cloudflare.com/durable-objects/platform/limits/)与[计费规则](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

准备使用 `blender.junwei.cool` 的 Custom Domain，已确认该 DNS 名未占用，但尚未发布。主网站 `www.junwei.cool` 与它同站，符合 Strict 桌面 Cookie 策略。独立 Vercel 预览域和 workers.dev 跨站 iframe 不能当作生产桌面验收入口。公网只暴露 `/health`、有票据的 `/v1/*` 和 `/desktop/*`；内部 RPC 不映射 URL。日志去掉查询参数并关闭自动请求日志，避免记录桌面 ticket 和 TOS 签名。

`BLENDER_POOL` 是部署级资源池身份。改变它会创建独立额度账本，不能把它作为用户输入，也不能靠改名逃逸预算；生产升级须保留当前名称和两份 Durable Object 绑定/迁移。当前没有将旧 Bun SQLite 导入云端，也没有真实云端任务要迁移。

## 验证与切换顺序

```sh
PATH="$HOME/.bun/bin:$PATH" BLENDER_ENABLED=0 bun run check
cd deploy/blender-cloudflare
../../node_modules/.bin/wrangler deploy --dry-run
```

2026-10-11 完整检查退出 0：app 953、chat 651、Cloudflare 9 项全部通过，类型检查和网站构建通过。Cloudflare 测试使用真实本机 workerd/SQLite、虚构凭据和模拟供应商，不证明真实公网/TOS 成功。覆盖事务嵌套与回滚、并发额度、未知操作和付费规划恢复、桌面权限/保存期间拒绝、Alarm 续调度、逐字节 GLB 校验、256 MiB 分块 hash、TOS 上传和回读后才提交指针、死定时器外部中止，以及 Worker→DO HTTP Upgrade 的真实二进制往返、单连接限制和撤销。WebSocket 响应不能通过 RPC 克隆，故桌面使用 DO 的 HTTP binding；控制服务之间继续使用 RPC。

上线顺序：专用凭据与权限 → 暂停邀测 → 部署受保护 Worker → 一个短期 managed 实例的 TOS 保存/回读/恢复 → 两实例隔离并行 → 关闭网页与 Worker 重启恢复 → 真实 Chrome 桌面输入/撤销 → 网站受控入口。验收前不给 Vercel 添加 `BLENDER_SERVICE_URL`，公开分配继续关闭。最后将 Vercel 服务端 URL 设为 `https://blender.junwei.cool/`，并安全保存同一个内部 Secret。

暂停/恢复邀测已于 2026-10-11 正式提交[火山工单 T-2026101110220001](https://console.volcengine.com/workorder/list/detail?id=T-2026101110220001)，提交后状态为“处理中”。申请明确要求人工确认实际权限、新实例适用范围、暂停期间生命周期计时、快照保留期限及恢复后进程规则。工单提交不代表权限已经开通；答复和真实 API 验收前，保持 `BLENDER_PAUSE_ENABLED=0`。

剩余产品边界仍包括：跨用户容器可信清理/复用、人工与 Agent 控制权切换、真实账号与跨设备额度、货币费用对账。当前批次画面只读，手动编辑独立会话；未知结果必须人工决定是否退回检查点或重做。
