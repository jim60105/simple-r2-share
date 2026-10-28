/**
 * The folder tree model (admin UI spec §6.5, §7.2), free of DOM so Node tests
 * can run it. A level's children are the folders R2 listed under it plus the
 * folders that rules name below it (ghost nodes), merged and sorted.
 *
 * A rule path that R2 did not list is `missing` (shown as NOT IN BUCKET) only
 * once the level's last page has loaded: until then it may simply be on a
 * page that has not been fetched yet.
 */

export interface TreeChild {
  readonly name: string;
  /** State table key: segments joined with `/`. */
  readonly path: string;
  readonly segments: readonly string[];
  /** Listed by R2 so far. */
  readonly listed: boolean;
  /** Named by a rule, the level is fully loaded and R2 did not list it. */
  readonly missing: boolean;
}

const collator = new Intl.Collator("zh-Hant-TW", { numeric: true });

/** Sort order inside a level; names the collator treats as equal fall back to code unit order. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Names of the folders directly below `parent` that some rule path lies in or at. */
export function ruleChildNames(parent: readonly string[], rulePaths: Iterable<string>): Set<string> {
  const prefix = parent.length === 0 ? "" : `${parent.join("/")}/`;
  const names = new Set<string>();
  for (const path of rulePaths) {
    if (!path.startsWith(prefix) || path.length === prefix.length) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.add(slash === -1 ? rest : rest.slice(0, slash));
  }
  return names;
}

/**
 * The sorted children of `parent`: every listed name plus every name from
 * `ruleChildNames`. `complete` says whether the level's last page has loaded.
 */
export function childrenOf(
  parent: readonly string[],
  listed: ReadonlySet<string>,
  complete: boolean,
  rulePaths: Iterable<string>,
): TreeChild[] {
  const names = new Set(listed);
  for (const name of ruleChildNames(parent, rulePaths)) names.add(name);
  return [...names].sort(compareNames).map((name) => {
    const segments = [...parent, name];
    const isListed = listed.has(name);
    return { name, path: segments.join("/"), segments, listed: isListed, missing: complete && !isListed };
  });
}
