# 分享頁 UI 主題設計規格

**日期：** 2026-10-27  
**狀態：** 已完成逐節設計確認，待審閱正式規格  
**相關規格：** [R2 資料夾分享頁設計規格](2026-10-27-r2-folder-sharing-design.md)  
**參考原型：** [三個主題方向的設計原型](../prototypes/2026-10-27-ui-theme-directions.html)（選定 A；原型早於部分決定，例如麵包屑、字體與字級，與本規格不同時以本規格為準）

## 1. 目的與範圍

本規格定義 Simple R2 Share 所有對外頁面的視覺主題與介面行為，包括分享頁、空目錄狀態、`404` 與通用錯誤頁。功能、授權、路徑安全與 ZIP 行為以相關規格為準；本規格只決定這些功能如何呈現。

主題名稱為 **Tactical HUD**，風格為未來科技電競，同時維持專業感。電競感主要來自形狀和線條，例如斜切角面板、角落括號、細網格與單一青色強調，不使用霓虹發光、掃描線、故障效果或載入動畫。

本規格只提供暗色主題，不提供亮色主題或主題切換，也沒有使用者設定頁。

## 2. 已確認的決定

- 獨立品牌，不配合部落格。品牌名稱固定為 `SIMPLE R2 SHARE`，Logo 是 Chakra Petch 文字標誌搭配內嵌 SVG 圖形符號，不另外提供圖檔。
- 介面文字只用英文。檔名、目錄名稱和 README 這類內容可能是正體中文或英文。
- 字體分成兩層：
  - **裝飾性字體**：Chakra Petch，只用在 Logo、分享根目錄標題、按鈕與錯誤頁大字。
  - **內容字體**：Jim Mono TC，用在其餘所有文字。
- 所有字型都自行託管，不依賴 Google Fonts 或其他第三方字型服務。
- 全站最小字級為 16px。
- 不顯示麵包屑。分享頁沒有可以返回的上層頁面，路徑也不代表可以瀏覽的層級。
- 頁尾為單行文字，內容來自部署設定 `FOOTER_HTML`。
- 樹狀清單使用原生 `<details>` / `<summary>`，不需要任何前端 JavaScript。

## 3. 設計變數（Design Tokens）

所有顏色、字體、字級與間距都以 CSS 自訂屬性定義在 `:root`，元件只引用設計變數，不寫死數值。`:root` 設定 `color-scheme: dark`，讓捲軸和原生控制項也呈暗色。

### 3.1 色彩

| 變數 | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#070B10` | 頁面底色 |
| `--grid` | `#2FD6E808` | 頁面底色上的 32px 網格線 |
| `--surface` | `#0C131A` | 檔案面板、README 面板 |
| `--surface-hero` | `#0A1118` | 標題區塊 |
| `--line` | `#1B2935` | 邊框、分隔線、樹狀縮排虛線 |
| `--fg` | `#DCE6EC` | 主要文字 |
| `--muted` | `#84A0B0` | 次要文字、檔案大小、統計列、頁尾 |
| `--accent` | `#2FD6E8` | 唯一的品牌強調色，用於 Logo 符號、資料夾圖示、箭頭、按鈕、角落括號、程式碼區塊左線 |
| `--accent-ink` | `#04121A` | 疊在 `--accent` 底色上的文字 |
| `--hover` | `#2FD6E80F` | 列表 hover 底色，約 6% 青色 |
| `--link` | `#6FE4F0` | README 與頁尾的連結 |
| `--focus` | `#FFC24A` | 鍵盤焦點外框；刻意和 `--accent` 不同色 |
| `--ok` | `#3EE08F` | 頂部列狀態燈號 |
| `--danger` | `#FF5C6C` | 通用錯誤頁的大字 |
| `--code-bg` | `#0F1A23` | 行內程式碼與程式碼區塊底色 |

`--ok` 與 `--danger` 是語意色，不屬於品牌色。所有文字和背景的組合都必須達到 WCAG 2.1 AA 的 4.5:1 對比。

### 3.2 字體

| 變數 | 字體堆疊 | 用途 |
| --- | --- | --- |
| `--font-display` | `"Chakra Petch", "Jim Mono TC", monospace` | Logo 字樣、分享根目錄標題、按鈕、錯誤頁大字 |
| `--font-content` | `"Jim Mono TC", monospace` | 檔名、README、統計列、面板標頭、檔案大小、頁尾、程式碼 |

- Chakra Petch 只有拉丁字元。分享根目錄標題若含中文，中文會自動改用 Jim Mono TC Bold 顯示。
- 分享根目錄標題**不做大小寫轉換**，保留目錄原本的名稱。只有介面固定文字（例如面板標頭 `FILES`）以大寫書寫。
- Jim Mono TC 的連字只在 `pre`、`code` 內開啟（`font-variant-ligatures: contextual`）。其餘地方一律設為 `font-variant-ligatures: none`，避免檔名或內文中的 `www`、`->`、`!=` 被顯示成連字。
- Jim Mono TC 本身等寬，數字欄自然對齊，不需要另外設定 `tabular-nums`。

### 3.3 字級

全站最小字級 16px，不允許更小的字。

| 變數 | 值 | 用途 |
| --- | --- | --- |
| `--text-base` | `16px` | 面板標頭、統計列、檔名、檔案大小、按鈕、程式碼、頁尾、同步時間 |
| `--text-body` | `18px` | README 內文，行高 1.8 |
| `--text-lg` | `20px` | Logo 字樣、README 的 `###` 至 `######` 標題 |
| `--text-xl` | `24px` | README 的 `##` 標題、錯誤頁標題 |
| `--text-2xl` | `28px` | README 的 `#` 標題 |
| `--text-title` | `clamp(32px, 6vw, 48px)` | 分享根目錄標題 |
| `--text-hero` | `clamp(64px, 14vw, 120px)` | 錯誤頁大字 |

面板標頭等大寫標籤使用 `letter-spacing: 0.08em`。

### 3.4 間距與形狀

- 間距以 4px 為基準，`--space-1` 到 `--space-8` 分別是 `4 / 8 / 12 / 16 / 20 / 24 / 32 / 48` px。元件之間的距離以 flex 或 grid 的 `gap` 控制。
- 所有圓角為 0。
- 邊框一律 1px `--line`。
- 面板的左上與右下角為斜切角，`--chamfer-panel` 預設 14px，窄螢幕為 10px。斜切角以偽元素繪製，避免裁掉鍵盤焦點外框。
- 按鈕同樣斜切，`--chamfer-button` 為 10px。
- 標題區塊左上與右下各有一個 14px 的角落括號，線寬 2px，顏色 `--accent`。

## 4. 字型來源與託管

所有字型檔都放在 Pages 靜態資源的 `/fonts/` 下，由 Cloudflare 直接提供，不經過 Functions。

### 4.1 Jim Mono TC

- 來源：[jim60105/JimMonoTC](https://github.com/jim60105/JimMonoTC) GitHub Releases 的 `JimMonoTC-<版本>-web.zip`，目前版本為 `0.4.0`。
- 建置時下載固定版本的 zip，以儲存庫內記錄的 SHA-256 值驗證，驗證失敗就讓建置失敗。
- 解壓後原封不動放到 `/fonts/`，不刪減分片。瀏覽器依 `unicode-range` 只下載頁面實際用到的分片，用不到的群組不會被下載。
- HTML 以 `<link rel="stylesheet" href="/fonts/JimMonoTC.css">` 載入。這個 CSS 預設的字型路徑就是 `/fonts/`，不需要修改。
- 四種樣式全部保留：Regular 和 Bold 用於一般文字與標題，Italic 和 Bold Italic 用於 README 中的強調文字。
- 升級時只需修改版本號和 SHA-256 值。

### 4.2 Chakra Petch

- 只需要拉丁字元的 600 和 700 兩個字重，格式為 `woff2`。
- 以固定版本的套件或檔案取得，版本與取得方式在實作計畫中決定，同樣必須鎖定版本並驗證內容。
- `@font-face` 宣告寫在 `/assets/theme.css`，使用 `font-display: swap`。

### 4.3 授權

兩套字型都採用 SIL Open Font License 1.1。部署內容必須在 `/fonts/licenses/` 下附上 Jim Mono TC 的 `LICENSE` 與 `NOTICE.md`，以及 Chakra Petch 的 OFL 授權文字。

## 5. 版面與元件

整頁為單欄，內容區最大寬度 960px，置中，兩側留白至少 16px。頁面底色為 `--bg`，上面疊一層 32px 間距的 `--grid` 網格線。

由上而下依序為頂部列、標題區塊、檔案面板、README 面板與頁尾。

### 5.1 頂部列

- 左側：內嵌 SVG 圖形符號（`--accent`，22px）加 `SIMPLE R2 SHARE` 字樣（`--font-display`、`--text-lg`、700）。不做成連結，因為沒有首頁可以回去。
- 右側：`--ok` 色的狀態燈號加 `SYNCED <YYYY-MM-DD HH:mm> UTC`，顯示伺服器產生這份頁面的時間，使用 `--muted` 色。
- 窄螢幕時左右兩側自動換行。

### 5.2 標題區塊

- 底色 `--surface-hero`，1px `--line` 邊框，左上和右下有角落括號。
- 第一行是分享根目錄名稱，只顯示分享根目錄的**最後一段**，例如分享 `releases/project-a/` 時顯示 `project-a`。使用 `--font-display`、`--text-title`、700，長名稱自動換行。
- 第二行是統計列，用 `--muted` 色，數字用 `--fg` 色加粗，例如 `9 FILES · 3 FOLDERS · 248.6 MB`。
  - 檔案數與資料夾數只計算經過排除規則後實際列出的項目。
  - 總大小為所有列出檔案的大小加總。
- `Download all` 按鈕：`ENABLE_ZIP_DOWNLOAD` 啟用時才輸出。寬螢幕放在右側，與統計列底部對齊；窄螢幕放到統計列下方並靠左。

### 5.3 檔案面板

- 底色 `--surface`，斜切角面板。
- 面板標頭為左 `FILES`、右 `SIZE`，下方以 `--line` 分隔。
- 樹狀結構使用巢狀 `<ul>`。資料夾以 `<details open>` 和 `<summary>` 表示，**預設全部展開**。
- 每一層的排序規則：
  1. 資料夾在前，檔案在後。
  2. 同類項目依名稱排序，使用 `Intl.Collator("zh-Hant-TW", { numeric: true })`，所以 `v2` 會排在 `v10` 前面。
- **資料夾列**：箭頭圖示（展開時旋轉 90°）、`--accent` 資料夾圖示、資料夾名稱，右側顯示直接子項目數量，例如 `3 items`、`1 item`。
- **檔案列**：檔案圖示（`--muted`）、檔名連結、右側檔案大小。
  - 檔名連結直接指向 R2 公開網址，在同一個分頁開啟，不加 `target="_blank"`。
  - 所有檔案使用同一個圖示，不依副檔名區分。
- 子層以左側 1px 虛線 `--line` 表示層級。寬螢幕每層縮排 22px，窄螢幕 12px。
- 長檔名以 `overflow-wrap: anywhere` 換行，不可讓版面變寬。
- R2 沒有真正的空資料夾，資料夾只會因為底下有檔案而出現，所以不需要處理空資料夾列。

### 5.4 README 面板

- 找到 `README.md` 或 `.README.md` 時才輸出這個面板。
- 面板標頭顯示實際使用的檔名，例如 `README.md`。
- 內文使用 `--font-content`、`--text-body`、行高 1.8，最大寬度 `80ch`。
- Markdown 元素樣式：

| 元素 | 樣式 |
| --- | --- |
| 標題 | `--font-content` 粗體，字級依 Markdown 原始層級套用第 3.3 節，不受第 10 節的 HTML 標籤降級影響 |
| 連結 | `--link` 色加底線，底線偏移 3px |
| 行內程式碼 | `--code-bg` 底色，左右內距 6px |
| 程式碼區塊 | `--code-bg` 底色，左側 2px `--accent` 線，開啟連字，水平捲動 |
| 表格 | 包在可水平捲動的容器中，儲存格以 `--line` 分隔 |
| 圖片 | 最大寬度 100% |
| 引言 | 左側 2px `--line` 線，文字用 `--muted` 色 |
| 清單 | 標準縮排，項目間距 `--space-1` |

- **無法使用的連結**：相關規格要求移除的越界或被排除連結，改成一般文字輸出，保留原本的連結文字，套用 `--muted` 色和虛線底線，並加上 `title="Not available in this share"`。不產生任何 `href`。
- **無法使用的圖片**：同樣條件的圖片不輸出 `<img>`。若有替代文字（alt），就以上述「無法使用的連結」樣式顯示替代文字；沒有替代文字時完全不輸出。

### 5.5 頁尾

- 部署設定 `FOOTER_HTML` 有值時才輸出，空字串或未設定時不輸出 `<footer>`。
- 內容**原樣插入 HTML，不跳脫、不過濾**，可以包含連結等標記。
- 樣式：上方 1px `--line` 分隔線、`--text-base`、`--muted` 色，裡面的連結用 `--link` 色。窄螢幕可以自然換行。
- 安全前提：`FOOTER_HTML` 是管理者在部署時輸入的受信任內容，等同程式碼的一部分。實作上**只能**從部署環境變數讀取，不能來自 R2 物件、請求參數或任何外部輸入。

## 6. 互動狀態與動態效果

| 元素 | Hover | 按下 | 鍵盤焦點 |
| --- | --- | --- | --- |
| `Download all` | 底色變成 `--accent`，文字變成 `--accent-ink` | 向下位移 1px | `--focus` 2px 外框，外框間距 2px |
| 檔案列 | 底色 `--hover`，檔名變成 `--accent` 並加底線 | 無變化 | 同上 |
| 資料夾列 | 底色 `--hover` | 箭頭旋轉 90° | 同上 |
| README 與頁尾連結 | 底線加粗 | 無變化 | 同上 |

- `Download all` 平時為透明底色、`--accent` 文字與 1px `--accent` 內框。它是樣式化的 `<a>`，連到 ZIP 端點，沒有停用狀態。ZIP 功能關閉時直接不輸出。
- 焦點外框只在 `:focus-visible` 時顯示。
- 動態效果只有兩種：箭頭旋轉和顏色過渡，時間都是 150ms。
- 作業系統或瀏覽器開啟「減少動態效果」時，以 `@media (prefers-reduced-motion: reduce)` 取消所有 `transition` 和 `animation`。

## 7. 特殊狀態與錯誤頁

### 7.1 空目錄

分享目錄合法但沒有任何可列出的檔案時，頁面依下列方式呈現。

- 標題區塊照常顯示，統計列為 `0 FILES · 0 FOLDERS · 0 B`。
- 不輸出 `Download all` 按鈕。
- 檔案面板照常顯示標頭，內文為 `No files in this share yet.`，使用 `--muted` 色。

### 7.2 錯誤頁

錯誤頁使用和分享頁相同的頂部列與頁尾。標題區塊改成以下內容，沒有統計列、按鈕、檔案面板或 README 面板。

| 狀況 | 大字 | 標題 | 說明 |
| --- | --- | --- | --- |
| `404` | `404`，`--accent` 色 | `Share not found` | `This link doesn't point to an active share. Check the address or ask the person who sent it.` |
| 通用錯誤（`500` 等） | `ERROR`，`--danger` 色 | `Something went wrong` | `This share couldn't be loaded right now. Try again in a minute.` |

- 大字使用 `--font-display`、`--text-hero`、700；標題使用 `--font-display`、`--text-xl`；說明使用 `--font-content`、`--text-body`、`--muted` 色。
- `404` 頁不區分「規則不允許」、「目錄不存在」或「規則檔錯誤」，所有情況外觀與文字完全相同。
- 通用錯誤頁不顯示任何內部資訊。

### 7.3 頁面標題

| 頁面 | `<title>` |
| --- | --- |
| 分享頁 | `<分享根目錄最後一段> · SIMPLE R2 SHARE` |
| `404` | `Share not found · SIMPLE R2 SHARE` |
| 通用錯誤 | `Something went wrong · SIMPLE R2 SHARE` |

## 8. 數值格式

- 檔案大小以 1024 為進位，單位為 `B`、`KB`、`MB`、`GB`、`TB`。`B` 不帶小數，其餘保留一位小數，例如 `412 B`、`8.4 KB`、`248.6 MB`。
- 統計列的數量使用單數或複數，例如 `1 FILE`、`2 FILES`、`1 FOLDER`、`3 FOLDERS`。
- 資料夾項目數使用 `1 item`、`3 items`。
- 同步時間格式為 `YYYY-MM-DD HH:mm UTC`，使用 24 小時制。

## 9. 響應式

| 寬度 | 變化 |
| --- | --- |
| ≥ 960px | 內容區固定 960px 寬並置中 |
| 561–959px | 內容區隨視窗伸縮，兩側留白至少 16px |
| ≤ 560px | `Download all` 移到統計列下方；樹狀清單每層縮排 12px；面板內距縮小；斜切角改為 10px |

- 頁面本身任何寬度都不可以水平捲動。只有程式碼區塊與表格可以在自己的容器內水平捲動。
- 側邊留白使用 `max(16px, env(safe-area-inset-left))` 與 `max(16px, env(safe-area-inset-right))`，以避開手機的瀏海和系統列。
- 所有可點擊的列和按鈕，最小高度為 44px。

## 10. 無障礙

- 符合 WCAG 2.1 AA。文字對比至少 4.5:1，鍵盤焦點外框可見，所有操作都能只用鍵盤完成。
- 頁面使用 `<header>`、`<main>`、`<footer>` 地標。
- 標題層級：
  - 分享頁的分享根目錄名稱是 `<h1>`，面板標頭的左側標籤（`FILES`、README 檔名）是 `<h2>`。
  - README 的標題放在 README 面板之下，因此 `#` 輸出為 `<h3>`、`##` 為 `<h4>`、`###` 為 `<h5>`，`####` 以下都輸出為 `<h6>`。
  - 錯誤頁的標題（`Share not found`、`Something went wrong`）是 `<h1>`。大字 `404`、`ERROR` 只是裝飾，設為 `aria-hidden="true"`。
- 圖示一律 `aria-hidden="true"`。資料夾項目數量以可見文字呈現，螢幕閱讀器可以讀到。
- `<html lang="en">` 對應英文介面文字。檔名和 README 的語言無法事先得知，因此不另外標示 `lang`。字體堆疊固定以 Jim Mono TC 顯示中文，中文一律呈現正體字形。

## 11. 靜態資源與輸出

| 資源 | 位置 | 說明 |
| --- | --- | --- |
| 主題樣式 | `/assets/theme.css` | Pages 靜態資源，包含所有設計變數、元件樣式與 Chakra Petch 的 `@font-face` |
| Jim Mono TC | `/fonts/JimMonoTC.css` 與分片 `woff2` | 見第 4.1 節 |
| Chakra Petch | `/fonts/` 下的 `woff2` | 見第 4.2 節 |
| 字型授權 | `/fonts/licenses/` 下的授權文字 | 見第 4.3 節 |
| Favicon | `/favicon.svg` | Logo 圖形符號，`--accent` 色 |
| 圖示 | 內嵌於每份 HTML | Logo、資料夾、檔案、箭頭、下載共 5 個 SVG `<symbol>`，以 `<use>` 引用 |

- 每份 HTML 的 `<head>` 依序載入 `/fonts/JimMonoTC.css` 與 `/assets/theme.css`，不載入任何外部網域的資源。
- 靜態資源由 Pages 直接提供，不計入 Functions 請求額度，也不佔用 Functions 的 CPU 時間。
- HTML 回應依相關規格不做持久快取，靜態資源則可正常快取。
- 頁面不包含任何 `<script>`。

## 12. 部署設定

本規格新增一個部署設定，其餘沿用相關規格第 3 節。

| 設定 | 用途 | 預設 |
| --- | --- | --- |
| `FOOTER_HTML` | 頁尾的單行 HTML，原樣渲染 | 未設定，不顯示頁尾 |

## 13. 驗收條件

- 分享頁、空目錄、`404` 與通用錯誤頁都套用本主題，並且在 360px、768px、1280px 寬度下都沒有水平捲動。
- 頁面完全不從外部網域載入資源，也不包含任何 `<script>`。
- 樹狀清單在停用 JavaScript 的瀏覽器中仍可以展開和收合，而且預設全部展開。
- 排序符合第 5.3 節，資料夾在前，名稱採自然排序，`v2` 排在 `v10` 前面。
- 中文和英文混合的檔名、目錄名稱與 README 都以 Jim Mono TC 正確顯示。分享根目錄標題的中文改用 Jim Mono TC 顯示，而且不轉換大小寫。
- 檔名中的 `www`、`->` 不會顯示成連字，README 程式碼區塊中的連字則正常顯示。
- 頁面中任何文字的計算字級都不小於 16px。
- 所有文字組合達到 4.5:1 對比，以鍵盤 Tab 移動時每個可操作元素都顯示 `--focus` 外框。
- 開啟「減少動態效果」後，箭頭旋轉和顏色過渡都會立即完成，沒有過渡動畫。
- `ENABLE_ZIP_DOWNLOAD` 關閉或目錄為空時不輸出 `Download all`。
- `FOOTER_HTML` 未設定時不輸出 `<footer>`；有值時原樣渲染其中的 HTML。
- README 中無法使用的連結和圖片依第 5.4 節呈現，不產生任何 `href` 或 `src`。
- Jim Mono TC 的 zip 雜湊值不符時，建置失敗。

## 14. 非目標

- 亮色主題、主題切換或任何使用者設定。
- 依副檔名區分的檔案圖示、檔案預覽、縮圖或搜尋。
- 「全部展開」或「全部收合」按鈕。
- 麵包屑或任何上層目錄導覽。
- 多語系介面。
- 頁面動畫、發光、掃描線或其他裝飾性特效。
