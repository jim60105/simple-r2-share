import { describe, expect, it } from "vitest";
import {
  isRelativeHref,
  isSafeKey,
  isValidSegment,
  isWithin,
  parseFolderPrefix,
  parseShortSharePath,
  publicUrl,
  relativeKey,
  resolveReadmeHref,
  shortSharePath,
  toPrefix,
  zipDownloadPath,
} from "../src/paths";
import { decodeShareToken, encodeShareToken } from "../src/short-url";

const BASE = "https://files.example.com";
const ROOT = ["releases", "project-a"];
const TOKEN = "hxR19djQFNp3SS7mNmos88qd"; // releases/project-a

describe("isValidSegment", () => {
  it.each(["releases", "專案 a", "v1.0", ".hidden", "...", "100% off", "literal%41", "q?#", "a+b", "emoji 📦"])(
    "accepts %j",
    (segment) => {
      expect(isValidSegment(segment)).toBe(true);
    },
  );

  it.each([
    ["empty", ""],
    [".", "."],
    ["..", ".."],
    ["slash", "a/b"],
    ["backslash", "a\\b"],
    ["NUL", "a\0b"],
    ["tab", "a\tb"],
    ["newline", "a\nb"],
    ["DEL", "a\u007fb"],
    ["C1 control", "a\u0085b"],
  ])("rejects %s", (_label, segment) => {
    expect(isValidSegment(segment)).toBe(false);
  });
});

describe("parseShortSharePath and shortSharePath", () => {
  it("extracts the token of a canonical share path", () => {
    expect(parseShortSharePath(`/s/${TOKEN}/`)).toBe(TOKEN);
    expect(shortSharePath(TOKEN)).toBe(`/s/${TOKEN}/`);
  });

  it("round-trips through the URL parser and decodeShareToken", () => {
    const segments = ["releases", "專案 a", "100% off", "q?#", "a+b"];
    const { pathname } = new URL(shortSharePath(encodeShareToken(segments)), "https://share.example.com");
    const token = parseShortSharePath(pathname);
    expect(token && decodeShareToken(token)).toEqual(segments);
  });

  it.each([
    ["no trailing slash", `/s/${TOKEN}`],
    ["bare /s/", "/s/"],
    ["bare /s", "/s"],
    ["empty", ""],
    ["root", "/"],
    ["two segments", `/s/${TOKEN}/x/`],
    ["repeated separator", `/s//${TOKEN}/`],
    ["trailing //", `/s/${TOKEN}//`],
    ["percent escape", "/s/hxR19%64jQ/"],
    ["encoded slash", `/s/${TOKEN}%2F/`],
    ["old share route", "/share/releases/project-a/"],
    ["similar prefix", `/sx/${TOKEN}/`],
    ["uppercase prefix", `/S/${TOKEN}/`],
    ["no leading slash", `s/${TOKEN}/`],
  ])("rejects %s", (_label, pathname) => {
    expect(parseShortSharePath(pathname)).toBeNull();
  });
});

describe("zipDownloadPath", () => {
  it("builds the ZIP path from the token", () => {
    expect(zipDownloadPath(TOKEN)).toBe(`/api/share-zip?token=${TOKEN}`);
  });

  it("round-trips through URLSearchParams", () => {
    const url = new URL(zipDownloadPath(TOKEN), "https://share.example.com");
    expect(url.searchParams.getAll("token")).toEqual([TOKEN]);
  });
});

describe("parseFolderPrefix", () => {
  it.each([
    [null, []],
    ["", []],
    ["releases/", ["releases"]],
    ["releases/project-a/", ["releases", "project-a"]],
    ["發佈/專案 A/", ["發佈", "專案 A"]],
    ["100%25 off/", ["100%25 off"]],
  ])("accepts %j", (prefix, expected) => {
    expect(parseFolderPrefix(prefix)).toEqual(expected);
  });

  it.each([
    ["root slash", "/"],
    ["leading slash", "/releases/"],
    ["no trailing slash", "releases"],
    ["repeated separator", "releases//"],
    ["..", "releases/../"],
    [".", "./"],
    ["backslash", "a\\b/"],
    ["control character", "a\nb/"],
  ])("rejects %s", (_label, prefix) => {
    expect(parseFolderPrefix(prefix)).toBeNull();
  });
});

describe("toPrefix", () => {
  it("joins segments and always ends with /", () => {
    expect(toPrefix(["releases"])).toBe("releases/");
    expect(toPrefix(["releases", "project-a"])).toBe("releases/project-a/");
    expect(toPrefix(["releases", "專案 a"])).toBe("releases/專案 a/");
    expect(toPrefix(["100%41"])).toBe("100%41/");
  });

  it("round-trips decodeShareToken output", () => {
    const segments = decodeShareToken(TOKEN);
    expect(segments && toPrefix(segments)).toBe("releases/project-a/");
  });

  it.each([
    ["no segments (bucket root)", []],
    ["empty segment", ["releases", ""]],
    ["dot-dot", ["releases", ".."]],
    ["slash inside a segment", ["releases/project-a"]],
    ["backslash", ["a\\b"]],
  ])("throws for %s", (_label, segments) => {
    expect(() => toPrefix(segments)).toThrow(TypeError);
  });
});

describe("isSafeKey and publicUrl", () => {
  it.each([
    ["releases/project-a/README.md", `${BASE}/releases/project-a/README.md`],
    ["releases/專案 a/說明.md", `${BASE}/releases/%E5%B0%88%E6%A1%88%20a/%E8%AA%AA%E6%98%8E.md`],
    ["a/100%.txt", `${BASE}/a/100%25.txt`],
    ["a/literal%41.txt", `${BASE}/a/literal%2541.txt`],
    ["a/q?x#y.txt", `${BASE}/a/q%3Fx%23y.txt`],
    ["a/.hidden", `${BASE}/a/.hidden`],
    ["a/b&c=d e+f", `${BASE}/a/b%26c%3Dd%20e%2Bf`],
  ])("encodes each segment of %j", (key, expected) => {
    expect(isSafeKey(key)).toBe(true);
    expect(publicUrl(BASE, key)).toBe(expected);
  });

  it("works with a base URL that has a path", () => {
    expect(publicUrl("https://cdn.example.com/bucket", "a/b c.txt")).toBe(
      "https://cdn.example.com/bucket/a/b%20c.txt",
    );
  });

  it("keeps the URL pointing at the same key after browser parsing", () => {
    const url = publicUrl(BASE, "releases/專案 a/100%.txt");
    expect(url && new URL(url).pathname).toBe("/releases/%E5%B0%88%E6%A1%88%20a/100%25.txt");
  });

  it.each([
    ["empty", ""],
    ["directory marker", "releases/project-a/"],
    ["leading slash", "/releases/a.txt"],
    ["repeated separator", "releases//a.txt"],
    ["dot-dot segment", "releases/../a.txt"],
    ["dot segment", "releases/./a.txt"],
    ["backslash", "releases\\a.txt"],
    ["NUL", "releases/a\0.txt"],
    ["control character", "releases/a\n.txt"],
  ])("rejects unsafe key: %s", (_label, key) => {
    expect(isSafeKey(key)).toBe(false);
    expect(publicUrl(BASE, key)).toBeNull();
  });
});

describe("isWithin and relativeKey", () => {
  it.each([
    ["releases/project-a/README.md", "releases/project-a/", "README.md"],
    ["releases/project-a/docs/a.png", "releases/project-a/", "docs/a.png"],
    ["releases/project-a/docs/a.png", "releases/project-a", "docs/a.png"],
    ["releases/專案 a/x", "releases/專案 a/", "x"],
  ])("%j is within %j", (key, prefix, rest) => {
    expect(isWithin(key, prefix)).toBe(true);
    expect(relativeKey(key, prefix)).toBe(rest);
  });

  it.each([
    ["spec §10 similar-prefix sibling", "releases/project-a2/x", "releases/project-a/"],
    ["spec §10 similar-prefix sibling, prefix without slash", "releases/project-a2/x", "releases/project-a"],
    ["similar-prefix file", "releases/project-a.zip", "releases/project-a/"],
    ["parent", "releases/x", "releases/project-a/"],
    ["the prefix itself", "releases/project-a/", "releases/project-a/"],
    ["the directory without slash", "releases/project-a", "releases/project-a/"],
    ["escape with ..", "releases/project-a/../secret.txt", "releases/project-a/"],
    ["empty segment below", "releases/project-a//x", "releases/project-a/"],
    ["directory marker below", "releases/project-a/sub/", "releases/project-a/"],
    ["case differs", "Releases/project-a/x", "releases/project-a/"],
    ["bucket root prefix", "releases/x", ""],
    ["slash prefix", "releases/x", "/"],
  ])("rejects %s", (_label, key, prefix) => {
    expect(isWithin(key, prefix)).toBe(false);
    expect(relativeKey(key, prefix)).toBeNull();
  });
});

describe("isRelativeHref", () => {
  it.each(["a.png", "./a.png", "../a.png", "/a.png", "docs/a.png", "a.png#x", "a.png?x", "?x"])(
    "is true for %j",
    (href) => {
      expect(isRelativeHref(href)).toBe(true);
    },
  );

  it.each([
    "",
    "#section",
    "https://example.com/a.png",
    "HTTPS://example.com/",
    "http://example.com/",
    "mailto:a@example.com",
    "javascript:alert(1)",
    "data:image/png;base64,AA==",
    "//evil.example.com/a.png",
    "\\\\evil.example.com/a.png",
    "/\\evil.example.com/a.png",
    "\\/evil.example.com/a.png",
  ])("is false for %j", (href) => {
    expect(isRelativeHref(href)).toBe(false);
  });
});

describe("resolveReadmeHref", () => {
  it.each([
    ["a.png", "releases/project-a/a.png"],
    ["./a.png", "releases/project-a/a.png"],
    ["docs/guide.md", "releases/project-a/docs/guide.md"],
    ["./docs/./img/a.png", "releases/project-a/docs/img/a.png"],
    ["docs/../a.png", "releases/project-a/a.png"],
    ["docs/img/../../a.png", "releases/project-a/a.png"],
    ["/a.png", "releases/project-a/a.png"],
    ["/docs/a.png", "releases/project-a/docs/a.png"],
    ["a.png?raw=1", "releases/project-a/a.png"],
    ["a.png#frag", "releases/project-a/a.png"],
    ["a.png?x=1#frag", "releases/project-a/a.png"],
    ["a.png#frag?x", "releases/project-a/a.png"],
    ["my%20file.png", "releases/project-a/my file.png"],
    ["%E8%AA%AA%E6%98%8E.pdf", "releases/project-a/說明.pdf"],
    ["說明.pdf", "releases/project-a/說明.pdf"],
    ["100%25.txt", "releases/project-a/100%.txt"],
    [".hidden", "releases/project-a/.hidden"],
  ])("resolves %j", (href, expected) => {
    expect(resolveReadmeHref(href, ROOT)).toBe(expected);
  });

  describe("spec §10 URL attack cases", () => {
    it.each([
      ["../ leaving the root", "../secret.txt"],
      ["../ to a sibling with a similar prefix", "../project-a2/x.txt"],
      ["nested ../ leaving the root", "docs/../../secret.txt"],
      ["leading / then ..", "/../secret.txt"],
      ["./../", "./../secret.txt"],
      ["deep escape", "../../../../etc/passwd"],
    ])("rejects %s", (_label, href) => {
      expect(resolveReadmeHref(href, ROOT)).toBeNull();
    });

    it.each([
      ["%2e%2e", "%2e%2e/secret.txt"],
      ["%2E%2E", "%2E%2E/secret.txt"],
      ["mixed %2e.", "%2e./secret.txt"],
      ["%2e", "%2e/a.png"],
    ])("rejects encoded dot segments: %s", (_label, href) => {
      expect(resolveReadmeHref(href, ROOT)).toBeNull();
    });

    it.each([
      ["%2F", "..%2Fsecret.txt"],
      ["%2f", "docs%2fa.png"],
      ["%5C", "..%5Csecret.txt"],
      ["%5c", "docs%5ca.png"],
      ["backslash", "..\\secret.txt"],
      ["backslash in name", "docs\\a.png"],
    ])("rejects separator smuggling: %s", (_label, href) => {
      expect(resolveReadmeHref(href, ROOT)).toBeNull();
    });

    it.each([
      ["%252e%252e", "%252e%252e/secret.txt"],
      ["%252F", "..%252Fsecret.txt"],
      ["%255C", "..%255Csecret.txt"],
      ["%2541", "a%2541.png"],
    ])("rejects double encoding: %s", (_label, href) => {
      expect(resolveReadmeHref(href, ROOT)).toBeNull();
    });

    it.each([
      ["doubled separator", "docs//a.png"],
      ["leading //", "//evil.example.com/a.png"],
      ["/// prefix", "///a.png"],
    ])("rejects repeated separators: %s", (_label, href) => {
      expect(resolveReadmeHref(href, ROOT)).toBeNull();
    });
  });

  it.each([
    ["directory with trailing slash", "docs/"],
    ["current directory", "."],
    ["current directory slash", "./"],
    ["root slash", "/"],
    ["parent of a subdirectory", "docs/.."],
    ["ends in .", "docs/."],
  ])("rejects hrefs that point at a directory: %s", (_label, href) => {
    expect(resolveReadmeHref(href, ROOT)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["fragment only", "#section"],
    ["query only", "?x=1"],
    ["https", "https://example.com/a.png"],
    ["mailto", "mailto:a@example.com"],
    ["javascript", "javascript:alert(1)"],
    ["data", "data:image/png;base64,AA=="],
    ["NUL", "a\0.png"],
    ["%00", "a%00.png"],
    ["control character", "a%0A.png"],
    ["malformed escape", "a%G1.png"],
    ["lone %", "a%.png"],
    ["invalid UTF-8", "%FF.png"],
  ])("rejects %s", (_label, href) => {
    expect(resolveReadmeHref(href, ROOT)).toBeNull();
  });

  it("produces keys that stay within the share root", () => {
    const hrefs = ["a.png", "docs/../b.png", "/c/d.png", "./e%20f.png"];
    for (const href of hrefs) {
      const key = resolveReadmeHref(href, ROOT);
      expect(key, href).not.toBeNull();
      expect(isWithin(key ?? "", toPrefix(ROOT)), href).toBe(true);
    }
  });

  it("throws for an invalid share root", () => {
    expect(() => resolveReadmeHref("a.png", [])).toThrow(TypeError);
  });
});
