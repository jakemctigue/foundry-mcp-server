import { defineConfig } from "vitest/config";

const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: !isWindows,
    testTimeout: isWindows ? 60_000 : 20_000,
    include: ["test/**/*.test.ts", "test-e2e/**/*.test.ts"],
  },
});
