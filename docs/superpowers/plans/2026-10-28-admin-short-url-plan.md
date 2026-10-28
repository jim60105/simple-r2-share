# 管理頁與短網址實作計畫

**日期：** 2026-10-28  
**依據：** [規則編輯器與短網址設計規格](../specs/2026-10-28-rules-editor-short-url-design.md)、[管理頁畫面與功能設計規格](../specs/2026-10-28-admin-ui-design.md)  
**畫面參考：** [管理頁畫面原型](../prototypes/2026-10-28-admin-ui.html)（版面、間距、圖示路徑與顏色以原型為起點，與規格不同時以規格為準）

## 技術選擇

| 項目 | 選擇 | 理由 |
| --- | --- | --- |
| Base58 | `bs58@6.0.0`（底層為 `base-x@5`），固定版本 | 標準 Bitcoin 字元集；以位元組陣列做進位轉換，不使用 `BigInt`；ESM，可同時在 Workers 與瀏覽器執行 |
| 前端打包 | `esbuild@0.28.2`，固定版本，加入 devDependencies | 已是 vitest 的間接相依；只做單一入口打包，不需要開發伺服器 |
| 前端語言 | TypeScript，不用框架 | 規格要求不引入第二套應用框架；畫面只有一頁 |
| JWT 驗證 | Web Crypto（`crypto.subtle`）自行實作 | 官方 Access 外掛會略過缺少的 `iss`、`aud`、`exp`，見管理頁規格第 9 節 |
| 測試 | 沿用 Vitest 與 `test/fake-bucket.ts` | 純函式模組直接測試；R2 行為以假 Bucket 模擬 |

## 目錄結構變更

```text
functions/
  s/[[path]].ts              新增：短網址分享頁路由（取代 share/[[path]].ts）
  share/[[path]].ts          刪除
  api/share-zip.ts           改為 token 參數（只改註解，邏輯在 src/zip-handler.ts）
  api/admin/_middleware.ts   新增：Access JWT 驗證與 PUT 的 CSRF 檢查
  api/admin/rules.ts         新增：GET / PUT 規則檔
  api/admin/folders.ts       新增：逐層列舉資料夾
src/
  short-url.ts               新增：路徑 ⇄ token（前後端共用）
  paths.ts                   修改：移除 /share/ 與 ?dir= 解析，新增短網址與資料夾前綴解析
  rules.ts                   修改：只保留純解析與比對（前後端共用），新增 isDirExcluded 與 literal
  rules-store.ts             新增：從 rules.ts 移出的 loadRules 與 RulesReadError
  rules-editor.ts            新增：規則檔 ⇄ 四態狀態、輸出格式、生效狀態與差異計算（前後端共用）
  access.ts                  新增：Access 設定讀取與 JWT 驗證
  admin-api.ts               新增：管理 API 處理函式
  admin/                     新增：管理頁前端（只在瀏覽器執行，使用 DOM）
    main.ts  api.ts  store.ts  tree.ts  render.ts  icons.ts  toast.ts
public/
  admin/index.html           新增：靜態頁面骨架
  admin/admin.css            新增：管理頁樣式
  admin/app.js               建置產生，不進版控
  admin/THIRD_PARTY_LICENSES.txt  建置產生，不進版控
  _headers                   修改：/admin/* 的 CSP 與快取
scripts/
  build-admin.mjs            新增：esbuild 打包與第三方授權檔
tsconfig.admin.json          新增：DOM 環境的型別檢查
```

## 規格補充

撰寫計畫時發現管理頁是靜態檔，讀不到部署設定。因此 `GET /api/admin/rules` 的回應另外帶上 `brandName`（來自 `BRAND_NAME`，未設定時為預設品牌名稱）與 `rulesKey`（來自 `SHARE_RULES_KEY`），分別給頂部列與不支援行橫幅使用。這兩個欄位已與本計畫一起補進管理頁規格第 5.1 節。

## 任務

每個任務完成後執行 `npm test` 與 `npm run typecheck`，兩者都通過才 commit。任務 8 之後再加上 `npm run build`。

### 1. `short-url`：路徑與 token 互轉

新增 `src/short-url.ts`，依規則編輯器規格第 3 節實作，前後端共用，不得使用任何 Workers 專用的全域物件。

```ts
export const MAX_TOKEN_LENGTH = 1400;
export const MAX_PATH_BYTES = 1024;
/** 合法分享路徑的區段 → token。區段不合法或超過長度時丟出 TypeError（屬於程式錯誤）。 */
export function encodeShareToken(segments: readonly string[]): string;
/** token → 區段陣列。任何不合法的輸入都回傳 null，不丟出例外。 */
export function decodeShareToken(token: string): string[] | null;
```

- 正規化路徑：區段以 `/` 串接，不含頭尾斜線。區段驗證改用 `src/paths.ts` 對外提供的 `isValidSegment()`（任務 2 新增），與分享頁共用同一套規則。
- 混淆：
  - 固定公開種子 `SEED = 0x52325348`（ASCII `R2SH`）。
  - 初始狀態 `state = (SEED ^ Math.imul(byteLength, 0x9E3779B1)) >>> 0`，結果為 0 時改用 `SEED`。
  - 每個位元組先執行一次 xorshift32（`x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0`），再以 `x & 0xFF` 與該位元組做 XOR。
  - 編碼與解碼共用同一個函式。
- 編碼：`TextEncoder` → 混淆 → `bs58.encode()`。
- 解碼依序檢查，任一步失敗就回傳 `null`：
  1. 長度介於 1 與 `MAX_TOKEN_LENGTH` 之間，而且每個字元都在 Base58 字元集中。這一步在呼叫 `bs58` 之前完成。
  2. `bs58.decodeUnsafe()` 成功。
  3. 位元組長度介於 1 與 `MAX_PATH_BYTES` 之間。
  4. 重新編碼的結果必須等於輸入，以確保 token 是正規形式。
  5. 反向混淆後，以 `new TextDecoder("utf-8", { fatal: true })` 解碼成功。
  6. 以 `/` 切開後，每個區段都通過 `isValidSegment()`。
- 測試（`test/short-url.test.ts`）：
  - 英文、中文、空白、`#`、`?`、`%`、emoji、多層路徑都能正反向還原。
  - 固定向量：三個路徑（`releases/project-a`、`發佈/專案 A`、1024 位元組邊界路徑）的 token 寫死在測試中。演算法若被意外修改，已發出的網址會全部失效，固定向量可以及早發現。
  - 相同前綴、不同長度的路徑，混淆遮罩不同。
  - 拒絕：空字串、非 Base58 字元（`0`、`O`、`I`、`l`、`/`）、1401 個字元、非正規編碼、無效 UTF-8、空區段、`.`、`..`、反斜線、控制字元、超過 1024 位元組。
  - 粗略 CPU 檢查：在 Node 中對 1024 位元組路徑的 token 重複解碼 100 次，平均每次低於 2 ms。這只是防止明顯退化，正式預算在任務 11 量測。
- `npm install bs58@6.0.0 --save-exact`。

### 2. `paths` 與公開路由改用短網址

**`src/paths.ts`**

- 刪除 `parseSharePath`、`parseZipDir`、`sharePagePath`、`SHARE_PREFIX`，以及相關測試。
- 把現有的區段檢查抽成 `export function isValidSegment(segment: string): boolean`。
- 新增：
  - `parseShortSharePath(pathname: string): string | null`：`/s/<token>/` 回傳 token，其他一律回傳 `null`。只允許單一片段，token 內不能有 `%`。
  - `shortSharePath(token: string): string`：回傳 `/s/<token>/`。
  - `zipDownloadPath(token: string): string`：改為回傳 `/api/share-zip?token=<token>`。
  - `parseFolderPrefix(prefix: string | null): string[] | null`：空字串回傳 `[]`；否則必須以 `/` 結尾、不以 `/` 開頭，而且每個區段都通過 `isValidSegment()`。給管理 API 使用。

**`src/share-handler.ts`、`functions/s/[[path]].ts`**

- 新增 `functions/s/[[path]].ts`，內容與原本的 `functions/share/[[path]].ts` 相同（轉交給 `handleShareRequest`），並刪除舊檔。
- `resolveShare` 改為：
  1. 以 `parseShortSharePath()` 取出 token。
  2. 缺少結尾 `/` 但其餘合法時，回 `308` 導向 `shortSharePath(token)`，判斷順序與現在相同，仍在讀取規則之前。
  3. 以 `decodeShareToken()` 取得區段，失敗回 `404`。
  4. 之後的授權、列舉與渲染不變。
- `SharePageInput` 新增 `token`。`renderSharePage` 的 `Download all` 改用 `zipDownloadPath(token)`。

**`src/zip-handler.ts`**

- 查詢參數改成只接受唯一的 `token`，以 `decodeShareToken()` 解碼，其他情況回 `404`，仍在任何 R2 呼叫之前判斷。

**測試**

- 更新 `test/paths.test.ts`、`test/share-route.test.ts`、`test/zip.test.ts`、`test/html.test.ts`。
- 公開頁與 ZIP 的錯誤 token、未授權目錄、規則檔失效，三者的 `404` 回應位元組完全相同。
- 新增一個測試確認 `functions/share/` 目錄已不存在。舊路徑在 Pages 上沒有任何路由，會直接由 Pages 回應 `404`。

### 3. 拆分 `rules`，新增前端需要的能力

- 新增 `src/rules-store.ts`，把 `loadRules()` 與 `RulesReadError` 從 `src/rules.ts` 移過去，並更新 `share-handler.ts`、`zip-handler.ts` 與測試的 import。移動後 `src/rules.ts` 不再引用 `R2Bucket` 等 Workers 型別。
- `ShareRule` 新增 `literal: readonly string[] | null`：編譯後的每個區段比對器都是字串（字面名稱，已去除跳脫）時，就是這些字串，否則為 `null`。遞迴規則去掉結尾的 `**` 之後再判斷。
- `Rules` 新增 `isDirExcluded(segments)`：目錄本身或任一祖先的最後符合規則為排除時回傳 `true`，共用 `#dirExcluded` 快取。`denyAll()` 的版本回傳 `false`，因為規則檔失效時資料夾只是「未分享」，不是「已排除」。
- 測試：
  - `literal` 涵蓋跳脫字元（`a\*b` → `a*b`）、中文、`**` 在中間（結果為 `null`）、`[ab]`（結果為 `null`）。
  - `isDirExcluded` 與 `isExcluded("<dir>/x")` 的祖先判斷結果在一組隨機規則與路徑上一致。

### 4. `rules-editor`：規則檔與四態狀態

新增 `src/rules-editor.ts`，不使用 DOM 或 Workers 全域物件，Node 測試與前端共用。

```ts
export type RuleState = "share" | "share-sub" | "exclude";       // Inherit = 不在表中
export type StateTable = ReadonlyMap<string, RuleState>;          // key 為以 "/" 串接的路徑
export interface RulesFileModel {
  readonly rules: Rules;                       // parseRules(text) 的結果，即 Live
  readonly states: StateTable;                 // 支援行對應出的狀態
  readonly unsupported: readonly { line: number; text: string }[];
}
export const MANAGED_HEADER: string;
export function readRulesFile(text: string, rulesKey: string): RulesFileModel;
export function escapeSegment(name: string): string;
export function serializeRules(states: StateTable): string;
export type Effective = "shared" | "excluded" | "none";
export function effectiveState(rules: Rules, segments: readonly string[]): Effective;
export function changedPaths(live: StateTable, draft: StateTable): ReadonlySet<string>;
export function countBelow(paths: Iterable<string>, folder: string): number;
```

- `readRulesFile`：依管理頁規格第 3.2 節分類每條規則。`unsupported[].text` 取原文中對應行號的內容，去掉結尾的 `\r`。順序條件以一個已見路徑集合判斷：路徑已出現過，或已見路徑中有它的後代，就列為不支援。規則檔無效時，`states` 與 `unsupported` 都回傳空集合。
- `serializeRules`：
  - 以 `MANAGED_HEADER` 開頭。
  - 路徑依區段逐段比較排序，使用 UTF-16 code unit 順序。
  - 區段經 `escapeSegment` 跳脫 `\ * ? [ ] ! #` 與空白。
  - 依狀態輸出 `P/`、`P/**`、`!P/`，每行以 `\n` 結尾。
- `effectiveState`：依管理頁規格第 4 節的順序判斷，先 `isDirExcluded`，再 `isShareRoot`。
- 測試（`test/rules-editor.test.ts`）：
  - 管理頁規格第 11.1 節「規則對應」與「規則輸出」的所有案例。
  - 屬性測試：隨機產生 200 組狀態表（名稱含中文、空白與特殊字元），驗證「輸出 → `readRulesFile` → 狀態表」與原表相同，而且沒有不支援行。
  - 對同一組狀態表，`effectiveState` 在 `serializeRules` 前後與手算結果一致，包括祖先排除壓過子層分享。

### 5. 假 R2 Bucket 支援寫入與分隔列舉

擴充 `test/fake-bucket.ts`，讓管理 API 可以測試：

- 現有的 `put(key, body, uploaded)` 測試輔助方法改名為 `add()`，並以機械式替換更新所有測試。
- 新增與 R2 相容的 `async put(key, value, options)`：
  - 支援 `onlyIf`，可以是 `{ etagMatches }`、`{ etagDoesNotMatch }` 或 `Headers` 形式的 `If-Match`、`If-None-Match: *`。
  - 條件不符時回傳 `null`。
  - 每次寫入產生新的遞增 `etag` 與 `uploaded`。
- `get()` 與 `head()` 回傳每個物件自己的 `etag`、`httpEtag`、`uploaded`、`size`。
- `list()` 支援 `delimiter: "/"`，回傳 `delimitedPrefixes`，並與 `limit`、`cursor` 正確搭配。
- 可以對 `put` 注入失敗，與現有的 `get`、`list` 一致。

### 6. Access 驗證

新增 `src/access.ts` 與 `functions/api/admin/_middleware.ts`，依管理頁規格第 9 節實作。

```ts
export interface AccessConfig { readonly teamDomain: string; readonly aud: string }
export function loadAccessConfig(env: Env): AccessConfig | null;
export interface AccessIdentity { readonly email: string | null }
export interface KeySource { getKey(kid: string, refresh: boolean): Promise<JsonWebKey | null> }
export function certsKeySource(teamDomain: string, fetchFn: typeof fetch, cache: Cache | null): KeySource;
export function verifyAccessJwt(jwt: string, config: AccessConfig, keys: KeySource, now: Date): Promise<AccessIdentity | null>;
```

- `Env` 新增 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。`loadAccessConfig` 要求 `ACCESS_TEAM_DOMAIN` 是 `https://<name>.cloudflareaccess.com` 形式的 origin（不含路徑），`ACCESS_AUD` 不可為空；不符合就回傳 `null`。
- `certsKeySource`：
  - 以 Cache API 快取 `<teamDomain>/cdn-cgi/access/certs` 的回應一小時，快取鍵就是該網址。
  - `refresh` 為 `true` 時略過快取重新抓取。
  - 只接受 `kty: "RSA"` 的金鑰，`alg` 若存在必須是 `RS256`。
- `verifyAccessJwt`：
  - 依序檢查三段格式、header 的 `alg === "RS256"` 與 `kid`、取得金鑰（找不到就以 `refresh` 再取一次）、`RSASSA-PKCS1-v1_5` 驗章。
  - payload 的 `iss` 必須等於 `teamDomain`，`aud` 可以是字串或陣列但必須包含設定值，`exp` 必須存在且大於現在時間，`nbf` 若存在必須小於等於現在時間。
  - 任何例外都回傳 `null`。
- middleware：
  1. 設定缺少或驗證失敗時回 `403`，內容為 `{"error":"forbidden"}`，加上 `Cache-Control: no-store`。
  2. `PUT`、`POST`、`DELETE`、`PATCH` 必須帶有 `Origin` 而且等於請求網址的 origin；`PUT` 的 `Content-Type` 必須是 `application/json`。不符合就回 `403`。
  3. 通過後把 `email` 放進 `context.data.accessEmail`，再呼叫 `next()`。
- 測試（`test/access.test.ts`）：
  - 用 `crypto.subtle.generateKey` 產生 RSA 金鑰對，簽出各種 JWT，並以假的 `KeySource` 與假 `fetch` 測試。
  - 涵蓋管理頁規格第 11.1 節列出的所有拒絕案例，以及「未知 `kid` 觸發一次重新抓取、第二次仍找不到就拒絕」。
  - 驗證成功時取得 `email`；service token（沒有 `email`、`sub` 為空字串）回傳 `email: null`。
- `wrangler.toml` 的 `[vars]` 加入 `ACCESS_TEAM_DOMAIN = ""` 與 `ACCESS_AUD = ""`，附註解說明本機開發時管理 API 一律回 `403`。

### 7. 管理 API

新增 `src/admin-api.ts`，以及轉交用的 `functions/api/admin/rules.ts`、`functions/api/admin/folders.ts`。處理函式接受 `(request, env, email)`，方便直接測試。

- 共同：
  - 回應為 `application/json; charset=utf-8`，加上 `Cache-Control: no-store` 與 `X-Content-Type-Options: nosniff`。
  - 不支援的方法回 `405` 並附 `Allow`。
  - 例外記錄到 `console.error`，回 `500` 與 `{"error":"internal"}`。
- `GET /api/admin/rules`：依管理頁規格第 5.1 節回應，另外帶上本計畫「規格補充」中的 `brandName` 與 `rulesKey`。規則檔超過 64 KiB 時不讀取內容，直接回傳 `invalid`。
- `PUT /api/admin/rules`：
  - 請求內容超過 128 KiB 時回 `413`，不解析。
  - JSON 格式錯誤、`text` 不是字串，或 `etag` 不是字串也不是 `null` 時回 `400`。
  - `text` 的 UTF-8 長度超過 64 KiB，或 `parseRules()` 的狀態不是 `loaded` 時，回 `400` 與 `{"error":"invalid_rules","problem":"..."}`。
  - 寫入時使用 `bucket.put(rulesKey, text, { onlyIf, httpMetadata: { contentType: "text/plain; charset=utf-8" } })`。`etag` 為 `null` 時的條件是 `If-None-Match: *`，否則是 `etagMatches`。回傳 `null` 就回 `409`。
- `GET /api/admin/folders`：
  - 以 `parseFolderPrefix()` 驗證 `prefix`，不合法回 `400`。
  - 呼叫 `bucket.list({ prefix, delimiter: "/", limit: 1000, cursor })`，把 `delimitedPrefixes` 去掉前綴與結尾 `/`，只保留通過 `isValidSegment()` 的名稱。
  - `truncated` 為真時回傳 `cursor`，否則回傳 `null`。
- 測試（`test/admin-api.test.ts`）：規則檔不存在、無效、超過大小三種讀取狀態；首次建立；以正確或過期的 `etag` 更新；並行寫入時後到者得到 `409`；資料夾的前綴驗證、不安全名稱過濾與多頁游標。
- 部署驗收時另外確認：真實 R2 的 `If-None-Match: *` 在物件已存在時回傳 `null`。假 Bucket 只能模擬這個行為。

### 8. 前端建置設定

- `npm install esbuild@0.28.2 --save-dev --save-exact`。
- `scripts/build-admin.mjs`：
  - 以 esbuild API 打包 `src/admin/main.ts`：`bundle`、`format: "esm"`、`target: "es2022"`、`minify`、`legalComments: "none"`、`metafile: true`，輸出到 `public/admin/app.js`。
  - 依 metafile 找出打包進去的 `node_modules` 套件（預期為 `picomatch`、`bs58`、`base-x`），把各自的 `LICENSE` 串成 `public/admin/THIRD_PARTY_LICENSES.txt`。找不到授權檔就讓建置失敗。
  - `app.js` 第一行加上指向該授權檔的註解。
- `package.json`：
  - `build` 改為 `node scripts/build-fonts.mjs && node scripts/build-admin.mjs`。
  - `typecheck` 改為 `tsc --noEmit && tsc --noEmit -p tsconfig.admin.json`。
- `tsconfig.json` 加上 `"exclude": ["src/admin/**"]`。
- 新增 `tsconfig.admin.json`：繼承 `tsconfig.json`，`lib` 為 `["ES2023", "DOM", "DOM.Iterable"]`，`types` 為 `[]`，`include` 為 `["src/admin/**/*.ts"]`。共用模組會經由 import 一併在 DOM 環境下檢查；任何共用模組誤用 Workers 型別，這一步就會失敗。
- `.gitignore` 加入 `public/admin/app.js` 與 `public/admin/THIRD_PARTY_LICENSES.txt`。
- `public/_headers` 加入 `/admin/*` 規則，內容為管理頁規格第 10 節的 CSP 與 `Cache-Control: no-cache`，並更新檔案開頭的註解。

這個任務先放一個只有 `export {}` 的 `src/admin/main.ts`，確認 build 與 typecheck 流程可以跑通。

### 9. 管理頁靜態骨架與樣式

**`public/admin/index.html`**

- `<html lang="en">`，依序載入 `/fonts/JimMonoTC.css`、`/assets/theme.css`、`/admin/admin.css`，最後以 `<script type="module" src="/admin/app.js">` 載入程式。
- 內含固定的地標與容器：
  - `<header>`：品牌名稱、`ADMIN` 標籤、信箱、`Sign out`。
  - `<main>`：標題區塊、橫幅區、FOLDERS 面板。
  - 底部操作列、toast 容器，以及共用 SVG `<symbol>`：規則四態、資料夾、箭頭、複製、勾號、Logo，路徑取自原型。
- 程式載入前，FOLDERS 面板顯示 `Loading…`。
- 不寫任何 `style` 屬性或 inline script。

**`public/admin/admin.css`**

- 定義管理頁規格第 6.8 節的變數，其餘一律引用 `theme.css` 的變數。
- 依原型與規格第 6 節實作：
  - 頂部列與標題區塊沿用 `theme.css` 既有的 class。
  - 橫幅樣式。
  - 面板標頭與圖例。
  - 資料夾列的三欄 grid（`minmax(0, 1fr) 178px 64px`）。
  - 規則按鈕群組，以 `.is-live`、`.is-before`、`.is-after` 三種狀態上色。
  - 複製按鈕的可用與停用樣式、標籤、幽靈節點、待變更列、`LOAD MORE` 列、底部操作列、toast。
- 縮排使用 `--depth` 自訂屬性：`padding-left: calc(var(--depth) * var(--indent))`。層級線以 `repeating-linear-gradient` 畫出，寬度為 `calc(var(--depth) * var(--indent))`。`--indent` 寬螢幕為 22px，`max-width: 560px` 時為 12px。
- 原生 radio 以視覺隱藏方式保留，仍然可以取得焦點。`input:focus-visible + label` 顯示 `--focus` 外框。
- `@media (max-width: 560px)` 依規格第 8.1 節改成兩行版面。`prefers-reduced-motion` 時取消過渡效果。
- 測試（`test/admin-css.test.ts`，仿照 `test/theme.test.ts` 以 `?raw` 讀取）：所有 `font-size` 都不小於 16px；第 6.8 節的三個變數都有定義；不出現 `#` 開頭的寫死顏色（變數定義除外）。

### 10. 管理頁前端程式

全部位於 `src/admin/`。畫面以 `document.createElement`、`textContent` 與 `<use href="#icon-…">` 建立，**不得使用 `innerHTML`**。

| 模組 | 職責 |
| --- | --- |
| `api.ts` | 三支 API 的 `fetch` 包裝，使用 `credentials: "same-origin"`。非 2xx 回應丟出帶有 `status` 的 `ApiError`；網路錯誤視為 `status: 0` |
| `store.ts` | 單一狀態物件與變更通知（見下方說明） |
| `tree.ts` | 資料夾節點：一般節點、幽靈節點、排序、`NOT IN BUCKET` 判定時機 |
| `render.ts` | 依狀態建立或更新 DOM。每一列以路徑為鍵保留元素，更新時只修改 class、`checked`、`disabled` 與文字，切換規則後鍵盤焦點不會跑掉 |
| `icons.ts` | 以 `createElementNS` 產生 `<svg><use></svg>` |
| `toast.ts` | 單一 toast：成功訊息 5 秒後消失；失敗訊息附關閉按鈕且不自動消失；新訊息取代舊訊息 |
| `main.ts` | 啟動：並行載入規則與第一層資料夾，綁定事件與 `beforeunload` |

`store.ts` 的狀態物件包含：

- 回應資料：`live: RulesFileModel`、`liveText`、`etag`、`savedAt`、`exists`、`invalid`、`email`、`brandName`、`rulesKey`。
- 編輯狀態：`draft: StateTable`，以及由 `serializeRules(draft)` 經 `parseRules()` 解析出的 `draftRules`。
- 衍生資料：`changed: ReadonlySet<string>`。
- 樹狀資料：以路徑為鍵的 `Map`，每個節點記錄 `children`、`cursor`、`loaded`、`expanded`、`loading`、`error`。
- 介面狀態：`saving`、`banner`。

每次修改 Draft 都重新計算 `draftRules` 與 `changed`，接著通知畫面更新。

互動依管理頁規格第 7 節實作，另外注意以下幾點：

- 規則按鈕群組：每列一個 `<fieldset>`，配上視覺隱藏的 `<legend>`（`Rule for <path>`）。四個 `<input type="radio" name="rule-<序號>">` 各自搭配 `<label>`，label 內含圖示與視覺隱藏的文字。祖先在 Draft 中已排除時，停用 `Share` 與 `Share + subfolders` 兩個選項，並設定 `title`。
- 待變更列在資料夾欄放一段視覺隱藏文字，例如 `Pending: Inherit → Share + subfolders`。
- 複製：`encodeShareToken(segments)` → `` `${location.origin}${shortSharePath(token)}` `` → `navigator.clipboard.writeText()`。
- 存檔成功後：用回應的 `etag`、`savedAt` 與送出的文字重建 Live，Draft 保持不變，畫面重新計算。
- `403` 錯誤橫幅的 `RELOAD` 執行 `location.reload()`，Access 會在邊緣導向登入頁。
- 頂部列的 `Sign out` 是一般連結 `href="/cdn-cgi/access/logout"`，不需要程式處理。

測試：`src/admin/` 只負責畫面與事件，邏輯都在任務 4 的 `rules-editor.ts`，已有單元測試。另外為 `tree.ts` 的排序、幽靈節點合併與 `NOT IN BUCKET` 判定時機寫 Node 測試。`tree.ts` 不得使用 DOM，以便在 Node 中測試。

### 11. 畫面與效能驗證

本機沒有 Access，所以不使用 `wrangler pages dev` 驗證管理頁；也**不得**為了測試加入任何略過驗證的開關。

- **畫面驗證**：執行 `npm run build` 後，以 Playwright 開啟 `public/` 的靜態伺服器，用 `page.route()` 攔截 `/api/admin/*` 並回傳假資料，資料內容對應原型的情境。在 360px、768px、1280px 下截圖，逐項核對管理頁規格第 11.2 節中不需要真實環境的項目：
  - 沒有水平捲動、資料夾欄每列只有一行。
  - 按鈕顏色、標籤與計數的變化。
  - 鍵盤操作。
  - toast 5 秒後消失。
  - 主控台沒有 CSP 違規訊息。

  這段腳本只在驗證時使用，不加入儲存庫的相依套件。
- **公開頁 CPU**：以 `wrangler pages dev` 搭配本機 R2，請求 1024 位元組路徑的短網址分享頁與 ZIP 端點。部署到 Workers Free 預覽環境後，在 Cloudflare 後台記錄 CPU 時間，並確認沒有 `exceededCpu`。

### 12. 文件與部署說明

- 更新 `README.md` 與 `README.zh.md`：
  - 分享網址改為 `/s/<token>/`，刪除 `/share/<folder>/` 的說明，並說明短網址可以還原路徑，不具保密性。
  - 新增「管理頁」一節：在 Zero Trust 建立 Self-hosted 應用程式，保護 `/admin`、`/admin/*`、`/api/admin/*`，涵蓋正式網域、`pages.dev` 與預覽網域；取得 AUD tag；設定 `ACCESS_TEAM_DOMAIN` 與 `ACCESS_AUD`。
  - 設定表加入 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。
  - 說明規則檔改由管理頁維護，手寫的 glob 規則在下次存檔時會被移除。
- 兩份規格的狀態改為「已核可」。
- 部署後完成管理頁規格第 11.2 節中需要真實環境的驗收：
  - `Sign out` 之後重新進入 `/admin/` 會被要求登入。
  - 兩個分頁同時編輯時，後存檔的一方看到 `409` 橫幅。
  - 複製的短網址可以開啟對應的分享頁。
  - `If-None-Match: *` 的行為符合預期。
