# Blender Cloudflare 控制服务

2026-10-11：已部署受鉴权保护的 Cloudflare Worker、两个 SQLite Durable Objects、每分钟 Cron 和 `blender.junwei.cool` 域名。专用凭据已录入服务端 Secrets，真实 TOS、定制 Blender 的工程保存/恢复、两个实例隔离并行、火山暂停/恢复均已通过实际 API 验证。ECS 购买已搁置。Cloudflare 平台 Alarm 已完成真实创建、命令执行、TOS 检查点、同实例暂停/恢复和 GLB 下载；真实桌面 WebSocket 握手与撤销已通过。**网站生产 API 已接通，Chrome 已显示完整定制 Blender 窗口；自动保存后的观看恢复、网站领取和下载均已验收。真实后台并行批次、隔离导出和失败项单独重试已通过。**

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

`wrangler.jsonc` 已填写实际北京应用、预热镜像 ID、摘要、APIG 入口和 TOS 桶。`BLENDER_PAUSE_ENABLED=1` 已在短期专用测试实例完成真实暂停、状态确认、恢复、Blender 启动和 TOS 工程还原后启用。Vercel 生产服务端已配置新服务 URL 和同一内部 Secret；受短期签名身份保护的 API 用于调度与网站联调。

首次部署必须提供以下服务端 Secrets，不能提交 Git、发到聊天或使用 `VITE_` 前缀：

| Secret | 用途 |
| --- | --- |
| `BLENDER_SERVICE_SECRET` | 至少 32 字符随机值，用于短期身份签名和沙箱凭据加密；Vercel 服务端必须使用相同值，保留安全备份 |
| `VOLC_ACCESSKEY` / `VOLC_SECRETKEY` | 专用 IAM 用户，用于沙箱创建、列表、暂停、恢复和生命周期管理；先在官方控制台确认动作与资源范围 |
| `TOS_ACCESS_KEY` / `TOS_SECRET_KEY` | 专用桶范围凭据，只需要该桶 Blender 对象前缀的 GetObject/PutObject；禁止公共 ACL |
| `VOLC_KEY` | 方舟模型调用密钥，用于后台批次规划；使用既有模型和每日调用准入 |

不要授予账号管理员或全产品权限来绕过访问失败。`iam-policy.review.json` 记录已获用户批准的策略：五个沙箱动作已在官方编辑器确认，但选择指定资源时没有可选资源，故沙箱 `Resource=*` 配合北京地域条件，不能宣称只授权 ChatSpace。TOS 则限定本桶 `blender/*` 的 GetObject/PutObject。北京条件与对象权限已用真实 API 验收，未扩大范围。2026-10-11 已创建 `ChatSpaceBlenderCloudflare`，专用用户 `chatspace-blender-cloudflare`（96763875）只绑定此策略，控制台登录关闭。用户亲自创建并隐藏录入 AK/SK，仓库外凭据文件为 0600，已上传为 Worker Secrets；模型凭据复用既有服务端配置。任何密钥值均不进入 Git 或测试输出。

新 Worker 的必需 Secrets 要和首次部署同时提供。用仓库外的权限 0600 JSON/ dotenv 文件保存真实值，然后运行：

可先在自己的交互式终端执行 `python3 deploy/blender-cloudflare/prepare-secrets.py`，隐藏输入该专用用户的 AK/SK 并重复确认 SK。脚本将同一份受限凭据用于沙箱和 TOS，复用本机已有 `VOLC_KEY`，生成内部随机密钥（重跑时保留已有内部密钥，避免破坏加密记录），原子写入 `~/.config/chatspace/blender-cloudflare-secrets.json`，目录 0700、文件 0600。它不上传、不输出任何密钥值；实际部署仍由下面的 Wrangler 命令执行。创建密钥与输入由用户亲自完成，禁止把值贴到聊天或命令参数。

```sh
cd deploy/blender-cloudflare
../../node_modules/.bin/wrangler deploy --secrets-file /absolute/path/outside/repo/blender-secrets.json
```

部署脚本不会自动购买套餐。2026-10-11 控制台确认当前 Workers Free；SQLite Durable Objects 可用于受限试用。正式扩容前核对当日 CPU、请求、存储和桌面连接时长用量，避免免费额度耗尽后任务推进受阻。桌面使用常规双向代理而非 Hibernation，不能宣称长连接没有计算费用；Cloudflare 也不是火山费用的人民币账单封顶。参考[平台限制](https://developers.cloudflare.com/durable-objects/platform/limits/)与[计费规则](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

已发布 `blender.junwei.cool` 的 Custom Domain。主网站 `www.junwei.cool` 与它同站，符合 Strict 桌面 Cookie 策略。独立 Vercel 预览域和 workers.dev 跨站 iframe 不能当作生产桌面验收入口。公网只暴露 `/health`、有票据的 `/v1/*` 和 `/desktop/*`；内部 RPC 不映射 URL。日志去掉查询参数并关闭自动请求日志，避免记录桌面 ticket 和 TOS 签名。

`BLENDER_POOL` 是部署级资源池身份。改变它会创建独立额度账本，不能把它作为用户输入，也不能靠改名逃逸预算；生产升级须保留当前名称和两份 Durable Object 绑定/迁移。当前没有将旧 Bun SQLite 导入云端，也没有真实云端任务要迁移。

## 验证与切换顺序

```sh
PATH="$HOME/.bun/bin:$PATH" BLENDER_ENABLED=0 bun run check
cd deploy/blender-cloudflare
../../node_modules/.bin/wrangler deploy --dry-run
```

2026-10-11 完整检查退出 0：app 956、chat 657、Cloudflare 12 项全部通过，类型检查和网站构建通过。Cloudflare 测试使用真实本机 workerd/SQLite、虚构凭据和模拟供应商，不证明真实公网/TOS 成功。覆盖事务嵌套与回滚、并发额度、未知操作和付费规划恢复、桌面权限/保存期间拒绝、Alarm 续调度、逐字节 GLB 校验、256 MiB 分块 hash、TOS 上传和回读后才提交指针、死定时器外部中止，以及 Worker→DO HTTP Upgrade 的真实二进制往返、立即发送的 RFB 首条消息、成功握手后保留连接、单连接限制和撤销。HTTP 和 WebSocket 握手都覆盖死定时器外部中止。WebSocket 响应不能通过 RPC 克隆，故桌面使用 DO 的 HTTP binding；控制服务之间继续使用 RPC。

真实公网联调修正了本机模拟网络不会暴露的差异：Wrangler 打包保留 SDK 的 CommonJS `default` 包装；Workers 原生 fetch 要用全局接收者并以 `manual` 拒绝重定向；TOS 不覆盖头必须包含在签名里。桌面监听在接受上游前安装，以保留立即发送的 RFB 消息；握手预算中止与已升级的长连接分开，后者由桌面撤销和外部时钟校验租约。

截至 12:43，真实 Cloudflare 测试会话 `667c2727-173f-40fb-bfe9-482891978b29` 已完成同实例 epoch 1 → 2 恢复、工程哈希核对、1768 字节/12 三角形 GLB 下载；再次恢复到 epoch 3 后，桌面 HTML 200、双向 RFB 握手、结束后的连接关闭与旧 Cookie 401 均通过，工程已保存并暂停。这里只验证了协议与授权，不等同于 Chrome 画面/输入验收。用户已完成 Vercel 登录，生产 URL/Secret 已安全设置，远程构建成功。用户的普通 Chrome 健康检查返回 configured/pauseEnabled 为 true；自动化工具访问健康检查仍有客户端拦截。网站联调发现 Vercel rewrite 附加路径查询参数被严格入口拒绝，已补充仅接受与实际路径完全相符的 Vercel 路由元数据及拒绝伪造/重复参数的回归，修复版本已部署并通过真实会话 API 验证；正式网站已切换。Chrome 可见完整 Blender 窗口，实际 Shift+F4 和控制台 1+1 → 2 验证键盘输入。保存过程会撤销桌面；联调发现旧观看逻辑在保存期间续票会留下失败提示，新增按检查点重新取票、保存时隐藏失效 iframe、在完成后重连的组件，远程构建与实际保存后重连验收通过。

网站测试项目 `p-mv3ctr2n` 从网页分配会话，保存暂停后跨页面恢复。修改后的 `ChromeInputCube` 对象名保留；GLB 经 TOS 领取到真实 WebGPU 场景，重复领取保持一项资产。网站下载文件为 1948 字节/12 三角形，SHA-256 为 `e78b37ca61780fd166e9f1e7d30a2fe0679c38a81f783f8f821a7aa29f470340`。正式 Vercel 部署为 `dpl_HAQR52HTXVvgcrtG6WHREm4zr1aX`。

上线顺序：专用凭据与权限 → 暂停邀测 → 部署受保护 Worker → 一个短期 managed 实例的 TOS 保存/回读/恢复 → 两实例隔离并行 → 关闭网页与 Worker 重启恢复 → 真实 Chrome 桌面输入/撤销 → 网站受控入口。后台保存、恢复、导出及批次验收通过后，将 Vercel 服务端 URL 设为 `https://blender.junwei.cool/`，并安全保存同一个内部 Secret；远程构建后核对网站 API 和真实 Chrome 输入。

暂停/恢复邀测已于 2026-10-11 正式提交[火山工单 T-2026101110220001](https://console.volcengine.com/workorder/list/detail?id=T-2026101110220001)，提交后状态为“处理中”。申请明确要求人工确认实际权限、新实例适用范围、暂停期间生命周期计时、快照保留期限及恢复后进程规则。工单提交不代表权限已经开通；12:00 后，专用测试实例的真实 PauseSandbox、Paused 状态查询、ResumeSandbox、Blender 启动和 TOS 工程还原全部成功，已据此启用分配闸门。工单仍处理中，快照保留期限和计费细节仍待人工答复；不根据工单提交或 AI 助手推断权限。

真实后台双项批次：两个沙盒同时运行，球体导出 17652 字节/224 三角形；立方体原尝试因 get_object_info 参数名称错误失败并保存暂停。按定制插件实际签名补全规划工具参数说明后，仅重做失败立方体，导出 1740 字节/12 三角形；球体没有重做。两份 GLB 下载、SHA-256 和对象名称核对通过，互不包含对方场景对象，所有测试会话已保存暂停。

剩余产品边界仍包括：跨用户容器可信清理/复用、人工与 Agent 控制权切换、真实账号与跨设备额度、货币费用对账。当前批次画面只读，手动编辑独立会话；未知结果必须人工决定是否退回检查点或重做。

网站桌面现改为每个会话一个原样式 22rem 小浮窗（352×242），操作收进各自左下角菜单，支持拖动、调整大小、最大化/还原和浏览器全屏入口。顶部按钮打开窗口管理；收起管理或关闭一个观看窗口不会结束后台任务，暂停须使用对应窗口的“保存并暂停”。正式版本 `dpl_5GnMBfiEyBmAvmnq1ZbRWENFeEjN`；最新完整检查 app 966 / chat 657 / Cloudflare 12 项通过，真实 Chrome 两个桌面同时显示、拖动、缩放、小窗并排、关闭重开位置隔离和视口最大化/还原通过；测试工程均已保存暂停。Mac 锁屏阻止浏览器全屏验收，待解锁后继续，详见 `BLENDER_CLOUD_PLAN.md` 最后一节。
