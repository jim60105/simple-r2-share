import { describe, expect, it } from "vitest";
import { denyAll, parseRules, type Rules } from "../src/rules";

const RULES_KEY = ".r2-share-rules";

/** Spec §4 example, verbatim. */
const SPEC_EXAMPLE = `# 精確核准 project-a 的分享根目錄
releases/project-a/

# 核准 project-b 與其所有子目錄各自成為分享頁
releases/project-b/**

# project-b/private 與其後代不出現在分享頁與 ZIP
!releases/project-b/private/
`;

function rules(...lines: string[]): Rules {
  const parsed = parseRules(lines.join("\n"), RULES_KEY);
  expect(parsed.problem).toBeNull();
  expect(parsed.status).toBe("loaded");
  return parsed;
}

function dir(path: string): string[] {
  return path.split("/");
}

function expectInvalid(text: string): void {
  const parsed = parseRules(text, RULES_KEY);
  expect(parsed.status, JSON.stringify(text)).toBe("invalid");
  expect(parsed.problem).toMatch(/^line \d+: /);
  expect(parsed.isShareRoot(["a"])).toBe(false);
  expect(parsed.isExcluded("a/b.txt")).toBe(true);
}

describe("spec §4 example", () => {
  const spec = parseRules(SPEC_EXAMPLE, RULES_KEY);

  it("parses three rules", () => {
    expect(spec.status).toBe("loaded");
    expect(spec.rules).toEqual([
      { line: 2, body: "releases/project-a", exclude: false, dirOnly: true, recursive: false, literal: dir("releases/project-a") },
      { line: 5, body: "releases/project-b", exclude: false, dirOnly: false, recursive: true, literal: dir("releases/project-b") },
      {
        line: 8,
        body: "releases/project-b/private",
        exclude: true,
        dirOnly: true,
        recursive: false,
        literal: dir("releases/project-b/private"),
      },
    ]);
  });

  it("§4.1.1 denies everything without a matching allow rule", () => {
    expect(spec.isShareRoot(dir("releases"))).toBe(false);
    expect(spec.isShareRoot(dir("other"))).toBe(false);
    expect(spec.isShareRoot(dir("releases/project-c"))).toBe(false);
    expect(spec.isShareRoot([])).toBe(false);
  });

  it("§4.1.2 an exact rule shares only that directory, with all its files", () => {
    expect(spec.isShareRoot(dir("releases/project-a"))).toBe(true);
    expect(spec.isShareRoot(dir("releases/project-a/docs"))).toBe(false);
    expect(spec.isShareRoot(dir("releases/project-a/docs/deep"))).toBe(false);
    expect(spec.isExcluded("releases/project-a/readme.txt")).toBe(false);
    expect(spec.isExcluded("releases/project-a/docs/deep/file.bin")).toBe(false);
  });

  it("§4.1.3 a /** rule shares the directory and every non-excluded descendant", () => {
    expect(spec.isShareRoot(dir("releases/project-b"))).toBe(true);
    expect(spec.isShareRoot(dir("releases/project-b/docs"))).toBe(true);
    expect(spec.isShareRoot(dir("releases/project-b/docs/v1/assets"))).toBe(true);
  });

  it("§4.1.4 an exclusion hides the directory and all descendants", () => {
    expect(spec.isShareRoot(dir("releases/project-b/private"))).toBe(false);
    expect(spec.isShareRoot(dir("releases/project-b/private/sub"))).toBe(false);
    expect(spec.isExcluded("releases/project-b/private/key.txt")).toBe(true);
    expect(spec.isExcluded("releases/project-b/private/sub/deep.txt")).toBe(true);
    expect(spec.isExcluded("releases/project-b/public.txt")).toBe(false);
    // Similar prefix is a different directory.
    expect(spec.isExcluded("releases/project-b/private2/x.txt")).toBe(false);
    expect(spec.isShareRoot(dir("releases/project-b/private2"))).toBe(true);
  });

  it("§4.1.7 the rules object is never listable", () => {
    expect(spec.isExcluded(RULES_KEY)).toBe(true);
  });
});

describe("last matching rule wins", () => {
  it("a later exclusion overrides an earlier allow", () => {
    const r = rules("a/", "!a/");
    expect(r.isShareRoot(["a"])).toBe(false);
    expect(r.isExcluded("a/x")).toBe(true);
  });

  it("a later allow for the same directory overrides an earlier exclusion", () => {
    const r = rules("!a/", "a/");
    expect(r.isShareRoot(["a"])).toBe(true);
    expect(r.isExcluded("a/x")).toBe(false);
  });

  it("an exact exclusion after /** removes only that directory and its subtree", () => {
    const r = rules("a/**", "!a/b/");
    expect(r.isShareRoot(dir("a/b"))).toBe(false);
    expect(r.isShareRoot(dir("a/b/c"))).toBe(false);
    expect(r.isShareRoot(dir("a/c"))).toBe(true);
  });

  it("a recursive exclusion followed by an exact allow of the same directory reopens it", () => {
    const r = rules("a/**", "!a/b/**", "a/b/");
    expect(r.isShareRoot(dir("a/b"))).toBe(true);
    expect(r.isShareRoot(dir("a/b/c"))).toBe(false);
  });

  it("an earlier exclusion is overridden by a later recursive allow", () => {
    const r = rules("!a/b/", "a/**");
    expect(r.isShareRoot(dir("a/b"))).toBe(true);
    expect(r.isExcluded("a/b/x")).toBe(false);
  });
});

describe("excluded ancestors cannot be reopened", () => {
  it("rejects a deeper exact allow below an excluded directory", () => {
    const r = rules("a/**", "!a/private/", "a/private/public/");
    expect(r.isShareRoot(dir("a/private/public"))).toBe(false);
    expect(r.isExcluded("a/private/public/x.txt")).toBe(true);
  });

  it("rejects a deeper recursive allow below an excluded directory", () => {
    const r = rules("!a/", "a/b/**");
    expect(r.isShareRoot(dir("a/b"))).toBe(false);
    expect(r.isShareRoot(dir("a/b/c"))).toBe(false);
    expect(r.isExcluded("a/b/c/x")).toBe(true);
  });

  it("rejects an allow for an object below an excluded directory", () => {
    const r = rules("a/**", "!a/secret/", "a/secret/ok.txt");
    expect(r.isExcluded("a/secret/ok.txt")).toBe(true);
  });

  it("only cares about ancestors whose LAST matching rule is an exclusion", () => {
    const r = rules("!a/", "a/", "a/b/");
    expect(r.isShareRoot(dir("a/b"))).toBe(true);
  });
});

describe("rule kinds", () => {
  it("an exact rule does not authorise subdirectories, but they are not excluded", () => {
    const r = rules("a/");
    expect(r.isShareRoot(["a"])).toBe(true);
    expect(r.isShareRoot(dir("a/b"))).toBe(false);
    expect(r.isExcluded("a/b/c.txt")).toBe(false);
  });

  it("a trailing / matches directories only", () => {
    const r = rules("a/**", "!a/*.log/");
    expect(r.isExcluded("a/x.log")).toBe(false);
    expect(r.isExcluded("a/x.log/inner.txt")).toBe(true);
  });

  it("a pattern without a trailing / matches objects and directories", () => {
    const r = rules("a/**", "!a/*.log", "b");
    expect(r.isExcluded("a/x.log")).toBe(true);
    expect(r.isExcluded("a/x.log/inner.txt")).toBe(true);
    expect(r.isShareRoot(dir("a/x.log"))).toBe(false);
    expect(r.isExcluded("a/x.txt")).toBe(false);
    expect(r.isShareRoot(["b"])).toBe(true);
  });

  it("/** does not match an object with the same name as the directory", () => {
    const r = rules("!a/b/**");
    expect(r.isExcluded("a/b")).toBe(false);
    expect(r.isExcluded("a/b/c")).toBe(true);
  });

  it("a recursive exclusion excludes objects below it", () => {
    const r = rules("a/**", "!a/tmp/**");
    expect(r.isExcluded("a/tmp/x")).toBe(true);
    expect(r.isExcluded("a/tmp/y/z")).toBe(true);
    expect(r.isShareRoot(dir("a/tmp"))).toBe(false);
  });

  it("patterns are anchored at the bucket root, with or without a leading /", () => {
    const r = rules("/a/", "b/");
    expect(r.rules.map((rule) => rule.body)).toEqual(["a", "b"]);
    expect(r.isShareRoot(["a"])).toBe(true);
    expect(r.isShareRoot(["b"])).toBe(true);
    expect(r.isShareRoot(dir("x/a"))).toBe(false);
    expect(r.isShareRoot(dir("x/b"))).toBe(false);
  });

  it("a pattern without / is still root-anchored (unlike gitignore)", () => {
    const r = rules("**", "!*.tmp");
    expect(r.isExcluded("x.tmp")).toBe(true);
    expect(r.isExcluded("a/x.tmp")).toBe(false);
  });

  it("! with a leading / is an anchored exclusion", () => {
    const r = rules("a/**", "!/a/b/");
    expect(r.rules[1]).toMatchObject({ exclude: true, body: "a/b", dirOnly: true });
    expect(r.isShareRoot(dir("a/b"))).toBe(false);
  });
});

describe("globs", () => {
  it("* matches within one segment, never across /", () => {
    const r = rules("releases/*/");
    expect(r.isShareRoot(dir("releases/x"))).toBe(true);
    expect(r.isShareRoot(dir("releases/.hidden"))).toBe(true);
    expect(r.isShareRoot(dir("releases/x/y"))).toBe(false);
    expect(r.isShareRoot(["releases"])).toBe(false);
  });

  it("* inside a name", () => {
    const r = rules("releases/project-*/");
    expect(r.isShareRoot(dir("releases/project-a"))).toBe(true);
    expect(r.isShareRoot(dir("releases/project-"))).toBe(true);
    expect(r.isShareRoot(dir("releases/project"))).toBe(false);
    expect(r.isShareRoot(dir("releases/xproject-a"))).toBe(false);
  });

  it("? matches exactly one character, never /", () => {
    const r = rules("v?/", "w?x/");
    expect(r.isShareRoot(["v1"])).toBe(true);
    expect(r.isShareRoot(["v."])).toBe(true);
    expect(r.isShareRoot(["v"])).toBe(false);
    expect(r.isShareRoot(["v12"])).toBe(false);
    expect(r.isShareRoot(dir("w/x"))).toBe(false);
    expect(r.isShareRoot(["w專x"])).toBe(true);
  });

  it("** matches zero or more whole segments", () => {
    const r = rules("a/**/b/");
    expect(r.isShareRoot(dir("a/b"))).toBe(true);
    expect(r.isShareRoot(dir("a/x/b"))).toBe(true);
    expect(r.isShareRoot(dir("a/x/y/z/b"))).toBe(true);
    expect(r.isShareRoot(dir("a/x/b/c"))).toBe(false);
    expect(r.isShareRoot(dir("x/a/b"))).toBe(false);
  });

  it("leading **/ matches at any depth, including the root", () => {
    const r = rules("**", "!**/node_modules/");
    expect(r.isShareRoot(["node_modules"])).toBe(false);
    expect(r.isShareRoot(dir("a/b/node_modules"))).toBe(false);
    expect(r.isExcluded("a/node_modules/x.js")).toBe(true);
    expect(r.isExcluded("a/x.js")).toBe(false);
  });

  it("** alone allows every directory", () => {
    const r = rules("**");
    expect(r.isShareRoot(["a"])).toBe(true);
    expect(r.isShareRoot(dir("a/b/c"))).toBe(true);
    expect(r.isShareRoot([])).toBe(false);
  });

  it("many globstars stay correct", () => {
    const r = rules("**/a/**/a/**/a/**/b/");
    expect(r.isShareRoot(dir("a/a/a/b"))).toBe(true);
    expect(r.isShareRoot([...Array(40).fill("a"), "b"])).toBe(true);
    expect(r.isShareRoot(Array(40).fill("a"))).toBe(false);
  });

  it("a**b inside a segment behaves like a*b", () => {
    const r = rules("a**b/", "***/c/");
    expect(r.isShareRoot(["ab"])).toBe(true);
    expect(r.isShareRoot(["axyb"])).toBe(true);
    expect(r.isShareRoot(dir("a/b"))).toBe(false);
    expect(r.isShareRoot(dir("x/y/c"))).toBe(true);
  });

  it.each([
    ["[abc]/", ["a", "c"], ["d", "ab", "A"]],
    ["[a-c]x/", ["ax", "bx", "cx"], ["dx", "-x"]],
    ["[!a]/", ["b", "-", "!"], ["a"]],
    ["[a]/", ["a"], ["[a]", "b"]],
    ["[^a]/", ["b", "^"], ["a"]],
    ["[]a]/", ["]", "a"], ["b"]],
    ["[!]a]/", ["b"], ["]", "a"]],
    ["[a-]/", ["a", "-"], ["b"]],
    ["[\\]\\-]/", ["]", "-"], ["\\"]],
    ["[.]x/", [".x"], ["ax"]],
    ["[(|)]/", ["(", "|", ")"], ["a"]],
    ["[專案]/", ["專", "案"], ["a"]],
    ["[0-9][0-9]/", ["07"], ["7", "a7"]],
  ])("character set %j", (pattern, matching, nonMatching) => {
    const r = rules(pattern);
    for (const name of matching) expect(r.isShareRoot([name]), name).toBe(true);
    for (const name of nonMatching) expect(r.isShareRoot([name]), name).toBe(false);
  });

  it("is case-sensitive", () => {
    const r = rules("Docs/", "*.PDF");
    expect(r.isShareRoot(["Docs"])).toBe(true);
    expect(r.isShareRoot(["docs"])).toBe(false);
    expect(r.isShareRoot(["a.pdf"])).toBe(false);
  });

  it("matches dotfiles and dot-directories like any other name", () => {
    const r = rules("**", "!**/.*");
    expect(r.isExcluded("a/.git/config")).toBe(true);
    expect(r.isExcluded("a/.env")).toBe(true);
    expect(r.isExcluded("a/x.env")).toBe(false);
  });

  it.each([
    ["{a,b}/", "{a,b}", "a"],
    ["@(a)/", "@(a)", "a"],
    ["+(a)/", "+(a)", "a"],
    ["a(b)/", "a(b)", "ab"],
    ['"q"/', '"q"', "q"],
    ["a|b/", "a|b", "a"],
    ["a+/", "a+", "aa"],
    ["$a^/", "$a^", "a"],
    ["a.b/", "a.b", "axb"],
    ["d/", "d", "1"],
    ["100%/", "100%", "100"],
    ["#x/", "#x", "x"],
  ])("%j is literal (no braces, extglobs, quotes or regex syntax)", (pattern, literal, other) => {
    const r = rules(`a/${pattern}`);
    expect(r.isShareRoot(["a", literal])).toBe(true);
    expect(r.isShareRoot(["a", other])).toBe(false);
  });

  it("literal special characters work next to wildcards", () => {
    const r = rules("{x}*(1)/");
    expect(r.isShareRoot(["{x} copy (1)"])).toBe(true);
    expect(r.isShareRoot(["x copy 1"])).toBe(false);
  });

  it("matches non-ASCII names", () => {
    const r = rules("分享/專案 *");
    expect(r.isShareRoot(dir("分享/專案 甲"))).toBe(true);
    expect(r.isShareRoot(dir("分享/專案甲"))).toBe(false);
  });
});

describe("file format", () => {
  it("ignores comments and blank lines", () => {
    const r = rules("# comment", "", "   ", "\t", "a/", "#!b/", "  ");
    expect(r.rules).toHaveLength(1);
    expect(r.isShareRoot(["b"])).toBe(false);
  });

  it("\\# and \\! match a literal leading # or !", () => {
    const r = rules("\\#notes/", "\\!important/", "!\\!secret/");
    expect(r.rules).toEqual([
      { line: 1, body: "\\#notes", exclude: false, dirOnly: true, recursive: false, literal: ["#notes"] },
      { line: 2, body: "\\!important", exclude: false, dirOnly: true, recursive: false, literal: ["!important"] },
      { line: 3, body: "\\!secret", exclude: true, dirOnly: true, recursive: false, literal: ["!secret"] },
    ]);
    expect(r.isShareRoot(["#notes"])).toBe(true);
    expect(r.isShareRoot(["!important"])).toBe(true);
    expect(r.isShareRoot(["important"])).toBe(false);
  });

  it("other escapes match the character literally", () => {
    const r = rules("a\\*b/", "c\\?/", "\\[x]/", "\\a/");
    expect(r.isShareRoot(["a*b"])).toBe(true);
    expect(r.isShareRoot(["axb"])).toBe(false);
    expect(r.isShareRoot(["c?"])).toBe(true);
    expect(r.isShareRoot(["cx"])).toBe(false);
    expect(r.isShareRoot(["[x]"])).toBe(true);
    expect(r.isShareRoot(["x"])).toBe(false);
    expect(r.isShareRoot(["a"])).toBe(true);
  });

  it("strips trailing spaces and tabs", () => {
    const r = rules("a/  ", "b/\t \t", "!a/c/ ");
    expect(r.rules.map((rule) => rule.body)).toEqual(["a", "b", "a/c"]);
    expect(r.isShareRoot(["a"])).toBe(true);
    expect(r.isShareRoot(["b"])).toBe(true);
  });

  it("keeps one escaped trailing space", () => {
    const r = rules("a\\ ", "b\\   ", "c\\\\ ");
    expect(r.isShareRoot(["a "])).toBe(true);
    expect(r.isShareRoot(["a"])).toBe(false);
    expect(r.isShareRoot(["b "])).toBe(true);
    expect(r.isShareRoot(["b   "])).toBe(false);
    // `\\` is an escaped backslash, so the space after it is not escaped.
    expect(r.rules[2]?.body).toBe("c\\\\");
  });

  it("accepts CRLF line endings", () => {
    const r = parseRules("a/\r\n!a/b/\r\n", RULES_KEY);
    expect(r.status).toBe("loaded");
    expect(r.rules.map((rule) => rule.body)).toEqual(["a", "a/b"]);
  });

  it("an empty file or a file with only comments authorises nothing", () => {
    for (const text of ["", "\n\n", "# only\n# comments\n"]) {
      const r = parseRules(text, RULES_KEY);
      expect(r.status).toBe("loaded");
      expect(r.isShareRoot(["a"])).toBe(false);
    }
  });

  it.each([
    ["leading space", " a/"],
    ["leading tab", "\ta/"],
    ["indented exclusion", "  !a/secret/"],
    ["indented comment", "  # note"],
    ["space after !", "! a/"],
    ["lone !", "!"],
    ["lone /", "/"],
    ["!/", "!/"],
    ["double leading /", "//a/"],
    ["empty segment", "a//b/"],
    ["trailing //", "a//"],
    [". segment", "a/./b/"],
    [".. segment", "a/../b/"],
    ["leading ..", "../a/"],
    ["escaped ..", "a/\\.\\./"],
    ["dangling backslash", "a\\"],
    ["escaped slash", "a\\/b/"],
    ["unclosed [", "a[bc/"],
    ["unclosed [!", "[!"],
    ["empty []", "[]/"],
    ["/ in brackets", "a[/]b/"],
    ["POSIX class", "[[:digit:]]/"],
    ["reversed range", "[z-a]/"],
    ["astral in brackets", "[😀]/"],
    ["NUL", "a\0b/"],
    ["tab inside", "a\tb/"],
    ["vertical tab", "a\u000bb/"],
    ["C1 control", "a\u0085b/"],
  ])("rejects the whole file for an invalid line: %s", (_label, line) => {
    expectInvalid(`ok/\n${line}\nfine/**\n`);
  });

  it("reports the failing line number", () => {
    const r = parseRules("a/\n# c\n  bad/\n", RULES_KEY);
    expect(r.problem).toMatch(/^line 3: leading whitespace/);
    expect(r.rules).toEqual([]);
  });
});

describe("isExcluded", () => {
  it("always excludes the configured rules object", () => {
    const r = rules("**");
    expect(r.isExcluded(RULES_KEY)).toBe(true);
    expect(r.isExcluded("a/.r2-share-rules")).toBe(false);
  });

  it("excludes a custom rules key, even inside an allowed directory", () => {
    const r = parseRules("config/**\n", "config/share.rules");
    expect(r.isShareRoot(["config"])).toBe(true);
    expect(r.isExcluded("config/share.rules")).toBe(true);
    expect(r.isExcluded("config/other")).toBe(false);
    expect(r.isExcluded(RULES_KEY)).toBe(false);
  });

  it.each(["", "a//b", "a/../b", "./a", "a\\b", "a/\0", "dir/"])("excludes unsafe key %j", (key) => {
    expect(rules("**").isExcluded(key)).toBe(true);
  });

  it("distinguishes similar-prefix directories", () => {
    const r = rules("**", "!project-a/");
    expect(r.isExcluded("project-a/x")).toBe(true);
    expect(r.isExcluded("project-a2/x")).toBe(false);
    expect(r.isExcluded("project-a")).toBe(false);
    expect(r.isShareRoot(["project-a2"])).toBe(true);
    expect(r.isShareRoot(["project-a"])).toBe(false);
  });

  it("gives the same answers when called repeatedly (cached ancestors)", () => {
    const r = rules("**", "!a/b/");
    for (let i = 0; i < 3; i++) {
      expect(r.isExcluded("a/b/c/d")).toBe(true);
      expect(r.isExcluded("a/c/d")).toBe(false);
      expect(r.isShareRoot(dir("a/b/c"))).toBe(false);
    }
  });
});

describe("isShareRoot", () => {
  it("distinguishes similar-prefix directories", () => {
    const r = rules("releases/project-a/", "releases/project-b/**");
    expect(r.isShareRoot(dir("releases/project-a2"))).toBe(false);
    expect(r.isShareRoot(dir("releases/project-a-old"))).toBe(false);
    expect(r.isShareRoot(dir("releases/project-b2"))).toBe(false);
    expect(r.isShareRoot(dir("releases/project-b2/x"))).toBe(false);
  });

  it.each([[[]], [[""]], [["a", ""]], [[".."]], [["a", "."]], [["a/b"]], [["a\\b"]]])(
    "rejects invalid segments %j",
    (segments) => {
      expect(rules("**").isShareRoot(segments)).toBe(false);
    },
  );
});

describe("denyAll", () => {
  it("authorises nothing and excludes everything", () => {
    const r = denyAll("missing", "test");
    expect(r.status).toBe("missing");
    expect(r.rules).toEqual([]);
    expect(r.isShareRoot(["a"])).toBe(false);
    expect(r.isExcluded("a/b")).toBe(true);
  });
});

describe("ShareRule.literal", () => {
  it.each([
    ["releases/project-a/", ["releases", "project-a"]],
    ["releases/project-b/**", ["releases", "project-b"]],
    ["!releases/private/", ["releases", "private"]],
    ["/rooted/", ["rooted"]],
    ["a\\*b/", ["a*b"]],
    ["\\#x/\\!y/\\ z\\?/", ["#x", "!y", " z?"]],
    ["發佈/專案 A/", ["發佈", "專案 A"]],
    ["file.txt", ["file.txt"]],
  ])("%j -> %j", (line, expected) => {
    expect(rules(line).rules[0]?.literal).toEqual(expected);
  });

  it.each(["a/**/b/", "a/*/", "a/b?/", "[ab]/", "**", "/**", "**/x/", "a*/"])("%j is not literal", (line) => {
    expect(rules(line).rules[0]?.literal).toBeNull();
  });
});

describe("isDirExcluded", () => {
  it("covers the directory itself and every ancestor", () => {
    const r = rules("a/**", "!a/b/", "a/b/c/");
    expect(r.isDirExcluded(["a"])).toBe(false);
    expect(r.isDirExcluded(["a", "b"])).toBe(true);
    expect(r.isDirExcluded(["a", "b", "c"])).toBe(true);
    expect(r.isDirExcluded(["a", "x"])).toBe(false);
    expect(r.isShareRoot(["a", "b", "c"])).toBe(false);
  });

  it("follows last match wins for the directory itself", () => {
    const r = rules("!a/", "a/");
    expect(r.isDirExcluded(["a"])).toBe(false);
    expect(rules("a/", "!a/").isDirExcluded(["a"])).toBe(true);
  });

  it("treats a recursive exclusion as excluding the directory", () => {
    const r = rules("!a/**");
    expect(r.isDirExcluded(["a"])).toBe(true);
    expect(r.isDirExcluded(["a", "b"])).toBe(true);
  });

  it("is false for the bucket root, invalid segments and broken rules", () => {
    const r = rules("!a/");
    expect(r.isDirExcluded([])).toBe(false);
    expect(r.isDirExcluded(["a/b"])).toBe(false);
    expect(r.isDirExcluded([".."])).toBe(false);
    expect(denyAll("missing", "x").isDirExcluded(["a"])).toBe(false);
    expect(parseRules("[unclosed", RULES_KEY).isDirExcluded(["a"])).toBe(false);
  });

  it("agrees with isExcluded for a child file when no rule can match files", () => {
    // Directory-only rules never match a file, so the file's verdict comes
    // from its ancestors alone.
    let seed = 7;
    const next = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
    const names = ["a", "b", "c"];
    const parts = [...names, "*", "?", "[ab]"];
    for (let run = 0; run < 200; run++) {
      const lines = Array.from({ length: 1 + next(5) }, () => {
        const depth = 1 + next(3);
        const body = Array.from({ length: depth }, () => parts[next(parts.length)]).join("/");
        return `${next(2) === 0 ? "!" : ""}${body}/`;
      });
      const r = rules(...lines);
      for (let probe = 0; probe < 10; probe++) {
        const dirPath = Array.from({ length: 1 + next(3) }, () => names[next(names.length)] as string);
        expect(r.isDirExcluded(dirPath), `${lines.join(" | ")} @ ${dirPath.join("/")}`).toBe(
          r.isExcluded(`${dirPath.join("/")}/x`),
        );
      }
    }
  });
});
