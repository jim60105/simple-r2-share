import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateAdmin,
  certsKeySource,
  loadAccessConfig,
  verifyAccessJwt,
  type AccessConfig,
  type KeySource,
} from "../src/access";
import type { Env } from "../src/config";

const TEAM = "https://myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const CONFIG: AccessConfig = { teamDomain: TEAM, aud: AUD };
const NOW = new Date("2026-10-28T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;
const ORIGIN = "https://share.example.com";

let signingKey: CryptoKey;
let publicJwk: JsonWebKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = (await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  otherKey = ((await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function base64Url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" },
  key: CryptoKey = signingKey,
): Promise<string> {
  const signed = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signed)));
  return `${signed}.${base64Url(signature)}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUD],
    email: "admin@example.com",
    exp: NOW_S + 600,
    iat: NOW_S - 60,
    nbf: NOW_S - 60,
    iss: TEAM,
    type: "app",
    sub: "user-1",
    ...overrides,
  };
}

/** A key source holding `k1`, counting lookups per `refresh` flag. */
function keySource(available: Record<string, JsonWebKey> = { k1: publicJwk }) {
  const calls: { kid: string; refresh: boolean }[] = [];
  const source: KeySource = {
    async getKey(kid, refresh) {
      calls.push({ kid, refresh });
      return available[kid] ?? null;
    },
  };
  return { source, calls };
}

describe("loadAccessConfig", () => {
  it.each([
    [TEAM, TEAM],
    [`${TEAM}/`, TEAM],
    [` ${TEAM} `, TEAM],
  ])("accepts %j", (domain, expected) => {
    expect(loadAccessConfig({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD })).toEqual({ teamDomain: expected, aud: AUD });
  });

  it.each([
    ["missing domain", undefined, AUD],
    ["empty domain", "", AUD],
    ["missing aud", TEAM, undefined],
    ["blank aud", TEAM, "  "],
    ["http", "http://myteam.cloudflareaccess.com", AUD],
    ["no scheme", "myteam.cloudflareaccess.com", AUD],
    ["other host", "https://myteam.example.com", AUD],
    ["lookalike host", "https://myteam.cloudflareaccess.com.evil.example", AUD],
    ["bare suffix", "https://cloudflareaccess.com", AUD],
    ["path", `${TEAM}/cdn-cgi`, AUD],
    ["query", `${TEAM}?x=1`, AUD],
    ["fragment", `${TEAM}#x`, AUD],
    ["port", "https://myteam.cloudflareaccess.com:8443", AUD],
    ["credentials", "https://u:p@myteam.cloudflareaccess.com", AUD],
    ["uppercase host", "https://MyTeam.cloudflareaccess.com", AUD],
  ])("rejects %s", (_label, domain, aud) => {
    expect(loadAccessConfig({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: aud })).toBeNull();
  });
});

describe("verifyAccessJwt", () => {
  it("accepts a valid identity token and returns the email", async () => {
    const { source, calls } = keySource();
    expect(await verifyAccessJwt(await sign(claims()), CONFIG, source, NOW)).toEqual({ email: "admin@example.com" });
    expect(calls).toEqual([{ kid: "k1", refresh: false }]);
  });

  it("accepts a string aud and a token without nbf", async () => {
    const token = await sign(claims({ aud: AUD, nbf: undefined }));
    expect(await verifyAccessJwt(token, CONFIG, keySource().source, NOW)).not.toBeNull();
  });

  it("returns email null for a service token", async () => {
    const token = await sign(claims({ email: undefined, sub: "", common_name: "client-id.access" }));
    expect(await verifyAccessJwt(token, CONFIG, keySource().source, NOW)).toEqual({ email: null });
  });

  it("refreshes the keys once for an unknown kid", async () => {
    const available: Record<string, JsonWebKey> = {};
    const calls: boolean[] = [];
    const source: KeySource = {
      async getKey(kid, refresh) {
        calls.push(refresh);
        if (refresh) available.k1 = publicJwk; // rotated in
        return available[kid] ?? null;
      },
    };
    expect(await verifyAccessJwt(await sign(claims()), CONFIG, source, NOW)).not.toBeNull();
    expect(calls).toEqual([false, true]);
  });

  it("rejects a kid that is still unknown after the refresh", async () => {
    const { source, calls } = keySource({});
    expect(await verifyAccessJwt(await sign(claims()), CONFIG, source, NOW)).toBeNull();
    expect(calls).toEqual([
      { kid: "k1", refresh: false },
      { kid: "k1", refresh: true },
    ]);
  });

  it.each([
    ["wrong iss", { iss: "https://other.cloudflareaccess.com" }],
    ["missing iss", { iss: undefined }],
    ["wrong aud", { aud: ["other"] }],
    ["missing aud", { aud: undefined }],
    ["missing exp", { exp: undefined }],
    ["expired", { exp: NOW_S - 1 }],
    ["expiring now", { exp: NOW_S }],
    ["string exp", { exp: String(NOW_S + 600) }],
    ["nbf in the future", { nbf: NOW_S + 5 }],
    ["string nbf", { nbf: "0" }],
  ])("rejects a token with %s", async (_label, overrides) => {
    const token = await sign(claims(overrides));
    expect(await verifyAccessJwt(token, CONFIG, keySource().source, NOW)).toBeNull();
  });

  it.each([
    ["alg HS256", { alg: "HS256", kid: "k1" }],
    ["alg none", { alg: "none", kid: "k1" }],
    ["missing alg", { kid: "k1" }],
    ["missing kid", { alg: "RS256" }],
    ["empty kid", { alg: "RS256", kid: "" }],
  ])("rejects a header with %s", async (_label, header) => {
    const token = await sign(claims(), header);
    expect(await verifyAccessJwt(token, CONFIG, keySource().source, NOW)).toBeNull();
  });

  it("rejects a token signed by another key", async () => {
    const token = await sign(claims(), undefined, otherKey);
    expect(await verifyAccessJwt(token, CONFIG, keySource().source, NOW)).toBeNull();
  });

  it("rejects a token whose payload was changed after signing", async () => {
    const [header, , signature] = (await sign(claims())).split(".");
    const forged = `${header}.${base64Url(JSON.stringify(claims({ email: "evil@example.com" })))}.${signature}`;
    expect(await verifyAccessJwt(forged, CONFIG, keySource().source, NOW)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["one part", "abc"],
    ["two parts", "abc.def"],
    ["four parts", "a.b.c.d"],
    ["not base64url", "a+b.c.d"],
    ["not JSON", `${base64Url("nope")}.${base64Url("{}")}.sig`],
    ["JSON array header", `${base64Url("[]")}.${base64Url("{}")}.sig`],
  ])("rejects a malformed token: %s", async (_label, token) => {
    expect(await verifyAccessJwt(token, CONFIG, keySource().source, NOW)).toBeNull();
  });

  it("rejects when the key source throws", async () => {
    const source: KeySource = {
      getKey: async () => {
        throw new Error("certs unavailable");
      },
    };
    expect(await verifyAccessJwt(await sign(claims()), CONFIG, source, NOW)).toBeNull();
  });
});

/** Minimal Cache API stand-in keyed by URL. */
class FakeCache {
  readonly entries = new Map<string, string>();
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const text = this.entries.get(String(request));
    return text === undefined ? undefined : new Response(text);
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    expect(response.headers.get("Cache-Control")).toBe("max-age=3600");
    this.entries.set(String(request), await response.text());
  }
  asCache(): Cache {
    return this as unknown as Cache;
  }
}

describe("certsKeySource", () => {
  const CERTS = `${TEAM}/cdn-cgi/access/certs`;

  function fakeFetch(bodies: unknown[]) {
    const urls: string[] = [];
    const fn = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const body = bodies.shift();
      return body instanceof Response ? body : Response.json(body);
    }) as typeof fetch;
    return { fn, urls };
  }

  it("fetches the certs once and serves later lookups from the cache", async () => {
    const cache = new FakeCache();
    const { fn, urls } = fakeFetch([{ keys: [{ ...publicJwk, kid: "k1", alg: "RS256" }] }]);
    const source = certsKeySource(TEAM, fn, cache.asCache());
    expect((await source.getKey("k1", false))?.n).toBe(publicJwk.n);
    expect((await source.getKey("k1", false))?.n).toBe(publicJwk.n);
    expect(urls).toEqual([CERTS]);
    expect(cache.entries.has(CERTS)).toBe(true);
  });

  it("bypasses the cache on refresh and stores the new keys", async () => {
    const cache = new FakeCache();
    cache.entries.set(CERTS, JSON.stringify({ keys: [] }));
    const { fn, urls } = fakeFetch([{ keys: [{ ...publicJwk, kid: "k2" }] }]);
    const source = certsKeySource(TEAM, fn, cache.asCache());
    expect(await source.getKey("k2", false)).toBeNull();
    expect(urls).toEqual([]);
    expect(await source.getKey("k2", true)).not.toBeNull();
    expect(await source.getKey("k2", false)).not.toBeNull();
    expect(urls).toEqual([CERTS]);
  });

  it("ignores keys that are not RSA or not RS256", async () => {
    const body = {
      keys: [{ kid: "ec", kty: "EC", crv: "P-256", x: "x", y: "y" }, { ...publicJwk, kid: "ps", alg: "PS256" }, null, "junk"],
    };
    const { fn } = fakeFetch([body, body]);
    const source = certsKeySource(TEAM, fn, null);
    expect(await source.getKey("ec", true)).toBeNull();
    expect(await source.getKey("ps", false)).toBeNull();
  });

  it("throws when the certs endpoint fails", async () => {
    const { fn } = fakeFetch([new Response("down", { status: 502 })]);
    await expect(certsKeySource(TEAM, fn, null).getKey("k1", false)).rejects.toThrow("502");
  });

  it("returns null for a body without keys", async () => {
    const { fn } = fakeFetch([{ public_cert: {} }]);
    expect(await certsKeySource(TEAM, fn, null).getKey("k1", false)).toBeNull();
  });
});

describe("authenticateAdmin", () => {
  const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as Env;

  async function request(method: string, headers: Record<string, string> = {}, jwt?: string | null): Promise<Request> {
    const token = jwt === undefined ? await sign(claims()) : jwt;
    return new Request(`${ORIGIN}/api/admin/rules`, {
      method,
      headers: { ...(token === null ? {} : { "Cf-Access-Jwt-Assertion": token }), ...headers },
    });
  }

  const keys = () => keySource().source;

  async function expectForbidden(result: unknown): Promise<void> {
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({ error: "forbidden" });
  }

  it("lets a GET with a valid token through", async () => {
    expect(await authenticateAdmin(await request("GET"), ENV, keys, NOW)).toEqual({ email: "admin@example.com" });
  });

  it("lets a same-origin JSON PUT through", async () => {
    const put = await request("PUT", { Origin: ORIGIN, "Content-Type": "application/json; charset=utf-8" });
    expect(await authenticateAdmin(put, ENV, keys, NOW)).toEqual({ email: "admin@example.com" });
  });

  it("refuses everything without Access settings", async () => {
    await expectForbidden(await authenticateAdmin(await request("GET"), {} as Env, keys, NOW));
    await expectForbidden(await authenticateAdmin(await request("GET"), { ACCESS_TEAM_DOMAIN: TEAM } as Env, keys, NOW));
  });

  it("refuses a request without the JWT header", async () => {
    await expectForbidden(await authenticateAdmin(await request("GET", {}, null), ENV, keys, NOW));
    await expectForbidden(await authenticateAdmin(await request("GET", {}, ""), ENV, keys, NOW));
  });

  it("refuses an invalid JWT", async () => {
    const expired = await sign(claims({ exp: NOW_S - 1 }));
    await expectForbidden(await authenticateAdmin(await request("GET", {}, expired), ENV, keys, NOW));
  });

  it.each([
    ["missing Origin", { "Content-Type": "application/json" }],
    ["cross-site Origin", { Origin: "https://evil.example", "Content-Type": "application/json" }],
    ["null Origin", { Origin: "null", "Content-Type": "application/json" }],
    ["form Content-Type", { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }],
    ["text Content-Type", { Origin: ORIGIN, "Content-Type": "text/plain" }],
    ["missing Content-Type", { Origin: ORIGIN }],
  ])("refuses a PUT with %s", async (_label, headers) => {
    await expectForbidden(await authenticateAdmin(await request("PUT", headers), ENV, keys, NOW));
  });

  it.each(["POST", "DELETE", "PATCH"])("requires a same-origin Origin for %s", async (method) => {
    await expectForbidden(await authenticateAdmin(await request(method, { Origin: "https://evil.example" }), ENV, keys, NOW));
    expect(await authenticateAdmin(await request(method, { Origin: ORIGIN }), ENV, keys, NOW)).not.toBeInstanceOf(Response);
  });
});
