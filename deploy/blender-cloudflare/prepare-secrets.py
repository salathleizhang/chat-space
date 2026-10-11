#!/usr/bin/env python3
"""Collect service credentials locally, without echoing or deploying them."""
import getpass
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import warnings


REPOSITORY = Path(__file__).resolve().parents[2]
SECRET_DIRECTORY = Path.home() / ".config" / "chatspace"
SECRET_FILE = SECRET_DIRECTORY / "blender-cloudflare-secrets.json"


def check_private_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("凭据文件必须是当前用户拥有的普通文件。")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("凭据文件权限过宽；请先设为 0600。")


def model_key():
    existing = os.environ.get("VOLC_KEY", "").strip()
    if existing:
        return existing
    node = shutil.which("node")
    environment_file = REPOSITORY / "chat" / ".env"
    if node and environment_file.is_file():
        # Capture the value inside this process; never send it to the terminal.
        source = (
            "const fs=require('node:fs');const util=require('node:util');"
            "const env=util.parseEnv(fs.readFileSync(process.argv[1],'utf8'));"
            "process.stdout.write(env.VOLC_KEY||'');"
        )
        result = subprocess.run(
            [node, "-e", source, str(environment_file)],
            capture_output=True, timeout=10, check=False,
        )
        if result.returncode == 0:
            return result.stdout.decode("utf-8").strip()
    return ""


def hidden_value(prompt):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        value = getpass.getpass(prompt).strip()
    if len(value) < 16 or any(character.isspace() for character in value):
        raise ValueError("输入为空、过短或含空白；尚未保存，请重新运行并完整粘贴。")
    return value


def save_private(path, values):
    directory = path.parent
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("凭据目录必须是当前用户拥有的真实目录。")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("凭据目录权限过宽；请先设为 0700。")
    if path.exists() or path.is_symlink():
        check_private_file(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".blender-secrets-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(values, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError("请在你自己的交互式终端运行；不接受管道或聊天输入。")
    previous = {}
    if SECRET_FILE.exists() or SECRET_FILE.is_symlink():
        check_private_file(SECRET_FILE)
        previous = json.loads(SECRET_FILE.read_text(encoding="utf-8"))
        if not isinstance(previous, dict):
            raise ValueError("现有凭据文件格式不正确；尚未修改。")
    service_secret = previous.get("BLENDER_SERVICE_SECRET")
    if service_secret is not None and (
        not isinstance(service_secret, str) or len(service_secret) < 32
    ):
        raise ValueError("现有内部密钥无效；为避免破坏恢复记录，未自动替换。")
    print("请录入 chatspace-blender-cloudflare 用户的 Access Key。")
    print("粘贴时屏幕不会显示字符；本脚本只保存到本机，不上传。")
    access_key = hidden_value("Access Key ID（AK）：")
    secret_key = hidden_value("Secret Access Key（SK）：")
    if hidden_value("再次粘贴 SK 确认：") != secret_key:
        raise ValueError("两次 SK 不一致；尚未保存。")
    volc_key = previous.get("VOLC_KEY") or model_key()
    if not volc_key:
        volc_key = hidden_value("方舟模型调用密钥 VOLC_KEY：")
    values = {
        "BLENDER_SERVICE_SECRET": service_secret or secrets.token_urlsafe(48),
        "VOLC_ACCESSKEY": access_key,
        "VOLC_SECRETKEY": secret_key,
        # This identity has both sandbox and scoped TOS permissions.
        "TOS_ACCESS_KEY": access_key,
        "TOS_SECRET_KEY": secret_key,
        "VOLC_KEY": volc_key,
    }
    save_private(SECRET_FILE, values)
    print("已安全保存 6 项部署配置，文件权限为 0600；没有上传任何凭据。")
    print("位置：" + str(SECRET_FILE))
    print("请关闭浏览器中的密钥详情，然后在聊天回复：已录入。")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\n已取消，未保存新的凭据。", file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print("未保存：" + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Exceptions can contain input or local environment data; do not print them.
        print("未完成凭据保存；请检查终端、Node 和本机目录权限。", file=sys.stderr)
        sys.exit(1)
