/**
 * The share page route (spec §6, §8; plan task 8), kept out of `functions/` so
 * tests can call it directly with a fake bucket. `functions/share/[[path]].ts`
 * only forwards the request and bindings.
 *
 * Flow for `GET` / `HEAD /share/<dir>/`:
 * 1. Load the deployment settings. `ConfigError` -> generic error page `500`
 *    (the brand and footer still render from `BRAND_*` and `FOOTER_HTML`).
 * 2. Validate the path with `parseSharePath`. Invalid -> `404`, before any R2
 *    call. A valid directory path that only lacks the trailing `/` gets a
 *    `308` to the canonical URL; this happens before the rules are read, so
 *    the redirect says nothing about whether the share exists.
 * 3. Read the rules. A missing or invalid rules file authorises nothing (the
 *    reason goes to the server log only) and every unauthorised directory gets
 *    the same `404` page, byte for byte.
 * 4. List the share root, read the README, render the page.
 *
 * Any exception (R2 errors, `RulesReadError`, `ListingError`, bugs) is logged
 * with `console.error` and answered with the generic error page `500`, which
 * never contains error details. Other methods get `405` with `Allow`.
 *
 * The response helpers and `loadAuthorisedRules` are shared with the ZIP
 * endpoint (`src/zip-handler.ts`), so both routes answer `404`, `405` and
 * `500` with the same bytes and authorise share roots the same way.
 */
import { loadConfig, pageChromeFromEnv, type AppConfig, type Env } from "./config";
import { renderErrorPage, renderNotFoundPage, renderSharePage } from "./html";
import { loadListing } from "./listing";
import { parseSharePath, sharePagePath, toPrefix } from "./paths";
import { loadReadme, MAX_README_BYTES, selectReadme } from "./readme";
import { loadRules, type Rules } from "./rules";

export const ALLOWED_METHODS = "GET, HEAD";

const HTML_TYPE = "text/html; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";

/**
 * Content-Security-Policy for every response of this route. The pages contain
 * no script of their own; styles, fonts and the favicon come from this origin;
 * the only cross-origin loads are README images on the R2 public domain.
 *
 * `script-src 'self'` exists for Cloudflare zone features that inject a
 * same-origin `/cdn-cgi/scripts/…` file into the HTML, such as Email Address
 * Obfuscation (`email-decode.min.js`). Nothing else on this origin can run as
 * a script: function responses and static assets are sent with `nosniff` and
 * none of them is JavaScript, and inline scripts stay blocked.
 *
 * `style-src-attr 'unsafe-inline'` lets inline `style` attributes through
 * (markdown-it writes `style="text-align:…"` on aligned table cells, and the
 * trusted `FOOTER_HTML` may use them) while `<style>` elements and external
 * stylesheets stay blocked by `style-src 'self'`. Style attributes cannot run
 * code, and README raw HTML is disabled, so visitors' content cannot add them.
 */
export function contentSecurityPolicy(imageOrigin: string | null): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    `img-src 'self'${imageOrigin ? ` ${imageOrigin}` : ""}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Headers shared by every response of this route (HTML pages, `405`, `308`).
 * `imageOrigin` is the R2 public origin, or `null` when the configuration
 * could not be loaded (the error page shows no images anyway).
 */
export function responseHeaders(contentType: string | null, imageOrigin: string | null): Headers {
  const headers = new Headers();
  if (contentType !== null) headers.set("Content-Type", contentType);
  // Pages reflect the current rules and objects; no CDN or browser may keep them (spec §6).
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", contentSecurityPolicy(imageOrigin));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  // Cross-origin requests (R2 files, README links) get the origin only, never the share path.
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return headers;
}

function imageOriginOf(config: AppConfig | null): string | null {
  return config === null ? null : new URL(config.publicBaseUrl).origin;
}

function htmlResponse(status: number, html: string, config: AppConfig | null, head: boolean): Response {
  return new Response(head ? null : html, { status, headers: responseHeaders(HTML_TYPE, imageOriginOf(config)) });
}

/** `405` for anything but `GET` / `HEAD`, with `Allow`. */
export function methodNotAllowedResponse(): Response {
  const headers = responseHeaders(TEXT_TYPE, null);
  headers.set("Allow", ALLOWED_METHODS);
  return new Response("Method Not Allowed\n", { status: 405, headers });
}

/** The single `404` page, identical for every reason a share is not available. */
export function notFoundResponse(config: AppConfig, now: Date, head: boolean): Response {
  return htmlResponse(404, renderNotFoundPage(config, now), config, head);
}

/**
 * The generic error page `500`. `config` is `null` when the configuration
 * could not be loaded; the brand and footer then come from their variables alone.
 */
export function errorResponse(env: Env, config: AppConfig | null, now: Date, head: boolean): Response {
  return htmlResponse(500, renderErrorPage(config ?? pageChromeFromEnv(env), now), config, head);
}

/**
 * Reads the share rules and returns them if `segments` is an authorised share
 * root, otherwise `null` (answer with `notFoundResponse`). A missing or
 * invalid rules file authorises nothing; the reason is logged with `logLabel`
 * as prefix and never shown to visitors. R2 errors propagate.
 */
export async function loadAuthorisedRules(
  bucket: R2Bucket,
  config: AppConfig,
  segments: readonly string[],
  logLabel: string,
): Promise<Rules | null> {
  const rules = await loadRules(bucket, config.shareRulesKey);
  if (rules.status !== "loaded") {
    // Deny-all rules: the visitor sees the ordinary 404.
    console.error(`${logLabel}: share rules are ${rules.status}: ${rules.problem ?? "unknown problem"}`);
  }
  return rules.isShareRoot(segments) ? rules : null;
}

type Outcome =
  | { readonly kind: "page"; readonly html: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "redirect"; readonly location: string };

/**
 * Handles one request to `/share/*`. `now` is the render time shown as
 * `SYNCED …` (tests pass a fixed date).
 */
export async function handleShareRequest(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return methodNotAllowedResponse();

  let config: AppConfig | null = null;
  try {
    config = loadConfig(env);
    const outcome = await resolveShare(new URL(request.url).pathname, env.BUCKET, config, now);
    switch (outcome.kind) {
      case "page":
        return htmlResponse(200, outcome.html, config, head);
      case "not-found":
        return notFoundResponse(config, now, head);
      case "redirect": {
        const headers = responseHeaders(null, imageOriginOf(config));
        headers.set("Location", outcome.location);
        return new Response(null, { status: 308, headers });
      }
    }
  } catch (error) {
    console.error("share page: request failed", error);
    return errorResponse(env, config, now, head);
  }
}

async function resolveShare(pathname: string, bucket: R2Bucket, config: AppConfig, now: Date): Promise<Outcome> {
  const segments = parseSharePath(pathname);
  if (segments === null) {
    const withSlash = pathname.endsWith("/") ? null : parseSharePath(`${pathname}/`);
    return withSlash === null ? { kind: "not-found" } : { kind: "redirect", location: sharePagePath(withSlash) };
  }

  const rules = await loadAuthorisedRules(bucket, config, segments, "share page");
  if (rules === null) return { kind: "not-found" };

  const listing = await loadListing(bucket, toPrefix(segments), rules);
  const readmeFile = selectReadme(listing);
  if (readmeFile !== null && readmeFile.size > MAX_README_BYTES) {
    console.warn(`share page: ${readmeFile.key} is larger than ${MAX_README_BYTES} bytes and is not shown`);
  }
  const readme = await loadReadme(bucket, { listing, rules, publicBaseUrl: config.publicBaseUrl });
  return { kind: "page", html: renderSharePage({ segments, listing, readme, config, now }) };
}
