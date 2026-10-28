// Prints the short share URL of a folder (rules editor spec §3), using the
// same src/short-url.ts as the admin page. Handy for local development, where
// the admin API always answers 403 because there is no Cloudflare Access.
//
//   npm run share-url -- releases/project-a
//   npm run share-url -- releases/project-a https://share.example.com
//
// The URL only works once the rules share that folder.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const [folder, origin = "http://localhost:8788"] = process.argv.slice(2);
if (!folder) {
  console.error("usage: npm run share-url -- <folder/path> [origin]");
  process.exit(2);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  absWorkingDir: ROOT,
  entryPoints: ["src/short-url.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "warning",
});
const source = Buffer.from(bundle.outputFiles[0].text).toString("base64");
const { encodeShareToken } = await import(`data:text/javascript;base64,${source}`);

try {
  const token = encodeShareToken(folder.replace(/^\/+|\/+$/g, "").split("/"));
  console.log(`${origin.replace(/\/+$/, "")}/s/${token}/`);
} catch (error) {
  console.error(`share-url: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
