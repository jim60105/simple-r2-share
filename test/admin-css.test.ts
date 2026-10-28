/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import adminCss from "../public/admin/admin.css?raw";
import adminHtml from "../public/admin/index.html?raw";
import themeCss from "../public/assets/theme.css?raw";

const css = adminCss.replace(/\/\*[\s\S]*?\*\//g, "");
const theme = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--name: value` declarations of a stylesheet. */
function tokens(text: string): Map<string, string> {
  return new Map([...text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

describe("admin.css (admin UI spec §6.8, §8)", () => {
  it("defines the pending tokens", () => {
    const defined = tokens(css);
    expect(defined.get("--pending")).toBe("#ffc24a");
    expect(defined.get("--pending-ink")).toBe("#1a1204");
    expect(defined.get("--pending-bg")).toBe("#ffc24a0d");
  });

  it("never sets a font size below 16px", () => {
    const themeTokens = tokens(theme);
    const values = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((match) => match[1]!.trim());
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      if (value === "inherit") continue;
      const token = /^var\((--text-[a-z0-9-]+)\)$/.exec(value)?.[1];
      // theme.test.ts checks the --text-* tokens themselves.
      if (token !== undefined) {
        expect(themeTokens.has(token), value).toBe(true);
        continue;
      }
      for (const [, number, unit] of value.matchAll(/(\d*\.?\d+)(px|r?em)\b/g)) {
        expect(unit === "px" ? Number(number) : Number(number) * 16, value).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it("does not use the `font` shorthand", () => {
    expect(css).not.toMatch(/(?:^|[\s;{])font\s*:/);
  });

  it("uses colors only through tokens", () => {
    const withoutTokens = css.replace(/--[a-z0-9-]+\s*:\s*[^;}]+/g, "");
    expect(withoutTokens).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(withoutTokens).not.toMatch(/\b(?:rgb|hsl)a?\(/i);
  });

  it("only references tokens that admin.css or theme.css define", () => {
    const defined = new Set([...tokens(css).keys(), ...tokens(theme).keys(), "--depth"]);
    for (const [, name] of css.matchAll(/var\((--[a-z0-9-]+)/g)) expect(defined.has(name!), name).toBe(true);
  });
});

describe("admin/index.html (admin UI spec §10)", () => {
  it("has no inline script or style", () => {
    expect(adminHtml).not.toMatch(/\sstyle\s*=/i);
    expect(adminHtml).not.toMatch(/\son[a-z]+\s*=/i);
    for (const [tag] of adminHtml.matchAll(/<script\b[^>]*>/gi)) expect(tag).toMatch(/\ssrc="\/admin\/app\.js"/);
    expect(adminHtml).not.toMatch(/<style\b/i);
  });

  it("loads only same-origin assets in the documented order", () => {
    const sheets = [...adminHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]);
    expect(sheets).toEqual(["/fonts/JimMonoTC.css", "/assets/theme.css", "/admin/admin.css"]);
    expect(adminHtml).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
  });

  it("defines every icon the page and the script use", () => {
    const symbols = new Set([...adminHtml.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]));
    for (const name of ["logo", "folder", "caret", "inherit", "share", "share-sub", "exclude", "copy", "check", "close"]) {
      expect(symbols.has(`icon-${name}`), name).toBe(true);
    }
    for (const [, id] of adminHtml.matchAll(/<use href="#([^"]+)"/g)) expect(symbols.has(id), id).toBe(true);
  });

  it("links Sign out to the Access logout endpoint", () => {
    expect(adminHtml).toContain('href="/cdn-cgi/access/logout"');
  });
});
