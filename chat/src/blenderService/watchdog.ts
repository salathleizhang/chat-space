import { issueIdentity } from "./auth";
import { cloudBudget } from "../models/blenderCloud";
// Invoke from an independent supervisor/timer. This process exits after one external tick.
const secret = process.env.BLENDER_SERVICE_SECRET;
if (!secret || secret.length < 32) throw new Error("Missing watchdog service secret");
const token = issueIdentity({ owner: "__watchdog", scope: "api", expires: Date.now() + 30_000 }, secret);
const response = await cloudBudget(signal => fetch(`http://127.0.0.1:${Number(process.env.BLENDER_SERVICE_PORT ?? 3907)}/internal/tick`, {
  method: "POST", headers: { Authorization: `Bearer ${token}` }, signal,
}), 10_000);
if (!response.ok) throw new Error(`Blender watchdog HTTP ${response.status}`);
await response.body?.cancel();
const gatewayResponse = await cloudBudget(signal => fetch(`http://127.0.0.1:${Number(process.env.BLENDER_GATEWAY_PORT ?? 3908)}/internal/tick`, {
  method: "POST", headers: { Authorization: `Bearer ${secret}` }, signal,
}), 10_000);
if (!gatewayResponse.ok) throw new Error(`Blender gateway watchdog HTTP ${gatewayResponse.status}`);
await gatewayResponse.body?.cancel();
