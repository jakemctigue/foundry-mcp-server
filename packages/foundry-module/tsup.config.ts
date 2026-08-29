import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { "foundry-mcp": "src/module-entry.ts" },
    outDir: "dist/module",
    format: ["esm"],
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
    noExternal: ["@foundry-mcp/protocol"],
  },
]);
