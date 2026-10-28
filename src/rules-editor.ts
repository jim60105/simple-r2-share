/**
 * The admin page's model of the rules file (admin UI spec §3, §4): the file is
 * read into one of four states per folder and written back in a fixed format.
 * Pure and shared by the admin page and the Node tests, so no DOM or Workers
 * globals here.
 *
 * States, for a folder path `P` (segments joined with `/`):
 * - Inherit: no entry in the table, no rule line.
 * - `share`: `P/`, the folder itself is a share root.
 * - `share-sub`: `P/**`, the folder and every descendant not excluded.
 * - `exclude`: `!P/`, the folder and everything below it are hidden.
 *
 * A line is supported when it names a literal folder path (escapes allowed,
 * no globs) in one of those forms (`!P/**` also reads as `exclude`), and its
 * path appeared on no earlier supported line, neither itself nor as an
 * ancestor of an earlier one. The last condition keeps "last match wins"
 * unchanged when the lines are written back sorted with ancestors first.
 * Everything else is unsupported: kept in Live (it still applies until the
 * next save) and dropped from Draft.
 */
import { isValidSegment } from "./paths";
import { parseRules, type Rules, type ShareRule } from "./rules";

export type RuleState = "share" | "share-sub" | "exclude";
/** Folder path (segments joined with `/`) -> state; Inherit is absence. */
export type StateTable = ReadonlyMap<string, RuleState>;

export interface RulesFileModel {
  /** `parseRules(text)`: what the public pages apply right now (Live). */
  readonly rules: Rules;
  /** States of the supported lines. */
  readonly states: StateTable;
  /** Lines the editor cannot represent; removed on the next save. */
  readonly unsupported: readonly { readonly line: number; readonly text: string }[];
}

export const MANAGED_HEADER =
  "# Managed by the Simple R2 Share admin page. Comments and unsupported lines are removed on save.";

/** The state table key of a folder. */
export function pathKey(segments: readonly string[]): string {
  return segments.join("/");
}

/**
 * Reads rules file text into the editor model. An invalid file has no states
 * and no unsupported lines: the editor starts from an empty draft and the
 * page shows `rules.problem` instead (spec §3.4).
 */
export function readRulesFile(text: string, rulesKey: string): RulesFileModel {
  const rules = parseRules(text, rulesKey);
  const states = new Map<string, RuleState>();
  const unsupported: { line: number; text: string }[] = [];
  if (rules.status !== "loaded") return { rules, states, unsupported };

  const lines = text.split("\n");
  // Every proper ancestor of a path in `states`, to spot a descendant-first order.
  const ancestors = new Set<string>();
  for (const rule of rules.rules) {
    const state = stateOf(rule);
    const literal = rule.literal;
    const key = literal === null ? "" : pathKey(literal);
    if (state === null || literal === null || states.has(key) || ancestors.has(key)) {
      const raw = lines[rule.line - 1] ?? "";
      unsupported.push({ line: rule.line, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
      continue;
    }
    states.set(key, state);
    for (let depth = 1; depth < literal.length; depth++) ancestors.add(pathKey(literal.slice(0, depth)));
  }
  return { rules, states, unsupported };
}

function stateOf(rule: ShareRule): RuleState | null {
  if (rule.literal === null || !rule.literal.every(isValidSegment)) return null;
  if (rule.exclude) return rule.dirOnly || rule.recursive ? "exclude" : null;
  if (rule.recursive) return "share-sub";
  return rule.dirOnly ? "share" : null;
}

const SPECIAL = /[\\*?[\]!#\s]/g;

/** Escapes a folder name so the rules parser reads it back as the same literal name. */
export function escapeSegment(name: string): string {
  return name.replace(SPECIAL, (char) => `\\${char}`);
}

/** Orders folder paths segment by segment in UTF-16 code unit order, ancestors first. */
function compareSegments(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * The rules file for a state table (spec §3.3): the managed header, then one
 * line per non-Inherit folder, sorted, each ending with `\n`. The same table
 * always yields the same text. Throws `TypeError` for a key that is not a
 * valid folder path, which is a programming error.
 */
export function serializeRules(states: StateTable): string {
  const entries = [...states].map(([key, state]) => {
    const segments = key.split("/");
    if (!segments.every(isValidSegment)) throw new TypeError(`rules-editor: invalid folder path ${JSON.stringify(key)}`);
    return { segments, state };
  });
  entries.sort((a, b) => compareSegments(a.segments, b.segments));
  let text = `${MANAGED_HEADER}\n`;
  for (const { segments, state } of entries) {
    const path = segments.map(escapeSegment).join("/");
    text += state === "share" ? `${path}/\n` : state === "share-sub" ? `${path}/**\n` : `!${path}/\n`;
  }
  return text;
}

export type Effective = "shared" | "excluded" | "none";

/** What the public pages do with a folder under `rules` (spec §4). */
export function effectiveState(rules: Rules, segments: readonly string[]): Effective {
  if (rules.isDirExcluded(segments)) return "excluded";
  return rules.isShareRoot(segments) ? "shared" : "none";
}

/** Paths whose state differs between the two tables. */
export function changedPaths(live: StateTable, draft: StateTable): ReadonlySet<string> {
  const changed = new Set<string>();
  for (const [key, state] of live) if (draft.get(key) !== state) changed.add(key);
  for (const [key, state] of draft) if (live.get(key) !== state) changed.add(key);
  return changed;
}

/** How many of `paths` lie strictly below `folder` (a state table key). */
export function countBelow(paths: Iterable<string>, folder: string): number {
  const prefix = `${folder}/`;
  let count = 0;
  for (const path of paths) if (path.startsWith(prefix)) count++;
  return count;
}
