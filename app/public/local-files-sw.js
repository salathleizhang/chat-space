/* Local asset URLs retain their directory structure for GLTF/OBJ auxiliary files. */
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("chatspace-local-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath: "path" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", glb: "model/gltf-binary", gltf: "model/gltf+json", obj: "text/plain", mtl: "text/plain", json: "application/json", hdr: "application/octet-stream", spz: "application/octet-stream" };
async function localFile(request) {
  let path;
  try { path = decodeURIComponent(new URL(request.url).pathname.slice("/api/library/".length)); } catch { return new Response(null, { status: 400 }); }
  if (!path || path.startsWith("/") || path.split("/").some(part => part === ".." || part === ".") || path.includes("\\")) return new Response(null, { status: 400 });
  const db = await database();
  const entry = await new Promise((resolve, reject) => {
    const query = db.transaction("files", "readonly").objectStore("files").get(path);
    query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error);
  });
  db.close();
  if (!entry) return new Response("Local file not found", { status: 404 });
  const blob = typeof entry.value === "string" ? new Blob([entry.value]) : entry.value;
  const headers = { "Content-Type": mime[path.split(".").pop().toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
    const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), blob.size - 1) : blob.size - 1;
    if (start > end || start >= blob.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
    return new Response(request.method === "HEAD" ? null : blob.slice(start, end + 1).stream(), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${blob.size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(request.method === "HEAD" ? null : blob.stream(), { headers: { ...headers, "Content-Length": String(blob.size) } });
}
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/library/") && ["GET", "HEAD"].includes(event.request.method)) {
    event.respondWith(localFile(event.request).catch(() => new Response("Local storage unavailable", { status: 503 })));
  }
});
