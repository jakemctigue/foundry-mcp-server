import { defineConfig } from "vitest/config";

const isWindows = process.platform === "win32";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: !isWindows,
    testTimeout: isWindows ? 60_000 : 5_000,
  },
});
