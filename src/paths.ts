/**
 * The single authority for share URLs, R2 key prefixes, public object URLs and
 * README relative links (spec §5). Every function here is pure.
 *
 * Segment rules shared by every untrusted input (share page URL, ZIP `dir`
 * parameter, README hrefs), applied to each segment AFTER it has been decoded
 * exactly once:
 * - not empty, not `.` and not `..`;
 * - no `/` or `\` (a decoded separator means `%2F` / `%5C` smuggling);
 * - no control characters. The spec only names the null byte; we also reject
 *   the rest of C0, DEL and C1 because no legitimate shared folder needs them
 *   and they make logs, headers and rendered names ambiguous;
 * - no `%XX` escape left over. Such a segment was double-encoded (`%252F`,
 *   `%252e%252e`) and a second decode somewhere else could turn it into a
 *   separator or a dot segment. The cost is that a directory whose real name
 *   contains a literal `%XX` sequence cannot be shared.
 */

const SHARE_PREFIX = "/share/";
const ZIP_ENDPOINT = "/api/share-zip";

// C0 controls (includes NUL), DEL and C1 controls.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const LEFTOVER_ESCAPE = /%[0-9a-f]{2}/i;
// Escapes that decode to a separator or NUL inside a single segment.
const FORBIDDEN_RAW_ESCAPE = /%(?:2f|5c|00)/i;
// RFC 3986 scheme, e.g. `https:`, `mailto:`, `javascript:`.
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Rules for one segment of an R2 object key (keys may contain a literal `%XX`). */
function isSafeKeySegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !CONTROL_CHARS.test(segment)
  );
}

/** Rules for one decoded segment that came from a URL or query parameter. */
function isSafeDecodedSegment(segment: string): boolean {
  return isSafeKeySegment(segment) && !LEFTOVER_ESCAPE.test(segment);
}

/** Checks on the still-encoded text, before any decoding happens. */
function hasForbiddenRaw(raw: string): boolean {
  return raw.includes("\\") || raw.includes("\0") || FORBIDDEN_RAW_ESCAPE.test(raw);
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding or invalid UTF-8
  }
}

/**
 * Parses a share page path such as `URL.pathname` (still percent-encoded),
 * e.g. `/share/releases/project-a/` -> `["releases", "project-a"]`.
 * Returns `null` for anything that is not a canonical share directory path,
 * including the bare `/share/` (the bucket root is never shareable) and paths
 * without the trailing `/`.
 *
 * Note: the WHATWG URL parser already resolves `.`, `..`, `%2e%2e` and `\`
 * before a Pages Function sees `URL.pathname`; those checks here are defence
 * in depth for callers that pass raw strings.
 */
export function parseSharePath(pathname: string): string[] | null {
  if (!pathname.startsWith(SHARE_PREFIX) || !pathname.endsWith("/")) return null;
  const raw = pathname.slice(SHARE_PREFIX.length, -1);
  if (raw === "" || hasForbiddenRaw(raw) || raw.includes("?") || raw.includes("#")) return null;

  const segments: string[] = [];
  for (const rawSegment of raw.split("/")) {
    const segment = decodeSegment(rawSegment);
    if (segment === null || !isSafeDecodedSegment(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

/**
 * Parses the ZIP endpoint's `dir` query value as returned by
 * `URLSearchParams.get("dir")` (already decoded once), e.g.
 * `releases/project-a` -> `["releases", "project-a"]`. The canonical form has
 * no leading or trailing `/`; anything else, including a missing parameter,
 * returns `null`. No further decoding is applied.
 */
export function parseZipDir(dir: string | null | undefined): string[] | null {
  if (!dir) return null;
  const segments = dir.split("/");
  return segments.every(isSafeDecodedSegment) ? segments : null;
}

function assertSegments(segments: readonly string[]): void {
  if (segments.length === 0 || !segments.every(isSafeDecodedSegment)) {
    throw new TypeError("paths: segments must come from parseSharePath or parseZipDir");
  }
}

/**
 * R2 list prefix for validated segments, always ending with `/`, e.g.
 * `releases/project-a/`. Throws `TypeError` if the segments are empty or
 * invalid, which is a programming error (spec §5: never list an unvalidated
 * prefix or the bucket root).
 */
export function toPrefix(segments: readonly string[]): string {
  assertSegments(segments);
  return `${segments.join("/")}/`;
}

/** Canonical share page path for validated segments, e.g. `/share/releases/%E5%B0%88%E6%A1%88/`. */
export function sharePagePath(segments: readonly string[]): string {
  assertSegments(segments);
  return `${SHARE_PREFIX}${segments.map(encodeURIComponent).join("/")}/`;
}

/** ZIP download path for validated segments, e.g. `/api/share-zip?dir=releases%2Fproject-a`. */
export function zipDownloadPath(segments: readonly string[]): string {
  assertSegments(segments);
  return `${ZIP_ENDPOINT}?dir=${encodeURIComponent(segments.join("/"))}`;
}

/**
 * Whether an R2 object key can be linked and listed safely: non-empty
 * segments, no `.` / `..` segments (a browser would resolve them in the public
 * URL), no backslash and no control characters. Directory marker keys ending
 * in `/` are not safe object keys. A literal `%XX` in a key is fine.
 */
export function isSafeKey(key: string): boolean {
  return key !== "" && key.split("/").every(isSafeKeySegment);
}

/**
 * Public R2 URL for an object key: each segment is encoded with
 * `encodeURIComponent` and appended to `publicBaseUrl` (no trailing slash, see
 * `AppConfig`). Returns `null` when the key is not `isSafeKey`.
 */
export function publicUrl(publicBaseUrl: string, key: string): string | null {
  if (!isSafeKey(key)) return null;
  return `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The part of `key` below `prefix`, or `null` if `key` is not strictly inside
 * it. Containment uses segment boundaries (`project-a2/x` is not inside
 * `project-a/`), the prefix itself is not inside, and the remainder must be a
 * safe key (`project-a/../x` is not inside). A prefix without a trailing `/`
 * is treated as a directory; an empty prefix (bucket root) contains nothing.
 */
export function relativeKey(key: string, prefix: string): string | null {
  if (prefix === "" || prefix === "/") return null;
  const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
  if (!key.startsWith(dir)) return null;
  const rest = key.slice(dir.length);
  return isSafeKey(rest) ? rest : null;
}

/** Whether `key` lies strictly inside the directory `prefix` (see `relativeKey`). */
export function isWithin(key: string, prefix: string): boolean {
  return relativeKey(key, prefix) !== null;
}

/**
 * Whether a Markdown href is a relative reference that `resolveReadmeHref`
 * handles. `false` for empty and fragment-only hrefs, for anything with a URL
 * scheme (`https:`, `mailto:`, `javascript:`) and for network-path references
 * (`//host`, and `\\host` variants that browsers treat the same way).
 * `false` does NOT mean safe: the caller must still vet absolute URLs.
 */
export function isRelativeHref(href: string): boolean {
  if (href === "" || href.startsWith("#")) return false;
  if (URL_SCHEME.test(href)) return false;
  return !/^[/\\]{2}/.test(href);
}

/**
 * Resolves a README link or image href against the share root and returns the
 * R2 key it points to, or `null`.
 *
 * - Works on the href as markdown-it emits it (percent-encoded); each path
 *   segment is decoded once and must pass the segment rules.
 * - `?query` and `#fragment` are dropped: public R2 URLs do not use them.
 * - `./` and `../` are resolved; a leading `/` means the share root (like a
 *   repository root on GitHub). Leaving the share root returns `null` rather
 *   than clamping.
 * - Encoded dot segments (`%2e%2e`), empty segments (`a//b`), separators
 *   smuggled as `%2F` / `%5C`, backslashes, control characters, double
 *   encoding and malformed escapes return `null`.
 * - Hrefs that point at a directory (trailing `/`, `.`, `..`, or the root
 *   itself) return `null`: only objects can be linked.
 * - Non-relative hrefs (see `isRelativeHref`) return `null`; callers handle
 *   external and fragment links before calling this.
 *
 * The result is inside the share root but may still be excluded by the share
 * rules; the caller must check that before linking it.
 */
export function resolveReadmeHref(href: string, shareSegments: readonly string[]): string | null {
  const root = toPrefix(shareSegments);
  if (!isRelativeHref(href)) return null;

  const end = href.search(/[?#]/);
  const path = end === -1 ? href : href.slice(0, end);
  if (path === "" || hasForbiddenRaw(path)) return null;

  const rawSegments = (path.startsWith("/") ? path.slice(1) : path).split("/");
  const stack: string[] = [];
  let pointsToDirectory = false;
  for (const rawSegment of rawSegments) {
    pointsToDirectory = false;
    if (rawSegment === ".") {
      pointsToDirectory = true;
      continue;
    }
    if (rawSegment === "..") {
      if (stack.pop() === undefined) return null;
      pointsToDirectory = true;
      continue;
    }
    const segment = decodeSegment(rawSegment);
    if (segment === null || !isSafeDecodedSegment(segment)) return null;
    stack.push(segment);
  }
  // A trailing `/` leaves an empty last segment, which was already rejected.
  if (pointsToDirectory || stack.length === 0) return null;
  return root + stack.join("/");
}
