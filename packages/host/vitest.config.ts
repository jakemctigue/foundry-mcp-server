import { defineConfig } from "vitest/config";

const isWindows = process.platform === "win32";
const platformCoverageExcludes = isWindows ? [] : ["src/bridge/windows-pipe-broker.ts"];

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: !isWindows,
    testTimeout: isWindows ? 60_000 : 15_000,
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
