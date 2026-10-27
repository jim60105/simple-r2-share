/**
 * The ZIP download endpoint `GET` / `HEAD /api/share-zip?dir=<share root>`
 * (spec §3, §7, §8; plan task 9), kept out of `functions/` so tests can call
 * it directly. `functions/api/share-zip.ts` only forwards the request.
 *
 * Flow:
 * 1. Other methods -> `405`, like the share route.
 * 2. Load the settings (`ConfigError` -> generic `500`). ZIP disabled -> the
 *    share route's `404` page, before any R2 call.
 * 3. Exactly one `dir` parameter, valid for `parseZipDir`; otherwise `404`
 *    (also before any R2 call). Other parameters are ignored.
 * 4. Read the rules and authorise the share root with the same helper as the
 *    share page (`loadAuthorisedRules`); unauthorised -> the same `404`.
 * 5. List the share root with the same filtering as the page, so excluded
 *    objects and the rules file never reach the archive. A share without
 *    files -> `404`: the page hides the button then, and an empty archive
 *    would be useless.
 * 6. Check the subrequest budget (below), then answer `200` with the stream.
 *    `HEAD` gets the same headers, including `Content-Length`, and reads no
 *    objects.
 *
 * Everything up to step 6 happens before the response exists, so any error
 * there (R2, `ListingError`, the budget) is logged and answered with the
 * generic error page `500`. Once streaming has begun, a failure errors the
 * body (see `src/zip-stream.ts`) and is logged here.
 */
import { loadConfig, type AppConfig, type Env } from "./config";
import { loadListing } from "./listing";
import { parseZipDir, toPrefix } from "./paths";
import {
  errorResponse,
  loadAuthorisedRules,
  methodNotAllowedResponse,
  notFoundResponse,
  responseHeaders,
} from "./share-handler";
import { createZipStream, predictZipLength, type ZipFile } from "./zip-stream";

/**
 * Most R2 calls (rules `get` + `list` pages + one `get` per file) one ZIP
 * request may plan to make. Workers Free allows 1,000 subrequests to
 * Cloudflare services per request (spec §7.1); the margin leaves room for the
 * platform and keeps a request that would certainly die mid-stream from
 * starting at all. Over budget -> generic `500`, reason in the server log.
 */
export const ZIP_SUBREQUEST_BUDGET = 900;

/** Planning failed before any byte was sent; answered with the generic `500`. */
export class ZipBudgetError extends Error {
  override name = "ZipBudgetError";
}

const ZIP_TYPE = "application/zip";

type Plan = { readonly kind: "not-found" } | { readonly kind: "zip"; readonly name: string; readonly files: readonly ZipFile[] };

export async function handleZipRequest(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head) return methodNotAllowedResponse();

  let config: AppConfig | null = null;
  try {
    config = loadConfig(env);
    if (!config.zipEnabled) return notFoundResponse(config, now, head);

    const plan = await planZip(new URL(request.url).searchParams, env.BUCKET, config);
    if (plan.kind === "not-found") return notFoundResponse(config, now, head);

    if (head) return new Response(null, { status: 200, headers: zipHeaders(plan.name, predictZipLength(plan.files)) });
    const zip = createZipStream(env.BUCKET, plan.files, (error, entry) => {
      console.error(`share zip: stream aborted at ${entry === null ? "start" : JSON.stringify(entry)}`, error);
    });
    return new Response(zip.body, { status: 200, headers: zipHeaders(plan.name, zip.length) });
  } catch (error) {
    console.error("share zip: request failed", error);
    return errorResponse(env, config, now, head);
  }
}

async function planZip(params: URLSearchParams, bucket: R2Bucket, config: AppConfig): Promise<Plan> {
  const dirs = params.getAll("dir");
  const segments = dirs.length === 1 ? parseZipDir(dirs[0]) : null;
  if (segments === null) return { kind: "not-found" };

  const counter = countSubrequests(bucket);
  const rules = await loadAuthorisedRules(counter.bucket, config, segments, "share zip");
  if (rules === null) return { kind: "not-found" };

  const listing = await loadListing(counter.bucket, toPrefix(segments), rules);
  if (listing.fileCount === 0) return { kind: "not-found" };

  const planned = counter.count + listing.fileCount;
  if (planned > ZIP_SUBREQUEST_BUDGET) {
    throw new ZipBudgetError(
      `${toPrefix(segments)} needs ${planned} R2 subrequests (${counter.count} so far + ${listing.fileCount} files), ` +
        `over the budget of ${ZIP_SUBREQUEST_BUDGET}`,
    );
  }
  return { kind: "zip", name: segments[segments.length - 1] as string, files: listing.files };
}

/**
 * Wraps the bucket so the `get` / `list` calls made while planning are
 * counted (the listing does not report how many pages it fetched). Only the
 * two methods the shared modules use are forwarded.
 */
function countSubrequests(bucket: R2Bucket): { readonly bucket: R2Bucket; readonly count: number } {
  const counter = {
    count: 0,
    bucket: {
      get: (key: string, options?: R2GetOptions) => {
        counter.count++;
        return bucket.get(key, options);
      },
      list: (options?: R2ListOptions) => {
        counter.count++;
        return bucket.list(options);
      },
    } as unknown as R2Bucket,
  };
  return counter;
}

function zipHeaders(name: string, length: bigint): Headers {
  // Shared security headers incl. `Cache-Control: no-store` and `nosniff`;
  // the CSP is inert for a download but harmless.
  const headers = responseHeaders(ZIP_TYPE, null);
  headers.set("Content-Disposition", contentDisposition(name));
  // In Workers `FixedLengthStream` sets the same value; set it explicitly so
  // `HEAD` and other runtimes agree. A body that ends up shorter or longer
  // errors instead of completing (see `src/zip-stream.ts`).
  headers.set("Content-Length", length.toString());
  return headers;
}

/**
 * `attachment` with `<name>.zip`: an ASCII `filename` fallback (anything
 * outside printable ASCII, `"` and `\` become `_`) and the exact name as an
 * RFC 5987 / RFC 6266 `filename*`, e.g. `專案` ->
 * `attachment; filename="__.zip"; filename*=UTF-8''%E5%B0%88%E6%A1%88.zip`.
 */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  // `encodeURIComponent` leaves `'()*` alone, which are not RFC 5987 attr-chars.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}.zip"; filename*=UTF-8''${encoded}.zip`;
}
