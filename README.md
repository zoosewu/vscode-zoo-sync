# Zoo Sync

透過**私有 GitHub repository**，在 Windows、macOS、Linux 之間同步 VS Code 的 `settings.json`、`keybindings.json` 與擴充套件列表。

## 功能

- **settings.json**：所有平台共用一份，以 top-level key 為單位做三方合併。本機檔案的註解與格式會保留。
- **keybindings.json**：依平台各存一份（`keybindings/windows.json`、`macos.json`、`linux.json`），整份同步並保留註解。
- **擴充套件**：只記錄 extension id（不記版本）。遠端新增的會自動安裝；其他機器移除的會先詢問，再決定要不要在這台移除。
- **不會誤判變更**：比對前會把內容正規化（排序 key、去掉註解與格式），`meta.json` 裡的 update time 也不參與比對。內容沒變就不會產生 commit。
- **衝突處理**：兩邊改到同一個 key（或同一平台的 keybindings）時，保留 update time 較新的一方，並寫進 log。舊的值仍可在 git 歷史中找回。

## 使用方式

1. 執行指令 **Zoo Sync: Configure Repository**，用 VS Code 內建的 GitHub 帳號登入（需要 `repo` scope）。
2. 輸入 `owner/name`，例如 `yourname/vscode-settings`。若 repository 不存在，會在你的帳號下自動建立為 **private**。
3. 其他電腦做同樣設定。第一次同步時會詢問要：
   - **Download**：以 repository 內容取代這台機器
   - **Upload**：以這台機器取代 repository 內容
   - **Merge**：合併兩邊，衝突時以 repository 為準

> 如果有開啟 VS Code 內建的 Settings Sync，請先關閉，避免兩者互相覆蓋。

## 同步時機

| 時機 | 行為 |
|---|---|
| VS Code 啟動 | 完整同步一次 |
| 每 30 分鐘（`zooSync.remotePollMinutes`） | 檢查遠端是否有新 commit。沒有變動時只發一個 conditional request（HTTP 304，不計入 rate limit） |
| 每 5 分鐘（`zooSync.localSyncMinutes`） | 只有偵測到本機變更時才同步。變更偵測使用檔案系統事件，不會輪詢 |
| 狀態列按鈕／**Zoo Sync: Sync Now** | 立即同步 |

同時開多個 VS Code 視窗時，會透過鎖檔確保同一時間只有一個視窗在同步。

## Repository 結構

```
meta.json                 每個資源的 updatedAt / updatedBy
settings.json             共用設定（已移除排除的 key）
keybindings/<platform>.json
extensions.json           排序過的 extension id 陣列
```

commit message 格式：`sync: settings, extensions from linux@host at 2026-09-15T12:00:00.000Z`

## 設定

| 設定 | 預設值 | 說明 |
|---|---|---|
| `zooSync.repository` | `""` | `owner/name` |
| `zooSync.branch` | `main` | 儲存同步資料的 branch，不存在時會自動建立 |
| `zooSync.autoSync` | `true` | 自動同步（此設定本身不會被同步） |
| `zooSync.remotePollMinutes` | `30` | 檢查遠端的間隔 |
| `zooSync.localSyncMinutes` | `5` | 上傳本機變更的間隔 |
| `zooSync.ignoredSettings` | 見下方 | 不同步的 setting key |
| `zooSync.ignoredExtensions` | `[]` | 不同步的 extension id，支援 `*` |

### 排除的設定

`zooSync.ignoredSettings` 的 `*` 可以比對任何字元（包含 `.`），大小寫需相符。預設排除機器相關或容易變動的 key：

```json
["zooSync.autoSync", "http.proxy*", "*.path", "*Path", "remote.SSH.configFile",
 "terminal.integrated.cwd", "window.zoomLevel", "*.lastCheck*", "*.timestamp", "*.machineId"]
```

自訂這個設定時會**整份取代**預設清單，需要的預設項目請一併保留。另外，key 名稱最後一段看起來像機密資料的（`apiKey`、`accessToken`、`authToken`、`password`、`secret`）**永遠不會同步**。

被排除的 key 會留在本機的 settings.json，下載時也不會被動到。

## 指令

- **Zoo Sync: Configure Repository**：設定或建立同步用的 repository
- **Zoo Sync: Sync Now**：立即同步
- **Zoo Sync: Sign In with GitHub** / **Sign Out**：登入，或讓 Zoo Sync 停止使用 GitHub 帳號（帳號本身請從 Accounts 選單移除）
- **Zoo Sync: Toggle Auto Sync**：開關自動同步
- **Zoo Sync: Reset Local Sync State**：清除這台機器的同步紀錄，下次同步時會重新詢問 Download / Upload / Merge
- **Zoo Sync: Show Log**：顯示同步 log

## 已知限制

- 只同步 **Default profile**。VS Code 沒有提供可以取得目前 profile 的穩定 API。
- 在 **Remote 視窗**（SSH、WSL、Dev Containers）中只同步 settings 與 keybindings，擴充套件同步會略過。
- 在 marketplace 上找不到的擴充套件（例如只提供 VSIX 的套件，或 VSCodium 使用的 Open VSX 上沒有的套件）會安裝失敗。失敗會記錄在 log，但**不會**因此從遠端清單中移除，之後每次完整同步都會重試。
- `settings.json` 有語法錯誤，或在編輯器中有尚未存檔的修改時，會暫停同步，直到修正或存檔。

## 開發

```bash
fnm use                 # Node 24（.nvmrc）
pnpm install
pnpm run check-types    # 型別檢查（src + 測試）
pnpm run lint
pnpm test               # vitest 單元測試
pnpm run test:integration   # 在 VS Code 內跑 smoke test（Linux 無桌面環境時用 xvfb-run -a）
pnpm run package        # 產出 .vsix
```

在 VS Code 中按 F5 可以開啟 Extension Development Host。

架構：

- `src/sync/`：純邏輯，不依賴 `vscode`，可以直接用 vitest 測試。包含正規化、排除清單、三方合併、同步引擎、狀態檔與跨視窗鎖。
- `src/github/`：GitHub REST API（Git Database API，以原生 `fetch` 呼叫）與登入。
- `src/local/`：讀寫本機設定檔與管理擴充套件。
- `src/syncController.ts`：排程、變更偵測與所有使用者互動。同步引擎本身不會跳出任何詢問。
