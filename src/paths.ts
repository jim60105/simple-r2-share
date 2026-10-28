/**
 * The single authority for share URLs, R2 key prefixes, public object URLs and
 * README relative links (spec §5). Every function here is pure and runs in
 * both Workers and the admin page.
 *
 * Share pages live at `/s/<token>/` (rules editor spec §2, §3): the token
 * carries the folder path, so folder names never appear in a URL and are never
 * percent-decoded. Folder segments (from a token, the admin folder listing or
 * an R2 key) follow `isValidSegment`:
 * - not empty, not `.` and not `..`;
 * - no `/` or `\`;
 * - no control characters (C0 including NUL, DEL and C1): no legitimate shared
 *   folder needs them and they make logs, headers and rendered names ambiguous.
 *
 * README hrefs are still percent-encoded text, so each of their segments is
 * decoded exactly once and must additionally contain no `%XX` escape left
 * over. Such a segment was double-encoded (`%252F`, `%252e%252e`) and a
 * second decode somewhere else could turn it into a separator or a dot
 * segment. The cost is that a README cannot link a file whose real name
 * contains a literal `%XX` sequence.
 */

const SHORT_SHARE_PREFIX = "/s/";
const ZIP_ENDPOINT = "/api/share-zip";

// C0 controls (includes NUL), DEL and C1 controls.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const LEFTOVER_ESCAPE = /%[0-9a-f]{2}/i;
// Escapes that decode to a separator or NUL inside a single segment.
const FORBIDDEN_RAW_ESCAPE = /%(?:2f|5c|00)/i;
// RFC 3986 scheme, e.g. `https:`, `mailto:`, `javascript:`.
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Rules for one folder or object key segment (see the module comment). */
export function isValidSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !CONTROL_CHARS.test(segment)
  );
}

/** Rules for one decoded segment that came from a README href. */
function isSafeDecodedSegment(segment: string): boolean {
  return isValidSegment(segment) && !LEFTOVER_ESCAPE.test(segment);
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
 * The token of a short share page path such as `URL.pathname`, e.g.
 * `/s/hxR19djQFNp3SS7mNmos88qd/` -> `hxR19djQFNp3SS7mNmos88qd`, or `null` for
 * anything else: no trailing `/`, more than one segment, an empty token or a
 * `%` (tokens are plain Base58, so an escape means the URL is not canonical).
 * Whether the token decodes to a folder is `decodeShareToken`'s job.
 */
export function parseShortSharePath(pathname: string): string | null {
  if (!pathname.startsWith(SHORT_SHARE_PREFIX) || !pathname.endsWith("/")) return null;
  const token = pathname.slice(SHORT_SHARE_PREFIX.length, -1);
  if (token === "" || token.includes("/") || token.includes("%")) return null;
  return token;
}

/** Canonical share page path for a token, e.g. `/s/hxR19djQFNp3SS7mNmos88qd/`. */
export function shortSharePath(token: string): string {
  return `${SHORT_SHARE_PREFIX}${token}/`;
}

/** ZIP download path for a token, e.g. `/api/share-zip?token=hxR19djQFNp3SS7mNmos88qd`. */
export function zipDownloadPath(token: string): string {
  return `${ZIP_ENDPOINT}?token=${encodeURIComponent(token)}`;
}

/**
 * Parses the admin folder listing's `prefix` query value (already decoded
 * once by `URLSearchParams`): `""` is the bucket root (`[]`), anything else
 * must end with `/`, must not start with `/` and must consist of
 * `isValidSegment` segments, e.g. `releases/project-a/` ->
 * `["releases", "project-a"]`. A missing parameter counts as the root.
 */
export function parseFolderPrefix(prefix: string | null): string[] | null {
  if (prefix === null || prefix === "") return [];
  if (!prefix.endsWith("/") || prefix.startsWith("/")) return null;
  const segments = prefix.slice(0, -1).split("/");
  return segments.every(isValidSegment) ? segments : null;
}

/**
 * R2 list prefix for validated segments, always ending with `/`, e.g.
 * `releases/project-a/`. Throws `TypeError` if the segments are empty or
 * invalid, which is a programming error (spec §5: never list an unvalidated
 * prefix or the bucket root).
 */
export function toPrefix(segments: readonly string[]): string {
  if (segments.length === 0 || !segments.every(isValidSegment)) {
    throw new TypeError("paths: segments must come from decodeShareToken");
  }
  return `${segments.join("/")}/`;
}

/**
 * Whether an R2 object key can be linked and listed safely: non-empty
 * segments, no `.` / `..` segments (a browser would resolve them in the public
 * URL), no backslash and no control characters. Directory marker keys ending
 * in `/` are not safe object keys. A literal `%XX` in a key is fine.
 */
export function isSafeKey(key: string): boolean {
  return key !== "" && key.split("/").every(isValidSegment);
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
