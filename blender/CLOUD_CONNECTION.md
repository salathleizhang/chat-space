# 云端 Blender 单会话接入

这是共享池之前的第一步：**一个指定沙箱对应一个工程**。它用于验收网站 Agent
和桌面是否操作同一场景，不能作为多人复用、自动批量创建或生产鉴权已经完成的证明。

## 镜像与接口

使用 `blender/docker/Dockerfile.cloud` 构建 `linux/amd64` 定制镜像。
桌面继续使用 `VNC_PW` 的 Basic 鉴权。新增接口：

| 接口 | 用途 |
| --- | --- |
| `POST /control/call` | 只调用现有 8 个 MCP 工具，复用镜像内的 MCP 适配器 |
| `GET /control/exports/<UUID>` | 下载指定临时目录的 `model.glb` |
| `DELETE /control/exports/<UUID>` | 清理该临时导出目录 |

这些接口要求独立 `Authorization: Bearer <BLENDER_CONTROL_TOKEN>`。
**桌面密码不能授权执行代码。** 未设置命令密钥时接口返回 404，保持原桌面功能。
密钥必须为 32–128 位 ASCII 字母、数字、`_` 或 `-`，并且与桌面密码不同。
不向浏览器发送命令密钥；只在沙箱和 ChatSpace 后端保存。

镜像中的 `/opt/mcp/bin/mcp-for-blender` 由网关按需启动，连容器内部
`127.0.0.1:9877`。命令串行、队列和启动合计最多 180 秒，超时关闭 MCP 进程，
**不重放未知结果的命令**。遥测环境开关全部关闭，日志不输出 MCP 的 stderr。
原始 TCP 插件端口仍不经公网网关暴露。

## 配置位置

沙箱环境变量保存 `VNC_PW` 和 `BLENDER_CONTROL_TOKEN`，然后发布新版应用。
创建新实例后，ChatSpace 后端进程配置以下变量：

```dotenv
BLENDER_ENABLED=1
BLENDER_LIVE_TARGET=https://saobidloj9b5hmpajmjko.apigateway-cn-beijing.volceapi.com/
BLENDER_LIVE_INSTANCE_NAME=实际新实例名
BLENDER_CONTROL_TOKEN=与沙箱完全相同的独立命令密钥
BLENDER_CLOUD_PROJECT=当前工程的真实slug
```

当前 Vite 桌面预览进程另外需要同一 `BLENDER_LIVE_TARGET`、
`BLENDER_LIVE_INSTANCE_NAME`、`BLENDER_LIVE_USER=kasm_user`、`BLENDER_LIVE_PASS`。
不要加 `VITE_` 前缀，否则凭据可能进入浏览器构建包。
修改服务端环境后重启相应进程；不要修改现有本机环境来混用两套会话。

界面打开 Blender 小窗时同时检查桌面与工具的实例配置；不一致或工程不匹配时
显示提示，不加载桌面。`/api/blender/connection` 只返回连接类型、实例名、工程名
和工具开关，**不代表实例已存活**；真实连接状态由 `blender-session` 检查。

## 导出与验证

`blender-export` 在后台任务中执行，云端临时输出写入
`/workspace/.chatspace/exports/<UUID>/model.glb`。后端经 HTTPS 下载、校验大小和
面数，然后按原有版本规则发布到当前 `AssetStorage`，工作台通过任务完成刷新。
最后清理临时目录。无共享盘要求，不读取宿主机的同名路径。
本阶段没有自动把资产库迁入 TOS；当前 `AssetStorage` 的落点保持既有配置。

验证顺序：`blender-session` → `blender-scene` → 小步建模 → 真实桌面检查 →
`blender-export` → 工作台看到新资产。超时后先读场景，不能自动重跑建模命令。
实例到期会断开；本实现不延长实例寿命、自动创建、暂停或恢复实例。

## 隔离的本机验收预览

V4 已验证公网命令、GLB 下载及桌面 WebSocket。连接本机工作台时，在 Mac 终端运行：

```bash
bash blender/scripts/start-cloud-preview.sh 实际运行中的实例名
```

按提示隐藏输入现有 `VNC_PW` 和 `BLENDER_CONTROL_TOKEN`，不要粘贴到聊天里。
在仓库根目录执行上述命令。
此脚本使用测试工程 `cloud-public-check`，要求实例内已创建验收球体 `CloudPublicProbe`。
它先经真实云端导出分支将球体发布到 `output/blender-cloud-public-check`，然后启动独立
后端 3906 与 Vite 5195，预览地址 `http://127.0.0.1:5195/app/cloud-public-check`。
后端使用 Bun，Vite 必须使用 Node.js：本机 Bun 1.3.14 的 Node `upgrade` 事件能触发，
但原始 `socket.write()` 握手响应没有发出；相同最小对照在 Node 返回 101。
密码不会写入文件；Vite 子进程不接收命令密钥。保留终端运行，按 Ctrl+C 关闭两个子进程。
实例原有到期时间仍有效；脚本不会暂停、续期或新建实例。

手工检查 WebSocket 时必须带 `Origin`，与真实浏览器请求一致。遗漏该头时 Kasm
拒绝升级，公网转发可能返回普通 HTTP 200，不能据此判断画面连接成功。

云端派生镜像必须复制当前 `custom-startup.sh` 到 `/dockerstartup/custom_startup.sh`。
固定摘要的旧基座仍包含过大的浮动窗口配置；只复制网关会遗漏仓库里的最大化修复。
即使 `resize=scale` 正常，窗口超出远程桌面的部分也无法显示。验收时同时检查完整
属性栏与时间轴，以及实际窗口尺寸不超过远程桌面；不能只验证有画面和键鼠。

## 下一阶段

生产桌面 HTTP/WS 代理目前仍需实现，现有 `/blender-live` 为 Vite 开发代理。
正式上线还需网站用户鉴权、会话租约、TOS 持久化、火山实例生命周期 API、配额
和多个 Blender 调度。不能直接把当前单工程服务开放给多人。
