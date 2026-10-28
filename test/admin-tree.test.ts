import { describe, expect, it } from "vitest";
import { childrenOf, compareNames, ruleChildNames } from "../src/admin/tree";

describe("compareNames", () => {
  it("sorts numbers numerically and is total", () => {
    const names = ["v10", "v2", "b", "B", "a", "發佈", "v1", "專案"];
    const sorted = [...names].sort(compareNames);
    expect(sorted.indexOf("v2")).toBeLessThan(sorted.indexOf("v10"));
    expect(sorted.indexOf("v1")).toBeLessThan(sorted.indexOf("v2"));
    expect([...names].reverse().sort(compareNames)).toEqual(sorted);
  });
});

describe("ruleChildNames", () => {
  const rules = ["releases/project-a", "releases/project-b/private", "tmp", "releases"];

  it("takes the next segment of every rule path below the parent", () => {
    expect([...ruleChildNames([], rules)].sort()).toEqual(["releases", "tmp"]);
    expect([...ruleChildNames(["releases"], rules)].sort()).toEqual(["project-a", "project-b"]);
    expect([...ruleChildNames(["releases", "project-b"], rules)]).toEqual(["private"]);
    expect([...ruleChildNames(["tmp"], rules)]).toEqual([]);
  });

  it("respects segment boundaries", () => {
    expect([...ruleChildNames(["a"], ["ab/c", "a-b", "a/c"])]).toEqual(["c"]);
  });
});

describe("childrenOf", () => {
  it("merges listed folders and rule paths, sorted", () => {
    const children = childrenOf([], new Set(["photos", "releases"]), true, ["old-project/x", "releases/project-a"]);
    expect(children.map((child) => child.name)).toEqual(["old-project", "photos", "releases"]);
    expect(children[0]).toEqual({ name: "old-project", path: "old-project", segments: ["old-project"], listed: false, missing: true });
    expect(children[2]).toMatchObject({ path: "releases", listed: true, missing: false });
  });

  it("builds nested paths", () => {
    const [child] = childrenOf(["releases"], new Set(["project-a"]), true, []);
    expect(child).toEqual({ name: "project-a", path: "releases/project-a", segments: ["releases", "project-a"], listed: true, missing: false });
  });

  it("shows rule paths but does not call them missing before the last page", () => {
    const children = childrenOf([], new Set(["a"]), false, ["z"]);
    expect(children.map((child) => [child.name, child.missing])).toEqual([
      ["a", false],
      ["z", false],
    ]);
    expect(childrenOf([], new Set(["a"]), true, ["z"]).find((child) => child.name === "z")?.missing).toBe(true);
  });

  it("adds intermediate ghost folders on the way to a deep rule", () => {
    expect(childrenOf([], new Set(), true, ["gone/deeper/target"]).map((child) => child.path)).toEqual(["gone"]);
    expect(childrenOf(["gone"], new Set(), true, ["gone/deeper/target"]).map((child) => child.path)).toEqual(["gone/deeper"]);
  });

  it("lists a folder that is both listed and named by a rule once", () => {
    expect(childrenOf([], new Set(["a"]), true, ["a", "a/b"])).toHaveLength(1);
  });
});
