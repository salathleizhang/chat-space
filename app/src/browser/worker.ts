import "./bootstrap";
import { tickTaskPumps } from "../../../chat/src/common/taskPump";
import { createApp } from "../../../chat/src/app";
import { withAssetStorage } from "../../../chat/src/services/assetStorage";
import { withCloudContext } from "../../../chat/src/cloud/context";
import { BrowserAssetStorage } from "./storage";
import { browserContext, runBrowserJob } from "./jobs";
import { configureCapabilities } from "./config";
import { installProviderProxy } from "./network";
import { setBlenderExportImporter } from "../../../chat/src/mastra/tools/blenderService";
import { importCloudBlenderExports } from "./blenderImports";
setBlenderExportImporter(importCloudBlenderExports);
installProviderProxy();
const scope = globalThis as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (message: unknown, transfers?: Transferable[]) => void };
scope.onmessage = async event => {
  if (event.data.tick) { tickTaskPumps(); return; }
  const { path, method, body, job, port } = event.data as { path: string; method: string; body?: string; job?: string; port: MessagePort };
  try {
    if (job || path.startsWith("/api/chat/") || path.startsWith("/api/tasks") && method === "POST") {
      const capabilities = await fetch(location.origin + "/api/capabilities").then(response => response.json());
      configureCapabilities(capabilities);
    }
    if (job) { await runBrowserJob(job); port.postMessage({ done: true }); return; }
    const storage = new BrowserAssetStorage();
    const context = browserContext(storage);
    storage.onSidecar = context.onSidecar;
    const response = await withAssetStorage(storage, () => withCloudContext(context, () => createApp().fetch(new Request(location.origin + path, {
      method, ...(body ? { headers: { "Content-Type": "application/json" }, body } : {}),
    }))));
    port.postMessage({ status: response.status, headers: [...response.headers] });
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; port.postMessage({ chunk: chunk.value }, [chunk.value.buffer]); }
    }
    await Promise.all(context.pending);
    if (body) {
      const findUploads = (value: unknown): string[] => value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, item]) => key === "localPath" && typeof item === "string" && item.startsWith(".uploads/") ? [item] : findUploads(item)) : [];
      await Promise.all(findUploads(JSON.parse(body)).map(path => storage.remove(path)));
    }
    port.postMessage({ done: true });
  } catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
