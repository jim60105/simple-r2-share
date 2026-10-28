/**
 * Reads the share rules object from R2 (spec §4). Kept apart from
 * `src/rules.ts` so the parser stays free of Workers types and can be bundled
 * into the admin page.
 */
import { denyAll, MAX_RULES_FILE_BYTES, parseRules, type Rules } from "./rules";

/** Reading the rules object from R2 failed; routes should answer with the generic error page. */
export class RulesReadError extends Error {
  override name = "RulesReadError";
}

/**
 * Reads and parses the rules object.
 *
 * - Missing object: deny-all rules with status `missing`.
 * - Larger than `MAX_RULES_FILE_BYTES`, not valid UTF-8 or any invalid line:
 *   deny-all rules with status `invalid` and a `problem` for the server log.
 * - R2 errors (`get` or reading the body throws) are NOT turned into deny-all
 *   rules: they are rethrown as `RulesReadError`, so the route shows the
 *   generic error page (spec §8 "R2 temporary failure") instead of a `404`
 *   that would make a working share look deleted. Either way nothing is
 *   authorised and the response reveals nothing about the bucket.
 */
export async function loadRules(bucket: R2Bucket, rulesKey: string): Promise<Rules> {
  let bytes: ArrayBuffer;
  try {
    const object = await bucket.get(rulesKey);
    if (object === null) return denyAll("missing", "rules object not found");
    if (object.size > MAX_RULES_FILE_BYTES) {
      await object.body.cancel().catch(() => undefined);
      return denyAll("invalid", `rules object is larger than ${MAX_RULES_FILE_BYTES} bytes`);
    }
    bytes = await object.arrayBuffer();
  } catch (error) {
    throw new RulesReadError("failed to read the share rules object", { cause: error });
  }

  let text: string;
  try {
    // `fatal` rejects invalid UTF-8; a leading BOM is skipped.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return denyAll("invalid", "rules object is not valid UTF-8");
  }
  return parseRules(text, rulesKey);
}
