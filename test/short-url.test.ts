import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { decodeShareToken, encodeShareToken, MAX_PATH_BYTES, MAX_TOKEN_LENGTH } from "../src/short-url";
import { tokenOfBytes } from "./tokens";

const utf8 = (text: string) => new TextEncoder().encode(text);

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Four segments joined by `/`: exactly 1024 bytes. */
const LONGEST = ["a".repeat(255), "b".repeat(255), "c".repeat(255), "d".repeat(256)];

describe("encodeShareToken / decodeShareToken", () => {
  it.each([
    [["releases"]],
    [["releases", "project-a"]],
    [["發佈", "專案 A"]],
    [["with space", "trailing "]],
    [["#hash", "?query", "100% off", "%41"]],
    [["emoji 📦", "🎉"]],
    [["a", "b", "c", "d", "e", "f"]],
    [[".hidden", "...", "v1.0"]],
    [["﻿bom"]],
    [LONGEST],
  ])("round-trips %j", (segments) => {
    const token = encodeShareToken(segments);
    expect(token).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(decodeShareToken(token)).toEqual(segments);
  });

  it("matches the golden vectors (changing them breaks every issued URL)", async () => {
    expect(encodeShareToken(["releases", "project-a"])).toBe("hxR19djQFNp3SS7mNmos88qd");
    expect(encodeShareToken(["發佈", "專案 A"])).toBe("4q2N13jyPP7WLE86wopSw");
    const longest = encodeShareToken(LONGEST);
    expect(longest).toHaveLength(1399);
    expect(await sha256Hex(longest)).toBe("339da58744bd72fb4b8d65ea1b77bf2e9cfc6f723f6e48fab9a2bb665828fd4b");
  });

  it("matches the independent mask implementation", () => {
    for (const segments of [["releases", "project-a"], ["發佈", "專案 A"], LONGEST]) {
      expect(encodeShareToken(segments)).toBe(tokenOfBytes(utf8(segments.join("/"))));
    }
  });

  it("uses a different mask for paths that share a prefix but differ in length", () => {
    const short = bs58.decode(encodeShareToken(["releases"]));
    const long = bs58.decode(encodeShareToken(["releases", "project-a"]));
    expect(short.subarray(0, 8)).not.toEqual(long.subarray(0, 8));
  });

  it("throws TypeError for segments that cannot be shared", () => {
    for (const segments of [[], [""], ["."], [".."], ["a/b"], ["a\\b"], ["a\0b"], ["x".repeat(1025)]]) {
      expect(() => encodeShareToken(segments), JSON.stringify(segments)).toThrow(TypeError);
    }
  });
});

describe("decodeShareToken rejects", () => {
  it.each([
    ["empty", ""],
    ["0", "0"],
    ["O", `hxR19djQFNp3SS7mNmos88q${"O"}`],
    ["I", "I"],
    ["l", "l"],
    ["/", "hxR19djQ/FNp3SS7mNmos88qd"],
    ["space", "hxR19djQ FNp3SS7mNmos88qd"],
    ["non-ASCII", "hxR19djQ專"],
    ["over the length limit", "z".repeat(MAX_TOKEN_LENGTH + 1)],
  ])("invalid token text: %s", (_label, token) => {
    expect(decodeShareToken(token)).toBeNull();
  });

  it("leading '1' padding never aliases the same folder", () => {
    expect(decodeShareToken(`1${encodeShareToken(["releases"])}`)).not.toEqual(["releases"]);
  });

  it("has no non-canonical tokens: Base58 round-trips every string over its alphabet", () => {
    let seed = 1;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let run = 0; run < 500; run++) {
      const length = 1 + (next() % 60);
      let token = "";
      for (let i = 0; i < length; i++) token += ALPHABET[next() % 58];
      expect(bs58.encode(bs58.decode(token)), token).toBe(token);
    }
  });

  it.each([
    ["invalid UTF-8", Uint8Array.of(0xff, 0xfe)],
    ["truncated UTF-8", Uint8Array.of(0xe5, 0xb0)],
    ["encoded surrogate", Uint8Array.of(0xed, 0xa0, 0x80)],
    ["empty segment", utf8("a//b")],
    ["leading slash", utf8("/a")],
    ["trailing slash", utf8("a/")],
    [". segment", utf8("a/./b")],
    [".. segment", utf8("a/../b")],
    ["backslash", utf8("a\\b")],
    ["NUL", utf8("a\0b")],
    ["tab", utf8("a\tb")],
    ["DEL", utf8("a\u007fb")],
    ["C1 control", utf8("a\u0085b")],
    ["over the byte limit", utf8("x".repeat(MAX_PATH_BYTES + 1))],
  ])("tokens that decode to an invalid path: %s", (_label, bytes) => {
    expect(decodeShareToken(tokenOfBytes(bytes))).toBeNull();
  });

  it("accepts the same bytes once they form a valid path", () => {
    expect(decodeShareToken(tokenOfBytes(utf8("x".repeat(MAX_PATH_BYTES))))).toEqual(["x".repeat(MAX_PATH_BYTES)]);
  });
});

describe("decode cost", () => {
  // A coarse regression guard only; the real budget is measured on Workers.
  it("decodes a 1024-byte path token in under 4 ms on average", () => {
    const token = encodeShareToken(LONGEST);
    decodeShareToken(token); // warm up
    const runs = 100;
    const start = performance.now();
    for (let i = 0; i < runs; i++) decodeShareToken(token);
    expect((performance.now() - start) / runs).toBeLessThan(4);
  });
});
