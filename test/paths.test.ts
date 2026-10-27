import { describe, expect, it } from "vitest";
import {
  isRelativeHref,
  isSafeKey,
  isWithin,
  parseSharePath,
  parseZipDir,
  publicUrl,
  relativeKey,
  resolveReadmeHref,
  sharePagePath,
  toPrefix,
  zipDownloadPath,
} from "../src/paths";

const BASE = "https://files.example.com";
const ROOT = ["releases", "project-a"];

describe("parseSharePath", () => {
  it.each([
    ["/share/releases/", ["releases"]],
    ["/share/releases/project-a/", ["releases", "project-a"]],
    ["/share/a/b/c/d/", ["a", "b", "c", "d"]],
    ["/share/%E5%B0%88%E6%A1%88%20a/", ["專案 a"]],
    ["/share/專案 a/", ["專案 a"]],
    ["/share/v1.0/", ["v1.0"]],
    ["/share/.hidden/", [".hidden"]],
    ["/share/.../", ["..."]],
    ["/share/a%2Bb/", ["a+b"]],
    ["/share/a+b/", ["a+b"]],
    ["/share/100%25%20off/", ["100% off"]],
    ["/share/q%3F%23/", ["q?#"]],
  ])("accepts %j", (pathname, expected) => {
    expect(parseSharePath(pathname)).toEqual(expected);
  });

  it("accepts what the WHATWG URL parser produces for non-ASCII names", () => {
    const { pathname } = new URL("https://share.example.com/share/releases/專案 a/");
    expect(parseSharePath(pathname)).toEqual(["releases", "專案 a"]);
  });

  describe("spec §10 URL attack cases", () => {
    it.each([
      ["../ escaping the share prefix", "/share/../"],
      ["../ at the start", "/share/../releases/"],
      ["../ in the middle", "/share/releases/../secret/"],
      ["../ at the end", "/share/releases/project-a/../"],
      [". segment", "/share/releases/./project-a/"],
      [". alone", "/share/./"],
    ])("rejects literal dot segments: %s", (_label, pathname) => {
      expect(parseSharePath(pathname)).toBeNull();
    });

    it.each([
      ["%2e%2e", "/share/releases/%2e%2e/secret/"],
      ["%2E%2E", "/share/releases/%2E%2E/secret/"],
      ["mixed %2e.", "/share/releases/%2e./secret/"],
      ["mixed .%2E", "/share/releases/.%2E/secret/"],
      ["%2e", "/share/releases/%2e/project-a/"],
      ["%2e%2e as only segment", "/share/%2e%2e/"],
    ])("rejects encoded dot segments: %s", (_label, pathname) => {
      expect(parseSharePath(pathname)).toBeNull();
    });

    it.each([
      ["%2F", "/share/releases%2Fproject-a/"],
      ["%2f", "/share/releases%2fproject-a/"],
      ["%2F..", "/share/releases/project-a%2F..%2Fsecret/"],
      ["%2F at the start", "/share/%2Fetc/"],
    ])("rejects encoded slash: %s", (_label, pathname) => {
      expect(parseSharePath(pathname)).toBeNull();
    });

    it.each([
      ["%5C", "/share/releases%5Cproject-a/"],
      ["%5c", "/share/releases%5cproject-a/"],
      ["%5C..", "/share/releases/%5C..%5Csecret/"],
      ["literal backslash", "/share/releases\\project-a/"],
      ["literal backslash dot-dot", "/share/releases/..\\secret/"],
    ])("rejects backslash: %s", (_label, pathname) => {
      expect(parseSharePath(pathname)).toBeNull();
    });

    it.each([
      ["%252F", "/share/releases%252Fproject-a/"],
      ["%252f", "/share/releases%252fproject-a/"],
      ["%255C", "/share/releases%255Cproject-a/"],
      ["%252e%252e", "/share/releases/%252e%252e/secret/"],
      ["%252E%252E", "/share/releases/%252E%252E/"],
      ["%2500", "/share/releases%2500/"],
      ["%2541 (any leftover escape)", "/share/a%2541/"],
      ["triple %25252F", "/share/releases%25252Fproject-a/"],
    ])("rejects double encoding: %s", (_label, pathname) => {
      expect(parseSharePath(pathname)).toBeNull();
    });

    it.each([
      ["leading //", "/share//releases/"],
      ["middle //", "/share/releases//project-a/"],
      ["trailing //", "/share/releases/project-a//"],
      ["only //", "/share//"],
      ["many slashes", "/share///"],
    ])("rejects repeated separators: %s", (_label, pathname) => {
      expect(parseSharePath(pathname)).toBeNull();
    });

    it("never yields a parent or bucket-root prefix for an attack path", () => {
      const attacks = [
        "/share/releases/project-a/../",
        "/share/releases/project-a/%2e%2e/",
        "/share/releases/project-a%2F..%2F/",
        "/share/releases/project-a%5C..%5C/",
        "/share/releases/project-a/%252e%252e/",
        "/share//",
        "/share/",
      ];
      for (const pathname of attacks) {
        expect(parseSharePath(pathname), pathname).toBeNull();
      }
    });
  });

  it.each([
    ["literal NUL", "/share/a\0b/"],
    ["%00", "/share/a%00b/"],
    ["tab", "/share/a%09b/"],
    ["newline", "/share/a%0Ab/"],
    ["DEL", "/share/a%7Fb/"],
    ["C1 control", "/share/a%C2%85b/"],
  ])("rejects control characters: %s", (_label, pathname) => {
    expect(parseSharePath(pathname)).toBeNull();
  });

  it.each([
    ["lone %", "/share/a%/"],
    ["non-hex escape", "/share/a%G1/"],
    ["truncated escape", "/share/a%2/"],
    ["truncated UTF-8", "/share/%E5%B0/"],
    ["invalid UTF-8", "/share/%FF/"],
    ["encoded surrogate", "/share/%ED%A0%80/"],
  ])("rejects malformed percent-encoding: %s", (_label, pathname) => {
    expect(parseSharePath(pathname)).toBeNull();
  });

  it.each([
    ["no trailing slash", "/share/releases/project-a"],
    ["no trailing slash, one segment", "/share/releases"],
    ["bare /share", "/share"],
    ["bucket root /share/", "/share/"],
    ["empty", ""],
    ["root", "/"],
    ["other route", "/api/share-zip/"],
    ["similar prefix", "/shared/releases/"],
    ["uppercase prefix", "/SHARE/releases/"],
    ["no leading slash", "share/releases/"],
    ["query in raw path", "/share/releases?x=1/"],
    ["fragment in raw path", "/share/releases#x/"],
  ])("rejects non-share paths: %s", (_label, pathname) => {
    expect(parseSharePath(pathname)).toBeNull();
  });
});

describe("parseZipDir", () => {
  it.each([
    ["releases", ["releases"]],
    ["releases/project-a", ["releases", "project-a"]],
    ["releases/專案 a", ["releases", "專案 a"]],
    ["100% off", ["100% off"]],
  ])("accepts %j", (dir, expected) => {
    expect(parseZipDir(dir)).toEqual(expected);
  });

  it("accepts the value URLSearchParams decodes from the spec example", () => {
    const dir = new URL("https://share.example.com/api/share-zip?dir=releases%2Fproject-a").searchParams.get("dir");
    expect(parseZipDir(dir)).toEqual(["releases", "project-a"]);
  });

  it.each([
    ["missing", null],
    ["undefined", undefined],
    ["empty", ""],
    ["root slash", "/"],
    ["leading slash", "/releases"],
    ["trailing slash", "releases/project-a/"],
    ["repeated separator", "releases//project-a"],
    ["..", "releases/.."],
    ["../ escape", "../releases"],
    [".", "releases/./project-a"],
    ["backslash", "releases\\project-a"],
    ["NUL", "releases\0"],
    ["control character", "releases\n"],
    ["double-encoded slash (%252F)", "releases%2Fproject-a"],
    ["double-encoded dots (%252e)", "releases/%2e%2e"],
    ["double-encoded backslash (%255C)", "releases%5Cproject-a"],
  ])("rejects %s", (_label, dir) => {
    expect(parseZipDir(dir)).toBeNull();
  });

  it("does not decode again", () => {
    const dir = new URLSearchParams("dir=releases%252Fproject-a").get("dir");
    expect(dir).toBe("releases%2Fproject-a");
    expect(parseZipDir(dir)).toBeNull();
  });
});

describe("toPrefix", () => {
  it("joins segments and always ends with /", () => {
    expect(toPrefix(["releases"])).toBe("releases/");
    expect(toPrefix(["releases", "project-a"])).toBe("releases/project-a/");
    expect(toPrefix(["releases", "專案 a"])).toBe("releases/專案 a/");
  });

  it("round-trips parseSharePath output", () => {
    const segments = parseSharePath("/share/releases/project-a/");
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

describe("sharePagePath and zipDownloadPath", () => {
  it("builds the canonical share page path", () => {
    expect(sharePagePath(["releases", "project-a"])).toBe("/share/releases/project-a/");
    expect(sharePagePath(["releases", "專案 a"])).toBe("/share/releases/%E5%B0%88%E6%A1%88%20a/");
  });

  it("round-trips through parseSharePath and the URL parser", () => {
    const segments = ["releases", "專案 a", "100% off", "q?#", "a+b"];
    const { pathname } = new URL(sharePagePath(segments), "https://share.example.com");
    expect(parseSharePath(pathname)).toEqual(segments);
  });

  it("builds the ZIP download path from the spec example", () => {
    expect(zipDownloadPath(["releases", "project-a"])).toBe("/api/share-zip?dir=releases%2Fproject-a");
  });

  it("round-trips through URLSearchParams and parseZipDir", () => {
    const segments = ["releases", "專案 a", "100% off", "a&b=c"];
    const url = new URL(zipDownloadPath(segments), "https://share.example.com");
    expect(parseZipDir(url.searchParams.get("dir"))).toEqual(segments);
  });

  it("refuses invalid segments", () => {
    expect(() => sharePagePath([])).toThrow(TypeError);
    expect(() => zipDownloadPath([".."])).toThrow(TypeError);
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
