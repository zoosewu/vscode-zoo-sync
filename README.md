# Zoo Sync

透過**私有 GitHub repository**，在 Windows、macOS、Linux 之間同步 VS Code 與 Cursor 的 `settings.json`、`keybindings.json`、擴充套件列表與自訂檔案，並可分 profile 同步。

## 功能

- **settings.json**：所有平台共用一份，以 top-level key 為單位做三方合併。本機檔案的註解與格式會保留。
- **keybindings.json**：依平台各存一份（`keybindings/windows.json`、`macos.json`、`linux.json`），整份同步並保留註解。
- **擴充套件**：只記錄 extension id（不記版本）。遠端新增的會自動安裝；其他機器移除的會先詢問，再決定要不要在這台移除。
- **自訂檔案**：`zooSync.files` 可以指定 VS Code 使用者目錄底下的檔案（如 `snippets/**`、`tasks.json`）或家目錄的檔案（如 `~/.gitconfig`），支援 glob 與每平台不同路徑。
- **Profile**：`zooSync.profiles` 列出的每個 profile 各自同步自己的設定、快捷鍵、擴充套件與自訂檔案。
- **多編輯器**：VS Code 與 Cursor 共用設定、快捷鍵與自訂檔案，擴充套件清單各自獨立。
- **不會誤判變更**：比對前會把內容正規化（排序 key、去掉註解與格式），`meta.json` 裡的 update time 也不參與比對。內容沒變就不會產生 commit。
- **衝突處理**：兩邊改到同一個 key（或同一平台的 keybindings）時，保留 update time 較新的一方，並寫進 log。舊的值仍可在 git 歷史中找回。

## 安裝

Zoo Sync 不會發布到 VS Code Marketplace。請從 GitHub Releases 下載 `zoo-sync-<version>.vsix`，再用以下任一方式安裝：

- 在 Extensions 檢視的 `…` 選單選擇 **Install from VSIX…**（VS Code 與 Cursor 皆同）
- 或在終端機執行：`code --install-extension zoo-sync-<version>.vsix`

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

## 自訂檔案

```jsonc
"zooSync.files": [
  "snippets/**",        // 相對路徑 → 每個同步的 profile 各自一份
  "tasks.json",
  "mcp.json",
  "~/.gitconfig",       // ~ 開頭 → 機器層級，與 profile 無關
  { "path": "~/.config/starship.toml", "perPlatform": true },          // 每個平台各存一份
  { "path": { "windows": "~/AppData/Roaming/x.toml", "*": "~/.config/x.toml" } }
]
```

- glob 只支援 `*`（不跨目錄）與 `**`（跨目錄）。符號連結不會被追蹤，`.git` 與 `node_modules` 會跳過。
- 這些檔案無法像 settings 那樣逐 key 合併，因此採整份檔案、update time 較新者勝。
- 只允許使用者目錄或家目錄底下的路徑。其他絕對路徑、含 `..` 的路徑會被拒絕並記錄在 log。
- 超過 1 MB、非文字、或檔名像機密資料的（`id_rsa`、`*.pem`、`.env`、`credentials*` 等）會跳過。
- **新增與更新自動套用；刪除會先詢問**。被刪除的檔案在刪除前會複製到擴充套件 globalStorage 的 `trash/` 目錄。選擇保留的檔案之後就不再同步。

## Profile

`zooSync.profiles` 預設是 `["Default"]`，可用指令 **Zoo Sync: Choose Profiles to Sync** 勾選。每個 profile 在 repository 裡有自己的目錄。

- profile 的內容是直接從磁碟讀寫的，所以**任何視窗都能同步所有列出的 profile**。
- **擴充套件例外**：VS Code 只能把套件安裝到目前視窗的 profile，也沒有公開 API 能得知目前是哪個 profile。Zoo Sync 會從 VS Code 自己的 `storage.json` 反查（有開資料夾或工作區的視窗才查得到）。清單一律同步；安裝與移除只在能確認 profile 的視窗執行，其餘等你切換過去時再補上。
- 遠端有、本機沒有的 profile **只會提示，不會自動建立**——profile 清單由 VS Code 主程序管理。請先在 VS Code 裡建立同名 profile。

## VS Code 與 Cursor

兩個編輯器裝上同一個擴充套件、指到同一個 repository 即可。**profile 以名稱配對**：VS Code 的 Default 對 Cursor 的 Default、Work 對 Work。

| 項目 | 行為 |
|---|---|
| settings | **共用**，但每個編輯器專屬的 key 另外存放（見下） |
| keybindings | **共用**。另一個編輯器不認得的指令會被忽略，不會出錯 |
| 自訂檔案 | **共用** |
| 擴充套件清單 | **各自一份**（`extensions.code.json`、`extensions.cursor.json`） |

擴充套件之所以不共用，是因為 Cursor 改用 Open VSX，而且官方文件明載：同一個 `publisher.extension` id 在 Open VSX 與 MS Marketplace **可能指向不同的發行者或程式碼**。微軟的閉源套件（Pylance、C/C++、C#、Remote 系列）在 Cursor 也無法使用。

### 編輯器專屬的設定

`zooSync.appSettings` 定義哪些 key 只屬於某個編輯器，預設：

```json
{ "cursor": ["cursor.*", "anysphere.*"] }
```

- 屬於自己的 key → 存到 `settings.<app>.json`
- 屬於別的編輯器的 key → **不上傳、也不寫進本機**，所以 VS Code 的 settings.json 不會冒出 `cursor.*`
- 其餘 → 共用的 `settings.json`

編輯器代號由 `vscode.env.uriScheme` 自動判斷：VS Code（含 Insiders）是 `code`、Cursor 是 `cursor`、VSCodium 是 `vscodium`。需要時可用 `zooSync.appId` 覆寫——**代號相同的編輯器會共用擴充套件清單**。

## Repository 結構

```
meta.json                                   每個資源的 updatedAt / updatedBy
profiles/Default/settings.json               共用設定
profiles/Default/settings.<app>.json         該編輯器專屬設定
profiles/Default/keybindings/<platform>.json
profiles/Default/extensions.<app>.json       各編輯器一份
profiles/Default/files/common/<相對路徑>     自訂檔案
profiles/Default/files/<platform>/<相對路徑> perPlatform 的版本
profiles/Work/…                             其他 profile
files/common/<家目錄相對路徑>                機器層級自訂檔案
```

commit message 格式：`sync: profiles/Default/settings.json, … from linux@host at 2026-09-16T12:00:00.000Z`

舊版建立的 repository 會在第一次同步時自動升級（扁平結構 → profile 結構 → 各編輯器獨立的擴充套件清單），並保留註解與 update time。升級後**舊版的 Zoo Sync 會停止同步並提示更新**，這是刻意的保護，請把所有機器都更新到同一版。

## 設定

| 設定 | 預設值 | 說明 |
|---|---|---|
| `zooSync.repository` | `""` | `owner/name` |
| `zooSync.profiles` | `["Default"]` | 要同步的 profile 名稱 |
| `zooSync.files` | `[]` | 額外同步的檔案，見上方說明 |
| `zooSync.appId` | `""` | 編輯器代號，空白為自動判斷 |
| `zooSync.appSettings` | `{"cursor": [...]}` | 只屬於某個編輯器的設定 key |
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
- **Zoo Sync: Choose Profiles to Sync**：勾選要同步的 profile
- **Zoo Sync: Add File to Sync**：把目前開啟的檔案（或手動輸入的路徑）加進 `zooSync.files`
- **Zoo Sync: Sync Now**：立即同步
- **Zoo Sync: Sign In with GitHub** / **Sign Out**：登入，或讓 Zoo Sync 停止使用 GitHub 帳號（帳號本身請從 Accounts 選單移除）
- **Zoo Sync: Toggle Auto Sync**：開關自動同步
- **Zoo Sync: Reset Local Sync State**：清除這台機器的同步紀錄，下次同步時會重新詢問 Download / Upload / Merge
- **Zoo Sync: Show Log**：顯示同步 log

## 已知限制

- **空白視窗**（沒有開資料夾或工作區）無法判斷所屬 profile，因此只同步檔案，不會安裝或移除擴充套件。
- 在 **Remote 視窗**（SSH、WSL、Dev Containers）中不會安裝或移除擴充套件，因為會裝到遠端主機上。
- 不同步各擴充套件的內部狀態（`globalStorage`）。
- 不做跨市集的擴充套件對應（例如 `ms-python.python` 與 Cursor 的替代版本），因為同名 id 可能是不同的程式碼。
- 若某個編輯器沒有內建 GitHub 登入，狀態列會顯示需要登入並停在該狀態，不會影響本機設定。
- 在 marketplace 上找不到的擴充套件（例如只提供 VSIX 的套件，或 VSCodium 使用的 Open VSX 上沒有的套件）會安裝失敗。失敗會記錄在 log，但**不會**因此從遠端清單中移除，之後每次完整同步都會重試。
- `settings.json` 有語法錯誤，或在編輯器中有尚未存檔的修改時，會暫停同步，直到修正或存檔。

## 開發

```bash
fnm use                 # Node 24（.nvmrc）
pnpm install
pnpm run check-types    # 型別檢查（src + 測試）
pnpm run lint
pnpm test               # vitest 單元測試
pnpm run test:integration   # 在 VS Code 內跑 smoke test
pnpm run package        # 產出 .vsix
```

在 VS Code 中按 F5 可以開啟 Extension Development Host。

無桌面環境的 Linux（容器、WSL）跑整合測試時，需要先安裝 Electron 的執行期函式庫，並透過 xvfb 執行：

```bash
sudo apt-get install -y libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxkbfile1 \
  libsecret-1-0 libatk-bridge2.0-0t64 libcups2t64 libxdamage1 libxrandr2 libxcomposite1 libxfixes3
xvfb-run -a pnpm run test:integration
```

缺少這些函式庫時，錯誤訊息會是 `code: error while loading shared libraries: libgtk-3.so.0`。

### 發版流程

版本由 [release-please](https://github.com/googleapis/release-please) 依照 [Conventional Commits](https://www.conventionalcommits.org/) 自動決定：

1. commit 訊息使用 `feat:`、`fix:` 等前綴，push 到 `main`。
2. `Release Please` workflow 會建立或更新 `chore: release x.y.z` PR，內容包含 `CHANGELOG.md` 與 `package.json` 版本號。
3. 合併這個 PR 後，會建立 `vx.y.z` tag 與 GitHub Release，並把打包好的 `.vsix` 上傳到該 Release。

第一次使用前，請在 repository 的 **Settings → Actions → General** 開啟 **Allow GitHub Actions to create and approve pull requests**。

由 `GITHUB_TOKEN` 建立的 release PR 不會觸發 CI。需要在該 PR 上跑檢查時，請手動重新觸發，或改用 Personal Access Token。

架構：

- `src/sync/`：純邏輯，不依賴 `vscode`，可以直接用 vitest 測試。包含正規化、排除清單、三方合併、同步引擎、狀態檔與跨視窗鎖。
- `src/github/`：GitHub REST API（Git Database API，以原生 `fetch` 呼叫）與登入。
- `src/local/`：讀寫本機設定檔、解析 profile（`storage.json`）與管理擴充套件。
- `src/syncController.ts`：排程、變更偵測與所有使用者互動。同步引擎本身不會跳出任何詢問。
