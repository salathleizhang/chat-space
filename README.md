# ChatSpace

以原版界面与交互为基线，保留真实工程文件。本机模式由 Bun 服务管理工程文件、Agent 和生成任务。Vercel 公开版将项目、聊天、任务回执、图片与模型保存在每个访问者自己的浏览器（IndexedDB）；服务端只转发供应商请求，不使用 Postgres、Blob 或云端生成队列。配置与备份说明见 [deploy/README.md](deploy/README.md)。

界面基线来自原项目 commit `7a701ee8db050f33b767b8f1490738cb543c3679`。工作台与交互沿用原版；设置弹窗改为显示本机供应商配置状态，不再向网页索取 API key。

选中单个模型时，屏幕右侧出现检查器（与左侧模型栏同一套 chrome）：上半是 position / rotate / scale 的数值输入（角度按度显示、按弧度落盘），拖拽 gizmo 时数字**实时跟着手走**，改完防抖写入 `scene.json`；下半是材质——按通道替换贴图，通道列表只列该模型材质真正会读的那些，贴图来源是工程里已有的参考图与源图，换掉的通道可以单独或整体换回模型自带贴图。材质覆盖**只换贴图、不换材质类**：实现是从模型自带材质克隆一份再补改过的槽位，所以 glTF 的 clearcoat/transmission、OBJ 的 specular、unlit 材质都原样保留。材质与摆放同存于 `projects/<slug>/scene.json` 的 `transforms` 与 `materials` 两张稀疏表（按资产**稳定 id** 索引，服务端按键浅合并；没有条目的资产由 app 按创建顺序算网格默认位，不落盘），因此刷新、重启服务后仍然生效；写在 `transforms` 里的摆放不只是用户手工拖出来的——完整场景生成结束时的按参考图摆放（见下）也写同一张表。材质覆盖只作用于视口与预览小窗，模型文件与列表缩略图保持供应商原样。

## 本地开发

需要 Bun 1.3+、能成功初始化 WebGPU adapter/device 的浏览器，并通过 HTTPS 或 localhost 访问。所有 3D 画面统一走原生 WebGPU（包含 Gaussian Splat、collider GLB、预览和截图），不回退到 WebGL；不支持时显示重试提示，项目与聊天界面仍可用。

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

**高模生成完先问一次要不要降面**（不是自动减、也不是静默交付）：每个 3D 生成任务的 result 里都带 `modelInfo`——`faces` 是**实测三角面数**（读 GLB 的 JSON chunk，不解码几何，见 `chat/src/common/glb.ts`；OBJ/FBX 之类读不出来则是 `null`），`highPoly` 是服务端按 **10 万面**阈值给出的判定（`chat/src/mastra/tools/modelInfo.ts`）。工作台的“生成完成”通知里也带上面数，所以 Agent 在结算那一轮就能决定，不必为此多调一次工具。`highPoly` 为真时 Agent 用 `ask-user` 弹一次卡片：选项是「Auto low-poly · 2 万面」（recommended）、「Auto low-poly · 5 千面」与「保持高模，不减面」，`allowOther` 让用户自己填目标面数；**用户同意后才调 `retopologize`**（Tripo `/mesh/decimate` 的另一次付费任务，产物是新的一代、原高模保留，视口与摆放自动用低模——`latestModel()` 按索引取最新）。低模（例如 Tripo P 系列约 5 千面）不问；`highPoly` 为假或者根本没有 `modelInfo` 的旧任务都不会触发卡片。一批里多个高模只问一次；完整场景 SceneJob 跑的过程中不逐个问（那条 DAG 的付费计划与键集是单独一份），等整场景交付、用户提出面数或性能问题时再按需调用 `retopologize`。

**Tripo 并发与 429**：Tripo 有两套独立限制——请求频率（按 API Key，超限 `code 1007`）和**按类目的并发**（按账户，超限 `code 2000`）。官方默认并发是 H 系列生成 10、**P 系列生成 5**、图像生成 1、模型后处理 5、网格操作 10、动画 10；同一类目共享池子，类目之间互不影响。提交端按这张表排队（`chat/src/models/tripoConcurrency.ts`），**槽一直持到任务轮询到终态**，所以一批 16 个 P 系列对象会排队跑而不是齐发撞 429（2026-10-01 实测：16 个 P2 齐发只有 5 个成功、11 个被 `code 2000` 拒绝）。撞上账户里别的占用者时，`code 2000` 会放掉槽位、按 `Retry-After` 重排（缺该头时 5 秒起指数退避），`code 1007` 走 1 秒起、上限 32 秒、最多 5 次的指数退避；两者最终仍失败才抛 `tripo_rate_limited`。任务查询走批量端点 `POST /v3/tasks/list` 并把同一时刻到点的查询合并成一个请求（`chat/src/models/tripoTaskQuery.ts`），单个任务的轮询间隔（10 秒）、总预算与状态回调不变。注意实测 Tripo 的成功响应里**没有**官方文档承诺的 `X-RateLimit-*` 响应头，所以退避以本地指数退避为准。

需要从整张图片生成完整场景时，Creator 先用 `analyze-reference` 提取对象，再用 `ask-user` 卡片让用户勾选对象并确认整条付费计划；获得确认后，把该次分析的 `runId` 与可选的 `selectedSlugs` 交给 `start-scene-job`。服务端会把确认结果保存成可版本化的 `SceneSpec`，并创建持久化 `SceneJob` DAG：各对象的参考图和干净底板可以并行，单个模型只依赖对应参考图，World Labs 空环境只依赖底板，**世界与全部模型就绪后再由 `placement` 节点按参考图把每件家具摆回 3D 原位**，最后汇总交付。节点记录输入指纹、尝试次数、产物和状态，因此中断后可以从未完成节点恢复，而不必整条重来。

摆放（`placement`，免费、确定性、不调用任何供应商）读的是 `analyze-reference` 已经落盘的两样东西：每个对象的**归一化包围框** `box=[x0,y0,x1,y1]`（原点左上、紧贴物体自身外轮廓）和拍摄这张照片的**相机估计** `camera`（地平线行、拍摄高度、竖直视场角）。接地像素离地平线越近纵深越大（`纵深 = 相机高 × 焦距 / 行距`），横向按视场角与图片真实宽高比换算，纵深有 12 m 上限（贴着地平线的物体不会飞到几公里外）；给了 `heightMeters` 就按服务端量到的 GLB 包围盒把模型归一到现实尺寸，脚底贴到 **world collider 采样出的真实地面**（采样不到该点、collider 读不出来或面数异常时退回 y=0 平面，摆放不会因此失败）。结果写进 `scene.json` 的 `transforms`，按资产**稳定 id** 索引——和用户在视口里用 gizmo 手动摆放是同一张表、同一份文件，所以摆完可以继续手调，重算时也会覆盖旧值。

摆放不是必须在完整场景里发生：`place-scene-objects` 工具随时可以重跑一遍（例如只想重新布局），并对缺框的对象用 `items=[{slug, box, heightMeters}]` 补框——`revise-scene-job` 新增的家具就属于这种情况。返回里会列出没能摆放的对象与原因（`no_box` / `no_model` / `unknown_slug`）。**需要说明精度边界**：World Labs 只回传世界的对齐参数（翻转、米制缩放、地面偏移），不回传原照片的相机位姿，世界本身也是生成而非度量重建，所以这是"左右顺序、相对远近、米制尺度都成立"的近似解，不是逐像素精确反投影；旧工程里没有 `box` 的分析结果会整批跳过摆放，要重新 `analyze-reference` 才会有框。

完整场景并不是唯一入口：`generate-clean-plate` 可以只生成或继续清理底板，`start-world-task(mode=direct)` 可以只生成世界，参考图与模型也保留各自的独立工具。发现漏掉家具时用 `revise-scene-job` 增补对象，只新增该对象的参考图和模型，并把受影响的底板、世界、摆放与最终汇总标为待重建；底板不够干净时用 `retry-scene-job-nodes` 重跑 `plate`，只连带重建 World、摆放与最终汇总，已经成功的物体模型保持不变。

单物体的参考图有两条来源：生成出来的，和**用户自己上传的**。用户上传一张干净的单物体照片说「把这个做成 3D 模型」时，Creator 用 `attach-source-image` 把这张原图直接登记为参考图（免费、不调用任何供应商、不需要付费同意）——参考图本来就是用户给的输入，再花钱画一张只会把真实物体的细节换成模型想象出来的版本。照片是场景照、有多件物体、或主体被遮挡时，改用 `generate-reference-images(mode=edit)` 把目标隔离成干净的单物体参考图（`assetSlug` 可以是还不存在的新对象，会一并登记；省略 `sourceImage` 就用本条消息那张图）；照片本身糊、主体出框才回到 `mode=generate` 重新生成。判档只看**输入图**，不靠"先生成出来看看、不行再换"——供应商对差输入照样出模型、照样收费，重来一遍就是付两次费。三档都要在 `ask-user` 卡片里写明用的是哪张图。绑定成功之后的 3D 生成仍是独立的一次付费同意，只有 `attach-source-image` 这一档允许在"新参考图落盘"之前取得它（那一档本来就没有新图要落盘）。Hi3D 是例外：它只吃 Seedream 产物的公网 URL，本地上传图必须先经 `mode=edit|generate` 出一张。

`ask-user` 是 Agent 需要用户本人做决定时的统一出口：付费操作同意、方案取舍、对象确认都走它，不再用自然语言提问后等用户打字。问题由模型给出（角标、正文、明细、选项、是否多选、是否允许自由输入），工作台渲染成可点选卡片；服务端在提问写进 SSE 后立即中止本轮 agent run，因此提问之后不可能再有工具被调用。用户点选后，回答走请求顶层的 `answer` 字段接回本轮上下文——**不是一条用户消息**：用户点的是卡片，历史里不会因此多出一条用户气泡，会话标题也不会被「同意」这类词占掉，界面上只在卡片内部显示「已选择：X」。用户直接打字回答时，卡片置灰保留在历史里。卡片与答案随会话落盘，刷新或换浏览器后仍可点选——它不依赖任何服务端状态。生成模型期间对话面板常常是收起的（只剩一行状态文字），所以待回答的问题一到就会自动展开，把卡片摆到用户面前；用户自己收起后同一个问题不再弹开，刷新后仍挂着的问题会重新展开（那正是「等你决定」的状态）。

`inspect` 是唯一的视觉检查工具（免费，服务端不渲染）：用户点名要看某个模型时用 `target="asset"`（默认 ISO/前/右/顶四视角，也可以用 `views` 只拍某个方向，例如只看底面有没有破洞），要看整个场景时用 `target="scene"`（按一个机位拍一张整场景图，机位为 iso/前/右/顶/左/后/底，由 Agent 看上一张图判断要不要换），要判断某个模型**摆在场景里合不合适**（贴不贴地、有没有穿模、和邻居的间距）时用 `target="closeup"`——工作台会把主视口的相机**真的飞到那个模型旁边**（与双击模型列表同一段缓动、同一个固定偏移，所以「agent 看到的」就是「你双击看到的」），到位后从那个机位拍一张带环境的特写，再**飞回出发前的机位**；这一趟里编辑器网格不参与取景，用户也看得见 Agent 在看哪儿。截图由工作台完成——单模型在预览小窗里拍，整场景与贴近检查在主视口里拍，取景只算场景里的内容，编辑器网格与天空背景球不参与——落盘后经请求的 `resume` 字段回传，接在下一轮上下文末尾，界面上渲染成 Agent 侧的 `Self-check` / `Scene check` / `Close-up check` 卡片，**不进入会话历史、不冒充用户发言**。触发口径是产品决策：只在用户明确要求检查、或用户对已经产出的模型/场景提出疑问时调用；**单模型生成完成不做自检**，唯一自动的一次是完整场景（`start-scene-job`）全部节点成功后的整场景检查，机位不合适时最多换 3 次再如实汇报（贴近检查没有可选机位，重复调用只会得到同一张图，提示词里明确不许靠换角度重试）。检查图落盘位置：单模型在 `assets/<asset>/inspections/<id>.png`（随资产留档），整场景与贴近检查在项目级的 `inspections/<id>.png`（一张图不属于任何单个资产）。

对话模型下拉菜单提供四个模型：GLM 5.3 Flash、DeepSeek V4.1 Flash、Doubao-Seed-Evolving、Doubao-Seed-2.1-pro，共用本机的 `VOLC_KEY` 和火山方舟地址 `https://ark.cn-beijing.volces.com/api/v3`。自动选择默认使用 GLM 5.3 Flash；旧版 `glm-5.3` 选择会迁移到 Flash，已移除的 Seed 2.0 Lite 选择会回退到默认模型。可用 `VOLC_LLM_BASE_URL` 覆盖地址，用 `VOLC_LLM_MODEL` 单独覆盖自动选择的默认模型。四个选项的实际模型 ID 或专属接入点 ID 可分别覆盖：

| 模型 | 默认 Model ID | 覆盖变量 |
| --- | --- | --- |
| GLM 5.3 Flash | `glm-5-3-flash-260828` | `VOLC_GLM_MODEL` |
| DeepSeek V4.1 Flash | `deepseek-v4-1-flash-260910` | `VOLC_DEEPSEEK_MODEL` |
| Doubao-Seed-Evolving | `doubao-seed-evolving` | `VOLC_DOUBAO_EVOLVING_MODEL` |
| Doubao-Seed-2.1-pro | `doubao-seed-2-1-pro-260915` | `VOLC_DOUBAO_PRO_MODEL` |

模型 ID 已于 2026-09-18 通过火山方舟 `/api/v3/models` 核对。修改旧版 `.env` 时，将 `VOLC_LLM_MODEL` 的 Seed 2.0 Lite 值删除或改为以上模型 ID，并重启本机服务。

火山影眸 Hyper3D、数美 Hi3D 的默认模型 ID 可分别用 `VOLC_HYPER3D_MODEL`、`VOLC_HI3D_MODEL` 覆盖。Hi3D 的方舟接口要求公网参考图 URL：当前流程可复用 Seedream 生成或编辑时的临时供应商 URL，正式工程文件仍保存在本机；仅有本地上传图时需先生成或编辑一张 Seedream 参考图。网页只获取是否配置的状态，不读取密钥；旧版浏览器保存的密钥会在启动时清除。

3D 生成下拉菜单选的是具体模型，不是渠道；目前显示 Auto、Tripo 3.1、Tripo P1、Tripo P2，Seed3D、Hyper3D、Hi3D 暂时隐藏，后端接入保留。选定的模型同时决定渠道与提交给供应商的模型 ID，`start-3d-batch` 由服务端按该选择钉住，Agent 传的 `provider` 参数会被忽略（留空 `Auto` 才由 Agent 判断）。完整接入表如下：

| 菜单项 | 渠道 | 默认 Model ID | 覆盖变量 |
| --- | --- | --- | --- |
| Seed3D 2.0 | `seed3d-direct` | `doubao-seed3d-2-0-260328` | — |
| Hyper3D Gen-2 | `hyper3d-volc` | `hyper3d-gen2-260112` | `VOLC_HYPER3D_MODEL` |
| Hi3D 2.0 | `hi3d-volc` | `hitem3d-2-0-251223` | `VOLC_HI3D_MODEL` |
| Tripo 3.1 | `tripo-direct` | `v3.1-20260211` | `TRIPO_IMAGE_MODEL` |
| Tripo P1 | `tripo-direct` | `P1-20260311` | — |
| Tripo P2 | `tripo-direct` | `P2-20260801` | — |

菜单项与模型 ID 的对应关系在 `chat/src/models/threeD.ts`（选择键是稳定契约，模型 ID 才允许被 env 覆盖）。展示开关在 `app/src/shared/storage/apiKeys.ts`：移除对应模型的 `hidden` 标记即可恢复。旧版浏览器里保存的 Tripo3D 渠道偏好会在加载时迁移成 Tripo 3.1，已保存的隐藏模型及其旧渠道偏好回退到 Auto。完整场景 SceneJob 的单物体模型目前固定用 Seed3D，不跟随这个选择。

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
| 环境变量 | `BUN_VERSION=1.3.14`、`SKIP_DEPENDENCY_INSTALL=1`、`VITE_CHAT_URL=http://127.0.0.1:3901` |

Pages 对没有根级 `404.html` 的 SPA 默认回退到 `index.html`，因此 `/app/:projectSlug` 可直接打开。设置稳定的 Pages 自定义域名后，将该完整 origin 加入本机服务的 `CHATSPACE_WEB_ORIGINS`，例如 `https://chatspace.example.com`。浏览器首次访问本机服务时可能要求本地网络权限。

工程和会话仍位于本机工程目录。网页向本机服务直连，Cloudflare 不接收项目 API 请求；调用第三方生成供应商时，任务输入会发送给相应供应商。Cloudflare 的实际部署及联通性验证按当前开发安排暂缓。

协议依据：[火山 Seedream 图片编辑](https://www.volcengine.com/docs/82379/1829186)、[火山影眸 Hyper3D](https://docs.volcengine.com/docs/82379/2279947?lang=zh)、[火山数美 Hi3D](https://docs.volcengine.com/docs/82379/2307070?lang=zh)、[Tripo3D API v3](https://developers.tripo3d.ai/en/docs/migration-v2-to-v3)、[World Labs API](https://docs.worldlabs.ai/api)。
