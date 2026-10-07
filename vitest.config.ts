import { defineConfig } from "vitest/config";

// Wire conformance tests run when PCN_CONFORMANCE_TARGET names a target module. See conformance/README.md.
export default defineConfig({
  test: {
    include: ["conformance/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
