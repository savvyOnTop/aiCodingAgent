import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(__dirname, "src/frontend"),
  plugins: [react()],
  resolve: {
    alias: {
      "@ai-coding-agent/types": path.resolve(__dirname, "types/src")
    }
  },
  build: {
    outDir: path.resolve(__dirname, "dist/web"),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true
      }
    }
  }
});
