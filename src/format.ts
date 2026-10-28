/**
 * Display formats from UI spec §8. Each value has a `…Quantity` form that keeps
 * the number and the unit apart, because the stats row renders the number in
 * bold (UI spec §5.2), and a `format…` form that joins them with one space.
 *
 * Invalid input (negative, non-finite, non-integer counts, invalid dates) is
 * a programming error and throws `RangeError`; R2 never reports such values.
 */

export interface Quantity {
  /** The number as displayed, e.g. `248.6` or `3`. */
  readonly value: string;
  /** e.g. `MB`, `FILES`, `item`. */
  readonly unit: string;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const LAST_UNIT = BYTE_UNITS.length - 1;

/**
 * File size with 1024-based units: `B` without decimals, `KB` to `TB` with one
 * decimal (`412 B`, `8.4 KB`, `248.6 MB`). A value that would round up to
 * `1024` of a unit moves to the next unit instead (`1048575` is `1.0 MB`, not
 * `1024.0 KB`). `TB` is the largest unit (`2048.0 TB`).
 */
export function bytesQuantity(bytes: number): Quantity {
  if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`invalid byte count: ${bytes}`);
  let unit = 0;
  let scaled = bytes;
  for (;;) {
    const rounded = unit === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
    if (rounded < 1024 || unit === LAST_UNIT) {
      return { value: unit === 0 ? String(rounded) : rounded.toFixed(1), unit: BYTE_UNITS[unit] as string };
    }
    unit++;
    scaled = bytes / 1024 ** unit;
  }
}

export function formatBytes(bytes: number): string {
  return join(bytesQuantity(bytes));
}

function countQuantity(count: number, singular: string, plural: string): Quantity {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`invalid count: ${count}`);
  return { value: String(count), unit: count === 1 ? singular : plural };
}

/** `1 FILE`, `0 FILES`, `2 FILES` (stats row). */
export function fileCountQuantity(count: number): Quantity {
  return countQuantity(count, "FILE", "FILES");
}

/** `1 FOLDER`, `0 FOLDERS`, `3 FOLDERS` (stats row). */
export function folderCountQuantity(count: number): Quantity {
  return countQuantity(count, "FOLDER", "FOLDERS");
}

/** `1 item`, `3 items` (a folder's direct children). */
export function itemCountQuantity(count: number): Quantity {
  return countQuantity(count, "item", "items");
}

export function formatFileCount(count: number): string {
  return join(fileCountQuantity(count));
}

export function formatFolderCount(count: number): string {
  return join(folderCountQuantity(count));
}

export function formatItemCount(count: number): string {
  return join(itemCountQuantity(count));
}

/**
 * The top bar's sync time, `YYYY-MM-DD HH:mm UTC` on a 24-hour clock (seconds
 * are truncated). Per UI spec §5.1 this is the time the server rendered the
 * page, so pass the request time, not an object's `uploaded`.
 */
export function formatSyncedTime(date: Date): string {
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new RangeError("invalid date");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  return `${year}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function join(quantity: Quantity): string {
  return `${quantity.value} ${quantity.unit}`;
}

// Han, kana, Hangul, Bopomofo, CJK punctuation and full-width forms: the
// characters that come from Jim Mono TC's CJK design rather than Chakra Petch.
// The brand wraps each run in `.brand__cjk` (share pages and the admin page).
export const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303F\uFF00-\uFFEF]+/gu;
