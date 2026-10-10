#!/usr/bin/env bash
set -euo pipefail
# Validate before Kasm can start with a default password. Never print the secret.
/opt/cloud-gateway/bin/python -c 'from cloud_gateway import Settings; from pathlib import Path; import os; Settings(os.environ.get("VNC_PW", ""), Path("unused"), control_token=os.environ.get("BLENDER_CONTROL_TOKEN", ""))'

desktop_pid=""
gateway_pid=""
cleanup() {
  trap - EXIT INT TERM
  [[ -z "$gateway_pid" ]] || kill "$gateway_pid" 2>/dev/null || true
  [[ -z "$desktop_pid" ]] || kill "$desktop_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM
/dockerstartup/kasm_default_profile.sh /dockerstartup/vnc_startup.sh /dockerstartup/kasm_startup.sh --wait &
desktop_pid=$!
/opt/cloud-gateway/bin/python /opt/cloud-gateway/cloud_gateway.py &
gateway_pid=$!
# If either process exits, stop the whole instance rather than leaving a broken desktop.
set +e
wait -n "$desktop_pid" "$gateway_pid"
status=$?
exit "$status"
