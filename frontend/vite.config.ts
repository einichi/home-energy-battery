import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.VITE_API_PORT ?? 8797);

export default defineConfig({
  root: import.meta.dirname,
  base: "/ui/",
  plugins: [react()],
  build: {
    outDir: "../public/ui",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
});
