import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["lib/**/*.ts"],
      exclude: ["**/*.test.*", "**/*.d.ts"],
    },
  },
});
