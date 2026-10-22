import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/e2e/global-setup.ts"],
    setupFiles: ["test/support/state-home.ts"],
  },
});
