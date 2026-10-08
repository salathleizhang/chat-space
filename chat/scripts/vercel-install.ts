import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

// Vercel's function builder installs again after the frontend build. Keep both
// installs on the same layout, without changing normal local Bun installs.
if (process.env.VERCEL === "1" && root.startsWith("/vercel/")) {
  await Bun.write(join(root, "bunfig.toml"), '[install]\nlinker = "hoisted"\n');
}

const install = Bun.spawn(
  [process.execPath, "install", "--frozen-lockfile", "--linker", "hoisted"],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exit(await install.exited);
