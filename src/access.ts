/**
 * Cloudflare Access verification for the admin API (admin UI spec §9).
 *
 * Access protects `/admin`, `/admin/*` and `/api/admin/*` at the edge and
 * adds a `Cf-Access-Jwt-Assertion` header (an RS256 JWT) to every request it
 * lets through. The admin API verifies that JWT itself instead of trusting
 * the edge alone, so a deployment where Access is missing or misconfigured
 * (a `pages.dev` or preview host left unprotected) still refuses every admin
 * call. Nothing here is skipped when a claim is missing: no `exp`, `iss` or
 * matching `aud` means `403`.
 *
 * This replaces `@cloudflare/pages-plugin-cloudflare-access`, which skips the
 * claims it cannot find, answers `302` instead of `403` and fetches the keys
 * on every request.
 */
import type { Env } from "./config";
import { jsonResponse } from "./admin-api";

export interface AccessConfig {
  /** Team domain origin without a trailing slash, e.g. `https://myteam.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** AUD tag of the admin Access application. */
  readonly aud: string;
}

/** What the admin API learns about the caller. */
export interface AccessIdentity {
  /** `null` for service tokens, which carry no `email`. */
  readonly email: string | null;
}

/** Looks up an Access signing key by `kid`; `refresh` bypasses any cache. */
export interface KeySource {
  getKey(kid: string, refresh: boolean): Promise<JsonWebKey | null>;
}

const TEAM_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;

/**
 * The Access settings, or `null` when either is missing or malformed (the
 * admin API then refuses everything). `ACCESS_TEAM_DOMAIN` must be a
 * `<team>.cloudflareaccess.com` hostname with optional `https://` and one trailing `/`.
 */
export function loadAccessConfig(env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">): AccessConfig | null {
  const raw = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!raw || !aud) return null;
  const origin = raw.startsWith("https://") ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // Comparing with the origin rules out credentials, a path, a query and a fragment.
  if (url.protocol !== "https:" || !TEAM_HOST.test(url.hostname) || url.port !== "") return null;
  if (origin.replace(/\/$/, "") !== url.origin) return null;
  return { teamDomain: url.origin, aud };
}

const CERTS_TTL_SECONDS = 3600;

/**
 * Keys from `<teamDomain>/cdn-cgi/access/certs`, kept in the Cache API for an
 * hour under that URL. `cache` is `caches.default` in Workers; `null` skips
 * caching. Only RSA keys whose `alg` is absent or `RS256` are returned. A
 * failed fetch throws, which `verifyAccessJwt` turns into a refusal.
 */
export function certsKeySource(teamDomain: string, fetchFn: typeof fetch, cache: Cache | null): KeySource {
  const url = `${teamDomain}/cdn-cgi/access/certs`;

  async function load(refresh: boolean): Promise<unknown> {
    if (!refresh && cache !== null) {
      const cached = await cache.match(url);
      if (cached !== undefined) return cached.json();
    }
    const response = await fetchFn(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`access: ${url} answered ${response.status}`);
    const text = await response.text();
    if (cache !== null) {
      const headers = { "Content-Type": "application/json", "Cache-Control": `max-age=${CERTS_TTL_SECONDS}` };
      await cache.put(url, new Response(text, { headers }));
    }
    return JSON.parse(text) as unknown;
  }

  return {
    async getKey(kid, refresh) {
      const body = await load(refresh);
      const keys = typeof body === "object" && body !== null && "keys" in body ? body.keys : null;
      if (!Array.isArray(keys)) return null;
      for (const key of keys as unknown[]) {
        if (typeof key !== "object" || key === null) continue;
        const { kid: keyId, kty, alg } = key as { kid?: unknown; kty?: unknown; alg?: unknown };
        if (keyId === kid && kty === "RSA" && (alg === undefined || alg === "RS256")) return key as JsonWebKey;
      }
      return null;
    },
  };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function base64UrlBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlJson(text: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(text);
  if (bytes === null) return null;
  const value: unknown = JSON.parse(decoder.decode(bytes));
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Verifies an Access JWT: three parts, header `alg` `RS256` with a `kid`, a
 * known key (an unknown `kid` refreshes the keys once), a valid
 * RSASSA-PKCS1-v1_5 SHA-256 signature, `iss` equal to the team domain, `aud`
 * (string or array) containing the configured tag, `exp` present and in the
 * future, and `nbf`, when present, not in the future. Any failure, including
 * an exception, returns `null`.
 */
export async function verifyAccessJwt(
  jwt: string,
  config: AccessConfig,
  keys: KeySource,
  now: Date,
): Promise<AccessIdentity | null> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = base64UrlJson(headerPart);
    if (header === null || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid === "") return null;

    const jwk = (await keys.getKey(header.kid, false)) ?? (await keys.getKey(header.kid, true));
    if (jwk === null || typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signature = base64UrlBytes(signaturePart);
    if (signature === null) return null;
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) return null;

    const payload = base64UrlJson(payloadPart);
    if (payload === null || payload.iss !== config.teamDomain) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(config.aud)) return null;
    const seconds = now.getTime() / 1000;
    if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
    if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > seconds)) return null;

    return { email: typeof payload.email === "string" && payload.email !== "" ? payload.email : null };
  } catch {
    return null;
  }
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** `403` for every refused admin request; the body never says why. */
export function forbiddenResponse(): Response {
  return jsonResponse(403, { error: "forbidden" });
}

/**
 * The admin API gate run by `functions/api/admin/_middleware.ts`: the caller's
 * identity, or the `403` to send. Besides the JWT, state-changing methods
 * need an `Origin` equal to the request's own origin (CSRF), and `PUT` needs
 * a JSON body type, which a cross-site form cannot send without a preflight.
 */
export async function authenticateAdmin(
  request: Request,
  env: Env,
  keys: (config: AccessConfig) => KeySource,
  now: Date = new Date(),
): Promise<AccessIdentity | Response> {
  const config = loadAccessConfig(env);
  if (config === null) {
    console.error("admin api: ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set; refusing every request");
    return forbiddenResponse();
  }
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt === null || jwt === "") return forbiddenResponse();
  const identity = await verifyAccessJwt(jwt, config, keys(config), now);
  if (identity === null) return forbiddenResponse();

  if (STATE_CHANGING.has(request.method)) {
    if (request.headers.get("Origin") !== new URL(request.url).origin) return forbiddenResponse();
    if (request.method === "PUT") {
      const mediaType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") return forbiddenResponse();
    }
  }
  return identity;
}
