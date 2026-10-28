import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Env } from "../src/config";
import { EMPTY_TEXT, ERROR_TITLE, NOT_FOUND_TITLE } from "../src/html";
import { MAX_README_BYTES } from "../src/readme";
import { ALLOWED_METHODS, contentSecurityPolicy, handleShareRequest } from "../src/share-handler";
import { encodeShareToken } from "../src/short-url";
import { FakeBucket } from "./fake-bucket";
import { tokenOfBytes } from "./tokens";

const ORIGIN = "https://share.example.com";
const PUBLIC_BASE = "https://files.example.com";
const NOW = new Date("2026-10-27T08:30:00Z");
const RULES = ["releases/project-a/", "releases/project-b/**", "!releases/project-b/private/", "empty/"].join("\n");
const SECRET = "SECRET-DETAIL-r2-internal";

let errorSpy: MockInstance<typeof console.error>;
let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seededBucket(rules: string | null = RULES): FakeBucket {
  const bucket = new FakeBucket();
  if (rules !== null) bucket.put(".r2-share-rules", rules);
  bucket
    .put("releases/project-a/README.md", "# Project A\n\n![shot](img/shot.png)\n", new Date("2026-10-20T00:00:00Z"))
    .put("releases/project-a/img/shot.png", "png")
    .put("releases/project-a/app-v1.zip", "zip-bytes")
    .put("releases/project-a/sub/notes.txt", "notes")
    .put("releases/project-b/one.txt", "1")
    .put("releases/project-b/child/two.txt", "2")
    .put("releases/project-b/private/secret.txt", "s")
    .put("releases/project-a2/other.txt", "x");
  return bucket;
}

/** The canonical share page path of a folder. */
function share(...segments: string[]): string {
  return `/s/${encodeShareToken(segments)}/`;
}

function envFor(bucket: FakeBucket, overrides: Partial<Omit<Env, "BUCKET">> = {}): Env {
  return { BUCKET: bucket.asR2Bucket(), R2_PUBLIC_BASE_URL: PUBLIC_BASE, ...overrides };
}

function request(path: string, method = "GET"): Request {
  return new Request(`${ORIGIN}${path}`, { method });
}

async function get(bucket: FakeBucket, path: string, overrides?: Partial<Omit<Env, "BUCKET">>, method?: string) {
  const response = await handleShareRequest(request(path, method), envFor(bucket, overrides), NOW);
  return { response, body: await response.text() };
}

function expectCommonHeaders(response: Response, contentType: string | null = "text/html; charset=utf-8"): void {
  expect(response.headers.get("Content-Type")).toBe(contentType);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  const csp = response.headers.get("Content-Security-Policy");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self';");
  expect(csp).toContain("frame-ancestors 'none'");
}

describe("authorised share", () => {
  it("renders the tree and README with 200", async () => {
    const { response, body } = await get(seededBucket(), share("releases", "project-a"));
    expect(response.status).toBe(200);
    expectCommonHeaders(response);
    expect(response.headers.get("Content-Security-Policy")).toContain(`img-src 'self' ${PUBLIC_BASE}`);
    expect(body).toContain('<h1 class="hero__title">project-a</h1>');
    expect(body).toContain(`href="${PUBLIC_BASE}/releases/project-a/app-v1.zip"`);
    expect(body).toContain(`href="${PUBLIC_BASE}/releases/project-a/sub/notes.txt"`);
    expect(body).toContain('<h2 class="panel__title" id="readme-title">README.md</h2>');
    expect(body).toContain(`src="${PUBLIC_BASE}/releases/project-a/img/shot.png"`);
    expect(body).not.toContain("project-a2");
    expect(body).not.toContain(".r2-share-rules");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("lists only below the share root", async () => {
    const bucket = seededBucket();
    await get(bucket, share("releases", "project-a"));
    expect(bucket.listCalls.map((call) => call.prefix)).toEqual(["releases/project-a/"]);
  });

  it("serves descendants of a `/**` rule and hides excluded folders", async () => {
    const bucket = seededBucket();
    const root = await get(bucket, share("releases", "project-b"));
    expect(root.response.status).toBe(200);
    expect(root.body).toContain("one.txt");
    expect(root.body).not.toContain("secret.txt");
    const child = await get(bucket, share("releases", "project-b", "child"));
    expect(child.response.status).toBe(200);
    expect(child.body).toContain("two.txt");
  });

  it("shows the empty state for an authorised share without files", async () => {
    const { response, body } = await get(seededBucket(), share("empty"));
    expect(response.status).toBe(200);
    expect(body).toContain(EMPTY_TEXT);
    expect(body).not.toContain("panel--readme");
  });

  it("handles Unicode directory names", async () => {
    const bucket = new FakeBucket().put(".r2-share-rules", "專案/\n").put("專案/說明.txt", "x");
    const { response, body } = await get(bucket, share("專案"));
    expect(response.status).toBe(200);
    expect(body).toContain("說明.txt");
  });

  it("uses the configured rules key", async () => {
    const bucket = new FakeBucket().put("config/rules", "docs/\n").put("docs/a.txt", "a");
    const { response } = await get(bucket, share("docs"), { SHARE_RULES_KEY: "config/rules" });
    expect(response.status).toBe(200);
  });

  it("skips and logs a README over the size limit", async () => {
    const bucket = seededBucket().put("releases/project-a/README.md", "x".repeat(MAX_README_BYTES + 1));
    const { response, body } = await get(bucket, share("releases", "project-a"));
    expect(response.status).toBe(200);
    expect(body).not.toContain("panel--readme");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(bucket.getCalls).not.toContain("releases/project-a/README.md");
  });

  it("shows the Download all button only when ZIP is enabled", async () => {
    const off = await get(seededBucket(), share("releases", "project-a"));
    expect(off.body).not.toContain("/api/share-zip");
    const on = await get(seededBucket(), share("releases", "project-a"), { ENABLE_ZIP_DOWNLOAD: "true" });
    expect(on.body).toContain(`href="/api/share-zip?token=${encodeShareToken(["releases", "project-a"])}"`);
  });
});

describe("404", () => {
  it("rejects a child directory of an exact rule", async () => {
    const { response, body } = await get(seededBucket(), share("releases", "project-a", "sub"));
    expect(response.status).toBe(404);
    expectCommonHeaders(response);
    expect(body).toContain(NOT_FOUND_TITLE);
  });

  it("rejects a directory that does not exist", async () => {
    const { response } = await get(seededBucket(), share("nothing", "here"));
    expect(response.status).toBe(404);
  });

  it("rejects an excluded directory below a `/**` rule", async () => {
    const { response } = await get(seededBucket(), share("releases", "project-b", "private"));
    expect(response.status).toBe(404);
  });

  it("rejects a similar-prefix sibling", async () => {
    const { response } = await get(seededBucket(), share("releases", "project-a2"));
    expect(response.status).toBe(404);
  });

  it("denies everything when the rules file is missing, and logs it", async () => {
    const bucket = seededBucket(null);
    const { response } = await get(bucket, share("releases", "project-a"));
    expect(response.status).toBe(404);
    expect(bucket.listCalls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("missing");
  });

  it("denies everything when the rules file is invalid, and logs the problem", async () => {
    const bucket = seededBucket(`${RULES}\n  !releases/project-a/`);
    const { response, body } = await get(bucket, share("releases", "project-a"));
    expect(response.status).toBe(404);
    expect(bucket.listCalls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0]);
    expect(logged).toContain("invalid");
    expect(logged).toContain("line 5");
    expect(body).not.toContain("line 5");
  });

  it("returns a byte-identical page for every reason", async () => {
    const bodies = await Promise.all([
      get(seededBucket(), share("releases", "project-a", "sub")),
      get(seededBucket(), share("nothing")),
      get(seededBucket(), share("releases", "project-b", "private")),
      get(seededBucket(null), share("releases", "project-a")),
      get(seededBucket("[unclosed"), share("releases", "project-a")),
      get(seededBucket(), "/s/0OIl/"),
      get(seededBucket(), "/s/"),
    ]);
    for (const { response } of bodies) expect(response.status).toBe(404);
    const unique = new Set(bodies.map(({ body }) => body));
    expect(unique.size).toBe(1);
    const headerSets = new Set(bodies.map(({ response }) => JSON.stringify([...response.headers])));
    expect(headerSets.size).toBe(1);
  });

  it.each([
    ["non-Base58 character", "/s/0OIl/"],
    ["percent escape", `/s/${encodeShareToken(["releases", "project-a"]).replace("h", "%68")}/`],
    ["encoded slash", "/s/abc%2Fdef/"],
    ["two segments", `/s/${encodeShareToken(["releases"])}/project-a/`],
    ["empty segment", "/s//"],
    ["over the length limit", `/s/${"z".repeat(1401)}/`],
    ["token of an invalid path", `/s/${tokenOfBytes(new TextEncoder().encode("releases/../x"))}/`],
    ["token of invalid UTF-8", `/s/${tokenOfBytes(Uint8Array.of(0xff))}/`],
    ["bare /s/", "/s/"],
    ["bare /s without slash", "/s"],
    ["old /share/ route", "/share/releases/project-a/"],
    ["old /share/ route without slash", "/share/releases/project-a"],
  ])("rejects a bad path (%s) without touching R2", async (_name, path) => {
    const bucket = seededBucket();
    const { response } = await get(bucket, path);
    expect(response.status).toBe(404);
    expect(bucket.listCalls).toEqual([]);
    expect(bucket.getCalls).toEqual([]);
  });

  it("keeps the footer on the 404 page", async () => {
    const { body } = await get(seededBucket(), share("nothing"), { FOOTER_HTML: "<b>FOOT</b>" });
    expect(body).toContain('<footer class="footer"><b>FOOT</b> • Powered by');
  });
});

describe("missing trailing slash", () => {
  it("redirects a valid directory path to its canonical URL", async () => {
    const token = encodeShareToken(["releases", "project-a"]);
    const { response, body } = await get(seededBucket(), `/s/${token}`);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(`/s/${token}/`);
    expectCommonHeaders(response, null);
    expect(body).toBe("");
  });

  it("redirects before reading the rules, so it reveals nothing", async () => {
    const bucket = seededBucket();
    const { response } = await get(bucket, `/s/${encodeShareToken(["not", "shared"])}`);
    expect(response.status).toBe(308);
    expect(bucket.getCalls).toEqual([]);
  });

  it("does not redirect an invalid path", async () => {
    const { response } = await get(seededBucket(), "/s/abc%2Fdef");
    expect(response.status).toBe(404);
  });
});

describe("500", () => {
  it("returns the generic error page when listing fails", async () => {
    const bucket = seededBucket();
    bucket.failList = () => new Error(`${SECRET} list failed`);
    const { response, body } = await get(bucket, share("releases", "project-a"));
    expect(response.status).toBe(500);
    expectCommonHeaders(response);
    expect(body).toContain(ERROR_TITLE);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("project-a");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toContainEqual(expect.objectContaining({ message: `${SECRET} list failed` }));
  });

  it("returns the generic error page when reading the rules fails", async () => {
    const bucket = seededBucket();
    bucket.failGet = (key) => (key === ".r2-share-rules" ? new Error(SECRET) : undefined);
    const { response, body } = await get(bucket, share("releases", "project-a"));
    expect(response.status).toBe(500);
    expect(body).toContain(ERROR_TITLE);
    expect(body).not.toContain(SECRET);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the generic error page when reading the README fails", async () => {
    const bucket = seededBucket();
    bucket.failBody = (key) => (key.endsWith("README.md") ? new Error(SECRET) : undefined);
    const { response, body } = await get(bucket, share("releases", "project-a"));
    expect(response.status).toBe(500);
    expect(body).not.toContain(SECRET);
  });

  it("returns the generic error page when pagination does not advance", async () => {
    const bucket = seededBucket();
    bucket.mapList = (page) => ({ ...page, truncated: true, cursor: "same" }) as R2Objects;
    const { response } = await get(bucket, share("releases", "project-a"));
    expect(response.status).toBe(500);
  });

  it("returns the generic error page with the footer on a configuration error", async () => {
    const bucket = seededBucket();
    const { response, body } = await get(bucket, share("releases", "project-a"), {
      R2_PUBLIC_BASE_URL: "http://insecure.example.com",
      FOOTER_HTML: "<b>FOOT</b>",
      BRAND_NAME: "Jim Files",
      BRAND_URL: "https://jim.example.com/",
    });
    expect(response.status).toBe(500);
    expectCommonHeaders(response);
    expect(response.headers.get("Content-Security-Policy")).toContain("img-src 'self';");
    expect(body).toContain(ERROR_TITLE);
    expect(body).toContain('<footer class="footer"><b>FOOT</b> • Powered by');
    expect(body).toContain('<a class="brand" href="https://jim.example.com/">');
    expect(body).toContain('<span class="brand__name">Jim Files</span>');
    expect(body).not.toContain("insecure.example.com");
    expect(bucket.getCalls).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("shows only the credit on a configuration error when FOOTER_HTML is empty", async () => {
    const { response, body } = await get(seededBucket(), share("releases", "project-a"), {
      R2_PUBLIC_BASE_URL: undefined,
      FOOTER_HTML: "",
    });
    expect(response.status).toBe(500);
    expect(body).toContain('<footer class="footer">Powered by');
  });
});

describe("methods", () => {
  it("answers HEAD with the GET status and headers but no body", async () => {
    const getResponse = (await get(seededBucket(), share("releases", "project-a"))).response;
    const { response, body } = await get(seededBucket(), share("releases", "project-a"), {}, "HEAD");
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(body).toBe("");
    expect([...response.headers]).toEqual([...getResponse.headers]);
  });

  it("answers HEAD for a 404 without a body", async () => {
    const { response, body } = await get(seededBucket(), share("nothing"), {}, "HEAD");
    expect(response.status).toBe(404);
    expectCommonHeaders(response);
    expect(body).toBe("");
  });

  it("answers HEAD for a 500 without a body", async () => {
    const bucket = seededBucket();
    bucket.failList = () => new Error(SECRET);
    const { response, body } = await get(bucket, share("releases", "project-a"), {}, "HEAD");
    expect(response.status).toBe(500);
    expect(body).toBe("");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("rejects %s with 405 without touching R2", async (method) => {
    const bucket = seededBucket();
    const { response, body } = await get(bucket, share("releases", "project-a"), {}, method);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(ALLOWED_METHODS);
    expectCommonHeaders(response, "text/plain; charset=utf-8");
    expect(body).toBe("Method Not Allowed\n");
    expect(bucket.getCalls).toEqual([]);
    expect(bucket.listCalls).toEqual([]);
  });
});

describe("contentSecurityPolicy", () => {
  it("allows images from the R2 public origin only, and same-origin scripts only (Cloudflare /cdn-cgi/)", () => {
    expect(contentSecurityPolicy("https://files.example.com")).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; " +
        "img-src 'self' https://files.example.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("uses the origin of a public base URL with a path", async () => {
    const { response } = await get(seededBucket(), share("releases", "project-a"), {
      R2_PUBLIC_BASE_URL: "https://cdn.example.com/bucket/",
    });
    expect(response.headers.get("Content-Security-Policy")).toContain("img-src 'self' https://cdn.example.com;");
  });
});

describe("routes", () => {
  it("serves share pages from functions/s/ and has no functions/share/ route any more", async () => {
    const route = await import("../functions/s/[[path]]");
    expect(typeof route.onRequest).toBe("function");
    const oldRoute = "../functions/share/[[path]].ts";
    await expect(import(/* @vite-ignore */ oldRoute)).rejects.toThrow();
  });
});
