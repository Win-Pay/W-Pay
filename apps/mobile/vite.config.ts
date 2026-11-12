import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: true,
    // Workspace packages are compiled to CommonJS for Node consumers; teach
    // Rollup to convert them (and their dependencies) to ESM for the browser.
    commonjsOptions: {
      include: [/node_modules/, /packages[\\/]/],
    },
  },
  optimizeDeps: {
    include: ["@wpay/sdk", "@wpay/shared", "@wpay/ui", "@wpay/hooks"],
  },
  server: {
    port: 5173,
  },
});
