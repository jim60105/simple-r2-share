/**
 * README selection and safe Markdown rendering (spec §5, §6 steps 4–5; UI spec
 * §5.4 and §10).
 *
 * Selection: only the share root's `README.md`, else `.README.md`, and only if
 * the listing kept it (so exclusion rules and the share-root boundary already
 * apply). The object is then read with `bucket.get`; if it vanished since the
 * listing, there is no README. R2 errors propagate so the route can show the
 * generic error page (spec §8).
 *
 * Limits: a README larger than `MAX_README_BYTES` is not rendered at all
 * (`loadReadme` returns `null`) because rendering it would not fit the Workers
 * Free CPU budget; truncating could cut a link or code fence in half. Bytes
 * that are not valid UTF-8 are replaced with U+FFFD rather than rejecting the
 * whole README: the text is only displayed, never interpreted, so a stray byte
 * should not hide the documentation. A leading BOM is dropped.
 *
 * Rendering uses one module-level `markdown-it` instance (`html: false`,
 * `linkify: false`, `typographer: false`), so raw HTML in the README is shown
 * as escaped text. Every link and image goes through `classifyHref`, the single
 * URL policy of this module; markdown-it's own `validateLink` is switched off
 * so dangerous protocols reach that policy as tokens instead of being left in
 * the output as half-parsed literal text.
 *
 * URL policy:
 * - Relative hrefs are resolved against the share root with
 *   `resolveReadmeHref`. They are usable only if the key is not excluded and is
 *   a file in the listing (so a link to a missing file, a directory or
 *   anything outside the share is unavailable). The output URL is always
 *   rebuilt with `publicUrl`; the author's text never reaches `href`/`src`.
 * - Absolute hrefs are kept only for links whose scheme is exactly `http:` or
 *   `https:`. `javascript:`, `data:`, `mailto:`, `vbscript:`, `file:`, `//host`
 *   and everything else are unavailable.
 * - External images (`http:`/`https:`) are blocked too: the page must not load
 *   anything from external domains (UI spec §11, §13). Only relative images
 *   that resolve to an object in this share are shown, from the R2 public URL.
 * - Fragment-only hrefs (`#section`) are unavailable: README headings carry
 *   no `id`, so the anchor would lead nowhere.
 *
 * Unavailable links keep their inner Markdown (emphasis, code, images) inside
 * `<span class="unavailable" title="Not available in this share">`, with no
 * `href`. Unavailable images become their alt text in the same span, or
 * nothing when the alt text is empty. External links get
 * `rel="noopener noreferrer"` and open in the same tab, like file links.
 *
 * Headings move three levels down below the panel's `<h2>` (`#` -> `<h3>`, …,
 * `####` and deeper -> `<h6>`) and carry `md-h1`…`md-h6` by their ORIGINAL
 * Markdown level for sizing. Tables are wrapped in
 * `<div class="table-scroll">`.
 */
import MarkdownIt from "markdown-it";
import type { Env as MarkdownEnv, Token } from "markdown-it";
import type { FileNode, Listing } from "./listing";
import { isRelativeHref, publicUrl, relativeKey, resolveReadmeHref } from "./paths";
import type { Rules } from "./rules";

/** README file names in priority order, relative to the share root. */
export const README_CANDIDATES = ["README.md", ".README.md"] as const;

/**
 * Larger READMEs are skipped (no README panel). markdown-it needs roughly
 * 0.1–0.5 ms of CPU per KiB depending on how dense the Markdown is, so a
 * typical README of a few KiB fits the Workers Free 10 ms budget easily; this
 * bound only stops a huge file from turning every page view into an error.
 */
export const MAX_README_BYTES = 64 * 1024;

/** CSS class for links and images that are not available in this share. */
export const UNAVAILABLE_CLASS = "unavailable";
/** `title` of unavailable links and images (UI spec §5.4). */
export const UNAVAILABLE_TITLE = "Not available in this share";

export interface Readme {
  /** The file actually used, `README.md` or `.README.md`, for the panel header. */
  readonly filename: string;
  /** Rendered HTML fragment for the README panel body (trusted, already escaped). */
  readonly html: string;
}

export interface ReadmeContext {
  /** Listing of the current share root; its `prefix` is the share root. */
  readonly listing: Listing;
  readonly rules: Rules;
  /** `AppConfig.publicBaseUrl`. */
  readonly publicBaseUrl: string;
}

/** The README file the share page should show, or `null` (spec §6 step 4). */
export function selectReadme(listing: Listing): FileNode | null {
  for (const name of README_CANDIDATES) {
    const file = listing.byPath.get(name);
    if (file !== undefined) return file;
  }
  return null;
}

/**
 * Selects, reads and renders the README. Returns `null` when there is no
 * README, when it vanished between listing and reading, or when it is larger
 * than `MAX_README_BYTES`. Errors from `bucket.get` or reading the body
 * propagate unchanged.
 */
export async function loadReadme(bucket: R2Bucket, context: ReadmeContext): Promise<Readme | null> {
  const file = selectReadme(context.listing);
  if (file === null || file.size > MAX_README_BYTES) return null;

  const object = await bucket.get(file.key);
  if (object === null) return null;
  if (object.size > MAX_README_BYTES) {
    await object.body.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await object.arrayBuffer();
  const markdown = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  return { filename: file.name, html: renderReadme(markdown, context) };
}

/** Renders README Markdown to an HTML fragment using the policy in the module comment. */
export function renderReadme(markdown: string, context: ReadmeContext): string {
  const state: RenderState = {
    context,
    shareSegments: shareSegmentsOf(context.listing.prefix),
    openLinks: [],
  };
  return md.render(markdown, { [STATE]: state });
}

// ---------------------------------------------------------------------------
// URL policy

export type HrefVerdict =
  | { readonly kind: "share"; readonly url: string }
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "unavailable" };

const UNAVAILABLE: HrefVerdict = { kind: "unavailable" };
const HTTP_URL = /^https?:\/\//i;

/**
 * Decides what a link or image href (as markdown-it emits it, i.e. after
 * `normalizeLink`) may become. `share` URLs point into this share on the R2
 * public domain; `external` URLs are absolute `http:`/`https:` URLs.
 */
export function classifyHref(href: string, context: ReadmeContext, shareSegments?: readonly string[]): HrefVerdict {
  if (isRelativeHref(href)) {
    const segments = shareSegments ?? shareSegmentsOf(context.listing.prefix);
    const key = resolveReadmeHref(href, segments);
    if (key === null || context.rules.isExcluded(key)) return UNAVAILABLE;
    const path = relativeKey(key, context.listing.prefix);
    if (path === null || !context.listing.byPath.has(path)) return UNAVAILABLE;
    const url = publicUrl(context.publicBaseUrl, key);
    return url === null ? UNAVAILABLE : { kind: "share", url };
  }
  // Fragment-only, empty, network-path (`//host`) and scheme hrefs end up here.
  if (!HTTP_URL.test(href)) return UNAVAILABLE;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return UNAVAILABLE;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return UNAVAILABLE;
  return { kind: "external", url: url.href };
}

/** `releases/project-a/` -> `["releases", "project-a"]`. */
function shareSegmentsOf(prefix: string): string[] {
  return prefix.slice(0, -1).split("/");
}

// ---------------------------------------------------------------------------
// markdown-it instance and renderer rules

const STATE = Symbol("readme-render-state");

interface RenderState {
  readonly context: ReadmeContext;
  readonly shareSegments: readonly string[];
  /** One entry per open link: whether it was rendered as `<span>` instead of `<a>`. */
  readonly openLinks: boolean[];
}

const md = new MarkdownIt("default", {
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
  xhtmlOut: false,
});

// Every link and image becomes a token so `classifyHref` sees it (see module comment).
md.validateLink = () => true;

const { escapeHtml } = md.utils;
const rules = md.renderer.rules;

function stateOf(env: MarkdownEnv | undefined): RenderState {
  const state = env?.[STATE];
  if (state === undefined) throw new TypeError("readme: render through renderReadme");
  return state as RenderState;
}

function unavailableOpen(): string {
  return `<span class="${UNAVAILABLE_CLASS}" title="${escapeHtml(UNAVAILABLE_TITLE)}">`;
}

function titleAttr(token: Token): string {
  const title = token.attrGet("title");
  return typeof title === "string" && title !== "" ? ` title="${escapeHtml(title)}"` : "";
}

function hrefOf(token: Token, name: "href" | "src"): string {
  const value = token.attrGet(name);
  return typeof value === "string" ? value : "";
}

rules.link_open = (tokens, idx, _options, env) => {
  const token = tokens[idx] as Token;
  const state = stateOf(env);
  const verdict = classifyHref(hrefOf(token, "href"), state.context, state.shareSegments);
  if (verdict.kind === "unavailable") {
    state.openLinks.push(true);
    return unavailableOpen();
  }
  state.openLinks.push(false);
  const rel = verdict.kind === "external" ? ' rel="noopener noreferrer"' : "";
  return `<a href="${escapeHtml(verdict.url)}"${titleAttr(token)}${rel}>`;
};

rules.link_close = (_tokens, _idx, _options, env) => {
  const wasUnavailable = stateOf(env).openLinks.pop();
  if (wasUnavailable === undefined) throw new TypeError("readme: unbalanced link tokens");
  return wasUnavailable ? "</span>" : "</a>";
};

rules.image = (tokens, idx, options, env, renderer) => {
  const token = tokens[idx] as Token;
  const state = stateOf(env);
  const alt = renderer.renderInlineAsText(token.children ?? [], options, env);
  const verdict = classifyHref(hrefOf(token, "src"), state.context, state.shareSegments);
  if (verdict.kind !== "share") {
    return alt === "" ? "" : `${unavailableOpen()}${escapeHtml(alt)}</span>`;
  }
  return `<img src="${escapeHtml(verdict.url)}" alt="${escapeHtml(alt)}"${titleAttr(token)}>`;
};

rules.heading_open = (tokens, idx) => {
  const level = headingLevel(tokens[idx] as Token);
  return `<h${Math.min(level + 2, 6)} class="md-h${level}">`;
};

rules.heading_close = (tokens, idx) => `</h${Math.min(headingLevel(tokens[idx] as Token) + 2, 6)}>\n`;

function headingLevel(token: Token): number {
  const level = Number(token.tag.slice(1));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 6;
}

rules.table_open = (tokens, idx, options, _env, renderer) =>
  `<div class="table-scroll">${renderer.renderToken(tokens, idx, options)}`;

rules.table_close = (tokens, idx, options, _env, renderer) => `${renderer.renderToken(tokens, idx, options)}</div>\n`;

// `html: false` never produces these tokens; escape them anyway as defence in depth.
rules.html_block = (tokens, idx) => escapeHtml((tokens[idx] as Token).content);
rules.html_inline = (tokens, idx) => escapeHtml((tokens[idx] as Token).content);
