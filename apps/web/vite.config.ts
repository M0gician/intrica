import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { buildMetadata } from "../../scripts/build-metadata.mjs";

// e2e 用专用 API 端口（INTRICA_API_PORT 环境变量注入）；开发默认 3001
const apiPort = process.env.INTRICA_API_PORT ?? "3001";

export default defineConfig({
  define: {
    "import.meta.env.VITE_INTRICA_BUILD": JSON.stringify(
      buildMetadata(new URL("../desktop/package.json", import.meta.url)),
    ),
  },
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (outgoing, request) => {
            if (request.headers.origin === `http://${request.headers.host}`)
              outgoing.setHeader("Origin", `http://127.0.0.1:${apiPort}`);
          });
        },
      },
    },
  },
});
