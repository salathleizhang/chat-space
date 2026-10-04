#!/usr/bin/env python3
"""
ChatSpace Blender 补丁 —— 自检
==============================

在 Blender **里面**跑，回答一个问题：**这个 Blender 现在能不能被 ChatSpace 驱动？**

## 为什么要有它（而不是"装完看一眼没报错就行"）

这一整条链路上最贵的故障是**静默的**：

  · 插件文件在、但没启用 → `bpy.ops.<命名空间>.<op>` 不存在，报错含混
  · 插件启用了、但它的 operator 需要 UI context → 在无头环境里必失败
  · Blender 版本与插件预期不符 → 行为变了但不报错

所以这里逐项**读引擎状态**并打印，最后打一个通过标记。
`install.py` 拿这个标记判断成败 —— 没有标记就算失败，而不是"退出码是 0 就算过"。
"""

from __future__ import annotations

import json
import sys

import bpy

MARKER = "CS_PATCH"

#: 必须存在的 operator。少一个就说明某个环节没生效。
#:
#: 注意这里**只放我们真的会用到的**：
#:   · `export_scene.gltf` —— `blender-export` 的落地手段，缺了整个"拿到模型"就断了
#:   · `wm.save_as_mainfile` —— 保存 .blend（可复现的源头）
#:   · `import_scene.gltf` —— 把已有资产带进来改
REQUIRED_OPERATORS = (
    "export_scene.gltf",
    "import_scene.gltf",
    "wm.save_as_mainfile",
)


def check_operator(path: str) -> dict:
    """用 RNA 反射确认 operator 真的注册了。

    **不要用 `hasattr(bpy.ops.x, 'y')`** —— operator 的访问器是动态的，那个判断会骗人。
    走 `get_rna_type()`：它要么给出真实签名，要么抛异常。
    """
    parts = path.split(".")
    if len(parts) != 2:
        return {"operator": path, "ok": False, "error": "路径必须是 <category>.<name>"}
    group = getattr(bpy.ops, parts[0], None)
    op = getattr(group, parts[1], None) if group is not None else None
    if op is None:
        return {"operator": path, "ok": False, "error": "operator 不存在"}
    try:
        rna = op.get_rna_type()
    except Exception as exc:  # noqa: BLE001
        return {"operator": path, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return {
        "operator": path,
        "ok": True,
        "label": rna.name,
        "parameters": len(rna.properties) - 1,
    }


def find_mcp_addon() -> dict:
    """找社区版 MCP 插件，并把**全部已启用插件**列出来。

    模块名在版本间变过（`blender_mcp` / `blendermcp` / …），所以按关键词扫，
    而不是断言某一个名字。

    ## 为什么要把整份清单打出来

    补丁的卖点是"打完就变成一个**有各种各样插件**的 Blender"，但**装了插件不等于
    agent 会用插件**：`bpy_api_lookup` 是**按名字查**的，模型不知道插件叫什么就不会
    去查它。所以清单必须能被取出来交到 agent 眼前（产品路径是 `blender-plugins` 工具，
    它走 `execute_blender_code`，**不依赖文件系统共享**，容器里照样用）。

    这里打出来是给人和 CI 看的：`docker build` 的日志里就能看到这一版到底装了什么。
    """
    enabled = sorted(bpy.context.preferences.addons.keys())
    matches = [name for name in enabled if "mcp" in name.lower()]
    return {
        "enabledCount": len(enabled),
        "mcpModules": matches,
        # 全量清单：补丁装了什么，这里就有什么。别只报数量 —— 数量对不上时排查不了。
        "enabled": enabled,
    }


def main() -> int:
    report: dict = {
        "blender": bpy.app.version_string,
        "python": sys.version.split()[0],
        "background": bpy.app.background,
        "operators": [check_operator(path) for path in REQUIRED_OPERATORS],
        "addons": find_mcp_addon(),
        "exportFormats": sorted(
            item.identifier
            for item in bpy.ops.export_scene.gltf.get_rna_type().properties
            if item.identifier == "export_format"
        ),
    }

    failed = [item for item in report["operators"] if not item["ok"]]
    report["ok"] = not failed and bool(report["addons"]["mcpModules"])

    print(f"{MARKER} " + json.dumps(report, ensure_ascii=False, indent=2))

    if failed:
        print(f"{MARKER}_FAIL 缺少必需的 operator：{[i['operator'] for i in failed]}", file=sys.stderr)
        return 1
    if not report["addons"]["mcpModules"]:
        print(
            f"{MARKER}_FAIL 没有任何 MCP 插件被启用（已启用 {report['addons']['enabledCount']} 个）",
            file=sys.stderr,
        )
        return 1

    print(f"{MARKER}_SELFCHECK_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
