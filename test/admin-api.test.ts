import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { handleFoldersRequest, handleRulesRequest, MAX_PUT_BODY_BYTES } from "../src/admin-api";
import type { Env } from "../src/config";
import { MAX_RULES_FILE_BYTES } from "../src/rules";
import { FakeBucket } from "./fake-bucket";

const ORIGIN = "https://share.example.com";
const RULES_KEY = ".r2-share-rules";
const EMAIL = "admin@example.com";
const SAVED = new Date("2026-10-28T14:02:11Z");

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function envFor(bucket: FakeBucket, overrides: Partial<Omit<Env, "BUCKET">> = {}): Env {
  return { BUCKET: bucket.asR2Bucket(), ...overrides };
}

async function getRules(bucket: FakeBucket, overrides?: Partial<Omit<Env, "BUCKET">>, email: string | null = EMAIL) {
  const response = await handleRulesRequest(new Request(`${ORIGIN}/api/admin/rules`), envFor(bucket, overrides), email);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function putRules(bucket: FakeBucket, body: unknown, overrides?: Partial<Omit<Env, "BUCKET">>) {
  const request = new Request(`${ORIGIN}/api/admin/rules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await handleRulesRequest(request, envFor(bucket, overrides), EMAIL);
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function expectJsonHeaders(response: Response): void {
  expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

describe("GET /api/admin/rules", () => {
  it("returns the text, etag, save time and caller", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "a/\n", SAVED);
    const { response, body } = await getRules(bucket);
    expect(response.status).toBe(200);
    expectJsonHeaders(response);
    expect(body).toEqual({
      exists: true,
      text: "a/\n",
      etag: (await bucket.head(RULES_KEY))?.etag,
      savedAt: "2026-10-28T14:02:11.000Z",
      user: { email: EMAIL },
      brandName: "SIMPLE R2 SHARE",
      rulesKey: RULES_KEY,
    });
  });

  it("reports a missing file", async () => {
    const { body } = await getRules(new FakeBucket(), {}, null);
    expect(body).toMatchObject({ exists: false, text: "", etag: null, savedAt: null, user: { email: null } });
    expect(body).not.toHaveProperty("invalid");
  });

  it("uses the configured rules key and brand", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "a/\n").add("config/rules", "b/\n");
    const { body } = await getRules(bucket, { SHARE_RULES_KEY: "config/rules", BRAND_NAME: "Files" });
    expect(body).toMatchObject({ text: "b/\n", rulesKey: "config/rules", brandName: "Files" });
    expect(bucket.getCalls).toEqual(["config/rules"]);
  });

  it("returns text that parseRules rejects as is (the page reports it)", async () => {
    const { body } = await getRules(new FakeBucket().add(RULES_KEY, "[unclosed\n"));
    expect(body).toMatchObject({ exists: true, text: "[unclosed\n" });
    expect(body).not.toHaveProperty("invalid");
  });

  it("skips a UTF-8 BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a/\n")]);
    const { body } = await getRules(new FakeBucket().add(RULES_KEY, bytes));
    expect(body.text).toBe("a/\n");
  });

  it("marks a file over the size limit invalid without reading it", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "#".repeat(MAX_RULES_FILE_BYTES + 1));
    const { body } = await getRules(bucket);
    expect(body).toMatchObject({ exists: true, text: "", invalid: expect.stringContaining("larger") });
    expect(body.etag).toBeTypeOf("string");
  });

  it("marks a file that is not UTF-8 invalid", async () => {
    const { body } = await getRules(new FakeBucket().add(RULES_KEY, new Uint8Array([0x61, 0xff])));
    expect(body).toMatchObject({ exists: true, text: "", invalid: expect.stringContaining("UTF-8") });
  });

  it("answers 500 without details when R2 fails", async () => {
    const bucket = new FakeBucket();
    bucket.failGet = () => new Error("SECRET r2 detail");
    const { response, body } = await getRules(bucket);
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "internal" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("answers 405 with Allow for other methods", async () => {
    const request = new Request(`${ORIGIN}/api/admin/rules`, { method: "DELETE" });
    const response = await handleRulesRequest(request, envFor(new FakeBucket()), EMAIL);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, PUT");
    expectJsonHeaders(response);
  });
});

describe("PUT /api/admin/rules", () => {
  it("creates the file when it does not exist", async () => {
    const bucket = new FakeBucket();
    bucket.now = () => SAVED;
    const { response, body } = await putRules(bucket, { text: "a/\n", etag: null });
    expect(response.status).toBe(200);
    expectJsonHeaders(response);
    const stored = await bucket.head(RULES_KEY);
    expect(body).toEqual({ etag: stored?.etag, savedAt: "2026-10-28T14:02:11.000Z" });
    expect(await (await bucket.get(RULES_KEY))?.text()).toBe("a/\n");
    expect(bucket.contentTypeOf(RULES_KEY)).toBe("text/plain; charset=utf-8");
  });

  it("refuses to create over a file someone else created", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "theirs/\n");
    const { response, body } = await putRules(bucket, { text: "mine/\n", etag: null });
    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "conflict" });
    expect(await (await bucket.get(RULES_KEY))?.text()).toBe("theirs/\n");
  });

  it("updates over the version that was read and returns the new etag", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "a/\n");
    const read = await getRules(bucket);
    const { response, body } = await putRules(bucket, { text: "b/\n", etag: read.body.etag });
    expect(response.status).toBe(200);
    expect(body.etag).not.toBe(read.body.etag);
    expect((await getRules(bucket)).body.text).toBe("b/\n");
  });

  it("gives the later of two concurrent saves a 409", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "a/\n");
    const { etag } = (await getRules(bucket)).body;
    const first = await putRules(bucket, { text: "first/\n", etag });
    const second = await putRules(bucket, { text: "second/\n", etag });
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(409);
    expect((await getRules(bucket)).body.text).toBe("first/\n");
  });

  it("writes only the configured rules key", async () => {
    const bucket = new FakeBucket();
    await putRules(bucket, { text: "a/\n", etag: null }, { SHARE_RULES_KEY: "config/rules" });
    expect(bucket.putCalls.map((call) => call.key)).toEqual(["config/rules"]);
  });

  it.each([
    ["not JSON", "{"],
    ["a JSON array", "[]"],
    ["null", "null"],
    ["missing text", { etag: null }],
    ["text not a string", { text: 1, etag: null }],
    ["missing etag", { text: "a/\n" }],
    ["etag a number", { text: "a/\n", etag: 1 }],
  ])("answers 400 for %s", async (_label, body) => {
    const bucket = new FakeBucket();
    const result = await putRules(bucket, body);
    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({ error: "bad_request" });
    expect(bucket.putCalls).toEqual([]);
  });

  it("answers 400 with the line for rules parseRules rejects", async () => {
    const bucket = new FakeBucket();
    const { response, body } = await putRules(bucket, { text: "a/\n[unclosed\n", etag: null });
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_rules", problem: expect.stringMatching(/^line 2:/) });
    expect(bucket.putCalls).toEqual([]);
  });

  it("answers 400 for rules over the size limit", async () => {
    const text = `#${"x".repeat(MAX_RULES_FILE_BYTES)}\n`;
    const { response, body } = await putRules(new FakeBucket(), { text, etag: null });
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_rules" });
  });

  it("answers 413 for a body over the limit without parsing it", async () => {
    const bucket = new FakeBucket();
    const { response, body } = await putRules(bucket, JSON.stringify({ text: "x".repeat(MAX_PUT_BODY_BYTES), etag: null }));
    expect(response.status).toBe(413);
    expect(body).toEqual({ error: "too_large" });
    expect(bucket.putCalls).toEqual([]);
  });

  it("answers 413 for a streamed body over the limit", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        if (sent > 3) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request(`${ORIGIN}/api/admin/rules`, {
      method: "PUT",
      body: stream,
      headers: { "Content-Type": "application/json" },
      duplex: "half",
    } as RequestInit);
    const response = await handleRulesRequest(request, envFor(new FakeBucket()), EMAIL);
    expect(response.status).toBe(413);
  });

  it("answers 500 when the write fails", async () => {
    const bucket = new FakeBucket();
    bucket.failPut = () => new Error("SECRET");
    const { response, body } = await putRules(bucket, { text: "a/\n", etag: null });
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "internal" });
  });
});

describe("GET /api/admin/folders", () => {
  async function folders(bucket: FakeBucket, query: string) {
    const response = await handleFoldersRequest(new Request(`${ORIGIN}/api/admin/folders${query}`), envFor(bucket));
    return { response, body: (await response.json()) as { folders?: string[]; cursor?: string | null; error?: string } };
  }

  const seeded = () =>
    new FakeBucket()
      .add(RULES_KEY, "a/\n")
      .add("releases/project-a/app.zip")
      .add("releases/project-b/x/y.txt")
      .add("releases/readme.txt")
      .add("發佈/專案 A/說明.txt")
      .add("top.txt");

  it("lists the first level when prefix is empty or missing", async () => {
    for (const query of ["", "?prefix="]) {
      const { response, body } = await folders(seeded(), query);
      expect(response.status).toBe(200);
      expectJsonHeaders(response);
      expect(body).toEqual({ folders: ["releases", "發佈"], cursor: null });
    }
  });

  it("lists one level below a prefix and makes one R2 call", async () => {
    const bucket = seeded();
    const { body } = await folders(bucket, `?prefix=${encodeURIComponent("releases/")}`);
    expect(body).toEqual({ folders: ["project-a", "project-b"], cursor: null });
    expect(bucket.listCalls).toEqual([{ prefix: "releases/", delimiter: "/", limit: 1000 }]);
  });

  it("handles Unicode prefixes", async () => {
    const { body } = await folders(seeded(), `?prefix=${encodeURIComponent("發佈/")}`);
    expect(body.folders).toEqual(["專案 A"]);
  });

  it("drops names that are not valid folder names", async () => {
    const bucket = new FakeBucket().add("ok/x").add("a\\b/x").add("ctl\u0001/x").add("//x").add("./x").add("../x");
    const { body } = await folders(bucket, "");
    expect(body.folders).toEqual(["ok"]);
  });

  it("pages with the cursor", async () => {
    const bucket = new FakeBucket({ pageSize: 2 });
    for (const name of ["a", "b", "c", "d", "e"]) bucket.add(`p/${name}/x`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?prefix=p%2F${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const { body } = await folders(bucket, query);
      seen.push(...(body.folders ?? []));
      cursor = body.cursor ?? null;
    } while (cursor !== null);
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(bucket.listCalls).toHaveLength(3);
  });

  it.each([
    ["no trailing slash", "?prefix=releases"],
    ["leading slash", "?prefix=%2Freleases%2F"],
    ["dot-dot", "?prefix=..%2F"],
    ["empty segment", "?prefix=a%2F%2F"],
    ["backslash", "?prefix=a%5Cb%2F"],
    ["two prefixes", "?prefix=&prefix=a%2F"],
    ["two cursors", "?cursor=a&cursor=b"],
  ])("answers 400 for %s without touching R2", async (_label, query) => {
    const bucket = seeded();
    const { response, body } = await folders(bucket, query);
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "bad_request" });
    expect(bucket.listCalls).toEqual([]);
  });

  it("answers 500 when listing fails", async () => {
    const bucket = seeded();
    bucket.failList = () => new Error("SECRET");
    const { response, body } = await folders(bucket, "");
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "internal" });
  });

  it("answers 405 for other methods", async () => {
    const request = new Request(`${ORIGIN}/api/admin/folders`, { method: "POST" });
    const response = await handleFoldersRequest(request, envFor(seeded()));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });
});
