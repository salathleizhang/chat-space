import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      BLENDER_SERVICE_SECRET: "fixture-controller-secret-never-production-12345",
      VOLC_ACCESSKEY: "fixture-ak", VOLC_SECRETKEY: "fixture-sk",
      TOS_ACCESS_KEY: "fixture-ak", TOS_SECRET_KEY: "fixture-sk", VOLC_KEY: "fixture-model-key",
    } },
  })],
  test: { include: ["*.test.ts"], server: { deps: { inline: ["@volcengine/openapi", "@volcengine/tos-sdk"] } } },
});
