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
        raise ValueError("The credentials file must be a regular file owned by the current user.")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("The credentials file permissions are too broad; set them to 0600 first.")


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
        raise ValueError("The input is empty, too short, or contains whitespace; nothing was saved. Run it again and paste the full value.")
    return value


def save_private(path, values):
    directory = path.parent
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("The credentials directory must be a real directory owned by the current user.")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("The credentials directory permissions are too broad; set them to 0700 first.")
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
        raise ValueError("Run this in your own interactive terminal; piped or chat input is not accepted.")
    previous = {}
    if SECRET_FILE.exists() or SECRET_FILE.is_symlink():
        check_private_file(SECRET_FILE)
        previous = json.loads(SECRET_FILE.read_text(encoding="utf-8"))
        if not isinstance(previous, dict):
            raise ValueError("The existing credentials file has an invalid format; nothing was modified.")
    service_secret = previous.get("BLENDER_SERVICE_SECRET")
    if service_secret is not None and (
        not isinstance(service_secret, str) or len(service_secret) < 32
    ):
        raise ValueError("The existing internal secret is invalid; it was not replaced automatically, so that recovery records are not broken.")
    print("Enter the Access Key of the chatspace-blender-cloudflare user.")
    print("Pasting does not show characters on screen; this script only saves locally and does not upload.")
    access_key = hidden_value("Access Key ID (AK): ")
    secret_key = hidden_value("Secret Access Key (SK): ")
    if hidden_value("Paste the SK again to confirm: ") != secret_key:
        raise ValueError("The two SK values do not match; nothing was saved.")
    volc_key = previous.get("VOLC_KEY") or model_key()
    if not volc_key:
        volc_key = hidden_value("Ark model invocation key VOLC_KEY: ")
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
    print("Saved 6 deployment settings securely with file permissions 0600; no credentials were uploaded.")
    print("Location: " + str(SECRET_FILE))
    print("Close the key details in the browser, then reply in the chat: credentials entered.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled; no new credentials were saved.", file=sys.stderr)
        sys.exit(1)
    except ValueError as error:
        print("Not saved: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Exceptions can contain input or local environment data; do not print them.
        print("Credential saving did not complete; check the terminal, Node, and local directory permissions.", file=sys.stderr)
        sys.exit(1)
