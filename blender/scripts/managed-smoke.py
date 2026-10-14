"""Real customized Blender + durable executor. Only creates/removes its own test container."""
import hashlib
import json
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import uuid

name = "chatspace-managed-smoke-" + uuid.uuid4().hex[:8]
session = str(uuid.uuid4())
token = secrets.token_hex(32)
desktop = secrets.token_hex(24)
epoch = 1
image = "chatspace-blender:5.2.2-managed-20261011"


def docker(*args):
    return subprocess.check_output(["docker", *args], stderr=subprocess.DEVNULL).decode().strip()


def request(method, path, data=None, raw=False):
    body = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(base + path, data=body, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/octet-stream" if isinstance(data, bytes) else "application/json",
        "x-chatspace-session": session, "x-chatspace-epoch": str(epoch)})
    with urllib.request.urlopen(req, timeout=190) as response:
        content = response.read()
        return content if raw else json.loads(content) if content else None


def operation(tool, arguments=None, duplicate=False):
    operation_id = str(uuid.uuid4())
    payload = {"operationId": operation_id, "sessionId": session, "epoch": epoch,
               "inputCheckpointId": None, "tool": tool, "arguments": arguments or {}}
    accepted = request("POST", "/control/managed/operations", payload)
    assert accepted["id"] == operation_id
    if duplicate:
        again = request("POST", "/control/managed/operations", payload)
        assert again["id"] == operation_id
    deadline = time.monotonic() + 190
    while time.monotonic() < deadline:
        receipt = request("GET", "/control/managed/operations/" + operation_id)
        if receipt["state"] in {"succeeded", "failed", "unknown"}:
            assert receipt["state"] == "succeeded", "Executor state: " + receipt["state"]
            return receipt["result"]
        time.sleep(0.25)
    raise RuntimeError("Operation exceeded smoke deadline")


try:
    docker("run", "-d", "--name", name, "--cpus", "2", "--memory", "4g", "--shm-size", "256m", "-p", "127.0.0.1::8080",
           "-e", "VNC_PW=" + desktop, "-e", "BLENDER_CONTROL_TOKEN=" + token,
           "-e", "CHATSPACE_MANAGED=1", "-e", "CHATSPACE_SESSION_ID=" + session, "-e", "CHATSPACE_LEASE_EPOCH=1", image)
    port = docker("port", name, "8080/tcp").split(":")[-1]
    base = "http://127.0.0.1:" + port
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            docker("exec", name, "python3", "-c", "import socket; s=socket.create_connection(('127.0.0.1',9877),1); s.close()")
            health = request("GET", "/control/managed/health")
            if health["epoch"] == 1 and health.get("ready") and health.get("protocolVersion") == 1:
                break
        except (subprocess.CalledProcessError, OSError, urllib.error.URLError):
            time.sleep(1)
    else:
        raise RuntimeError("Customized Blender did not become ready")
    print("customized-addon-ready", flush=True)
    try:
        request("POST", "/control/call", {"tool": "get_scene_info"})
        raise AssertionError("Legacy control was not fenced")
    except urllib.error.HTTPError as error:
        assert error.code == 403
    operation("get_addon_status")
    operation("execute_blender_code", {"code": "import bpy, json\nfor o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)\nbpy.ops.mesh.primitive_cube_add(size=2,location=(3,0,0))\nbpy.context.object.name='ManagedSmokeCube'\nprint(json.dumps({'objects':len(bpy.context.scene.objects)}))"}, duplicate=True)
    file_id = str(uuid.uuid4())
    operation("_checkpoint", {"fileId": file_id})
    scene = request("GET", "/control/managed/files/" + file_id, raw=True)
    assert scene[:7] == b"BLENDER" and len(scene) > 1000
    print(json.dumps({"checkpointBytes": len(scene), "sha256": hashlib.sha256(scene).hexdigest()}), flush=True)
    operation("execute_blender_code", {"code": "import bpy\nfor o in list(bpy.data.objects): bpy.data.objects.remove(o,do_unlink=True)\nprint('scene-cleared')"})
    operation("_restore", {"fileId": file_id})
    result = operation("get_scene_info")
    assert "ManagedSmokeCube" in json.dumps(result)
    operation("execute_blender_code", {"code": "import bpy,json\nprint(json.dumps({'cubeCount':sum(o.name=='ManagedSmokeCube' for o in bpy.context.scene.objects),'x':bpy.data.objects['ManagedSmokeCube'].location.x}))"})
    export_id = str(uuid.uuid4())
    operation("export_scene", {"format": "glb", "filepath": "/workspace/.chatspace/exports/" + export_id + "/model.glb"})
    exported = request("GET", "/control/exports/" + export_id, raw=True)
    assert exported[:4] == b"glTF" and len(exported) > 1000
    with urllib.request.urlopen(urllib.request.Request(base + "/", headers={"Authorization": "Basic " + __import__('base64').b64encode(("kasm_viewer:" + desktop).encode()).decode()}), timeout=15) as response:
        assert response.status == 200
    request("POST", "/control/managed/lease/advance", {"epoch": 2})
    try:
        request("GET", "/control/managed/health")
        raise AssertionError("Old epoch retained access")
    except urllib.error.HTTPError as error:
        assert error.code == 409
    epoch = 2
    docker("restart", name)
    # Docker can assign a new ephemeral host port when restarting this fixture.
    port = docker("port", name, "8080/tcp").split(":")[-1]
    base = "http://127.0.0.1:" + port
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            docker("exec", name, "python3", "-c", "import socket; s=socket.create_connection(('127.0.0.1',9877),1); s.close()")
            health = request("GET", "/control/managed/health")
            if health["epoch"] == 2 and health.get("ready"):
                break
        except (subprocess.CalledProcessError, OSError, urllib.error.URLError):
            time.sleep(1)
    else:
        raise RuntimeError("Restart did not retain fenced lease")
    operation("_restore", {"fileId": file_id})
    assert "ManagedSmokeCube" in json.dumps(operation("get_scene_info"))
    print("real-blend-export-viewer-restart-epoch-and-idempotency-passed", flush=True)
finally:
    subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
