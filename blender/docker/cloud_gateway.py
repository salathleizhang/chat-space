"""HTTP entry for Volcano FaaS; the existing KasmVNC desktop remains HTTPS.

The raw Blender command socket is not exposed. Optional MCP HTTP control requires
a separate backend Bearer token; desktop Basic credentials cannot authorize it.
External TLS terminates at the cloud gateway; local TLS pins Kasm's certificate.
"""
import asyncio
import base64
import hashlib
import hmac
import os
import re
import ssl
from dataclasses import dataclass
from pathlib import Path

import aiohttp
from aiohttp import web
from multidict import CIMultiDict
from cloud_control import install_control


HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade"}


@dataclass(frozen=True)
class Settings:
    password: str
    certificate: Path
    upstream: str = "https://127.0.0.1:6901"
    control_token: str = ""

    def __post_init__(self):
        # Kasm's shell startup uses echo -e: avoid escapes, newline and whitespace.
        if not re.fullmatch(r"[A-Za-z0-9_!@#%+=.,:-]{20,72}", self.password):
            raise ValueError("VNC_PW must contain 20–72 ASCII letters, digits or _!@#%+=.,:-")
        if self.control_token and self.control_token == self.password:
            raise ValueError("Desktop password and control token must be different")
        if self.control_token and not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", self.control_token):
            raise ValueError("BLENDER_CONTROL_TOKEN must be 32–128 ASCII letters, digits, _ or -")

    @property
    def authorization(self):
        return "Basic " + base64.b64encode(f"kasm_user:{self.password}".encode()).decode()

    @property
    def viewer_authorization(self):
        # The pinned Kasm startup creates kasm_viewer with read permission only.
        return "Basic " + base64.b64encode(f"kasm_viewer:{self.password}".encode()).decode()

    def fingerprint(self):
        pem = self.certificate.read_text()
        certificate = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", pem, re.S)
        if not certificate:
            raise ValueError("Kasm certificate is not ready")
        der = ssl.PEM_cert_to_DER_cert(certificate.group())
        return aiohttp.Fingerprint(hashlib.sha256(der).digest())


def clean_headers(headers):
    blocked = HOP_HEADERS | {part.strip().lower() for part in headers.get("Connection", "").split(",")}
    return CIMultiDict((key, value) for key, value in headers.items() if key.lower() not in blocked)


def create_app(settings: Settings):
    async def resources(app):
        # No upstream cookies are shared between desktop connections.
        app[SESSION] = aiohttp.ClientSession(
            cookie_jar=aiohttp.DummyCookieJar(), auto_decompress=False,
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=60),
        )
        yield
        await app[SESSION].close()

    async def forward(source, destination):
        async for message in source:
            if message.type == aiohttp.WSMsgType.BINARY:
                await destination.send_bytes(message.data)
            elif message.type == aiohttp.WSMsgType.TEXT:
                await destination.send_str(message.data)
            elif message.type == aiohttp.WSMsgType.ERROR:
                break

    async def proxy(request):
        supplied = request.headers.get("Authorization", "").encode()
        if not (hmac.compare_digest(supplied, settings.authorization.encode()) or
                hmac.compare_digest(supplied, settings.viewer_authorization.encode())):
            raise web.HTTPUnauthorized(headers={"WWW-Authenticate": 'Basic realm="ChatSpace Blender"'})
        if request.method not in {"GET", "HEAD", "POST"}:
            raise web.HTTPMethodNotAllowed(request.method, ["GET", "HEAD", "POST"])
        # Preserve escaped path/query, remove only Volcano's routing parameter.
        path = request.rel_url.with_query([
            (key, value) for key, value in request.query.items() if key != "faasInstanceName"
        ])
        target = settings.upstream + str(path)
        headers = clean_headers(request.headers)
        for key in list(headers):
            if key.lower() in {"host", "x-faas-instance-name", "x-faas-proxy-port"}:
                del headers[key]
        try:
            pin = settings.fingerprint() if settings.upstream.startswith("https:") else True
            session = request.app[SESSION]
            downstream = web.WebSocketResponse(protocols=("binary",), compress=False,
                                               max_msg_size=16 * 1024 * 1024, heartbeat=30)
            if downstream.can_prepare(request).ok:
                if request.path != "/websockify":
                    raise web.HTTPNotFound()
                # aiohttp generates fresh handshake headers for the upstream.
                for key in list(headers):
                    if key.lower().startswith("sec-websocket-"):
                        del headers[key]
                async with session.ws_connect(
                    target, headers=headers, ssl=pin, protocols=("binary",),
                    compress=0, max_msg_size=16 * 1024 * 1024, heartbeat=30,
                    timeout=aiohttp.ClientWSTimeout(ws_receive=None, ws_close=10),
                ) as upstream:
                    await downstream.prepare(request)
                    tasks = [asyncio.create_task(forward(downstream, upstream)),
                             asyncio.create_task(forward(upstream, downstream))]
                    try:
                        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        for task in tasks:
                            task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
                        await downstream.close()
                return downstream
            async with session.request(
                request.method, target, headers=headers, ssl=pin, allow_redirects=False,
                data=await request.read() if request.can_read_body else None,
            ) as upstream:
                response = web.StreamResponse(status=upstream.status, headers=clean_headers(upstream.headers))
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(64 * 1024):
                    await response.write(chunk)
                await response.write_eof()
                return response
        except (FileNotFoundError, ValueError):
            raise web.HTTPServiceUnavailable(text="Desktop is starting") from None
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError):
            raise web.HTTPBadGateway(text="Desktop connection unavailable") from None

    app = web.Application(client_max_size=16 * 1024 * 1024)
    app.cleanup_ctx.append(resources)
    install_control(app, settings.control_token)
    app.router.add_route("*", "/{path:.*}", proxy)
    return app


SESSION = web.AppKey("desktop_client", aiohttp.ClientSession)


if __name__ == "__main__":
    config = Settings(os.environ.get("VNC_PW", ""), Path(os.environ["HOME"]) / ".vnc/self.pem",
                      control_token=os.environ.get("BLENDER_CONTROL_TOKEN", ""))
    web.run_app(create_app(config), host="0.0.0.0", port=8080, access_log=None)
