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
| `TRIPO_KEY` | Tripo3D 单图/多视角模型生成、多角度参考图、贴图、分割、重拓扑与绑骨 |
| `TRIPO_IMAGE_MODEL` | 界面「Tripo 3.1」项提交的几何模型 ID，默认 `v3.1-20260211`（v3 接口必填；P 系列在菜单里单独选，不受这个变量影响） |
| `HUNYUAN_KEY` | 腾讯混元 UV 展开专用，格式为 `SecretId:SecretKey` |
| `WORLDLABS_KEY` | World Labs Marble 场景 |

World Labs 单步任务有两种模式：`direct` 直接用最新源图和可选文字提示词生成世界，不要求图片分析；传 `sourceImage: null` 可只用文字。`empty-environment` 根据已有的完整场景确认记录排除独立对象，生成空环境。完整场景的 SceneJob 世界节点会使用干净底板和明确的空环境提示词；单独生成世界仍可直接调用 `start-world-task(mode=direct)`，不需要先启动完整场景。

Tripo3D 支持单图与多视角模型生成。`generate-reference-images(mode=multiview)` 可把目标已有的一张干净参考图扩展为前、左、后、右四视图并绑定视角元数据；之后 `start-3d-batch(provider=tripo-direct)` 默认自动使用多视角接口，也可用 `tripoGenerationMode=single|multiview` 显式选择。

Tripo 几何模型分两个系列：H 系列的 `v3.1-20260211` 是最高精度版本，P 系列的 `P2-20260801`（四边面输出，Preview）与 `P1-20260311` 面向低多边形、干净拓扑的游戏与移动端资产，面数上限分别为 48–50,000（四边面 48–25,000）与 50–20,000。生成请求固定带 `texture_version=v3.5-20260815`（最新的贴图模型；`v2.5` 几何仍配 `v2.5-20250123` 贴图），不再落到官方默认的 `v3.0` 贴图。贴图后处理 `generate-texture` 同样用 v3.5，并可用 `textureQuality=fast|standard|detailed|extreme` 与 `delight` 控制细节档位和参考图烘焙光照。

模型后处理统一走 Tripo v3：`retopologize` 使用 `/mesh/decimate`，`rig-model` 使用 `/animations/rig`；`generate-animation` 当前未向 Agent 注册，动作生成已禁用。`generate-character` 组合“图生 3D → biped 绑骨”（会产生两次付费任务）。Tripo 当前没有为已有模型单独执行 UV 展开的端点，因此只有 `unwrap-uv` 保留混元实现；Tripo P 系列生成接口的 UV 开关只在新模型生成时生效，不能替代后处理 UV 展开。

需要从整张图片生成完整场景时，Creator 先用 `analyze-reference` 提取对象，再用 `ask-user` 卡片让用户勾选对象并确认整条付费计划；获得确认后，把该次分析的 `runId` 与可选的 `selectedSlugs` 交给 `start-scene-job`。服务端会把确认结果保存成可版本化的 `SceneSpec`，并创建持久化 `SceneJob` DAG：各对象的参考图和干净底板可以并行，单个模型只依赖对应参考图，World Labs 空环境只依赖底板，最后汇总等待世界与全部模型。节点记录输入指纹、尝试次数、产物和状态，因此中断后可以从未完成节点恢复，而不必整条重来。

完整场景并不是唯一入口：`generate-clean-plate` 可以只生成或继续清理底板，`start-world-task(mode=direct)` 可以只生成世界，参考图与模型也保留各自的独立工具。发现漏掉家具时用 `revise-scene-job` 增补对象，只新增该对象的参考图和模型，并把受影响的底板、世界与最终汇总标为待重建；底板不够干净时用 `retry-scene-job-nodes` 重跑 `plate`，只连带重建 World 与最终汇总，已经成功的物体模型保持不变。旧的 `one-shot-scene` 源码暂留兼容，但不再注册到 Creator Agent。

`ask-user` 是 Agent 需要用户本人做决定时的统一出口：付费操作同意、方案取舍、对象确认都走它，不再用自然语言提问后等用户打字。问题由模型给出（角标、正文、明细、选项、是否多选、是否允许自由输入），工作台渲染成可点选卡片；服务端在提问写进 SSE 后立即中止本轮 agent run，因此提问之后不可能再有工具被调用。用户点选后，答案作为一条带结构化 `answer` 部件的用户消息回到下一轮；用户直接打字回答时，卡片置灰保留在历史里。卡片与答案随会话落盘，刷新或换浏览器后仍可点选——它不依赖任何服务端状态。

对话模型下拉菜单提供四个模型：GLM 5.3 Flash、DeepSeek V4.1 Flash、Doubao-Seed-Evolving、Doubao-Seed-2.1-pro，共用本机的 `VOLC_KEY` 和火山方舟地址 `https://ark.cn-beijing.volces.com/api/v3`。自动选择默认使用 GLM 5.3 Flash；旧版 `glm-5.3` 选择会迁移到 Flash，已移除的 Seed 2.0 Lite 选择会回退到默认模型。可用 `VOLC_LLM_BASE_URL` 覆盖地址，用 `VOLC_LLM_MODEL` 单独覆盖自动选择的默认模型。四个选项的实际模型 ID 或专属接入点 ID 可分别覆盖：

| 模型 | 默认 Model ID | 覆盖变量 |
| --- | --- | --- |
| GLM 5.3 Flash | `glm-5-3-flash-260828` | `VOLC_GLM_MODEL` |
| DeepSeek V4.1 Flash | `deepseek-v4-1-flash-260910` | `VOLC_DEEPSEEK_MODEL` |
| Doubao-Seed-Evolving | `doubao-seed-evolving` | `VOLC_DOUBAO_EVOLVING_MODEL` |
| Doubao-Seed-2.1-pro | `doubao-seed-2-1-pro-260915` | `VOLC_DOUBAO_PRO_MODEL` |

模型 ID 已于 2026-09-18 通过火山方舟 `/api/v3/models` 核对。修改旧版 `.env` 时，将 `VOLC_LLM_MODEL` 的 Seed 2.0 Lite 值删除或改为以上模型 ID，并重启本机服务。

火山影眸 Hyper3D、数美 Hi3D 的默认模型 ID 可分别用 `VOLC_HYPER3D_MODEL`、`VOLC_HI3D_MODEL` 覆盖。Hi3D 的方舟接口要求公网参考图 URL：当前流程可复用 Seedream 生成或编辑时的临时供应商 URL，正式工程文件仍保存在本机；仅有本地上传图时需先生成或编辑一张 Seedream 参考图。网页只获取是否配置的状态，不读取密钥；旧版浏览器保存的密钥会在启动时清除。

3D 生成下拉菜单选的是具体模型，不是渠道；选定的模型同时决定渠道与提交给供应商的模型 ID，`start-3d-batch` 由服务端按该选择钉住，Agent 传的 `provider` 参数会被忽略（留空 `Auto` 才由 Agent 判断）：

| 菜单项 | 渠道 | 默认 Model ID | 覆盖变量 |
| --- | --- | --- | --- |
| Seed3D 2.0 | `seed3d-direct` | `doubao-seed3d-2-0-260328` | — |
| Hyper3D Gen-2 | `hyper3d-volc` | `hyper3d-gen2-260112` | `VOLC_HYPER3D_MODEL` |
| Hi3D 2.0 | `hi3d-volc` | `hitem3d-2-0-251223` | `VOLC_HI3D_MODEL` |
| Tripo 3.1 | `tripo-direct` | `v3.1-20260211` | `TRIPO_IMAGE_MODEL` |
| Tripo P1 | `tripo-direct` | `P1-20260311` | — |
| Tripo P2 | `tripo-direct` | `P2-20260801` | — |

菜单项与模型 ID 的对应关系在 `chat/src/models/threeD.ts`（选择键是稳定契约，模型 ID 才允许被 env 覆盖）。旧版浏览器里保存的渠道偏好（Seed3D / Hyper3D / Hi3D / Tripo3D）会在加载时迁移成对应渠道的默认模型。完整场景 SceneJob 的单物体模型目前固定用 Seed3D，不跟随这个选择。

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

协议依据：[火山 Seedream 图片编辑](https://www.volcengine.com/docs/82379/1829186)、[火山影眸 Hyper3D](https://docs.volcengine.com/docs/82379/2279947?lang=zh)、[火山数美 Hi3D](https://docs.volcengine.com/docs/82379/2307070?lang=zh)、[Tripo3D API v3](https://developers.tripo3d.ai/en/docs/migration-v2-to-v3)、[World Labs API](https://docs.worldlabs.ai/api)。
