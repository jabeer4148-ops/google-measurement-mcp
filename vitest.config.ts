import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Contract tests only by default. The smoke suite hits real Google APIs and
    // is opt-in via GMCP_SMOKE=1 so CI and contributors never touch live data.
    include: ["test/contract/**/*.test.ts"],
    environment: "node",
    // Stubs are installed by mutating the shared `google` object, so tests must
    // not run concurrently within a file's lifecycle.
    fileParallelism: false,
    reporters: ["default"],
  },
});
