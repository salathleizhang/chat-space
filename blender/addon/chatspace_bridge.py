# -*- coding: utf-8 -*-
"""
ChatSpace Blender Bridge
========================

把 Blender 变成一个「**能被 agent 小步驱动、并且人能看到每一步**」的执行器。

## 设计要点（每条都有具体理由，改动前先读）

**1. 所有 op 都在主线程执行，走 `bpy.app.timers` 泵。**

socket 线程只负责收包/解包，真正的 bpy 调用丢进队列、由主线程的定时器取出执行。
两个理由缺一不可：

- `bpy.ops` 依赖正确的 context，在随机线程里调用会随机失败（而且失败得很安静）；
- **主线程执行完会自然重绘**（下面还会显式 `tag_redraw`），视口才会在每一步之后跳一下。
  这正是「A 路线：人要能实时看到」的实现基础。

反过来也成立：**一段脚本跑得越久，画面冻得越久**。所以工具层的纪律是**小步、多步**，
不要一次提交一个长脚本——那样人在屏幕前只会看到画面卡住，然后啪一下出现成品。
（实测记录：blender-mcp 的 `execute_code` 直接在线程里跑，一段长脚本执行期间 UI 完全冻结。）

**2. 协议是类型化的 op，不是任意 Python。**

产品路径上**不提供** `execute_code`。理由：LLM 写 bpy 的失败是静默的
（脚本"成功"退出但场景是空的、或者几何退化成 NaN 一团），而目录化的 op 失败模式可枚举、
可单测、可在主线程安全执行。逃生舱 `run_python` 默认关闭，要用必须显式打开 preference。

**3. 每个 op 都返回引擎事实**（对象数 / 面数 / 包围盒 / 是否退化）。

判据必须读引擎状态，不能读调用方的自述——这是本仓库在渲染层反复踩出来的纪律，
在 Blender 这一侧同样成立：**"脚本没报错"不等于"模型建出来了"**。

**4. 绑定地址默认 127.0.0.1，token 从第一天就有。**

本地开发不需要 token；但一旦进容器对外暴露（A 路线的远端形态），这就是唯一的门。
现在不做，将来就要在一堆已经写好的调用点上补。

**5. 视图自动跟随（`auto_frame`）。**

建模 op 默认在提交后把视口对准场景包围盒。人盯着屏幕时，这是"看得见"和"看不见"的区别——
尤其是物体建在原点之外、或者尺寸比当前视野大一个数量级的时候。
"""

bl_info = {
    "name": "ChatSpace Bridge",
    "author": "ChatSpace",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar(N) > ChatSpace",
    "description": "Let the ChatSpace agent drive Blender in small steps and watch every step live in the viewport",
    "category": "Interface",
}

import base64
import json
import math
import os
import queue
import socket
import socketserver
import threading
import time
import traceback
from collections import deque

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector

PROTOCOL_VERSION = 1
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9876
ADDON_ID = __name__

# 主线程任务的默认超时：单步建模通常 < 1s，给到 120s 足够布尔/细分级别的重活。
# 超时不是"放弃执行"，只是让 socket 侧先如实回一个错误——主线程仍会把它跑完。
DEFAULT_OP_TIMEOUT_S = 120.0


# ---------------------------------------------------------------------------
# 错误与 op 注册表
# ---------------------------------------------------------------------------


class OpError(Exception):
    """可预期的用户错误（参数不对、找不到对象）。会原样回给调用方，不当作 traceback。"""


_OPS = {}


def op(name, mutates=True, summary=""):
    """注册一个类型化 op。

    `mutates=True` 表示它会改动场景 —— 这类 op 默认在成功后自动对准视口，
    这样人盯着屏幕就能看到"刚才那一步干了什么"。
    """

    def deco(fn):
        fn._cs_op = {"name": name, "mutates": mutates, "summary": summary}
        _OPS[name] = fn
        return fn

    return deco


def op_catalog():
    return [
        {
            "name": meta["name"],
            "mutates": meta["mutates"],
            "summary": meta["summary"],
        }
        for meta in sorted(
            (fn._cs_op for fn in _OPS.values()), key=lambda m: m["name"]
        )
    ]


# ---------------------------------------------------------------------------
# 运行时状态
# ---------------------------------------------------------------------------

_LOG = deque(maxlen=40)
_STATE = {
    "server": None,
    "host": DEFAULT_HOST,
    "port": DEFAULT_PORT,
    "token": "",
    "clients": 0,
    "last_op": None,
    "last_ok": None,
    "last_ms": None,
    "last_note": "",
    "started_at": None,
    "handled": 0,
    "failed": 0,
}


def _prefs():
    try:
        return bpy.context.preferences.addons[ADDON_ID].preferences
    except Exception:
        return None


def _auto_frame_enabled():
    prefs = _prefs()
    return bool(prefs.auto_frame) if prefs else True


def _allow_run_python():
    """逃生舱。默认关闭——理由见模块文档第 2 条。"""
    prefs = _prefs()
    if prefs:
        return bool(prefs.allow_run_python)
    return os.environ.get("CHATSPACE_BRIDGE_ALLOW_PYTHON") == "1"


def _log(note):
    _LOG.append((time.strftime("%H:%M:%S"), note))


# ---------------------------------------------------------------------------
# 主线程任务泵
# ---------------------------------------------------------------------------


class _Job:
    __slots__ = ("op", "params", "result", "error", "done", "queued_at", "started_at")

    def __init__(self, op_name, params):
        self.op = op_name
        self.params = params
        self.result = None
        self.error = None
        self.done = threading.Event()
        self.queued_at = time.time()
        self.started_at = None


_JOB_QUEUE = queue.Queue()
_TIMER_INTERVAL_BUSY = 0.02
_TIMER_INTERVAL_IDLE = 0.10


def _ensure_timer():
    """确保主线程泵在跑。在 timer 回调里重复注册是幂等的。"""
    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, first_interval=0.01, persistent=True)


def _pump():
    """在**主线程**上排空任务队列。返回值是下一次调用的间隔（返回 None 会注销）。"""
    busy = False
    while True:
        try:
            job = _JOB_QUEUE.get_nowait()
        except queue.Empty:
            break
        busy = True
        job.started_at = time.time()
        try:
            job.result = _execute(job.op, job.params)
        except OpError as exc:
            job.error = {"kind": "op_error", "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - 必须把任何失败如实回给调用方
            job.error = {
                "kind": "internal",
                "message": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc(),
            }
        finally:
            job.done.set()

    if busy:
        _redraw_all()
    return _TIMER_INTERVAL_BUSY if busy else _TIMER_INTERVAL_IDLE


def _submit(op_name, params, timeout):
    """从任意线程提交一个 op，阻塞等待主线程执行完。"""
    if not bpy.app.timers.is_registered(_pump):
        # timers.register 必须在主线程调用；socket 线程只负责入队。
        # 正常情况下 addon 注册时泵已经跑起来了，这里是兜底。
        raise OpError("the main-thread job pump is not running (the add-on may be disabled)")
    job = _Job(op_name, params)
    _JOB_QUEUE.put(job)
    if not job.done.wait(timeout):
        raise OpError(
            f"op `{op_name}` did not finish within {timeout:.0f}s; "
            "Blender may still be running it (the viewport stays frozen until it finishes)"
            " — split the work into smaller steps"
        )
    if job.error:
        if job.error["kind"] == "op_error":
            raise OpError(job.error["message"])
        raise RuntimeError(job.error.get("traceback") or job.error["message"])
    return job.result


def _execute(op_name, params):
    if op_name == "run_python":
        if not _allow_run_python():
            raise OpError(
                "run_python is disabled. This is deliberate: LLM-written bpy fails silently, "
                "so the product path only uses typed ops. If you really need it, enable "
                "allow_run_python in the add-on preferences."
            )
        return _run_python(params)
    fn = _OPS.get(op_name)
    if fn is None:
        raise OpError(
            f"unknown op `{op_name}`; available: {', '.join(sorted(_OPS))}"
        )
    return fn(params or {})


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------


def _redraw_all():
    """让所有窗口重绘 —— 人才能看到刚才那一步的结果。"""
    try:
        wm = bpy.context.window_manager
        for window in wm.windows:
            screen = window.screen
            if screen is None:
                continue
            for area in screen.areas:
                area.tag_redraw()
    except Exception:
        pass


def _link(mesh, name):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _mesh_from_bmesh(name, build):
    """用 bmesh 造网格 —— 完全不需要 context，因此在主线程/后台都可靠。"""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    try:
        build(bm)
        bm.to_mesh(mesh)
    finally:
        bm.free()
    mesh.update()
    return mesh


def _obj(name):
    if not name:
        raise OpError("name is required")
    obj = bpy.data.objects.get(name)
    if obj is None:
        known = ", ".join(sorted(o.name for o in bpy.data.objects)) or "(scene is empty)"
        raise OpError(f"object `{name}` not found; the current scene has: {known}")
    return obj


def _mesh_obj(name):
    obj = _obj(name)
    if obj.type != "MESH":
        raise OpError(f"`{name}` is {obj.type}, not MESH")
    return obj


def _vec(value, default=None, field="parameter"):
    if value is None:
        if default is None:
            raise OpError(f"{field} must not be empty")
        return Vector(default)
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise OpError(f"{field} must be [x, y, z], got {value!r}")
    try:
        return Vector((float(value[0]), float(value[1]), float(value[2])))
    except (TypeError, ValueError) as exc:
        raise OpError(f"{field} must be three numbers: {value!r}") from exc


def _bounds(objects=None):
    """场景（或指定对象集合）的世界包围盒。退化时返回 None —— 这是判"几何是否存在"的关键事实。"""
    objs = objects if objects is not None else list(bpy.context.scene.objects)
    lo = Vector((math.inf, math.inf, math.inf))
    hi = Vector((-math.inf, -math.inf, -math.inf))
    found = False
    for obj in objs:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            if not all(math.isfinite(c) for c in world):
                continue
            found = True
            for i in range(3):
                lo[i] = min(lo[i], world[i])
                hi[i] = max(hi[i], world[i])
    if not found:
        return None
    return lo, hi


def _stats():
    """引擎事实：对象清单 + 汇总。每个 op 都带它回去，让调用方有判据可用。"""
    objects = []
    total_faces = 0
    total_verts = 0
    degenerate = []
    for obj in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        entry = {
            "name": obj.name,
            "type": obj.type,
            "location": [round(c, 6) for c in obj.location],
        }
        if obj.type == "MESH":
            faces = len(obj.data.polygons)
            verts = len(obj.data.vertices)
            entry["faces"] = faces
            entry["verts"] = verts
            entry["modifiers"] = [m.type for m in obj.modifiers]
            total_faces += faces
            total_verts += verts
            if faces == 0:
                degenerate.append(obj.name)
            # NaN / 非有限坐标是最典型的静默失败产物
            bad = [v.co for v in obj.data.vertices if not all(math.isfinite(c) for c in v.co)]
            if bad:
                entry["non_finite_vertices"] = len(bad)
                degenerate.append(obj.name)
        objects.append(entry)

    bounds = _bounds()
    return {
        "objects": objects,
        "objectCount": len(objects),
        "meshCount": sum(1 for o in objects if o["type"] == "MESH"),
        "totalFaces": total_faces,
        "totalVerts": total_verts,
        "bounds": (
            {
                "min": [round(c, 6) for c in bounds[0]],
                "max": [round(c, 6) for c in bounds[1]],
                "size": [round(bounds[1][i] - bounds[0][i], 6) for i in range(3)],
            }
            if bounds
            else None
        ),
        "degenerate": degenerate,
    }


def _blender_version():
    return ".".join(str(v) for v in bpy.app.version)


# ---------------------------------------------------------------------------
# 视口控制（"看得见"的关键）
# ---------------------------------------------------------------------------

_VIEW_PRESETS = {
    # region_3d.view_rotation 是四元数；identity = 俯视（沿 -Z 看）。
    "top": ((0.0, 0.0, 0.0), "ORTHO"),
    "bottom": ((math.pi, 0.0, 0.0), "ORTHO"),
    "front": ((math.radians(90), 0.0, 0.0), "ORTHO"),
    "back": ((math.radians(90), 0.0, math.pi), "ORTHO"),
    "right": ((math.radians(90), 0.0, math.radians(90)), "ORTHO"),
    "left": ((math.radians(90), 0.0, math.radians(-90)), "ORTHO"),
    "user": ((math.radians(63.435), 0.0, math.radians(45)), "PERSP"),
}


def _view3d_regions():
    """遍历所有 3D 视口区域。用数据结构而不是 operator —— 不需要 context override。"""
    out = []
    try:
        for window in bpy.context.window_manager.windows:
            screen = window.screen
            if screen is None:
                continue
            for area in screen.areas:
                if area.type != "VIEW_3D":
                    continue
                for region in area.regions:
                    if region.type == "WINDOW":
                        space = area.spaces.active
                        if space and space.region_3d:
                            out.append((space, space.region_3d))
    except Exception:
        pass
    return out


def _frame_view(radius_scale=2.6):
    """把每个 3D 视口对准场景包围盒。直接写 region_3d，不走 operator。"""
    bounds = _bounds()
    if bounds is None:
        return 0
    lo, hi = bounds
    center = (lo + hi) / 2.0
    size = max((hi - lo).length, 0.2)
    count = 0
    for space, r3d in _view3d_regions():
        r3d.view_location = center
        r3d.view_distance = size * radius_scale
        count += 1
    return count


@op("frame_all", mutates=False, summary="Frame the viewport on the whole scene (the key to letting a human see it)")
def op_frame_all(params):
    count = _frame_view(float(params.get("radius_scale", 2.6)))
    return {"framed": count, "note": "no 3D viewport (background mode)" if count == 0 else ""}


@op("set_view", mutates=False, summary="Switch the viewport camera: top/front/right/user/…")
def op_set_view(params):
    name = str(params.get("view", "user")).lower()
    if name not in _VIEW_PRESETS:
        raise OpError(f"view must be one of {', '.join(_VIEW_PRESETS)}; got {name!r}")
    (rx, ry, rz), perspective = _VIEW_PRESETS[name]
    quat = Euler((rx, ry, rz), "XYZ").to_quaternion()
    count = 0
    for space, r3d in _view3d_regions():
        r3d.view_rotation = quat
        r3d.view_perspective = perspective
        space.overlay.show_floor = bool(params.get("show_grid", True))
        space.overlay.show_axis_x = True
        space.overlay.show_axis_y = True
        count += 1
    return {"view": name, "applied": count}


# ---------------------------------------------------------------------------
# 场景 op
# ---------------------------------------------------------------------------


@op("ping", mutates=False, summary="Liveness check; returns the Blender version and a scene overview")
def op_ping(params):
    return {
        "blender": _blender_version(),
        "protocol": PROTOCOL_VERSION,
        "scene": bpy.context.scene.name,
        "objectCount": len(bpy.context.scene.objects),
        "catalog": [m["name"] for m in op_catalog()],
    }


@op("scene_info", mutates=False, summary="Engine facts: object list, face counts, bounding box, degenerate items")
def op_scene_info(params):
    return _stats()


@op("reset", mutates=True, summary="Clear the scene (back to a blank starting point)")
def op_reset(params):
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)
    if params.get("keep_view") is not True:
        for _, r3d in _view3d_regions():
            r3d.view_location = Vector((0.0, 0.0, 0.0))
            r3d.view_distance = 8.0
    return _stats()


@op("delete", mutates=True, summary="Delete one object")
def op_delete(params):
    bpy.data.objects.remove(_obj(str(params.get("name", ""))), do_unlink=True)
    return _stats()


# ---------------------------------------------------------------------------
# 图元
# ---------------------------------------------------------------------------


def _primitive(name, build, location=None, rotation_degrees=None, scale=None, material=None):
    mesh = _mesh_from_bmesh(name, build)
    obj = _link(mesh, name)
    if location is not None:
        obj.location = _vec(location, field="location")
    if rotation_degrees is not None:
        deg = _vec(rotation_degrees, field="rotation_degrees")
        obj.rotation_euler = Euler(
            (math.radians(deg.x), math.radians(deg.y), math.radians(deg.z)), "XYZ"
        )
    if scale is not None:
        obj.scale = _vec(scale, field="scale")
    if material:
        _assign_material(obj, material)
    return obj


def _apply_and_return(obj, note=""):
    bpy.context.view_layer.update()
    stats = _stats()
    entry = next((o for o in stats["objects"] if o["name"] == obj.name), None)
    return {"object": entry, "stats": stats, "note": note}


@op("box", summary="Cube (size is the full length along each axis)")
def op_box(params):
    size = _vec(params.get("size"), default=(1.0, 1.0, 1.0), field="size")
    name = str(params.get("name") or "Box")

    def build(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, verts=bm.verts, vec=size)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    obj = _primitive(name, build, params.get("location"),
                     params.get("rotation_degrees"), params.get("scale"),
                     params.get("material"))
    return _apply_and_return(obj)


@op("cylinder", summary="Cylinder/cone (equal radius_top and radius_bottom gives a cylinder)")
def op_cylinder(params):
    r_bottom = float(params.get("radius_bottom", params.get("radius", 0.5)))
    r_top = float(params.get("radius_top", r_bottom))
    depth = float(params.get("depth", 1.0))
    segments = max(3, int(params.get("segments", 32)))
    name = str(params.get("name") or "Cylinder")

    def build(bm):
        bmesh.ops.create_cone(
            bm, cap_ends=True, cap_tris=False, segments=segments,
            radius1=r_bottom, radius2=r_top, depth=depth,
        )
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    obj = _primitive(name, build, params.get("location"),
                     params.get("rotation_degrees"), params.get("scale"),
                     params.get("material"))
    return _apply_and_return(obj)


@op("sphere", summary="UV sphere")
def op_sphere(params):
    radius = float(params.get("radius", 0.5))
    u = max(3, int(params.get("segments", 32)))
    v = max(2, int(params.get("rings", 16)))
    name = str(params.get("name") or "Sphere")

    def build(bm):
        try:
            bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=radius)
        except TypeError:  # Blender < 3.0 用 diameter
            bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, diameter=radius)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    obj = _primitive(name, build, params.get("location"),
                     params.get("rotation_degrees"), params.get("scale"),
                     params.get("material"))
    return _apply_and_return(obj)


@op("torus", summary="Torus (washers, handles, ring-shaped parts)")
def op_torus(params):
    major = float(params.get("major_radius", 0.5))
    minor = float(params.get("minor_radius", 0.15))
    major_seg = max(3, int(params.get("major_segments", 32)))
    minor_seg = max(3, int(params.get("minor_segments", 12)))
    name = str(params.get("name") or "Torus")

    def build(bm):
        rings = []
        for i in range(major_seg):
            theta = 2.0 * math.pi * i / major_seg
            cx, cy = math.cos(theta) * major, math.sin(theta) * major
            ring = []
            for j in range(minor_seg):
                phi = 2.0 * math.pi * j / minor_seg
                r = minor * math.cos(phi)
                ring.append(bm.verts.new((cx + r * math.cos(theta),
                                          cy + r * math.sin(theta),
                                          minor * math.sin(phi))))
            rings.append(ring)
        bm.verts.ensure_lookup_table()
        for i in range(major_seg):
            a, b = rings[i], rings[(i + 1) % major_seg]
            for j in range(minor_seg):
                k = (j + 1) % minor_seg
                bm.faces.new((a[j], a[k], b[k], b[j]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    obj = _primitive(name, build, params.get("location"),
                     params.get("rotation_degrees"), params.get("scale"),
                     params.get("material"))
    return _apply_and_return(obj)


@op("extrude_profile", summary="Extrude a closed profile on the XY plane into a solid (the workhorse for hard surfaces)")
def op_extrude_profile(params):
    """`points` is a closed profile of [[x,y], …] (it is closed automatically; no need to repeat
    the first point).

    For shapes with holes, do **not** stuff multiple profiles in here: first extrude the solid,
    then cut with `boolean`. This is deliberate — boolean is a single-responsibility op with
    enumerable failure reasons, while multi-profile triangulation failure is a black box.
    """
    raw = params.get("points")
    if not isinstance(raw, list) or len(raw) < 3:
        raise OpError("points needs at least 3 [x, y] points")
    points = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            raise OpError(f"every point must be [x, y], got {item!r}")
        points.append((float(item[0]), float(item[1])))
    height = float(params.get("height", 1.0))
    if height == 0.0:
        raise OpError("height must not be 0 (that would give a zero-volume shell)")
    name = str(params.get("name") or "Profile")

    def build(bm):
        verts = [bm.verts.new((x, y, 0.0)) for x, y in points]
        try:
            face = bm.faces.new(verts)
        except ValueError as exc:
            raise OpError(
                f"the profile cannot form a face (duplicate, self-intersecting or collinear points): {exc}"
            ) from exc
        result = bmesh.ops.extrude_face_region(bm, geom=[face])
        new_verts = [e for e in result["geom"] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, verts=new_verts, vec=(0.0, 0.0, height))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    obj = _primitive(name, build, params.get("location"),
                     params.get("rotation_degrees"), params.get("scale"),
                     params.get("material"))
    return _apply_and_return(obj)


# ---------------------------------------------------------------------------
# 变换与修改器
# ---------------------------------------------------------------------------


@op("transform", summary="Set an object's location/rotation (degrees)/scale")
def op_transform(params):
    obj = _mesh_obj(str(params.get("name", "")))
    if "location" in params and params["location"] is not None:
        obj.location = _vec(params["location"], field="location")
    if "rotation_degrees" in params and params["rotation_degrees"] is not None:
        deg = _vec(params["rotation_degrees"], field="rotation_degrees")
        obj.rotation_euler = Euler(
            (math.radians(deg.x), math.radians(deg.y), math.radians(deg.z)), "XYZ"
        )
    if "scale" in params and params["scale"] is not None:
        obj.scale = _vec(params["scale"], field="scale")
    bpy.context.view_layer.update()
    return _apply_and_return(obj, note="the transform only takes effect if there are no unapplied modifiers")


def _apply_modifiers(obj):
    """用 depsgraph 求值来"应用修改器" —— 不需要 bpy.ops，因此不需要 context override。"""
    if not obj.modifiers:
        return 0
    count = len(obj.modifiers)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    new_mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
    old_mesh = obj.data
    obj.data = new_mesh
    obj.modifiers.clear()
    if old_mesh.users == 0:
        bpy.data.meshes.remove(old_mesh)
    bpy.context.view_layer.update()
    return count


@op("apply_modifiers", summary="Bake all modifiers into the mesh (required before export)")
def op_apply_modifiers(params):
    obj = _mesh_obj(str(params.get("name", "")))
    count = _apply_modifiers(obj)
    return _apply_and_return(obj, note=f"applied {count} modifiers")


@op("boolean", summary="Boolean: union/difference/intersect (the tool object is consumed)")
def op_boolean(params):
    target = _mesh_obj(str(params.get("target", "")))
    tool = _mesh_obj(str(params.get("tool", "")))
    if target is tool:
        raise OpError("target and tool must not be the same object")
    operation = str(params.get("operation", "difference")).upper()
    if operation not in {"UNION", "DIFFERENCE", "INTERSECT"}:
        raise OpError("operation must be union/difference/intersect")
    before = len(target.data.polygons)

    modifier = target.modifiers.new(name="cs_boolean", type="BOOLEAN")
    modifier.operation = operation
    modifier.object = tool
    modifier.solver = str(params.get("solver", "EXACT")).upper()

    if params.get("keep_tool") is not True:
        bpy.data.objects.remove(tool, do_unlink=True)
    _apply_modifiers(target)
    bpy.context.view_layer.update()

    after = len(target.data.polygons)
    result = _apply_and_return(
        target,
        note=f"{operation}: {before} → {after} faces",
    )
    if after == 0:
        result["warning"] = (
            "the mesh is empty after the boolean — the two objects most likely do not really "
            "intersect, or difference carved the whole target away. First confirm that their "
            "world bounding boxes actually overlap."
        )
    return result


@op("bevel", summary="Bevel (the key to hard surfaces not looking like plastic)")
def op_bevel(params):
    obj = _mesh_obj(str(params.get("name", "")))
    width = float(params.get("width", 0.02))
    segments = max(1, int(params.get("segments", 2)))
    if width <= 0:
        raise OpError("width must be positive")
    if not obj.modifiers:
        # 先应用已有的，避免修改器顺序把倒角放到布尔之前
        pass
    modifier = obj.modifiers.new(name="cs_bevel", type="BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = str(params.get("limit_method", "ANGLE")).upper()
    modifier.angle_limit = math.radians(float(params.get("angle_limit_degrees", 30.0)))
    modifier.harden_normals = bool(params.get("harden_normals", False))
    before = len(obj.data.polygons)
    _apply_modifiers(obj)
    return _apply_and_return(obj, note=f"bevel {width}m/{segments} segments: {before} → {len(obj.data.polygons)} faces")


@op("solidify", summary="Solidify (turn a surface patch into a solid with thickness)")
def op_solidify(params):
    obj = _mesh_obj(str(params.get("name", "")))
    thickness = float(params.get("thickness", 0.05))
    if thickness == 0:
        raise OpError("thickness must not be 0")
    modifier = obj.modifiers.new(name="cs_solidify", type="SOLIDIFY")
    modifier.thickness = thickness
    modifier.offset = float(params.get("offset", -1.0))
    _apply_modifiers(obj)
    return _apply_and_return(obj)


@op("mirror", summary="Mirror (modeling symmetric parts)")
def op_mirror(params):
    obj = _mesh_obj(str(params.get("name", "")))
    axes = params.get("axes", ["x"])
    if isinstance(axes, str):
        axes = [axes]
    modifier = obj.modifiers.new(name="cs_mirror", type="MIRROR")
    modifier.use_axis[0] = "x" in axes
    modifier.use_axis[1] = "y" in axes
    modifier.use_axis[2] = "z" in axes
    if not any(modifier.use_axis):
        raise OpError("axes needs at least one of: x/y/z")
    modifier.use_clip = bool(params.get("use_clip", False))
    modifier.merge_threshold = float(params.get("merge_threshold", 0.001))
    _apply_modifiers(obj)
    return _apply_and_return(obj)


@op("array", summary="Array: linear (constant_offset) or circular (use_object / around the origin)")
def op_array(params):
    obj = _mesh_obj(str(params.get("name", "")))
    count = int(params.get("count", 2))
    if count < 1 or count > 500:
        raise OpError("count must be in 1..500")
    modifier = obj.modifiers.new(name="cs_array", type="ARRAY")
    modifier.count = count
    mode = str(params.get("mode", "linear")).lower()
    if mode == "linear":
        offset = _vec(params.get("offset"), default=(0.0, 0.0, 1.0), field="offset")
        modifier.use_relative_offset = False
        modifier.use_constant_offset = True
        modifier.constant_offset_displace = offset
    elif mode == "circular":
        pivot = bpy.data.objects.new("cs_array_pivot", None)
        bpy.context.scene.collection.objects.link(pivot)
        pivot.location = _vec(params.get("pivot"), default=(0.0, 0.0, 0.0), field="pivot")
        pivot.rotation_euler = Euler(
            (0.0, 0.0, math.radians(float(params.get("sweep_degrees", 360.0)) / count)), "XYZ"
        )
        obj.parent = pivot
        obj.matrix_parent_inverse = pivot.matrix_world.inverted()
        modifier.use_relative_offset = False
        modifier.use_object_offset = True
        modifier.offset_object = pivot
        modifier.use_relative_offset = False
    else:
        raise OpError("mode must be linear or circular")
    _apply_modifiers(obj)
    result = _apply_and_return(obj, note=f"{mode} array ×{count}")
    if params.get("cleanup_pivot", True) and obj.parent is not None:
        pivot = obj.parent
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
        bpy.data.objects.remove(pivot, do_unlink=True)
        bpy.context.view_layer.update()
        result["stats"] = _stats()
    return result


@op("subdivide", summary="Subdivide (Catmull-Clark or simple subdivision)")
def op_subdivide(params):
    obj = _mesh_obj(str(params.get("name", "")))
    levels = max(0, min(6, int(params.get("levels", 1))))
    if levels == 0:
        raise OpError("levels must be at least 1")
    if len(obj.data.polygons) > 200_000:
        raise OpError("the mesh already has over 200,000 faces; subdividing will blow up memory — decimate first or skip the subdivision")
    modifier = obj.modifiers.new(name="cs_subsurf", type="SUBSURF")
    modifier.levels = levels
    modifier.render_levels = levels
    if str(params.get("type", "catmull-clark")).lower() == "simple":
        modifier.subdivision_type = "SIMPLE"
    _apply_modifiers(obj)
    return _apply_and_return(obj)


@op("shade_smooth", mutates=False, summary="Shade smooth")
def op_shade_smooth(params):
    obj = _mesh_obj(str(params.get("name", "")))
    smooth = bool(params.get("smooth", True))
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    obj.data.update()
    return {"name": obj.name, "smooth": smooth}


@op("uv_smart_project", mutates=False, summary="Smart UV project")
def op_uv_smart_project(params):
    """需要 Edit Mode + operator，因此是本文件里少数必须走 context override 的 op。"""
    obj = _mesh_obj(str(params.get("name", "")))
    view_layer = bpy.context.view_layer
    previous = view_layer.objects.active
    try:
        for other in bpy.context.selected_objects:
            other.select_set(False)
        obj.select_set(True)
        view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(
            angle_limit=math.radians(float(params.get("angle_limit_degrees", 66.0))),
            island_margin=float(params.get("island_margin", 0.02)),
        )
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception as exc:  # noqa: BLE001
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass
        raise OpError(f"UV unwrap failed (needs a 3D viewport context): {type(exc).__name__}: {exc}") from exc
    finally:
        if previous is not None:
            view_layer.objects.active = previous
    return {
        "name": obj.name,
        "uvLayers": [layer.name for layer in obj.data.uv_layers],
        "note": "UV unwrap succeeded, but no seam optimization was done — good enough for regular shapes",
    }


# ---------------------------------------------------------------------------
# 材质
# ---------------------------------------------------------------------------


def _assign_material(obj, spec):
    if isinstance(spec, str):
        spec = {"name": spec}
    if not isinstance(spec, dict):
        raise OpError("material must be a name, or a {name, base_color, metallic, roughness} object")
    name = str(spec.get("name") or f"{obj.name}_mat")
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name=name)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        color = spec.get("base_color")
        if isinstance(color, (list, tuple)) and len(color) in (3, 4):
            bsdf.inputs["Base Color"].default_value = (
                float(color[0]), float(color[1]), float(color[2]),
                float(color[3]) if len(color) == 4 else 1.0,
            )
        if "metallic" in spec:
            bsdf.inputs["Metallic"].default_value = float(spec["metallic"])
        if "roughness" in spec:
            bsdf.inputs["Roughness"].default_value = float(spec["roughness"])
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return material


@op("set_material", summary="Set a PBR material (base color/metallic/roughness)")
def op_set_material(params):
    obj = _mesh_obj(str(params.get("name", "")))
    material = _assign_material(obj, {
        "name": params.get("material_name"),
        "base_color": params.get("base_color", [0.8, 0.8, 0.8, 1.0]),
        "metallic": params.get("metallic", 0.0),
        "roughness": params.get("roughness", 0.5),
    })
    return {"name": obj.name, "material": material.name}


# ---------------------------------------------------------------------------
# 文件往返
# ---------------------------------------------------------------------------


@op("import_glb", summary="Import GLB/GLTF (bring an existing asset in to modify)")
def op_import_glb(params):
    path = str(params.get("path", ""))
    if not path or not os.path.isfile(path):
        raise OpError(f"file does not exist: {path!r} (the path must be visible to the machine Blender runs on)")
    before = set(bpy.data.objects.keys())
    bpy.ops.import_scene.gltf(filepath=path)
    added = sorted(set(bpy.data.objects.keys()) - before)
    if not added:
        raise OpError(f"importing {path} added no objects — the file may be empty or in the wrong format")
    bpy.context.view_layer.update()
    return {"imported": added, "stats": _stats()}


@op("export_glb", summary="Export GLB (all modifiers are applied automatically before export)")
def op_export_glb(params):
    path = str(params.get("path", ""))
    if not path:
        raise OpError("path is required")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if params.get("apply_modifiers", True):
        for obj in list(bpy.context.scene.objects):
            if obj.type == "MESH" and obj.modifiers:
                _apply_modifiers(obj)
    bpy.context.view_layer.update()
    stats = _stats()
    if stats["meshCount"] == 0:
        raise OpError("there are no meshes in the scene; exporting would give an empty file")
    if stats["totalFaces"] == 0:
        raise OpError("every mesh has 0 faces; the export would be an empty model (this usually means the previous step failed silently)")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=bool(params.get("selection_only", False)),
        export_apply=False,
        export_yup=True,
    )
    if not os.path.isfile(path):
        raise OpError(f"the export command finished but the file does not exist: {path}")
    size = os.path.getsize(path)
    if size < 1024:
        raise OpError(f"the exported GLB is only {size} bytes; it is almost certainly broken")
    return {"path": path, "bytes": size, "stats": stats}


@op("save_blend", summary="Save the .blend (the single source of truth for parameters, for later re-runs with changed parameters)")
def op_save_blend(params):
    path = str(params.get("path", ""))
    if not path:
        raise OpError("path is required")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path)
    return {"path": path, "bytes": os.path.getsize(path)}


@op("screenshot", mutates=False, summary="Capture a viewport image (the agent's eyes; a human watches the real stream)")
def op_screenshot(params):
    """走 `render.opengl` 抓当前视口。

    注意这一条的定位：**它是给 agent 自检用的，不是给"实时观看"用的**。
    人要看到的是真实推流（本地 getDisplayMedia / 远端 KasmVNC 或 Selkies）。
    """
    path = str(params.get("path") or os.path.join(
        bpy.app.tempdir or "/tmp", "chatspace_viewport.png"
    ))
    regions = _view3d_regions()
    if not regions:
        raise OpError("no 3D viewport to capture (background mode)")
    space, _ = regions[0]
    area = next((a for a in _all_areas() if a.spaces.active is space), None)
    region = None
    if area is not None:
        region = next((r for r in area.regions if r.type == "WINDOW"), None)
    try:
        with bpy.context.temp_override(area=area, region=region, space_data=space):
            bpy.ops.render.opengl(write_still=True, filepath=path)
    except Exception as exc:  # noqa: BLE001
        raise OpError(
            f"viewport capture failed ({type(exc).__name__}: {exc}). "
            "This is the old problem of opengl rendering being context-sensitive — it needs "
            "a real GUI viewport."
        ) from exc
    if not os.path.isfile(path):
        raise OpError("the capture command finished but the file does not exist")
    with open(path, "rb") as handle:
        data = handle.read()
    result = {"path": path, "bytes": len(data), "width": None, "height": None}
    if params.get("inline", True):
        result["pngBase64"] = base64.b64encode(data).decode("ascii")
    return result


def _all_areas():
    out = []
    try:
        for window in bpy.context.window_manager.windows:
            if window.screen:
                out.extend(window.screen.areas)
    except Exception:
        pass
    return out


def _run_python(params):
    """逃生舱：默认禁用。启用后仍然回到引擎事实，避免"静默成功"。"""
    code = str(params.get("code", ""))
    if not code.strip():
        raise OpError("code must not be empty")
    namespace = {"bpy": bpy, "bmesh": bmesh, "math": math, "Matrix": Matrix, "Vector": Vector}
    import io
    import contextlib

    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            exec(compile(code, "<chatspace>", "exec"), namespace)
    except Exception as exc:  # noqa: BLE001
        raise OpError(
            f"python execution failed: {type(exc).__name__}: {exc}\n{buffer.getvalue()}"
        ) from exc
    return {"stdout": buffer.getvalue(), "stats": _stats()}


# ---------------------------------------------------------------------------
# socket 服务
# ---------------------------------------------------------------------------


class _Handler(socketserver.StreamRequestHandler):
    def handle(self):
        _STATE["clients"] += 1
        try:
            self._send({
                "event": "hello",
                "protocol": PROTOCOL_VERSION,
                "blender": _blender_version(),
                "scene": bpy.context.scene.name,
            })
            while True:
                line = self.rfile.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                self._handle_line(line)
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            _STATE["clients"] -= 1
            _redraw_all()

    def _handle_line(self, line):
        request_id = None
        started = time.time()
        try:
            request = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            self._send({"ok": False, "error": f"request is not valid JSON: {exc}"})
            return

        request_id = request.get("id")
        op_name = str(request.get("op", ""))
        token = str(request.get("token", ""))

        if _STATE["token"] and token != _STATE["token"]:
            self._send({"id": request_id, "ok": False,
                        "error": {"kind": "auth", "message": "incorrect token"}})
            return

        if op_name == "catalog":
            self._send({"id": request_id, "ok": True, "result": {"ops": op_catalog()}})
            return

        try:
            result = _submit(op_name, request.get("params") or {}, float(
                request.get("timeout", DEFAULT_OP_TIMEOUT_S)
            ))
            elapsed = (time.time() - started) * 1000.0
            _STATE["handled"] += 1
            _STATE["last_op"] = op_name
            _STATE["last_ok"] = True
            _STATE["last_ms"] = elapsed
            _STATE["last_note"] = _note_for(op_name, result)
            _log(f"✓ {op_name}  {elapsed:.0f}ms")
            if _auto_frame_enabled() and _is_mutating(op_name):
                _frame_view()
                _redraw_all()
            self._send({"id": request_id, "ok": True, "result": result,
                        "ms": round(elapsed, 1), "blender": _blender_version()})
        except OpError as exc:
            elapsed = (time.time() - started) * 1000.0
            _STATE["failed"] += 1
            _STATE["last_op"] = op_name
            _STATE["last_ok"] = False
            _STATE["last_ms"] = elapsed
            _STATE["last_note"] = str(exc)[:200]
            _log(f"✗ {op_name}  {elapsed:.0f}ms  {str(exc)[:80]}")
            self._send({"id": request_id, "ok": False,
                        "error": {"kind": "op_error", "message": str(exc)},
                        "ms": round(elapsed, 1)})
        except Exception as exc:  # noqa: BLE001
            elapsed = (time.time() - started) * 1000.0
            _STATE["failed"] += 1
            _STATE["last_op"] = op_name
            _STATE["last_ok"] = False
            _STATE["last_ms"] = elapsed
            _STATE["last_note"] = f"{type(exc).__name__}: {exc}"
            _log(f"✗ {op_name}  {elapsed:.0f}ms  {type(exc).__name__}")
            self._send({"id": request_id, "ok": False,
                        "error": {"kind": "internal", "message": f"{type(exc).__name__}: {exc}",
                                  "traceback": traceback.format_exc()},
                        "ms": round(elapsed, 1)})
        finally:
            _redraw_all()

    def _send(self, payload):
        try:
            self.wfile.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        except (ConnectionResetError, BrokenPipeError):
            pass


def _is_mutating(op_name):
    fn = _OPS.get(op_name)
    return bool(fn and fn._cs_op["mutates"])


def _note_for(op_name, result):
    if not isinstance(result, dict):
        return ""
    if result.get("warning"):
        return str(result["warning"])[:200]
    stats = result.get("stats")
    if isinstance(stats, dict) and stats.get("totalFaces") is not None:
        return f"{stats.get('objectCount')} obj / {stats['totalFaces']} faces"
    if result.get("note"):
        return str(result["note"])[:200]
    return ""


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server(host=None, port=None, token=None):
    if _STATE["server"] is not None:
        return {"host": _STATE["host"], "port": _STATE["port"], "already": True}
    prefs = _prefs()
    host = host or (prefs.host if prefs else DEFAULT_HOST) or DEFAULT_HOST
    port = int(port or (prefs.port if prefs else DEFAULT_PORT) or DEFAULT_PORT)
    if token is None:
        token = (prefs.token if prefs else "") or os.environ.get("CHATSPACE_BRIDGE_TOKEN", "")
    try:
        server = _Server((host, port), _Handler)
    except OSError as exc:
        raise OpError(
            f"cannot listen on {host}:{port} — {exc}. If the port is taken, use another port, "
            "or make sure no second Blender is already running the bridge."
        ) from exc
    thread = threading.Thread(target=server.serve_forever, name="chatspace-bridge", daemon=True)
    thread.start()
    _STATE.update({
        "server": server, "host": host, "port": port, "token": token,
        "started_at": time.time(), "handled": 0, "failed": 0,
    })
    _log(f"listening on {host}:{port}")
    _ensure_timer()
    _redraw_all()
    return {"host": host, "port": port, "token": bool(token)}


def stop_server():
    server = _STATE["server"]
    if server is None:
        return {"stopped": False}
    server.shutdown()
    server.server_close()
    _STATE["server"] = None
    _log("stopped")
    _redraw_all()
    return {"stopped": True}


def server_status():
    return {
        "running": _STATE["server"] is not None,
        "host": _STATE["host"],
        "port": _STATE["port"],
        "tokenRequired": bool(_STATE["token"]),
        "clients": _STATE["clients"],
        "handled": _STATE["handled"],
        "failed": _STATE["failed"],
        "lastOp": _STATE["last_op"],
        "lastOk": _STATE["last_ok"],
        "lastMs": _STATE["last_ms"],
        "lastNote": _STATE["last_note"],
        "blender": _blender_version(),
        "autoFrame": _auto_frame_enabled(),
        "runPythonAllowed": _allow_run_python(),
    }


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------


class CHATSPACE_OT_start_bridge(bpy.types.Operator):
    bl_idname = "chatspace.start_bridge"
    bl_label = "Start Bridge"
    bl_description = "Start listening so the ChatSpace agent can drive this Blender"

    def execute(self, context):
        try:
            info = start_server()
            self.report({"INFO"}, f"ChatSpace Bridge listening on {info['host']}:{info['port']}")
        except OpError as exc:
            self.report({"ERROR"}, str(exc))
            return {"CANCELLED"}
        return {"FINISHED"}


class CHATSPACE_OT_stop_bridge(bpy.types.Operator):
    bl_idname = "chatspace.stop_bridge"
    bl_label = "Stop Bridge"
    bl_description = "Stop listening (ops already running are unaffected)"

    def execute(self, context):
        stop_server()
        self.report({"INFO"}, "ChatSpace Bridge stopped")
        return {"FINISHED"}


class CHATSPACE_OT_frame_all(bpy.types.Operator):
    bl_idname = "chatspace.frame_all"
    bl_label = "Frame All"
    bl_description = "Frame the viewport on the whole scene"

    def execute(self, context):
        _frame_view()
        _redraw_all()
        return {"FINISHED"}


class CHATSPACE_PT_bridge(bpy.types.Panel):
    bl_idname = "CHATSPACE_PT_bridge"
    bl_label = "ChatSpace Bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "ChatSpace"

    def draw(self, context):
        layout = self.layout
        status = server_status()

        box = layout.box()
        row = box.row()
        if status["running"]:
            row.label(text=f"● Listening  {status['host']}:{status['port']}", icon="PLAY")
        else:
            row.label(text="○ Not running", icon="PAUSE")
        if status["running"]:
            box.label(text=f"clients {status['clients']} · ok {status['handled']} · failed {status['failed']}")

        row = layout.row(align=True)
        if status["running"]:
            row.operator("chatspace.stop_bridge", icon="PAUSE")
        else:
            row.operator("chatspace.start_bridge", icon="PLAY")
        row.operator("chatspace.frame_all", text="", icon="VIEWZOOM")

        box = layout.box()
        box.label(text="Last step", icon="INFO")
        if status["lastOp"]:
            row = box.row()
            row.label(text=("✓ " if status["lastOk"] else "✗ ") + str(status["lastOp"]))
            if status["lastMs"] is not None:
                row.label(text=f"{status['lastMs']:.0f}ms")
            if status["lastNote"]:
                box.label(text=str(status["lastNote"])[:48])
        else:
            box.label(text="(no op received yet)")

        box = layout.box()
        box.label(text="History", icon="TIME")
        for stamp, note in reversed(list(_LOG)[-12:]):
            box.label(text=f"{stamp}  {note}"[:52])

        box = layout.box()
        box.label(text=f"Blender {status['blender']}", icon="BLENDER")
        box.label(text=f"Auto-frame viewport: {'on' if status['autoFrame'] else 'off'}")
        if status["runPythonAllowed"]:
            box.label(text="run_python: enabled (escape hatch)", icon="ERROR")


class ChatSpaceBridgePreferences(bpy.types.AddonPreferences):
    bl_idname = ADDON_ID

    host: bpy.props.StringProperty(
        name="Listen address", default=DEFAULT_HOST,
        description="Use 127.0.0.1 locally; when exposing it from a container, change it to 0.0.0.0 and set a token",
    )
    port: bpy.props.IntProperty(name="Port", default=DEFAULT_PORT, min=1, max=65535)
    token: bpy.props.StringProperty(name="Token", default="", subtype="PASSWORD")
    auto_frame: bpy.props.BoolProperty(
        name="Auto-frame the viewport after each step", default=True,
        description="With a human watching the screen, this is the difference between \"visible\" and \"invisible\"",
    )
    allow_run_python: bpy.props.BoolProperty(
        name="Allow the run_python escape hatch", default=False,
        description="Off by default: LLM-written bpy fails silently. Turn it on only when you truly need an operation outside the catalog",
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "host")
        layout.prop(self, "port")
        layout.prop(self, "token")
        layout.prop(self, "auto_frame")
        layout.prop(self, "allow_run_python")
        if self.host not in ("127.0.0.1", "localhost") and not self.token:
            layout.label(text="Listening externally without a token — please add one", icon="ERROR")


_CLASSES = (
    CHATSPACE_OT_start_bridge,
    CHATSPACE_OT_stop_bridge,
    CHATSPACE_OT_frame_all,
    CHATSPACE_PT_bridge,
    ChatSpaceBridgePreferences,
)


def register():
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    _ensure_timer()
    if os.environ.get("CHATSPACE_BRIDGE_AUTOSTART", "1") == "1":
        try:
            start_server()
        except OpError as exc:
            print(f"[chatspace] failed to auto-start the bridge: {exc}")


def unregister():
    stop_server()
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
