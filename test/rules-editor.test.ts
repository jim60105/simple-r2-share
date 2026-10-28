import { describe, expect, it } from "vitest";
import { parseRules } from "../src/rules";
import {
  changedPaths,
  countBelow,
  effectiveState,
  escapeSegment,
  MANAGED_HEADER,
  pathKey,
  readRulesFile,
  serializeRules,
  type RuleState,
  type StateTable,
} from "../src/rules-editor";

const RULES_KEY = ".r2-share-rules";

function read(...lines: string[]) {
  return readRulesFile(lines.join("\n"), RULES_KEY);
}

function table(entries: Record<string, RuleState>): StateTable {
  return new Map(Object.entries(entries));
}

describe("readRulesFile: supported lines", () => {
  it.each([
    ["releases/project-a/", "releases/project-a", "share"],
    ["releases/project-b/**", "releases/project-b", "share-sub"],
    ["!releases/private/", "releases/private", "exclude"],
    ["!releases/private/**", "releases/private", "exclude"],
    ["/rooted/", "rooted", "share"],
    ["!/rooted/**", "rooted", "exclude"],
    ["a\\*b/", "a*b", "share"],
    ["\\#notes/", "#notes", "share"],
    ["\\!bang/**", "!bang", "share-sub"],
    ["with\\ space\\ /", "with space ", "share"],
    ["發佈/專案\\ A/", "發佈/專案 A", "share"],
  ])("%j -> %s %s", (line, key, state) => {
    const model = read(line);
    expect(model.unsupported).toEqual([]);
    expect([...model.states]).toEqual([[key, state]]);
  });

  it("does not report comments or blank lines", () => {
    const model = read("# comment", "", "a/", "   ", "# another");
    expect(model.unsupported).toEqual([]);
    expect([...model.states]).toEqual([["a", "share"]]);
  });
});

describe("readRulesFile: unsupported lines", () => {
  it.each([
    ["glob", "**/*.tmp"],
    ["glob in a segment", "releases/v[0-9]*/"],
    ["question mark", "releases/v?/"],
    ["globstar in the middle", "a/**/b/"],
    ["no trailing slash", "releases/a"],
    ["exclusion without trailing slash", "!releases/a"],
    ["everything", "**"],
    ["backslash in a name", "a\\\\b/"],
  ])("%s", (_label, line) => {
    const model = read("keep/", line);
    expect(model.unsupported).toEqual([{ line: 2, text: line }]);
    expect([...model.states]).toEqual([["keep", "share"]]);
  });

  it("reports a repeated path and keeps the first", () => {
    const model = read("a/", "!a/");
    expect(model.unsupported).toEqual([{ line: 2, text: "!a/" }]);
    expect(model.states.get("a")).toBe("share");
  });

  it("reports an ancestor that comes after its descendant", () => {
    const model = read("a/b/", "!a/");
    expect(model.unsupported).toEqual([{ line: 2, text: "!a/" }]);
    expect([...model.states]).toEqual([["a/b", "share"]]);
  });

  it("accepts an ancestor before its descendant and siblings in any order", () => {
    const model = read("z/", "a/**", "!a/b/", "a/c/");
    expect(model.unsupported).toEqual([]);
    expect(model.states.size).toBe(4);
  });

  it("keeps the original line text without the trailing \\r", () => {
    const model = readRulesFile("a/\r\n**/*.tmp   \r\n", RULES_KEY);
    expect(model.unsupported).toEqual([{ line: 2, text: "**/*.tmp   " }]);
  });

  it("keeps unsupported lines in Live", () => {
    const model = read("a/**", "!a/*/secret/");
    expect(model.rules.isShareRoot(["a", "x", "secret"])).toBe(false);
    expect(model.states.size).toBe(1);
  });

  it("yields no states for an invalid file", () => {
    const model = read("a/", "[unclosed");
    expect(model.rules.status).toBe("invalid");
    expect(model.states.size).toBe(0);
    expect(model.unsupported).toEqual([]);
  });
});

describe("escapeSegment", () => {
  it.each([
    ["plain", "plain"],
    ["a*b?c", "a\\*b\\?c"],
    ["[x]", "\\[x\\]"],
    ["!#", "\\!\\#"],
    ["back\\slash", "back\\\\slash"],
    ["a b", "a\\ b"],
    ["全形\u3000空白", "全形\\\u3000空白"],
  ])("%j -> %j", (name, escaped) => {
    expect(escapeSegment(name)).toBe(escaped);
  });
});

describe("serializeRules", () => {
  it("writes the header and sorts ancestors first", () => {
    const text = serializeRules(
      table({ tmp: "exclude", "releases/project-b/private": "exclude", "releases/project-b": "share-sub", "releases/project-a": "share" }),
    );
    expect(text).toBe(
      [MANAGED_HEADER, "releases/project-a/", "releases/project-b/**", "!releases/project-b/private/", "!tmp/", ""].join("\n"),
    );
  });

  it("compares segment by segment in UTF-16 code unit order", () => {
    // Plain string order would put `a-b` (0x2D) before `a/c` (0x2F); per segment `a` comes first.
    const text = serializeRules(table({ "a-b": "share", "a/c": "share", a: "share", B: "share", 專: "share" }));
    expect(text.split("\n").slice(1, -1)).toEqual(["B/", "a/", "a/c/", "a-b/", "專/"]);
  });

  it("writes only the header for an empty draft", () => {
    expect(serializeRules(new Map())).toBe(`${MANAGED_HEADER}\n`);
    expect(parseRules(serializeRules(new Map()), RULES_KEY).rules).toEqual([]);
  });

  it("escapes names so they parse back to the same folders", () => {
    const states = table({ "a*b": "share", "#x/!y": "share-sub", " lead/trail ": "exclude", "[x]?": "share" });
    const model = readRulesFile(serializeRules(states), RULES_KEY);
    expect(model.rules.status).toBe("loaded");
    expect(model.unsupported).toEqual([]);
    expect(model.states).toEqual(states);
  });

  it("is deterministic", () => {
    const a = table({ x: "share", "x/y": "exclude", b: "share-sub" });
    const b = table({ b: "share-sub", "x/y": "exclude", x: "share" });
    expect(serializeRules(a)).toBe(serializeRules(b));
  });

  it("throws for a key that is not a folder path", () => {
    for (const key of ["", "a//b", "a/..", "a\\b", "/a"]) {
      expect(() => serializeRules(table({ [key]: "share" })), key).toThrow(TypeError);
    }
  });

  it("round-trips random state tables", () => {
    let seed = 42;
    const next = (n: number) => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
    const names = ["a", "b", "發佈", "專案 A", "with space", " lead", "trail ", "*", "?x", "[ab]", "!bang", "#hash", "全形\u3000空白", "📦"];
    const statesList: RuleState[] = ["share", "share-sub", "exclude"];
    for (let run = 0; run < 200; run++) {
      const states = new Map<string, RuleState>();
      const size = next(12);
      for (let i = 0; i < size; i++) {
        const depth = 1 + next(4);
        const segments = Array.from({ length: depth }, () => names[next(names.length)] as string);
        states.set(pathKey(segments), statesList[next(3)] as RuleState);
      }
      const model = readRulesFile(serializeRules(states), RULES_KEY);
      expect(model.rules.status, [...states.keys()].join(" | ")).toBe("loaded");
      expect(model.unsupported).toEqual([]);
      expect(model.states).toEqual(states);
    }
  });
});

describe("effectiveState", () => {
  const states = table({
    releases: "share-sub",
    "releases/private": "exclude",
    "releases/private/open": "share",
    docs: "share",
  });

  it.each([
    ["releases", "shared"],
    ["releases/project-a", "shared"],
    ["releases/private", "excluded"],
    ["releases/private/open", "excluded"],
    ["releases/private/deep/x", "excluded"],
    ["docs", "shared"],
    ["docs/sub", "none"],
    ["other", "none"],
  ])("%s is %s", (path, expected) => {
    const rules = parseRules(serializeRules(states), RULES_KEY);
    expect(effectiveState(rules, path.split("/"))).toBe(expected);
  });

  it("lets unsupported lines affect Live only", () => {
    const live = read("a/**", "!a/*/secret/");
    expect(effectiveState(live.rules, ["a", "x", "secret"])).toBe("excluded");
    const draft = parseRules(serializeRules(live.states), RULES_KEY);
    expect(effectiveState(draft, ["a", "x", "secret"])).toBe("shared");
  });

  it("shares nothing for a missing or invalid file", () => {
    expect(effectiveState(read("[unclosed").rules, ["a"])).toBe("none");
  });
});

describe("changedPaths and countBelow", () => {
  it("lists paths whose state differs in either direction", () => {
    const live = table({ a: "share", b: "exclude", c: "share-sub" });
    const draft = table({ a: "share", b: "share", d: "exclude" });
    expect([...changedPaths(live, draft)].sort()).toEqual(["b", "c", "d"]);
    expect(changedPaths(live, live).size).toBe(0);
  });

  it("counts paths strictly below a folder", () => {
    const paths = ["a", "a/b", "a/b/c", "ab", "a-b/x", "b/a"];
    expect(countBelow(paths, "a")).toBe(2);
    expect(countBelow(paths, "a/b")).toBe(1);
    expect(countBelow(paths, "ab")).toBe(0);
    expect(countBelow(new Set(paths), "b")).toBe(1);
  });
});
