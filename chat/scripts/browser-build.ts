import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
const browser = join(root, "app/src/browser");
const aliases: Record<string, string> = {
  "@mastra/core/tools": "toolCompat.ts", "@mastra/core/di": "toolCompat.ts", "@mastra/core/agent": "agentCompat.ts",
};
const result = await Bun.build({
  entrypoints: [join(browser, "worker.ts")], outdir: join(root, "app/public"),
  naming: "local-runtime.js", target: "browser", minify: true, env: "disable",
  plugins: [{ name: "browser-local-runtime", setup(build) {
    build.onResolve({ filter: /^node:/ }, () => ({ path: join(browser, "nodeCompat.ts") }));
    build.onResolve({ filter: /^@mastra\/core\/(tools|di|agent)$/ }, args => ({ path: join(browser, aliases[args.path]!) }));
    build.onResolve({ filter: /config$/ }, args => args.importer.includes("/chat/src/") ? { path: join(browser, "config.ts") } : undefined);
    build.onResolve({ filter: /services\/uploads$/ }, () => ({ path: join(browser, "uploads.ts") }));
    build.onLoad({ filter: /\/chat\/src\/.*\.ts$/ }, async args => {
      let contents = await Bun.file(args.path).text();
      contents = contents.replace(/import \{ NodeIO([, }])/g, "import { WebIO as NodeIO$1");
      return { contents, loader: "ts" };
    });
  }}],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`Browser local runtime: ${result.outputs[0]?.size} bytes`);
