"""Durable, serial sandbox executor. A dispatched unknown Python call is never replayed."""
import asyncio
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path
from aiohttp import web

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
MAX_BYTES = 256 * 1024 * 1024


class Receipts:
    def __init__(self, path, session, epoch):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), session TEXT NOT NULL, epoch INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL,
          state TEXT NOT NULL, result TEXT);
        UPDATE operations SET state='unknown' WHERE state='running';""")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO lease VALUES (1,?,?)", (session, epoch))
        lease = self.db.execute("SELECT * FROM lease WHERE id=1").fetchone()
        if lease["session"] != session or lease["epoch"] < epoch:
            raise ValueError("Saved lease differs from instance lease; reset required")

    def check(self, data):
        lease = self.db.execute("SELECT * FROM lease WHERE id=1").fetchone()
        if data.get("sessionId") != lease["session"] or data.get("epoch") != lease["epoch"]:
            raise web.HTTPConflict(text="Stale lease")

    def get(self, operation_id):
        row = self.db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
        if row is None:
            raise web.HTTPNotFound()
        return {"id": row["id"], "state": row["state"], "result": json.loads(row["result"]) if row["result"] else None}

    def accept(self, data):
        self.check(data)
        payload = json.dumps(data, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(payload.encode()).hexdigest()
        old = self.db.execute("SELECT digest FROM operations WHERE id=?", (data["operationId"],)).fetchone()
        if old:
            if old["digest"] != digest:
                raise web.HTTPConflict(text="Operation id reused")
            return self.get(data["operationId"])
        if self.db.execute("SELECT id FROM operations WHERE state='unknown'").fetchone():
            raise web.HTTPConflict(text="Unknown command requires reconciliation")
        if self.db.execute("SELECT count(*) FROM operations WHERE state IN ('queued','running')").fetchone()[0] >= 20:
            raise web.HTTPTooManyRequests()
        with self.db:
            self.db.execute("INSERT INTO operations VALUES (?,?,?,'queued',NULL)", (data["operationId"], digest, payload))
        return self.get(data["operationId"])

    def claim(self):
        if self.db.execute("SELECT id FROM operations WHERE state IN ('unknown','running')").fetchone():
            return None
        row = self.db.execute("SELECT * FROM operations WHERE state='queued' ORDER BY rowid LIMIT 1").fetchone()
        if row:
            with self.db:
                self.db.execute("UPDATE operations SET state='running' WHERE id=?", (row["id"],))
            return json.loads(row["payload"])
        return None

    def finish(self, operation_id, state, result):
        with self.db:
            self.db.execute("UPDATE operations SET state=?,result=? WHERE id=? AND state='running'",
                            (state, json.dumps(result), operation_id))


def install_managed(app, authorize, bridge, allowed_tools, root, session, epoch):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    receipts = Receipts(root / "receipts.sqlite", session, epoch)
    tasks = set()
    worker = None

    def file_path(file_id):
        if not isinstance(file_id, str) or not UUID.fullmatch(file_id):
            raise web.HTTPBadRequest(text="Invalid file id")
        directory = root / "files" / file_id
        path = directory / "scene.blend"
        if directory.is_symlink() or path.is_symlink() or directory.resolve().parent != (root / "files").resolve():
            raise web.HTTPForbidden()
        return path

    def script(data):
        file_id = data.get("arguments", {}).get("fileId", "")
        path = file_path(file_id)
        if data["tool"] == "_checkpoint":
            path.parent.mkdir(parents=True, exist_ok=True)
            return {"code": "import bpy, os, json\n"
                "bpy.ops.file.pack_all()\n"
                "if bpy.data.libraries: raise RuntimeError('Linked libraries require explicit dependency support')\n"
                "if any(s.type in {'FLUID','CLOTH'} for o in bpy.data.objects for s in o.modifiers): raise RuntimeError('Simulation caches require explicit dependency support')\n"
                "if any(i.source in {'MOVIE','SEQUENCE'} or (i.filepath and i.source == 'FILE' and not i.packed_file) for i in bpy.data.images): raise RuntimeError('Unpacked image dependency')\n"
                "if any(s.filepath and not s.packed_file for s in bpy.data.sounds): raise RuntimeError('Unpacked sound dependency')\n"
                "if any(f.filepath and f.filepath != '<builtin>' and not f.packed_file for f in bpy.data.fonts): raise RuntimeError('Unpacked font dependency')\n"
                "if bpy.data.cache_files or bpy.data.movieclips or any(v.filepath for v in bpy.data.volumes): raise RuntimeError('External cache dependency requires explicit support')\n"
                "if any(getattr(m, 'bakes', ()) for o in bpy.data.objects for m in o.modifiers): raise RuntimeError('Geometry node bake dependency requires explicit support')\n"
                f"bpy.ops.wm.save_as_mainfile(filepath={str(path)!r}, compress=False)\n"
                f"print('CS_CHECKPOINT ' + json.dumps({{'bytes':os.path.getsize({str(path)!r})}}))"}
        if not path.is_file():
            raise ValueError("Restore file missing")
        return {"code": f"import bpy\nbpy.ops.wm.open_mainfile(filepath={str(path)!r}, load_ui=False, use_scripts=False)\nprint('CS_RESTORED')"}

    async def run_queue():
        nonlocal worker
        try:
            while True:
                data = receipts.claim()
                if not data:
                    break
                try:
                    internal = data["tool"] in {"_checkpoint", "_restore"}
                    arguments = script(data) if internal else data.get("arguments", {})
                    tool = "execute_blender_code" if internal else data["tool"]
                    result = await asyncio.wait_for(bridge.call(tool, arguments), 180)
                    state = "failed" if isinstance(result, dict) and result.get("isError") else "succeeded"
                    if data["tool"] == "_restore" and "CS_RESTORED" not in json.dumps(result):
                        raise RuntimeError("Restore not confirmed")
                    if data["tool"] == "_checkpoint" and state == "succeeded":
                        path = file_path(data["arguments"]["fileId"])
                        if not path.is_file() or path.stat().st_size > MAX_BYTES:
                            raise RuntimeError("Checkpoint incomplete")
                        with path.open("rb") as source:
                            if source.read(7) != b"BLENDER":
                                raise RuntimeError("Invalid checkpoint")
                    receipts.finish(data["operationId"], state, result)
                except asyncio.CancelledError:
                    receipts.finish(data["operationId"], "unknown", {"error": "executor_interrupted"})
                    raise
                except Exception:
                    # Lost response or Python raised after side effects: cannot infer scene outcome.
                    receipts.finish(data["operationId"], "unknown", {"error": "inspect_before_retry"})
        finally:
            worker = None

    def kick():
        nonlocal worker
        if worker is None:
            worker = asyncio.create_task(run_queue())
            tasks.add(worker)
            worker.add_done_callback(tasks.discard)

    async def submit(request):
        authorize(request)
        try:
            data = await request.json()
        except ValueError:
            raise web.HTTPBadRequest() from None
        if (not isinstance(data, dict) or not isinstance(data.get("operationId"), str)
                or not UUID.fullmatch(data["operationId"]) or not isinstance(data.get("tool"), str) or data.get("tool") not in allowed_tools | {"_checkpoint", "_restore"}
                or not isinstance(data.get("arguments", {}), dict)):
            raise web.HTTPBadRequest(text="Invalid operation")
        if data["tool"] == "execute_blender_code":
            code = data.get("arguments", {}).get("code")
            if not isinstance(code, str) or not code.strip() or len(code) > 6000 or any(
                    name in code for name in ("read_factory_settings", "read_homefile", "open_mainfile")):
                raise web.HTTPBadRequest(text="Use a bounded step; restore through the checkpoint service")
        if data["tool"] == "export_scene":
            filepath = data["arguments"].get("filepath", "")
            if not isinstance(filepath, str):
                raise web.HTTPBadRequest(text="Invalid export path")
            path = Path(filepath)
            if not UUID.fullmatch(path.parent.name) or path != Path("/workspace/.chatspace/exports") / path.parent.name / "model.glb" or data["arguments"].get("format", "glb") != "glb":
                raise web.HTTPBadRequest(text="Invalid export path")
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.parent.is_symlink() or path.is_symlink():
                raise web.HTTPForbidden()
        if data["tool"] in {"_checkpoint", "_restore"}:
            file_path(data["arguments"].get("fileId", ""))
        result = receipts.accept(data)
        kick()
        return web.json_response(result, status=202)

    def authorize_lease(request):
        authorize(request)
        try:
            epoch_header = int(request.headers.get("x-chatspace-epoch", "0"))
        except ValueError:
            raise web.HTTPBadRequest() from None
        receipts.check({"sessionId": request.headers.get("x-chatspace-session"), "epoch": epoch_header})

    async def status(request):
        authorize_lease(request)
        return web.json_response(receipts.get(request.match_info["operation_id"]))

    async def health(request):
        authorize_lease(request)
        current = receipts.db.execute("SELECT * FROM lease WHERE id=1").fetchone()
        ready = False
        # Probe the actual addon/main-thread round trip, not just the receipt database.
        # Do not interrupt a serialized scene command with a second MCP exchange.
        if not receipts.db.execute("SELECT id FROM operations WHERE state IN ('queued','running','unknown')").fetchone():
            try:
                result = await asyncio.wait_for(bridge.call("get_addon_status", {}), 10)
                ready = isinstance(result, dict) and not result.get("isError")
            except Exception:
                pass
        return web.json_response({"sessionId": current["session"], "epoch": current["epoch"], "protocolVersion": 1,
            "ready": ready,
            "unknown": bool(receipts.db.execute("SELECT id FROM operations WHERE state='unknown'").fetchone())})

    async def advance(request):
        authorize_lease(request)
        try:
            data = await request.json()
        except ValueError:
            raise web.HTTPBadRequest() from None
        current = receipts.db.execute("SELECT * FROM lease WHERE id=1").fetchone()
        next_epoch = data.get("epoch") if isinstance(data, dict) else None
        if next_epoch != current["epoch"] + 1:
            raise web.HTTPConflict(text="Invalid lease advancement")
        if receipts.db.execute("SELECT id FROM operations WHERE state IN ('queued','running','unknown')").fetchone():
            raise web.HTTPConflict(text="Unresolved operations prevent advancement")
        with receipts.db:
            receipts.db.execute("UPDATE lease SET epoch=? WHERE id=1", (next_epoch,))
        return web.json_response({"sessionId": current["session"], "epoch": next_epoch})

    async def transfer(request):
        authorize_lease(request)
        path = file_path(request.match_info["file_id"])
        if request.method == "PUT":
            if path.exists():
                raise web.HTTPConflict(text="Immutable restore file exists")
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".upload")
            size = 0
            try:
                with temporary.open("xb") as target:
                    async for chunk in request.content.iter_chunked(64 * 1024):
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise web.HTTPRequestEntityTooLarge(max_size=MAX_BYTES, actual_size=size)
                        target.write(chunk)
                    target.flush()
                    os.fsync(target.fileno())
                with temporary.open("rb") as source:
                    if source.read(7) != b"BLENDER":
                        raise web.HTTPBadRequest(text="Invalid blend header")
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
            return web.Response(status=201)
        if not path.is_file():
            raise web.HTTPNotFound()
        if path.stat().st_size > MAX_BYTES:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_BYTES, actual_size=path.stat().st_size)
        return web.FileResponse(path, headers={"Cache-Control": "no-store"})

    async def start(_app):
        kick()

    async def cleanup(_app):
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        receipts.db.close()

    app.on_startup.append(start)
    app.on_cleanup.append(cleanup)
    app.router.add_post("/control/managed/operations", submit)
    app.router.add_get("/control/managed/health", health)
    app.router.add_post("/control/managed/lease/advance", advance)
    app.router.add_get("/control/managed/operations/{operation_id}", status)
    app.router.add_get("/control/managed/files/{file_id}", transfer)
    app.router.add_put("/control/managed/files/{file_id}", transfer)
    return authorize_lease
