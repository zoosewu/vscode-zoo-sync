# Zoo Sync — Todo

## 0. 規劃
- [x] 需求確認（儲存後端、觸發、跨平台、衝突、擴充套件行為）
- [x] 查證最新 VS Code Extension API 與 GitHub REST API 規格
- [x] 建立 tasks/todo.md、tasks/lessons.md

## 1. 環境
- [x] fnm 1.39 + Node 24.21 LTS、pnpm 12.4（corepack）；fnm 已加入 `~/.bashrc`
- [x] `.nvmrc`

## 2. 專案骨架
- [x] package.json（manifest、contributes、scripts）
- [x] tsconfig.json（src + integration）、test/unit/tsconfig.json（vitest 為 ESM-only，用 bundler resolution）
- [x] esbuild.js、eslint.config.mjs、vitest.config.mts、.vscode-test.mjs
- [x] .vscode/launch.json、tasks.json、.vscodeignore、.gitignore、pnpm-workspace.yaml（allowBuilds）

## 3. 純邏輯層
- [x] sync/canonical.ts、sync/ignore.ts、sync/merge.ts、sync/documents.ts

## 4. GitHub 層
- [x] github/client.ts（headers、錯誤對應、rate limit）
- [x] github/repoStore.ts（ensureRepository、getHead、readFile、commit）
- [x] github/auth.ts
- [x] 測試：304、404、409 空 repo、缺 branch、422 非 fast-forward、429 / 403 rate limit

## 5. 本機層
- [x] local/vscodeLocalStore.ts（路徑、settings/keybindings 讀寫、擴充套件清單 + manifest、未存檔偵測）

## 6. 同步引擎
- [x] sync/stateStore.ts、sync/lock.ts、sync/engine.ts + 流程測試

## 7. 排程與 UI
- [x] syncController.ts、ui/statusBar.ts、config.ts、extension.ts

## 8. 文件
- [x] README.md

## 9. 驗證
- [x] check-types / lint / 90 個單元測試通過
- [x] integration smoke test（本機缺 libgtk-3 無法執行，改由 CI 在三個平台驗證，見第 10 節）
- [x] 以 stub vscode + 假 GitHub API 對 production bundle 做兩台機器端到端驗證
- [x] package .vsix（只含 dist/extension.js、package.json、readme）
- [ ] 以真實 GitHub 帳號手動端到端測試（需使用者執行）

## 10. GitHub Actions 自動 release（參考 zoosewu/vscode-project-manager，不發布 Marketplace）
- [x] 查證最新版本：checkout v7、setup-node v7、cache v6、pnpm/action-setup v6、release-please-action v5（v5 只把 runtime 改成 node24）
- [x] `.github/workflows/ci.yml`：Windows / macOS / Linux 矩陣，執行 type check、lint、unit、integration，並在 Linux 上打包
- [x] `.github/workflows/release-please.yml`：維護 release PR，合併後建立 tag / Release，並上傳 `.vsix`
- [x] `release-please-config.json`、`.release-please-manifest.json`（manifest 設為 `0.0.0`；實際發布時 release-please 的 node 策略把第一次發布視為 **1.0.0**，不是預期的 0.1.0）
- [x] `package.json` 加入 `packageManager: pnpm@12.4.1`，供 CI 決定 pnpm 版本
- [x] README：安裝方式與發版流程
- [x] 本機驗證：actionlint 1.7.12 無問題、JSON 格式正確、frozen lockfile 可安裝、90 個 unit test 通過、vsix 只含 5 個必要檔案
  - 修正：pnpm 12 會把 `packageManagerDependencies` 寫進 lockfile，因此 `pnpm-lock.yaml` 必須一起 commit，否則 CI 的 frozen install 會失敗
  - 修正：`.vscodeignore` 排除 `.github/` 與 release-please 設定檔
- [x] push 到 GitHub 後實際驗證：CI 在 Windows / macOS / Linux 三個平台全數通過（本機無法執行的整合測試在此得到驗證）；release-please 開出 PR #1，合併後產生 tag `v1.0.0`、Release 與附件 `zoo-sync-1.0.0.vsix`（22.5 KB）
- [x] 修正 `changelog-sections`：section 名稱不需自帶 `###`，否則 CHANGELOG 會出現 `### ### Added`（已同步修正既有的 CHANGELOG.md）

## Review

### 與計畫的差異
- **引擎改為完全不互動**：原計畫在同步流程中詢問使用者，但詢問期間會一直持有跨視窗鎖，使用者不回應時所有視窗都會卡住。現在改成引擎回報 `needs-initial-choice` / `pendingUninstall`，由 controller 在鎖外詢問，再以 `resolvePendingUninstall` 套用。
- **新增 `unavailableExtensions` 狀態**：某台機器安裝失敗的擴充套件（例如 Open VSX 上沒有）原本會被視為「本機移除」，進而從所有機器刪除。現在會鏡像遠端清單，並在每次完整同步時重試安裝。
- **自寫回聲抑制簡化**：不另外追蹤預期 hash。watcher 觸發後的同步會得到 HTTP 304，本機內容也等於 base，只多一次免費的檢查。
- **檔案整併**：local/ 原本規劃的四個檔案合成一個 `vscodeLocalStore.ts`；`baseStore` 改名為 `stateStore`（也存 localOnly/pending/unavailable）；`scheduler` 與 `prompts` 合併為 `src/syncController.ts`（它依賴 vscode，因此不放在純邏輯的 `sync/`）；`log.ts` 不需要，`LogOutputChannel` 已符合 `Logger` 介面。
- `@vscode/vsce` 安裝到的是 3.9.2。

### 驗證中發現並修正的問題
- **production bundle 啟動即崩潰**：`jsonc-parser` 的 UMD 入口使用動態 `require('./impl/format')`，esbuild 無法打包。vitest 抓不到，是端到端 smoke test 載入 `dist/extension.js` 時發現的。已在 esbuild 設定 `mainFields: ['module', 'main']` 修正。
- `.vscodeignore` 仍寫舊檔名 `vitest.config.ts`，導致設定檔被打包進 vsix。已修正。

### 未完成的驗證
- `pnpm test:integration` 在這台開發機無法執行（缺少 `libgtk-3.so.0` 等 Electron 系統函式庫）。需要本機執行時：
  `apt-get install -y libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxkbfile1 libsecret-1-0`，再執行 `xvfb-run -a pnpm run test:integration`。CI 已在 Windows / macOS / Linux 上執行並通過。
- 還需要以真實 GitHub 帳號實際同步兩台電腦。
