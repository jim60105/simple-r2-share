# Simple R2 Share：管理頁畫面與功能設計規格

**日期：** 2026-10-28  
**狀態：** 待審閱  
**相關規格：** [規則編輯器與短網址設計規格](2026-10-28-rules-editor-short-url-design.md)、[分享頁 UI 主題設計規格](2026-10-27-ui-theme-design.md)  
**參考原型：** [管理頁畫面原型](../prototypes/2026-10-28-admin-ui.html)（靜態畫面，以 IBM Plex Mono 代替 Jim Mono TC；與本規格不同時以本規格為準）

## 1. 目的與範圍

本規格定義 `/admin/` 管理頁的畫面、操作流程、管理 API 與前端建置方式。規則編輯器規格中的短網址演算法、公開路由 `/s/<token>/`、ZIP 端點與 Access 保護範圍維持不變；該規格第 4 節的管理頁描述與 `GET /api/admin/shares` 由本規格取代。

管理頁只給管理員使用，用來決定哪些資料夾可以分享，以及複製分享資料夾的短網址。介面文字只用英文，視覺沿用 Tactical HUD 主題。

## 2. 已確認的決定

- 前端不提供規則檔的純文字編輯，改用結構化的**資料夾樹**。每個資料夾有四種規則狀態，以圖示按鈕切換。
- 規則檔由管理頁全權管理，依固定格式輸出。編輯器無法表達的行（glob、檔案層級規則、會因順序改變結果的行）在頁面上警告，下次存檔時移除。
- 所有尚未存檔的變更直接標示在樹上：規則欄以顏色區分「變更前」與「變更後」，資料夾欄每列只有一行。
- 按下 `SAVE` 直接寫入，不跳確認對話框；收合節點以標籤顯示內部的變更數。
- 短網址只在樹上提供，**點擊複製時才在前端計算**，不做批次編碼，不提供分享清單或規則摘要面板。
- 規則指向 Bucket 中不存在的資料夾時，以「幽靈節點」顯示在樹上，可以照常修改。
- 前端以 TypeScript 撰寫，由 esbuild 打包，與伺服器共用 `src/rules.ts`、`src/paths.ts`、`src/short-url.ts`。
- 頂部列顯示 Access 登入的信箱與 `Sign out`。不記錄最後存檔者。
- 複製成功後顯示 toast，5 秒後自動消失。
- 支援的寬度與分享頁相同：360px、768px、1280px，以 560px 為窄螢幕斷點。

## 3. 規則檔與編輯器狀態

### 3.1 四種規則狀態

每個資料夾路徑最多對應一行規則。路徑 `P` 為不含頭尾斜線的 Bucket 相對目錄，例如 `releases/project-b`。

| 狀態 | 介面名稱 | 輸出的規則行 | 意義（依規則語意） |
| --- | --- | --- | --- |
| 無規則 | `Inherit` | 不輸出 | 由祖先規則決定 |
| 分享 | `Share` | `P/` | `P` 本身是分享根目錄 |
| 分享含子資料夾 | `Share + subfolders` | `P/**` | `P` 與未排除的後代目錄各自是分享根目錄 |
| 排除 | `Exclude` | `!P/` | `P` 與其後代全部排除 |

Bucket 根目錄本身不能是分享根目錄，樹上沒有根節點列，最上層直接列出第一層資料夾。

### 3.2 讀取規則檔：支援行與不支援行

管理頁以 `parseRules()` 解析規則原文，逐條判斷能否對應到第 3.1 節的狀態。符合以下全部條件的行為**支援行**：

- 規則本體的每個區段都是字面名稱，不含 `*`、`?`、`[...]` 等萬用字元，跳脫字元允許。
- 形式為 `P/`（分享）、`P/**`（分享含子資料夾）、`!P/` 或 `!P/**`（兩者都視為排除）。開頭可以有一個 `/`。
- 同一路徑先前沒有出現過，而且先前出現的支援行都不是它的後代。後一條件確保依祖先在前的順序重新輸出時，「最後符合的規則優先」的結果不變。

其餘規則行都是**不支援行**，例如 `**/*.tmp`、`releases/v[0-9]*/`、沒有結尾 `/` 的 `releases/a`、重複或順序顛倒的路徑。空行與註解行不列為不支援行，但存檔時一律不保留，只會重新寫入第 3.3 節的固定標頭。

`src/rules.ts` 需要對外提供兩項能力，供前端判斷與計算：

- 從已解析的 `ShareRule` 取得「全為字面名稱的路徑區段」，含萬用字元時回傳 `null`。
- `Rules.isDirExcluded(segments)`：目錄本身或任一祖先的最後符合規則為排除時回傳 `true`，與 `isExcluded()` 的祖先判斷共用同一份快取。

### 3.3 輸出格式

存檔時，管理頁把所有非 `Inherit` 的狀態依下列格式輸出成 UTF-8 文字，每行以 `\n` 結尾：

```gitignore
# Managed by the Simple R2 Share admin page. Comments and unsupported lines are removed on save.
releases/project-a/
releases/project-b/**
!releases/project-b/private/
!tmp/
```

- 第一行固定為上述註解。
- 規則依路徑區段逐段比較排序，比較時使用 UTF-16 code unit 順序，不依語系。這樣祖先一定排在後代之前，而且同一份狀態永遠產生同一份文字。
- 每個區段中的 `\`、`*`、`?`、`[`、`]`、`!`、`#` 與空白字元一律加上 `\` 跳脫，避免資料夾名稱被解讀成萬用字元或註解。
- 沒有任何規則時只輸出標頭行，代表不分享任何資料夾。
- 輸出結果必須再經過 `parseRules()` 驗證；驗證失敗屬於程式錯誤，不送出 `PUT`。

### 3.4 規則檔不存在或無效

- **不存在**：草稿從空白開始，不顯示警告，標題區塊的統計列顯示 `NOT SAVED YET`。
- **無效**（超過 64 KiB、不是 UTF-8，或 `parseRules()` 拒絕）：目前實際上不分享任何資料夾。草稿從空白開始，頁面顯示錯誤橫幅：`The rules file is invalid (<problem>). Nothing is shared right now. Saving replaces the whole file.` 底部操作列出現，管理員可以直接存檔覆蓋。

## 4. 狀態計算

前端同時維護兩份規則：

- **Live**：目前已存檔的規則原文，經 `parseRules()` 解析。包含不支援行，代表此刻公開頁實際套用的結果。
- **Draft**：編輯中的四態狀態表，依第 3.3 節輸出後再經 `parseRules()` 解析。不含不支援行，代表存檔後的結果。

對每個已顯示的資料夾 `segments`，分別以 Live 與 Draft 計算**生效狀態**：

1. `isDirExcluded(segments)` 為真：**已排除**。
2. 否則 `isShareRoot(segments)` 為真：**已分享**。
3. 否則：**未分享**。

由此衍生的顯示資料：

| 項目 | 定義 |
| --- | --- |
| 規則變更 | 某路徑在 Draft 的四態與 Live 支援行的四態不同 |
| 待變更列 | 該列有規則變更，或 Draft 與 Live 的生效狀態不同 |
| `N PENDING CHANGES` | 規則變更的總數，含幽靈節點 |
| 資料夾標籤 `N SHARED` | 位於此資料夾之下（不含自身）、Draft 狀態為 `Share` 或 `Share + subfolders` 的路徑數 |
| 資料夾標籤 `N PENDING` | 位於此資料夾之下（不含自身）的規則變更數 |

所有計算只依賴規則與已載入的資料夾名稱，不需要伺服器參與。`parseRules()` 每次編輯重新執行一次；規則檔上限 64 KiB，這個成本在瀏覽器中可以忽略。

## 5. 管理 API

所有管理 API 都經過第 9 節的 Access 驗證，回應一律設定 `Cache-Control: no-store`，錯誤回應為 `{"error": "<code>"}` 形式的 JSON，不透露內部路徑或物件鍵。

### 5.1 `GET /api/admin/rules`

```json
{
  "exists": true,
  "text": "# Managed by ...\nreleases/project-a/\n",
  "etag": "\"a1b2c3\"",
  "savedAt": "2026-10-28T14:02:11Z",
  "user": { "email": "admin@example.com" },
  "brandName": "SIMPLE R2 SHARE",
  "rulesKey": ".r2-share-rules"
}
```

- `savedAt` 取自 R2 物件的 `uploaded` 時間。規則檔不存在時 `exists` 為 `false`，`text` 為空字串，`etag` 與 `savedAt` 為 `null`。
- 規則檔超過 64 KiB 或不是 UTF-8 時，`text` 為空字串並附上 `invalid: "<problem>"`，前端依第 3.4 節處理。
- `user.email` 取自已驗證 JWT 的 `email` 欄位，沒有這個欄位時為 `null`。
- 管理頁是靜態檔，讀不到部署設定，所以回應另外帶上 `brandName`（來自 `BRAND_NAME`，未設定時為預設品牌名稱）與 `rulesKey`（來自 `SHARE_RULES_KEY`），分別給頂部列與不支援行橫幅使用。

### 5.2 `PUT /api/admin/rules`

- 請求：`Content-Type: application/json`，內容為 `{"text": "<規則原文>", "etag": "<讀取時的 ETag>" | null}`。`etag` 為 `null` 代表首次建立。
- 行為沿用規則編輯器規格：超過 64 KiB、`parseRules()` 拒絕時回 `400`；以 R2 條件式寫入防止覆蓋他人變更，版本不符回 `409`。
- 成功回 `200`，內容為 `{"etag": "...", "savedAt": "..."}`。
- 規則檔仍然只能寫入 `SHARE_RULES_KEY` 這一個物件。

### 5.3 `GET /api/admin/folders?prefix=<dir/>&cursor=<cursor>`

- 列出某一層的子資料夾。`prefix` 為空字串（第一層）或以 `/` 結尾的合法目錄路徑，經 `src/paths.ts` 驗證，不合法回 `400`。
- 以 `bucket.list({ prefix, delimiter: "/", limit: 1000, cursor })` 取得 `delimitedPrefixes`，轉成資料夾名稱，只保留通過 `isSafeKey()` 的名稱。這一層的檔案物件不回傳。
- 回應：`{"folders": ["project-a", "project-b"], "cursor": "<下一頁>" | null}`，名稱不排序，由前端排序。
- 每次請求只做一次 R2 列舉，不做編碼或規則計算，CPU 用量固定且很小。

### 5.4 刪除的 API

原規格的 `GET /api/admin/shares`（掃描物件鍵、批次產生短網址）刪除，不保留相容路由。短網址改由前端計算。

## 6. 畫面

整頁沿用分享頁的單欄版面，內容區最大寬度 960px，載入 `/fonts/JimMonoTC.css`、`/assets/theme.css` 與 `/admin/admin.css`。由上而下依序為頂部列、標題區塊、警告與錯誤橫幅、FOLDERS 面板，以及只在需要時出現的底部操作列與 toast。

### 6.1 頂部列

- 左側：Logo 圖形符號、品牌名稱（沿用 `BRAND_NAME`），以及一個 `ADMIN` 外框標籤，使用 `--accent` 色。
- 右側：`user.email`（`--muted` 色），接著是連到 `/cdn-cgi/access/logout` 的 `Sign out` 連結。沒有信箱時只顯示 `Sign out`。

### 6.2 標題區塊

- 標題 `Share rules`（`<h1>`），樣式與分享頁標題相同。
- 統計列依 Live 支援行計算：`3 SHARED · 1 EXCLUDED · SAVED 2026-10-28 14:02 UTC`。`SHARED` 是 `Share` 與 `Share + subfolders` 規則的數量，`EXCLUDED` 是 `Exclude` 規則的數量。規則檔不存在時，時間部分改為 `NOT SAVED YET`。

### 6.3 警告與錯誤橫幅

位於標題區塊與 FOLDERS 面板之間，可以同時出現多個。

| 橫幅 | 出現條件 | 樣式 |
| --- | --- | --- |
| 不支援行 | Live 有不支援行 | `--pending` 外框。標題 `N LINES IN <規則檔名> ARE NOT SUPPORTED BY THE EDITOR`，說明 `They still apply now, and will be removed on the next save. Their effect is already included in the states below.`，下方以程式碼區塊列出行號與原文 |
| 規則檔無效 | 第 3.4 節 | `--danger` 外框 |
| 存檔或載入錯誤 | 第 7.6 節 | `--danger` 外框，附 `RELOAD` 或 `TRY AGAIN` 按鈕 |

窄螢幕的不支援行橫幅改用短標題 `N UNSUPPORTED LINES` 與短說明 `Still applied now; removed on the next save.`。

### 6.4 FOLDERS 面板

面板沿用分享頁的斜切角面板。標頭第一行是 `FOLDERS`（`<h2>`）、`RULE` 與 `LINK` 三個欄名；第二行是圖例，依序說明四個規則圖示，以及三種顏色：

| 圖例 | 外觀 | 意義 |
| --- | --- | --- |
| `Live` | `--accent` 實心底 | 已存檔、這次沒有變更的狀態 |
| `Before` | 2px `--accent` 內框，透明底 | 已存檔、這次會被改掉的狀態 |
| `After` | `--pending` 實心底 | 存檔後的新狀態 |

窄螢幕不顯示欄名，只保留 `FOLDERS` 與圖例，圖例自動換行。

### 6.5 資料夾列

寬螢幕每列一行，分成三欄：`minmax(0, 1fr)` 的資料夾欄、規則欄、連結欄，最小高度 56px。

**資料夾欄**只有一行，不換行：

- 展開箭頭、資料夾圖示、名稱，依序排列。名稱過長時以 `…` 截斷，並以 `title` 顯示完整路徑。
- 資料夾圖示的顏色表示 Draft 的生效狀態：已分享為 `--accent`，已排除為 `--danger`，未分享為 `--muted`。
- 名稱後面可以接標籤：`N SHARED`（`--accent` 外框）、`N PENDING`（`--pending` 外框）、`NOT IN BUCKET`（`--muted` 外框）。窄螢幕改成精簡形式：分享圖示加數字、方塊加數字、`MISSING`。
- 子層以 1px `--line` 直線表示層級，寬螢幕每層縮排 22px，窄螢幕 12px，與分享頁一致。

**規則欄**是四個圖示按鈕組成的群組，每顆 44 × 40px，依序為：

| 狀態 | 圖示 |
| --- | --- |
| `Inherit` | 虛線圓 |
| `Share` | 方框加向右上的箭頭 |
| `Share + subfolders` | 樹狀分支加向右上的箭頭 |
| `Exclude` | 圓加斜線 |

按鈕依第 6.4 節的圖例上色：沒有變更時，目前狀態為 `Live`；有變更時，原狀態為 `Before`，新狀態為 `After`。祖先在 Draft 中已排除時，`Share` 與 `Share + subfolders` 停用，`title` 顯示 `Excluded by <祖先路徑>`。

**連結欄**是一顆 44 × 44px 的複製圖示按鈕：

- Live 中 `isShareRoot()` 為真：`--accent` 外框，可以點擊，`title` 為 `Copy short URL`。
- Draft 將它變成分享根目錄但尚未存檔：灰色虛線外框，停用，`title` 為 `Short URL available after save`。
- 其他情況不顯示按鈕。

**待變更列**整列加上 `--pending-bg` 底色。

**幽靈節點**：規則中位於這一層、但 R2 列舉沒有回傳的路徑。名稱使用 `--muted` 色加虛線底線，資料夾圖示為 `--muted`，並加上 `NOT IN BUCKET` 標籤。中間層不存在時同樣補上幽靈節點，讓管理員可以展開到目標路徑。幽靈節點的規則按鈕照常可用，切回 `Inherit` 就等於刪除這條規則；存檔後沒有任何規則指向它時，它就從樹上消失。

**排序**：每一層依名稱排序，使用 `Intl.Collator("zh-Hant-TW", { numeric: true })`，幽靈節點與一般節點一起排序。

### 6.6 底部操作列

- 有規則變更、Live 有不支援行，或規則檔無效時才出現，固定在視窗底部，上緣 1px `--pending` 線。
- 左側：`N PENDING CHANGES`（`--pending` 粗體）。有不支援行時接 `· N UNSUPPORTED LINES WILL BE REMOVED`。
- 右側：`DISCARD`（透明底、`--line` 外框）與 `SAVE`（`--accent` 實心）。
- 頁面底部預留操作列的高度，避免它擋住最後一列。

### 6.7 Toast

- 一次只顯示一個，新訊息會取代舊訊息。寬螢幕位於右下角、操作列上方，最大寬度 560px；窄螢幕左右各留 16px、撐滿寬度。
- 樣式：`--surface-hero` 底、1px `--accent` 外框、左側一個 `--ok` 色勾號，標題粗體、內容 `--muted` 色。
- 成功訊息 5 秒後自動消失：`SHORT URL COPIED`（內容為完整短網址，過長時以 `…` 截斷）與 `RULES SAVED`。
- 複製失敗時顯示 `COPY FAILED`，內容為完整短網址，文字可以選取，並附一個關閉按鈕；失敗 toast 不會自動消失，讓管理員有時間手動複製。

### 6.8 新增的設計變數

寫在 `/admin/admin.css` 的 `:root`，其餘沿用 `/assets/theme.css`。

| 變數 | 值 | 用途 |
| --- | --- | --- |
| `--pending` | `#FFC24A` | `After` 按鈕、待變更標籤、不支援行橫幅、操作列 |
| `--pending-ink` | `#1A1204` | 疊在 `--pending` 上的圖示 |
| `--pending-bg` | `#FFC24A0D` | 待變更列底色 |

`--pending` 與 `--focus` 目前同值。焦點外框畫在元素外側 2px，仍然和黃色按鈕的底色分得開；若實際使用時難以分辨，只需要調整 `--pending` 的值。

## 7. 互動流程

### 7.1 載入

1. 同時呼叫 `GET /api/admin/rules` 與 `GET /api/admin/folders?prefix=`。
2. 解析 Live、建立 Draft（等於 Live 的支援行），畫出第一層資料夾與幽靈節點。
3. 載入期間面板內顯示 `Loading…`。任一請求失敗時改顯示錯誤橫幅，附 `TRY AGAIN`。

### 7.2 展開與分頁

- 點擊箭頭展開時，才呼叫 `GET /api/admin/folders?prefix=<路徑>/` 載入下一層；同一層只載入一次，收合不會清掉已載入的資料。
- 回應帶 `cursor` 時，這一層最後顯示一列 `LOAD MORE`，點擊後載入下一頁並合併。
- 規則路徑的子節點在列舉期間就先顯示，方便操作；`NOT IN BUCKET` 標籤要等這一層的最後一頁載入完成才判定。
- 某一層載入失敗時，在該層顯示一列 `Couldn't load folders` 與 `TRY AGAIN`，不影響其他層。

### 7.3 切換規則

點擊規則按鈕只修改 Draft，接著重新計算第 4 節的所有顯示資料，並更新樹、標籤與底部操作列。沒有任何網路請求。

### 7.4 複製短網址

1. 以 `src/short-url.ts` 的 `encode(path)` 在前端計算 token，組成 `<location.origin>/s/<token>/`。
2. 以 `navigator.clipboard.writeText()` 寫入剪貼簿，成功後顯示 `SHORT URL COPIED` toast。
3. 寫入失敗時顯示第 6.7 節的 `COPY FAILED` toast。

### 7.5 存檔與捨棄

- `SAVE`：依第 3.3 節輸出規則原文並送出 `PUT`。等待期間 `SAVE` 改為 `SAVING…`，兩顆按鈕與所有規則按鈕暫時停用。成功後以 Draft 取代 Live，更新 ETag 與存檔時間，顯示 `RULES SAVED` toast。
- `DISCARD`：直接把 Draft 還原成 Live，不跳確認框。
- 有規則變更時，關閉分頁或重新整理會觸發 `beforeunload` 提示。

### 7.6 錯誤處理

| 狀況 | 畫面 |
| --- | --- |
| `PUT` 回 `409` | 橫幅 `The rules were changed somewhere else. Reload to see the latest rules; your unsaved changes will be lost.`，附 `RELOAD`。Draft 保留在畫面上，直到管理員重新載入 |
| 任何 API 回 `403` | 橫幅 `Your session has expired or you don't have access. Reload to sign in again.`，附 `RELOAD` |
| `PUT` 回 `400`、`413` 或 `500` | 橫幅 `Couldn't save the rules. Try again.`，Draft 保留，可以再次存檔 |
| 網路中斷 | 與 `500` 相同 |

## 8. 響應式與無障礙

### 8.1 響應式

| 寬度 | 變化 |
| --- | --- |
| ≥ 561px | 資料夾列為單行三欄 |
| ≤ 560px | 每列分兩行：第一行為資料夾欄與複製按鈕，第二行為規則按鈕群組，縮排對齊名稱；欄名隱藏；標籤改為精簡形式；底部操作列改成兩行，兩顆按鈕各佔一半寬度 |

- 任何寬度都不可以出現水平捲動。
- 最小字級 16px，所有可點擊元素至少 44px 高，側邊留白使用 `max(16px, env(safe-area-inset-*))`，都與分享頁相同。

### 8.2 無障礙

- 符合 WCAG 2.1 AA，文字對比至少 4.5:1，鍵盤焦點以 `--focus` 外框顯示。
- 規則按鈕群組使用原生 `<input type="radio">`，包在帶有視覺隱藏 `<legend>` 的 `<fieldset>` 中，例如 `Rule for releases/project-b`。每個選項的 `<label>` 內含 SVG（`aria-hidden="true"`）與視覺隱藏的文字名稱。如此每組只佔一個 Tab 停駐點，方向鍵即可切換，不需要自寫鍵盤處理。
- 「變更前」以外框、「變更後」以實心底區分，不只靠顏色。待變更列另外附上視覺隱藏文字，例如 `Pending: Inherit → Share + subfolders`。
- 展開按鈕使用 `<button aria-expanded>`，標籤為 `Expand <name>` 或 `Collapse <name>`。樹以巢狀 `<ul>` 呈現。
- 複製按鈕與停用的複製按鈕都有 `aria-label`。
- Toast 容器設定 `role="status"` 與 `aria-live="polite"`，不搶走焦點。
- `prefers-reduced-motion: reduce` 時取消所有過渡效果。

## 9. Access 驗證

正式網域、`pages.dev` 與預覽網域都必須以 Cloudflare Zero Trust 的 Self-hosted 應用程式保護 `/admin`、`/admin/*` 與 `/api/admin/*`。通過驗證的請求會帶有 `Cf-Access-Jwt-Assertion` header，內容為 RS256 簽章的 JWT。

不使用 `@cloudflare/pages-plugin-cloudflare-access`。該套件在 `iss`、`aud`、`exp` 欄位不存在時會跳過檢查，驗證失敗時回 `302` 而非 `403`，而且每次請求都重新抓取公鑰。改為自行實作 `functions/api/admin/_middleware.ts`：

1. 讀取 `ACCESS_TEAM_DOMAIN`（例如 `https://myteam.cloudflareaccess.com`）與 `ACCESS_AUD`。任何一個未設定時，所有管理 API 回 `403`。
2. 取出 `Cf-Access-Jwt-Assertion`，缺少或格式錯誤時回 `403`。
3. header 的 `alg` 必須是 `RS256`，並以 `kid` 從 `<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` 找到對應金鑰。公鑰以 Cache API 快取一小時；遇到不認得的 `kid` 時略過快取重新抓取一次。
4. 驗證簽章。`iss` 必須等於 `ACCESS_TEAM_DOMAIN`，`aud` 必須包含 `ACCESS_AUD`，`exp` 必須存在且尚未過期；有 `nbf` 時必須已經生效。任何一項不符都回 `403`。
5. 驗證通過後，把 `email`（可能不存在）放進 `context.data`，交給後續處理函式。
6. `PUT` 另外要求 `Origin` 等於請求網址的 origin，且 `Content-Type` 為 `application/json`，否則回 `403`。

`Sign out` 連到同源的 `/cdn-cgi/access/logout`。Access 身分只用來判斷請求能否使用伺服器的 R2 binding，不會轉換成任何 R2 權限；實際寫入一律由 Pages 的 R2 binding 執行，而且只能寫入規則檔。

新增部署設定：

| 設定 | 用途 | 預設 |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | Access team domain，用來取得公鑰與比對 `iss` | 未設定時拒絕所有管理 API |
| `ACCESS_AUD` | 管理頁 Access 應用程式的 AUD tag | 未設定時拒絕所有管理 API |

## 10. 前端建置與檔案結構

| 檔案 | 說明 |
| --- | --- |
| `public/admin/index.html` | 靜態頁面骨架，載入字型、`/assets/theme.css`、`/admin/admin.css` 與 `/admin/app.js` |
| `public/admin/admin.css` | 管理頁專用樣式與第 6.8 節的設計變數 |
| `src/admin/*.ts` | 前端程式：API 呼叫、狀態計算、規則輸出、畫面更新 |
| `public/admin/app.js` | 由 esbuild 產生，列入 `.gitignore`，與 `public/fonts/` 相同 |
| `scripts/build-admin.mjs` | 以 esbuild 把 `src/admin/main.ts` 打包成單一 ES module |

- `esbuild` 以固定版本加入 devDependencies。`npm run build` 依序執行字型建置與管理頁打包。沒有開發伺服器，也不做熱更新。
- 前端與伺服器共用的模組（`src/rules.ts`、`src/paths.ts`、`src/short-url.ts`）不得使用 Workers 專用的全域物件。`loadRules()` 與 `RulesReadError` 依賴 `R2Bucket`，移到新的 `src/rules-store.ts`，`src/rules.ts` 只保留純解析與比對。
- 新增 `tsconfig.admin.json`（`lib` 含 `DOM`，涵蓋 `src/admin/**` 與共用模組），主要 `tsconfig.json` 排除 `src/admin/**`。`npm run typecheck` 兩份都要檢查。
- 規則比對的 picomatch 已確認可以打包到瀏覽器：`src/rules.ts` 打包壓縮後約 30 KB，gzip 後約 11 KB。
- 畫面以 `document.createElement` 與 `textContent` 建立，不使用 `innerHTML` 插入任何來自 R2 的字串。資料夾名稱一律當成純文字。
- 動態縮排等數值以 CSSOM 的 `style.setProperty()` 設定，不在 HTML 中寫 `style` 屬性，以符合下方的 CSP。

`public/_headers` 為 `/admin/*` 加上：

```text
/admin/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Cache-Control: no-cache
```

公開分享頁的 CSP 不變。

## 11. 測試與驗收

### 11.1 自動測試

- **規則對應**：第 3.2 節每種支援形式、`!P/**` 視為排除、glob 與沒有結尾 `/` 的行列為不支援、重複路徑與後代在祖先之前的順序列為不支援、註解不列入。
- **規則輸出**：排序固定、祖先在前、特殊字元跳脫後可以由 `parseRules()` 還原成同一組路徑、中文與空白名稱、空草稿只輸出標頭；任何狀態表經「輸出 → 解析 → 對應」後都回到原狀態。
- **狀態計算**：繼承分享、祖先排除壓過子層分享、不支援行只影響 Live、`PENDING` 與 `SHARED` 標籤計數、幽靈節點判定。
- **`isDirExcluded()`** 與既有 `isExcluded()` 的祖先判斷結果一致。
- **API**：`folders` 的前綴驗證、`delimitedPrefixes` 轉換、不安全名稱過濾與游標分頁；`rules` 的 `savedAt`、`user.email`、無效規則檔回應。
- **Access middleware**：缺少 header、`alg` 不是 RS256、未知 `kid` 觸發重新抓取、簽章錯誤、`iss` 或 `aud` 不符、缺少 `exp`、已過期、`nbf` 未到、缺少設定、`PUT` 的 `Origin` 或 `Content-Type` 錯誤，都回 `403`。

### 11.2 手動驗收

- 360px、768px、1280px 下都沒有水平捲動，資料夾欄每列只有一行，長名稱以 `…` 截斷。
- 只用鍵盤可以展開資料夾、切換規則、複製短網址、存檔與捨棄。
- 切換規則後，按鈕顏色、資料夾圖示顏色、標籤與底部計數立即更新；存檔後公開頁 `/s/<token>/` 的結果與樹上的生效狀態一致。
- 從規則檔不存在、含不支援行、無效三種狀態開始，存檔後的規則檔都符合第 3.3 節的格式。
- 兩個分頁同時編輯時，後存檔的一方看到 `409` 橫幅。
- 複製的短網址可以開啟對應的分享頁；toast 5 秒後消失。
- 點擊 `Sign out` 後重新進入 `/admin/` 會被要求重新登入。
- 頁面在瀏覽器主控台沒有任何 CSP 違規訊息。

## 12. 範圍外

- 純文字規則編輯、glob 規則、檔案層級規則與規則註解。
- 分享清單、規則摘要面板、搜尋與篩選。
- 存檔確認對話框、復原（undo）與變更歷史。
- 記錄最後存檔者或任何稽核紀錄。
- 以 Access 身分換取 R2 權限，或以 R2 臨時憑證、S3 API 寫入。
- 管理頁的亮色主題與多語系介面。
