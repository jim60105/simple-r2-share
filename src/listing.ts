/**
 * Recursive listing of one share root and the in-memory file tree (spec §6
 * steps 2–3, UI spec §5.3).
 *
 * - `listAll` pages through `bucket.list({ prefix, cursor })` until R2 says the
 *   listing is no longer `truncated` (never "fewer objects than `limit`"). No
 *   `delimiter` is used, so one listing returns the whole subtree. The default
 *   list output already has `key`, `size` and `uploaded`, so no `include` is
 *   requested.
 * - `buildListing` keeps only objects that are strictly inside the prefix on a
 *   segment boundary and form a safe relative key (`relativeKey`), skips
 *   directory markers (keys ending in `/`) and drops every key the share rules
 *   exclude. Folders exist only because a kept file lies below them, so a
 *   folder whose objects are all excluded or markers does not appear at all.
 * - Each level lists folders first, then files; names are ordered with one
 *   shared `Intl.Collator("zh-Hant-TW", { numeric: true })` (`v2` before
 *   `v10`, Chinese by stroke count), ties broken by UTF-16 code units so the
 *   order is total and deterministic (`file01` and `file1` collate equal).
 *
 * Work is a single pass over the keys plus one sort per folder, to stay well
 * inside the Workers Free 10 ms CPU budget (spec §7.1).
 */
import { relativeKey } from "./paths";
import type { Rules } from "./rules";

/** Objects requested per `list()` call (the R2 maximum). */
export const LIST_PAGE_LIMIT = 1000;

/**
 * Safety net, not a product limit (spec §1.1 expects at most ~100 files): a
 * share that returns more raw objects than this would blow the Workers Free
 * CPU budget anyway, so we stop early with `ListingError` ("too-many-objects")
 * and the route shows the generic error page.
 */
export const MAX_LISTED_OBJECTS = 10_000;

/**
 * Safety net against a list API that keeps returning small or empty pages with
 * an advancing cursor. Each page is also one internal subrequest.
 */
export const MAX_LIST_PAGES = 100;

export type ListingErrorReason =
  /** `truncated` without a cursor, the same cursor again, or a cursor seen before. */
  | "cursor-not-advancing"
  /** More than `MAX_LISTED_OBJECTS` objects or `MAX_LIST_PAGES` pages. */
  | "too-many-objects";

/** Listing could not be completed safely; routes should answer with the generic error page. */
export class ListingError extends Error {
  override name = "ListingError";
  readonly reason: ListingErrorReason;

  constructor(reason: ListingErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The object fields the listing uses (a subset of `R2Object`). */
export type ListedObject = Pick<R2Object, "key" | "size" | "uploaded">;

export interface ListLimits {
  /** Defaults to `MAX_LISTED_OBJECTS`. */
  readonly maxObjects?: number;
  /** Defaults to `MAX_LIST_PAGES`. */
  readonly maxPages?: number;
}

export interface FileNode {
  readonly kind: "file";
  /** Last path segment, e.g. `a.txt`. */
  readonly name: string;
  /** Path relative to the share root, e.g. `docs/a.txt` (no leading `/`). */
  readonly path: string;
  /** Full R2 object key, e.g. `releases/project-a/docs/a.txt`. */
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
}

export interface FolderNode {
  readonly kind: "folder";
  /** Last path segment, e.g. `docs`. */
  readonly name: string;
  /** Path relative to the share root, e.g. `docs/img` (no leading or trailing `/`). */
  readonly path: string;
  /** Direct children: folders first, then files, each sorted by name. Never empty. */
  readonly children: readonly TreeNode[];
  /** Number of direct children (`children.length`), shown as `3 items`. */
  readonly childCount: number;
}

export type TreeNode = FolderNode | FileNode;

export interface Listing {
  /** The listed prefix, e.g. `releases/project-a/`. */
  readonly prefix: string;
  /** Top-level children of the share root, ordered like `FolderNode.children`. */
  readonly root: readonly TreeNode[];
  /**
   * Every listed file in tree display order (depth-first; in each folder its
   * subfolders' files come before its own files). Deterministic: use it for
   * the ZIP entry order.
   */
  readonly files: readonly FileNode[];
  /** Listed files by `FileNode.path`, e.g. `byPath.get("README.md")`. */
  readonly byPath: ReadonlyMap<string, FileNode>;
  /** Listed files (after exclusion). */
  readonly fileCount: number;
  /** Listed folders at every depth (after exclusion). */
  readonly folderCount: number;
  /** Sum of the listed files' sizes. */
  readonly totalBytes: number;
}

const collator = new Intl.Collator("zh-Hant-TW", { numeric: true });

/** Name order used at every tree level: collator first, then UTF-16 code units. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function assertPrefix(prefix: string): void {
  if (prefix === "" || prefix === "/" || !prefix.endsWith("/")) {
    throw new TypeError("listing: prefix must be a share root from toPrefix (non-empty, ending with `/`)");
  }
}

/**
 * Lists every object under `prefix` (which must come from `toPrefix`),
 * following `cursor` while `truncated`. Errors from `bucket.list` propagate
 * unchanged; pagination that does not advance or exceeds the limits throws
 * `ListingError`. Objects are returned unfiltered, in R2 order.
 */
export async function listAll(bucket: R2Bucket, prefix: string, limits: ListLimits = {}): Promise<ListedObject[]> {
  assertPrefix(prefix);
  const maxObjects = limits.maxObjects ?? MAX_LISTED_OBJECTS;
  const maxPages = limits.maxPages ?? MAX_LIST_PAGES;
  const objects: ListedObject[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pages = 1; ; pages++) {
    const page = await bucket.list({ prefix, cursor, limit: LIST_PAGE_LIMIT });
    for (const object of page.objects) objects.push(object);
    if (objects.length > maxObjects) {
      throw new ListingError("too-many-objects", `listing exceeded ${maxObjects} objects`);
    }
    if (!page.truncated) return objects;

    const next = page.cursor;
    if (!next || seenCursors.has(next)) {
      throw new ListingError("cursor-not-advancing", "list() reported more objects but the cursor did not advance");
    }
    if (pages >= maxPages) {
      throw new ListingError("too-many-objects", `listing exceeded ${maxPages} pages`);
    }
    seenCursors.add(next);
    cursor = next;
  }
}

interface FolderBuilder {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, FolderBuilder>;
  readonly files: FileNode[];
}

function newFolder(name: string, path: string): FolderBuilder {
  return { name, path, folders: new Map(), files: [] };
}

/**
 * Builds the tree and statistics from listed objects (see the module comment
 * for the filtering rules). Pure and synchronous; duplicate keys keep the
 * first occurrence. A file and a folder may share a name (`a` and `a/b` are
 * both valid R2 keys); both are listed.
 */
export function buildListing(objects: Iterable<ListedObject>, prefix: string, rules: Rules): Listing {
  assertPrefix(prefix);
  const root = newFolder("", "");
  const byPath = new Map<string, FileNode>();
  let folderCount = 0;
  let totalBytes = 0;

  for (const { key, size, uploaded } of objects) {
    if (key.endsWith("/")) continue; // directory marker
    const path = relativeKey(key, prefix);
    if (path === null || byPath.has(path) || rules.isExcluded(key)) continue;

    const segments = path.split("/");
    let folder = root;
    let folderPath = "";
    const last = segments.length - 1;
    for (let i = 0; i < last; i++) {
      const name = segments[i] as string;
      folderPath = folderPath === "" ? name : `${folderPath}/${name}`;
      let child = folder.folders.get(name);
      if (child === undefined) {
        child = newFolder(name, folderPath);
        folder.folders.set(name, child);
        folderCount++;
      }
      folder = child;
    }

    const file: FileNode = { kind: "file", name: segments[last] as string, path, key, size, uploaded };
    folder.files.push(file);
    byPath.set(path, file);
    totalBytes += size;
  }

  const files: FileNode[] = [];
  return {
    prefix,
    root: finish(root, files),
    files,
    byPath,
    fileCount: byPath.size,
    folderCount,
    totalBytes,
  };
}

/** Sorts one folder's children and appends its files to `flat` in display order. */
function finish(folder: FolderBuilder, flat: FileNode[]): TreeNode[] {
  const children: TreeNode[] = [];
  const folders = [...folder.folders.values()].sort((a, b) => compareNames(a.name, b.name));
  for (const sub of folders) {
    const subChildren = finish(sub, flat);
    children.push({ kind: "folder", name: sub.name, path: sub.path, children: subChildren, childCount: subChildren.length });
  }
  folder.files.sort((a, b) => compareNames(a.name, b.name));
  for (const file of folder.files) {
    children.push(file);
    flat.push(file);
  }
  return children;
}

/** `listAll` followed by `buildListing`. */
export async function loadListing(bucket: R2Bucket, prefix: string, rules: Rules, limits?: ListLimits): Promise<Listing> {
  return buildListing(await listAll(bucket, prefix, limits), prefix, rules);
}
