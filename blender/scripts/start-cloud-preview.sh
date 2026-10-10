#!/bin/bash
# Local acceptance preview; credentials stay in child-process environments.
set -euo pipefail
set +x
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
preview_bun="$HOME/.bun/bin/bun"
preview_node="$(command -v node || true)"
if [[ ! -x "$preview_bun" ]]; then
  echo '未找到 Bun，请先安装或调整脚本中的 Bun 路径。' >&2
  exit 1
fi
if [[ -z "$preview_node" ]]; then
  echo '未找到 Node.js；Vite 的原始 WebSocket 代理需要 Node 运行时。' >&2
  exit 1
fi
if [[ $# -ne 1 || ! "$1" =~ ^[A-Za-z0-9_-]{1,200}$ ]]; then
  echo '用法：bash blender/scripts/start-cloud-preview.sh 实际沙箱实例名' >&2
  exit 1
fi
for preview_port in 3906 5195; do
  if lsof -nP -iTCP:"$preview_port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "端口 $preview_port 已被占用，请先关闭之前的验收预览。" >&2
    exit 1
  fi
done
read -r -s -p '输入已有的云端桌面密码 VNC_PW（隐藏输入）：' preview_desktop_pass
echo
read -r -s -p '输入刚保存的 BLENDER_CONTROL_TOKEN（隐藏输入）：' preview_control_token
echo
if [[ ! "$preview_control_token" =~ ^[A-Za-z0-9_-]{32,128}$ ||
      ! "$preview_desktop_pass" =~ ^[A-Za-z0-9_-]{16,128}$ ||
      "$preview_control_token" == "$preview_desktop_pass" ]]; then
  echo '密钥格式无效，或命令密钥与桌面密码相同；未启动服务。' >&2
  exit 1
fi
export BLENDER_ENABLED=1
export BLENDER_LIVE_TARGET='https://saobidloj9b5hmpajmjko.apigateway-cn-beijing.volceapi.com/'
export BLENDER_LIVE_INSTANCE_NAME="$1"
export BLENDER_LIVE_USER=kasm_user
export BLENDER_LIVE_PASS="$preview_desktop_pass"
export BLENDER_CONTROL_TOKEN="$preview_control_token"
export BLENDER_CLOUD_PROJECT=cloud-public-check
export CHATSPACE_LIBRARY_DIR="$repo_dir/output/blender-cloud-public-check"
export CHAT_HOST=127.0.0.1
export CHAT_PORT=3906
export VITE_CHAT_URL='http://127.0.0.1:3906'
unset preview_desktop_pass preview_control_token
cd "$repo_dir"
# Uses the real cloud client and existing asset publishing path. No modeling replay.
"$preview_bun" run blender/scripts/cloud-preview-check.ts
preview_chat_pid=''
preview_vite_pid=''
cleanup_preview() {
  [[ -z "$preview_chat_pid" ]] || kill "$preview_chat_pid" 2>/dev/null || true
  [[ -z "$preview_vite_pid" ]] || kill "$preview_vite_pid" 2>/dev/null || true
}
trap cleanup_preview EXIT
trap 'exit 130' INT TERM
"$preview_bun" run chat/src/index.ts &
preview_chat_pid=$!
(
  unset BLENDER_CONTROL_TOKEN
  cd "$repo_dir/app"
  # Bun 1.3.14 receives Node upgrade events but does not flush raw socket.write()
  # responses. Keep Vite on Node so this desktop proxy forwards the handshake.
  exec "$preview_node" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5195 --strictPort
) &
preview_vite_pid=$!
echo '验收预览：http://127.0.0.1:5195/app/cloud-public-check'
echo '请保留此终端；Ctrl+C 关闭本次本地预览。云端实例仍按平台生命周期到期。'
wait "$preview_chat_pid" "$preview_vite_pid"
