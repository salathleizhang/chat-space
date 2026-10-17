# Vercel 浏览器本地版

**日常发布只走 commit + push，由现有自动部署流程发布；禁止自行手动部署。以根目录 [DEPLOYMENT.md](../DEPLOYMENT.md) 为准。**

公开地址： https://chat-space-app.vercel.app/app （自定义域名 https://www.junwei.cool）。
Vercel 提供网页和无状态供应商转发 API；访问者不需要运行 Bun。
项目、聊天、场景位置、任务回执、图片与模型全部保存在访问者当前浏览器的 IndexedDB。
此版本不使用外部数据库、Vercel Blob 或 Vercel Queues。

## 构建和环境

项目 `salathleizhangs-projects/chat-space-app` 的 Root Directory 为仓库根目录。
`vercel.json` 构建时设 `VITE_BROWSER_LOCAL=1`、清空 `VITE_CHAT_URL`。
`build:vercel` 检查源码、构建浏览器 Worker、构建网页，再在 Vercel 临时目录
预打包 `api/server.ts`。安装脚本只在云端设置 hoisted 依赖布局。
普通本机 Bun 服务仍使用原来的磁盘存储，默认前端构建不启用浏览器模式。

Vercel 服务端需要至少 32 字符的 `CHATSPACE_SESSION_SECRET`，以及实际使用的
`VOLC_KEY` / `TRIPO_KEY` / `WORLDLABS_KEY`，见 `vercel.env.example`。
供应商密钥不得使用 `VITE_` 前缀；浏览器只获得能力标记，不获得服务端密钥。
已配置火山和 Tripo，WorldLabs 未配置。Blender 在 Vercel 版关闭。
新增的 Blender 持久服务已有代码与本机验收，尚未完成云端部署；配置及验收清单见
[Blender 服务部署](blender-service/README.md)。仅该服务保存 Blender 调度记录与工程文件，
现有项目和聊天仍保存在浏览器；当前不要设置其公开分配变量。
Production / Preview 的数据库与 Blob 连接及相关环境变量已断开；
云端原件已备份，经用户确认后，两个 Neon 数据库和两个 Blob 仓库均已永久删除。
原生产工作区「我的第一个项目」已通过备份导入到 Chrome 的 Vercel 域名下。
不需要建表或连接存储。

浏览器本地模式已提交到 GitHub `main`，2026-10-08 已从提交 `45470e7` 完成生产部署。
不要把 `output/cloud-backup`、`.env` 或临时凭证上传到 Vercel；`.vercelignore` 已排除它们。

## Git 自动部署

Vercel 项目连接 `salathleizhang/chat-space`，生产分支为 `main`，自动创建部署已启用。
推送到 `main` 后，Vercel 构建网页与供应商转发 API，成功后更新正式域名。
此流程不会更新用户本机运行的 Bun 或 Blender 进程。

若推送后没有新部署，先在 Vercel Account Settings → Authentication 核对 GitHub 账号连接，
再核对项目 Settings → Git 的仓库绑定、生产分支和构建跳过设置。
GitHub 的 Vercel App 必须有这个仓库的访问权限。
排查依据见 [Vercel 官方说明](https://vercel.com/kb/guide/why-aren-t-commits-triggering-deployments-on-vercel)。

Cloudflare 仅负责正式域名的 DNS；这个仓库的 Workers 自动构建关联已解除。

## 本地保存和备份

浏览器内的请求由独立 Web Worker 执行已有工程、聊天与生成工具。
Service Worker 为本地模型和图片提供 `/api/library/...` 地址，支持 MIME 和范围读取；
模型导入先保存本地 Blob，不把模型编码成 JSON 传到 Vercel。
Web Locks 防止同一浏览器多个请求重复认领任务或资产名。

设置对话框里有「数据保存在此浏览器」「导出备份」「导入备份」（2026-10-16 从工作台左下角搬进来）。
备份 ZIP 包含项目、聊天、场景、模型、图片和任务回执（`.uploads/`、`.downloads/` 里的暂存件除外）。
**导入不再要求空工作区**（2026-10-17 改）：选包之后先算出计划并在面板里报数——备份多少文件、
此浏览器多少文件、多少同名冲突、多少缺失、多少只在这里——再由用户选
**Merge**（只补缺失，已有的同名文件一律不动）、**Overwrite**（写备份里的全部文件，同名的用备份内容盖掉，
本地多出来的保留）或 **Replace**（先删掉备份里没有的文件，等于还原成备份那一份快照）。
旧口径是"任何一个路径撞上就整包拒绝"，实测把唯一的找回路径堵死了：应用没有删除项目、
也没有清空本地数据的入口，而 `.jobs/`、`sessions/` 的残留没法从界面清掉，
于是**同一个域名一旦用过，备份就永远进不来**（用户报的 "The backup conflicts with the current project"）。
导入走流式（`app/src/browser/backupZip.ts`：`File.slice()` → Blob 直接落 IndexedDB），
不再用 JSZip 把整包 + 全部解压结果同时驻留——实测 454 MB / 816 个文件的包，
JSZip 旧路径 63 分钟写 0 个文件，流式路径 1.0 s 写完。
导出仍是一次性全内存打包（JSZip），超大工作区应分批管理，并保留原始模型文件。

数据按浏览器用户配置和网站 origin 隔离：Vercel 域名与自定义域名各有一份本地数据，
不同设备、浏览器和隐身窗口不会自动同步。请固定使用同一个网址，换设备时导出再导入。
清除网站数据会删除项目；浏览器存储受本机剩余空间和浏览器配额限制，代码会请求
持久化权限，但权限不保证获准。它不是 localStorage 的小容量文本存储，也不承诺无限空间。

旧云端数据已导出到本机 `output/cloud-backup/production` 与 `preview`，按原工作区
分别生成可导入 ZIP，并保留原始记录和二进制。不同访问者的 ZIP 不应合并到同一浏览器。

## 生成和恢复

任务描述和供应商回执先保存到浏览器。现有每秒 `/api/tasks` 心跳以绝对 `nextAt`
驱动到期任务；等待中的供应商查询只执行一次，不依赖长期运行的云端实例。
心跳也向在飞 Worker 发送 taskPump tick，以应对定时器停摆和请求超时。
关闭网页后本地推进暂停，供应商可能继续生成；重新打开项目会凭已保存的回执继续查询。

发出付费请求前先写入开始标记。刷新后只恢复已有 `providerTaskId` 的任务，不重复提交。
若请求结果未知且没有供应商回执，提示用户核对，不冒险重新付费。
此语义仍有网络边界：供应商已接收而浏览器尚未保存回执时无法自动确定提交结果。

## 转发和费用

`/api/provider` 只转发允许的供应商域名与路径，注入服务端密钥。
供应商 CDN 允许跨域时，结果直接下载到浏览器；否则使用服务端签名的下载凭证，
由 `/api/download` 流式转发，不在 Vercel 保存文件。导入已有模型仅写本地；
调用 AI 时必要的提示词和输入图片/模型仍会发送给供应商。

数据库与 Blob 的持久化费用已经从应用架构移除。AI 调用和 Vercel 函数、流量仍可能计费，
特别是 CDN 跨域受限时的大文件转发。请在供应商账户设置消费额度。
当前限流是单个函数实例内每访客每分钟 120 次请求的辅助保护；不是可靠的跨实例每日预算。
原先依赖数据库的全站每日额度不再存在，不能声称公开网址具有严格的总消费上限。

## 验证范围

类型检查、服务端边界测试和生产构建覆盖本机模式与浏览器兼容层。
本次完整 `bun run check` 退出码为 0（app 946 pass / chat 600 pass）；
删除云资源后，两个正式域名的健康接口均返回 `storage: browser-local`。
真实浏览器已验证创建项目、刷新恢复、短 AI 流式聊天、图片与场景位置保存，
以及 100 MB 模型文件的本地导入、范围读取和删除。100 MB 文件是存储链路夹具，
不是渲染性能测试；另一个有效 GLB 立方体已在真实 WebGPU 视口显示。

模拟供应商验证了首次提交、保存 running 回执、换新 Worker 续跑、下载发布，
提交次数始终为 1；没有供应商回执的中断任务安全失败。
未提交真实付费图片、模型或世界生成，供应商完整付费链路仍需按实际账户验证。

## 备用：独立 Bun 后端

若希望所有用户访问一个磁盘工作区，可使用仓库 Dockerfile 和持久卷。
这属于另一种架构，不是本版本的浏览器本地模式。
Vercel 前端需去掉浏览器标记、恢复普通 `bun run build`，移除无状态 API rewrite，
并将 `VITE_CHAT_URL` 指向独立 HTTPS 后端。后端环境见 `cloud.env.example`。
Bun 后端需要长期进程、持久盘、准确的 `CHATSPACE_WEB_ORIGINS` 和访问控制，
建议只运行一个副本；不要使用 `bun --hot` 长期运行服务。
