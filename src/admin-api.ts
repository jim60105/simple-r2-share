/**
 * The admin API (admin UI spec §5): `/api/admin/rules` and
 * `/api/admin/folders`. The handlers run behind
 * `functions/api/admin/_middleware.ts`, which has already verified Access and
 * passes the caller's email. Only the `SHARE_RULES_KEY` object is ever read
 * whole or written; folders are listed one level at a time.
 *
 * Every response is uncached JSON; errors are `{"error": "<code>"}` and never
 * mention keys or internals.
 */
import { DEFAULT_SHARE_RULES_KEY, pageChromeFromEnv, type Env } from "./config";
import { isValidSegment, parseFolderPrefix } from "./paths";
import { MAX_RULES_FILE_BYTES, parseRules } from "./rules";

/** Data the Access middleware passes to the admin API handlers. */
export interface AdminData extends Record<string, unknown> {
  /** `email` of the verified Access JWT; `null` for service tokens. */
  accessEmail: string | null;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/** Largest `PUT` body read: a full rules file JSON-escaped, with room to spare. */
export const MAX_PUT_BODY_BYTES = 128 * 1024;

const FOLDER_PAGE_SIZE = 1000;

function methodNotAllowed(allow: string): Response {
  return jsonResponse(405, { error: "method_not_allowed" }, { Allow: allow });
}

function internalError(label: string, error: unknown): Response {
  console.error(`admin api: ${label} failed`, error);
  return jsonResponse(500, { error: "internal" });
}

function rulesKeyOf(env: Env): string {
  return env.SHARE_RULES_KEY || DEFAULT_SHARE_RULES_KEY;
}

/** `GET` and `PUT /api/admin/rules` (admin UI spec §5.1, §5.2). */
export async function handleRulesRequest(request: Request, env: Env, email: string | null): Promise<Response> {
  try {
    if (request.method === "GET") return await readRules(env, email);
    if (request.method === "PUT") return await writeRules(request, env);
    return methodNotAllowed("GET, PUT");
  } catch (error) {
    return internalError("rules", error);
  }
}

async function readRules(env: Env, email: string | null): Promise<Response> {
  const rulesKey = rulesKeyOf(env);
  const common = { user: { email }, brandName: pageChromeFromEnv(env).brandName, rulesKey };
  const object = await env.BUCKET.get(rulesKey);
  if (object === null) return jsonResponse(200, { exists: false, text: "", etag: null, savedAt: null, ...common });

  const saved = { exists: true, etag: object.etag, savedAt: object.uploaded.toISOString(), ...common };
  if (object.size > MAX_RULES_FILE_BYTES) {
    await object.body.cancel().catch(() => undefined);
    return jsonResponse(200, { ...saved, text: "", invalid: `the file is larger than ${MAX_RULES_FILE_BYTES} bytes` });
  }
  let text: string;
  try {
    // Same decoding as the public pages (`loadRules`): invalid UTF-8 is an error, a BOM is skipped.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await object.arrayBuffer());
  } catch {
    return jsonResponse(200, { ...saved, text: "", invalid: "the file is not valid UTF-8" });
  }
  return jsonResponse(200, { ...saved, text });
}

/** The request body, or `null` once it grows past `max` bytes. */
async function readLimited(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (request.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseSaveBody(bytes: Uint8Array): { text: string; etag: string | null } | null {
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (typeof body !== "object" || body === null) return null;
    const { text, etag } = body as { text?: unknown; etag?: unknown };
    if (typeof text !== "string" || (typeof etag !== "string" && etag !== null)) return null;
    return { text, etag };
  } catch {
    return null;
  }
}

async function writeRules(request: Request, env: Env): Promise<Response> {
  const bytes = await readLimited(request, MAX_PUT_BODY_BYTES);
  if (bytes === null) return jsonResponse(413, { error: "too_large" });
  const body = parseSaveBody(bytes);
  if (body === null) return jsonResponse(400, { error: "bad_request" });

  const rulesKey = rulesKeyOf(env);
  if (new TextEncoder().encode(body.text).byteLength > MAX_RULES_FILE_BYTES) {
    return jsonResponse(400, { error: "invalid_rules", problem: `the file is larger than ${MAX_RULES_FILE_BYTES} bytes` });
  }
  const rules = parseRules(body.text, rulesKey);
  if (rules.status !== "loaded") return jsonResponse(400, { error: "invalid_rules", problem: rules.problem });

  // First save: only if nobody created the file meanwhile. Later saves: only over the version that was read.
  const onlyIf = body.etag === null ? new Headers({ "If-None-Match": "*" }) : { etagMatches: body.etag };
  const written = await env.BUCKET.put(rulesKey, body.text, {
    onlyIf,
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  if (written === null) return jsonResponse(409, { error: "conflict" });
  return jsonResponse(200, { etag: written.etag, savedAt: written.uploaded.toISOString() });
}

/** `GET /api/admin/folders?prefix=<dir/>&cursor=<cursor>` (admin UI spec §5.3). */
export async function handleFoldersRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const params = new URL(request.url).searchParams;
  const prefixes = params.getAll("prefix");
  const cursors = params.getAll("cursor");
  const segments = prefixes.length <= 1 ? parseFolderPrefix(prefixes[0] ?? null) : null;
  if (segments === null || cursors.length > 1) return jsonResponse(400, { error: "bad_request" });

  const prefix = segments.length === 0 ? "" : `${segments.join("/")}/`;
  try {
    const page = await env.BUCKET.list({
      prefix,
      delimiter: "/",
      limit: FOLDER_PAGE_SIZE,
      ...(cursors[0] ? { cursor: cursors[0] } : {}),
    });
    const folders = page.delimitedPrefixes
      .filter((name) => name.startsWith(prefix) && name.endsWith("/"))
      .map((name) => name.slice(prefix.length, -1))
      .filter(isValidSegment);
    return jsonResponse(200, { folders, cursor: page.truncated ? page.cursor : null });
  } catch (error) {
    return internalError("folders", error);
  }
}
