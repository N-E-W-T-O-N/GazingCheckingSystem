import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/ingest": "http://localhost:8000",
      "/sessions": "http://localhost:8000",
      "/live": {
        target: "ws://localhost:8000",
        ws: true,
      },
      // /stream has both an HTTP endpoint (/info) and the WS pump; one entry
      // with ws:true over an http target proxies both.
      "/stream": {
        target: "http://localhost:8000",
        ws: true,
      },
    },
    allowedHosts:["little-owls-decide.loca.lt"]
  },
  define: {
    __API_URL__: JSON.stringify(process.env.VITE_API_URL || ""),
  }
});
