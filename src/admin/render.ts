/**
 * Builds and updates the admin page DOM from the store (admin UI spec §6, §8).
 *
 * - Text from R2 or the rules file only ever goes into `textContent`, `title`
 *   or attributes; there is no `innerHTML`.
 * - Folder rows are kept per path and updated in place (classes, `checked`,
 *   `disabled`, text), and moved only when their order changes, so keyboard
 *   focus stays on the rule button that was just switched.
 * - Numbers such as the tree depth go through CSSOM (`style.setProperty`),
 *   which the page CSP allows, never through a `style` attribute.
 */
import { CJK_RUN, formatSyncedTime } from "../format";
import { shortSharePath } from "../paths";
import { countBelow, effectiveState, type Effective } from "../rules-editor";
import { encodeShareToken } from "../short-url";
import { icon, type IconName } from "./icons";
import type { Choice, Store } from "./store";
import { childrenOf, type TreeChild } from "./tree";

const CHOICES: readonly Choice[] = ["inherit", "share", "share-sub", "exclude"];

const CHOICE_ICON: Record<Choice, IconName> = {
  inherit: "inherit",
  share: "share",
  "share-sub": "share-sub",
  exclude: "exclude",
};

const CHOICE_TITLE: Record<Choice, string> = {
  inherit: "Inherit (no rule)",
  share: "Share this folder",
  "share-sub": "Share folder and subfolders",
  exclude: "Exclude",
};

const CHOICE_NAME: Record<Choice, string> = {
  inherit: "Inherit",
  share: "Share",
  "share-sub": "Share + subfolders",
  exclude: "Exclude",
};

const EFFECTIVE_NAME: Record<Effective, string> = { shared: "Shared", excluded: "Excluded", none: "Not shared" };

export interface Dom {
  readonly brandName: HTMLElement;
  readonly email: HTMLElement;
  readonly stats: HTMLElement;
  readonly banners: HTMLElement;
  readonly folders: HTMLElement;
  readonly actionbar: HTMLElement;
  readonly pendingCount: HTMLElement;
  readonly unsupportedNote: HTMLElement;
  readonly discard: HTMLButtonElement;
  readonly save: HTMLButtonElement;
}

/** What the view asks the page to do; wired up in `main.ts`. */
export interface Actions {
  readonly copy: (segments: readonly string[]) => void;
  readonly save: () => void;
  readonly reload: () => void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** Plural for the upper-case labels: `1 LINE`, `2 LINES`. */
function count(n: number, singular: string, plural = `${singular}S`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

interface RowView {
  readonly li: HTMLLIElement;
  readonly row: HTMLDivElement;
  readonly toggle: HTMLButtonElement;
  readonly folder: SVGSVGElement;
  readonly label: HTMLSpanElement;
  readonly shared: { readonly tag: HTMLSpanElement; readonly long: HTMLSpanElement; readonly short: Text };
  readonly pending: { readonly tag: HTMLSpanElement; readonly long: HTMLSpanElement; readonly short: Text };
  readonly missing: HTMLSpanElement;
  readonly pendingText: HTMLSpanElement;
  readonly inputs: Record<Choice, HTMLInputElement>;
  readonly options: Record<Choice, HTMLLabelElement>;
  readonly copy: HTMLButtonElement;
  readonly children: HTMLUListElement;
}

export class View {
  readonly #rows = new Map<string, RowView>();
  readonly #statusRows = new Map<string, { li: HTMLLIElement; signature: string }>();
  readonly #tree = element("ul", "ftree");
  #bannerSignature = "";
  #brand = "";
  #rowCount = 0;

  constructor(
    private readonly store: Store,
    private readonly dom: Dom,
    private readonly actions: Actions,
  ) {}

  render(): void {
    const { store, dom } = this;
    this.#renderBrand();
    dom.email.hidden = store.email === null;
    setText(dom.email, store.email ?? "");
    this.#renderStats();
    this.#renderBanners();
    this.#renderFolders();
    this.#renderActionbar();
  }

  #renderBrand(): void {
    const name = this.store.brandName;
    if (name === "" || name === this.#brand) return;
    this.#brand = name;
    document.title = `Share rules · ${name}`;
    const parts: Node[] = [];
    let last = 0;
    for (const match of name.matchAll(CJK_RUN)) {
      parts.push(document.createTextNode(name.slice(last, match.index)), element("span", "brand__cjk", match[0]));
      last = match.index + match[0].length;
    }
    parts.push(document.createTextNode(name.slice(last)));
    this.dom.brandName.replaceChildren(...parts);
  }

  #renderStats(): void {
    const { store } = this;
    if (store.phase !== "ready") {
      setText(this.dom.stats, store.phase === "loading" ? "LOADING…" : "");
      return;
    }
    let shared = 0;
    let excluded = 0;
    for (const state of store.live.states.values()) {
      if (state === "exclude") excluded++;
      else shared++;
    }
    const parts: (string | HTMLElement)[] = [element("b", "", String(shared)), " SHARED · ", element("b", "", String(excluded)), " EXCLUDED · "];
    if (store.exists && store.savedAt !== null) {
      parts.push("SAVED ", element("b", "", formatSyncedTime(new Date(store.savedAt)).replace(/ UTC$/, "")), " UTC");
    } else {
      parts.push("NOT SAVED YET");
    }
    this.dom.stats.replaceChildren(...parts);
  }

  #renderBanners(): void {
    const { store } = this;
    const unsupported = store.live.unsupported;
    const signature = JSON.stringify([store.banner, store.invalid, store.rulesKey, unsupported]);
    if (signature === this.#bannerSignature) return;
    this.#bannerSignature = signature;

    const banners: HTMLElement[] = [];
    switch (store.banner) {
      case "forbidden":
        banners.push(this.#errorBanner("Your session has expired or you don't have access. Reload to sign in again.", "RELOAD", this.actions.reload));
        break;
      case "conflict":
        banners.push(
          this.#errorBanner(
            "The rules were changed somewhere else. Reload to see the latest rules; your unsaved changes will be lost.",
            "RELOAD",
            this.actions.reload,
          ),
        );
        break;
      case "save-failed":
        banners.push(this.#errorBanner("Couldn't save the rules. Try again.", "TRY AGAIN", this.actions.save));
        break;
      case "load-failed":
        banners.push(this.#errorBanner("Couldn't load the rules or folders. Try again.", "TRY AGAIN", () => void store.load()));
        break;
      case null:
        break;
    }
    if (store.invalid !== null) {
      const banner = element("section", "banner banner--danger");
      banner.append(
        element("p", "banner__text", `The rules file is invalid (${store.invalid}). Nothing is shared right now. Saving replaces the whole file.`),
      );
      banners.push(banner);
    }
    if (unsupported.length > 0) {
      const banner = element("section", "banner banner--pending");
      const title = element("p", "banner__title");
      title.append(
        element("span", "wide-only", `${count(unsupported.length, "LINE")} IN ${store.rulesKey} ${unsupported.length === 1 ? "IS" : "ARE"} NOT SUPPORTED BY THE EDITOR`),
        element("span", "narrow-only", count(unsupported.length, "UNSUPPORTED LINE")),
      );
      const text = element("p", "banner__text");
      text.append(
        element(
          "span",
          "wide-only",
          "They still apply now, and will be removed on the next save. Their effect is already included in the states below.",
        ),
        element("span", "narrow-only", "Still applied now; removed on the next save."),
      );
      const lines = element("dl", "banner__lines");
      for (const line of unsupported) {
        const code = element("code", "", line.text);
        const dd = element("dd");
        dd.append(code);
        lines.append(element("dt", "", `line ${line.line}`), dd);
      }
      banner.append(title, text, lines);
      banners.push(banner);
    }
    this.dom.banners.replaceChildren(...banners);
  }

  #errorBanner(text: string, label: string, onClick: () => void): HTMLElement {
    const banner = element("section", "banner banner--danger");
    banner.setAttribute("role", "alert");
    const button = element("button", "button", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    banner.append(element("p", "banner__text", text), button);
    return banner;
  }

  #renderFolders(): void {
    const { store, dom } = this;
    if (store.phase !== "ready") {
      const text = store.phase === "loading" ? "Loading…" : "Couldn't load the folders.";
      const current = dom.folders.firstElementChild;
      if (!(current instanceof HTMLParagraphElement) || current.textContent !== text) {
        dom.folders.replaceChildren(element("p", "panel__empty", text));
      }
      return;
    }
    if (this.#tree.parentNode !== dom.folders) dom.folders.replaceChildren(this.#tree);

    const sharedPaths = [...store.draft].filter(([, state]) => state !== "exclude").map(([path]) => path);
    const context = { rulePaths: store.rulePaths(), sharedPaths, seen: new Set<string>() };
    this.#renderLevel([], this.#tree, 0, context);
    // Forget rows that left the tree (a ghost whose rule was saved away).
    for (const path of this.#rows.keys()) if (!context.seen.has(path)) this.#rows.delete(path);
  }

  #renderLevel(
    parent: readonly string[],
    list: HTMLUListElement,
    depth: number,
    context: { rulePaths: Set<string>; sharedPaths: string[]; seen: Set<string> },
  ): void {
    const key = parent.join("/");
    const level = this.store.levels.get(key);
    const children = childrenOf(parent, level?.listed ?? new Set(), level?.complete ?? false, context.rulePaths);
    const items: HTMLLIElement[] = [];
    for (const child of children) {
      context.seen.add(child.path);
      const view = this.#rows.get(child.path) ?? this.#createRow(child);
      this.#rows.set(child.path, view);
      this.#updateRow(view, child, depth, context);
      const expanded = this.store.expanded.has(child.path);
      view.children.hidden = !expanded;
      if (expanded) this.#renderLevel(child.segments, view.children, depth + 1, context);
      items.push(view.li);
    }
    const status = level === undefined ? null : this.#statusRow(key, depth, level, children.length);
    if (status !== null) items.push(status);
    syncChildren(list, items);
  }

  /** Loading, error or LOAD MORE row at the end of a level, or `null`. */
  #statusRow(
    key: string,
    depth: number,
    level: { loading: boolean; error: boolean; cursor: string | null; complete: boolean },
    shown: number,
  ): HTMLLIElement | null {
    let signature: string;
    if (level.error) signature = "error";
    else if (level.loading) signature = level.cursor === null && shown === 0 ? "loading" : "loading-more";
    else if (level.cursor !== null) signature = "more";
    else if (level.complete && shown === 0 && key !== "") return null;
    else if (level.complete && shown === 0) signature = "empty";
    else return null;
    signature += `:${depth}`;

    const existing = this.#statusRows.get(key);
    if (existing !== undefined && existing.signature === signature) return existing.li;

    const li = element("li");
    const row = element("div", "frow frow--status");
    row.style.setProperty("--depth", String(depth));
    const cell = element("div", "frow__status");
    const kind = signature.split(":")[0];
    if (kind === "error" || kind === "more" || kind === "loading-more") {
      if (kind === "error") cell.append(element("p", "", "Couldn't load folders"));
      const button = element("button", "button", kind === "error" ? "TRY AGAIN" : kind === "more" ? "LOAD MORE" : "LOADING…");
      button.type = "button";
      button.disabled = kind === "loading-more";
      button.addEventListener("click", () => this.store.loadMore(key));
      cell.append(button);
    } else {
      cell.append(element("p", "", kind === "loading" ? "Loading…" : "No folders in the bucket yet."));
    }
    row.append(cell);
    li.append(row);
    this.#statusRows.set(key, { li, signature });
    return li;
  }

  #createRow(child: TreeChild): RowView {
    const index = this.#rowCount++;
    const li = element("li");
    const row = element("div", "frow");

    const name = element("div", "frow__name");
    const toggle = element("button", "frow__toggle");
    toggle.type = "button";
    const folder = icon("folder", "frow__folder");
    const label = element("span", "frow__label");
    toggle.append(icon("caret", "frow__caret"), folder, label);
    toggle.addEventListener("click", () => this.store.toggle(child.path));

    const makeCountTag = (className: string, shortIcon: () => Element) => {
      const tag = element("span", `tag ${className}`);
      const long = element("span", "tag__long");
      const shortText = document.createTextNode("");
      const short = element("span", "tag__short");
      short.setAttribute("aria-hidden", "true");
      short.append(shortIcon(), shortText);
      tag.append(long, short);
      return { tag, long, short: shortText };
    };
    const shared = makeCountTag("tag--accent", () => icon("share", "tag__icon"));
    const pending = makeCountTag("tag--pending", () => element("span", "tag__square"));
    const missing = element("span", "tag tag--muted");
    const missingShort = element("span", "tag__short", "MISSING");
    missingShort.setAttribute("aria-hidden", "true");
    missing.append(element("span", "tag__long", "NOT IN BUCKET"), missingShort);
    const pendingText = element("span", "visually-hidden");
    name.append(toggle, shared.tag, pending.tag, missing, pendingText);

    const rule = element("fieldset", "rule");
    const legend = element("legend", "visually-hidden", `Rule for ${child.path}`);
    rule.append(legend);
    const inputs = {} as Record<Choice, HTMLInputElement>;
    const options = {} as Record<Choice, HTMLLabelElement>;
    for (const choice of CHOICES) {
      const input = element("input", "rule__input visually-hidden");
      input.type = "radio";
      input.name = `rule-${index}`;
      input.id = `rule-${index}-${choice}`;
      input.value = choice;
      input.addEventListener("change", () => {
        if (input.checked) this.store.setRule(child.path, choice);
      });
      const option = element("label", "rule__option");
      option.htmlFor = input.id;
      option.append(icon(CHOICE_ICON[choice], "rule__icon"), element("span", "visually-hidden", CHOICE_TITLE[choice]));
      rule.append(input, option);
      inputs[choice] = input;
      options[choice] = option;
    }

    const link = element("div", "frow__link");
    const copy = element("button", "copy");
    copy.type = "button";
    copy.append(icon("copy", "copy__icon"));
    copy.addEventListener("click", () => this.actions.copy(child.segments));
    link.append(copy);

    row.append(name, rule, link);
    const children = element("ul");
    children.hidden = true;
    li.append(row, children);
    return { li, row, toggle, folder, label, shared, pending, missing, pendingText, inputs, options, copy, children };
  }

  #updateRow(
    view: RowView,
    child: TreeChild,
    depth: number,
    context: { rulePaths: ReadonlySet<string>; sharedPaths: readonly string[] },
  ): void {
    const { store } = this;
    const { path, segments } = child;
    const liveChoice: Choice = store.live.states.get(path) ?? "inherit";
    const draftChoice: Choice = store.draft.get(path) ?? "inherit";
    const changed = store.changed.has(path);
    const liveEffect = effectiveState(store.live.rules, segments);
    const draftEffect = effectiveState(store.draftRules, segments);

    view.row.style.setProperty("--depth", String(depth));
    view.row.classList.toggle("frow--pending", changed || liveEffect !== draftEffect);
    view.row.classList.toggle("frow--ghost", child.missing);
    view.folder.classList.toggle("is-shared", draftEffect === "shared");
    view.folder.classList.toggle("is-excluded", draftEffect === "excluded");

    setText(view.label, child.name);
    view.label.title = path;
    const level = store.levels.get(path);
    const leaf = level !== undefined && level.complete && !level.error && level.listed.size === 0 && countBelow(context.rulePaths, path) === 0;
    view.toggle.disabled = leaf;
    if (leaf) view.toggle.removeAttribute("aria-expanded");
    else view.toggle.setAttribute("aria-expanded", String(store.expanded.has(path)));
    view.toggle.setAttribute("aria-label", `${store.expanded.has(path) ? "Collapse" : "Expand"} ${child.name}`);

    const sharedBelow = countBelow(context.sharedPaths, path);
    view.shared.tag.hidden = sharedBelow === 0;
    setText(view.shared.long, `${sharedBelow} SHARED`);
    setText(view.shared.short, String(sharedBelow));
    view.shared.tag.title = `${sharedBelow} SHARED`;
    const pendingBelow = countBelow(store.changed, path);
    view.pending.tag.hidden = pendingBelow === 0;
    setText(view.pending.long, `${pendingBelow} PENDING`);
    setText(view.pending.short, String(pendingBelow));
    view.pending.tag.title = `${pendingBelow} PENDING`;
    view.missing.hidden = !child.missing;

    setText(
      view.pendingText,
      changed
        ? `Pending: ${CHOICE_NAME[liveChoice]} → ${CHOICE_NAME[draftChoice]}`
        : liveEffect !== draftEffect
          ? `Pending: ${EFFECTIVE_NAME[liveEffect]} → ${EFFECTIVE_NAME[draftEffect]}`
          : "",
    );

    const blockedBy = excludedAncestor(store, segments);
    for (const choice of CHOICES) {
      const input = view.inputs[choice];
      const option = view.options[choice];
      input.checked = choice === draftChoice;
      const blocked = blockedBy !== null && (choice === "share" || choice === "share-sub");
      input.disabled = store.saving || blocked;
      option.title = blocked ? `Excluded by ${blockedBy}` : CHOICE_TITLE[choice];
      option.classList.toggle("is-live", !changed && choice === draftChoice);
      option.classList.toggle("is-before", changed && choice === liveChoice);
      option.classList.toggle("is-after", changed && choice === draftChoice);
    }

    const liveRoot = store.live.rules.isShareRoot(segments);
    const draftRoot = store.draftRules.isShareRoot(segments);
    view.copy.hidden = !liveRoot && !draftRoot;
    view.copy.disabled = !liveRoot;
    const copyLabel = liveRoot ? "Copy short URL" : "Short URL available after save";
    view.copy.title = copyLabel;
    view.copy.setAttribute("aria-label", liveRoot ? `Copy short URL of ${path}` : copyLabel);
  }

  #renderActionbar(): void {
    const { store, dom } = this;
    const unsupported = store.live.unsupported.length;
    const visible = store.phase === "ready" && (store.changed.size > 0 || unsupported > 0 || store.invalid !== null);
    dom.actionbar.hidden = !visible;
    document.body.classList.toggle("has-actionbar", visible);
    if (!visible) return;
    setText(dom.pendingCount, count(store.changed.size, "PENDING CHANGE"));
    setText(dom.unsupportedNote, unsupported > 0 ? `${count(unsupported, "UNSUPPORTED LINE")} WILL BE REMOVED` : "");
    setText(dom.save, store.saving ? "SAVING…" : "SAVE");
    dom.save.disabled = store.saving;
    dom.discard.disabled = store.saving || store.changed.size === 0;
  }
}

/** The topmost ancestor excluded in the draft, as a path, or `null` (§6.5). */
function excludedAncestor(store: Store, segments: readonly string[]): string | null {
  for (let depth = 1; depth < segments.length; depth++) {
    const ancestor = segments.slice(0, depth);
    if (store.draftRules.isDirExcluded(ancestor)) return ancestor.join("/");
  }
  return null;
}

/** Makes `list` hold exactly `items` in order, moving only nodes that are out of place. */
function syncChildren(list: HTMLElement, items: readonly HTMLElement[]): void {
  for (const [index, item] of items.entries()) {
    const current = list.children[index];
    if (current !== item) list.insertBefore(item, current ?? null);
  }
  while (list.children.length > items.length) list.lastElementChild?.remove();
}

/** The full short URL of a share folder (§7.4). */
export function shortUrl(segments: readonly string[]): string {
  return `${location.origin}${shortSharePath(encodeShareToken(segments))}`;
}
