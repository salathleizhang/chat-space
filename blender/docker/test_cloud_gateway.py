"""Real HTTP/TLS/WebSocket regression tests; no Blender or GPU needed."""
import asyncio
import gzip
import ssl
import subprocess
import tempfile
import unittest
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from cloud_gateway import Settings, create_app


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.cert = Path(cls.temp.name) / "cert.pem"
        cls.key = Path(cls.temp.name) / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048",
                        "-days", "1", "-keyout", str(cls.key), "-out", str(cls.cert),
                        "-subj", "/CN=localhost"], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    async def asyncSetUp(self):
        self.requests = []
        self.ws_closed = asyncio.Event()

        async def desktop(request):
            self.requests.append(request)
            if request.path == "/websockify":
                ws = web.WebSocketResponse(protocols=("binary",))
                await ws.prepare(request)
                try:
                    async for message in ws:
                        if message.type == aiohttp.WSMsgType.BINARY:
                            await ws.send_bytes(message.data)
                finally:
                    self.ws_closed.set()
                return ws
            if request.path == "/compressed":
                return web.Response(body=gzip.compress(b"desktop bytes"), headers={"Content-Encoding": "gzip"})
            return web.json_response({"path": request.path, "query": dict(request.query),
                                      "auth": request.headers.get("Authorization"),
                                      "routing": request.headers.get("x-faas-instance-name"),
                                      "body": (await request.read()).decode()})

        desktop_app = web.Application()
        desktop_app.router.add_route("*", "/{path:.*}", desktop)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(self.cert, self.key)
        self.desktop = TestServer(desktop_app, scheme="https")
        await self.desktop.start_server(ssl=tls)
        self.settings = Settings("OnlyForTests_20261009!", self.cert, str(self.desktop.make_url("")))
        self.client = TestClient(TestServer(create_app(self.settings)), auto_decompress=False)
        await self.client.start_server()
        self.auth = {"Authorization": self.settings.authorization}

    async def asyncTearDown(self):
        await self.client.close()
        await self.desktop.close()

    async def test_all_http_paths_require_authentication(self):
        for path in ("/", "/vnc.html", "/app.js", "/websockify"):
            response = await self.client.get(path)
            self.assertEqual(response.status, 401)
        response = await self.client.get("/", headers={"Authorization": "Basic invalid"})
        self.assertEqual(response.status, 401)
        self.assertEqual(self.requests, [])

    async def test_tls_and_instance_routing_and_body(self):
        response = await self.client.post("/vnc.html?resize=scale&faasInstanceName=instance-a",
                                          headers={**self.auth, "x-faas-instance-name": "instance-a"}, data="body")
        self.assertEqual(response.status, 200)
        data = await response.json()
        self.assertEqual(data["path"], "/vnc.html")
        self.assertEqual(data["query"], {"resize": "scale"})
        self.assertIsNone(data["routing"])
        self.assertEqual(data["auth"], self.settings.authorization)
        self.assertEqual(data["body"], "body")

    async def test_compressed_http_bytes_are_not_changed(self):
        response = await self.client.get("/compressed", headers=self.auth)
        body = await response.read()
        self.assertEqual(int(response.headers["Content-Length"]), len(body))
        self.assertEqual(gzip.decompress(body), b"desktop bytes")

    async def test_binary_websocket_roundtrip_and_cleanup(self):
        ws = await self.client.ws_connect("/websockify", headers={**self.auth, "Origin": "https://website.example"},
                                          protocols=("binary",))
        self.assertEqual(ws.protocol, "binary")
        await ws.send_bytes(b"\x00\xffRFB 003.008\n")
        response = await ws.receive(timeout=5)
        self.assertEqual(response.data, b"\x00\xffRFB 003.008\n")
        self.assertEqual(self.requests[-1].headers["Origin"], "https://website.example")
        await ws.close()
        await asyncio.wait_for(self.ws_closed.wait(), timeout=5)

    async def test_websocket_requires_authentication(self):
        with self.assertRaises(aiohttp.WSServerHandshakeError) as failure:
            await self.client.ws_connect("/websockify")
        self.assertEqual(failure.exception.status, 401)

    async def test_incorrect_certificate_pin_rejects_upstream(self):
        # A valid but unrelated certificate must fail, unlike ssl=False.
        wrong = Path(self.temp.name) / "wrong.pem"
        subprocess.run(["openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1",
                        "-keyout", str(Path(self.temp.name) / "wrong.key"), "-out", str(wrong),
                        "-subj", "/CN=unrelated"], check=True, capture_output=True)
        client = TestClient(TestServer(create_app(Settings(self.settings.password, wrong, self.settings.upstream))))
        async with client:
            response = await client.get("/", headers=self.auth)
            self.assertEqual(response.status, 502)
        self.assertEqual(self.requests, [])

    def test_default_and_shell_escape_passwords_are_rejected(self):
        for password in ("", "chatspace", "longpassword\\n0123456789", "longpassword\n0123456789"):
            with self.assertRaises(ValueError):
                Settings(password, self.cert)


if __name__ == "__main__":
    unittest.main()
