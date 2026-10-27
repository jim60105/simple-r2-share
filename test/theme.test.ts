/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import themeCss from "../public/assets/theme.css?raw";

const css = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** Values of `font-size` declarations and `--text-*` tokens. */
const sizeValues = [...css.matchAll(/(?:font-size|--text-[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map((match) => match[1]!.trim());

describe("theme.css (UI spec §3.3, §11)", () => {
  it("declares font sizes", () => {
    expect(sizeValues.length).toBeGreaterThan(10);
  });

  it("never sets a font size below 16px", () => {
    for (const value of sizeValues) {
      for (const [, number, unit] of value.matchAll(/(\d*\.?\d+)(px|r?em)\b/g)) {
        const px = unit === "px" ? Number(number) : Number(number) * 16;
        expect(px, `${value}`).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it("does not use the `font` shorthand, which would hide sizes from the check above", () => {
    expect(css).not.toMatch(/(?:^|[\s;{])font\s*:/);
  });

  it("loads fonts only from /fonts/", () => {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^\/fonts\/[A-Za-z0-9.-]+\.woff2$/);
  });
});
