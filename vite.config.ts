import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Serve (dev) / copy (build) pdf.js cMaps and standard fonts under /pdfjs/. */
function pdfjsAssets(): Plugin {
  const src = path.resolve("node_modules/pdfjs-dist");
  const dirs = ["cmaps", "standard_fonts"];
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]);
        const file = path.join(src, rel);
        if (!file.startsWith(src + path.sep) || !dirs.some((d) => rel.startsWith(`/${d}/`))) return next();
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const d of dirs) cpSync(path.join(src, d), path.resolve("dist/pdfjs", d), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787" } },
  },
});
