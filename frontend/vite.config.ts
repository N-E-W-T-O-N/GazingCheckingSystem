import { defineConfig } from "vite";

// We proxy /ingest and /sessions and /live to the FastAPI backend so the SPA
// can be served at http://localhost:5173 in dev without CORS gymnastics.
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
});
