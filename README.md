# Simple R2 Share

Read-only folder sharing pages for a public [Cloudflare R2](https://developers.cloudflare.com/r2/) bucket, served by Cloudflare Pages Functions. You list the folders you want to share in one rules file at the bucket root. Each shared folder gets a page at `/share/<folder>/` with an expandable file tree, links to the files on the bucket's existing public URL, and the folder's `README.md` rendered underneath. A "Download all" ZIP button is optional. Every page is built from the bucket's current contents on each request, so there is nothing to publish or rebuild when files or rules change.

**Features**

- Server-rendered HTML: no JavaScript, no external requests. Folders use native `<details>`, so they expand and collapse without scripts.
- Allowlist rules file in a `.gitignore`-like syntax (inverted: nothing is shared unless a rule allows it). `!` rules hide folders and files.
- File links and README images point straight at the bucket's public URL. They are not proxied.
- Safe README rendering: raw HTML is shown as text, relative links that leave the share or point at hidden files are disabled, and external images are blocked.
- Optional streaming ZIP of a whole share (STORE, no compression), turned off by default.
- One dark "Tactical HUD" theme, self-hosted fonts, readable from 360 px wide.

**Non-goals**

- No uploads, admin UI, logins, passwords, tokens or download limits. Everything is read-only.
- No access control on the bucket. The share rules only control what this site lists and zips. **Every object stays directly reachable on the bucket's public URL**, including hidden files and the rules file itself, for anyone who knows or guesses the URL. Don't put anything secret in the bucket.

## How it works

```text
GET /share/releases/project-a/
  → validate the path (one decode per segment; `..`, `%2F`, `%5C`, double encoding, … → 404)
  → read the rules file from R2   (missing or invalid → nothing is shared)
  → is `releases/project-a` an allowed share root?   no → 404
  → list `releases/project-a/` with R2 list(), following the cursor
  → drop excluded objects, build the tree, render README.md (or .README.md)
  → HTML response (Cache-Control: no-store, strict CSP)
```

| URL | What it does |
| --- | --- |
| `/share/<dir>/` | Share page for the bucket folder `<dir>`, for example `/share/releases/project-a/`. Each path segment is percent-encoded once (`/share/releases/%E5%B0%88%E6%A1%88/`). Without the trailing `/` you get a `308` redirect to it. |
| `/api/share-zip?dir=<dir>` | ZIP of the same share, for example `/api/share-zip?dir=releases%2Fproject-a`. Gives `404` unless `ENABLE_ZIP_DOWNLOAD` is `"true"`, and also for any share that the page would `404` on or that has no files. The archive is named after the folder (`project-a.zip`). |

Every share that doesn't exist, isn't allowed, is excluded, or has an invalid URL gets the same `404` page, so a visitor can't tell which reason applied. R2 errors and invalid settings get a generic error page (`500`). The details are only written to the Functions log. Methods other than `GET` and `HEAD` get `405`.

## Requirements

- Node.js 22.12.0 or newer (`engines` in `package.json`) and npm.
- A Cloudflare account. The Workers Free plan works, but read [Limits](#limits-workers-free).
- An R2 bucket that already has a public HTTPS URL: a [custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/#custom-domains) or the bucket's `r2.dev` URL. This project does not make the bucket public. It only links to that URL.

## Configuration

All settings live in [`wrangler.toml`](wrangler.toml):

| Setting | Required | Meaning |
| --- | --- | --- |
| `[[r2_buckets]]` binding `BUCKET` | yes | The bucket to share from. Set `bucket_name`. Keep the binding name `BUCKET`. |
| `R2_PUBLIC_BASE_URL` | yes | The bucket's public base URL, such as `https://files.example.com` or `https://pub-….r2.dev`. Must start with `https://` and must not contain credentials, a `?query` or a `#fragment`. A path prefix is allowed (`https://cdn.example.com/bucket`) and trailing slashes are ignored. Object URLs are built as `<base>/<key, each segment percent-encoded>`. If the value is missing or invalid, every request gets the generic error page. |
| `ENABLE_ZIP_DOWNLOAD` | no | Only the exact string `"true"` turns on the "Download all" button and `/api/share-zip`. Any other value (`"TRUE"`, `"1"`, empty) leaves it off. Default `"false"`. |
| `SHARE_RULES_KEY` | no | Object key of the rules file, relative to the bucket root. Default `.r2-share-rules` (also used when the value is empty). |
| `FOOTER_HTML` | no | One line of HTML rendered **unescaped** in a `<footer>` on every page, including 404 and error pages. Empty or unset means no footer. Treat it as code: only the site admin should be able to set it. The page's Content-Security-Policy still applies, so `<script>` doesn't run, `<style>` elements and external stylesheets are blocked, fonts load only from this site, and images load only from this site or the `R2_PUBLIC_BASE_URL` origin. Inline `style="…"` attributes and ordinary links work. Cloudflare limits a variable to 5 KB. |

**`wrangler.toml` is the source of truth.** It contains `pages_build_output_dir`, so Cloudflare Pages treats it as the project's configuration ([docs](https://developers.cloudflare.com/pages/functions/wrangler-configuration/#source-of-truth)). Bindings, `vars` and the compatibility date can be seen in the dashboard but not edited there. To change a value, edit `wrangler.toml` and deploy again. The new value takes effect with that deployment. Pages also supports `[env.preview]` and `[env.production]` overrides in the same file. If you override one non-inheritable key such as `vars` or `r2_buckets` for an environment, you must override all of them for that environment ([docs](https://developers.cloudflare.com/pages/functions/wrangler-configuration/#configure-environments)).

For local development, put overrides in a `.dev.vars` file next to `wrangler.toml` (it is git-ignored), for example `ENABLE_ZIP_DOWNLOAD="true"`. Values there replace `[vars]` when you run `wrangler pages dev`. You can also pass them as `--binding KEY=VALUE` on the command line.

Changes to R2 objects and to the rules file **do not** need a deployment. The next request sees them.

## Rules file

`.r2-share-rules` (or your `SHARE_RULES_KEY`) is one UTF-8 text object at the bucket root, edited only by the admin. Nothing is shared until a rule allows it.

```gitignore
# Share exactly this folder (with everything below it on one page)
releases/project-a/

# Share project-b, and let each of its subfolders have its own page too
releases/project-b/**

# Hide project-b/private and everything in it, from every page and ZIP
!releases/project-b/private/
```

With this file:

| URL | Result |
| --- | --- |
| `/share/releases/project-a/` | Page listing every file under `releases/project-a/`, at any depth |
| `/share/releases/project-a/docs/` | `404`. An exact rule doesn't give subfolders their own page. |
| `/share/releases/project-a2/` | `404`. Matching uses whole path segments, not string prefixes. |
| `/share/releases/project-b/` and `/share/releases/project-b/sub/` | Pages, without anything under `private/` |
| `/share/releases/project-b/private/` | `404` |

**Syntax**

- One pattern per line. Blank lines are ignored. A line starting with `#` is a comment. A leading `!` makes an exclusion rule. Write `\#` or `\!` to match a literal `#` or `!` at the start.
- `\r\n` line endings and a UTF-8 BOM are accepted. Trailing spaces and tabs are dropped unless escaped (`name\ ` keeps one space).
- One leading `/` is allowed and changes nothing, because every pattern is anchored at the bucket root anyway.
- A trailing `/` makes the rule match directories only. A trailing `/**` matches the directory itself and everything below it.
- Inside a path segment: `*` matches any run of characters except `/`, `?` matches one character except `/` (one UTF-16 code unit), `[abc]`, `[a-z]`, and `[!a]` or `[^a]` match one character from a set, and `\x` matches `x` literally. A segment that is exactly `**` matches zero or more whole segments (`a/**/b` matches `a/b`, `a/x/b`, `a/x/y/b`). `a**b` means the same as `a*b`.
- Matching is case-sensitive, and dotfiles are ordinary names. `{a,b}`, extglobs such as `@(x)`, and quotes are taken literally (no brace expansion). POSIX classes such as `[[:digit:]]` are rejected.

**Semantics**

- **Share roots.** A folder can have a page if the last rule that matches it is an allow rule and no ancestor folder is excluded. An exact rule (`dir/`, or `dir` without the slash) allows only that folder. `dir/**` allows the folder and every descendant folder. The bucket root can never be shared.
- **Content.** Inside an allowed share, every object is listed and zipped unless it, or one of its ancestor folders, is excluded. The last matching rule wins, so a later rule overrides an earlier one for the same path.
- **No re-opening.** Once a folder is excluded, nothing below it can be shared or listed again, whatever later rules say.
- **Always hidden.** The rules object itself, and object keys this site can't link safely: keys with empty, `.` or `..` segments, backslashes, or control characters, plus directory-marker keys ending in `/`.
- R2 has no real folders, so a folder appears in the tree only if a visible file lies below it. An allowed share with no visible files shows "No files in this share yet." without a Download button.

**Deliberate differences from `.gitignore`**

1. **Fail closed.** If any line can't be parsed with certainty, the **whole file** is invalid and every share returns `404`. Problems include leading whitespace, control characters, an empty pattern (`!` or `/`), `a//b`, `.` or `..` segments, a dangling `\`, `\/`, unclosed or reversed `[...]`, `/` or POSIX classes or non-BMP characters inside `[...]`, invalid UTF-8, or a file larger than 64 KiB. Skipping one bad line could silently drop an exclusion. The reason (with the line number) goes to the Functions log as `share rules are invalid: line N: …`, never to visitors. A missing rules file also shares nothing.
2. **Every pattern is anchored at the bucket root.** `*.tmp` matches only `.tmp` objects at the root. Write `**/*.tmp` to match at any depth, for example `!**/*.tmp`.
3. **The trailing `/` decides files vs. directories.** With a trailing `/` a rule matches directories only. Without one it matches files and directories of that name. So `!secret` hides a file *or* a folder named `secret`, and `!secret/` only a folder. For share roots, `dir/` and `dir` are the same exact rule. Use `dir/**` to open subfolders too.

Upload or replace the rules file with Wrangler (`--remote` for the real bucket):

```sh
npx wrangler r2 object put <bucket-name>/.r2-share-rules --file ./r2-share-rules.txt --remote
```

## Deploy

Before the first deploy, edit [`wrangler.toml`](wrangler.toml): `name` (the Pages project name), `bucket_name`, `R2_PUBLIC_BASE_URL`, and the optional variables. Commit the file if you use Git integration.

The build (`npm run build`, i.e. `scripts/build-fonts.mjs`) downloads the pinned Jim Mono TC web font release from GitHub, checks its SHA-256 (a mismatch fails the build), and writes `public/fonts/` together with Chakra Petch from `@fontsource/chakra-petch`. `public/fonts/` is generated and git-ignored. The Pages Functions in `functions/` are bundled by Pages itself.

### Option A: Git integration

1. Push this repository to GitHub or GitLab.
2. In the dashboard, go to **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**, then pick the repository.
3. Build settings: framework preset *None*, **build command** `npm run build`, **build output directory** `public`.
4. Add the build environment variable `NODE_VERSION` = `22` (any version ≥ 22.12.0). The current build image already defaults to Node 22, but it does not read `engines` from `package.json`, so pinning the version keeps the build reproducible.
5. Save and deploy. Pages installs the dependencies, runs the build and deploys `public/` with the Functions. The R2 binding and variables come from `wrangler.toml`.

Each push to the production branch redeploys. Other branches get preview deployments with the same configuration unless you add `[env.preview]` overrides.

### Option B: Direct upload with Wrangler

```sh
npm ci
npm run build
npx wrangler login
npx wrangler pages project create <project-name> --production-branch master   # first time only; same name as in wrangler.toml
npx wrangler pages deploy
```

`wrangler pages deploy` with no directory uses `pages_build_output_dir` (`public`) from `wrangler.toml`. Add `--branch <name>` to deploy a preview. Note that Cloudflare doesn't let a project switch between Git integration and direct upload later.

### After the first deploy

1. Upload the rules file (see [Rules file](#rules-file)).
2. Go through the [post-deploy checklist](#post-deploy-checklist).

## Local development

```sh
npm ci
npm run build            # fonts → public/fonts/ (cached in node_modules/.cache/)
npm run dev              # wrangler pages dev → http://localhost:8788
```

`npm run dev` uses a local, simulated R2 bucket stored in `.wrangler/state/`, named after `bucket_name` in `wrangler.toml`. Seed it with `--local`:

```sh
npx wrangler r2 object put your-bucket-name/.r2-share-rules --file ./rules.txt --local
npx wrangler r2 object put your-bucket-name/releases/project-a/README.md --file ./README.md --local
```

Then open `http://localhost:8788/share/releases/project-a/`. File links and README images still point at `R2_PUBLIC_BASE_URL`, because the local bucket isn't served publicly. Use `.dev.vars` to change variables locally (for example `ENABLE_ZIP_DOWNLOAD="true"`).

Behind an HTTP proxy that Node's `fetch` doesn't pick up, run the build with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

```sh
npm test                 # Vitest
npm run typecheck        # tsc --noEmit
```

Layout: `functions/` holds the thin Pages Functions entry points, `src/` the logic (`rules`, `paths`, `listing`, `readme`, `html`, `zip-stream`, and the two route handlers), `public/` the static theme, `scripts/build-fonts.mjs` the font build, `test/` the tests and `docs/` the design specs.

## Limits (Workers Free)

The Workers Free plan allows **10 ms of CPU time per request**, 128 MB of memory, and 1,000 subrequests to Cloudflare services such as R2 per request ([limits](https://developers.cloudflare.com/workers/platform/limits/)). Time spent waiting on R2 doesn't count as CPU time.

- **Share pages.** Typical shares (up to about 100 files) render well within the CPU budget. A README larger than 64 KiB is skipped (no README panel) rather than rendered. As a safety net, a share whose listing exceeds 10,000 objects or 100 `list()` pages gets the generic error page instead of a partial tree. These caps are intentional and final.
- **ZIP downloads** stream STORE entries (no compression) with data descriptors and ZIP64 when needed, and a `Content-Length` computed up front. Memory stays small, but **CRC-32 is computed in JavaScript over every byte**. On the Free plan's 10 ms budget that probably limits a ZIP to a few MB. Past that the download fails partway (it never ends looking complete). **The real limit has to be measured after deployment** (see the checklist). If it's too low, keep `ENABLE_ZIP_DOWNLOAD` off or move to Workers Paid.
- **ZIP subrequests.** One ZIP may plan at most 900 R2 calls (1 for the rules, plus one per `list()` page, plus one per file). A bigger share gets the generic error page before any bytes are sent.
- An object that changes size or disappears between listing and download aborts the ZIP. There is no snapshot across objects.
- R2 allows a file `a` and a folder `a/` side by side. Both go into the ZIP, but such an archive may fail to extract on Windows and with some other tools.

## Post-deploy checklist

1. **Share page.** Open `https://<your-site>/share/<an allowed dir>/`. Check the tree, sizes, README, and that a file link opens on your R2 public URL.
2. **404.** Open an unlisted folder, a subfolder of an exact rule, and an excluded folder. All three should show the same "Share not found" page.
3. **Live updates.** Upload a file and edit the rules file, then reload. The changes show up without a redeploy.
4. **ZIP off/on.** With `ENABLE_ZIP_DOWNLOAD = "false"` there is no "Download all" button and `/api/share-zip?dir=…` returns `404`. Set it to `"true"`, deploy, and check that the button appears and the archive passes `unzip -t`.
5. **CPU test with real files (required if ZIP is on, spec §7.1).** Make a test share with files of increasing size (for example 1 MB, 5 MB, 20 MB) and download each share's ZIP while you watch the logs:

   ```sh
   npx wrangler pages deployment tail --project-name <project-name> --format pretty
   ```

   A request over the CPU limit is logged with an error outcome such as `exceededCpu` (add `--status error` to see only failures). In the browser it appears as a failed download or Cloudflare error 1102. The project's **Functions** metrics in the dashboard show the same errors. Write down the largest share that still downloads reliably and tell your users, or turn ZIP off.

## Fonts and licenses

- **Jim Mono TC** 0.4.0 ([github.com/jim60105/JimMonoTC](https://github.com/jim60105/JimMonoTC)), the content font. It is pinned by version and SHA-256 in `scripts/build-fonts.mjs`. SIL Open Font License 1.1, with upstream notices for Cascadia Code, Noto Sans CJK and Nerd Fonts.
- **Chakra Petch** (SemiBold and Bold, Latin), the display font, from [`@fontsource/chakra-petch`](https://www.npmjs.com/package/@fontsource/chakra-petch). SIL Open Font License 1.1.

The build copies the license texts into `public/fonts/licenses/`, so a deployed site serves them under `/fonts/licenses/` (for example `/fonts/licenses/LICENSE`, `/fonts/licenses/NOTICE.md` and `/fonts/licenses/ChakraPetch-OFL.txt`).

## License

Licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`). See [`LICENSE`](LICENSE).
