import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: the tests need none of the app's plugins.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Spawning the MCP server through tsx is slow on Windows runners.
    testTimeout: 30_000,
  },
});
