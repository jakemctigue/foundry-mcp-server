import { defineConfig } from "vitest/config";

const platformCoverageExcludes =
  process.platform === "win32" ? [] : ["src/bridge/windows-pipe-broker.ts"];

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      exclude: platformCoverageExcludes,
      thresholds: {
        lines: 80,
        branches: 75,
      },
    },
  },
});
