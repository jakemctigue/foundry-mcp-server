import { defineConfig } from "vitest/config";

const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    environment: "node",
    // These suites launch real adapter/daemon child processes and compete for
    // the runner event loop when Vitest executes files concurrently.
    fileParallelism: false,
    testTimeout: isWindows ? 60_000 : 20_000,
    include: ["test/**/*.test.ts", "test-e2e/**/*.test.ts"],
  },
});
