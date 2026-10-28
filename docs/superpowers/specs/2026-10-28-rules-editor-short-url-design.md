# Simple R2 Share：規則編輯器與短網址設計規格

**日期：** 2026-10-28  
**狀態：** 待審閱  
**部署：** 原有單一 Cloudflare Pages 專案（Pages Functions + R2 binding）

## 1. 目標與已確認決策

在現有 Simple R2 Share 中新增 `.r2-share-rules` 管理介面，並讓管理員取得每個可分享資料夾的短網址。規則仍儲存在 R2 的單一 UTF-8 文字物件，前後端沿用 `src/rules.ts` 的判斷語意。短網址直接編碼資料夾路徑，不使用 KV、D1、映射表或預先建立的索引。

**現有版本完全未上線，因此直接替換舊路由，不提供相容路由、重新導向、遷移程式、版本化 URL 或雙路由維護。** 專案維持一個 Git 儲存庫、一個 Pages 專案與一套部署設定，不新增管理 Worker，也不改成另一種框架。

## 2. URL 與檔案結構

公開分享網址固定為 `GET|HEAD /s/<token>/`。刪除 `functions/share/[[path]].ts` 及原 `/share/<directory>/` 解析；新建 `functions/s/[[path]].ts`，直接呼叫既有 `src/share-handler.ts`。短網址僅允許單一 token 片段，且要有尾端 `/`；不提供舊網址重新導向。重新整理時從 R2 讀取最新規則與內容。

若 `ENABLE_ZIP_DOWNLOAD=true`，保留現有 ZIP 處理器和 `/api/share-zip` 端點，但改為接受唯一的 `token` 查詢參數，例如 `/api/share-zip?token=<token>`。刪除原本 `dir` 查詢參數與 `parseZipDir()`，ZIP、分享頁與管理端共用同一個解碼函式及 `isShareRoot()` 授權檢查。ZIP 按鈕由相同 token 組成 URL。公開物件下載連結仍直接指向 R2 公開網域，不經 Pages 代理。

管理頁位於 `/admin/`，使用 `public/admin/index.html` 與同源 JS/CSS；管理 API 位於 `functions/api/admin/`。現有 `public/assets`、README 渲染、規則語法、分享清單與 ZIP 串流功能原則上保留。

## 3. 無狀態可逆短網址（Base58＋無密鑰混淆）

新增 `src/short-url.ts`，實作 `encode(path)` 與 `decode(token)`。公開網址只使用 `/s/<token>/`，沒有版本前綴、編碼模式字元或其他相容層。規則編輯器產生完整短網址，公開頁面和 ZIP 端點只解碼一次。

確定性編解碼流程：

1. 使用既有路徑模組驗證 Bucket 相對資料夾，統一以不含頭尾斜線的正規化目錄字串表示。
2. `TextEncoder` 將路徑轉為 UTF-8 位元組。
3. 使用固定公開種子及位元組長度初始化輕量、確定性的 `xorshift32` 序列；逐位元組 XOR 產生混淆內容。反向流程重建同一個序列再 XOR，逐位元組還原。
4. 使用標準 Bitcoin Base58 字元集及正規 Base58 編碼產生 token，字元集合為 `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`。解碼後檢查正規編碼、UTF-8 與合法分享路徑。

XOR 對任意位元組序列可逆，標準 Base58 編碼可無損還原位元組，且同一個合法路徑產生固定 token。長度參與種子初始化，減少相同路徑前綴導致的固定遮罩規律。**固定種子完全公開，混淆僅改變外觀，不提供保密性、驗證或授權能力。** 取回路徑後，每次均重新執行 `isShareRoot()`，並以原有規則限制分享內容。

不使用壓縮、密鑰、雜湊碰撞處理、資料庫查詢或 `BigInt` 型別的逐字元大數運算。優先採用可在 Workers 執行、以位元組陣列做進位轉換的標準 Base58 函式庫，避免自製數字編碼與不必要的套件。Base58 的一般進位轉換在長輸入上可能接近二次時間，因此先對輸入 token 長度做嚴格上限檢查，再執行解碼。編解碼僅接受 R2 物件鍵允許範圍內的 UTF-8 路徑，最大 1024 位元組；錯誤編碼、無效 UTF-8、空路徑、異常斜線和路徑跳脫一律拒絕。

使用 Base58 的網址通常約為 UTF-8 位元組數的 1.37 倍字元長度，短或高熵路徑不保證縮短。中文目錄以 UTF-8 位元組計算，可能產生更長的 token。此規格以「短網址外觀不透露可讀路徑」為優先目標，仍可直接由演算法無狀態還原；部署前以實際資料夾名稱及最大長度進行驗收。

### 3.1 Workers Free CPU 預算

Workers Free 每次 HTTP 請求的 CPU 上限為 **10 ms**；等待 R2 回應的 I/O 時間不列入 CPU，但解碼、規則解析、Markdown/HTML 渲染和 ZIP 處理都會計入。效能預算必須以**整個公開請求**量測，不能只測編解碼器。測試案例包含典型資料夾名稱、中文、多層路徑與 1024 位元組邊界；正式 Free 環境需記錄 CPU 使用情形及是否出現 `exceededCpu`。

公開路由每次只解碼一個 token，不做 Base58 編碼或全 Bucket 掃描；ZIP 亦只解碼一次。管理端列舉路由每次只掃描有界數量的 R2 物件鍵（預設最多 100 筆），延續 R2 cursor 分頁，不在單次請求編碼整個 Bucket。對同一頁出現的重複資料夾先去重再編碼。若在極端長路徑或清單處理時超過 Free CPU 額度，應在實作階段以 Workers 實測結果優化編碼核心或調小分頁，避免宣稱未經驗證的效能保證。

## 4. 規則編輯器

`/admin/` 以純前端頁面實作，不引入第二套應用建置系統。畫面包含規則文字編輯區、驗證錯誤與行號、儲存操作，以及可分頁載入的「分享資料夾 / 短網址」清單與複製連結功能。

- `GET /api/admin/rules`：回傳目前規則原文及 ETag；規則檔不存在時回傳空白文字和「尚未建立」狀態。
- `PUT /api/admin/rules`：接收 UTF-8 規則原文與先前讀取的 ETag。超過 64 KiB、UTF-8 無效、`parseRules()` 拒絕或版本衝突時不得寫入。以 R2 `put(..., { onlyIf: ... })` 進行條件式更新；首次建立使用 `If-None-Match: *`，有版本時使用 `If-Match`。成功後回傳新的 ETag；衝突回 `409`。
- `GET /api/admin/shares?cursor=...`：讀取目前已儲存的規則，透過 R2 `list()` 游標分頁列舉物件鍵（每次最多 100 筆），衍生各物件的父目錄，去重後以 `isShareRoot()` 過濾，回傳其原始目錄路徑及短網址。每頁僅掃描有界數量的物件，不建立長期索引。前端逐頁載入並合併去重。R2 是以物件鍵呈現目錄；僅包含沒有任何物件的虛擬資料夾，無法由列舉結果發現。

規則清單與已產生短網址的對應關係完全由演算法即時計算，沒有額外儲存。規則儲存後清空已載入的分享清單並重新查詢，避免顯示過期結果。規則檔本身始終不得成為分享內容。列表若出現很多資料夾，採用「載入更多」而非一次全量查詢。

## 5. 驗證與權限

正式網域透過 Cloudflare Zero Trust Access 的 Self-hosted 應用保護 `/admin`、`/admin/*`、`/api/admin/*`。Pages Functions 的 `functions/api/admin/_middleware.ts` 再驗證 Access JWT 的簽章、Issuer、Audience 和期限。正式、`pages.dev`、預覽網域下的所有管理 API 都必須通過驗證；沒有有效 Access 設定時直接拒絕請求，不提供本機或預覽版的公開寫入後門。管理 UI 可以是靜態資源，所有讀寫操作都要由後端驗證。

管理 API 僅允許讀取與覆寫 `SHARE_RULES_KEY` 指定的單一 R2 物件，不提供任意物件寫入、刪除或檔案上傳。`PUT` 需限制 Content-Type、大小、同源 Origin，並使用適當的防 CSRF 措施；API 回應設定 `Cache-Control: no-store`。靜態管理頁採用獨立、限制同源 JS 與 API 的 CSP，不修改公開分享頁的 CSP。

前端不存放任何密鑰；同一個後端 R2 binding 承擔讀寫作業。這是應用程式層級的授權隔離，並未承諾把公開 Pages 的 R2 binding 改為平台權限層級的唯讀。原本 Public R2 Bucket 的物件公開讀取行為維持不變。

## 6. 錯誤行為與測試

非法 token、未獲分享權限與不存在的分享根目錄回傳相同公開 `404`；規則檔失效則預設拒絕分享；R2 暫時性錯誤回傳一般 `500`。管理 API 未登入回傳 `403`，無效規則回 `400` 並提供行號，版本衝突回 `409`，暫時性錯誤回 `500` 且不透露內部金鑰。ZIP 端點使用相同授權判斷與既有串流錯誤機制。

測試包含短網址中英文、空白與特殊字元正反向還原、固定混淆序列與 Base58 正規編碼、錯誤或過長 token、10 ms CPU 預算與邊界長度、規則排除及遞迴目錄、ZIP 下載、規則檔首次建立與並行編輯衝突、無效 JWT、錯誤 Origin，以及大量 R2 物件的游標分頁。刪除原 `/share/*` 與 `?dir=` 相關測試，改為驗證舊路徑直接 `404`，不再提供原路由。

## 7. 範圍外

不新增 KV、D1、資料表、獨立 Worker、客製別名、登入帳號資料庫、檔案上傳與物件刪除，也不保證短網址對所有輸入都比原路徑短。無密鑰混淆提供網址外觀變化，但能被任何取得演算法的人還原。

## 8. 參考文件

- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Cloudflare Pages Access 外掛](https://developers.cloudflare.com/pages/functions/plugins/cloudflare-access/)
- [Cloudflare Workers API Compression Streams](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
