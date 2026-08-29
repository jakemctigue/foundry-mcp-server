import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 80,
        branches: 75,
      },
    },
  },
});
