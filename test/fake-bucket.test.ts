import { describe, expect, it } from "vitest";
import { FakeBucket } from "./fake-bucket";

describe("FakeBucket.put", () => {
  it("writes an object with a new etag and upload time each time", async () => {
    const bucket = new FakeBucket();
    bucket.now = () => new Date("2026-10-28T10:00:00Z");
    const first = await bucket.put("k", "one", { httpMetadata: { contentType: "text/plain" } });
    const second = await bucket.put("k", "two");
    expect(first?.etag).not.toBe(second?.etag);
    expect(second?.uploaded).toEqual(new Date("2026-10-28T10:00:00Z"));
    const object = await bucket.get("k");
    expect(await object?.text()).toBe("two");
    expect(object?.etag).toBe(second?.etag);
    expect(object?.httpEtag).toBe(`"${second?.etag}"`);
    expect((await bucket.head("k"))?.size).toBe(3);
    expect(bucket.contentTypeOf("k")).toBeUndefined();
  });

  it("gives seeded objects their own etags", async () => {
    const bucket = new FakeBucket().add("a", "1").add("b", "2");
    expect((await bucket.head("a"))?.etag).not.toBe((await bucket.head("b"))?.etag);
    expect(await bucket.head("missing")).toBeNull();
  });

  it("honours etagMatches and etagDoesNotMatch", async () => {
    const bucket = new FakeBucket().add("k", "v1");
    const etag = (await bucket.head("k"))?.etag as string;
    expect(await bucket.put("k", "x", { onlyIf: { etagMatches: "other" } })).toBeNull();
    expect(await bucket.put("missing", "x", { onlyIf: { etagMatches: etag } })).toBeNull();
    expect(await bucket.put("k", "x", { onlyIf: { etagDoesNotMatch: etag } })).toBeNull();
    expect(await (await bucket.get("k"))?.text()).toBe("v1");
    const written = await bucket.put("k", "v2", { onlyIf: { etagMatches: etag } });
    expect(written).not.toBeNull();
    // The old etag is stale now.
    expect(await bucket.put("k", "v3", { onlyIf: { etagMatches: etag } })).toBeNull();
  });

  it("honours If-Match and If-None-Match: * headers", async () => {
    const bucket = new FakeBucket();
    const create = () => bucket.put("k", "v", { onlyIf: new Headers({ "If-None-Match": "*" }) });
    const created = await create();
    expect(created).not.toBeNull();
    expect(await create()).toBeNull();
    expect(await bucket.put("k", "x", { onlyIf: new Headers({ "If-Match": '"stale"' }) })).toBeNull();
    expect(await bucket.put("k", "x", { onlyIf: new Headers({ "If-Match": created?.httpEtag as string }) })).not.toBeNull();
  });

  it("records calls and can fail", async () => {
    const bucket = new FakeBucket();
    bucket.failPut = (key) => (key === "bad" ? new Error("R2 down") : undefined);
    await expect(bucket.put("bad", "x")).rejects.toThrow("R2 down");
    expect(bucket.objects.has("bad")).toBe(false);
    await bucket.put("good", "x", { httpMetadata: { contentType: "text/plain" } });
    expect(bucket.putCalls.map((call) => call.key)).toEqual(["bad", "good"]);
    expect(bucket.contentTypeOf("good")).toBe("text/plain");
  });
});

describe("FakeBucket.list with a delimiter", () => {
  const seeded = () =>
    new FakeBucket()
      .add("a-b/x")
      .add("a/1")
      .add("a/2/deep")
      .add("a/3/x")
      .add("a/3/y")
      .add("a/file")
      .add("b/x")
      .add("root.txt");

  it("rolls keys up into delimitedPrefixes", async () => {
    const page = await seeded().list({ delimiter: "/" });
    expect(page.delimitedPrefixes).toEqual(["a-b/", "a/", "b/"]);
    expect(page.objects.map((object) => object.key)).toEqual(["root.txt"]);
    expect(page.truncated).toBe(false);
  });

  it("lists one level below a prefix", async () => {
    const page = await seeded().list({ prefix: "a/", delimiter: "/" });
    expect(page.delimitedPrefixes).toEqual(["a/2/", "a/3/"]);
    expect(page.objects.map((object) => object.key)).toEqual(["a/1", "a/file"]);
  });

  it("pages through objects and prefixes together", async () => {
    const bucket = seeded();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ prefix: "a/", delimiter: "/", limit: 1, cursor });
      seen.push(...page.objects.map((object) => object.key), ...page.delimitedPrefixes);
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    expect(seen).toEqual(["a/1", "a/2/", "a/3/", "a/file"]);
  });
});
