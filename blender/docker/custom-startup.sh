#!/usr/bin/env bash
# ChatSpace Blender —— Kasm 工作区启动脚本
# ========================================
#
# 放在 `/dockerstartup/kasm_startup.sh`。
#
# ## 为什么是这个路径（而不是自己写 ENTRYPOINT）
#
# 基座镜像的启动链是（实测 `docker history`）：
#
#   ENTRYPOINT ["/dockerstartup/kasm_default_profile.sh",
#               "/dockerstartup/vnc_startup.sh",
#               "/dockerstartup/kasm_startup.sh"]
#   CMD        ["--wait"]
#
# 而 `kasm_startup.sh` **在基座里并不存在** —— 它是 Kasm 留给派生镜像的扩展点
# （它自家的 blender / firefox 那些工作区镜像就是这么接的）。
#
# 一开始我用 `ENTRYPOINT ["/entrypoint.sh"]` 覆盖，那是错的：会把 profile 同步、
# VNC 启动整条链跳过，结果是"容器在跑、但没有桌面、也没有推流"。
#
# ## 在这里启动 Blender 还有一个额外好处
#
# 这个脚本是在**桌面已经起来之后**被调的，所以 DISPLAY 有效 —— Blender 能真的开窗口、
# 出现在推流画面里。这正是 A 路线（人要能实时看到）的前提，同时也是插件命令队列
# （跑在 `bpy.app.timers` 上）能工作的前提。
set -uo pipefail

MARKER="CS_PATCH"
BLENDER="${BLENDER_BIN:-/usr/local/bin/blender}"

# ⚠️ **不要在这里做全局重定向。** 第一版写了 `exec > >(tee -a "$LOG") 2>&1`，
# 后果是 `docker logs` 里一行 `[chatspace]` 都看不到（全进了文件）——
# 而排查"脚本到底跑没跑"时那正是最需要的信息。输出直接留给 docker logs，
# 需要留档由编排层去收。
# ⚠️ 面包屑：写在文件里，**不依赖 stdout 去哪**。实测这个脚本被 Kasm 的监督循环
# 报成 "Unknown Service: custom_startup"（注册键是 custom_startup、而 case 分支写的是
# custom_script，名字对不上），日志里一行它的输出都没有——所以先证明它到底跑没跑。
printf 'started %s DISPLAY=%s uid=%s\n' "$(date -Is)" "${DISPLAY:-unset}" "$(id -u)" \
  >> /tmp/cs-boot.log 2>&1 || true

# ⚠️ **必须设 XDG_RUNTIME_DIR。** 实测不设的话 Blender 5.x 走 Wayland 后端直接报
# `GHOST/Wayland: error: XDG_RUNTIME_DIR not set in the environment.` 并打一堆栈
# （socket 仍然能起来，但 GUI 是坏的）。Kasm 的会话不保证它存在，所以自己建。
# 权限必须是 700 —— XDG 规范要求，否则程序会拒绝使用。
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-kasm}"
mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

echo "[chatspace] $(date -Is) 启动脚本开始（DISPLAY=${DISPLAY:-未设置}）"

# ---- 关掉社区版遥测 ---------------------------------------------------------
# 三个别名全设。**这只是意图**；真正的执行是网络策略（见 blender/README.md）。
export DISABLE_TELEMETRY=1
export BLENDER_MCP_DISABLE_TELEMETRY=1
export MCP_DISABLE_TELEMETRY=1

if [[ ! -x "$BLENDER" ]]; then
  echo "[chatspace] 致命：找不到 Blender（$BLENDER）" >&2
  exit 1
fi
echo "[chatspace] $("$BLENDER" --version | head -1)"

# ---- 自检（顺手修）----------------------------------------------------------
# 放在启动而不是只放在构建：卷被清空、插件被手改、或者插件在运行时才注册失败，
# 这几种都不会在镜像里体现出来。**自检不过要以非零码退出** —— 一个"看着在跑、
# 其实驱动不了"的容器是最贵的那种。
selfcheck() {
  "$BLENDER" --background --python-expr "exec(open('/patch/selfcheck.py').read())" 2>&1 \
    | grep -q "${MARKER}_SELFCHECK_OK"
}

if [[ "${CHATSPACE_SKIP_SELFCHECK:-0}" != "1" ]]; then
  if selfcheck; then
    echo "[chatspace] 自检通过"
  elif [[ "${CHATSPACE_PATCH_REPAIR:-1}" == "1" ]] \
       && python3 /patch/install.py --blender "$BLENDER" && selfcheck; then
    echo "[chatspace] 自检最初没过，重装补丁后通过"
  else
    echo "[chatspace] 致命：自检没过，而且重装也没救回来。" >&2
    "$BLENDER" --background --python-expr "exec(open('/patch/selfcheck.py').read())" 2>&1 | tail -30 >&2
    exit 1
  fi
fi

# ---- 无头模式（显式选择时）---------------------------------------------------
if [[ "${CHATSPACE_NO_GUI:-0}" == "1" ]]; then
  echo "[chatspace] CHATSPACE_NO_GUI=1：无头启动。**没有人能看到画面**，只能跑流水线。"
  exec "$BLENDER" --background --python-expr "import bpy; bpy.ops.mcp.start_server() if hasattr(bpy.ops, 'mcp') else None"
fi

# ---- 启动 Blender GUI --------------------------------------------------------
# ⚠️ **把 addon 的监听地址改成 0.0.0.0，否则容器外连不进来。**
# 社区版 addon 默认绑 `localhost`（`BlenderMCPServer.__init__(self, host='localhost')`），
# 在容器里那只监听 127.0.0.1，而 **Docker 的端口转发是从网关 IP 连进来的** → 连接被拒。
# 症状极具误导性：容器内 `ss` 显示 9876 在听、宿主机 `nc` 也"通"（那是 Docker 代理接受的），
# 但 MCP 握手返回 `source=error` / `Connection closed before receiving any data`。
# 必须在 Blender 启 GUI **之前**改好并落盘，因为 addon 是在 register 时按这个偏好起 server 的。
if [[ "${CHATSPACE_BIND_ALL:-1}" == "1" ]]; then
  "$BLENDER" --background --python-expr "
import bpy
p = bpy.context.preferences.addons.get('blender_mcp')
if p is not None:
    p.preferences.host = '0.0.0.0'
    print('[chatspace] addon host -> 0.0.0.0')
bpy.ops.wm.save_userpref()
" 2>&1 | grep -E "chatspace|Error" | head -3 || true
fi

echo "[chatspace] 启动 Blender（DISPLAY=${DISPLAY:-未设置}）…"
"$BLENDER" --window-geometry 0 0 1440 900 &
BLENDER_PID=$!
echo "[chatspace] Blender pid=$BLENDER_PID"

# 等 addon socket。**这一步让"容器起来了"和"能被驱动了"变成两个可区分的状态**：
# 编排层/客户端一连就是通的，不用自己重试；而如果它一直不通，日志里看得到。
for i in $(seq 1 90); do
  if (echo > /dev/tcp/127.0.0.1/9876) 2>/dev/null; then
    echo "[chatspace] addon socket 9876 已就绪（等了 ${i}s）"
    break
  fi
  if ! kill -0 "$BLENDER_PID" 2>/dev/null; then
    echo "[chatspace] 致命：Blender 进程已经退出，没等到 socket。" >&2
    exit 1
  fi
  sleep 1
  if [[ "$i" == "90" ]]; then
    echo "[chatspace] 警告：90 秒还没等到 9876。Blender 在跑，但插件可能没启动监听。" >&2
    echo "[chatspace] 在 Blender 的 3D 视口侧栏（N 键）里手动 Start 一次即可。" >&2
  fi
done

# 这个脚本是 ENTRYPOINT 链的最后一环，**必须保持前台**，否则容器会立刻退出。
# ── 对外中继：把 9877 转发到 addon 的 127.0.0.1:9876 ──────────────────────────
#
# **为什么不直接改 addon 的监听地址**：试过了，没用。我在启 GUI 之前用
# `bpy` 把偏好 `host` 写成 `0.0.0.0` 并 `save_userpref()`，日志确实打了
# `addon host -> 0.0.0.0`，但起来之后 `/proc/net/tcp` 里仍然是 `0100007F:2694`
# 也就是 **127.0.0.1**（从容器内连自己的 eth0 IP 也不通）。所以那条路不通、
# 而且它依赖 addon 内部实现，改版就可能再坏一次。
#
# 中继的好处是**与 addon 怎么绑完全无关**：它绑哪儿都行，我们只对外暴露自己的端口。
# 这也是这类"容器内服务只绑 localhost"问题的标准解法。
#
# compose 里映射的是 `127.0.0.1:9876 -> 容器:9877`，
# 所以 chat/ 那边看到的仍然是熟悉的 9876，配置一个字都不用改。
if command -v socat >/dev/null 2>&1; then
  echo "[chatspace] 启动 socat 中继 0.0.0.0:9877 -> 127.0.0.1:9876"
  # `nodelay` 是实测加上去的：不带它时 `get_addon_status`（短应答）能通、
  # 而 `execute_blender_code`（要进 Blender 主线程的 timer 队列、跨度更长）会
  # 被对端以 `Connection closed before receiving any data` 断开。
  socat TCP-LISTEN:9877,fork,reuseaddr,nodelay TCP:127.0.0.1:9876 &
  sleep 1
  if (echo > /dev/tcp/127.0.0.1/9877) 2>/dev/null; then
    echo "[chatspace] 中继 9877 已就绪"
  else
    echo "[chatspace] 警告：中继 9877 没起来，容器外将无法连接" >&2
  fi
else
  echo "[chatspace] 警告：没有 socat，容器外无法连接（addon 只绑 127.0.0.1）" >&2
fi

echo "[chatspace] 进入等待（保持容器存活）"
wait "$BLENDER_PID"
