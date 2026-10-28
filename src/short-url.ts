/**
 * Stateless, reversible share tokens for `/s/<token>/` (rules editor spec §3).
 * Shared by the Pages Functions (decode) and the admin page (encode), so this
 * module uses no Workers- or DOM-only globals.
 *
 * token = Base58( UTF-8(path) XOR xorshift32 mask )
 *
 * - `path` is the share folder's segments joined with `/`, without leading or
 *   trailing `/`.
 * - The mask comes from a fixed PUBLIC seed mixed with the byte length. It only
 *   changes how the URL looks: anyone can reverse it, so it provides no
 *   secrecy and no authorisation. Callers must still run `isShareRoot()`.
 * - Changing anything here breaks every URL already handed out; the golden
 *   vectors in `test/short-url.test.ts` guard against that.
 */

import bs58 from "bs58";
import { isValidSegment } from "./paths";

/** Longest token accepted before Base58 decoding (Base58 decoding is roughly quadratic). */
export const MAX_TOKEN_LENGTH = 1400;
/** Longest folder path in UTF-8 bytes, the same as the R2 object key limit. */
export const MAX_PATH_BYTES = 1024;

const SEED = 0x52325348; // ASCII "R2SH"
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** XORs `bytes` in place with the xorshift32 mask for its length; its own inverse. */
function mask(bytes: Uint8Array): Uint8Array {
  let x = (SEED ^ Math.imul(bytes.length, 0x9e3779b1)) >>> 0;
  if (x === 0) x = SEED;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    bytes[i] = bytes[i]! ^ (x & 0xff);
  }
  return bytes;
}

/**
 * Token for a share folder, e.g. `["releases", "project-a"]`. Throws
 * `TypeError` for empty or invalid segments or a path over `MAX_PATH_BYTES`,
 * which is a programming error: callers only encode folders they listed.
 */
export function encodeShareToken(segments: readonly string[]): string {
  if (segments.length === 0 || !segments.every(isValidSegment)) {
    throw new TypeError("short-url: invalid folder segments");
  }
  const bytes = encoder.encode(segments.join("/"));
  if (bytes.length > MAX_PATH_BYTES) throw new TypeError("short-url: folder path too long");
  return bs58.encode(mask(bytes));
}

/**
 * Folder segments for a token, or `null` for anything that is not a canonical
 * token of a valid folder path. Never throws.
 */
export function decodeShareToken(token: string): string[] | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !BASE58.test(token)) return null;
  let path: string;
  try {
    const bytes = bs58.decodeUnsafe(token);
    // Standard Base58 is a bijection between strings over its alphabet and
    // byte arrays (leading `1`s are exactly the leading zero bytes), so every
    // accepted token is already canonical: one token per folder. Re-encoding
    // to check that would triple the decode cost (test/short-url.test.ts
    // checks the property instead).
    if (bytes === undefined || bytes.length === 0 || bytes.length > MAX_PATH_BYTES) return null;
    path = decoder.decode(mask(bytes)); // throws on invalid UTF-8
  } catch {
    return null;
  }
  const segments = path.split("/");
  return segments.every(isValidSegment) ? segments : null;
}
