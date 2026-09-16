import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

type ApiFetch = (request: Request) => Response | Promise<Response>;

/** Serve the built SPA and local API from one loopback process. */
export function createLocalFetch(apiFetch: ApiFetch, distDirectory: string): ApiFetch {
  const root = resolve(distDirectory);
  const indexFile = resolve(root, "index.html");

  return async (request) => {
    const pathname = new URL(request.url).pathname;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (decodedPath === "/api" || decodedPath.startsWith("/api/")) {
      return apiFetch(request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
      return new Response("Bad request", { status: 400 });
    }

    const filePath = resolve(root, `.${decodedPath}`);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      return new Response("Bad request", { status: 400 });
    }

    if (filePath !== root && await isFile(filePath)) {
      return fileResponse(request, filePath);
    }
    if (extname(decodedPath)) {
      return new Response("Not found", { status: 404 });
    }
    if (!await isFile(indexFile)) {
      return new Response("Front-end build missing. Run `bun run build` first.", { status: 503 });
    }
    return fileResponse(request, indexFile, true);
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function fileResponse(request: Request, path: string, isAppShell = false): Response {
  const headers = new Headers();
  if (isAppShell) headers.set("Cache-Control", "no-cache");
  if (request.method === "HEAD") {
    headers.set("Content-Type", Bun.file(path).type);
    return new Response(null, { headers });
  }
  return new Response(Bun.file(path), { headers });
}
