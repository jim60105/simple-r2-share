// Builds public/fonts/ (UI spec §4, plan Task 7). Node built-ins only.
//
// 1. Downloads the pinned Jim Mono TC web zip (or reuses the cached copy in
//    node_modules/.cache/) and verifies its SHA-256; a mismatch fails the build.
// 2. Checks every entry name first, then cleans public/fonts/ and extracts
//    the zip's top-level folder into it unchanged: JimMonoTC.css (its URLs already point at /fonts/), the .woff2
//    slices and licenses/ (LICENSE, NOTICE.md, …). Every entry name is checked
//    against zip-slip (absolute paths, `..`, backslashes, escaping the target)
//    and only .css / .woff2 / licence text files are written.
// 3. Copies Chakra Petch latin 600 / 700 woff2 and its OFL text from the
//    exact-pinned @fontsource/chakra-petch package (verified by the
//    package-lock.json integrity hash on install).
// 4. Checks that every url() in JimMonoTC.css is a /fonts/ URL of a file that
//    exists, and that the files public/assets/theme.css references exist.
//
// Upgrading Jim Mono TC: change JIM_MONO_VERSION and JIM_MONO_SHA256.
// Behind an HTTP proxy that Node's fetch does not pick up on its own, run with
// NODE_USE_ENV_PROXY=1 (Node ≥ 22.21).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

const JIM_MONO_VERSION = "0.4.0";
const JIM_MONO_SHA256 = "02ff346787546379156b633aca181e0a6233c00b8980dbcbe9d387c39be89856";
const JIM_MONO_ASSET = `JimMonoTC-${JIM_MONO_VERSION}-web.zip`;
const JIM_MONO_URL = `https://github.com/jim60105/JimMonoTC/releases/download/v${JIM_MONO_VERSION}/${JIM_MONO_ASSET}`;
/** The folder every entry of the web zip lives in; its contents go to public/fonts/. */
const JIM_MONO_TOP = `JimMonoTC-${JIM_MONO_VERSION}-web/`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONTS_DIR = join(ROOT, "public", "fonts");
const THEME_CSS = join(ROOT, "public", "assets", "theme.css");
const CACHE_DIR = join(ROOT, "node_modules", ".cache", "simple-r2-share");
const CHAKRA_DIR = join(ROOT, "node_modules", "@fontsource", "chakra-petch");

/** Chakra Petch files: source in the fontsource package -> name in public/fonts/ (matches theme.css). */
const CHAKRA_FILES = [
  ["files/chakra-petch-latin-600-normal.woff2", "ChakraPetch-SemiBold.latin.woff2"],
  ["files/chakra-petch-latin-700-normal.woff2", "ChakraPetch-Bold.latin.woff2"],
  ["LICENSE", "licenses/ChakraPetch-OFL.txt"],
];

// Extraction allow-list, matched against the path below JIM_MONO_TOP.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED_FILES = [
  /^JimMonoTC\.css$/,
  /^JimMonoTC-[A-Za-z]+\.[a-z0-9-]+\.woff2$/,
  /^licenses\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:md|txt)$/,
  /^licenses\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*(?:LICENSE|LICENCE|OFL)[A-Za-z0-9._-]*$/,
];
// Upper bounds that keep a corrupt archive from exhausting memory or disk.
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

class BuildError extends Error {}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Returns the verified zip, from the cache when possible, otherwise downloaded. */
async function loadJimMonoZip() {
  const cached = join(CACHE_DIR, `${JIM_MONO_ASSET.replace(/\.zip$/, "")}-${JIM_MONO_SHA256}.zip`);
  if (existsSync(cached)) {
    const buffer = readFileSync(cached);
    if (sha256(buffer) === JIM_MONO_SHA256) {
      console.log(`build-fonts: using cached ${JIM_MONO_ASSET}`);
      return buffer;
    }
    rmSync(cached, { force: true });
  }

  console.log(`build-fonts: downloading ${JIM_MONO_URL}`);
  let response;
  try {
    response = await fetch(JIM_MONO_URL, { redirect: "follow" });
  } catch (error) {
    throw new BuildError(`download failed: ${error.cause?.message ?? error.message} (behind a proxy? try NODE_USE_ENV_PROXY=1)`);
  }
  if (!response.ok) throw new BuildError(`download failed: HTTP ${response.status} for ${JIM_MONO_URL}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = sha256(buffer);
  if (actual !== JIM_MONO_SHA256) {
    throw new BuildError(`SHA-256 mismatch for ${JIM_MONO_ASSET}\n  expected ${JIM_MONO_SHA256}\n  actual   ${actual}`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const temporary = `${cached}.${process.pid}.tmp`;
  writeFileSync(temporary, buffer);
  renameSync(temporary, cached);
  return buffer;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader: central directory, STORE and DEFLATE, no ZIP64, no
// encryption. Enough for the pinned release asset; anything else is an error.

function readCentralDirectory(zip) {
  const EOCD = 0x06054b50;
  const searchFrom = Math.max(0, zip.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = zip.length - 22; i >= searchFrom; i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BuildError("zip: end of central directory not found");
  const count = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  const offset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new BuildError("zip: ZIP64 is not supported");
  if (offset + size > eocd) throw new BuildError("zip: central directory out of bounds");

  const entries = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > offset + size || zip.readUInt32LE(p) !== 0x02014b50) throw new BuildError("zip: bad central directory entry");
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    entries.push({
      flags: zip.readUInt16LE(p + 8),
      method: zip.readUInt16LE(p + 10),
      crc: zip.readUInt32LE(p + 16),
      compressedSize: zip.readUInt32LE(p + 20),
      size: zip.readUInt32LE(p + 24),
      localOffset: zip.readUInt32LE(p + 42),
      // Raw bytes as latin1, so any non-ASCII byte survives and fails SAFE_SEGMENT.
      name: zip.toString("latin1", p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(zip, entry) {
  if (entry.flags & 0x1) throw new BuildError(`zip: ${entry.name}: encrypted entries are not supported`);
  if (entry.size > MAX_ENTRY_BYTES) throw new BuildError(`zip: ${entry.name}: ${entry.size} bytes is too large`);
  const p = entry.localOffset;
  if (p + 30 > zip.length || zip.readUInt32LE(p) !== 0x04034b50) throw new BuildError(`zip: ${entry.name}: bad local header`);
  const start = p + 30 + zip.readUInt16LE(p + 26) + zip.readUInt16LE(p + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new BuildError(`zip: ${entry.name}: data out of bounds`);
  const raw = zip.subarray(start, end);

  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
  else throw new BuildError(`zip: ${entry.name}: compression method ${entry.method} is not supported`);
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new BuildError(`zip: ${entry.name}: size or CRC mismatch`);
  return data;
}

/**
 * Maps a zip entry name to its path below JIM_MONO_TOP, or throws when the
 * name is unsafe (zip-slip). Returns null for directories.
 */
function safeRelativePath(name) {
  if (name.includes("\\") || name.includes("\0")) throw new BuildError(`zip: unsafe entry name ${JSON.stringify(name)}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new BuildError(`zip: absolute entry name ${JSON.stringify(name)}`);
  if (!name.startsWith(JIM_MONO_TOP)) throw new BuildError(`zip: entry outside ${JIM_MONO_TOP}: ${JSON.stringify(name)}`);
  const relative = name.slice(JIM_MONO_TOP.length);
  if (relative === "") return null;
  const isDirectory = relative.endsWith("/");
  const segments = (isDirectory ? relative.slice(0, -1) : relative).split("/");
  for (const segment of segments) {
    // Rejects "", ".", ".." and anything outside a conservative character set.
    if (!SAFE_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new BuildError(`zip: unsafe entry name ${JSON.stringify(name)}`);
    }
  }
  return isDirectory ? null : segments.join("/");
}

/** Resolves `relative` inside `base`, refusing anything that escapes it. */
function insideDir(base, relative) {
  const target = resolve(base, relative);
  if (!target.startsWith(base + sep)) throw new BuildError(`refusing to write outside ${base}: ${relative}`);
  return target;
}

/**
 * Validates every entry name before anything is written, so an unsafe archive
 * fails the build without touching public/fonts/. Returns the entries to write.
 */
function planJimMono(zip) {
  const plan = [];
  let skipped = 0;
  let total = 0;
  for (const entry of readCentralDirectory(zip)) {
    const relative = safeRelativePath(entry.name);
    if (relative === null) continue;
    if (!ALLOWED_FILES.some((pattern) => pattern.test(relative))) {
      console.warn(`build-fonts: skipping unexpected entry ${entry.name}`);
      skipped++;
      continue;
    }
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) throw new BuildError("zip: archive expands beyond the size limit");
    plan.push({ entry, target: insideDir(FONTS_DIR, relative) });
  }
  return { plan, skipped };
}

function extractJimMono(zip, { plan, skipped }) {
  for (const { entry, target } of plan) {
    mkdirSync(dirname(target), { recursive: true });
    // "wx": a duplicate entry name fails instead of silently overwriting.
    writeFileSync(target, readEntryData(zip, entry), { flag: "wx" });
  }
  console.log(`build-fonts: extracted ${plan.length} Jim Mono TC files${skipped ? `, skipped ${skipped}` : ""}`);
}

function copyChakraPetch() {
  if (!existsSync(CHAKRA_DIR)) throw new BuildError(`${CHAKRA_DIR} is missing; run npm ci first`);
  for (const [source, destination] of CHAKRA_FILES) {
    const target = insideDir(FONTS_DIR, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(CHAKRA_DIR, source), target);
  }
  console.log(`build-fonts: copied Chakra Petch ${CHAKRA_FILES.length} files`);
}

/** Every url() in `css` must be /fonts/<file> and that file must exist in public/fonts/. */
function checkFontUrls(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  const urls = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((match) => match[2]);
  for (const url of urls) {
    if (!url.startsWith("/fonts/")) throw new BuildError(`${cssPath}: url(${url}) is not a /fonts/ URL`);
    const file = insideDir(FONTS_DIR, url.slice("/fonts/".length));
    if (!existsSync(file) || !statSync(file).isFile()) throw new BuildError(`${cssPath}: url(${url}) does not exist in public/fonts/`);
  }
  return urls.length;
}

async function main() {
  const zip = await loadJimMonoZip();
  const plan = planJimMono(zip);
  rmSync(FONTS_DIR, { recursive: true, force: true });
  mkdirSync(FONTS_DIR, { recursive: true });
  extractJimMono(zip, plan);
  copyChakraPetch();

  for (const required of ["JimMonoTC.css", "licenses/LICENSE", "licenses/NOTICE.md"]) {
    if (!existsSync(join(FONTS_DIR, required))) throw new BuildError(`public/fonts/${required} is missing after extraction`);
  }
  const jimUrls = checkFontUrls(join(FONTS_DIR, "JimMonoTC.css"));
  const themeUrls = checkFontUrls(THEME_CSS);
  console.log(`build-fonts: ok, ${jimUrls} Jim Mono TC and ${themeUrls} Chakra Petch font URLs resolve in public/fonts/`);
}

try {
  await main();
} catch (error) {
  console.error(`build-fonts: error: ${error instanceof BuildError ? error.message : error.stack}`);
  process.exitCode = 1;
}
