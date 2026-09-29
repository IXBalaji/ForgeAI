import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "web/lib/**/*.test.ts"],
    exclude: ["src/scan/tests/**"],
  },
});
