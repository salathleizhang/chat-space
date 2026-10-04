#!/usr/bin/env bash
# 把钉版本的 Blender 取到 docker/vendor/，供镜像构建时 COPY。
#
# ## 为什么要这一步（而不是让 Dockerfile 直接 curl）
#
# 实测 `download.blender.org` 会在 **3 MB/s 与 178 KB/s 之间跳**——慢的时候下一次
# 366 MB 要 35 分钟。而 Docker 的层缓存只要被无关改动（改一个 ARG、调一下 COPY 顺序）
# 打掉一次，就要白等一整轮。我这轮为此白等了两次。
#
# 所以把下载**移出构建**：宿主机下一次、带断点续传、可反复重跑；
# 之后每次构建都只是本地 COPY（秒级）。`vendor/` 已进 .gitignore —— 不进 Git，
# 但要留在磁盘上。
#
# ## 为什么默认走清华镜像
#
# 同一条命令、同一时刻实测（2026-10-04）：
#
#     清华 TUNA  https://mirrors.tuna.tsinghua.edu.cn/blender/release/…  34.8 MB/s
#     官方       https://download.blender.org/release/…                  178 KB/s
#
# **差 195 倍**（366 MB：11 秒 vs 35 分钟）。镜像路径是 `/blender/release/…`，
# 注意**不是** `/blender/blender-release/…`（那个 404，我试错过）。
# 中科大没有这个镜像（404）。官方源保留作兜底。
#
# 用法：  ./fetch-blender.sh [版本]
set -euo pipefail

VERSION="${1:-5.2.2}"
MAJOR_MINOR="$(echo "$VERSION" | cut -d. -f1-2)"
FILE="blender-${VERSION}-linux-x64.tar.xz"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor"
TARGET="$VENDOR/$FILE"

# 顺序有意义：快的在前。换源时 `-C -` 仍会续传（各镜像服务的是同一份文件）。
SOURCES=(
  "https://mirrors.tuna.tsinghua.edu.cn/blender/release/Blender${MAJOR_MINOR}/${FILE}"
  "https://download.blender.org/release/Blender${MAJOR_MINOR}/${FILE}"
)

mkdir -p "$VENDOR"

file_size() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }

# 已经完整下过就跳过。判据是**大小 + 能列出归档内容**，不是"文件存在"——
# 断点续传会留下半截文件，而"存在"会把半截文件当成完成。
if [[ -f "$TARGET" ]]; then
  SIZE=$(file_size "$TARGET")
  if [[ "$SIZE" -gt 300000000 ]] && tar -tJf "$TARGET" >/dev/null 2>&1; then
    echo "[fetch-blender] 已存在且完整（$((SIZE / 1024 / 1024)) MB）：$TARGET"
    exit 0
  fi
  echo "[fetch-blender] 已有文件不完整（$((SIZE / 1024 / 1024)) MB），继续续传…"
fi

for URL in "${SOURCES[@]}"; do
  HOST=$(echo "$URL" | awk -F/ '{print $3}')
  echo "[fetch-blender] 尝试 $HOST"
  # `--retry-all-errors` + `-C -`：源站偶发截断时接着下，不必从头再来。
  if curl -fL --retry 10 --retry-delay 3 --retry-all-errors --connect-timeout 15 \
          --max-time 3600 -C - -o "$TARGET" "$URL"; then
    # **必须验完整性**：下载"成功"不等于文件能用（截断、HTTP 200 里夹着错误页都见过）。
    # `tar -tJf` 会真去解压流，能抓出截断与损坏；坏文件进镜像的代价是构建后期才炸。
    if tar -tJf "$TARGET" >/dev/null 2>&1; then
      SIZE=$(file_size "$TARGET")
      echo "[fetch-blender] 完成并通过完整性校验：$((SIZE / 1024 / 1024)) MB → $TARGET"
      exit 0
    fi
    echo "[fetch-blender] $HOST 下到的文件校验不过（截断或损坏），换下一个源重试" >&2
    rm -f "$TARGET"
  else
    echo "[fetch-blender] $HOST 失败，换下一个源" >&2
  fi
done

echo "[fetch-blender] 所有源都失败了。手动下载后放到：$TARGET" >&2
exit 1
