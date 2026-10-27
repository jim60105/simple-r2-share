/**
 * The share page route (spec §6, §8; plan task 8), kept out of `functions/` so
 * tests can call it directly with a fake bucket. `functions/share/[[path]].ts`
 * only forwards the request and bindings.
 *
 * Flow for `GET` / `HEAD /share/<dir>/`:
 * 1. Load the deployment settings. `ConfigError` -> generic error page `500`
 *    (the footer still renders from `FOOTER_HTML`).
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
 */
import { footerHtmlFromEnv, loadConfig, type AppConfig, type Env } from "./config";
import { renderErrorPage, renderNotFoundPage, renderSharePage } from "./html";
import { loadListing } from "./listing";
import { parseSharePath, sharePagePath, toPrefix } from "./paths";
import { loadReadme, MAX_README_BYTES, selectReadme } from "./readme";
import { loadRules } from "./rules";

export const ALLOWED_METHODS = "GET, HEAD";

const HTML_TYPE = "text/html; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";

/**
 * Content-Security-Policy for every response of this route. The pages contain
 * no script at all; styles, fonts and the favicon come from this origin; the
 * only cross-origin loads are README images on the R2 public domain.
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
    "script-src 'none'",
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
  if (request.method !== "GET" && !head) {
    const headers = responseHeaders(TEXT_TYPE, null);
    headers.set("Allow", ALLOWED_METHODS);
    return new Response("Method Not Allowed\n", { status: 405, headers });
  }

  let config: AppConfig | null = null;
  try {
    config = loadConfig(env);
    const outcome = await resolveShare(new URL(request.url).pathname, env.BUCKET, config, now);
    switch (outcome.kind) {
      case "page":
        return htmlResponse(200, outcome.html, config, head);
      case "not-found":
        return htmlResponse(404, renderNotFoundPage(config, now), config, head);
      case "redirect": {
        const headers = responseHeaders(null, imageOriginOf(config));
        headers.set("Location", outcome.location);
        return new Response(null, { status: 308, headers });
      }
    }
  } catch (error) {
    console.error("share page: request failed", error);
    const footer = { footerHtml: config?.footerHtml ?? footerHtmlFromEnv(env) };
    return htmlResponse(500, renderErrorPage(footer, now), config, head);
  }
}

async function resolveShare(pathname: string, bucket: R2Bucket, config: AppConfig, now: Date): Promise<Outcome> {
  const segments = parseSharePath(pathname);
  if (segments === null) {
    const withSlash = pathname.endsWith("/") ? null : parseSharePath(`${pathname}/`);
    return withSlash === null ? { kind: "not-found" } : { kind: "redirect", location: sharePagePath(withSlash) };
  }

  const rules = await loadRules(bucket, config.shareRulesKey);
  if (rules.status !== "loaded") {
    // Deny-all rules: the visitor sees the ordinary 404 below.
    console.error(`share page: share rules are ${rules.status}: ${rules.problem ?? "unknown problem"}`);
  }
  if (!rules.isShareRoot(segments)) return { kind: "not-found" };

  const listing = await loadListing(bucket, toPrefix(segments), rules);
  const readmeFile = selectReadme(listing);
  if (readmeFile !== null && readmeFile.size > MAX_README_BYTES) {
    console.warn(`share page: ${readmeFile.key} is larger than ${MAX_README_BYTES} bytes and is not shown`);
  }
  const readme = await loadReadme(bucket, { listing, rules, publicBaseUrl: config.publicBaseUrl });
  return { kind: "page", html: renderSharePage({ segments, listing, readme, config, now }) };
}
