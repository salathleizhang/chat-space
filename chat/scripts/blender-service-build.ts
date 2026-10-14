import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
for (const [name, target] of [["server", "bun"], ["gatewayServer", "node"], ["watchdog", "bun"]] as const) {
  const result = await Bun.build({ entrypoints: [resolve(root, `chat/src/blenderService/${name}.ts`)], target, format: "esm", env: "disable",
    outdir: resolve(root, "chat/dist/blender-service"), naming: `${name}.mjs` });
  if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
  console.log(`Built Blender ${name} for ${target}`);
}
