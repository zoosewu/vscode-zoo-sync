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
- [ ] integration smoke test（環境缺 libgtk-3，無法啟動 VS Code，見 Review）
- [x] 以 stub vscode + 假 GitHub API 對 production bundle 做兩台機器端到端驗證
- [x] package .vsix（只含 dist/extension.js、package.json、readme）
- [ ] 以真實 GitHub 帳號手動端到端測試（需使用者執行）

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
- `pnpm test:integration`：VS Code 1.137 已下載，但容器缺少 `libgtk-3.so.0` 等 Electron 系統函式庫，因此沒有安裝。需要時可執行：
  `apt-get install -y libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxkbfile1 libsecret-1-0`，再執行 `xvfb-run -a pnpm run test:integration`。
- 還需要以真實 GitHub 帳號、在 Windows / macOS 上實際測試。
