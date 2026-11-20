import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy mirrors the hub API so the UI can run with `npm run dev` in web/.
// WEB_DEV_HUB and WEB_DEV_PORT point a second dev server at a separate preview hub.
const hub = process.env.WEB_DEV_HUB ?? "http://127.0.0.1:8791";
const port = Number(process.env.WEB_DEV_PORT ?? 5195);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: {
      "/v1": { target: hub, changeOrigin: false, ws: true },
      "/healthz": { target: hub, changeOrigin: false },
      "/readyz": { target: hub, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
});
