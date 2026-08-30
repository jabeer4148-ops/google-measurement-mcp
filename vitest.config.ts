import { defineConfig } from "vitest/config";

/**
 * Smoke tests hit real Google APIs and need credentials, so they are opt-in.
 *
 * The gate is the GMCP_SMOKE env var rather than a path exclusion, because a
 * plain exclusion would make `vitest run test/smoke` silently match zero files
 * and report success — a green run that tested nothing.
 */
const smokeEnabled = process.env["GMCP_SMOKE"] === "1";

export default defineConfig({
  test: {
    // Default: contract tests only. CI and contributors never touch live data.
    // Opt in with: GMCP_SMOKE=1 npx vitest run test/smoke
    include: smokeEnabled
      ? ["test/contract/**/*.test.ts", "test/smoke/**/*.test.ts"]
      : ["test/contract/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    environment: "node",
    // Stubs are installed by mutating the shared `google` object, so files must
    // not run in parallel.
    fileParallelism: false,
    reporters: ["default"],
  },
});
