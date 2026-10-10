# Blender 持久服务部署与验收

这些文件是待部署配置，**不是已上线结果**。代码现已包含事务调度、独立会话、TOS 工程/产物、执行回执、外部巡检和网站入口；云端端到端仍须逐条验收。

## 当前前置条件

- 2026-10-10 控制台读取时，TOS 仍在开通页；接受存储条款及创建北京地域私有桶需要用户本次确认。
- veFaaS 暂停/恢复邀测尚未确认。实例菜单只有修改生命周期/删除，不能据此宣布已具备暂停。先按[官方说明](https://docs.volcengine.com/docs/vefaas/Sandboxinstancepauseandresume?lang=zh)开通，再创建新测试实例。
- 需要一个常驻 Linux 主机、持久盘、HTTPS 域名。此服务不能只部署为 Vercel 函数。起步仅运行一个调度副本；较大工程传输可能同时持有几份 256 MiB 缓冲，主机内存应留充足余量（首次验收建议 8 GiB）。
- 准备只用于调度服务的火山 IAM 凭据、桶范围 TOS 凭据及可选方舟模型凭据。**不要把 AK/SK 贴到聊天或交给沙盒**。需要先在控制台核验具体动作和资源范围；这里没有编造资源级 IAM 策略，也不要求授予账号全权限。
- 网站目前使用签名匿名工作区 Cookie。它不是付费账号或跨设备登录体系。公开收费/不受信用户上线前还需真实账号、额度结算和全局累计预算；当前功能仅供受控验收。

## 镜像发布

从已上传的定制镜像摘要构建，不替换 Blender 本体/插件/用户配置：

```sh
docker build --platform linux/amd64 -f blender/docker/Dockerfile.cloud -t chatspace-blender:5.2.2-managed-20261011 blender/docker
python3 blender/scripts/managed-smoke.py
```

真实 smoke 会在自己的临时容器里验插件真实就绪、重复命令只执行一次、保存/清空/恢复 `.blend`、GLB 导出、只读账户、租约换代和容器重启后恢复；结束删除这个测试容器。它不修改 `csvol` 或现有云实例。2026-10-11 该验收已通过，镜像已推送到 `blender-cn-beijing.cr.volces.com/chatspace/chatspace-blender:5.2.2-managed-20261011`，Registry 回读摘要为 `sha256:1485b04a2886e05e7b364357df56c14d2991f87f39bd6a6bc44fb8cd1db39443`。

2026-10-11 北京控制台已确认“已预热”，新镜像 ID **`1e1bj472zl`**，样例配置已填入该 ID 与上述摘要。平台目前提示预热默认保留 15 天，安装时须重新确认状态。不要使用旧 control 镜像 ID。创建接口显式选择该镜像 ID；桌面 HTTP 端口为 **8080**。原 ChatSpace 应用的默认镜像尚未切换。

## 服务安装

在用户确认的常驻主机上准备 Node 24、Bun 1.3.14、`chatspace` 用户及 `/opt/chatspace/repo` checkout。依赖/代码安装不负责购买主机。

```sh
bun install --frozen-lockfile
bun run chat/scripts/blender-service-build.ts
```

将 `service.conf.example` 复制为 `/etc/chatspace/blender-service.conf`，用安全编辑器填值，权限为 root:root 0600。不要运行 `cat`、`env`、`set -x` 输出配置。相同 `BLENDER_SERVICE_SECRET` 另存到 Vercel 服务端变量；不能使用 `VITE_` 前缀。为其保留离线安全备份，丢失后 SQLite 中旧实例凭据无法解密。

将五个 unit 文件放到 `/etc/systemd/system/`，确认实际 Bun/Node 路径。SQLite 在 `/var/lib/chatspace-blender`，不得放临时容器层。只有一个调度副本；桌面网关使用 Node 的真实 upgrade socket。

```sh
systemctl daemon-reload
systemctl enable --now chatspace-blender.service chatspace-blender-desktop.service chatspace-blender-watchdog.timer
```

Caddy 按样例配置自动 TLS，DNS 指向该主机，仅开放 HTTPS/必要运维入口。3907/3908 仅绑定 loopback；公网不转发 `/internal/*`。桌面域名优先为网站同一主域的子域，否则需额外验收浏览器第三方 Cookie 策略。反向代理日志不能记录桌面 `ticket` 或 TOS 签名查询参数。

独立 systemd timer 每 5 秒请求任务闸门，不依赖网页或本进程定时器。巡检本身有 OS 的 30 秒截止；失败会重启控制器及桌面网关、撤销旧连接，随后按数据库和回执核对，**不自动重买状态不明的模型调用**。

## TOS 与网站

私有桶仅服务端有读写凭据。保留默认私有 ACL，不开放公共桶。为网站实际 Origin 配置 CORS：GET/HEAD、必要响应头，不设通配凭据访问。下载 URL 只针对当前会话产物、默认 5 分钟；浏览器以省略凭据的方式下载并校验 SHA-256。首次并行导入时产物、asset.json、侧写和导入回执在一个 IndexedDB 事务中落盘；Web Locks 防止两标签页重复发资产身份。当前每个导出成为独立新资产，不静默覆盖已有版本。

Vercel 服务端增加：

```text
BLENDER_SERVICE_URL=https://blender-api.example.com/
BLENDER_SERVICE_SECRET=同一服务端随机密钥
```

先不配置这两个变量，保持公开功能关闭。验收通过后才配置并部署。`BLENDER_ENABLED` 仍控制原有本机工具，不用于生产会话调度。浏览器 Agent 新增 `start-blender-batch` / `blender-batch-status`，只有服务器确认云服务配置后注册；每个批次项有明确 sessionId，不读取界面当前选中会话作路由。

## 恢复边界

- 每次 Agent 写场景后在下一步前保存检查点；手动会话在安全空闲边界每 60 秒保存，正常结束再次保存。依赖打包；链接库、外部缓存、视频序列及未打包文件明确拒绝，不冒充完整可恢复工程。
- 运行预算最长 60 分钟，到期前 2 分钟开始收尾。云实例确认消失后，只有已提交检查点、操作结果已知且原预算足够时最多自动恢复两次；旧请求以 epoch 隔离。
- SQLite 和沙盒回执的 `unknown` 不转回执行队列。结果未知时展示需要检查；用户可以在实例确认停止后明确退回已保存工程，或单独发起新尝试。失败项不挡住其它无依赖项。
- 新建、批次提交、单项重试与导出先把请求写入浏览器 IndexedDB，再发送。网页关闭或响应丢失后保留原请求，重试沿用原 id；只有收到明确成功结果才清除。请求按签名工作区身份和项目隔离，Web Locks 防止多个标签页同时另发意图。
- 当前跨用户可信清理尚未验收：结束保存后暂停为私有快照，**不会分配给另一个用户**。须先证明不可变基础环境和可替换租约写层/可信重置，才能开放跨用户复用。不能只清空 Blender 场景便回池。
- 备份 SQLite 必须用在线 SQLite backup API 或停服务后复制完整数据库/WAL，不能运行中只复制主文件。数据库含加密实例凭据，备份保持私有权限，与服务密钥分开保存。

## 上线验收记录（目前待完成）

1. 开通 TOS、IAM 和暂停邀测；确认同一区域及费用。
2. 发布测试过的 managed 镜像、预热；核对摘要/镜像 ID/8080。
3. 同一工作区创建两份独立 Blender，真实并行编辑/导出；确认画面和命令不会串场。
4. 保存真 `.blend` 到私有桶并校验回读；暂停后恢复，验证定制插件与几何事实。
5. 浏览器关闭后完成已接受批次；重启服务、丢失回执、过期实例、上传中断分别验证。
6. 实例状态确认为 frozen 才释放名额；无权限时不能声称暂停或零算力费用。
7. 验证 TOS 下载/多标签页幂等导入、旧 epoch 和旧画面票据失效、批量只读账户。
8. 完成跨用户清理、人工/Agent 控制权切换及实际预算验收后，再扩展公开复用范围。
