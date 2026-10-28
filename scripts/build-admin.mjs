// Builds the admin page script (admin UI spec §10, plan task 8).
//
// 1. Bundles src/admin/main.ts into public/admin/app.js: one minified ES
//    module, no source map, no legal comments (they go to the file below).
// 2. Finds every node_modules package that ended up in the bundle (from the
//    esbuild metafile) and concatenates their licence files into
//    public/admin/THIRD_PARTY_LICENSES.txt, which app.js points to in its
//    first line. A bundled package without a licence file fails the build.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "admin");
const LICENSES_NAME = "THIRD_PARTY_LICENSES.txt";
const LICENSE_FILE = /^(?:LICEN[CS]E|COPYING)(?:\.(?:md|txt))?$/i;

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: ["src/admin/main.ts"],
  outfile: join(OUT_DIR, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  metafile: true,
  banner: { js: `/*! Third-party licenses: /admin/${LICENSES_NAME} */` },
  logLevel: "warning",
});

/** `node_modules/<name>` or `node_modules/@scope/<name>` directories of the bundled inputs. */
const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) packageDirs.add(input.slice(0, match.index + match[0].length - 1));
}

const sections = [];
for (const dir of [...packageDirs].sort()) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  const licenseFile = readdirSync(join(ROOT, dir)).find((name) => LICENSE_FILE.test(name));
  if (licenseFile === undefined) {
    throw new Error(`build-admin: ${manifest.name} is bundled into app.js but has no licence file in ${dir}`);
  }
  const text = readFileSync(join(ROOT, dir, licenseFile), "utf8").trim();
  sections.push(`${manifest.name}@${manifest.version} (${manifest.license ?? "see below"})\n\n${text}\n`);
}

writeFileSync(
  join(OUT_DIR, LICENSES_NAME),
  `Third-party software bundled into /admin/app.js\n\n${sections.join(`\n${"-".repeat(72)}\n\n`)}`,
);
const bytes = result.metafile.outputs["public/admin/app.js"]?.bytes ?? 0;
console.log(`build-admin: app.js ${bytes} bytes, ${packageDirs.size} bundled packages`);
