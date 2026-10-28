/**
 * The admin page state (admin UI spec §4, §7): what was loaded, the draft,
 * the folder levels and the UI flags, plus the actions that change them.
 * Every change calls the listener; `render.ts` reads the state from scratch.
 *
 * Live is the saved text as the public pages apply it (`readRulesFile`).
 * Draft is a state table; `draftRules` is what it would apply once saved.
 */
import { parseRules, type Rules } from "../rules";
import { changedPaths, readRulesFile, serializeRules, type RuleState, type RulesFileModel } from "../rules-editor";
import { ApiError, fetchFolders, fetchRules, saveRules, type RulesResponse } from "./api";

/** The four choices of a rule button group; `inherit` is no rule. */
export type Choice = "inherit" | RuleState;

export type Banner = "load-failed" | "forbidden" | "conflict" | "save-failed";

/** One loaded level of the tree, keyed by its parent's path (`""` for the top level). */
export interface Level {
  readonly listed: Set<string>;
  /** Cursor of the next page, or `null`. */
  cursor: string | null;
  /** The last page has loaded, so rule paths R2 did not list are missing. */
  complete: boolean;
  loading: boolean;
  error: boolean;
}

function prefixOf(path: string): string {
  return path === "" ? "" : `${path}/`;
}

export class Store {
  phase: "loading" | "ready" | "load-error" = "loading";

  rulesKey = "";
  brandName = "";
  email: string | null = null;
  exists = false;
  etag: string | null = null;
  savedAt: string | null = null;
  live: RulesFileModel = readRulesFile("", "");
  /** Why the saved file is invalid (§3.4), or `null`. */
  invalid: string | null = null;

  draft = new Map<string, RuleState>();
  draftRules: Rules = this.live.rules;
  changed: ReadonlySet<string> = new Set();

  readonly levels = new Map<string, Level>();
  readonly expanded = new Set<string>();

  saving = false;
  banner: Banner | null = null;

  constructor(private readonly onChange: () => void) {}

  /** Folders that the tree must show even if R2 does not list them. */
  rulePaths(): Set<string> {
    return new Set([...this.live.states.keys(), ...this.draft.keys()]);
  }

  /** §7.1: rules and the top level in parallel. */
  async load(): Promise<void> {
    this.phase = "loading";
    this.banner = null;
    this.onChange();
    try {
      const [rules, top] = await Promise.all([fetchRules(), fetchFolders("", null)]);
      this.#applyLoaded(rules);
      this.levels.clear();
      this.levels.set("", { listed: new Set(top.folders), cursor: top.cursor, complete: top.cursor === null, loading: false, error: false });
      this.phase = "ready";
    } catch (error) {
      console.error("admin: loading failed", error);
      this.phase = "load-error";
      this.banner = error instanceof ApiError && error.status === 403 ? "forbidden" : "load-failed";
    }
    this.onChange();
  }

  #applyLoaded(rules: RulesResponse): void {
    this.rulesKey = rules.rulesKey;
    this.brandName = rules.brandName;
    this.email = rules.user.email;
    this.exists = rules.exists;
    this.etag = rules.etag;
    this.savedAt = rules.savedAt;
    this.live = readRulesFile(rules.invalid === undefined ? rules.text : "", rules.rulesKey);
    this.invalid = rules.invalid ?? (this.live.rules.status === "invalid" ? this.live.rules.problem : null);
    this.draft = new Map(this.live.states);
    this.#recompute();
  }

  #recompute(): void {
    this.draftRules = parseRules(serializeRules(this.draft), this.rulesKey);
    this.changed = changedPaths(this.live.states, this.draft);
  }

  /** §7.3: only the draft changes; no request. */
  setRule(path: string, choice: Choice): void {
    if (this.saving) return;
    if (choice === "inherit") this.draft.delete(path);
    else this.draft.set(path, choice);
    this.#recompute();
    this.onChange();
  }

  /** §7.5: back to Live without asking. */
  discard(): void {
    if (this.saving) return;
    this.draft = new Map(this.live.states);
    if (this.banner === "save-failed") this.banner = null;
    this.#recompute();
    this.onChange();
  }

  /** Expands or collapses a folder; the first expansion loads its level (§7.2). */
  toggle(path: string): void {
    if (this.expanded.delete(path)) {
      this.onChange();
      return;
    }
    this.expanded.add(path);
    if (this.levels.has(path)) this.onChange();
    else void this.#loadLevel(path, null);
  }

  /** Next page of a level, or the failed page again. */
  loadMore(path: string): void {
    const level = this.levels.get(path);
    if (level !== undefined && !level.loading && (level.error || level.cursor !== null)) void this.#loadLevel(path, level.cursor);
  }

  async #loadLevel(path: string, cursor: string | null): Promise<void> {
    let level = this.levels.get(path);
    if (level === undefined) {
      level = { listed: new Set(), cursor: null, complete: false, loading: false, error: false };
      this.levels.set(path, level);
    }
    level.loading = true;
    level.error = false;
    this.onChange();
    try {
      const page = await fetchFolders(prefixOf(path), cursor);
      for (const name of page.folders) level.listed.add(name);
      level.cursor = page.cursor;
      level.complete = page.cursor === null;
    } catch (error) {
      console.error(`admin: listing ${JSON.stringify(path)} failed`, error);
      level.error = true;
      if (error instanceof ApiError && error.status === 403) this.banner = "forbidden";
    } finally {
      level.loading = false;
      this.onChange();
    }
  }

  /**
   * §7.5: writes the draft in the fixed format. On success Live becomes the
   * text that was sent and the draft stays as it is. Returns whether it saved.
   */
  async save(): Promise<boolean> {
    if (this.saving) return false;
    const text = serializeRules(this.draft);
    if (parseRules(text, this.rulesKey).status !== "loaded") {
      // serializeRules output always parses; this is a bug, never send it.
      console.error("admin: serialized rules do not parse", text);
      this.banner = "save-failed";
      this.onChange();
      return false;
    }
    this.saving = true;
    this.onChange();
    try {
      const result = await saveRules(text, this.exists ? this.etag : null);
      this.live = readRulesFile(text, this.rulesKey);
      this.exists = true;
      this.invalid = null;
      this.etag = result.etag;
      this.savedAt = result.savedAt;
      this.banner = null;
      this.#recompute();
      return true;
    } catch (error) {
      console.error("admin: saving failed", error);
      const status = error instanceof ApiError ? error.status : 0;
      this.banner = status === 409 ? "conflict" : status === 403 ? "forbidden" : "save-failed";
      return false;
    } finally {
      this.saving = false;
      this.onChange();
    }
  }
}
