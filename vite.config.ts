import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Subdomain (speed-rev-check.kevinlewis.net) serves from root, so base = "/".
// If you ever move it to a subpath (kevinlewis.net/Speed-Rev-Check/), set base to "/Speed-Rev-Check/".
export default defineConfig({
  base: "/",
  plugins: [react()],
});
