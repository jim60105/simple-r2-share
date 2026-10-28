import { describe, expect, it } from "vitest";
import type { AppConfig, PageChrome } from "../src/config";
import {
  EMPTY_TEXT,
  ERROR_TEXT,
  NOT_FOUND_TEXT,
  PROJECT_URL,
  escapeHtml,
  renderErrorPage,
  renderNotFoundPage,
  renderSharePage,
  type SharePageInput,
} from "../src/html";
import { buildListing, type Listing } from "../src/listing";
import { parseRules, type Rules } from "../src/rules";

const RULES_KEY = ".r2-share-rules";
const SEGMENTS = ["releases", "project-a"];
const PREFIX = "releases/project-a/";
const BASE = "https://files.example.com";
const NOW = new Date("2026-10-27T08:05:59Z");

function rules(...lines: string[]): Rules {
  const parsed = parseRules(lines.join("\n"), RULES_KEY);
  expect(parsed.status).toBe("loaded");
  return parsed;
}

const ALLOW = rules(PREFIX, "!releases/project-a/**/*.secret");

/** Listing of share-relative paths with sizes. */
function listing(files: Record<string, number>, prefix = PREFIX, shareRules = ALLOW): Listing {
  const objects = Object.entries(files).map(([path, size]) => ({ key: prefix + path, size, uploaded: new Date(0) }));
  return buildListing(objects, prefix, shareRules);
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    publicBaseUrl: BASE,
    zipEnabled: false,
    shareRulesKey: RULES_KEY,
    footerHtml: null,
    brandName: "SIMPLE R2 SHARE",
    brandUrl: null,
    ...overrides,
  };
}

function page(overrides: Partial<SharePageInput> = {}): string {
  return renderSharePage({
    token: "hxR19djQFNp3SS7mNmos88qd",
    segments: SEGMENTS,
    listing: listing({ "a.txt": 412 }),
    readme: null,
    config: config(),
    now: NOW,
    ...overrides,
  });
}

/** Visible text: tags dropped, entities decoded, whitespace collapsed. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function titleOf(html: string): string | undefined {
  return /<title>(.*?)<\/title>/.exec(html)?.[1];
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const SAMPLE = listing({
  "builds/win.zip": 84 * 1024 * 1024,
  "builds/linux.tar.gz": 80 * 1024 * 1024,
  "builds/SHA256SUMS.txt": 412,
  "docs/guide.pdf": 1024,
  "docs/img/a.png": 1,
  "README.md": 3174,
});

const POWERED_BY = `Powered by <a href="${PROJECT_URL}">Simple R2 Share</a>`;

function chrome(overrides: Partial<PageChrome> = {}): PageChrome {
  return { footerHtml: null, brandName: "SIMPLE R2 SHARE", brandUrl: null, ...overrides };
}

function allPages(): string[] {
  const custom = chrome({ footerHtml: '<a href="/x">Ops</a>', brandUrl: "/" });
  return [
    page({ listing: SAMPLE, config: config({ zipEnabled: true, ...custom }), readme: { filename: "README.md", html: "<p>hi</p>" } }),
    page({ listing: listing({}) }),
    renderNotFoundPage(custom, NOW),
    renderNotFoundPage(null, NOW),
    renderErrorPage(custom, NOW),
    renderErrorPage(null, NOW),
  ];
}

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;");
  });

  it("leaves other text untouched", () => {
    expect(escapeHtml("中文 檔案 v2 != www")).toBe("中文 檔案 v2 != www");
  });
});

describe("document shell", () => {
  it.each(allPages().map((html, i) => [i, html] as const))("page %i has the shared head, landmarks and no script", (_, html) => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html.indexOf('href="/fonts/JimMonoTC.css"')).toBeGreaterThan(0);
    expect(html.indexOf('href="/fonts/JimMonoTC.css"')).toBeLessThan(html.indexOf('href="/assets/theme.css"'));
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(count(html, "<header ")).toBe(1);
    expect(count(html, "<main ")).toBe(1);
    expect(count(html, "<h1 ")).toBe(1);
    for (const id of ["logo", "folder", "file", "caret", "download"]) {
      expect(count(html, `<symbol id="i-${id}"`)).toBe(1);
    }
    expect(count(html, "<symbol ")).toBe(5);
  });

  it.each(allPages().map((html, i) => [i, html] as const))("page %i only links to the configured public base and the project", (_, html) => {
    const urls = html.match(/https?:\/\/[^"'\s<>]*/g) ?? [];
    for (const url of urls) expect(url === PROJECT_URL || url.startsWith(`${BASE}/`)).toBe(true);
  });

  it("shows the brand, not as a link, and the sync time", () => {
    const html = page();
    expect(html).toContain('<span class="brand"><svg class="icon brand__glyph"');
    expect(html).toContain('<span class="brand__name">SIMPLE R2 SHARE</span></span>');
    expect(html).not.toMatch(/<a [^>]*>[^<]*SIMPLE R2 SHARE/);
    expect(textOf(html)).toContain("SYNCED 2026-10-27 08:05 UTC");
    expect(html).toContain('datetime="2026-10-27T08:05:59.000Z"');
  });

  it("uses BRAND_NAME, escaped, for the brand and the title on every page", () => {
    const custom = chrome({ brandName: "Jim's <Files>" });
    for (const html of [page({ config: config(custom) }), renderNotFoundPage(custom, NOW), renderErrorPage(custom, NOW)]) {
      expect(html).toContain('<span class="brand__name">Jim&#39;s &lt;Files&gt;</span>');
      expect(titleOf(html)).toMatch(/ · Jim&#39;s &lt;Files&gt;$/);
      expect(html).not.toContain("SIMPLE R2 SHARE");
    }
  });

  it("wraps each CJK run of the brand name so CSS can align it with the logo", () => {
    const html = page({ config: config({ brandName: "Jim <的> 備忘手札、メモ v2" }) });
    expect(html).toContain(
      '<span class="brand__name">Jim &lt;<span class="brand__cjk">的</span>&gt; <span class="brand__cjk">備忘手札、メモ</span> v2</span>',
    );
    expect(titleOf(html)).toBe("project-a · Jim &lt;的&gt; 備忘手札、メモ v2");
    expect(page()).not.toContain("brand__cjk");
  });

  it("links the brand to BRAND_URL, escaped, on every page", () => {
    const custom = chrome({ brandUrl: "https://example.com/?a=1&b=2" });
    for (const html of [page({ config: config(custom) }), renderNotFoundPage(custom, NOW), renderErrorPage(custom, NOW)]) {
      expect(html).toContain('<a class="brand" href="https://example.com/?a=1&amp;b=2"><svg class="icon brand__glyph"');
      expect(html).toContain('<span class="brand__name">SIMPLE R2 SHARE</span></a>');
      expect(html).not.toContain('<span class="brand">');
    }
  });

  it("marks every icon aria-hidden", () => {
    const html = page({ listing: SAMPLE, config: config({ zipEnabled: true }) });
    const svgs = html.match(/<svg [^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(5);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
  });

  it("renders no breadcrumbs or navigation", () => {
    expect(page({ listing: SAMPLE })).not.toContain("<nav");
  });
});

describe("footer", () => {
  it("shows only the credit when FOOTER_HTML is unset", () => {
    const expected = `<footer class="footer">${POWERED_BY}</footer>`;
    expect(page()).toContain(expected);
    expect(renderNotFoundPage(chrome(), NOW)).toContain(expected);
    expect(renderErrorPage(null, NOW)).toContain(expected);
  });

  it("renders FOOTER_HTML raw, then the credit, on every page", () => {
    const footerHtml = '© 2026 <a href="/about">Jim</a> &amp; friends';
    const expected = `<footer class="footer">${footerHtml} • ${POWERED_BY}</footer>`;
    expect(page({ config: config({ footerHtml }) })).toContain(expected);
    expect(renderNotFoundPage(chrome({ footerHtml }), NOW)).toContain(expected);
    expect(renderErrorPage(chrome({ footerHtml }), NOW)).toContain(expected);
  });

  it("comes after main", () => {
    const html = page({ config: config({ footerHtml: "x" }) });
    expect(html.indexOf("</main>")).toBeLessThan(html.indexOf("<footer"));
  });
});

describe("renderSharePage", () => {
  it("titles the page and the h1 with the share root's last segment", () => {
    const html = page();
    expect(titleOf(html)).toBe("project-a · SIMPLE R2 SHARE");
    expect(html).toContain('<h1 class="hero__title">project-a</h1>');
  });

  it("escapes the share name and keeps its case", () => {
    const name = `<A&"B'> 專案`;
    const html = page({ segments: ["releases", name], listing: listing({ "a.txt": 1 }, `releases/${name}/`, rules(`releases/${name}/`)) });
    const escaped = "&lt;A&amp;&quot;B&#39;&gt; 專案";
    expect(titleOf(html)).toBe(`${escaped} · SIMPLE R2 SHARE`);
    expect(html).toContain(`<h1 class="hero__title">${escaped}</h1>`);
    expect(html).not.toContain(name);
  });

  it("rejects empty segments", () => {
    expect(() => page({ segments: [] })).toThrow(TypeError);
  });

  it("shows the stats row", () => {
    const html = page({ listing: SAMPLE });
    expect(textOf(html)).toContain("6 FILES · 3 FOLDERS · 164.0 MB");
    expect(html).toContain('<p class="stats"><b>6</b> FILES · <b>3</b> FOLDERS · <b>164.0</b> MB</p>');
  });

  it("uses singular units for one file and one folder", () => {
    const html = page({ listing: listing({ "docs/a.txt": 1 }) });
    expect(textOf(html)).toContain("1 FILE · 1 FOLDER · 1 B");
    expect(textOf(html)).toContain("docs 1 item");
  });

  it("renders a nested, fully expanded tree with item counts and sizes", () => {
    const html = page({ listing: SAMPLE });
    expect(count(html, "<details open>")).toBe(3);
    expect(html).not.toMatch(/<details(?! open>)/);
    expect(textOf(html)).toContain("builds 3 items");
    expect(textOf(html)).toContain("docs 2 items");
    expect(textOf(html)).toContain("img 1 item");
    expect(textOf(html)).toContain("win.zip 84.0 MB");
    expect(textOf(html)).toContain("SHA256SUMS.txt 412 B");
    expect(textOf(html)).toContain("guide.pdf 1.0 KB");
    // docs/img is nested inside docs' <ul>.
    expect(html).toMatch(/<span class="row__name">docs<\/span>.*?<ul><li><details open><summary class="row row--folder">.*?<span class="row__name">img<\/span>/);
    // Folders first: the builds folder comes before the root README file.
    expect(html.indexOf(">builds<")).toBeLessThan(html.indexOf(">README.md<"));
    expect(count(html, '<ul class="tree">')).toBe(1);
  });

  it("puts caret, folder icon, name and count in each folder summary", () => {
    const html = page({ listing: listing({ "docs/a.txt": 1 }) });
    expect(html).toContain(
      '<li><details open><summary class="row row--folder">' +
        '<svg class="icon row__caret" aria-hidden="true"><use href="#i-caret"/></svg>' +
        '<svg class="icon row__icon" aria-hidden="true"><use href="#i-folder"/></svg>' +
        '<span class="row__name">docs</span><span class="row__meta">1 item</span></summary><ul>',
    );
  });

  it("links files to their R2 public URL in the same tab", () => {
    const html = page({ listing: listing({ "docs/安裝 說明.pdf": 1 }) });
    expect(html).toContain(
      '<li><div class="row row--file"><svg class="icon row__icon" aria-hidden="true"><use href="#i-file"/></svg>' +
        `<a class="row__name" href="${BASE}/releases/project-a/docs/%E5%AE%89%E8%A3%9D%20%E8%AA%AA%E6%98%8E.pdf">安裝 說明.pdf</a>` +
        '<span class="row__meta">1 B</span></div></li>',
    );
    expect(html).not.toContain("target=");
  });

  it("uses one file icon for every file", () => {
    const html = page({ listing: SAMPLE });
    expect(count(html, '<use href="#i-file"/>')).toBe(6);
  });

  it("escapes special file and folder names in text and attributes", () => {
    const names = [`a<b>.txt`, `q"uote.txt`, `amp&er.txt`, `it's.txt`, `中文檔案.txt`];
    const html = page({ listing: listing(Object.fromEntries([...names.map((n) => [n, 1]), [`<dir "x">/f.txt`, 1]])) });
    expect(html).toContain('<span class="row__name">&lt;dir &quot;x&quot;&gt;</span>');
    expect(html).toContain(">a&lt;b&gt;.txt</a>");
    expect(html).toContain(">q&quot;uote.txt</a>");
    expect(html).toContain(">amp&amp;er.txt</a>");
    expect(html).toContain(">it&#39;s.txt</a>");
    expect(html).toContain(">中文檔案.txt</a>");
    // Attributes: encodeURIComponent leaves `'` alone, escapeHtml turns it into `&#39;`.
    expect(html).toContain(`href="${BASE}/releases/project-a/it&#39;s.txt"`);
    expect(html).toContain(`href="${BASE}/releases/project-a/amp%26er.txt"`);
    for (const raw of ["a<b>", 'q"uote', "it's", "amp&er", '<dir "x">']) expect(html).not.toContain(raw);
    const text = textOf(html);
    for (const name of names) expect(text).toContain(name);
  });

  it("renders a file name as plain text when no public URL can be built", () => {
    const base = listing({ "a.txt": 1 });
    const file = base.files[0];
    if (file === undefined) throw new Error("missing file");
    const unsafe = { ...file, name: "x<y", key: "releases/project-a/../x<y" };
    const html = page({ listing: { ...base, root: [unsafe], files: [unsafe] } });
    expect(html).toContain('<span class="row__name">x&lt;y</span>');
    expect(html).not.toContain(`href="${BASE}`);
  });

  describe("Download all", () => {
    it("is a link to the ZIP endpoint when enabled and the share has files", () => {
      const html = page({ config: config({ zipEnabled: true }) });
      expect(html).toContain('<a class="button hero__download" href="/api/share-zip?token=hxR19djQFNp3SS7mNmos88qd">');
      expect(textOf(html)).toContain("Download all");
      expect(html).not.toContain("<button");
    });

    it("reuses the page token", () => {
      const html = page({ token: "4q2N13jyPP7WLE86wopSw", config: config({ zipEnabled: true }) });
      expect(html).toContain('href="/api/share-zip?token=4q2N13jyPP7WLE86wopSw"');
    });

    it("is absent when ZIP download is disabled", () => {
      expect(page()).not.toContain("Download all");
      expect(page()).not.toContain("/api/share-zip");
    });

    it("is absent when the share is empty", () => {
      const html = page({ listing: listing({}), config: config({ zipEnabled: true }) });
      expect(html).not.toContain("Download all");
      expect(html).not.toContain("/api/share-zip");
    });
  });

  it("shows the empty state", () => {
    const html = page({ listing: listing({ "x.secret": 5 }) });
    expect(textOf(html)).toContain("0 FILES · 0 FOLDERS · 0 B");
    expect(html).toContain(`<p class="panel__empty">${EMPTY_TEXT}</p>`);
    expect(EMPTY_TEXT).toBe("No files in this share yet.");
    expect(html).not.toContain('class="tree"');
    // The files panel header is still shown.
    expect(html).toContain('<h2 class="panel__title" id="files-title">FILES</h2><span class="panel__aside">SIZE</span>');
  });

  it("labels the files panel with an h2", () => {
    const html = page();
    expect(html).toContain('<section class="panel panel--files" aria-labelledby="files-title">');
    expect(html).toContain('<h2 class="panel__title" id="files-title">FILES</h2>');
    expect(html.indexOf("<h1 ")).toBeLessThan(html.indexOf("<h2 "));
  });

  describe("README panel", () => {
    it("is omitted when there is no README", () => {
      const html = page();
      expect(html).not.toContain("panel--readme");
      expect(count(html, "<h2 ")).toBe(1);
    });

    it("shows the actual file name in an h2 and inserts the rendered HTML as is", () => {
      const readmeHtml = '<h3 class="md-h1">Hi</h3><div class="table-scroll"><table></table></div><span class="unavailable" title="Not available in this share">x</span>';
      const html = page({ readme: { filename: ".README.md", html: readmeHtml } });
      expect(html).toContain(
        '<section class="panel panel--readme" aria-labelledby="readme-title"><div class="panel__head">' +
          '<h2 class="panel__title" id="readme-title">.README.md</h2></div>' +
          `<div class="readme">${readmeHtml}</div></section>`,
      );
      expect(html.indexOf("panel--files")).toBeLessThan(html.indexOf("panel--readme"));
    });

    it("escapes the file name", () => {
      const html = page({ readme: { filename: `<R&"'>.md`, html: "" } });
      expect(html).toContain('id="readme-title">&lt;R&amp;&quot;&#39;&gt;.md</h2>');
    });
  });
});

describe("status pages", () => {
  it("renders the 404 page", () => {
    const html = renderNotFoundPage(null, NOW);
    expect(titleOf(html)).toBe("Share not found · SIMPLE R2 SHARE");
    expect(html).toContain('<div class="status__code status__code--404" aria-hidden="true">404</div>');
    expect(html).toContain('<h1 class="status__title">Share not found</h1>');
    expect(textOf(html)).toContain("This link doesn't point to an active share. Check the address or ask the person who sent it.");
    expect(textOf(html)).toContain(NOT_FOUND_TEXT);
  });

  it("renders the generic error page", () => {
    const html = renderErrorPage(null, NOW);
    expect(titleOf(html)).toBe("Something went wrong · SIMPLE R2 SHARE");
    expect(html).toContain('<div class="status__code status__code--error" aria-hidden="true">ERROR</div>');
    expect(html).toContain('<h1 class="status__title">Something went wrong</h1>');
    expect(textOf(html)).toContain("This share couldn't be loaded right now. Try again in a minute.");
    expect(textOf(html)).toContain(ERROR_TEXT);
  });

  it.each([
    ["404", renderNotFoundPage(chrome(), NOW)],
    ["error", renderErrorPage(chrome(), NOW)],
  ])("%s page has only the hero: no stats, button, panels or details", (_, html) => {
    expect(html).toContain('<section class="hero hero--status">');
    const body = html.slice(html.indexOf("<body>"), html.indexOf("<footer"));
    for (const absent of ["stats", "Download all", "panel", "tree", "<h2", "<details", "<a "]) {
      expect(body).not.toContain(absent);
    }
    const text = textOf(body);
    // Exactly: brand, sync time, big code, title, explanation.
    expect(text).toMatch(/^SIMPLE R2 SHARE SYNCED 2026-10-27 08:05 UTC (404|ERROR) (Share not found|Something went wrong) [^<>]+$/);
    for (const leak of ["Error:", "stack", "R2", "bucket", "rules", "undefined", "null"]) {
      expect(text.replace(/SIMPLE R2 SHARE/g, "")).not.toContain(leak);
    }
  });
});
