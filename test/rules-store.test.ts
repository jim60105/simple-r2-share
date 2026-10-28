import { describe, expect, it } from "vitest";
import { MAX_RULES_FILE_BYTES } from "../src/rules";
import { loadRules, RulesReadError } from "../src/rules-store";
import { FakeBucket } from "./fake-bucket";

const RULES_KEY = ".r2-share-rules";
const RULES = "releases/project-a/\n!releases/project-a/private/\n";

describe("loadRules", () => {
  it("loads and parses the rules object", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, RULES);
    const r = await loadRules(bucket.asR2Bucket(), RULES_KEY);
    expect(r.status).toBe("loaded");
    expect(r.isShareRoot(["releases", "project-a"])).toBe(true);
    expect(bucket.getCalls).toEqual([RULES_KEY]);
  });

  it("reads the configured key", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "a/\n").add("custom", "b/\n");
    const r = await loadRules(bucket.asR2Bucket(), "custom");
    expect(r.isShareRoot(["a"])).toBe(false);
    expect(r.isShareRoot(["b"])).toBe(true);
    expect(r.isExcluded("custom")).toBe(true);
  });

  it("skips a UTF-8 BOM", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a/\n")]);
    const r = await loadRules(new FakeBucket().add(RULES_KEY, bytes).asR2Bucket(), RULES_KEY);
    expect(r.status).toBe("loaded");
    expect(r.isShareRoot(["a"])).toBe(true);
  });

  it("denies everything when the rules object is missing", async () => {
    const r = await loadRules(new FakeBucket().add("a/x", "x").asR2Bucket(), RULES_KEY);
    expect(r.status).toBe("missing");
    expect(r.isShareRoot(["a"])).toBe(false);
    expect(r.isExcluded("a/x")).toBe(true);
  });

  it("denies everything when the rules object has an invalid line", async () => {
    const r = await loadRules(new FakeBucket().add(RULES_KEY, "a/\n  !a/secret/\n").asR2Bucket(), RULES_KEY);
    expect(r.status).toBe("invalid");
    expect(r.problem).toMatch(/^line 2:/);
    expect(r.isShareRoot(["a"])).toBe(false);
  });

  it("denies everything when the rules object is not valid UTF-8", async () => {
    const bytes = new Uint8Array([0x61, 0x2f, 0x0a, 0xff, 0xfe]);
    const r = await loadRules(new FakeBucket().add(RULES_KEY, bytes).asR2Bucket(), RULES_KEY);
    expect(r.status).toBe("invalid");
    expect(r.problem).toMatch(/UTF-8/);
    expect(r.isShareRoot(["a"])).toBe(false);
  });

  it("denies everything when the rules object is too large", async () => {
    const body = `a/\n${"#".repeat(MAX_RULES_FILE_BYTES)}\n`;
    const r = await loadRules(new FakeBucket().add(RULES_KEY, body).asR2Bucket(), RULES_KEY);
    expect(r.status).toBe("invalid");
    expect(r.isShareRoot(["a"])).toBe(false);
  });

  it("accepts a file of exactly the maximum size", async () => {
    const body = `a/\n${"#".repeat(MAX_RULES_FILE_BYTES - 3)}`;
    const r = await loadRules(new FakeBucket().add(RULES_KEY, body).asR2Bucket(), RULES_KEY);
    expect(r.status).toBe("loaded");
  });

  it("throws RulesReadError when R2 get fails", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "a/\n");
    const cause = new Error("R2 unavailable");
    bucket.failGet = () => cause;
    const promise = loadRules(bucket.asR2Bucket(), RULES_KEY);
    await expect(promise).rejects.toBeInstanceOf(RulesReadError);
    await expect(promise).rejects.toMatchObject({ cause });
  });

  it("throws RulesReadError when reading the body fails", async () => {
    const bucket = new FakeBucket().add(RULES_KEY, "a/\n");
    bucket.failBody = () => new Error("stream reset");
    await expect(loadRules(bucket.asR2Bucket(), RULES_KEY)).rejects.toBeInstanceOf(RulesReadError);
  });
});
