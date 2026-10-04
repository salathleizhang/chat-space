# ChatSpace Blender 容器
# ======================
#
# 这一层只做一件事：**把 `patch/` 装进一个 Linux 环境，并把画面推出去。**
# 补丁本身是平台无关的（同一份也能装在 macOS 上，见 patch/README）。
#
# ── 为什么钉死 linux/amd64 ────────────────────────────────────────────────────
#
# **Blender 官方不提供 Linux arm64 构建。** 实测 download.blender.org：
#   Blender4.5 / 5.0 / 5.1 / 5.2  →  只有 linux-x64.tar.xz，没有 linux-arm64
# 所以在 Apple Silicon 上必须走 amd64（Docker Desktop 用 Rosetta 2 模拟）。
#
# 这**不是**妥协，反而对齐了目标：你的服务器几乎肯定是 amd64，
# 于是本地开发的就是最终要部署的那个架构，不会出现"本地好好的、上服务器就不对"。
# 代价是模拟下会慢（Rosetta 大约 1.5–3×）。前提：Docker Desktop →
# Settings → General → 打开 "Use Rosetta for x86_64/amd64 emulation"。
#
# ── 为什么基于 Kasm 的 core 镜像 ──────────────────────────────────────────────
#
# 自己拼 Xvfb + x11vnc + noVNC + websockify 是四五个会各自出错的部件；
# Kasm 的 core 镜像把 KasmVNC（纯 WebSocket 的浏览器远程桌面，不需要 TURN）装好了。
# 注意：**不要**用 `kasmweb/blender` —— 那个镜像自带一个旧 Blender 和一堆工作区杂物，
# 而我们要的是钉死版本的 Blender，所以只用它的 core 基座。
#
# ⚠️ 未验证项：Kasm 基座的用户布局（`kasm-user` / HOME / VNC 启动钩子）我在写这份
# Dockerfile 时**没能实测**（当时 Docker 守护进程没起）。标了 ⚠️ 的几处是首次构建时
# 最可能需要调的地方。

FROM --platform=linux/amd64 kasmweb/core-ubuntu-jammy:1.19.0

ARG BLENDER_VERSION=5.2.2
ARG DEBIAN_FRONTEND=noninteractive

# ⚠️ Kasm 基座的运行用户。首次构建时用 `docker run --rm <image> id` 核对。
ARG RUNTIME_USER=kasm-user
ARG RUNTIME_HOME=/home/kasm-user
# ⚠️ **USER 只能写数字 UID，不要写 `UID:GID`，也不要写用户名。** 三种写法实测对照：
#
#     User=1000        （基座用的，也是唯一能跑起来的）  → running  ✅
#     User=1000:1000   （我一度改成这样）                → exited 1 ❌
#     User=kasm-user   （我最初写的）                    → exited 1 ❌
#
# 写用户名时 Docker 要进容器查 `/etc/passwd` 再解析，与数字 UID 不是同一条路径。
# 写 `UID:GID` 时 Docker 只设那一个主组、**丢掉 `/etc/passwd` 里的补充组**，
# 于是 pulseaudio 写 `/var/run/pulse` 权限不足 → 会话起不来。
# 症状三者一模一样：日志停在 `pulseaudio … Permission denied`，然后 exit 1。
# **照基座写一个裸 UID 就对了。**
ARG RUNTIME_UID=1000

USER root

# 运行用户必须真的存在。**不要**用 `|| true` 把失败吞掉 —— 用户不存在时后面每一步
# 都会以奇怪的姿势失败（权限、找不到 HOME），而那正是这个补丁要消灭的静默失败。
RUN id "${RUNTIME_USER}" >/dev/null 2>&1 || { \
      echo "基座里没有用户 ${RUNTIME_USER}。先跑 docker run --rm <image> id 核对，再改 ARG。" >&2; \
      exit 1; \
    }

# Blender 官方 Linux 构建的运行时依赖。
# 无头渲染要 libgl/libegl；没有 GPU 时 Mesa 会退到 llvmpipe 软件渲染。
#
# ⚠️ **先把 apt 源换成清华镜像。** 实测 `archive.ubuntu.com` / `security.ubuntu.com`
# 在这个网络下会反复 `Ign:`（拿不到索引）并把整轮构建拖死——和 Blender 官方源是同一类问题，
# 同一个解法。Kasm 基座的 sources.list 是 Ubuntu 默认的，直接 sed 换掉。
# 换源只在构建层生效，不影响最终镜像跑起来之后的任何行为。
RUN set -eux; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|http://archive.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g; \
              s|http://security.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' \
          /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      curl xz-utils ca-certificates gnupg \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 \
      libgl1 libglu1-mesa libegl1 libgomp1 libsm6 libice6 \
      python3 python3-venv socat; \
    # ⚠️ /run/pulse 的属主修复挪到**文件末尾的最后一层**——实测写在 apt 层里会被
    # 后面的层改回去（apt 装完是 kasm-user:root 755，最终镜像里又变回 root:root 700）。
    rm -rf /var/lib/apt/lists/*

# 钉版本的 Blender。
#
# **从本地 vendor/ COPY，不从网上每次重下。** 理由：实测 download.blender.org 的速度会在
# 3MB/s 与 180KB/s 之间跳，后者下一次 500MB 要 45 分钟；而这一层只要被 ARG 变更之类的
# 原因失效一次，整个构建就白等一轮。
#
# 首次使用先跑：`./fetch-blender.sh`（带断点续传，可反复重跑）。
# 想让 CI 完全自包含时，把下面 COPY 换回 curl 即可（旧写法见 git 历史）。
COPY docker/vendor/blender-${BLENDER_VERSION}-linux-x64.tar.xz /tmp/blender.tar.xz
RUN set -eux; \
    mkdir -p /opt/blender; \
    tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1; \
    rm /tmp/blender.tar.xz; \
    ln -sf /opt/blender/blender /usr/local/bin/blender; \
    blender --version | head -1

# MCP for Blender —— **只在构建期需要**（用它把 addon 装进 Blender），运行时不需要它。
#
# ⚠️ 为什么不用官方那个 `curl https://astral.sh/uv/install.sh | sh`：
#
# 1. **`curl … | sh` 会吞掉 curl 的失败。** 管道退出码是 `sh` 的，而 `/bin/sh` 是 dash、
#    不支持 `pipefail`；curl 因 SSL 中断拿不到脚本时 sh 会拿空输入"成功"退出，
#    直到下一句才报 `not found`——**错误指向 uv，根因却在网络**。实测踩过。
# 2. **uv 安装器会去 GitHub Releases 拉二进制**，而 GitHub 在这个网络下时通时不通
#    （实测卡在 `downloading uv 0.12.23 x86_64-unknown-linux-gnu` 不动）。
#    清华的 `github-release` 镜像也没有 astral-sh/uv。
# 3. **PyPI 是通的**（实测 `pip install` 十几秒完成），而 uv 在这里唯一的作用就是装这个包。
#
# 所以直接从 PyPI 装到独立 venv：少一层依赖、少一个 GitHub 单点。
# 运行时 MCP server 是 **chat/ 在宿主机上**起的（它连容器的 9876），所以这里只需构建期可用。
#
# ⚠️ **pip 的选项是 `--retries` 不是 `--retry`**（实测报 `no such option: --retry`，
# exit 2）。而且 Jammy 自带的是 pip 22.0.2，很多新选项都没有——所以重试放在 **shell 层**，
# 不赌 pip 的选项表。
RUN set -eux; \
    python3 -m venv /opt/mcp; \
    ok=0; \
    for i in 1 2 3 4 5; do \
      if /opt/mcp/bin/pip install --no-cache-dir --timeout 60 mcp-for-blender; then ok=1; break; fi; \
      echo "pip install 失败（第 $i 次），重试…" >&2; sleep 5; \
    done; \
    [ "$ok" = 1 ]; \
    ln -sf /opt/mcp/bin/mcp-for-blender /usr/local/bin/mcp-for-blender; \
    mcp-for-blender --help >/dev/null; \
    chmod -R a+rX /opt/mcp; \
    mcp-for-blender --help | head -2

# 补丁：平台无关的那一份。
#
# ⚠️ **HOME 必须指到运行用户。** Blender 的配置目录（插件落在这里）由 HOME 决定；
#    不指的话插件会装进 `/root/.config/blender`，而运行时是 uid 1000 —— 同样看不见。
#    "装了但看不见"正是这个补丁要消灭的那类静默失败。
#
# `mcp-for-blender` 已由上面的 venv 装到 `/usr/local/bin`（全局可读），
# 所以这里直接用它、不需要 uv。
COPY patch /patch
# ⚠️ **755，不是 `+x`。** 同一个坑在这一层又踩了一次：`chmod +x` 只加执行位、
# **不给读权限**，而 `python3 /patch/install.py` 需要把文件读进来 →
# `[Errno 13] Permission denied`。这份 Dockerfile 里凡是 uid 1000 要用的文件，
# 权限一律写全（755），不要用 `+x` 递推。
RUN chmod 755 /patch/install.py /patch/selfcheck.py /patch && ls -l /patch \
    && HOME="${RUNTIME_HOME}" \
       BLENDER_MCP_BIN=mcp-for-blender \
       BLENDER_MCP_ARGS="" \
       python3 /patch/install.py --blender /usr/local/bin/blender \
    && chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${RUNTIME_HOME}"

# ── 启动脚本：接到 Kasm 的官方扩展点上 ────────────────────────────────────────
#
# 基座镜像的启动链是（实测 `docker history`）：
#
#   ENTRYPOINT ["/dockerstartup/kasm_default_profile.sh",
#               "/dockerstartup/vnc_startup.sh",
#               "/dockerstartup/kasm_startup.sh"]
#   CMD        ["--wait"]
#
# ⚠️ **但不要把脚本放在 `kasm_startup.sh`。** 实测（本机 1.19.0 基座）：
# `kasm_default_profile.sh` 把剩下的参数 exec 给 `vnc_startup.sh`，而 `vnc_startup.sh`
# **不执行那些参数**——所以放在 `kasm_startup.sh` 的脚本一次都不会跑，容器则因为主进程
# 退出而被反复重启（实测 restarts=13、exit=0、日志里没有任何来自我们脚本的行）。
#
# `vnc_startup.sh` 真正认的扩展点是 `/dockerstartup/custom_startup.sh`（`vnc_startup.sh:448`）：
# 它在 KasmVNC 环境起来之后被调用（`:641`），**放在后台跑**、PID 记进 `KASM_PROCS`
# （`:455-456`），并且监督循环会在它退出时自动重启（`:722`）。
# 它自己的注释也写明了契约：**custom startup 脚本不该退出，要自己跟踪目标进程**——
# 我们的脚本正是 `blender ... &` + `wait`。
#
# 放在这个位置还有个额外好处：它是在**桌面已经起来之后**才被调的，
# 所以 DISPLAY 有效 —— Blender 能真的开窗口、出现在推流里。
# ⚠️ **权限必须是 755，不能只 `chmod +x`。** 实测踩到的是 711（`-rwx--x--x`）：
# 属主可读写、其他人**只能执行不能读**。而 shell 脚本执行时内核读完 shebang 之后，
# **bash 还要能把文件内容读进来** —— uid 1000 没有读权限，于是 bash 一启动就死：
# 没有输出、没有报错、进程瞬间消失。症状是容器稳定运行、端口都通，但这个脚本
# **从来没有真正执行过一行**（用文件面包屑证实的：面包屑文件根本没被创建）。
# `COPY --chmod=755` 是显式的写法，不依赖源文件在宿主机上的 mode。
COPY --chmod=755 docker/custom-startup.sh /dockerstartup/custom_startup.sh
RUN chmod 755 /dockerstartup/custom_startup.sh && ls -l /dockerstartup/custom_startup.sh

# Blender addon 的 socket（chat/ 连这个）与 KasmVNC（人看这个）
EXPOSE 9876 6901

# ── 最后一层：修 /run/pulse 的属主 ─────────────────────────────────────────────
#
# **必须放在最后。** 实测把它写在 apt 那一层里：构建日志显示 `chown kasm-user:root
# /run/pulse` 确实执行了（`set -eux` 打出来了），但最终镜像里它又变回 `root:root 700`——
# 被后面的层改回去了。放最后才不会被覆盖。
#
# 为什么它决定容器能不能起来（对照实验）：
#
#     基座运行态   drwx------  kasm-user:kasm-user  /run/pulse   → 桌面正常
#     我的（坏）   drwx------  root:root           /run/pulse   → kasm-user 无权写
#
# 后果是一条完整的静默失败链：pulseaudio `Permission denied` → XFCE 会话起不来 →
# `vnc_startup.sh` 退出 → **容器 exit 1 反复重启**，而日志里只有一句 pulseaudio 的警告，
# 完全看不出跟 apt 有关（`/var/run` 是 `/run` 的软链，两处一起坏）。
# 根因是 `apt-get install` 重新配置了 pulseaudio 包、按默认把这个目录建成了 root:root 0700。
RUN set -eux; \
    if [ -d /run/pulse ]; then \
      chown "${RUNTIME_USER}:${RUNTIME_USER}" /run/pulse; \
      chmod 700 /run/pulse; \
      ls -ld /run/pulse; \
    fi

USER ${RUNTIME_UID}
WORKDIR ${RUNTIME_HOME}

