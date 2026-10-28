import bs58 from "bs58";

/**
 * Independent copy of the short URL mask (rules editor spec §3) so tests can
 * build tokens for byte strings that `encodeShareToken` refuses.
 */
export function tokenOfBytes(bytes: Uint8Array): string {
  const out = Uint8Array.from(bytes);
  let x = (0x52325348 ^ Math.imul(out.length, 0x9e3779b1)) >>> 0 || 0x52325348;
  for (let i = 0; i < out.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = out[i]! ^ (x & 0xff);
  }
  return bs58.encode(out);
}
