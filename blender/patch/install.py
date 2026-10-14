#!/usr/bin/env python3
"""
ChatSpace Blender 补丁 —— 可移植安装器
=====================================

把一套**可复现**的 Blender 环境装好：MCP 插件 + 你指定的社区插件 + 自检。

## 这一份同时支持 Linux 与 macOS

同一份脚本在两种平台上跑；**Docker 只是它的另一种运行方式**（容器里也是跑这个脚本）。
所以"Mac 上验证过"和"容器里验过"是同一套逻辑，不是两套。

## 步骤顺序不能换（第 2 步尤其）

  1. 定位 Blender 可执行文件
  2. 问 Blender 它真实的配置目录，**并自己把插件目录建出来**
  3. 装 Blender MCP 插件（复用社区版自带的跨平台安装器）
  4. 按 `plugins.txt` 装其余插件
  5. 启用全部并写进 preferences
  6. 自检

**第 2 步为什么要"自己建目录"**（这是容器里实测出来的，我原先的假设是错的）：

`bpy.utils.user_resource('CONFIG')` **只计算路径，不创建目录** —— 后台模式跑一次 Blender
并不会把配置目录建出来（只有保存偏好时才写盘）。而社区版安装器靠 `base.is_dir()` 去发现
插件目录，于是报：

    Could not find a Blender user addons directory. Set BLENDERMCP_ADDONS_DIR ...

它的措辞会让人以为是路径探测出了问题，实际是**目录根本不存在**。
所以这里显式 `mkdir -p`，并把路径通过 `BLENDERMCP_ADDONS_DIR` 交给安装器 ——
不依赖任何副作用。

## 为什么要硬失败

任何一项装不上（尤其是"装了但 enable 不了"），**整个安装以非零码退出**。
理由是本仓库反复踩出来的：**"脚本没报错"不等于"东西装好了"**。
一个静默没启用的插件会让 agent 在几天后收到一句含混的 `context is incorrect`，
而那时候已经没人记得安装时发生了什么。宁可构建/安装当场红。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "plugins.txt"
SELFCHECK = HERE / "selfcheck.py"
MARKER = "CS_PATCH"

# 关掉社区版遥测。三个别名全设——它认这三个。
# 注意这只是"意图"；真正的兜底是网络策略（见 ../README.md 的遥测审计）。
TELEMETRY_OFF = {
    "DISABLE_TELEMETRY": "1",
    "BLENDER_MCP_DISABLE_TELEMETRY": "1",
    "MCP_DISABLE_TELEMETRY": "1",
}


def log(step: str, message: str) -> None:
    print(f"[{step}] {message}", flush=True)


def fail(step: str, message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"[{step}] failed: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------------
# 1. 定位 Blender
# ---------------------------------------------------------------------------

#: 各平台常见位置。**顺序有意义**：显式环境变量 > 平台标准位置 > PATH。
LINUX_CANDIDATES = ("/opt/blender/blender", "/usr/local/bin/blender", "/usr/bin/blender")
MACOS_CANDIDATES = (
    "/Applications/Blender.app/Contents/MacOS/Blender",
    str(Path.home() / "Applications/Blender.app/Contents/MacOS/Blender"),
)


def find_blender(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            fail("blender", f"the file BLENDER_BIN points to does not exist: {path}")
        return path

    if env := os.environ.get("BLENDER_BIN"):
        return find_blender(env)

    candidates = MACOS_CANDIDATES if sys.platform == "darwin" else LINUX_CANDIDATES
    for candidate in candidates:
        if Path(candidate).is_file():
            return Path(candidate)

    if on_path := shutil.which("blender"):
        return Path(on_path)

    fail(
        "blender",
        "Blender not found. Set BLENDER_BIN to point at the executable.\n"
        f"  Common macOS location: {MACOS_CANDIDATES[0]}\n"
        f"  Common Linux location: {LINUX_CANDIDATES[0]}",
    )


def blender_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(TELEMETRY_OFF)
    # 无头运行：不加载用户 startup 文件，减少不确定性（但**不**用 --factory-startup，
    # 那会连带禁用所有插件，与"装插件"这件事直接冲突）。
    return env


def run_blender(blender: Path, expr: str, timeout: int = 180) -> tuple[int, str]:
    """跑一段 bpy 表达式，返回 (退出码, 合并输出)。"""
    proc = subprocess.run(
        [str(blender), "--background", "--python-expr", expr],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=blender_env(),
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def probe(blender: Path) -> dict:
    """让 Blender 自己回答：版本、配置目录、**以及它到底从哪里加载插件**。

    **不要自己拼路径。** 最后一组（`scriptPaths` / `addonsPaths` / `extensionsDir`）是
    容器里踩出来的：Blender 4.2+ 引入了 extensions 机制，而 `scripts/addons` 在不同版本里
    的地位不一样。把文件放进一个 Blender 根本不扫的目录，后果是
    `addon_utils.enable()` **静默返回、不报错、也不启用** —— 这类故障没有诊断信息时
    极难定位，所以直接把 Blender 自己认的路径打出来。
    """
    expr = (
        "import bpy, json;"
        "d = {"
        "'version': bpy.app.version_string,"
        "'config': bpy.utils.user_resource('CONFIG'),"
        "'scripts': bpy.utils.user_resource('SCRIPTS'),"
        "'scriptPaths': bpy.utils.script_paths(),"
        "'addonsPaths': bpy.utils.script_paths(subdir='addons'),"
        "};"
        "d['extensionsDir'] = bpy.utils.user_resource('EXTENSIONS') if 'EXTENSIONS' else None;"
        f"print('{MARKER} ' + json.dumps(d))"
    )
    code, output = run_blender(blender, expr)
    if code != 0:
        fail("blender", f"Blender failed to start (exit code {code}):\n{output[-1500:]}")
    for line in output.splitlines():
        if line.startswith(f"{MARKER} "):
            return json.loads(line[len(MARKER) + 1 :])
    fail("blender", f"could not get configuration information from Blender. Raw output:\n{output[-1500:]}")


# ---------------------------------------------------------------------------
# 3. Blender MCP 插件
# ---------------------------------------------------------------------------


def install_mcp_addon(addons_dir: Path) -> None:
    """复用社区版自带的安装器。

    **不要自己拼插件路径。** 社区版 `addon_manager.py` 已经处理了三件事：
      · 平台差异（darwin / linux / win32）
      · Blender 4.2+ 的 `extensions/user_default` 与旧版 `scripts/addons` 两种机制
      · 版本检查与更新（`read_addon_protocol_version`）
    自己重写一遍只会在这三件事上各踩一次。

    **但目标目录必须显式给它。** 它的自动发现依赖 `~/.config/blender/<ver>/` 已经存在，
    而后台模式跑 Blender 并不会创建那个目录（见模块文档第 2 步）。容器里实测的报错是
    `Could not find a Blender user addons directory` —— 在这里用 `BLENDERMCP_ADDONS_DIR`
    把已经建好的路径交给它，把那个不确定性彻底去掉。
    """
    command = os.environ.get("BLENDER_MCP_BIN", "uvx").split()
    command += os.environ.get("BLENDER_MCP_ARGS", "mcp-for-blender").split()
    command.append("install-addon")
    log("mcp-addon", f"{' '.join(command)}  →  {addons_dir}")

    env = blender_env()
    env["BLENDERMCP_ADDONS_DIR"] = str(addons_dir)
    proc = subprocess.run(command, capture_output=True, text=True, timeout=300, env=env)
    output = (proc.stdout or "") + (proc.stderr or "")
    print(output.strip()[-1200:])
    if proc.returncode != 0:
        fail(
            "mcp-addon",
            f"installer exited with code {proc.returncode}. If it says the executable was not "
            f"found, note that **the package name and the executable share the same name, "
            f"`mcp-for-blender`** (it was called `blender-mcp` before the rename; the old name "
            f"reports `An executable named 'blender-mcp' is not provided`).",
        )


def ensure_addon_dir(info: dict) -> Path:
    """把 Blender 的用户插件目录**建出来**，返回 `scripts/addons` 的路径。

    见模块文档第 2 步：Blender 只计算路径、不创建目录。

    **只建 `scripts/addons`，不建 `extensions/user_default`** —— 两个都建的话社区版安装器
    会把两者都放进候选表，装到哪个就变得不确定。一个明确的落点比两个模糊的落点好。
    """
    # CONFIG 形如 `<base>/<version>/config`，版本目录是它的父级。
    version_dir = Path(info["config"]).parent
    addons = version_dir / "scripts" / "addons"
    addons.mkdir(parents=True, exist_ok=True)
    return addons


def report_addon_paths(blender: Path) -> dict:
    """在**目录建好之后**再问一次 Blender 认哪些插件路径。

    为什么必须问第二次：`bpy.utils.script_paths()` 默认会做存在性检查 —— 目录还没建时
    它返回空列表，那会被误读成"Blender 不再支持 scripts/addons"。第一版就是这么误判的。
    建完之后再问，得到的才是真话。
    """
    expr = (
        "import bpy, json;"
        "print('" + MARKER + " ' + json.dumps({"
        "'scriptPaths': bpy.utils.script_paths(),"
        "'addonsPaths': bpy.utils.script_paths(subdir='addons'),"
        "'preferencesScripts': [p.directory for p in bpy.context.preferences.filepaths.script_directories]"
        "}))"
    )
    code, output = run_blender(blender, expr)
    if code != 0:
        return {"error": output[-400:]}
    for line in output.splitlines():
        if line.startswith(f"{MARKER} "):
            return json.loads(line[len(MARKER) + 1 :])
    return {"error": "no marker"}


# ---------------------------------------------------------------------------
# 4. 其余插件（清单）
# ---------------------------------------------------------------------------


def parse_manifest(path: Path) -> list[tuple[str, list[str]]]:
    if not path.is_file():
        return []
    entries: list[tuple[str, list[str]]] = []
    for number, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        kind, args = parts[0], parts[1:]
        if kind not in {"extension", "addon", "path"}:
            fail("manifest", f"{path.name}:{number} unknown directive `{kind}` (only extension/addon/path)")
        entries.append((kind, args))
    return entries


def install_manifest_entry(blender: Path, kind: str, args: list[str]) -> str:
    if kind == "extension":
        if len(args) != 2:
            fail("manifest", "extension needs two arguments: <repo> <id>")
        repo, extension_id = args
        proc = subprocess.run(
            [str(blender), "--command", "extension", "install", repo, extension_id],
            capture_output=True,
            text=True,
            timeout=600,
            env=blender_env(),
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            fail("extension", f"failed to install {repo}/{extension_id}:\n{output[-800:]}")
        return extension_id

    if kind == "path":
        if len(args) != 1:
            fail("manifest", "path needs one argument: <directory or file>")
        source = Path(args[0])
        if not source.is_absolute():
            source = (MANIFEST.parent / source).resolve()
        if not source.exists():
            fail("path", f"does not exist: {source}")
        # 放到用户插件目录；目录名即模块名。
        target_root = Path(os.environ["_CS_SCRIPTS_DIR"]) / "addons"
        target_root.mkdir(parents=True, exist_ok=True)
        target = target_root / source.name
        if target.exists():
            shutil.rmtree(target) if target.is_dir() else target.unlink()
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            target.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target / source.name)
        return source.stem if source.is_file() else source.name

    # addon：断言它已经在插件目录里，不下载
    module = args[0] if args else ""
    if not module:
        fail("manifest", "addon needs one argument: <module>")
    return module


# ---------------------------------------------------------------------------
# 5. 启用 + 自检
# ---------------------------------------------------------------------------


#: 在 Blender 里执行的启用脚本。
#:
#: **用模板而不是字符串拼接**：这个脚本本身是嵌在 Python 里的 Python，一旦用 f-string
#: 拼接就很容易出现引号嵌套（`subdir='addons'` 套在单引号字符串里 → 语法错误），
#: 而那种错误的表现是"启用脚本没有回报结果"，看不出真正原因。上一版正是这么挂的。
_ENABLE_TEMPLATE = """
import bpy, json, addon_utils
modules = __MODULES__
# `addon_utils.modules()` 是 Blender **实际扫到**的插件全集。有它才能把
# "enable 静默失败"分成两种情况：
#   · 模块不在 discovered 里 → 文件放错地方了（Blender 根本没看见）
#   · 在 discovered 里却没进 enabled → 插件自己的 register() 失败了
discovered = sorted(m.__name__ for m in addon_utils.modules())
errors = {}
for name in modules:
    # ⚠️ `addon_utils.enable()` **吞掉 register() 抛出的异常**：它调 handle_error 回调
    # （默认只往 stdout 打一行 traceback），然后**正常返回**。所以 try/except 抓不到任何东西。
    # 把 handle_error 接过来，异常才落到我们能报出来的地方。
    def _record_error(*args, _name=name, **kwargs):
        errors[_name] = " ".join(repr(a) for a in args) or repr(kwargs)
    try:
        # ⚠️ **`default_set=True` 不能省。** 容器里实测：用 False 时插件确实
        # `register()` 了（日志里能看到 "BlenderMCP addon registered"），但**不进
        # `preferences.addons`** —— 于是它只活在当前这个会话里，Blender 一重启就没了，
        # 而安装时看起来"成功、无异常"。这正是"装了但看不见"那一类静默失败。
        addon_utils.enable(name, default_set=True, persistent=True, handle_error=_record_error)
    except Exception as exc:
        errors[name] = repr(exc)

# 落盘 preferences：上面的 default_set 只是把模块写进内存里的 preferences 对象，
# 后台模式退出时不一定保存。不存的话下一次启动又回到未启用。
try:
    bpy.ops.wm.save_userpref()
    saved = True
except Exception as exc:
    saved = repr(exc)

enabled = sorted(bpy.context.preferences.addons.keys())
# `addon_utils.check()` 返回 (是否启用, 是否已加载) —— 它衡量的是**运行时的真实状态**，
# 而 preferences 只说明"记下来了"。两个都报，才能区分"没记下来"和"记了但没加载"。
loaded = {}
for name in modules:
    try:
        loaded[name] = list(addon_utils.check(name))
    except Exception as exc:
        loaded[name] = repr(exc)

missing = [m for m in modules if m not in enabled]
print("__MARKER__ " + json.dumps({
    "enabled": enabled,
    "missing": missing,
    "loaded": loaded,
    "savedPreferences": saved,
    "errors": errors,
    "discovered": discovered,
    "addonDirs": bpy.utils.script_paths(subdir="addons"),
}))
"""


def enable_and_verify(blender: Path, modules: list[str]) -> dict:
    """启用插件并**当场验证**它们真的启用了。

    验证方式：enable 之后读回 `bpy.context.preferences.addons`，逐个断言在里面。
    只听 `addon_utils.enable()` 没抛异常是不算的——**那个函数在模块找不到时会静默返回**，
    既不报错也不启用（容器里实测踩到过）。
    """
    expr_path = HERE / "_enable.py"
    expr_path.write_text(
        _ENABLE_TEMPLATE.replace("__MODULES__", json.dumps(modules)).replace(
            "__MARKER__", MARKER
        )
    )
    try:
        code, output = run_blender(blender, f"exec(open({str(expr_path)!r}).read())")
    finally:
        expr_path.unlink(missing_ok=True)

    # **永远把 Blender 的输出打出来。** 第一版没打，于是"register() 失败"只剩下我自己的
    # 一句推断，而 Blender 那边真正的 traceback 被丢掉了 —— 排查凭空多了好几轮。
    # 这类脚本的诊断信息比它自己的日志值钱得多。
    print("--- Blender output (enable step) ---")
    print(output.strip()[-3000:])

    if code != 0:
        fail("enable", f"Blender exited with code {code} while enabling the add-ons:\n{output[-1500:]}")
    for line in output.splitlines():
        if line.startswith(f"{MARKER} "):
            return json.loads(line[len(MARKER) + 1 :])
    fail("enable", f"the enable script reported no result. Raw output:\n{output[-1500:]}")


def write_manifest(blender: Path, info: dict, enabled: list[str], modules: list[str]) -> Path:
    """把"这一版到底装了什么"落成一个文件。

    ## 为什么值得单独存一份

    1. **产物溯源**：`blender-export` 会把 Blender 版本写进请求侧写，但**插件集**没有
       别的地方记。同一个 `.blend` 在两台插件不同的机器上跑，结果可能不一样；没有这份
       记录，那种差异永远查不出来。
    2. **补丁是可重跑的**，所以需要一个东西回答"上次打完之后状态是什么"。
    3. 出问题时它是最短的自证材料：`cat` 一下就知道装没装、启没启用。

    注意它**不是** agent 拿插件清单的路径 —— 那条走 `blender-plugins` 工具（经
    `execute_blender_code`，**不依赖文件系统共享**，容器里照样用）。这个文件是给人和 CI 看的。
    """
    manifest = {
        "schemaVersion": 1,
        "installedAt": __import__("datetime").datetime.now().astimezone().isoformat(),
        "platform": f"{platform.system()} {platform.machine()}",
        "blender": info["version"],
        "blenderConfig": info["config"],
        "requestedModules": modules,
        "enabledModules": enabled,
        "patchDir": str(HERE),
    }
    path = Path(info["config"]) / "chatspace-patch.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return path


def run_selfcheck(blender: Path) -> None:
    if not SELFCHECK.is_file():
        log("selfcheck", "skipped (no selfcheck.py)")
        return
    code, output = run_blender(blender, f"exec(open({str(SELFCHECK)!r}).read())")
    print(output.strip()[-2500:])
    if code != 0:
        fail("selfcheck", f"self-check exited with code {code}")
    if f"{MARKER}_SELFCHECK_OK" not in output:
        fail("selfcheck", "the self-check printed no pass marker — it failed silently partway through")


# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="ChatSpace Blender patch installer")
    parser.add_argument("--blender", help="path to the Blender executable (BLENDER_BIN also works)")
    parser.add_argument("--skip-manifest", action="store_true", help="install only the MCP add-on, skip plugins.txt")
    parser.add_argument("--skip-selfcheck", action="store_true")
    args = parser.parse_args()

    log("platform", f"{platform.system()} {platform.machine()} · Python {platform.python_version()}")

    blender = find_blender(args.blender)
    log("blender", str(blender))

    # 第 2 步：问配置目录（并**自己建**插件目录）。顺序不能换。
    info = probe(blender)
    log("blender", f"version {info['version']} · config dir {info['config']}")
    for label, value in (
        ("scripts", info.get("scripts")),
        ("addonsPaths", info.get("addonsPaths")),
        ("extensionsDir", info.get("extensionsDir")),
    ):
        log("paths", f"{label} = {value}")
    os.environ["_CS_SCRIPTS_DIR"] = info["scripts"]
    addons_dir = ensure_addon_dir(info)
    log("addons-dir", str(addons_dir))
    # 目录建好之后再问一次 —— 这时 script_paths 才不会再因为"目录不存在"而返回空。
    log("paths-after", json.dumps(report_addon_paths(blender), ensure_ascii=False))

    install_mcp_addon(addons_dir)

    modules = ["blender_mcp"]
    if not args.skip_manifest:
        entries = parse_manifest(MANIFEST)
        log("plugins", f"{len(entries)} entries in the manifest")
        for kind, entry_args in entries:
            module = install_manifest_entry(blender, kind, entry_args)
            modules.append(module)
            log(kind, f"{' '.join(entry_args)} → {module}")

    # MCP 插件的模块名随版本变过，用真实存在的那个；找不到时留空让 selfcheck 去报。
    result = enable_and_verify(blender, modules)
    log("enable", f"enabled {len(result['enabled'])} add-ons")
    log("discovered", f"Blender discovered {len(result.get('discovered', []))} modules")
    if result["errors"]:
        fail("enable", f"enable errors: {json.dumps(result['errors'], ensure_ascii=False)}")
    missing = [m for m in modules if m in result["missing"] and m != "blender_mcp"]
    if missing:
        fail("enable", f"these add-ons were installed but **could not be enabled**: {missing} (the real cause is most likely in the Blender output above)")
    # MCP 插件单独判：它静默失败时最需要诊断信息，所以把"扫到没有"和"扫到但没启用"分开报。
    if "blender_mcp" in result["missing"]:
        discovered = result.get("discovered", [])
        where = result.get("addonDirs", [])
        if "blender_mcp" in discovered:
            fail(
                "enable",
                "`blender_mcp` is among the modules Blender discovered, but enabling it did not "
                "take effect — its own `register()` failed. Look at the Blender output above to "
                "find the cause.",
            )
        fail(
            "enable",
            f"`blender_mcp` is **not** among the {len(discovered)} modules Blender discovered — "
            f"the file was placed in the wrong location, so Blender never saw it.\n"
            f"  File location: {addons_dir}/blender_mcp.py\n"
            f"  Add-on directories Blender recognizes: {where}\n"
            f"  Modules discovered: {discovered}",
        )

    manifest = write_manifest(blender, info, result["enabled"], modules)
    log("manifest", str(manifest))

    if not args.skip_selfcheck:
        run_selfcheck(blender)

    log("done", "patch installation complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
