# ChatSpace

以原版界面与交互为基线，保留真实本地工程文件。网页由 Cloudflare Pages 托管；本机 Bun 服务负责工程目录、Agent 和生成任务。

界面基线来自原项目 commit `7a701ee8db050f33b767b8f1490738cb543c3679`。工作台与交互沿用原版；设置弹窗改为显示本机供应商配置状态，不再向网页索取 API key。

## 本地开发

需要 Bun 1.3+、支持 WebGL 2 的浏览器。

```bash
bun install
bun run dev
```

将 `chat/.env.example` 复制为 `chat/.env`，在本机填写需要启用的平台密钥。打开 `http://localhost:5173/` 进入首页；`/app` 是项目列表。网页开发服务器在 5173，数据服务仅监听 `127.0.0.1:3901`。`CHATSPACE_LIBRARY_DIR` 可调整工程目录。

修改 `chat/.env`（包括 `VOLC_LLM_MODEL` 等模型 ID）后必须重启本机服务：`bun run dev` 的热重载只重载代码，不会重新读取环境变量；否则进程会继续用旧配置调用模型。

| 本机变量 | 用途 |
| --- | --- |
| `VOLC_KEY` | 火山方舟 GLM 5.3 Flash / DeepSeek V4.1 Flash / Doubao-Seed-Evolving / Doubao-Seed-2.1-pro 对话、Seedream 4.5 / 5.0 / 5.0 Pro 图片，以及 Seed3D、Hyper3D、Hi3D 模型 |
| `TRIPO_KEY` | Tripo3D 模型生成、贴图重生成与分割 |
| `TRIPO_IMAGE_MODEL` | Tripo3D 图生 3D 的几何模型 ID，默认 `v3.1-20260211`（v3 接口必填） |
| `WORLDLABS_KEY` | World Labs Marble 场景 |

World Labs 单步任务有两种模式：`direct` 直接用最新源图和可选文字提示词生成世界，不要求图片分析；传 `sourceImage: null` 可只用文字。`empty-environment` 根据已有的一键场景确认记录排除独立对象，生成空环境。`one-shot-scene` Workflow 使用空环境模式。

需要从整张图片生成完整场景时，Creator 先用 `analyze-reference` 提取对象并等待确认；获得对象选择和整条付费计划的同意后，把该次分析的 `runId` 与可选的 `selectedSlugs` 交给注册到 Agent 的 `one-shot-scene` Mastra Workflow。Workflow 首步保存确认结果，再依次完成逐对象参考图、干净底板、World Labs 空环境和 Seed3D 物体模型。后台任务会等全部模型落盘才标记成功；普通单步生成仍使用各自的工具。服务中断后正在运行的总任务会标记失败；再次运行会复用同一确认结果、已成功的请求侧写和产物完成剩余阶段，进行中的供应商请求仍可用 `resume-generation` 恢复。

对话模型下拉菜单提供四个模型：GLM 5.3 Flash、DeepSeek V4.1 Flash、Doubao-Seed-Evolving、Doubao-Seed-2.1-pro，共用本机的 `VOLC_KEY` 和火山方舟地址 `https://ark.cn-beijing.volces.com/api/v3`。自动选择默认使用 GLM 5.3 Flash；旧版 `glm-5.3` 选择会迁移到 Flash，已移除的 Seed 2.0 Lite 选择会回退到默认模型。可用 `VOLC_LLM_BASE_URL` 覆盖地址，用 `VOLC_LLM_MODEL` 单独覆盖自动选择的默认模型。四个选项的实际模型 ID 或专属接入点 ID 可分别覆盖：

| 模型 | 默认 Model ID | 覆盖变量 |
| --- | --- | --- |
| GLM 5.3 Flash | `glm-5-3-flash-260828` | `VOLC_GLM_MODEL` |
| DeepSeek V4.1 Flash | `deepseek-v4-1-flash-260910` | `VOLC_DEEPSEEK_MODEL` |
| Doubao-Seed-Evolving | `doubao-seed-evolving` | `VOLC_DOUBAO_EVOLVING_MODEL` |
| Doubao-Seed-2.1-pro | `doubao-seed-2-1-pro-260915` | `VOLC_DOUBAO_PRO_MODEL` |

模型 ID 已于 2026-09-18 通过火山方舟 `/api/v3/models` 核对。修改旧版 `.env` 时，将 `VOLC_LLM_MODEL` 的 Seed 2.0 Lite 值删除或改为以上模型 ID，并重启本机服务。

火山影眸 Hyper3D、数美 Hi3D 的默认模型 ID 可分别用 `VOLC_HYPER3D_MODEL`、`VOLC_HI3D_MODEL` 覆盖。Hi3D 的方舟接口要求公网参考图 URL：当前流程可复用 Seedream 生成或编辑时的临时供应商 URL，正式工程文件仍保存在本机；仅有本地上传图时需先生成或编辑一张 Seedream 参考图。网页只获取是否配置的状态，不读取密钥；旧版浏览器保存的密钥会在启动时清除。

运行检查：

```bash
bun run check
```

本地正式运行时先构建，再启动单个进程：

```bash
bun run build
bun run start
```

打开 `http://127.0.0.1:3901/`。这个端口同时提供网页和 `/api`。首页输入项目名称可直接创建项目；右上角按钮进入 `/app` 并打开创建弹窗。工程文件默认保存在 `~/ChatSpace`；可用 `CHATSPACE_LIBRARY_DIR` 指定目录。`CHAT_PORT` 可更换端口，本地正式网页会自动连接同一端口。修改前端代码后需重新构建。

## Cloudflare Pages

Pages 只发布 `app` 的 Vite 构建产物；本机服务仍需在用户电脑运行。

| 设置 | 值 |
| --- | --- |
| 仓库根目录 | `/` |
| 构建命令 | `bun install --frozen-lockfile && bun run build` |
| 输出目录 | `app/dist` |
| 环境变量 | `BUN_VERSION=1.3.14`、`SKIP_DEPENDENCY_INSTALL=1` |

Pages 对没有根级 `404.html` 的 SPA 默认回退到 `index.html`，因此 `/app/:projectSlug` 可直接打开。设置稳定的 Pages 自定义域名后，将该完整 origin 加入本机服务的 `CHATSPACE_WEB_ORIGINS`，例如 `https://chatspace.example.com`。浏览器首次访问本机服务时可能要求本地网络权限。

工程和会话仍位于本机工程目录。网页向本机服务直连，Cloudflare 不接收项目 API 请求；调用第三方生成供应商时，任务输入会发送给相应供应商。Cloudflare 的实际部署及联通性验证按当前开发安排暂缓。

协议依据：[火山 Seedream 图片编辑](https://www.volcengine.com/docs/82379/1829186)、[火山影眸 Hyper3D](https://docs.volcengine.com/docs/82379/2279947?lang=zh)、[火山数美 Hi3D](https://docs.volcengine.com/docs/82379/2307070?lang=zh)、[Tripo3D API](https://platform.tripo3d.ai/docs/quick-start)、[World Labs API](https://docs.worldlabs.ai/api)。
