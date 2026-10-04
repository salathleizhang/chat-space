# Blender 集成

给 ChatSpace 的 agent 一个真正的 DCC：**建模 → 导出 → 进资产库**，并且**人能看到它在干什么**。

```
chat/ (Mastra, 我们的 8 个工具)
   ⇅ MCP / stdio
mcp-for-blender（社区版 MCP server，本地代理，自己拉 Python）
   ⇅ TCP socket :9876      ← ⚠️ 这个 socket 没有任何鉴权
Blender 5.2.2 + MCP 插件
```

---

## 一、这里的三个目录

| 目录 | 是什么 | 平台 |
| --- | --- | --- |
| `patch/` | **可移植的补丁**：装 MCP 插件、按清单装社区插件、启用、自检 | Linux **和** macOS |
| `docker/` | 把同一份补丁装进 Linux 容器，并把画面推出去 | Linux (amd64) |
| `addon/` | ⚠️ **已作废**。早期自研的插件，在我们改用社区版之后就没有用了，建议删 | — |

**核心口径：补丁是交付单元，Docker 只是它的一种运行方式。** 容器里跑的也是
`patch/install.py`，所以"Mac 上验过"和"容器里验过"是同一套逻辑，不是两套。

---

## 二、两种跑法（同一份补丁）

### A. Docker（Day-1 主路径）

```bash
cd blender/docker
./fetch-blender.sh          # ← 首次必须：把钉版本的 Blender 取到 vendor/（约 500 MB）
docker compose up --build
```

> **为什么下载要单独一步**：实测 `download.blender.org` 的速度会在 **3 MB/s 与 180 KB/s
> 之间跳**——后者下一次要 45 分钟。而 Docker 层缓存只要被无关改动打掉一次就要白等一整轮。
> 所以把下载移出构建：宿主机下一次（带断点续传、可反复重跑），之后每次构建只是本地 COPY。
> `vendor/` 已进 `.gitignore`：不进 Git，但要留在磁盘上。让 CI 自包含时把 Dockerfile 里
> 那条 COPY 换回 curl 即可。

- 人看画面：<http://localhost:6901>（口令见 `compose.yaml` 的 `VNC_PW`）
- chat/ 驱动：`BLENDER_ENABLED=1 BLENDER_HOST=127.0.0.1 BLENDER_PORT=9876`

### B. macOS 原生（可选，做补丁迭代时更快）

```bash
# 装 Blender 5.2.2（官方源；brew cask 的 blender 在本机是坏的：
#   Cask 'blender' definition is invalid: undefined method 'command_wrapper'）
curl -L -o /tmp/b.dmg https://download.blender.org/release/Blender5.2/blender-5.2.2-macos-arm64.dmg
hdiutil attach /tmp/b.dmg && cp -R /Volumes/Blender/Blender.app /Applications/

python3 blender/patch/install.py --blender /Applications/Blender.app/Contents/MacOS/Blender
```

macOS 上**不需要**共享目录配置（Blender 与 chat/ 同一个文件系统），
`blender-export` 会走 `os.tmpdir()` 那条路。

---

## 三、必须知道的硬事实

### ⚠️ 容器只能是 amd64

**Blender 官方不提供 Linux arm64 构建。** 实测 `download.blender.org`：

```
Blender4.5 / 5.0 / 5.1 / 5.2  →  只有 linux-x64.tar.xz
```

所以在 Apple Silicon 上必须走 Rosetta 2 模拟。这**不是妥协**——目标服务器几乎肯定是
amd64，于是你在本地开发的就是最终要部署的那个架构。代价是模拟下慢约 1.5–3×。

前提：Docker Desktop → Settings → General → 打开 **"Use Rosetta for x86_64/amd64 emulation"**。

### ⚠️ addon socket 没有任何鉴权

实测社区版 `addon.py`：**没有 token、没有密码、没有来源校验**，默认只绑 `localhost`。

→ `compose.yaml` 里端口**只绑 `127.0.0.1`**。要跨机访问，走 SSH 隧道，或者自己写一个带
token 的反代。**不要把这个端口直接暴露出去** —— 那等于给同网段任何人一个
"在你的 Blender 里执行任意 Python"的入口。

### ⚠️ 社区版遥测默认是开的

装了 `mcp-for-blender` 之后我读了它**装好的** `config.py`（仓库里那份被 gitignore 了，
`src/blender_mcp/config.py`，所以只看 GitHub 审计不到收件人）：

```python
supabase_url = "https://<第三方项目>.supabase.co"
supabase_anon_key = "<内嵌>"          # 明文内置
enabled: bool = True                   # ← 默认开启
supabase_bucket = "telemetry-screenshots"
```

默认档（未授权）也上报：持久 `customer_uuid`、`session_id`、`tool_name`、成功与否、耗时、
平台、版本。**授权之后**还会带上提示词、**代码片段**、截图、场景信息——而 `execute_blender_code`
正是我们必须敞开的那把刀。

三道防线：

1. **环境变量**（`patch/install.py` 与 `docker/entrypoint.sh` 都设了三个别名）
   `DISABLE_TELEMETRY=1` / `BLENDER_MCP_DISABLE_TELEMETRY=1` / `MCP_DISABLE_TELEMETRY=1`
2. **Blender 面板里的 "Allow Telemetry" 保持不勾**（本来就是默认）
3. **网络策略才是真正的执行** —— 环境变量只是意图。生产镜像建议默认不出网
   （`compose.yaml` 里留了注释好的 `internal: true` 网络）

---

## 四、必需的环境变量（chat/ 侧）

| 变量 | 作用 |
| --- | --- |
| `BLENDER_ENABLED=1` | 打开这 8 个工具。**默认关闭**——没有 Blender 时不该让模型看见它们 |
| `BLENDER_HOST` / `BLENDER_PORT` | **Blender 所在那台机器**的 socket 地址（默认 `127.0.0.1:9876`） |
| `BLENDER_MCP_BIN` / `BLENDER_MCP_ARGS` | 默认 `uvx mcp-for-blender`。注意**可执行文件与包同名**，改名前叫 `blender-mcp` |
| `BLENDER_WORKDIR` | **Blender 看到的**共享目录（容器里是 `/workspace`） |
| `CHATSPACE_BLENDER_WORKDIR` | **chat/ 看到的**同一个目录（宿主机上是 `~/ChatSpace/blender-work`） |

最后两个就是"文件怎么过去"那条缝。两个都不给 = 同一文件系统（macOS 原生那条路）。
映射逻辑在 `chat/src/mastra/tools/blenderOps.ts` 的 `mapWorkdirPath()`，
**上云时只换这一个函数**（从"读本地文件"变成"从沙箱取回字节"）。

---

## 五、验证状态（诚实版）

| | 状态 |
| --- | --- |
| 传输层（MCP stdio、握手、白名单、超时、进程树回收） | ✅ 已验：23 条测试 + 对**真** `mcp-for-blender` 的实机验证 |
| 工具层（8 个工具、小步闸门、路径映射） | ✅ 已验：21 条测试 |
| chat/ 全量 | ✅ 542 pass / 0 fail |
| 社区版 addon 能不能在 Blender **5.2** 上装并启用 | ❌ **未验**（本机还没装 Blender） |
| `patch/install.py` 端到端 | ❌ **未验**（需要 Blender） |
| Dockerfile 能不能构建出来 | ❌ **未验**（写的时候 Docker 守护进程没起） |
| 容器里的 KasmVNC 启动集成 | ❌ **未验** —— `entrypoint.sh` 里标了 ⚠️ 的那几处是最可能要调的 |
| "agent 小步建模 → 导出 → 进资产库"真实链路 | ❌ **未验** —— 这是最大的未知数 |

**首次构建时优先核对三件事**：

```bash
# 1. Kasm 基座的用户布局（Dockerfile 里的 RUNTIME_USER/HOME）
docker run --rm --platform linux/amd64 kasmweb/core-ubuntu-jammy:1.19.0 id

# 2. Kasm 的启动钩子路径（entrypoint.sh 最后那段）
docker run --rm --platform linux/amd64 kasmweb/core-ubuntu-jammy:1.19.0 ls /dockerstartup

# 3. 补丁装完之后，插件到底启用了没有
docker compose exec blender blender --background --python-expr \
  "exec(open('/patch/selfcheck.py').read())"
```

---

## 五之二、怎么验收（一条命令）

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd blender/docker && docker compose up -d          # 起容器（首次先 ./fetch-blender.sh）

# 只验"能连上 + 能建模"（不需要项目）
bun run --cwd chat scripts/verify-blender.ts

# 连"导出进资产库"一起验（需要一个真实项目 slug，且容器挂着共享卷）
BLENDER_WORKDIR=/workspace \
CHATSPACE_BLENDER_WORKDIR="$HOME/ChatSpace/blender-work" \
  bun run --cwd chat scripts/verify-blender.ts <项目slug>
```

**为什么要写成脚本而不是一段文档**：这条链有四层，而**每一层的失败症状都长得像另一层的失败**——

| 层 | 失败症状 | 真凶在哪 |
| --- | --- | --- |
| 1 容器 | 日志停在 pulseaudio / `Unknown Service: custom_startup` | 看 §三 的 16–20 条 |
| 2 端口通但连不上 | `source=error`（而 `nc` 说"通"——那是 Docker 代理接受的） | addon 只绑 localhost |
| 3 连上了但执行不了 | `Connection closed before receiving any data` | **上一次调用里跑了 `read_factory_settings`，addon 已被打死**（见下） |
| 4 执行了但拿不到事实 | 面数全是 `undefined` | 误用了社区版 `get_scene_info` |

脚本**逐层单独给结论**，哪层红了一眼就知道该往哪看，不用从一头猜。

### ⚠️ 单向陷阱：`read_factory_settings` 会打死桥接

实测（容器里逐项验过）：

```
① 动之前:  get_addon_status → source=native     ← addon 活着
② 执行:    bpy.ops.wm.read_factory_settings(use_empty=True)
③ 之后:    get_addon_status → source=error      ← addon 死了，之后永远连不上
```

它会**卸载并重载全部插件**，而 ChatSpace 的 socket 服务就挂在插件上。Blender 不报错、
那次调用也"成功"，但桥接从此断掉——**只能重启 Blender/容器**。症状看起来像"容器坏了"。

**工具层直接拦住了它**（`BRIDGE_KILLING_CALLS`），并把安全替代一起给出去：

```python
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
```

> 我一度以为这是"连接累积"，还去调了 socat。**那个诊断是错的**：实测 8 轮连接前后
> socat 进程数与线程数都不变，没有泄漏。这条记在这里，免得下次又往 socat 上想。

**看画面**：<http://localhost:6901>（口令 `chatspace`）—— 应该看到 XFCE 桌面和 Blender 窗口。

**让 agent 真的动手**（走 UI）：

```bash
BLENDER_ENABLED=1 \
BLENDER_WORKDIR=/workspace \
CHATSPACE_BLENDER_WORKDIR="$HOME/ChatSpace/blender-work" \
  bun run --cwd chat start
```

然后对 agent 说「用 Blender 做一块带孔的安装板」。`BLENDER_ENABLED=1` 才会把这 8 个工具注册给它
（默认关闭——没有 Blender 时不该让它看见这些工具）。

---

## 六、社区插件

清单在 `patch/plugins.txt`。三种写法：`extension` / `addon` / `path`。

**现在这份清单是空的**——Day 1 真正必须有的只有社区版 MCP 插件本身，那个由
`install.py` 单独负责（它有自带的跨平台安装器和版本检查）。

要加插件时按清单写法加进去再重跑 `install.py`：它会**装、启用、并当场验证真的启用了**。
任何一项装不上或启用不了，**整个安装以非零码退出** —— 因为"装了但静默没启用"是这整条
链路上最贵的一类故障（症状是几天后一句含混的 `context is incorrect`）。

> 迁移提示：把本机攒的插件搬进容器时，**不要拷 `userpref.blend`**。那是个不透明的二进制
> blob，你不知道里面有什么。用清单重装一遍。绝大多数 Blender 插件是纯 Python，跨平台
> 直接可用；少数带编译依赖的必须换 Linux 构建。
