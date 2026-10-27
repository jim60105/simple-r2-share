# Simple R2 Share 實作計畫

**日期：** 2026-10-27  
**依據：** [R2 資料夾分享頁設計規格](../specs/2026-10-27-r2-folder-sharing-design.md)、[分享頁 UI 主題設計規格](../specs/2026-10-27-ui-theme-design.md)

## 技術選擇

| 項目 | 選擇 | 理由 |
| --- | --- | --- |
| 語言 | TypeScript | Pages Functions 原生支援 |
| 執行環境 | Cloudflare Pages Functions + R2 binding | 依規格 |
| 測試 | Vitest，搭配記憶體內的假 R2 Bucket | 純函式模組可直接測試，不需要連線 |
| 規則比對 | 自行解析規則檔的每一行，glob 比對交給 `picomatch` | 規格要求的「精確目錄」與「`/**`」語意和 gitignore 的父目錄繼承不同，自行掌握比較可靠 |
| Markdown | `markdown-it`，`html: false` | 預設停用原始 HTML，內建擋下 `javascript:` 等危險協定，可覆寫連結與圖片的輸出 |
| ZIP | `client-zip` | 只產生 STORE（method 0），支援串流與 ZIP64，可在 Workers 中執行 |
| Chakra Petch | `@fontsource/chakra-petch`，鎖定確切版本 | 由 `package-lock.json` 的 integrity 驗證內容 |
| Jim Mono TC | 建置腳本下載 `v0.4.0` 的 web zip，用 SHA-256 驗證 | 依 UI 規格第 4.1 節 |

原始 HTML 支援是規格中的選用項目，本計畫**不實作**。README 中的 HTML 標記會被當成文字輸出。

## 目錄結構

```text
functions/
  share/[[path]].ts      分享頁路由
  api/share-zip.ts       ZIP 端點
src/
  config.ts              讀取部署設定
  paths.ts               URL 與 R2 鍵名的驗證、正規化、相對路徑解析
  rules.ts               規則檔解析、分享根目錄授權、內容排除
  listing.ts             分頁列舉、邊界檢查、排除過濾、樹狀結構、排序、統計
  readme.ts              README 選擇與 Markdown 渲染
  format.ts              檔案大小、數量、時間的格式
  html.ts                頁面版型、分享頁、空目錄、錯誤頁
  zip-stream.ts          STORE ZIP 串流
public/
  assets/theme.css
  favicon.svg
  fonts/                 建置時產生，不進版控
scripts/
  build-fonts.mjs        下載並驗證 Jim Mono TC，複製 Chakra Petch
test/
  fake-bucket.ts         假 R2 Bucket，可設定每頁筆數與錯誤
  *.test.ts
```

## 任務

每個任務完成後執行 `npm test`，通過後 commit。

### 1. 專案骨架

- 建立 `package.json`、`tsconfig.json`、`vitest.config.ts`、`.gitignore`（排除 `node_modules/`、`public/fonts/`、`.wrangler/`）。
- 建立 `wrangler.toml`：設定 `pages_build_output_dir = "public"`、R2 binding `BUCKET`，以及 `R2_PUBLIC_BASE_URL`、`ENABLE_ZIP_DOWNLOAD`、`SHARE_RULES_KEY`、`FOOTER_HTML` 四個變數。
- npm scripts：`build`（執行 `scripts/build-fonts.mjs`）、`dev`（`wrangler pages dev`）、`test`、`typecheck`。
- `src/config.ts`：讀取設定並套用預設值。`ENABLE_ZIP_DOWNLOAD` 只有字串 `true` 才算啟用；`R2_PUBLIC_BASE_URL` 必須是 `https://` 開頭，否則視為設定錯誤。

### 2. `paths`

- 把 `/share/<dir>/` 解析成目錄區段陣列。原始 URL 與解碼後的路徑都要檢查，遇到以下情況一律拒絕：
  - 空區段、`.`、`..`
  - 反斜線、空位元組
  - `%2F`、`%5C`、雙重編碼
  - 結尾沒有 `/`
- 由區段組出 R2 前綴，一律以 `/` 結尾。
- 由 R2 鍵名組出公開網址：每個區段個別做 `encodeURIComponent`。
- 以分享根目錄為基準解析 README 的相對路徑。結果離開分享根目錄時回傳 `null`。
- `isWithin(key, prefix)`：以區段邊界判斷從屬關係，所以 `project-a2/x` 不屬於 `project-a/`。
- 測試涵蓋規格第 10 節列出的所有 URL 攻擊案例。

### 3. `rules`

- 解析規則檔：註解、空行、`\#` 與 `\!` 跳脫、結尾空白、`!` 排除。
- 每條規則記錄三件事：glob 本體、是否為排除、是否以 `/**` 結尾。
- `isShareRoot(dir)`：
  - 依序套用所有規則，以最後一條符合的規則決定結果，而且結果必須是允許。
  - 精確目錄規則只符合該目錄本身。
  - `/**` 規則符合該目錄與所有後代目錄。
  - 任何祖先目錄或目錄本身最後符合的是排除規則時，結果為拒絕。
- `isExcluded(key)`：物件本身或它的任何一層祖先目錄，最後符合的規則是排除時，回傳 `true`。
- 規則檔物件鍵永遠視為排除。
- 規則檔不存在、讀取失敗或無法解析時，所有目錄都不授權。
- 測試涵蓋規格第 4 節的範例、最後符合規則優先、排除後無法被更深的規則重新開放、`*`、`?`、`**`、字元集合。

### 4. `listing` 與 `format`

- `listAll(bucket, prefix)`：依 `truncated` 與 `cursor` 持續列舉直到結束；cursor 沒有前進時丟出錯誤，避免無限迴圈。
- 每個回傳的鍵都要通過 `isWithin` 與 `isExcluded` 檢查，才會納入結果。
- 建立樹狀結構：
  - 資料夾在前、檔案在後。
  - 名稱以 `Intl.Collator("zh-Hant-TW", { numeric: true })` 排序。
  - 資料夾記錄直接子項目數量。
- 統計檔案數、資料夾數、總大小。
- `format.ts`：依 UI 規格第 8 節格式化檔案大小、單複數、同步時間。
- 測試：假 Bucket 每頁 2 筆的分頁、排除過濾、相似字首目錄、排序、空目錄。

### 5. `readme`

- 在分享根目錄依序找 `README.md`、`.README.md`，兩者都不存在或被排除時回傳 `null`。
- `markdown-it` 設定 `html: false`，並覆寫以下輸出規則：
  - **相對連結與圖片**：用 `paths` 解析。結果合法且沒有被排除時，改寫成 R2 公開網址；否則依 UI 規格第 5.4 節輸出成無法使用的樣式。
  - **外部連結**：只保留 `http:` 與 `https:`，其餘協定一律視為無法使用。
  - **標題**：`#` 輸出成 `<h3>`，依序降級，`####` 以下都輸出成 `<h6>`。每個標題另加 `md-h1` 到 `md-h6` class，CSS 依這個 class 決定字級。
  - **表格**：包在 `<div class="table-scroll">` 中。
- 測試：選擇順序、`../` 越界、指向被排除物件、`javascript:` 連結、原始 HTML 被跳脫、標題降級。

### 6. `html`

- 共用版型：
  - `<head>` 載入 `/fonts/JimMonoTC.css`、`/assets/theme.css`、`/favicon.svg`。
  - 頁面開頭內嵌 5 個 SVG `<symbol>`。
  - 頂部列顯示 Logo 與 `SYNCED` 時間。
  - 只有 `FOOTER_HTML` 有值時，才原樣輸出頁尾。
- 分享頁：標題區塊、統計列、選用的 `Download all`、檔案樹（`<details open>`）、選用的 README 面板。
- 空目錄、`404`、通用錯誤頁的文字與 `<title>` 依 UI 規格第 7 節。
- 所有動態文字都經過 HTML 跳脫，只有 `FOOTER_HTML` 例外。
- 測試：特殊檔名（`<`、`"`、`&`、中文）正確跳脫；ZIP 開關與空目錄時不輸出按鈕；`FOOTER_HTML` 未設定時沒有 `<footer>`；頁面沒有 `<script>`。

### 7. 樣式與字型

- `public/assets/theme.css`：依 UI 規格實作所有 token、元件、互動狀態、響應式與 `prefers-reduced-motion`。Chakra Petch 的 `@font-face` 指向 `/fonts/`。
- `public/favicon.svg`：Logo 圖形符號。
- `scripts/build-fonts.mjs`：
  1. 下載 `JimMonoTC-0.4.0-web.zip`，比對腳本中寫死的 SHA-256 值，不符就以非零狀態結束。
  2. 解壓到 `public/fonts/`。
  3. 從 `node_modules/@fontsource/chakra-petch` 複製 latin 600 和 700 的 `woff2`。
  4. 複製兩套字型的授權文字到 `public/fonts/`。
- SHA-256 值在這個任務中下載一次後計算並寫入腳本。

### 8. 分享頁路由

- `functions/share/[[path]].ts` 的處理順序：
  1. 用 `paths` 驗證網址，不合法就回 `404`。
  2. 讀取規則並確認分享根目錄授權，不通過就回 `404`。
  3. 列舉檔案並建立樹狀結構。
  4. 讀取並渲染 README。
  5. 輸出 HTML。
- 回應標頭：`Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`。
- R2 錯誤或其他例外：記錄到 `console.error`，回傳通用錯誤頁（`500`），內容不包含錯誤細節。
- 測試：用假 Bucket 直接呼叫 handler，涵蓋授權、未授權子目錄、規則檔遺失、R2 錯誤。

### 9. ZIP 端點

- `functions/api/share-zip.ts`：ZIP 開關沒有啟用時回 `404`。其餘授權與列舉流程和分享頁共用同一組模組。
- 在送出回應前完成授權與列舉。之後用 `client-zip` 逐檔讀取 R2 物件，串流輸出。
- ZIP 內的路徑以分享根目錄為基準，包含 README。
- 串流途中讀取失敗時，記錄錯誤並中止串流，不讓瀏覽器收到看似完整的 ZIP。
- 回應標頭：`Content-Disposition: attachment; filename="<最後一段>.zip"`，檔名經過 RFC 5987 編碼。
- 測試：用 `unzip -v` 或 JS 解析確認每個項目都是 method 0、路徑正確、沒有被排除的檔案；另外測試串流途中物件消失的情況。

### 10. 整體驗證與部署說明

- 用 `wrangler pages dev` 搭配本機 R2，建立以下測試資料：多層目錄、中文檔名、README、排除目錄。
- 用預裝的 Playwright 檢查 UI 規格第 13 節：
  - 360、768、1280 寬度下沒有水平捲動。
  - 計算字級不小於 16px。
  - 停用 JavaScript 時仍可展開和收合。
  - 鍵盤焦點外框可見。
  - 頁面沒有任何外部網域請求。
- 在 `README.md` 寫部署步驟：
  - 建立 Pages 專案，建置指令為 `npm run build`，輸出目錄為 `public`。
  - 綁定 R2 與設定環境變數。
  - 規則檔範例。
- Workers Free 的 CPU 實測（規格第 7.1 節）需要在正式環境進行，列為部署後的手動檢查項目。
