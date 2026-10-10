import { createDesktopGateway } from "./desktopGateway";
const secret = process.env.BLENDER_SERVICE_SECRET, origin = process.env.BLENDER_DESKTOP_ORIGIN;
if (!secret || secret.length < 32 || !origin) throw new Error("Missing desktop gateway configuration");
const frames = (process.env.BLENDER_WEB_ORIGINS ?? "https://www.junwei.cool,https://chat-space-app.vercel.app").split(",");
for (const frame of frames) { const url = new URL(frame); if (url.origin !== frame || url.protocol !== "https:") throw new Error("Invalid frame origin"); }
const server = createDesktopGateway({ secret, origin, frames, api: `http://127.0.0.1:${Number(process.env.BLENDER_SERVICE_PORT ?? 3907)}` });
server.listen(Number(process.env.BLENDER_GATEWAY_PORT ?? 3908), "127.0.0.1");
process.once("SIGTERM", () => { server.shutdownSockets(); server.closeAllConnections(); server.close(() => process.exit(0)); });
console.log("Blender desktop gateway started on loopback");
