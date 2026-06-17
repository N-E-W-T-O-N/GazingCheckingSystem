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
    },
    allowedHosts:["little-owls-decide.loca.lt"]
  },
  define: {
    __API_URL__: JSON.stringify(process.env.VITE_API_URL || ""),
  }
});
