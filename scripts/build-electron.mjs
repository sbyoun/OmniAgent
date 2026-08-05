// Bundles the Electron main and preload entry points. node-pty stays external
// so its native binding is loaded from node_modules at runtime.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron", "node-pty"],
  logLevel: "info",
};

await build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" });
await build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" });
