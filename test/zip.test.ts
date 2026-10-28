import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Env } from "../src/config";
import { ERROR_TITLE } from "../src/html";
import { ALLOWED_METHODS, handleShareRequest } from "../src/share-handler";
import { contentDisposition, handleZipRequest, ZIP_SUBREQUEST_BUDGET } from "../src/zip-handler";
import { assertSafeEntryName, createZipStream, predictZipLength } from "../src/zip-stream";
import { encodeShareToken } from "../src/short-url";
import { FakeBucket } from "./fake-bucket";
import { tokenOfBytes } from "./tokens";

const ORIGIN = "https://share.example.com";
const PUBLIC_BASE = "https://files.example.com";
const NOW = new Date("2026-10-27T08:30:00Z");
const RULES_KEY = ".r2-share-rules";
const RULES = ["releases/project-a/", "releases/project-b/**", "!releases/project-b/private/", "empty/"].join("\n");
const SECRET = "SECRET-DETAIL-r2-internal";
const ZIP_ON = { ENABLE_ZIP_DOWNLOAD: "true" };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** project-a: README, nested folders, Chinese names, an excluded folder and file. */
const PROJECT_A: Record<string, string> = {
  "README.md": "# Project A\n",
  "app-v1.zip": "zip-bytes",
  "docs/guide.txt": "guide",
  "docs/深層/說明.txt": "中文內容",
  "專案資料/報告 2026.txt": "report",
  "empty.txt": "",
  "private/secret.txt": "secret",
  "notes.tmp": "tmp",
};

function seededBucket(rules: string | null = `${RULES}\n!releases/project-a/private/\n!releases/project-a/*.tmp`) {
  const bucket = new FakeBucket();
  if (rules !== null) bucket.put(RULES_KEY, rules);
  for (const [path, body] of Object.entries(PROJECT_A)) {
    bucket.put(`releases/project-a/${path}`, body, new Date("2026-10-20T12:34:56Z"));
  }
  bucket
    .put("releases/project-a/", "") // directory marker
    .put("releases/project-a2/other.txt", "x")
    .put("releases/project-b/one.txt", "1")
    .put("releases/project-b/private/secret.txt", "s");
  return bucket;
}

function envFor(bucket: FakeBucket, overrides: Partial<Omit<Env, "BUCKET">> = ZIP_ON): Env {
  return { BUCKET: bucket.asR2Bucket(), R2_PUBLIC_BASE_URL: PUBLIC_BASE, ...overrides };
}

function zipRequest(query: string, method = "GET"): Request {
  return new Request(`${ORIGIN}/api/share-zip${query}`, { method });
}

/** The ZIP query for a folder path such as `releases/project-a`. */
function zipQuery(dir: string): string {
  return `?token=${encodeShareToken(dir.split("/"))}`;
}

const NOT_SHARED_PAGE = `/s/${encodeShareToken(["nothing"])}/`;

function fetchZip(bucket: FakeBucket, query: string, overrides?: Partial<Omit<Env, "BUCKET">>, method?: string) {
  return handleZipRequest(zipRequest(query, method), envFor(bucket, overrides), NOW);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Keys the handler fetched with `get`, apart from the rules file. */
function objectGets(bucket: FakeBucket): string[] {
  return bucket.getCalls.filter((key) => key !== RULES_KEY);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly size: number;
  readonly data: Uint8Array;
}

/**
 * Minimal reader for the archives this project writes (no ZIP64, no comment):
 * walks the central directory, checks each local header and data descriptor
 * against it and returns the entries in archive order.
 */
function parseZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const eocd = bytes.byteLength - 22;
  expect(u32(eocd)).toBe(0x06054b50);
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  expect(cdOffset + cdSize).toBe(eocd);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(u32(p)).toBe(0x02014b50);
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const compressed = u32(p + 20);
    const size = u32(p + 24);
    const nameLength = u16(p + 28);
    const extraLength = u16(p + 30);
    const commentLength = u16(p + 32);
    const local = u32(p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;

    expect(u32(local)).toBe(0x04034b50);
    expect(u16(local + 6)).toBe(flags);
    expect(u16(local + 8)).toBe(method);
    const localNameLength = u16(local + 26);
    expect(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength))).toBe(name);
    const dataStart = local + 30 + localNameLength + u16(local + 28);
    const data = bytes.subarray(dataStart, dataStart + compressed);

    const descriptor = dataStart + compressed;
    expect(u32(descriptor)).toBe(0x08074b50);
    expect(u32(descriptor + 4)).toBe(crc);
    expect(u32(descriptor + 8)).toBe(compressed);
    expect(u32(descriptor + 12)).toBe(size);
    expect(compressed).toBe(size);
    entries.push({ name, method, flags, crc, size, data });
  }
  expect(p).toBe(eocd);
  return entries;
}

describe("ZIP disabled", () => {
  it.each([undefined, "false", "TRUE", "1"])(
    "answers ENABLE_ZIP_DOWNLOAD=%s with the share route's 404 and no R2 call",
    async (flag) => {
      const bucket = seededBucket();
      const overrides = { ENABLE_ZIP_DOWNLOAD: flag };
      const response = await fetchZip(bucket, zipQuery("releases/project-a"), overrides);
      const share = await handleShareRequest(
        new Request(`${ORIGIN}${NOT_SHARED_PAGE}`),
        envFor(seededBucket(), overrides),
        NOW,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(await share.text());
      expect([...response.headers]).toEqual([...share.headers]);
      expect(bucket.getCalls).toEqual([]);
      expect(bucket.listCalls).toEqual([]);
    },
  );
});

describe("404", () => {
  async function shareNotFound(): Promise<{ body: string; headers: [string, string][] }> {
    const response = await handleShareRequest(new Request(`${ORIGIN}${NOT_SHARED_PAGE}`), envFor(seededBucket()), NOW);
    return { body: await response.text(), headers: [...response.headers] };
  }

  it.each([
    ["missing token", ""],
    ["empty token", "?token="],
    ["other parameter only", `?t=${encodeShareToken(["releases", "project-a"])}`],
    ["old dir parameter", "?dir=releases%2Fproject-a"],
    ["duplicate token", `${zipQuery("releases/project-a")}&token=${encodeShareToken(["releases", "project-a"])}`],
    ["non-Base58 character", "?token=0OIl"],
    ["over the length limit", `?token=${"z".repeat(1401)}`],
    ["token of a dot-dot path", `?token=${tokenOfBytes(new TextEncoder().encode("releases/../releases/project-a"))}`],
    ["token of an empty segment", `?token=${tokenOfBytes(new TextEncoder().encode("releases//project-a"))}`],
    ["token of a trailing slash", `?token=${tokenOfBytes(new TextEncoder().encode("releases/project-a/"))}`],
    ["token of invalid UTF-8", `?token=${tokenOfBytes(Uint8Array.of(0xff, 0xfe))}`],
  ])("rejects a bad token (%s) without touching R2", async (_name, query) => {
    const bucket = seededBucket();
    const response = await fetchZip(bucket, query);
    expect(response.status).toBe(404);
    const expected = await shareNotFound();
    expect(await response.text()).toBe(expected.body);
    expect([...response.headers]).toEqual(expected.headers);
    expect(bucket.getCalls).toEqual([]);
    expect(bucket.listCalls).toEqual([]);
  });

  it.each([
    ["child of an exact rule", "releases/project-a/docs", RULES],
    ["excluded folder below `/**`", "releases/project-b/private", RULES],
    ["similar-prefix sibling", "releases/project-a2", RULES],
    ["unknown folder", "nothing/here", RULES],
    ["missing rules", "releases/project-a", null],
    ["invalid rules", "releases/project-a", "[unclosed"],
  ])("rejects an unauthorised dir (%s) like the share route, without listing", async (_name, dir, rules) => {
    const bucket = seededBucket(rules);
    const response = await fetchZip(bucket, zipQuery(dir));
    expect(response.status).toBe(404);
    const expected = await shareNotFound();
    expect(await response.text()).toBe(expected.body);
    expect([...response.headers]).toEqual(expected.headers);
    expect(bucket.listCalls).toEqual([]);
    expect(objectGets(bucket)).toEqual([]);
  });

  it("answers an authorised share without files with 404", async () => {
    const bucket = seededBucket().put("empty/", "");
    const response = await fetchZip(bucket, zipQuery("empty"));
    expect(response.status).toBe(404);
    expect(objectGets(bucket)).toEqual([]);
  });

  it("answers an authorised share whose files are all excluded with 404", async () => {
    const bucket = seededBucket().put("releases/project-b/private/only.txt", "x");
    bucket.put(RULES_KEY, "releases/project-b/private2/\n!releases/project-b/private2/x\n");
    bucket.put("releases/project-b/private2/x", "x");
    const response = await fetchZip(bucket, zipQuery("releases/project-b/private2"));
    expect(response.status).toBe(404);
  });
});

describe("successful download", () => {
  it("streams a STORE ZIP of every listed file with paths relative to the share root", async () => {
    const bucket = seededBucket();
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    expect(response.status).toBe(200);
    const bytes = await readAll(response.body as ReadableStream<Uint8Array>);
    const entries = parseZip(bytes);

    // Listing display order: folders first (the zh-Hant-TW collator puts Han before Latin), then files.
    expect(entries.map((entry) => entry.name)).toEqual([
      "專案資料/報告 2026.txt",
      "docs/深層/說明.txt",
      "docs/guide.txt",
      "app-v1.zip",
      "empty.txt",
      "README.md",
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.flags & 0x0800).toBe(0x0800); // UTF-8 names
      expect(entry.name.startsWith("/")).toBe(false);
      expect(entry.name.split("/")).not.toContain("..");
      const expected = encoder.encode(PROJECT_A[entry.name] as string);
      expect(entry.data).toEqual(expected);
      expect(entry.size).toBe(expected.byteLength);
      expect(entry.crc).toBe(crc32(expected));
    }
    expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("only lists below the share root and fetches each file once, in order", async () => {
    const bucket = seededBucket();
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    await readAll(response.body as ReadableStream<Uint8Array>);
    expect(bucket.listCalls.map((call) => call.prefix)).toEqual(["releases/project-a/"]);
    expect(objectGets(bucket)).toEqual([
      "releases/project-a/專案資料/報告 2026.txt",
      "releases/project-a/docs/深層/說明.txt",
      "releases/project-a/docs/guide.txt",
      "releases/project-a/app-v1.zip",
      "releases/project-a/empty.txt",
      "releases/project-a/README.md",
    ]);
  });

  it("serves descendants of a `/**` rule without excluded folders", async () => {
    const bucket = seededBucket().put("releases/project-b/child/two.txt", "2");
    const response = await fetchZip(bucket, zipQuery("releases/project-b"));
    const entries = parseZip(await readAll(response.body as ReadableStream<Uint8Array>));
    expect(entries.map((entry) => entry.name)).toEqual(["child/two.txt", "one.txt"]);
    const child = await fetchZip(bucket, zipQuery("releases/project-b/child"));
    expect(parseZip(await readAll(child.body as ReadableStream<Uint8Array>)).map((e) => e.name)).toEqual(["two.txt"]);
  });

  it("never includes the rules object, even when it lies inside the share", async () => {
    const bucket = new FakeBucket()
      .put("share/.rules", "share/\n")
      .put("share/a.txt", "a")
      .put("share/README", "readme");
    const response = await fetchZip(bucket, zipQuery("share"), { ...ZIP_ON, SHARE_RULES_KEY: "share/.rules" });
    const entries = parseZip(await readAll(response.body as ReadableStream<Uint8Array>));
    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "README"]);
  });

  it("keeps both a file `a` and a folder `a/`", async () => {
    const bucket = new FakeBucket().put(RULES_KEY, "s/\n").put("s/a", "file").put("s/a/b", "nested");
    const response = await fetchZip(bucket, zipQuery("s"));
    const entries = parseZip(await readAll(response.body as ReadableStream<Uint8Array>));
    expect(entries.map((entry) => entry.name)).toEqual(["a/b", "a"]);
  });

  it("works for a Unicode share root", async () => {
    const bucket = new FakeBucket().put(RULES_KEY, "發布/專案/\n").put("發布/專案/說明.txt", "內容");
    const response = await fetchZip(bucket, zipQuery("發布/專案"));
    expect(response.status).toBe(200);
    const entries = parseZip(await readAll(response.body as ReadableStream<Uint8Array>));
    expect(entries.map((entry) => entry.name)).toEqual(["說明.txt"]);
  });

  it("sets download and security headers", async () => {
    const response = await fetchZip(seededBucket(), zipQuery("releases/project-a"));
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"project-a.zip\"; filename*=UTF-8''project-a.zip",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    await response.body?.cancel();
  });

  it("encodes a Chinese last segment in Content-Disposition", async () => {
    const bucket = new FakeBucket().put(RULES_KEY, "發布/專案 A/\n").put("發布/專案 A/x.txt", "x");
    const response = await fetchZip(bucket, zipQuery("發布/專案 A"));
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"__ A.zip\"; filename*=UTF-8''%E5%B0%88%E6%A1%88%20A.zip",
    );
    await response.body?.cancel();
  });

  it("escapes a quote in Content-Disposition", async () => {
    const bucket = new FakeBucket().put(RULES_KEY, 'say "hi"/\n').put('say "hi"/x.txt', "x");
    const response = await fetchZip(bucket, zipQuery('say "hi"'));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"say _hi_.zip\"; filename*=UTF-8''say%20%22hi%22.zip",
    );
    await response.body?.cancel();
  });

  it("fetches objects lazily as the stream is read", async () => {
    const bucket = new FakeBucket().put(RULES_KEY, "many/\n");
    for (let i = 0; i < 20; i++) bucket.put(`many/file-${String(i).padStart(2, "0")}.txt`, `content ${i}`);
    const response = await fetchZip(bucket, zipQuery("many"));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(objectGets(bucket).length).toBeGreaterThan(0);
    expect(objectGets(bucket).length).toBeLessThan(5);
    await reader.cancel();
  });

  it("uses the Workers FixedLengthStream with the predicted length when available", async () => {
    const lengths: Array<number | bigint> = [];
    class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
      constructor(length: number | bigint) {
        super();
        lengths.push(length);
      }
    }
    vi.stubGlobal("FixedLengthStream", FakeFixedLengthStream);
    const response = await fetchZip(seededBucket(), zipQuery("releases/project-a"));
    const bytes = await readAll(response.body as ReadableStream<Uint8Array>);
    expect(lengths).toEqual([BigInt(bytes.byteLength)]);
    expect(parseZip(bytes)).toHaveLength(6);
  });
});

describe("HEAD", () => {
  it("returns the GET headers without a body and without reading any object", async () => {
    const getResponse = await fetchZip(seededBucket(), zipQuery("releases/project-a"));
    const getBytes = await readAll(getResponse.body as ReadableStream<Uint8Array>);
    const bucket = seededBucket();
    const response = await fetchZip(bucket, zipQuery("releases/project-a"), ZIP_ON, "HEAD");
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect([...response.headers]).toEqual([...getResponse.headers]);
    expect(response.headers.get("Content-Length")).toBe(String(getBytes.byteLength));
    expect(objectGets(bucket)).toEqual([]);
  });

  it("answers HEAD for a 404 without a body", async () => {
    const response = await fetchZip(seededBucket(), zipQuery("nothing"), ZIP_ON, "HEAD");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

describe("errors before streaming", () => {
  it("returns the generic error page when listing fails", async () => {
    const bucket = seededBucket();
    bucket.failList = () => new Error(`${SECRET} list failed`);
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toContain(ERROR_TITLE);
    expect(body).not.toContain(SECRET);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the generic error page when reading the rules fails", async () => {
    const bucket = seededBucket();
    bucket.failGet = (key) => (key === RULES_KEY ? new Error(SECRET) : undefined);
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(SECRET);
  });

  it("returns the generic error page on a configuration error", async () => {
    const bucket = seededBucket();
    const response = await fetchZip(bucket, zipQuery("releases/project-a"), { ...ZIP_ON, R2_PUBLIC_BASE_URL: "http://x" });
    expect(response.status).toBe(500);
    expect(bucket.getCalls).toEqual([]);
  });

  it("refuses a share that would exceed the subrequest budget, before reading any object", async () => {
    // 1 rules get + 1 list page + files.
    const bucket = new FakeBucket().put(RULES_KEY, "big/\n");
    const fileCount = ZIP_SUBREQUEST_BUDGET - 1;
    for (let i = 0; i < fileCount; i++) bucket.put(`big/${i}.txt`, "x");
    const response = await fetchZip(bucket, zipQuery("big"));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain(ERROR_TITLE);
    expect(objectGets(bucket)).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain(`budget of ${ZIP_SUBREQUEST_BUDGET}`);
  });

  it("counts every list page against the budget", async () => {
    const bucket = new FakeBucket().put(RULES_KEY, "big/\n");
    for (let i = 0; i < 850; i++) bucket.put(`big/${String(i).padStart(3, "0")}.txt`, "x");
    // 1 rules get + 1 list page + 850 gets = 852: fine.
    const ok = await fetchZip(bucket, zipQuery("big"));
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    // 1 rules get + 95 list pages + 850 gets = 946: over.
    bucket.pageSize = 9;
    const tooMany = await fetchZip(bucket, zipQuery("big"));
    expect(tooMany.status).toBe(500);
    expect(String(errorSpy.mock.calls.at(-1)?.[1])).toContain("needs 946 R2 subrequests (96 so far + 850 files)");
  });

  it("allows a share exactly at the budget", async () => {
    const bucket = new FakeBucket().put(RULES_KEY, "big/\n");
    for (let i = 0; i < ZIP_SUBREQUEST_BUDGET - 2; i++) bucket.put(`big/${i}.txt`, "x");
    const response = await fetchZip(bucket, zipQuery("big"));
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
});

describe("errors while streaming", () => {
  async function expectBrokenStream(response: Response, message: RegExp): Promise<void> {
    expect(response.status).toBe(200);
    await expect(readAll(response.body as ReadableStream<Uint8Array>)).rejects.toThrow(message);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledTimes(1));
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("share zip: stream aborted");
  }

  it("errors the stream when an object vanishes after listing", async () => {
    const bucket = seededBucket();
    const vanished = "releases/project-a/app-v1.zip";
    bucket.failGet = (key) => {
      if (key === vanished) bucket.objects.delete(key);
      return undefined;
    };
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    await expectBrokenStream(response, /disappeared after listing/);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('"app-v1.zip"');
    // Nothing after the vanished object is fetched.
    expect(objectGets(bucket).at(-1)).toBe(vanished);
  });

  it("errors the stream when an object's size changed after listing", async () => {
    const bucket = seededBucket();
    bucket.mapList = (page) =>
      ({
        ...page,
        objects: page.objects.map((object) =>
          object.key.endsWith("guide.txt") ? { ...object, size: object.size + 1 } : object,
        ),
      }) as R2Objects;
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    await expectBrokenStream(response, /changed size after listing/);
  });

  it("errors the stream when a body is shorter than its reported size", async () => {
    const bucket = seededBucket();
    const short = "releases/project-a/README.md";
    bucket.mapList = (page) =>
      ({
        ...page,
        objects: page.objects.map((object) => (object.key === short ? { ...object, size: object.size + 3 } : object)),
      }) as R2Objects;
    const get = bucket.get.bind(bucket);
    bucket.get = async (key: string) => {
      const object = await get(key);
      return object !== null && key === short ? Object.assign(object, { size: object.size + 3 }) : object;
    };
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    await expectBrokenStream(response, /predicted/);
  });

  it("errors the stream when reading a body fails", async () => {
    const bucket = seededBucket();
    bucket.failBody = (key) => (key.endsWith("guide.txt") ? new Error(`${SECRET} read failed`) : undefined);
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    await expectBrokenStream(response, /read failed/);
  });

  it("errors the stream when get rejects", async () => {
    const bucket = seededBucket();
    bucket.failGet = (key) => (key.endsWith("empty.txt") ? new Error("get failed") : undefined);
    const response = await fetchZip(bucket, zipQuery("releases/project-a"));
    await expectBrokenStream(response, /get failed/);
  });
});

describe("methods", () => {
  it.each(["POST", "PUT", "DELETE"])("rejects %s with 405 without touching R2", async (method) => {
    const bucket = seededBucket();
    const response = await fetchZip(bucket, zipQuery("releases/project-a"), ZIP_ON, method);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe(ALLOWED_METHODS);
    expect(bucket.getCalls).toEqual([]);
    expect(bucket.listCalls).toEqual([]);
  });
});

describe("contentDisposition", () => {
  it.each([
    ["project-a", "attachment; filename=\"project-a.zip\"; filename*=UTF-8''project-a.zip"],
    ["專案", "attachment; filename=\"__.zip\"; filename*=UTF-8''%E5%B0%88%E6%A1%88.zip"],
    ["a\"b\\c", "attachment; filename=\"a_b_c.zip\"; filename*=UTF-8''a%22b%5Cc.zip"],
    ["it's (1)*", "attachment; filename=\"it's (1)*.zip\"; filename*=UTF-8''it%27s%20%281%29%2A.zip"],
    ["😀x", "attachment; filename=\"_x.zip\"; filename*=UTF-8''%F0%9F%98%80x.zip"],
    ["tab\there", "attachment; filename=\"tab_here.zip\"; filename*=UTF-8''tab%09here.zip"],
  ])("formats %j", (name, expected) => {
    expect(contentDisposition(name)).toBe(expected);
  });
});

describe("zip-stream", () => {
  it.each(["/a", "../a", "a/../b", "a//b", "a\\b", "", "a/", "./a", "a\u0000"])(
    "refuses the unsafe entry name %j",
    (name) => {
      expect(() => assertSafeEntryName(name)).toThrow(TypeError);
      const file = { path: name, key: `x/${name}`, size: 0, uploaded: new Date(0) };
      expect(() => createZipStream(new FakeBucket().asR2Bucket(), [file], () => undefined)).toThrow(TypeError);
    },
  );

  it("accepts nested and Unicode entry names", () => {
    expect(() => assertSafeEntryName("a/b/c.txt")).not.toThrow();
    expect(() => assertSafeEntryName("專案/說明 1.txt")).not.toThrow();
  });

  it("predicts the ZIP64 records for an entry of 4 GiB or more", () => {
    const file = (size: number) => [{ path: "big.bin", key: "x/big.bin", size, uploaded: new Date(0) }];
    const empty = predictZipLength(file(0));
    const below = predictZipLength(file(0xfffffffe));
    const at = predictZipLength(file(0xffffffff));
    // The central directory now starts beyond 4 GiB: +76 for the ZIP64 end records.
    expect(below - empty).toBe(0xfffffffen + 76n);
    // The entry itself needs ZIP64: +1 data byte, +8 for 64-bit descriptor sizes, +28 ZIP64 extra field.
    expect(at - below).toBe(1n + 8n + 28n);
  });
});
