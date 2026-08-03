import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-coding-agent/types": path.resolve(__dirname, "types/src")
    }
  },
  test: {
    include: ["src/**/*.test.ts", "types/**/*.test.ts"],
    environment: "node"
  }
});
