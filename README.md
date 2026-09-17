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

| 本机变量 | 用途 |
| --- | --- |
| `VOLC_KEY` | 火山方舟 GLM-5.3 / DeepSeek V4.1 Flash 对话、Seedream 图片，以及 Seed3D、Hyper3D、Hi3D 模型 |
| `TRIPO_KEY` | Tripo3D 模型生成与分割 |
| `WORLDLABS_KEY` | World Labs Marble 场景 |

对话模型可在 Agent 输入框的下拉菜单中选择 GLM-5.3 或 DeepSeek V4.1 Flash，默认仍使用 GLM-5.3。两者共用本机的 `VOLC_KEY` 和火山方舟地址 `https://ark.cn-beijing.volces.com/api/v3`。如果你的接入点使用不同的地址或模型 ID，可在本机设置 `VOLC_LLM_BASE_URL`、`VOLC_LLM_MODEL` 与 `VOLC_DEEPSEEK_MODEL`；DeepSeek V4.1 Flash 默认 ID 为 `deepseek-v4-1-flash-260910`。火山影眸 Hyper3D、数美 Hi3D 的默认模型 ID 可分别用 `VOLC_HYPER3D_MODEL`、`VOLC_HI3D_MODEL` 覆盖。Hi3D 的方舟接口要求公网参考图 URL：当前流程可复用 Seedream 生成或编辑时的临时供应商 URL，正式工程文件仍保存在本机；仅有本地上传图时需先生成或编辑一张 Seedream 参考图。网页只获取是否配置的状态，不读取密钥；旧版浏览器保存的密钥会在启动时清除。

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
