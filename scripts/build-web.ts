/**
 * Optional static build for hosting the UI outside the Bun server.
 *
 * The server normally bundles `web/main.ts` in memory, so this is only needed
 * for packaging or for serving the UI from a separate static host.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist", "web");
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "web", "main.ts")],
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "external",
});

if (!result.success) {
  console.error("Web build failed:");
  for (const log of result.logs) console.error(String(log));
  process.exit(1);
}

const output = result.outputs.find((artifact) => artifact.path.endsWith(".js"));
if (!output) {
  console.error("Web build produced no JavaScript.");
  process.exit(1);
}

fs.writeFileSync(path.join(outdir, "app.js"), await output.text());
for (const file of ["index.html", "styles.css", "favicon.svg"]) {
  fs.copyFileSync(path.join(root, "web", file), path.join(outdir, file));
}

console.log(`Built ${outdir}`);
