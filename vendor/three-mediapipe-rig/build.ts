import { dirname, relative, resolve } from "node:path";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";

const base = import.meta.dir;
const fflate = resolve(base, "dependencies/fflate-0.8.2/src");
const result = await Bun.build({
  entrypoints: [resolve(base, "runtime/library.ts"), resolve(base, "runtime/editor.ts"), resolve(base, "runtime/src/meshcap/meshcap.ts")],
  outdir: resolve(base, "compiled"),
  naming: "[name].js",
  target: "browser",
  format: "esm",
  external: ["three", "three/*", "@mediapipe/tasks-vision"],
  plugins: [{
    name: "fflate-browser-peer",
    setup(build) {
      build.onResolve({ filter: /^fflate$/ }, () => ({ path: resolve(fflate, "index.ts") }));
      // The same browser worker substitution as fflate's official build.
      build.onResolve({ filter: /^\.\/node-worker$/ }, ({ importer }) => importer === resolve(fflate, "index.ts")
        ? { path: resolve(fflate, "worker.ts") } : undefined);
    },
  }],
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
const types = Bun.spawn([process.execPath, resolve(base, "../../app/node_modules/typescript/bin/tsc"), "-p", resolve(base, "tsconfig.types.json")], { stdout: "inherit", stderr: "inherit" });
if (await types.exited !== 0) process.exit(1);
// This repository installs renderer/types in app/node_modules. Keep the
// generated declarations resolving the same pinned peers as the host app.
for await (const path of new Bun.Glob("**/*.d.ts").scan(resolve(base, "compiled"))) {
  const file = resolve(base, "compiled", path);
  const source = await readFile(file, "utf8");
  const declared = source.replace(/from "(three(?:\/[^\"]*)?|@mediapipe\/tasks-vision)"/g, (_match, name: string) => {
    const peer = name.startsWith("three")
      ? resolve(base, "../../app/node_modules/@types/three", name === "three" ? "index.js"
        : name === "three/webgpu" ? "build/three.webgpu.js"
        : name === "three/tsl" ? "build/three.tsl.js" : name.slice(6))
      : resolve(base, "../../app/node_modules/@mediapipe/tasks-vision/vision");
    const path = relative(dirname(file), peer).replaceAll("\\", "/");
    return `from "${path.startsWith(".") ? path : `./${path}`}"`;
  });
  await writeFile(file, declared);
}
const modelDir = resolve(base, "../../app/public/models/three-mediapipe-rig");
await mkdir(modelDir, { recursive: true });
await copyFile(resolve(base, "upstream/public/hands.glb"), resolve(modelDir, "hands.glb"));
await copyFile(resolve(base, "LICENSE"), resolve(modelDir, "LICENSE"));
console.log("Built complete three-mediapipe-rig API, hand integration and meshcap; copied upstream hands.glb.");
