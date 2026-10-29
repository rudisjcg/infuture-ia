import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // three.js (~540 kB min) gets its own long-cacheable vendor chunk, loaded only with the lazy office view.
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          if (path.includes("/node_modules/three/")) return "vendor-three";
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path)) return "vendor-react";
          if (/\/node_modules\/(i18next|i18next-browser-languagedetector|react-i18next)\//.test(path)) {
            return "vendor-i18n";
          }
          return undefined;
        },
      },
    },
    // three.js core (WebGLRenderer + shaders) is ~540 kB minified even fully tree-shaken and cannot be
    // split further; it is lazy-loaded with the office view and cached separately, so the default
    // 500 kB warning is raised just above it rather than silenced globally.
    chunkSizeWarningLimit: 560,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        ws: true,
      },
      "/health": apiTarget,
    },
  },
});
