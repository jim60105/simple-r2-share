import { describe, expect, it } from "vitest";
import { buildListing, type Listing } from "../src/listing";
import {
  MAX_README_BYTES,
  UNAVAILABLE_CLASS,
  UNAVAILABLE_TITLE,
  classifyHref,
  loadReadme,
  renderReadme,
  selectReadme,
  type ReadmeContext,
} from "../src/readme";
import { parseRules, type Rules } from "../src/rules";
import { FakeBucket } from "./fake-bucket";

const RULES_KEY = ".r2-share-rules";
const PREFIX = "releases/project-a/";
const BASE = "https://files.example.com";
const UNAVAILABLE_OPEN = `<span class="${UNAVAILABLE_CLASS}" title="${UNAVAILABLE_TITLE}">`;

function rules(...lines: string[]): Rules {
  const parsed = parseRules(lines.join("\n"), RULES_KEY);
  expect(parsed.status).toBe("loaded");
  return parsed;
}

const DEFAULT_RULES = rules("releases/project-a/", "!releases/project-a/private/", "!releases/project-a/**/*.secret");

/** Paths relative to the share root (plus any absolute keys starting with `/`), as a FakeBucket. */
function bucket(files: Record<string, string>): FakeBucket {
  const fake = new FakeBucket();
  for (const [path, body] of Object.entries(files)) {
    fake.add(path.startsWith("/") ? path.slice(1) : PREFIX + path, body);
  }
  return fake;
}

async function setup(
  files: Record<string, string>,
  rulesForShare: Rules = DEFAULT_RULES,
): Promise<{ fake: FakeBucket; context: ReadmeContext }> {
  const fake = bucket(files);
  const page = await fake.list({ prefix: PREFIX });
  const listing = buildListing(page.objects, PREFIX, rulesForShare);
  return { fake, context: { listing, rules: rulesForShare, publicBaseUrl: BASE, readmeImageDomains: [] } };
}

/** A context whose listing holds the given share-relative files (contents irrelevant). */
function contextWith(paths: string[], rulesForShare: Rules = DEFAULT_RULES): ReadmeContext {
  const objects = paths.map((path) => ({ key: path.startsWith("/") ? path.slice(1) : PREFIX + path, size: 1, uploaded: new Date(0) }));
  const listing: Listing = buildListing(objects, PREFIX, rulesForShare);
  return { listing, rules: rulesForShare, publicBaseUrl: BASE, readmeImageDomains: [] };
}

const FILES = [
  "docs/guide.pdf",
  "img/logo.png",
  "中文 檔案.txt",
  "top.txt",
  "private/key.txt",
  "notes.secret",
  "a%20b.txt",
  "/releases/outside.txt",
  "/releases/project-a2/x.txt",
];
const CONTEXT = contextWith(FILES);

function render(markdown: string, context: ReadmeContext = CONTEXT): string {
  return renderReadme(markdown, context).html;
}

/** The image the page head would use as `og:image`. */
function imageOf(markdown: string, context: ReadmeContext = CONTEXT) {
  return renderReadme(markdown, context).image;
}

function unavailable(inner: string): string {
  return `${UNAVAILABLE_OPEN}${inner}</span>`;
}

/** No executable markup can come out of README content. */
function expectInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  // Event handler attributes, ignoring text inside (escaped) attribute values.
  expect(html.replace(/"[^"]*"/g, '""')).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  // Every emitted URL is an absolute http(s) URL.
  expect(html).not.toMatch(/(?:href|src)\s*=\s*"(?!https?:\/\/)/i);
}

describe("selectReadme", () => {
  it("prefers README.md over .README.md", () => {
    const context = contextWith(["README.md", ".README.md"]);
    expect(selectReadme(context.listing)?.path).toBe("README.md");
  });

  it("falls back to .README.md", () => {
    const context = contextWith([".README.md", "readme.md", "docs/README.md"]);
    expect(selectReadme(context.listing)?.path).toBe(".README.md");
  });

  it("only uses the share root and exact names", () => {
    const context = contextWith(["docs/README.md", "readme.md", "README.markdown", "/releases/README.md"]);
    expect(selectReadme(context.listing)).toBeNull();
  });

  it("skips an excluded README.md and uses .README.md", () => {
    const context = contextWith(["README.md", ".README.md"], rules("releases/project-a/", "!releases/project-a/README.md"));
    expect(selectReadme(context.listing)?.path).toBe(".README.md");
  });

  it("returns null when both candidates are excluded", () => {
    const context = contextWith(
      ["README.md", ".README.md"],
      rules("releases/project-a/", "!releases/project-a/README.md", "!releases/project-a/.README.md"),
    );
    expect(selectReadme(context.listing)).toBeNull();
  });
});

describe("loadReadme", () => {
  it("reads and renders README.md and reports the filename", async () => {
    const { fake, context } = await setup({ "README.md": "# Hello", ".README.md": "# Hidden" });
    const readme = await loadReadme(fake.asR2Bucket(), context);
    expect(readme).toEqual({ filename: "README.md", html: '<h3 class="md-h1">Hello</h3>\n', image: null });
    expect(fake.getCalls).toEqual([`${PREFIX}README.md`]);
  });

  it("uses .README.md when README.md is missing", async () => {
    const { fake, context } = await setup({ ".README.md": "hi", "docs/README.md": "no" });
    expect(await loadReadme(fake.asR2Bucket(), context)).toEqual({ filename: ".README.md", html: "<p>hi</p>\n", image: null });
  });

  it("reports the first image it shows for the Open Graph preview", async () => {
    const { fake, context } = await setup({ "README.md": "![The logo](img/logo.png)\n\n![Second](top.txt)", "img/logo.png": "png", "top.txt": "t" });
    expect(await loadReadme(fake.asR2Bucket(), context)).toEqual({
      filename: "README.md",
      html: `<p><img src="${BASE}/releases/project-a/img/logo.png" alt="The logo"></p>\n` +
        `<p><img src="${BASE}/releases/project-a/top.txt" alt="Second"></p>\n`,
      image: { url: `${BASE}/releases/project-a/img/logo.png`, alt: "The logo" },
    });
  });

  it("returns null without touching R2 when there is no README", async () => {
    const { fake, context } = await setup({ "a.txt": "a" });
    expect(await loadReadme(fake.asR2Bucket(), context)).toBeNull();
    expect(fake.getCalls).toEqual([]);
  });

  it("does not read an excluded README", async () => {
    const { fake, context } = await setup(
      { "README.md": "secret" },
      rules("releases/project-a/", "!releases/project-a/README.md"),
    );
    expect(await loadReadme(fake.asR2Bucket(), context)).toBeNull();
    expect(fake.getCalls).toEqual([]);
  });

  it("treats a README deleted between list and get as missing", async () => {
    const { fake, context } = await setup({ "README.md": "# Hello" });
    fake.objects.delete(`${PREFIX}README.md`);
    expect(await loadReadme(fake.asR2Bucket(), context)).toBeNull();
  });

  it("skips a README larger than MAX_README_BYTES", async () => {
    const { fake, context } = await setup({ "README.md": "a".repeat(MAX_README_BYTES + 1) });
    expect(await loadReadme(fake.asR2Bucket(), context)).toBeNull();
    expect(fake.getCalls).toEqual([]);
  });

  it("renders a README of exactly MAX_README_BYTES", async () => {
    const { fake, context } = await setup({ "README.md": "a".repeat(MAX_README_BYTES) });
    expect((await loadReadme(fake.asR2Bucket(), context))?.html.length).toBeGreaterThan(MAX_README_BYTES);
  });

  it("skips a README that grew too large after the listing", async () => {
    const { fake, context } = await setup({ "README.md": "small" });
    fake.add(`${PREFIX}README.md`, "a".repeat(MAX_README_BYTES + 1));
    expect(await loadReadme(fake.asR2Bucket(), context)).toBeNull();
    expect(fake.getCalls).toEqual([`${PREFIX}README.md`]);
  });

  it("replaces invalid UTF-8 and drops a BOM", async () => {
    const { fake, context } = await setup({ "README.md": "" });
    fake.add(`${PREFIX}README.md`, new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xff, 0x42]));
    expect((await loadReadme(fake.asR2Bucket(), context))?.html).toBe("<p>A\uFFFDB</p>\n");
  });

  it("propagates R2 errors from get and from the body", async () => {
    const { fake, context } = await setup({ "README.md": "x" });
    const boom = new Error("R2 down");
    fake.failGet = () => boom;
    await expect(loadReadme(fake.asR2Bucket(), context)).rejects.toBe(boom);
    fake.failGet = null;
    fake.failBody = () => boom;
    await expect(loadReadme(fake.asR2Bucket(), context)).rejects.toBe(boom);
  });
});

describe("relative links", () => {
  it("rewrites links inside the share to the public R2 URL", () => {
    expect(render("[guide](docs/guide.pdf)")).toBe(
      `<p><a href="${BASE}/releases/project-a/docs/guide.pdf">guide</a></p>\n`,
    );
    expect(render("[g](./docs/../docs/guide.pdf) [t](/top.txt)")).toBe(
      `<p><a href="${BASE}/releases/project-a/docs/guide.pdf">g</a> <a href="${BASE}/releases/project-a/top.txt">t</a></p>\n`,
    );
  });

  it("resolves raw and percent-encoded Chinese file names", () => {
    const url = `${BASE}/releases/project-a/${encodeURIComponent("中文 檔案.txt")}`;
    expect(render("[a](<中文 檔案.txt>) [b](%E4%B8%AD%E6%96%87%20%E6%AA%94%E6%A1%88.txt)")).toBe(
      `<p><a href="${url}">a</a> <a href="${url}">b</a></p>\n`,
    );
  });

  it("does not link keys with a literal %XX (double encoding is rejected by paths)", () => {
    expect(render("[x](a%2520b.txt) [y](a%20b.txt)")).toBe(`<p>${unavailable("x")} ${unavailable("y")}</p>\n`);
  });

  it("drops the query and fragment of relative links", () => {
    expect(render("[x](top.txt?download=1#part)")).toBe(`<p><a href="${BASE}/releases/project-a/top.txt">x</a></p>\n`);
  });

  it.each([
    ["leaves the share root", "../outside.txt"],
    ["reaches a sibling share", "../project-a2/x.txt"],
    ["points to an excluded folder", "private/key.txt"],
    ["points to an excluded pattern", "notes.secret"],
    ["points to a file that does not exist", "missing.txt"],
    ["points to a directory", "docs/"],
    ["uses an encoded dot segment", "%2e%2e/outside.txt"],
    ["smuggles a separator", "docs%2Fguide.pdf"],
    ["uses a backslash", "docs\\\\guide.pdf"],
    ["is fragment-only", "#section"],
    ["is empty", ""],
  ])("renders unavailable when the href %s", (_why, href) => {
    const html = render(`[**see** \`it\`](${href})`);
    expect(html).toBe(`<p>${unavailable("<strong>see</strong> <code>it</code>")}</p>\n`);
    expect(html).not.toContain("href");
  });

  it("re-checks exclusion even if the listing contains the key", () => {
    const context = { ...CONTEXT, rules: rules("releases/project-a/", "!releases/project-a/top.txt") };
    expect(render("[t](top.txt)", context)).toBe(`<p>${unavailable("t")}</p>\n`);
  });

  it("works with reference-style links and keeps titles", () => {
    expect(render('[x][ref]\n\n[ref]: top.txt "The &quot;top&quot;"')).toBe(
      `<p><a href="${BASE}/releases/project-a/top.txt" title="The &quot;top&quot;">x</a></p>\n`,
    );
  });
});

describe("absolute links", () => {
  it("keeps http and https links", () => {
    expect(render("[a](https://example.com/x?a=1&b=2) [b](http://example.com)")).toBe(
      '<p><a href="https://example.com/x?a=1&amp;b=2" rel="noopener noreferrer">a</a> ' +
        '<a href="http://example.com/" rel="noopener noreferrer">b</a></p>\n',
    );
  });

  it("keeps https autolinks", () => {
    expect(render("<https://example.com/a>")).toBe(
      '<p><a href="https://example.com/a" rel="noopener noreferrer">https://example.com/a</a></p>\n',
    );
  });

  it("does not linkify bare URLs", () => {
    expect(render("see https://example.com")).toBe("<p>see https://example.com</p>\n");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "&#106;avascript:alert(1)",
    "&#x6A;avascript:alert(1)",
    "%6Aavascript:alert(1)",
    "< javascript:alert(1)>",
    "<\tjavascript:alert(1)>",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/png;base64,AAAA",
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "ftp://example.com/x",
    "//evil.example/x",
    "\\\\evil.example/x",
    "/\\evil.example/x",
    "https:evil.example",
    "https:/evil.example",
  ])("renders %s as unavailable", (href) => {
    const html = render(`[click](${href})`);
    expect(html).toBe(`<p>${unavailable("click")}</p>\n`);
    expectInert(html);
  });

  it("never turns a split javascript: into a link", () => {
    const html = render("[x](java\nscript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href");
  });

  it("renders unavailable javascript: and mailto: autolinks as text", () => {
    expect(render("<javascript:alert(1)> <someone@example.com>")).toBe(
      `<p>${unavailable("javascript:alert(1)")} ${unavailable("someone@example.com")}</p>\n`,
    );
  });

  it("renders unavailable javascript: reference definitions", () => {
    expect(render("[x]\n\n[x]: javascript:alert(1)")).toBe(`<p>${unavailable("x")}</p>\n`);
  });
});

describe("images", () => {
  describe("image selected for the page head", () => {
    it("is the first displayed image, not the first Markdown image", () => {
      expect(imageOf("![missing](img/missing.png)\n\n![logo *one*](img/logo.png)\n\n![two](top.txt)")).toEqual({
        url: `${BASE}/releases/project-a/img/logo.png`,
        alt: "logo one",
      });
    });

    it("ignores image syntax inside code spans and fences", () => {
      expect(imageOf("`![x](img/logo.png)`\n\n```\n![y](img/logo.png)\n```")).toBeNull();
    });

    it("finds a reference-style image and an image inside a link", () => {
      expect(imageOf("![ref][logo]\n\n[logo]: img/logo.png")).toEqual({
        url: `${BASE}/releases/project-a/img/logo.png`,
        alt: "ref",
      });
      expect(imageOf("[![logo](img/logo.png)](https://example.com)")).toEqual({
        url: `${BASE}/releases/project-a/img/logo.png`,
        alt: "logo",
      });
    });

    it("is null without an image", () => {
      expect(imageOf("just text")).toBeNull();
      expect(imageOf("![blocked](https://example.com/i.png)")).toBeNull();
    });

    it("skips a blocked external image before an allowed one", () => {
      const context = { ...CONTEXT, readmeImageDomains: ["images.example.com"] };
      expect(imageOf("![blocked](https://evil.example/i.png)\n\n![ext](https://images.example.com/a.png)", context)).toEqual({
        url: "https://images.example.com/a.png",
        alt: "ext",
      });
    });

    it("uses an allowlisted external HTTPS image", () => {
      const context = { ...CONTEXT, readmeImageDomains: ["images.example.com"] };
      expect(imageOf("![ext](https://images.example.com/a.png)", context)).toEqual({
        url: "https://images.example.com/a.png",
        alt: "ext",
      });
    });

    it("is per render, not shared between READMEs", () => {
      expect(imageOf("![a](img/logo.png)")).toEqual({ url: `${BASE}/releases/project-a/img/logo.png`, alt: "a" });
      expect(imageOf("text")).toBeNull();
    });
  });

  it("shows relative images from the public R2 URL", () => {
    expect(render('![The logo](img/logo.png "Logo")')).toBe(
      `<p><img src="${BASE}/releases/project-a/img/logo.png" alt="The logo" title="Logo"></p>\n`,
    );
  });

  it("uses the plain text of formatted alt text", () => {
    expect(render("![a *b* `c`](img/logo.png)")).toBe(
      `<p><img src="${BASE}/releases/project-a/img/logo.png" alt="a b c"></p>\n`,
    );
  });

  it.each([
    ["an external https image", "https://example.com/i.png"],
    ["a data: image", "data:image/png;base64,AAAA"],
    ["an image outside the share", "../outside.txt"],
    ["an excluded image", "private/key.txt"],
    ["a missing image", "img/missing.png"],
    ["a javascript: image", "javascript:alert(1)"],
  ])("renders %s as its alt text", (_why, src) => {
    const html = render(`![<b>alt</b> & more](${src})`);
    expect(html).toBe(`<p>${unavailable("&lt;b&gt;alt&lt;/b&gt; &amp; more")}</p>\n`);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
  });

  it("drops a blocked image without alt text", () => {
    expect(render("before ![](https://example.com/i.png) after")).toBe("<p>before  after</p>\n");
  });

  it("handles images inside available and unavailable links", () => {
    const img = `<img src="${BASE}/releases/project-a/img/logo.png" alt="logo">`;
    expect(render("[![logo](img/logo.png)](https://example.com)")).toBe(
      `<p><a href="https://example.com/" rel="noopener noreferrer">${img}</a></p>\n`,
    );
    expect(render("[![logo](img/logo.png)](../outside.txt)")).toBe(`<p>${unavailable(img)}</p>\n`);
  });
});

describe("raw HTML", () => {
  it("escapes raw HTML blocks and inline HTML", () => {
    const html = render(
      '<script>alert(1)</script>\n\nText <img src=x onerror="alert(1)"> and <a href="javascript:alert(1)">x</a>\n\n<div onclick="x()">d</div>',
    );
    expect(html).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n" +
        "<p>Text &lt;img src=x onerror=&quot;alert(1)&quot;&gt; and &lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;</p>\n" +
        "<p>&lt;div onclick=&quot;x()&quot;&gt;d&lt;/div&gt;</p>\n",
    );
    expectInert(html);
  });

  it("escapes attribute values in link titles and code languages", () => {
    const html = render('[x](https://example.com "a\\" onmouseover=\\"alert(1)")\n\n```js" onclick="x\ncode\n```');
    expectInert(html);
    expect(html).toContain('title="a&quot; onmouseover=&quot;alert(1)"');
    expect(html).toContain('class="language-js&quot;"');
  });
});

describe("headings and tables", () => {
  it("moves headings below the panel heading and keeps the original level as a class", () => {
    expect(render("# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six")).toBe(
      '<h3 class="md-h1">One</h3>\n' +
        '<h4 class="md-h2">Two</h4>\n' +
        '<h5 class="md-h3">Three</h5>\n' +
        '<h6 class="md-h4">Four</h6>\n' +
        '<h6 class="md-h5">Five</h6>\n' +
        '<h6 class="md-h6">Six</h6>\n',
    );
  });

  it("maps setext headings the same way", () => {
    expect(render("One\n===\n\nTwo\n---")).toBe('<h3 class="md-h1">One</h3>\n<h4 class="md-h2">Two</h4>\n');
  });

  it("wraps tables in a scroll container", () => {
    const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html.startsWith('<div class="table-scroll"><table>\n')).toBe(true);
    expect(html.endsWith("</table>\n</div>\n")).toBe(true);
    expect(html.match(/<div/g)).toHaveLength(1);
  });

  it("renders the usual Markdown elements", () => {
    expect(render("*a* **b** `c`\n\n> q\n\n- x\n- y\n\n```\nwww -> x\n```")).toBe(
      "<p><em>a</em> <strong>b</strong> <code>c</code></p>\n" +
        "<blockquote>\n<p>q</p>\n</blockquote>\n" +
        "<ul>\n<li>x</li>\n<li>y</li>\n</ul>\n" +
        "<pre><code>www -&gt; x\n</code></pre>\n",
    );
  });

  it("does not apply typographic replacements", () => {
    expect(render('"quotes" -- (c)')).toBe("<p>&quot;quotes&quot; -- (c)</p>\n");
  });
});

describe("classifyHref", () => {
  it("classifies share, external and unavailable hrefs", () => {
    expect(classifyHref("top.txt", CONTEXT)).toEqual({ kind: "share", url: `${BASE}/releases/project-a/top.txt` });
    expect(classifyHref("https://example.com", CONTEXT)).toEqual({ kind: "external", url: "https://example.com/" });
    expect(classifyHref("#top", CONTEXT)).toEqual({ kind: "unavailable" });
    expect(classifyHref("HTTPS://EXAMPLE.COM/A", CONTEXT)).toEqual({ kind: "external", url: "https://example.com/A" });
  });
});

describe("render state", () => {
  it("keeps link state per render", () => {
    // An unbalanced or leaked stack would make the second render emit the wrong closing tag.
    expect(render("[a](../x)")).toBe(`<p>${unavailable("a")}</p>\n`);
    expect(render("[a](top.txt)")).toBe(`<p><a href="${BASE}/releases/project-a/top.txt">a</a></p>\n`);
  });
});
