/**
 * Server-rendered pages (spec §9 `html`; UI spec §5, §7, §10, §11): the share
 * page, the `404` page and the generic error page. Pure string building, one
 * pass, joined once; the pages contain no `<script>`. Images load from R2
 * and configured README image domains. Absolute links also include the
 * trusted brand link, trusted footer / rendered README links and the
 * "Powered by" credit.
 *
 * Escaping: every dynamic text and attribute value goes through `escapeHtml`.
 * The only raw insertions are this module's static markup, `Readme.html`
 * (already safe, see `readme.ts`) and `AppConfig.footerHtml` (trusted admin
 * deployment setting, UI spec §5.5; it must never come from R2 or a request).
 * `brandName` and `brandUrl` are trusted too, but still escaped as text.
 *
 * Share pages carry Open Graph metadata (`og:type`, `og:site_name`,
 * `og:title`, `og:url`, and `og:image` / `og:image:alt` from the first image
 * the README panel shows). The 404 and error pages have none, so a preview of
 * a broken link reveals nothing.
 *
 * Markup / class contract for `public/assets/theme.css` (Task 7):
 *
 *   <body>
 *     svg.sprite                      0×0 icon sprite (width/height="0"); CSS
 *                                     should also take it out of the flow
 *                                     (position:absolute; overflow:hidden).
 *                                     Symbols: #i-logo #i-folder #i-file
 *                                     #i-caret #i-download (stroke=currentColor)
 *     header.topbar                   top bar, wraps on narrow screens
 *       span.brand                    a.brand[href] when BRAND_URL is set
 *         svg.icon.brand__glyph       logo glyph (--accent, 22px)
 *         span.brand__name            BRAND_NAME, default "SIMPLE R2 SHARE"
 *           span.brand__cjk           each run of CJK characters, nudged down
 *                                     to center on the glyph like Latin caps
 *       p.sync                        "SYNCED <time>YYYY-MM-DD HH:mm UTC</time>"
 *         span.sync__dot              --ok status light (aria-hidden, empty)
 *         time.sync__time[datetime]
 *     main.main
 *       --- share page ---
 *       section.hero                  corner brackets via ::before / ::after
 *         h1.hero__title              last segment of the share root
 *         div.hero__bar               stats + button; flex, button to the right,
 *                                     aligned to the stats' bottom; wraps ≤ 560px
 *           p.stats                   "<b>9</b> FILES · <b>3</b> FOLDERS · <b>248.6</b> MB"
 *             b                       the numbers (--fg, bold)
 *           a.button.hero__download   "Download all" (only if ZIP on and files > 0)
 *             svg.icon.button__icon   #i-download
 *             span.button__label
 *       section.panel.panel--files
 *         div.panel__head             h2 left, aside right, --line below
 *           h2.panel__title           "FILES"
 *           span.panel__aside         "SIZE"
 *         ul.tree                     nested <ul> (no class) inside folders
 *           li > details[open] > summary.row.row--folder
 *             svg.icon.row__caret     rotate 90° when details[open]
 *             svg.icon.row__icon      #i-folder (--accent)
 *             span.row__name
 *             span.row__meta          "3 items" / "1 item"
 *           li > details > ul         child level: 1px dashed --line on the left
 *           li > div.row.row--file
 *             svg.icon.row__icon      #i-file (--muted); no caret, so CSS must
 *                                     indent file rows by the caret's width+gap
 *             a.row__name[href]       R2 public URL, same tab
 *               (span.row__name when no public URL can be built)
 *             span.row__meta          "8.4 KB"
 *         p.panel__empty              "No files in this share yet." (instead of ul.tree)
 *       section.panel.panel--readme   only when a README was found
 *         div.panel__head > h2.panel__title   actual file name, e.g. "README.md"
 *         div.readme                  rendered Markdown; inside it readme.ts emits
 *                                     h3–h6.md-h1…md-h6, span.unavailable,
 *                                     div.table-scroll > table, pre > code, …
 *       --- 404 / error page ---
 *       section.hero.hero--status
 *         div.status__code.status__code--404     "404" (--accent, aria-hidden)
 *         div.status__code.status__code--error   "ERROR" (--danger, aria-hidden)
 *         h1.status__title            "Share not found" / "Something went wrong"
 *         p.status__text
 *     footer.footer                   raw FOOTER_HTML (when set), then
 *                                     "• Powered by <a>Simple R2 Share</a>";
 *                                     the bullet only follows FOOTER_HTML
 */
import { DEFAULT_BRAND_NAME, type AppConfig, type PageChrome } from "./config";
import { bytesQuantity, CJK_RUN, fileCountQuantity, folderCountQuantity, formatBytes, formatItemCount, formatSyncedTime, type Quantity } from "./format";
import type { Listing, TreeNode } from "./listing";
import { publicUrl, zipDownloadPath } from "./paths";
import type { Readme, ReadmeImage } from "./readme";

export const PROJECT_NAME = "Simple R2 Share";
export const PROJECT_URL = "https://github.com/jim60105/simple-r2-share";

export const NOT_FOUND_TITLE = "Share not found";
export const NOT_FOUND_TEXT = "This link doesn't point to an active share. Check the address or ask the person who sent it.";
export const ERROR_TITLE = "Something went wrong";
export const ERROR_TEXT = "This share couldn't be loaded right now. Try again in a minute.";
export const EMPTY_TEXT = "No files in this share yet.";

/**
 * Where the brand and footer come from. Normally the loaded `AppConfig`; when
 * the config itself failed to load (`ConfigError`), pass `pageChromeFromEnv(env)`
 * to keep them, or `null` for the default brand and no custom footer.
 */
export type ChromeSource = PageChrome | null;

const DEFAULT_CHROME: PageChrome = { footerHtml: null, brandName: DEFAULT_BRAND_NAME, brandUrl: null };

export interface SharePageInput {
  /** The share token of the page URL, reused for the ZIP link. */
  readonly token: string;
  /** Share root segments decoded from `token`, never empty. */
  readonly segments: readonly string[];
  /** Canonical URL of this page, used as `og:url`. */
  readonly url: string;
  readonly listing: Listing;
  readonly readme: Readme | null;
  readonly config: Pick<AppConfig, "publicBaseUrl" | "zipEnabled"> & PageChrome;
  /** Render time, shown as `SYNCED …` (the request time). */
  readonly now: Date;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const ESCAPE_PATTERN = /[&<>"']/g;

/** Escapes `& < > " '`; safe for text content and double- or single-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(ESCAPE_PATTERN, (char) => ESCAPES[char] ?? char);
}

// Inline SVG in HTML needs no xmlns, which keeps external URLs out of the page.
// Glyph shapes follow the Tactical HUD prototype (direction A).
const SPRITE =
  '<svg class="sprite" width="0" height="0" aria-hidden="true">' +
  '<symbol id="i-logo" viewBox="0 0 24 24"><path d="M7 2h10l5 5v10l-5 5H7l-5-5V7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 15.5 15.5 8M12 16h4v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></symbol>' +
  '<symbol id="i-folder" viewBox="0 0 16 16"><path d="M1.5 3.5h5l1.5 2h6.5v8h-13z" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>' +
  '<symbol id="i-file" viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>' +
  '<symbol id="i-caret" viewBox="0 0 10 10"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>' +
  '<symbol id="i-download" viewBox="0 0 16 16"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>' +
  "</svg>";

function icon(id: string, className: string): string {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
}

const CARET_ICON = icon("caret", "row__caret");
const FOLDER_ICON = icon("folder", "row__icon");
const FILE_ICON = icon("file", "row__icon");

/**
 * The escaped brand name with every CJK run in `span.brand__cjk`. CJK glyphs
 * share the Latin baseline but sit higher than capitals, so CSS moves only
 * those runs to line up with the logo glyph.
 */
function brandNameHtml(name: string): string {
  let html = "";
  let last = 0;
  for (const match of name.matchAll(CJK_RUN)) {
    html += `${escapeHtml(name.slice(last, match.index))}<span class="brand__cjk">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(name.slice(last));
}

/** Open Graph metadata of a share page; status pages have none. */
interface OpenGraph {
  readonly title: string;
  readonly url: string;
  readonly image: ReadmeImage | null;
}

/** Shared document start: head, sprite and top bar. */
function pushPageStart(out: string[], title: string, chrome: ChromeSource, now: Date, og?: OpenGraph): void {
  const { brandName, brandUrl } = chrome ?? DEFAULT_CHROME;
  const brandTag = brandUrl ? "a" : "span";
  const brandHref = brandUrl ? ` href="${escapeHtml(brandUrl)}"` : "";
  out.push(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark">',
    `<title>${escapeHtml(title)} · ${escapeHtml(brandName)}</title>`,
  );
  if (og !== undefined) {
    out.push(
      '<meta property="og:type" content="website">',
      `<meta property="og:site_name" content="${escapeHtml(brandName)}">`,
      `<meta property="og:title" content="${escapeHtml(og.title)}">`,
      `<meta property="og:url" content="${escapeHtml(og.url)}">`,
    );
    if (og.image !== null) {
      out.push(`<meta property="og:image" content="${escapeHtml(og.image.url)}">`);
      if (og.image.alt !== "") out.push(`<meta property="og:image:alt" content="${escapeHtml(og.image.alt)}">`);
    }
  }
  out.push(
    '<link rel="stylesheet" href="/fonts/JimMonoTC.css"><link rel="stylesheet" href="/assets/theme.css">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    "</head><body>",
    SPRITE,
    `<header class="topbar"><${brandTag} class="brand"${brandHref}>`,
    icon("logo", "brand__glyph"),
    `<span class="brand__name">${brandNameHtml(brandName)}</span></${brandTag}>`,
    '<p class="sync"><span class="sync__dot" aria-hidden="true"></span>SYNCED ',
    `<time class="sync__time" datetime="${escapeHtml(now.toISOString())}">${escapeHtml(formatSyncedTime(now))}</time></p>`,
    "</header>",
  );
}

const POWERED_BY = `Powered by <a href="${PROJECT_URL}">${PROJECT_NAME}</a>`;

/** Shared document end: the footer with the optional raw FOOTER_HTML and the credit. */
function pushPageEnd(out: string[], chrome: ChromeSource): void {
  const footerHtml = chrome?.footerHtml;
  out.push(
    `<footer class="footer">${footerHtml ? `${footerHtml} • ` : ""}${POWERED_BY}</footer>`,
    "</body></html>",
  );
}

function stat(quantity: Quantity): string {
  return `<b>${escapeHtml(quantity.value)}</b> ${escapeHtml(quantity.unit)}`;
}

function pushTree(out: string[], nodes: readonly TreeNode[], publicBaseUrl: string): void {
  for (const node of nodes) {
    if (node.kind === "folder") {
      out.push(
        '<li><details open><summary class="row row--folder">',
        CARET_ICON,
        FOLDER_ICON,
        `<span class="row__name">${escapeHtml(node.name)}</span>`,
        `<span class="row__meta">${formatItemCount(node.childCount)}</span></summary><ul>`,
      );
      pushTree(out, node.children, publicBaseUrl);
      out.push("</ul></details></li>");
    } else {
      const url = publicUrl(publicBaseUrl, node.key);
      const name = escapeHtml(node.name);
      out.push(
        '<li><div class="row row--file">',
        FILE_ICON,
        url === null ? `<span class="row__name">${name}</span>` : `<a class="row__name" href="${escapeHtml(url)}">${name}</a>`,
        `<span class="row__meta">${formatBytes(node.size)}</span></div></li>`,
      );
    }
  }
}

/** The share page (UI spec §5), including the empty state (§7.1). */
export function renderSharePage(input: SharePageInput): string {
  const { token, segments, url, listing, readme, config, now } = input;
  const name = segments.at(-1);
  if (name === undefined) throw new TypeError("html: segments must not be empty");

  const out: string[] = [];
  pushPageStart(out, name, config, now, { title: name, url, image: readme?.image ?? null });
  out.push(
    '<main class="main"><section class="hero">',
    `<h1 class="hero__title">${escapeHtml(name)}</h1>`,
    '<div class="hero__bar"><p class="stats">',
    `${stat(fileCountQuantity(listing.fileCount))} · ${stat(folderCountQuantity(listing.folderCount))} · ${stat(bytesQuantity(listing.totalBytes))}</p>`,
  );
  if (config.zipEnabled && listing.fileCount > 0) {
    out.push(
      `<a class="button hero__download" href="${escapeHtml(zipDownloadPath(token))}">`,
      icon("download", "button__icon"),
      '<span class="button__label">Download all</span></a>',
    );
  }
  out.push(
    "</div></section>",
    '<section class="panel panel--files" aria-labelledby="files-title"><div class="panel__head">',
    '<h2 class="panel__title" id="files-title">FILES</h2><span class="panel__aside">SIZE</span></div>',
  );
  if (listing.root.length === 0) {
    out.push(`<p class="panel__empty">${EMPTY_TEXT}</p>`);
  } else {
    out.push('<ul class="tree">');
    pushTree(out, listing.root, config.publicBaseUrl);
    out.push("</ul>");
  }
  out.push("</section>");
  if (readme !== null) {
    out.push(
      '<section class="panel panel--readme" aria-labelledby="readme-title"><div class="panel__head">',
      `<h2 class="panel__title" id="readme-title">${escapeHtml(readme.filename)}</h2></div>`,
      `<div class="readme">${readme.html}</div></section>`,
    );
  }
  out.push("</main>");
  pushPageEnd(out, config);
  return out.join("");
}

function renderStatusPage(code: "404" | "ERROR", modifier: string, title: string, text: string, chrome: ChromeSource, now: Date): string {
  const out: string[] = [];
  pushPageStart(out, title, chrome, now);
  out.push(
    '<main class="main"><section class="hero hero--status">',
    `<div class="status__code status__code--${modifier}" aria-hidden="true">${code}</div>`,
    // Static texts from this module, not escaped so `doesn't` stays readable in the source.
    `<h1 class="status__title">${title}</h1>`,
    `<p class="status__text">${text}</p>`,
    "</section></main>",
  );
  pushPageEnd(out, chrome);
  return out.join("");
}

/**
 * The `404` page (UI spec §7.2). Identical for every reason (not shared,
 * missing, broken rules), so it takes no details at all.
 */
export function renderNotFoundPage(chrome: ChromeSource, now: Date): string {
  return renderStatusPage("404", "404", NOT_FOUND_TITLE, NOT_FOUND_TEXT, chrome, now);
}

/**
 * The generic error page (UI spec §7.2). Takes no error so nothing internal can
 * leak; log details on the server instead. `chrome` may be `null` when the
 * configuration itself could not be loaded.
 */
export function renderErrorPage(chrome: ChromeSource, now: Date): string {
  return renderStatusPage("ERROR", "error", ERROR_TITLE, ERROR_TEXT, chrome, now);
}
