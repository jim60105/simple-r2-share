import { describe, expect, it } from "vitest";
import {
  LIST_PAGE_LIMIT,
  ListingError,
  buildListing,
  compareNames,
  listAll,
  loadListing,
  type FileNode,
  type FolderNode,
  type Listing,
  type TreeNode,
} from "../src/listing";
import { parseRules, type Rules } from "../src/rules";
import { FakeBucket } from "./fake-bucket";

const RULES_KEY = ".r2-share-rules";
const PREFIX = "releases/project-a/";

function rules(...lines: string[]): Rules {
  const parsed = parseRules(lines.join("\n"), RULES_KEY);
  expect(parsed.status).toBe("loaded");
  return parsed;
}

const ALLOW_A = rules("releases/project-a/");

function bucket(keys: Record<string, string>, pageSize = 2): FakeBucket {
  const fake = new FakeBucket({ pageSize });
  for (const [key, body] of Object.entries(keys)) fake.add(key, body);
  return fake;
}

/** Compact view of a tree: folders as `name/ (n)` with children, files as names. */
type Shape = string | [string, Shape[]];
function shape(nodes: readonly TreeNode[]): Shape[] {
  return nodes.map((node) => (node.kind === "file" ? node.name : [`${node.name}/ (${node.childCount})`, shape(node.children)]));
}

function folder(listing: Listing, path: string): FolderNode {
  let nodes = listing.root;
  let found: FolderNode | undefined;
  for (const name of path.split("/")) {
    found = nodes.find((node): node is FolderNode => node.kind === "folder" && node.name === name);
    if (found === undefined) throw new Error(`no folder ${path}`);
    nodes = found.children;
  }
  return found as FolderNode;
}

function objects(...keys: string[]) {
  return keys.map((key) => ({ key, size: 1, uploaded: new Date(0) }));
}

describe("listAll", () => {
  it("follows the cursor across pages of two", async () => {
    const fake = bucket({
      [`${PREFIX}a`]: "1",
      [`${PREFIX}b`]: "22",
      [`${PREFIX}c/d`]: "333",
      [`${PREFIX}c/e`]: "4444",
      [`${PREFIX}f`]: "55555",
      "releases/project-b/x": "x",
    });
    const listed = await listAll(fake.asR2Bucket(), PREFIX);
    expect(listed.map((o) => o.key)).toEqual(["a", "b", "c/d", "c/e", "f"].map((k) => PREFIX + k));
    expect(fake.listCalls).toEqual([
      { prefix: PREFIX, cursor: undefined, limit: LIST_PAGE_LIMIT },
      { prefix: PREFIX, cursor: `${PREFIX}b`, limit: LIST_PAGE_LIMIT },
      { prefix: PREFIX, cursor: `${PREFIX}c/e`, limit: LIST_PAGE_LIMIT },
    ]);
    for (const call of fake.listCalls) {
      expect(call.delimiter).toBeUndefined();
      expect(call.include).toBeUndefined();
    }
  });

  it("does not stop on a short page that is still truncated", async () => {
    const fake = bucket({ [`${PREFIX}a`]: "", [`${PREFIX}b`]: "", [`${PREFIX}c`]: "" });
    let first = true;
    fake.mapList = (page) => {
      if (!first) return page;
      first = false;
      return { ...page, objects: page.objects.slice(0, 1) }; // short page, cursor still after `b`
    };
    const listed = await listAll(fake.asR2Bucket(), PREFIX);
    expect(listed.map((o) => o.key)).toEqual([`${PREFIX}a`, `${PREFIX}c`]);
    expect(fake.listCalls).toHaveLength(2);
  });

  it("throws when the cursor repeats", async () => {
    const fake = bucket({ [`${PREFIX}a`]: "", [`${PREFIX}b`]: "", [`${PREFIX}c`]: "" });
    fake.mapList = (page) => ({ ...page, truncated: true, cursor: "stuck" });
    const error = await listAll(fake.asR2Bucket(), PREFIX).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ListingError);
    expect((error as ListingError).reason).toBe("cursor-not-advancing");
    expect(fake.listCalls).toHaveLength(2);
  });

  it("throws when a cursor from an earlier page comes back", async () => {
    const fake = bucket({ [`${PREFIX}a`]: "" });
    let n = 0;
    fake.mapList = (page) => ({ ...page, truncated: true, cursor: ["c1", "c2", "c1"][n++] ?? "c3" });
    await expect(listAll(fake.asR2Bucket(), PREFIX)).rejects.toMatchObject({ reason: "cursor-not-advancing" });
    expect(fake.listCalls).toHaveLength(3);
  });

  it.each([undefined, ""])("throws when truncated without a cursor (%j)", async (cursor) => {
    const fake = bucket({ [`${PREFIX}a`]: "" });
    fake.mapList = (page) => ({ objects: page.objects, delimitedPrefixes: [], truncated: true, cursor }) as R2Objects;
    await expect(listAll(fake.asR2Bucket(), PREFIX)).rejects.toMatchObject({ reason: "cursor-not-advancing" });
    expect(fake.listCalls).toHaveLength(1);
  });

  it("stops at the object limit", async () => {
    const fake = bucket({ [`${PREFIX}a`]: "", [`${PREFIX}b`]: "", [`${PREFIX}c`]: "" });
    await expect(listAll(fake.asR2Bucket(), PREFIX, { maxObjects: 3 })).resolves.toHaveLength(3);
    await expect(listAll(fake.asR2Bucket(), PREFIX, { maxObjects: 2 })).rejects.toMatchObject({
      name: "ListingError",
      reason: "too-many-objects",
    });
  });

  it("stops at the page limit", async () => {
    const fake = bucket({ [`${PREFIX}a`]: "", [`${PREFIX}b`]: "", [`${PREFIX}c`]: "" }, 1);
    await expect(listAll(fake.asR2Bucket(), PREFIX, { maxPages: 3 })).resolves.toHaveLength(3);
    fake.listCalls.length = 0;
    await expect(listAll(fake.asR2Bucket(), PREFIX, { maxPages: 2 })).rejects.toMatchObject({ reason: "too-many-objects" });
    expect(fake.listCalls).toHaveLength(2);
  });

  it("propagates list errors unchanged", async () => {
    const fake = bucket({ [`${PREFIX}a`]: "", [`${PREFIX}b`]: "", [`${PREFIX}c`]: "" });
    const boom = new Error("R2 is down");
    fake.failList = (options) => (options.cursor !== undefined ? boom : undefined);
    await expect(listAll(fake.asR2Bucket(), PREFIX)).rejects.toBe(boom);
  });

  it.each(["", "/", "releases/project-a"])("refuses the prefix %j", async (prefix) => {
    const fake = bucket({ a: "" });
    await expect(listAll(fake.asR2Bucket(), prefix)).rejects.toThrow(TypeError);
    expect(fake.listCalls).toHaveLength(0);
  });
});

describe("buildListing", () => {
  it("builds a sorted tree with folders first", () => {
    const listing = buildListing(
      objects(
        `${PREFIX}file10.txt`,
        `${PREFIX}file2.txt`,
        `${PREFIX}三.txt`,
        `${PREFIX}一.txt`,
        `${PREFIX}docs/b.md`,
        `${PREFIX}docs/img/x.png`,
        `${PREFIX}v10/notes.txt`,
        `${PREFIX}v2/notes.txt`,
        `${PREFIX}中文資料夾/說明.txt`,
        `${PREFIX}Zeta.txt`,
        `${PREFIX}alpha.txt`,
      ),
      PREFIX,
      ALLOW_A,
    );
    expect(shape(listing.root)).toEqual([
      ["中文資料夾/ (1)", ["說明.txt"]],
      ["docs/ (2)", [["img/ (1)", ["x.png"]], "b.md"]],
      ["v2/ (1)", ["notes.txt"]],
      ["v10/ (1)", ["notes.txt"]],
      "一.txt",
      "三.txt",
      "alpha.txt",
      "file2.txt",
      "file10.txt",
      "Zeta.txt",
    ]);
  });

  it("orders names with the zh-Hant-TW collator and a deterministic tie-break", () => {
    const names = ["file10", "file2", "file1", "file01", "三", "乙", "十", "一", "B", "a", "v10", "v2"];
    expect([...names].sort(compareNames)).toEqual(["一", "乙", "十", "三", "a", "B", "file01", "file1", "file2", "file10", "v2", "v10"]);
    expect(compareNames("file01", "file1")).toBeLessThan(0);
    expect(compareNames("file1", "file01")).toBeGreaterThan(0);
    expect(compareNames("x", "x")).toBe(0);
  });

  it("records file nodes, paths and the flat list in display order", () => {
    const uploaded = new Date("2026-10-27T08:00:00Z");
    const listing = buildListing(
      [
        { key: `${PREFIX}z.txt`, size: 5, uploaded },
        { key: `${PREFIX}a/b/c.txt`, size: 7, uploaded },
        { key: `${PREFIX}a/a.txt`, size: 11, uploaded },
        { key: `${PREFIX}README.md`, size: 13, uploaded },
      ],
      PREFIX,
      ALLOW_A,
    );
    expect(listing.files.map((f) => f.path)).toEqual(["a/b/c.txt", "a/a.txt", "README.md", "z.txt"]);
    const readme = listing.byPath.get("README.md");
    expect(readme).toEqual<FileNode>({
      kind: "file",
      name: "README.md",
      path: "README.md",
      key: `${PREFIX}README.md`,
      size: 13,
      uploaded,
    });
    expect(listing.root).toContain(readme);
    expect(folder(listing, "a/b")).toMatchObject({ kind: "folder", name: "b", path: "a/b", childCount: 1 });
    expect(listing.prefix).toBe(PREFIX);
  });

  it("counts files, folders at every depth and bytes", () => {
    const listing = buildListing(
      [
        { key: `${PREFIX}a/b/c/1`, size: 100, uploaded: new Date(0) },
        { key: `${PREFIX}a/b/2`, size: 20, uploaded: new Date(0) },
        { key: `${PREFIX}a/3`, size: 3, uploaded: new Date(0) },
        { key: `${PREFIX}d/4`, size: 0, uploaded: new Date(0) },
        { key: `${PREFIX}5`, size: 5000, uploaded: new Date(0) },
      ],
      PREFIX,
      ALLOW_A,
    );
    expect(listing).toMatchObject({ fileCount: 5, folderCount: 4, totalBytes: 5123 });
    expect(folder(listing, "a").childCount).toBe(2);
    expect(folder(listing, "a/b").childCount).toBe(2);
    expect(folder(listing, "a/b/c").childCount).toBe(1);
    expect(folder(listing, "d").childCount).toBe(1);
  });

  it("drops excluded objects and folders that end up empty", () => {
    const shareRules = rules("releases/project-a/", "!releases/project-a/private/", "!releases/project-a/**/*.tmp");
    const listing = buildListing(
      objects(
        `${PREFIX}public/a.txt`,
        `${PREFIX}public/scratch.tmp`,
        `${PREFIX}private/secret.txt`,
        `${PREFIX}private/deeper/key.pem`,
        `${PREFIX}only-tmp/x.tmp`,
        `${PREFIX}b.tmp`,
        `${PREFIX}b.txt`,
      ),
      PREFIX,
      shareRules,
    );
    expect(shape(listing.root)).toEqual([["public/ (1)", ["a.txt"]], "b.txt"]);
    expect(listing).toMatchObject({ fileCount: 2, folderCount: 1, totalBytes: 2 });
  });

  it("drops the rules object even when it lives inside the share", () => {
    const rulesKey = `${PREFIX}.share-rules`;
    const shareRules = parseRules("releases/project-a/", rulesKey);
    const listing = buildListing(objects(rulesKey, `${PREFIX}a.txt`), PREFIX, shareRules);
    expect(listing.files.map((f) => f.key)).toEqual([`${PREFIX}a.txt`]);
  });

  it("lists nothing when the rules are not loaded", () => {
    const invalid = parseRules("releases/project-a/\n  bad", RULES_KEY);
    expect(invalid.status).toBe("invalid");
    const listing = buildListing(objects(`${PREFIX}a.txt`), PREFIX, invalid);
    expect(listing.fileCount).toBe(0);
  });

  it("keeps only keys inside the prefix on a segment boundary", () => {
    const listing = buildListing(
      objects(
        `${PREFIX}ok.txt`,
        "releases/project-a2/leak.txt",
        "releases/project-a",
        "releases/other.txt",
        `${PREFIX}../escape.txt`,
        `${PREFIX}a//b.txt`,
        `${PREFIX}./dot.txt`,
        `${PREFIX}back\\slash.txt`,
        `${PREFIX}nul\u0000.txt`,
      ),
      PREFIX,
      rules("releases/**"),
    );
    expect(listing.files.map((f) => f.path)).toEqual(["ok.txt"]);
  });

  it("skips directory markers and folders that only hold markers", () => {
    const listing = buildListing(
      objects(PREFIX, `${PREFIX}docs/`, `${PREFIX}docs/a.txt`, `${PREFIX}empty/`, `${PREFIX}empty/deeper/`),
      PREFIX,
      ALLOW_A,
    );
    expect(shape(listing.root)).toEqual([["docs/ (1)", ["a.txt"]]]);
    expect(listing.folderCount).toBe(1);
  });

  it("lists a file and a folder that share a name", () => {
    const listing = buildListing(objects(`${PREFIX}a`, `${PREFIX}a/b`), PREFIX, ALLOW_A);
    expect(shape(listing.root)).toEqual([["a/ (1)", ["b"]], "a"]);
    expect(listing).toMatchObject({ fileCount: 2, folderCount: 1 });
  });

  it("ignores duplicate keys", () => {
    const listing = buildListing(objects(`${PREFIX}a`, `${PREFIX}a`), PREFIX, ALLOW_A);
    expect(listing.fileCount).toBe(1);
    expect(listing.totalBytes).toBe(1);
  });

  it("returns an empty listing for no objects", () => {
    const listing = buildListing([], PREFIX, ALLOW_A);
    expect(listing).toEqual({
      prefix: PREFIX,
      root: [],
      files: [],
      byPath: new Map(),
      fileCount: 0,
      folderCount: 0,
      totalBytes: 0,
    });
  });
});

describe("loadListing", () => {
  it("lists a share with similar-prefix siblings, exclusions and pagination", async () => {
    const fake = bucket({
      [RULES_KEY]: "releases/project-a/\n!releases/project-a/drafts/\n",
      "releases/project-a/README.md": "# hi",
      "releases/project-a/v2/app.zip": "12345",
      "releases/project-a/v10/app.zip": "1234567890",
      "releases/project-a/drafts/wip.txt": "secret",
      "releases/project-a/drafts/": "",
      "releases/project-a2/other.txt": "nope",
      "releases/project-a-old/x.txt": "nope",
    });
    const listing = await loadListing(fake.asR2Bucket(), PREFIX, parseRules("releases/project-a/\n!releases/project-a/drafts/\n", RULES_KEY));
    expect(shape(listing.root)).toEqual([["v2/ (1)", ["app.zip"]], ["v10/ (1)", ["app.zip"]], "README.md"]);
    expect(listing).toMatchObject({ fileCount: 3, folderCount: 2, totalBytes: 19 });
    expect(fake.listCalls.every((call) => call.prefix === PREFIX)).toBe(true);
    expect(fake.listCalls.length).toBeGreaterThan(1);
  });

  it("returns an empty listing for an empty share", async () => {
    const fake = bucket({ "releases/project-a2/x": "" });
    const listing = await loadListing(fake.asR2Bucket(), PREFIX, ALLOW_A);
    expect(listing).toMatchObject({ root: [], files: [], fileCount: 0, folderCount: 0, totalBytes: 0 });
    expect(fake.listCalls).toHaveLength(1);
  });

  it("propagates list errors", async () => {
    const fake = bucket({ [`${PREFIX}a`]: "" });
    const boom = new Error("R2 is down");
    fake.failList = () => boom;
    await expect(loadListing(fake.asR2Bucket(), PREFIX, ALLOW_A)).rejects.toBe(boom);
  });

  it("passes uploaded dates through", async () => {
    const uploaded = new Date("2026-10-27T08:05:00Z");
    const fake = new FakeBucket().add(`${PREFIX}a.txt`, "abc", uploaded);
    const listing = await loadListing(fake.asR2Bucket(), PREFIX, ALLOW_A);
    expect(listing.byPath.get("a.txt")).toMatchObject({ size: 3, uploaded });
  });
});
