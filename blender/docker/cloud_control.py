"""Backend-only MCP and GLB transfer. Desktop Basic credentials never authorize it."""
import asyncio
import hmac
import json
import os
import re
import shutil
from pathlib import Path

from aiohttp import web

ALLOWED_TOOLS = frozenset({"get_addon_status", "get_scene_info", "get_object_info",
                           "get_viewport_screenshot", "execute_blender_code",
                           "bpy_api_lookup", "describe_node_type", "export_scene"})
EXPORT_ROOT = Path("/workspace/.chatspace/exports")
EXPORT_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
MAX_FILE_BYTES = 256 * 1024 * 1024


class BlenderNotReady(Exception):
    pass


class McpBridge:
    """One stdio MCP process per Blender. An interrupted call is never replayed."""
    def __init__(self, command=("/opt/mcp/bin/mcp-for-blender",), socket_endpoint=("127.0.0.1", 9877)):
        self.command = command
        self.process = None
        self.lock = asyncio.Lock()
        self.next_id = 0
        self.socket_endpoint = socket_endpoint

    async def stop(self):
        process, self.process = self.process, None
        if process is not None:
            if process.returncode is None:
                process.kill()
            await process.wait()

    async def exchange(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": request_id,
                                              "method": method, "params": params}) + "\n").encode())
        await self.process.stdin.drain()
        while True:
            line = await self.process.stdout.readline()
            if not line:
                raise RuntimeError("MCP process stopped")
            message = json.loads(line)
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError("MCP protocol error")
                return message["result"]

    async def call(self, tool, arguments):
        async with self.lock:
            try:
                if self.process is None or self.process.returncode is not None:
                    await self.stop()
                    if self.socket_endpoint:
                        try:
                            _, writer = await asyncio.wait_for(asyncio.open_connection(*self.socket_endpoint), timeout=2)
                            writer.close()
                            await writer.wait_closed()
                        except (OSError, asyncio.TimeoutError):
                            raise BlenderNotReady() from None
                    env = {**os.environ, "BLENDER_HOST": "127.0.0.1", "BLENDER_PORT": "9877",
                           "DISABLE_TELEMETRY": "1", "BLENDER_MCP_DISABLE_TELEMETRY": "1",
                           "MCP_DISABLE_TELEMETRY": "1"}
                    self.process = await asyncio.create_subprocess_exec(
                        *self.command, env=env, stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                        limit=16 * 1024 * 1024,
                    )
                    await self.exchange("initialize", {"protocolVersion": "2024-11-05",
                                        "capabilities": {}, "clientInfo": {"name": "chatspace-cloud", "version": "1"}})
                    self.process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
                    await self.process.stdin.drain()
                return await self.exchange("tools/call", {"name": tool,
                                           "arguments": {**arguments, "user_prompt": ""}})
            except BaseException:
                # Timeout/cancellation cannot leave a stale response for the next call.
                await self.stop()
                raise


def install_control(app, token, bridge=None, root=EXPORT_ROOT):
    if token and not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("BLENDER_CONTROL_TOKEN must be 32–128 ASCII letters, digits, _ or -")
    bridge = bridge or McpBridge()
    root = root.resolve()

    def authorize(request):
        if not token:
            raise web.HTTPNotFound()
        if not hmac.compare_digest(request.headers.get("Authorization", "").encode(),
                                   ("Bearer " + token).encode()):
            raise web.HTTPUnauthorized()

    def export_directory(export_id):
        if not EXPORT_ID.fullmatch(export_id):
            raise web.HTTPBadRequest(text="Invalid export id")
        directory = root / export_id
        # Symlink escape is rejected for the directory and the file.
        if directory.is_symlink() or directory.resolve().parent != root:
            raise web.HTTPForbidden()
        return directory

    async def call(request):
        authorize(request)
        if os.environ.get("CHATSPACE_MANAGED") == "1":
            raise web.HTTPForbidden(text="Managed instance requires durable operation endpoint")
        try:
            data = await request.json()
        except (ValueError, UnicodeError):
            raise web.HTTPBadRequest(text="Invalid JSON") from None
        if not isinstance(data, dict) or not isinstance(data.get("tool"), str) or data["tool"] not in ALLOWED_TOOLS:
            raise web.HTTPBadRequest(text="Tool is not allowed")
        arguments = data.get("arguments", {})
        if not isinstance(arguments, dict):
            raise web.HTTPBadRequest(text="Invalid arguments")
        if data["tool"] == "export_scene":
            if not isinstance(arguments.get("filepath"), str):
                raise web.HTTPBadRequest(text="Invalid export path")
            path = Path(arguments.get("filepath", ""))
            directory = export_directory(path.parent.name)
            if path != directory / "model.glb" or arguments.get("format", "glb") != "glb":
                raise web.HTTPBadRequest(text="Export must use its assigned GLB path")
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError:
                raise web.HTTPServiceUnavailable(text="Export directory unavailable") from None
            if path.is_symlink():
                raise web.HTTPForbidden()
        try:
            # Includes queueing and process startup. Never auto-retry execute/export.
            return web.json_response(await asyncio.wait_for(bridge.call(data["tool"], arguments), timeout=180))
        except asyncio.TimeoutError:
            raise web.HTTPGatewayTimeout(text="Blender result unknown; inspect the scene before retrying") from None
        except BlenderNotReady:
            raise web.HTTPServiceUnavailable(text="Blender is starting") from None
        except (RuntimeError, OSError, ValueError):
            raise web.HTTPBadGateway(text="Blender command connection unavailable") from None

    async def file(request):
        authorize(request)
        if authorize_lease:
            authorize_lease(request)
        directory = export_directory(request.match_info["export_id"])
        path = directory / "model.glb"
        if path.is_symlink():
            raise web.HTTPForbidden()
        if request.method == "DELETE":
            if directory.exists():
                shutil.rmtree(directory)
            return web.Response(status=204)
        if not path.is_file():
            raise web.HTTPNotFound()
        if path.stat().st_size > MAX_FILE_BYTES:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_FILE_BYTES, actual_size=path.stat().st_size)
        return web.FileResponse(path, headers={"Cache-Control": "no-store", "Content-Type": "model/gltf-binary"})

    authorize_lease = None
    if os.environ.get("CHATSPACE_MANAGED") == "1":
        from managed_control import install_managed
        session = os.environ.get("CHATSPACE_SESSION_ID", "")
        epoch = int(os.environ.get("CHATSPACE_LEASE_EPOCH", "0"))
        if not EXPORT_ID.fullmatch(session) or epoch < 1:
            raise ValueError("Managed instance requires session and lease epoch")
        authorize_lease = install_managed(app, authorize, bridge, ALLOWED_TOOLS, root.parent / "managed", session, epoch)

    async def cleanup(_app):
        await bridge.stop()

    app.on_cleanup.append(cleanup)
    app.router.add_post("/control/call", call)
    app.router.add_get("/control/exports/{export_id}", file)
    app.router.add_delete("/control/exports/{export_id}", file)
    # Unknown control paths never fall through to the Basic-auth desktop proxy.
    async def unknown(request):
        raise web.HTTPNotFound()
    app.router.add_route("*", "/control/{path:.*}", unknown)
