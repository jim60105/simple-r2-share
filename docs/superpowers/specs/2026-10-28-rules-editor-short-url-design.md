# Simple R2 Share：規則編輯器與短網址設計規格

**日期：** 2026-10-28  
**狀態：** 已核可（第 4 節的管理頁設計已由 [管理頁畫面與功能設計規格](2026-10-28-admin-ui-design.md) 取代）  
**部署：** 原有單一 Cloudflare Pages 專案（Pages Functions + R2 binding）

## 1. 目標與已確認決策

在現有 Simple R2 Share 中新增 `.r2-share-rules` 管理介面，並讓管理員取得每個可分享資料夾的短網址。規則仍儲存在 R2 的單一 UTF-8 文字物件，前後端沿用 `src/rules.ts` 的判斷語意。短網址直接編碼資料夾路徑，不使用 KV、D1、映射表或預先建立的索引。

**現有版本完全未上線，因此直接替換舊路由，不提供相容路由、重新導向、遷移程式、版本化 URL 或雙路由維護。** 專案維持一個 Git 儲存庫、一個 Pages 專案與一套部署設定，不新增管理 Worker，也不改成另一種框架。

## 2. URL 與檔案結構

公開分享網址固定為 `GET|HEAD /s/<token>/`。刪除 `functions/share/[[path]].ts` 及原 `/share/<directory>/` 解析；新建 `functions/s/[[path]].ts`，直接呼叫既有 `src/share-handler.ts`。短網址僅允許單一 token 片段，且要有尾端 `/`；不提供舊網址重新導向。重新整理時從 R2 讀取最新規則與內容。

若 `ENABLE_ZIP_DOWNLOAD=true`，保留現有 ZIP 處理器和 `/api/share-zip` 端點，但改為接受唯一的 `token` 查詢參數，例如 `/api/share-zip?token=<token>`。刪除原本 `dir` 查詢參數與 `parseZipDir()`，ZIP、分享頁與管理端共用同一個解碼函式及 `isShareRoot()` 授權檢查。ZIP 按鈕由相同 token 組成 URL。公開物件下載連結仍直接指向 R2 公開網域，不經 Pages 代理。

管理頁位於 `/admin/`，使用 `public/admin/index.html`、同源 CSS，以及由 esbuild 打包的同源 JS；管理 API 位於 `functions/api/admin/`。前端與伺服器共用 `src/rules.ts`、`src/paths.ts` 與 `src/short-url.ts`，細節見管理頁規格第 10 節。現有 `public/assets`、README 渲染、規則語法、分享清單與 ZIP 串流功能原則上保留。

## 3. 無狀態可逆短網址（Base58＋無密鑰混淆）

新增 `src/short-url.ts`，實作 `encode(path)` 與 `decode(token)`。公開網址只使用 `/s/<token>/`，沒有版本前綴、編碼模式字元或其他相容層。管理頁在管理員點擊複製時，才於前端計算單一路徑的完整短網址；公開頁面和 ZIP 端點只解碼一次。

確定性編解碼流程：

1. 使用既有路徑模組驗證 Bucket 相對資料夾，統一以不含頭尾斜線的正規化目錄字串表示。
2. `TextEncoder` 將路徑轉為 UTF-8 位元組。
3. 使用固定公開種子及位元組長度初始化輕量、確定性的 `xorshift32` 序列；逐位元組 XOR 產生混淆內容。反向流程重建同一個序列再 XOR，逐位元組還原。
4. 使用標準 Bitcoin Base58 字元集及正規 Base58 編碼產生 token，字元集合為 `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`。解碼後檢查 UTF-8 與合法分享路徑。標準 Base58 在字元集字串與位元組陣列之間是一對一的，每個通過字元檢查的 token 本身就是正規編碼，因此不在執行時重新編碼比對，改由測試驗證這個性質。

XOR 對任意位元組序列可逆，標準 Base58 編碼可無損還原位元組，且同一個合法路徑產生固定 token。長度參與種子初始化，減少相同路徑前綴導致的固定遮罩規律。**固定種子完全公開，混淆僅改變外觀，不提供保密性、驗證或授權能力。** 取回路徑後，每次均重新執行 `isShareRoot()`，並以原有規則限制分享內容。

不使用壓縮、密鑰、雜湊碰撞處理、資料庫查詢或 `BigInt` 型別的逐字元大數運算。優先採用可在 Workers 執行、以位元組陣列做進位轉換的標準 Base58 函式庫，避免自製數字編碼與不必要的套件。Base58 的一般進位轉換在長輸入上可能接近二次時間，因此先將 token 限制為最多 1400 個 Base58 字元，再執行解碼。解碼後的路徑 UTF-8 長度最多 1024 位元組，與 R2 物件鍵上限一致；錯誤編碼、無效 UTF-8、空路徑、異常斜線和路徑跳脫一律拒絕。

使用 Base58 的網址通常約為 UTF-8 位元組數的 1.37 倍字元長度，短或高熵路徑不保證縮短。中文目錄以 UTF-8 位元組計算，可能產生更長的 token。此規格以「短網址外觀不透露可讀路徑」為優先目標，仍可直接由演算法無狀態還原；部署前以實際資料夾名稱及最大長度進行驗收。

### 3.1 Workers Free CPU 預算

Workers Free 每次 HTTP 請求的 CPU 上限為 **10 ms**；等待 R2 回應的 I/O 時間不列入 CPU，但解碼、規則解析、Markdown/HTML 渲染和 ZIP 處理都會計入。效能預算必須以**整個公開請求**量測，不能只測編解碼器。測試案例包含典型資料夾名稱、中文、多層路徑與 1024 位元組邊界；正式 Free 環境需記錄 CPU 使用情形及是否出現 `exceededCpu`。

公開路由每次只解碼一個 token，不做 Base58 編碼或全 Bucket 掃描；ZIP 亦只解碼一次。伺服器端完全不做 Base58 編碼：短網址只在管理頁前端、管理員點擊複製時計算一個路徑。管理端的資料夾列舉每次只做一次 `delimiter: "/"` 的 R2 列舉，不做編碼或規則計算。若極端長路徑的解碼超過 Free CPU 額度，應在實作階段以 Workers 實測結果優化解碼核心，避免宣稱未經驗證的效能保證。

## 4. 規則編輯器

管理頁的畫面、操作流程與管理 API 由 [管理頁畫面與功能設計規格](2026-10-28-admin-ui-design.md) 定義，取代本節原本的「規則文字編輯區」與「分享資料夾 / 短網址」清單設計。重點如下：

- 前端不提供純文字編輯，改以資料夾樹切換每個資料夾的四種規則狀態，規則檔由管理頁依固定格式輸出。
- `GET /api/admin/rules` 與 `PUT /api/admin/rules` 保留，條件式寫入、64 KiB 上限與 `409` 衝突處理不變，回應另外帶有存檔時間與登入者信箱。
- 新增 `GET /api/admin/folders?prefix=&cursor=`，以 R2 `delimiter` 列舉逐層載入資料夾。
- 原本的 `GET /api/admin/shares` 刪除。短網址改由前端在點擊複製時計算，不做批次編碼。

規則檔本身始終不得成為分享內容；R2 是以物件鍵呈現目錄，沒有任何物件的虛擬資料夾無法由列舉結果發現，只會以規則中的幽靈節點出現在樹上。

## 5. 驗證與權限

正式網域透過 Cloudflare Zero Trust Access 的 Self-hosted 應用保護 `/admin`、`/admin/*`、`/api/admin/*`。Pages Functions 的 `functions/api/admin/_middleware.ts` 再驗證 Access JWT 的簽章、Issuer、Audience 和期限。這個 middleware 自行實作，不使用 `@cloudflare/pages-plugin-cloudflare-access`，並新增 `ACCESS_TEAM_DOMAIN` 與 `ACCESS_AUD` 兩個部署設定，細節見管理頁規格第 9 節。正式、`pages.dev`、預覽網域下的所有管理 API 都必須通過驗證；沒有有效 Access 設定時直接拒絕請求，不提供本機或預覽版的公開寫入後門。管理 UI 可以是靜態資源，所有讀寫操作都要由後端驗證。

管理 API 僅允許讀取與覆寫 `SHARE_RULES_KEY` 指定的單一 R2 物件，不提供任意物件寫入、刪除或檔案上傳。`PUT` 需限制 Content-Type、大小、同源 Origin，並使用適當的防 CSRF 措施；API 回應設定 `Cache-Control: no-store`。靜態管理頁採用獨立、限制同源 JS 與 API 的 CSP，不修改公開分享頁的 CSP。

前端不存放任何密鑰；同一個後端 R2 binding 承擔讀寫作業。這是應用程式層級的授權隔離，並未承諾把公開 Pages 的 R2 binding 改為平台權限層級的唯讀。原本 Public R2 Bucket 的物件公開讀取行為維持不變。

## 6. 錯誤行為與測試

非法 token、未獲分享權限與不存在的分享根目錄回傳相同公開 `404`；規則檔失效則預設拒絕分享；R2 暫時性錯誤回傳一般 `500`。管理 API 未登入回傳 `403`，無效規則回 `400` 並提供行號，版本衝突回 `409`，暫時性錯誤回 `500` 且不透露內部金鑰。ZIP 端點使用相同授權判斷與既有串流錯誤機制。

測試包含短網址中英文、空白與特殊字元正反向還原、固定混淆序列與 Base58 正規編碼、錯誤或過長 token、10 ms CPU 預算與邊界長度、規則排除及遞迴目錄、ZIP 下載、規則檔首次建立與並行編輯衝突、無效 JWT、錯誤 Origin，以及資料夾列舉的游標分頁；管理頁本身的測試見管理頁規格第 11 節。刪除原 `/share/*` 與 `?dir=` 相關測試，改為驗證舊路徑直接 `404`，不再提供原路由。

## 7. 範圍外

不新增 KV、D1、資料表、獨立 Worker、客製別名、登入帳號資料庫、檔案上傳與物件刪除，也不保證短網址對所有輸入都比原路徑短。無密鑰混淆提供網址外觀變化，但能被任何取得演算法的人還原。

## 8. 參考文件

- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Cloudflare Pages Access 外掛](https://developers.cloudflare.com/pages/functions/plugins/cloudflare-access/)
- [Cloudflare Workers API Compression Streams](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare R2 object key limits](https://developers.cloudflare.com/r2/platform/limits/)
