import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // The packaged app loads index.html off disk, where an absolute `/assets/…`
  // would resolve against the filesystem root.
  base: "./",

  server: {
    port: 1420,
    strictPort: true,
  },
});
