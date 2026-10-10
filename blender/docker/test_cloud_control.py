import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cloud_control import BlenderNotReady, McpBridge, install_control

TOKEN = "Control_Test_Secret_1234567890123456"
EXPORT_ID = "00000000-0000-4000-8000-000000000001"


class FakeBridge:
    def __init__(self):
        self.calls = []
    async def call(self, tool, arguments):
        self.calls.append((tool, arguments))
        return {"content": [{"type": "text", "text": "ok"}]}
    async def stop(self):
        pass


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bridge = FakeBridge()
        app = web.Application()
        install_control(app, TOKEN, self.bridge, self.root)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.auth = {"Authorization": "Bearer " + TOKEN}

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def test_basic_password_cannot_authorize_commands_or_files(self):
        for headers in ({}, {"Authorization": "Basic ZGVza3RvcDpzZWNyZXQ="}):
            response = await self.client.post("/control/call", headers=headers,
                                              json={"tool": "execute_blender_code", "arguments": {"code": "print(1)"}})
            self.assertEqual(response.status, 401)
            self.assertEqual((await self.client.get("/control/exports/" + EXPORT_ID, headers=headers)).status, 401)
        self.assertEqual(self.bridge.calls, [])

    async def test_disallowed_tools_and_invalid_paths_never_reach_blender(self):
        for tool, arguments in (("generate_tripo_model", {}), ("export_scene", {"filepath": "/etc/passwd"}),
                                ("export_scene", {"filepath": str(self.root / EXPORT_ID / "model.fbx")})):
            response = await self.client.post("/control/call", headers=self.auth, json={"tool": tool, "arguments": arguments})
            self.assertEqual(response.status, 400)
        self.assertEqual(self.bridge.calls, [])

    async def test_call_returns_mcp_contract_and_preserves_arguments(self):
        response = await self.client.post("/control/call", headers=self.auth,
                                          json={"tool": "get_object_info", "arguments": {"object_name": "Cube"}})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["content"][0]["text"], "ok")
        self.assertEqual(self.bridge.calls, [("get_object_info", {"object_name": "Cube"})])

    async def test_export_download_cleanup_and_symlink_escape(self):
        directory = self.root / EXPORT_ID
        directory.mkdir()
        (directory / "model.glb").write_bytes(b"glTF-test")
        url = "/control/exports/" + EXPORT_ID
        response = await self.client.get(url, headers=self.auth)
        self.assertEqual(await response.read(), b"glTF-test")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        (directory / "model.glb").unlink()
        (directory / "model.glb").symlink_to(__file__)
        self.assertEqual((await self.client.get(url, headers=self.auth)).status, 403)
        (directory / "model.glb").unlink()
        self.assertEqual((await self.client.delete(url, headers=self.auth)).status, 204)
        self.assertFalse(directory.exists())
        self.assertEqual((await self.client.delete(url, headers=self.auth)).status, 204)
        self.assertEqual((await self.client.get("/control/exports/not-a-uuid", headers=self.auth)).status, 400)

    async def test_missing_token_disables_control(self):
        app = web.Application()
        install_control(app, "", self.bridge, self.root)
        async with TestClient(TestServer(app)) as client:
            self.assertEqual((await client.post("/control/call", headers=self.auth, json={"tool": "get_scene_info"})).status, 404)

    async def test_invalid_json_and_argument_types_are_rejected(self):
        self.assertEqual((await self.client.post("/control/call", headers=self.auth, data="{")).status, 400)
        for data in ({"tool": []}, {"tool": "get_scene_info", "arguments": []},
                     {"tool": "export_scene", "arguments": {"filepath": 42}}):
            self.assertEqual((await self.client.post("/control/call", headers=self.auth, json=data)).status, 400)
        self.assertEqual(self.bridge.calls, [])

    async def test_unready_blender_fails_before_mcp_startup(self):
        bridge = McpBridge(socket_endpoint=("127.0.0.1", 0))
        with self.assertRaises(BlenderNotReady):
            await bridge.call("get_scene_info", {})
        self.assertIsNone(bridge.process)

    async def test_real_stdio_initialization_serialization_and_prompt_suppression(self):
        fixture = self.root / "fake_mcp.py"
        fixture.write_text('''import json, sys
for line in sys.stdin:
    req = json.loads(line)
    if 'id' not in req: continue
    result = {} if req['method'] == 'initialize' else {'content': [{'type': 'text', 'text': json.dumps(req['params'])}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': result}), flush=True)
''')
        bridge = McpBridge((sys.executable, str(fixture)), socket_endpoint=None)
        try:
            replies = await asyncio.gather(bridge.call("get_scene_info", {"user_prompt": "private"}),
                                            bridge.call("get_object_info", {"object_name": "Cube"}))
            self.assertEqual(json.loads(replies[0]["content"][0]["text"])["arguments"]["user_prompt"], "")
            self.assertEqual(json.loads(replies[1]["content"][0]["text"])["name"], "get_object_info")
            process = bridge.process
            self.assertIsNotNone(process)
        finally:
            await bridge.stop()
        self.assertIsNotNone(process.returncode)

    async def test_cancelled_stdio_call_stops_process_without_replay(self):
        fixture = self.root / "hanging_mcp.py"
        fixture.write_text('''import json, sys, time
for line in sys.stdin:
    req = json.loads(line)
    if 'id' not in req: continue
    if req['method'] == 'tools/call' and req['params']['name'] == 'execute_blender_code': time.sleep(100)
    print(json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': {'content': []}}), flush=True)
''')
        bridge = McpBridge((sys.executable, str(fixture)), socket_endpoint=None)
        try:
            await bridge.call("get_scene_info", {})
            process = bridge.process
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(bridge.call("execute_blender_code", {}), timeout=0.05)
            self.assertIsNone(bridge.process)
            self.assertIsNotNone(process.returncode)
        finally:
            await bridge.stop()
