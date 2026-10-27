import { describe, expect, it } from "vitest";
import {
  bytesQuantity,
  fileCountQuantity,
  folderCountQuantity,
  formatBytes,
  formatFileCount,
  formatFolderCount,
  formatItemCount,
  formatSyncedTime,
  itemCountQuantity,
} from "../src/format";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [412, "412 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1025, "1.0 KB"],
    [1536, "1.5 KB"],
    [8.4 * KB, "8.4 KB"],
    [Math.round(248.6 * MB), "248.6 MB"],
    [1023 * KB, "1023.0 KB"],
    [1023.94 * KB, "1023.9 KB"],
    // Would round to 1024.0 KB: shown in the next unit instead.
    [1023.95 * KB, "1.0 MB"],
    [MB - 1, "1.0 MB"],
    [MB, "1.0 MB"],
    [GB - 1, "1.0 GB"],
    [1.5 * GB, "1.5 GB"],
    [TB - 1, "1.0 TB"],
    [TB, "1.0 TB"],
    [1023.95 * TB, "1024.0 TB"],
    [2048 * TB, "2048.0 TB"],
  ])("%d bytes -> %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("rounds fractional bytes", () => {
    expect(formatBytes(1.4)).toBe("1 B");
    expect(formatBytes(1023.5)).toBe("1.0 KB");
  });

  it("keeps number and unit apart in bytesQuantity", () => {
    expect(bytesQuantity(Math.round(248.6 * MB))).toEqual({ value: "248.6", unit: "MB" });
    expect(bytesQuantity(0)).toEqual({ value: "0", unit: "B" });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %d", (bytes) => {
    expect(() => formatBytes(bytes)).toThrow(RangeError);
  });
});

describe("counts", () => {
  it("uses singular only for exactly one", () => {
    expect(formatFileCount(0)).toBe("0 FILES");
    expect(formatFileCount(1)).toBe("1 FILE");
    expect(formatFileCount(2)).toBe("2 FILES");
    expect(formatFolderCount(0)).toBe("0 FOLDERS");
    expect(formatFolderCount(1)).toBe("1 FOLDER");
    expect(formatFolderCount(3)).toBe("3 FOLDERS");
    expect(formatItemCount(1)).toBe("1 item");
    expect(formatItemCount(3)).toBe("3 items");
    expect(formatItemCount(1000)).toBe("1000 items");
  });

  it("keeps number and unit apart", () => {
    expect(fileCountQuantity(9)).toEqual({ value: "9", unit: "FILES" });
    expect(folderCountQuantity(1)).toEqual({ value: "1", unit: "FOLDER" });
    expect(itemCountQuantity(2)).toEqual({ value: "2", unit: "items" });
  });

  it.each([-1, 1.5, Number.NaN])("rejects %d", (count) => {
    expect(() => formatFileCount(count)).toThrow(RangeError);
    expect(() => formatItemCount(count)).toThrow(RangeError);
  });
});

describe("formatSyncedTime", () => {
  it("formats in UTC on a 24-hour clock", () => {
    expect(formatSyncedTime(new Date("2026-10-27T08:05:00Z"))).toBe("2026-10-27 08:05 UTC");
    expect(formatSyncedTime(new Date("2026-01-02T23:59:59.999Z"))).toBe("2026-01-02 23:59 UTC");
    expect(formatSyncedTime(new Date("2026-12-31T00:00:00Z"))).toBe("2026-12-31 00:00 UTC");
  });

  it("converts from other offsets", () => {
    expect(formatSyncedTime(new Date("2026-10-28T01:30:00+08:00"))).toBe("2026-10-27 17:30 UTC");
  });

  it("rejects an invalid date", () => {
    expect(() => formatSyncedTime(new Date(Number.NaN))).toThrow(RangeError);
  });
});
