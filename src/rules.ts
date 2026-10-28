/**
 * Share rules (spec §4): an inverted, gitignore-style allowlist stored as one
 * UTF-8 object at the bucket root (key from `AppConfig.shareRulesKey`).
 *
 * File format, line by line:
 * - A trailing `\r` is dropped, then trailing spaces and tabs, unless the last
 *   one is escaped (`foo\ ` keeps one space, as in gitignore).
 * - Blank lines are ignored; a line starting with `#` is a comment.
 * - A leading `!` makes the rule an exclusion; otherwise it is an allow rule.
 *   `\#` and `\!` at the start match a literal `#` / `!`.
 * - Every pattern is anchored at the bucket root (spec §4: "all rules are
 *   relative to the bucket root"). One leading `/` is accepted and means the
 *   same thing. Unlike gitignore, a pattern without a `/` (`*.tmp`) does NOT
 *   match at every depth; write `**\/*.tmp` for that.
 * - A trailing `/` restricts the rule to directories. A trailing `/**` makes it
 *   recursive: it matches that directory and everything below it.
 * - Glob syntax inside a path segment: `*` (any run, never crossing `/`), `?`
 *   (one UTF-16 code unit, never `/`), `[abc]`, `[a-z]`, `[!a]` / `[^a]`, and
 *   `\x` for a literal `x`. A segment that is exactly `**` (or more stars)
 *   matches zero or more whole segments; `a**b` is the same as `a*b`. Matching
 *   is case-sensitive and dotfiles are ordinary names. Everything else
 *   (`{a,b}`, `@(x)`, `"`, `|`, `+`, ...) is literal: no brace expansion, no
 *   extglobs, no POSIX classes.
 *
 * Anything this module cannot interpret with certainty makes the WHOLE file
 * invalid, and an invalid file authorises nothing. Silently skipping one bad
 * line would be unsafe: if that line was an exclusion, skipping it would
 * publish what the admin meant to hide. Invalid lines are: leading whitespace
 * (likely a typo, e.g. `  !secret/` would otherwise be an allow rule), control
 * characters, an empty pattern (`!`, `/`), empty segments (`a//b`), `.` or
 * `..` segments, a dangling or `/`-escaping backslash, unclosed brackets,
 * `/` or POSIX classes inside brackets, reversed ranges and characters outside
 * the BMP inside brackets.
 *
 * Semantics (spec §4.1): for each path, rules are tried in order and the last
 * one that matches decides. A directory may be a share root only if the last
 * matching rule for it is an allow AND no ancestor directory's last matching
 * rule is an exclusion, so a deeper allow can never reopen an excluded parent.
 * An object is excluded if its own last matching rule, or that of any ancestor
 * directory, is an exclusion. The rules object itself is always excluded.
 *
 * Globs are compiled once when the file is parsed (Workers Free has a 10 ms
 * CPU budget); create one `Rules` per request and reuse it for every key.
 */
import picomatch from "picomatch/posix";
import { isSafeKey } from "./paths";

/** Larger rules files are treated as invalid, to keep parsing within the CPU budget. */
export const MAX_RULES_FILE_BYTES = 64 * 1024;

export type RulesStatus =
  /** The rules file was read and every line is valid. */
  | "loaded"
  /** No rules object exists: nothing is authorised. */
  | "missing"
  /** The rules object is too large, not UTF-8 or has an invalid line: nothing is authorised. */
  | "invalid";

/** One parsed rule line. */
export interface ShareRule {
  /** 1-based line number in the rules file. */
  readonly line: number;
  /** Glob without `!`, the leading `/`, and the trailing `/` or `/**`; escapes kept. */
  readonly body: string;
  readonly exclude: boolean;
  /** Pattern ended with `/`: matches directories only. */
  readonly dirOnly: boolean;
  /** Pattern ended with `/**`: matches the directory and all its descendants. */
  readonly recursive: boolean;
}

export interface Rules {
  readonly status: RulesStatus;
  /** Why the file was rejected, for server logs only (never show it to visitors). */
  readonly problem: string | null;
  readonly rules: readonly ShareRule[];
  /**
   * Whether the directory may have its own share page. `segments` come from
   * `decodeShareToken`; the bucket root (`[]`) and invalid
   * segments are never share roots.
   */
  isShareRoot(segments: readonly string[]): boolean;
  /**
   * Whether an object key must be hidden from listings, README links and ZIPs.
   * Always `true` for the rules object itself, for keys that are not
   * `isSafeKey`, and for every key when the rules are not `loaded`.
   */
  isExcluded(key: string): boolean;
}

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

/**
 * Parses rules file text. Never throws: an invalid file yields deny-all rules
 * with status `invalid`. `rulesKey` is the configured rules object key, which
 * `isExcluded` always reports as excluded.
 */
export function parseRules(text: string, rulesKey: string): Rules {
  const compiled: CompiledRule[] = [];
  const lines = text.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const result = parseLine(rawLine, lineNumber);
    if (result === null) continue;
    if (typeof result === "string") {
      return denyAll("invalid", `line ${lineNumber}: ${result}`);
    }
    compiled.push(result);
  }
  return new MatchingRules(rulesKey, compiled);
}

/** Rules that authorise nothing, for a missing or unusable rules file. */
export function denyAll(status: Exclude<RulesStatus, "loaded">, problem: string): Rules {
  return {
    status,
    problem,
    rules: [],
    isShareRoot: () => false,
    isExcluded: () => true,
  };
}

// ---------------------------------------------------------------------------
// Matching

const GLOBSTAR = Symbol("globstar");

/** A pattern segment: `**`, an exact name, or a compiled single-segment glob. */
type SegmentMatcher = typeof GLOBSTAR | string | RegExp;

interface CompiledRule extends ShareRule {
  readonly segments: readonly SegmentMatcher[];
}

type Verdict = "allow" | "exclude" | null;

class MatchingRules implements Rules {
  readonly status = "loaded";
  readonly problem = null;
  readonly rules: readonly ShareRule[];
  readonly #compiled: readonly CompiledRule[];
  readonly #rulesKey: string;
  /** Directory path -> its last matching rule is an exclusion (per request). */
  readonly #dirExcluded = new Map<string, boolean>();

  constructor(rulesKey: string, compiled: readonly CompiledRule[]) {
    this.#rulesKey = rulesKey;
    this.#compiled = compiled;
    this.rules = compiled.map(({ line, body, exclude, dirOnly, recursive }) => ({
      line,
      body,
      exclude,
      dirOnly,
      recursive,
    }));
  }

  isShareRoot(segments: readonly string[]): boolean {
    if (segments.length === 0 || segments.some((segment) => segment.includes("/"))) return false;
    if (!isSafeKey(segments.join("/"))) return false;
    if (this.#hasExcludedAncestor(segments)) return false;
    return this.#verdict(segments, true) === "allow";
  }

  isExcluded(key: string): boolean {
    if (key === this.#rulesKey || !isSafeKey(key)) return true;
    const segments = key.split("/");
    return this.#hasExcludedAncestor(segments) || this.#verdict(segments, false) === "exclude";
  }

  /** Whether any proper ancestor directory of `segments` is excluded. */
  #hasExcludedAncestor(segments: readonly string[]): boolean {
    for (let depth = 1; depth < segments.length; depth++) {
      const dir = segments.slice(0, depth);
      const cacheKey = dir.join("/");
      let excluded = this.#dirExcluded.get(cacheKey);
      if (excluded === undefined) {
        excluded = this.#verdict(dir, true) === "exclude";
        this.#dirExcluded.set(cacheKey, excluded);
      }
      if (excluded) return true;
    }
    return false;
  }

  /** The last matching rule's verdict for one path (last match wins). */
  #verdict(path: readonly string[], isDir: boolean): Verdict {
    for (let i = this.#compiled.length - 1; i >= 0; i--) {
      const rule = this.#compiled[i];
      if (rule !== undefined && ruleMatches(rule, path, isDir)) {
        return rule.exclude ? "exclude" : "allow";
      }
    }
    return null;
  }
}

function ruleMatches(rule: CompiledRule, path: readonly string[], isDir: boolean): boolean {
  if (path.length === 0) return false;
  const prefixes = matchingPrefixes(rule.segments, path);
  if (rule.recursive) {
    // `dir/**`: some ancestor matches the body, or the path itself does and is a directory.
    for (let length = 0; length < path.length; length++) {
      if (prefixes[length]) return true;
    }
    return prefixes[path.length] === true && isDir;
  }
  return prefixes[path.length] === true && (isDir || !rule.dirOnly);
}

/**
 * `result[n]` is whether the pattern matches exactly the first `n` segments of
 * `path`. Dynamic programming keeps `**` linear in the path length, however
 * many globstars a rule has.
 */
function matchingPrefixes(segments: readonly SegmentMatcher[], path: readonly string[]): boolean[] {
  let row: boolean[] = new Array<boolean>(path.length + 1).fill(false);
  row[0] = true;
  for (const matcher of segments) {
    const next: boolean[] = new Array<boolean>(path.length + 1).fill(false);
    if (matcher === GLOBSTAR) {
      let reachable = false;
      for (let n = 0; n <= path.length; n++) {
        reachable ||= row[n] === true;
        next[n] = reachable;
      }
    } else {
      for (let n = 1; n <= path.length; n++) {
        const name = path[n - 1];
        next[n] = row[n - 1] === true && name !== undefined && segmentMatches(matcher, name);
      }
    }
    row = next;
  }
  return row;
}

function segmentMatches(matcher: string | RegExp, name: string): boolean {
  return typeof matcher === "string" ? matcher === name : matcher.test(name);
}

// ---------------------------------------------------------------------------
// Parsing

/**
 * picomatch only ever sees one path segment that `toPicomatchGlob` produced:
 * `*`, `?`, `[...]` and backslash-escaped literals. Every option that could
 * change that meaning is pinned, because several defaults are surprising for
 * gitignore-style input (`[!a]` is not negation without `posix`, `"` is
 * stripped without `keepQuotes`, `a(b)` becomes a regex group, `{a,b}` expands,
 * `[a]` also matches the literal text `[a]` unless `literalBrackets` is false,
 * `nocase`/`basename` change what matches, and `windows` follows the host OS).
 */
const PICOMATCH_OPTIONS: picomatch.PicomatchOptions = {
  dot: true,
  nocase: false,
  nobrace: true,
  noextglob: true,
  noglobstar: true,
  nonegate: true,
  posix: false,
  keepQuotes: true,
  regex: false,
  basename: false,
  matchBase: false,
  contains: false,
  bash: false,
  windows: false,
  unescape: false,
  strictBrackets: true,
  literalBrackets: false,
  strictSlashes: true,
  fastpaths: false,
  capture: false,
};

// C0 controls (includes NUL), DEL and C1 controls, as in paths.ts.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

type Token =
  | { readonly kind: "literal"; readonly char: string }
  | { readonly kind: "star" }
  | { readonly kind: "any" }
  | { readonly kind: "class"; readonly negate: boolean; readonly ranges: readonly (readonly [string, string])[] };

/** A compiled rule, `null` for blank and comment lines, or an error message. */
function parseLine(rawLine: string, line: number): CompiledRule | string | null {
  const text = stripTrailingWhitespace(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
  if (text === "" || text.startsWith("#")) return null;
  if (CONTROL_CHARS.test(text)) return "control characters are not allowed";
  if (/^\s/.test(text)) return "leading whitespace is not allowed (escape it as `\\ ` if intended)";

  const exclude = text.startsWith("!");
  let pattern = exclude ? text.slice(1) : text;
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (/^\s/.test(pattern)) return "whitespace after `!` or `/` is not allowed";

  const split = splitSegments(pattern);
  if (typeof split === "string") return split;
  const segments = split.map((segment) => segment.tokens);
  const sources = split.map((segment) => segment.source);

  let dirOnly = false;
  if (segments.length > 1 && segments[segments.length - 1]?.length === 0) {
    dirOnly = true;
    segments.pop();
    sources.pop();
  }
  if (segments.some((tokens) => tokens.length === 0)) return "empty pattern or empty path segment";

  const matchers: SegmentMatcher[] = [];
  for (const tokens of segments) {
    const matcher = compileSegment(tokens);
    if (typeof matcher === "object" && "error" in matcher) return matcher.error;
    // Collapse `**/**` into one globstar: same meaning, less work.
    if (matcher === GLOBSTAR && matchers[matchers.length - 1] === GLOBSTAR) continue;
    matchers.push(matcher);
  }

  const recursive = !dirOnly && matchers[matchers.length - 1] === GLOBSTAR;
  if (recursive) {
    matchers.pop();
    sources.pop();
  }
  return { line, body: sources.join("/"), exclude, dirOnly, recursive, segments: matchers };
}

/** Drops trailing spaces and tabs, keeping one that is escaped by an odd run of backslashes. */
function stripTrailingWhitespace(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) {
    let backslashes = 0;
    while (end - 2 - backslashes >= 0 && text[end - 2 - backslashes] === "\\") backslashes++;
    if (backslashes % 2 === 1) break;
    end--;
  }
  return text.slice(0, end);
}

/** Tokenises a pattern and splits it on every `/` that is not escaped or inside brackets. */
function splitSegments(pattern: string): { tokens: Token[]; source: string }[] | string {
  const segments: { tokens: Token[]; source: string }[] = [];
  let tokens: Token[] = [];
  let start = 0;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] as string;
    if (char === "/") {
      segments.push({ tokens, source: pattern.slice(start, i) });
      tokens = [];
      start = i + 1;
      i++;
    } else if (char === "\\") {
      const escaped = pattern[i + 1];
      if (escaped === undefined) return "a trailing `\\` escapes nothing";
      if (escaped === "/") return "`\\/` is not allowed; `/` always separates segments";
      tokens.push({ kind: "literal", char: escaped });
      i += 2;
    } else if (char === "*") {
      tokens.push({ kind: "star" });
      i++;
    } else if (char === "?") {
      tokens.push({ kind: "any" });
      i++;
    } else if (char === "[") {
      const parsed = parseBracket(pattern, i);
      if (typeof parsed === "string") return parsed;
      tokens.push(parsed.token);
      i = parsed.end;
    } else {
      tokens.push({ kind: "literal", char });
      i++;
    }
  }
  segments.push({ tokens, source: pattern.slice(start) });
  return segments;
}

/** Parses `[...]` starting at `open`; `end` is the index after the closing `]`. */
function parseBracket(pattern: string, open: number): { token: Token; end: number } | string {
  let i = open + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i++;
  }
  const ranges: (readonly [string, string])[] = [];

  // Reads one member character (possibly escaped) at `i`.
  const readChar = (): string | { error: string } => {
    let char = pattern[i];
    if (char === "\\") {
      i++;
      char = pattern[i];
    }
    if (char === undefined) return { error: "unclosed `[`" };
    if (char === "/") return { error: "`/` cannot appear inside `[...]`" };
    const code = char.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdfff) return { error: "characters outside the BMP cannot appear inside `[...]`" };
    i++;
    return char;
  };

  for (let first = true; ; first = false) {
    const char = pattern[i];
    if (char === undefined) return "unclosed `[`";
    if (char === "]" && !first) return { token: { kind: "class", negate, ranges }, end: i + 1 };
    if (char === "[" && pattern[i + 1] === ":") return "POSIX character classes like `[[:digit:]]` are not supported";
    const low = readChar();
    if (typeof low !== "string") return low.error;
    let high = low;
    if (pattern[i] === "-" && pattern[i + 1] !== undefined && pattern[i + 1] !== "]") {
      i++;
      const read = readChar();
      if (typeof read !== "string") return read.error;
      high = read;
      if (high < low) return `reversed range \`${low}-${high}\` in \`[...]\``;
    }
    ranges.push([low, high]);
  }
}

function compileSegment(tokens: readonly Token[]): SegmentMatcher | { error: string } {
  if (tokens.length >= 2 && tokens.every((token) => token.kind === "star")) return GLOBSTAR;
  if (tokens.every((token) => token.kind === "literal")) {
    const name = tokens.map((token) => (token.kind === "literal" ? token.char : "")).join("");
    if (name === "." || name === "..") return { error: "`.` and `..` segments are not allowed" };
    return name;
  }
  try {
    return picomatch.makeRe(toPicomatchGlob(tokens), PICOMATCH_OPTIONS);
  } catch (error) {
    return { error: `cannot compile glob (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Canonical picomatch glob for one segment: only `*`, `?`, `[...]` and escaped punctuation. */
function toPicomatchGlob(tokens: readonly Token[]): string {
  let glob = "";
  let previous: Token["kind"] | null = null;
  for (const token of tokens) {
    switch (token.kind) {
      case "star":
        if (previous !== "star") glob += "*"; // `a**b` is `a*b`
        break;
      case "any":
        glob += "?";
        break;
      case "literal":
        glob += escapeGlobChar(token.char);
        break;
      case "class":
        glob += `[${token.negate ? "^" : ""}${token.ranges
          .map(([low, high]) => (low === high ? escapeGlobChar(low) : `${escapeGlobChar(low)}-${escapeGlobChar(high)}`))
          .join("")}]`;
        break;
    }
    previous = token.kind;
  }
  return glob;
}

/**
 * Backslash-escapes ASCII punctuation and spaces so picomatch treats them as
 * literals. Letters and digits must stay unescaped (`\d` would become a regex
 * class) and non-ASCII characters pass through unchanged.
 */
function escapeGlobChar(char: string): string {
  return /^[A-Za-z0-9]$/.test(char) || char.charCodeAt(0) > 0x7f ? char : `\\${char}`;
}
