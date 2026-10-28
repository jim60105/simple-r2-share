import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Let the stylesheet tests import the real stylesheet text with `?raw`.
    css: { include: [/theme\.css/, /admin\.css/] },
  },
});
