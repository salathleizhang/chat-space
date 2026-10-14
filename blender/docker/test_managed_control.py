import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from managed_control import Receipts, install_managed

SESSION = "00000000-0000-4000-8000-000000000001"
OP = "00000000-0000-4000-8000-000000000002"
FILE = "00000000-0000-4000-8000-000000000003"


class Bridge:
    def __init__(self):
        self.calls = []
        self.ready = asyncio.Event()

    async def call(self, tool, args):
        self.calls.append((tool, args))
        await self.ready.wait()
        return {"content": [{"type": "text", "text": "ok"}]}


class ManagedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.bridge = Bridge()
        app = web.Application(client_max_size=256 * 1024 * 1024)
        def authorize(request):
            if request.headers.get("Authorization") != "Bearer test":
                raise web.HTTPUnauthorized()
        install_managed(app, authorize, self.bridge, frozenset({"execute_blender_code", "get_scene_info"}), self.root, SESSION, 1)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.headers = {"Authorization": "Bearer test", "x-chatspace-session": SESSION, "x-chatspace-epoch": "1"}

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    def payload(self):
        return {"operationId": OP, "sessionId": SESSION, "epoch": 1, "inputCheckpointId": None,
                "tool": "execute_blender_code", "arguments": {"code": "print(1)"}}

    async def test_accept_is_immediate_and_duplicates_execute_once_after_disconnect(self):
        payload = self.payload()
        self.assertEqual((await self.client.post("/control/managed/operations", headers=self.headers, json=payload)).status, 202)
        self.assertEqual((await self.client.post("/control/managed/operations", headers=self.headers, json=payload)).status, 202)
        # HTTP submit has returned while execution is still waiting.
        status = await self.client.get("/control/managed/operations/" + OP, headers=self.headers)
        self.assertEqual((await status.json())["state"], "running")
        self.bridge.ready.set()
        for _ in range(100):
            await asyncio.sleep(0)
            status = await self.client.get("/control/managed/operations/" + OP, headers=self.headers)
            if (await status.json())["state"] == "succeeded":
                break
        self.assertEqual(len(self.bridge.calls), 1)
        duplicate = await self.client.post("/control/managed/operations", headers=self.headers, json=payload)
        self.assertEqual((await duplicate.json())["state"], "succeeded")

    async def test_stale_lease_and_changed_id_are_rejected(self):
        data = self.payload(); data["epoch"] = 0
        self.assertEqual((await self.client.post("/control/managed/operations", headers=self.headers, json=data)).status, 409)
        data = self.payload()
        await self.client.post("/control/managed/operations", headers=self.headers, json=data)
        data["arguments"] = {"code": "print(2)"}
        self.assertEqual((await self.client.post("/control/managed/operations", headers=self.headers, json=data)).status, 409)
        bad = {**self.headers, "x-chatspace-epoch": "nonsense"}
        self.assertEqual((await self.client.get("/control/managed/operations/" + OP, headers=bad)).status, 400)

    async def test_restart_does_not_replay_started_command(self):
        path = self.root / "other.sqlite"
        first = Receipts(path, SESSION, 1)
        first.accept(self.payload()); first.claim(); first.db.close()
        next_run = Receipts(path, SESSION, 1)
        self.assertEqual(next_run.get(OP)["state"], "unknown")
        self.assertIsNone(next_run.claim())
        second = self.payload(); second["operationId"] = FILE
        with self.assertRaises(web.HTTPConflict):
            next_run.accept(second)
        next_run.db.close()

    async def test_restore_transfer_is_immutable_fenced_and_rejects_symlink(self):
        url = "/control/managed/files/" + FILE
        self.assertEqual((await self.client.put(url, headers=self.headers, data=b"invalid")).status, 400)
        self.assertEqual((await self.client.get(url, headers=self.headers)).status, 404)
        value = b"BLENDER-valid-test"
        self.assertEqual((await self.client.put(url, headers=self.headers, data=value)).status, 201)
        self.assertEqual(await (await self.client.get(url, headers=self.headers)).read(), value)
        self.assertEqual((await self.client.put(url, headers=self.headers, data=value)).status, 409)
        bad = {**self.headers, "x-chatspace-epoch": "2"}
        self.assertEqual((await self.client.get(url, headers=bad)).status, 409)
        path = self.root / "files" / FILE / "scene.blend"
        path.unlink(); path.symlink_to(__file__)
        self.assertEqual((await self.client.get(url, headers=self.headers)).status, 403)

    async def test_health_requires_real_addon_and_does_not_probe_during_commands(self):
        self.bridge.ready.set()
        health = await (await self.client.get("/control/managed/health", headers=self.headers)).json()
        self.assertTrue(health["ready"])
        self.assertEqual(health["protocolVersion"], 1)
        self.assertEqual(self.bridge.calls[0][0], "get_addon_status")
        self.bridge.ready.clear()
        await self.client.post("/control/managed/operations", headers=self.headers, json=self.payload())
        calls = len(self.bridge.calls)
        health = await (await self.client.get("/control/managed/health", headers=self.headers)).json()
        self.assertFalse(health["ready"])
        self.assertEqual(len(self.bridge.calls), calls)


if __name__ == "__main__":
    unittest.main()
