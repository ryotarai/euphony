import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.EUPHONY_DEV_API_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    exclude: ["e2e/**", "node_modules/**"],
    globals: true,
    setupFiles: "./src/test/setup.ts",
  },
});
