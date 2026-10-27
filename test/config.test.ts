import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_SHARE_RULES_KEY, loadConfig } from "../src/config";

const BASE = { R2_PUBLIC_BASE_URL: "https://files.example.com" };

describe("loadConfig", () => {
  it("applies defaults when only the public URL is set", () => {
    expect(loadConfig(BASE)).toEqual({
      publicBaseUrl: "https://files.example.com",
      zipEnabled: false,
      shareRulesKey: ".r2-share-rules",
      footerHtml: null,
    });
    expect(DEFAULT_SHARE_RULES_KEY).toBe(".r2-share-rules");
  });

  describe("ENABLE_ZIP_DOWNLOAD", () => {
    it("is enabled only by the exact string 'true'", () => {
      expect(loadConfig({ ...BASE, ENABLE_ZIP_DOWNLOAD: "true" }).zipEnabled).toBe(true);
    });

    it.each(["false", "", "TRUE", "True", " true", "true ", "1", "yes", "on"])(
      "is disabled for %j",
      (value) => {
        expect(loadConfig({ ...BASE, ENABLE_ZIP_DOWNLOAD: value }).zipEnabled).toBe(false);
      },
    );
  });

  describe("SHARE_RULES_KEY", () => {
    it("defaults when unset or empty", () => {
      expect(loadConfig(BASE).shareRulesKey).toBe(".r2-share-rules");
      expect(loadConfig({ ...BASE, SHARE_RULES_KEY: "" }).shareRulesKey).toBe(".r2-share-rules");
    });

    it("uses a custom key verbatim", () => {
      expect(loadConfig({ ...BASE, SHARE_RULES_KEY: "config/share.rules" }).shareRulesKey).toBe(
        "config/share.rules",
      );
    });
  });

  describe("FOOTER_HTML", () => {
    it("is null when unset or empty", () => {
      expect(loadConfig(BASE).footerHtml).toBeNull();
      expect(loadConfig({ ...BASE, FOOTER_HTML: "" }).footerHtml).toBeNull();
    });

    it("is kept verbatim when set", () => {
      const html = '© 2026 <a href="https://example.com/">Example</a> & friends';
      expect(loadConfig({ ...BASE, FOOTER_HTML: html }).footerHtml).toBe(html);
    });
  });

  describe("R2_PUBLIC_BASE_URL", () => {
    it.each([
      ["https://files.example.com", "https://files.example.com"],
      ["https://files.example.com/", "https://files.example.com"],
      ["https://files.example.com//", "https://files.example.com"],
      ["https://FILES.Example.com", "https://files.example.com"],
      ["https://files.example.com:8443/", "https://files.example.com:8443"],
      ["https://cdn.example.com/bucket", "https://cdn.example.com/bucket"],
      ["https://cdn.example.com/bucket/", "https://cdn.example.com/bucket"],
      ["https://pub-0123456789abcdef.r2.dev", "https://pub-0123456789abcdef.r2.dev"],
    ])("normalizes %j to %j", (input, expected) => {
      expect(loadConfig({ R2_PUBLIC_BASE_URL: input }).publicBaseUrl).toBe(expected);
    });

    it("produces a base that object paths can be appended to", () => {
      const { publicBaseUrl } = loadConfig({ R2_PUBLIC_BASE_URL: "https://files.example.com/" });
      const key = ["releases", "專案 a", "README.md"].map(encodeURIComponent).join("/");
      expect(new URL(`${publicBaseUrl}/${key}`).pathname).toBe(
        "/releases/%E5%B0%88%E6%A1%88%20a/README.md",
      );
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["http", "http://files.example.com"],
      ["uppercase scheme", "HTTPS://files.example.com"],
      ["leading whitespace", " https://files.example.com"],
      ["protocol-relative", "//files.example.com"],
      ["no scheme", "files.example.com"],
      ["other scheme", "ftp://files.example.com"],
      ["javascript scheme", "javascript:alert(1)"],
      ["scheme only", "https://"],
      ["invalid host", "https://exa mple.com"],
      ["credentials", "https://user:pass@files.example.com"],
      ["query", "https://files.example.com/?a=1"],
      ["empty query", "https://files.example.com/?"],
      ["fragment", "https://files.example.com/#top"],
    ])("rejects %s", (_label, value) => {
      expect(() => loadConfig({ R2_PUBLIC_BASE_URL: value })).toThrow(ConfigError);
    });

    it("throws an error identifiable by type and name", () => {
      try {
        loadConfig({});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("ConfigError");
      }
    });
  });
});
