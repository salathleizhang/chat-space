import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
if (process.env.VERCEL !== "1" || !root.startsWith("/vercel/")) {
  throw new Error("Run this only in Vercel's disposable build checkout.");
}

const result = await Bun.build({
  entrypoints: [join(root, "api/server.ts")],
  outdir: join(root, ".vercel-api-bundle"),
  target: "bun",
  env: "disable",
  splitting: false,
});
if (!result.success) throw new AggregateError(result.logs, "Cloud API bundling failed");

// Keep Vercel's discovered entrypoint filenames, but ship self-contained code
// instead of relying on the function tracer to recreate workspace symlinks.
for (const output of result.outputs) {
  if (output.kind !== "entry-point") continue;
  await Bun.write(join(root, "api", basename(output.path, ".js") + ".ts"), output);
}

// build:vercel checked the original source before this step. The generated JS
// has no TS annotations; let Vercel transpile it without checking inferred types.
const configFile = Bun.file(join(root, "tsconfig.json"));
const config = await configFile.json();
config.compilerOptions = { ...config.compilerOptions, noCheck: true };
await Bun.write(configFile, JSON.stringify(config, null, 2));
