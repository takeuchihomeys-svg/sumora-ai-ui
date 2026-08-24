# #43 物件検索ツール部署 記録ファイル

> セッションをまたいで記録を継続する。更新時は日付を必ず記録する。

---

## 📌 部署ミッション

Chrome拡張ツール（AIXLINX 物件検索サポート）の開発・改善・記録。
お客さんの条件に合わせてリアプロ・itandi・レインズの検索手順を正確にアナウンスする。

**管轄ファイル**:
| ファイル | 役割 |
|--------|------|
| `chrome-extension/popup.js` | メインロジック・検索手順定義・STATION_LINE_MAP・STATION_WARD_MAP |
| `chrome-extension/popup.html` | 拡張ツールUI |
| `chrome-extension/styles.css` | スタイル |
| `chrome-extension/background.js` | サイドパネル設定 |
| `chrome-extension/manifest.json` | 拡張設定・バージョン管理 |
| `chrome-extension/page-script.js` | リアプロフォーム自動入力（ページコンテキスト） |
| `chrome-extension/underbar.js` | リアプロ画面下部固定バー（iframe注入） |
| `chrome-extension/content.js` | リアプロコンテンツスクリプト（viewport制御） |
| `chrome-extension/content.css` | リアプロUI補正CSS |
| `chrome-extension/bulk-dl.js` | リアプロ印刷用PDF一括DLバー |
| `chrome-extension/itandi-content.js` | itandi BBコンテンツスクリプト（メッセージ受信・ページスクリプト注入） |
| `chrome-extension/itandi-page-script.js` | itandi BBフォーム自動入力（ページコンテキスト） |
| `chrome-extension/reins-content.js` | REINSコンテンツスクリプト（chrome.tabs.sendMessage受信・ページスクリプト注入） |
| `chrome-extension/reins-page-script.js` | REINSフォーム自動入力（Vueセッター・select/option/checkbox対応） |

---

## 🖥️ 表示モード（2026-05-17 確立）

### アンダーバーモード（リアプロ専用）
- リアプロ（realnetpro.com）を開くと画面下部に固定バーとして自動表示
- `underbar.js` がページに `<iframe src="popup.html">` を固定注入
- 高さ: 折りたたみ 54px ↔ 展開 480px（アニメーション付き）
- **サイドパネルと異なりviewport幅を狭めない** → リアプロの左サイドバーが消えない
- ヘッダーのロゴクリック or トグルボタンで展開/折りたたみ
- ヘッダー右に折りたたみボタン（chevron）＋更新ボタン

### サイドパネルモード（itandi・レインズ等）
- Chrome拡張アイコンクリックでサイドパネルとして通常起動
- itandi BBではサイドパネルで「⚡ itandiに自動入力」ボタンが表示される

### isUnderbar 判定
- `window.self !== window.top` → true でアンダーバーモード（リアプロ・itandiどちらも underbar.js が動くため、両方で isUnderbar=true）
- リアプロ自動入力ボタンは `isUnderbar && siteKey === "realpro"` のときのみ表示
- itandi自動入力ボタンは `isUnderbar && siteKey === "itandi"` のときのみ表示（!isUnderbarは誤り）
- Clipboard API: isUnderbar=true のとき navigator.clipboard を使わず execCommand("copy") を直接使用（Permissions Policyエラー対策）

---

## 🗺️ 現在の機能（2026-05-18 時点）

### 検索モード（v1.4.0〜）
| モード | 説明 |
|---|---|
| 🎯 ピンポイント | 条件ぴったりで検索 |
| 🔎 広げて検索 | 家賃・エリア・広さを緩めて検索 |

※ モード切替はサイト選択後（view-instructions）に表示。以前はサイト選択前にあったが移動。

### 広げて検索のルール
| 項目 | ルール |
|---|---|
| 家賃 | 10万以下 → +5,000円 / 10万超 → +10,000円 |
| エリア（駅） | 隣の駅も追加で選択 ＋ 所在地（市区）でも検索 |
| エリア（所在地） | 同じ区内も対象 / 隣接エリアも視野に |
| 広さ | 30㎡未満 → −5㎡まで OK / 30㎡以上 → −10㎡まで OK |

### 物件検索ブレイン（エリア仕分けロジック）

> **呼称**: このローカル分類ロジック全体を「物件検索ブレイン」と呼ぶ。LINE返信AI用のClaudeブレインとは別物。

#### classifyAreaTokens（2026-08-24 新設・仕分け担当の中核）
各トークンを6段階シグナルで独立分類し、曖昧なものは周囲の多数決で解決する：

```
① 〜線で終わる          → 路線（駅系）
② JR/阪急/阪神等プレフィックス → 駅（明確・最強シグナル）
③ 市区郡サフィックス     → 地域（明確）
④ STATION_LINE_MAP のみ → 駅
⑤ WARD_CODE_MAP のみ   → 地域
⑥ 両方 or 不明         → 周囲トークンの多数決で解決（同数は駅優先）
```

**重要**: STATION_LINE_MAP にある = 駅が最優先。
NEIGHBORHOOD_WARD_MAP（地名→区 の弱いシグナル）は STATION_LINE_MAP に負ける。
十三・平野など「駅名と同じ地名」はSTATION_LINE_MAPがあれば常に駅として扱う。
WARD_CODE_MAP（実際の区コード: 大阪市淀川区 等）だけが駅分類を上書きできる。

コンソールに `[AX] 仕分け: 駒川中野→station(station_map), 平野→station(station_map)...` が出力される。

#### setupAreaModeSelector
classifyAreaTokens の結果を受けてグローバルモード（駅 or 地域）を決定する。

### 不明トークン発生時の三博士相談フロー
```
お客さんの条件にマップ未収録の X が出現
  ↓
#43-EK（駅博士）「X は大阪の駅ですか？」
  → 駅 → #43-KN が STATION_LINE_MAP に追加 → 解決
  → 駅ではない → #43-GK（地域博士）「X は大阪の地名ですか？」
      → 地名 → #43-GK が NEIGHBORHOOD_WARD_MAP に追加 → 解決
      → 不明 → 竹内悠馬に確認（推測でコードを書かない）
```

### 駅→沿線マッピング（STATION_LINE_MAP）
主要大阪府内の駅を収録。駅名から選択すべきリアプロ沿線名を自動表示。
例: 堺筋本町 → 大阪市高速軌道中央線 / 大阪市高速軌道堺筋線

### 駅→市区マッピング（STATION_WARD_MAP）
広げて検索時に所在地絞り込み用の市区を自動表示。
例: 堺筋本町 → 大阪市中央区

**収録済み駅数**: 約185駅（大阪府全主要駅網羅）
**最終更新日**: 2026-05-19

---

## 🔧 実装済みの改善履歴

| 日付 | 内容 |
|---|---|
| 2026-08-24 | **電車での通勤距離ステップ追加**: `buildCondData()`に`commuteByTrain`フィールド追加（`desired_area`から「○○駅まで電車で△分」正規表現でパース）。realpro/itandi/reinsの手順ステップに「電車での通勤距離: 北加賀屋まで電車で45分以内」を表示。徒歩パターン・bareパターンは対象外（電車/バスキーワード必須）。Dijkstra展開済みなので絞り込み欄への追加入力不要と案内。 |
| 2026-08-24 | **物件検索ブレイン: classifyAreaTokens で仕分け担当を強化（commit 741dd11b）**: 駅/地域の分類を6段階シグナルで独立判定。JR/阪急プレフィックスを最強シグナルに。STATION_LINE_MAP にある駅名は NEIGHBORHOOD_WARD_MAP に登録されていても駅優先（十三・平野 等）。コンテキスト多数決で曖昧トークン解決。 |
| 2026-08-24 | **物件検索ブレイン: 能勢電鉄/谷町線全駅誤選択バグ修正**: ①popup-maps.js: 「平野」を谷町線のみに修正（能勢電鉄平野は川西市の別駅）②popup.js decomposeToken第4フォールバック: 「谷町線駒川中野」→`["谷町線","駒川中野"]`が全線展開するバグを修正、`[stk]`のみ返す（路線名を除去） |
| 2026-08-24 | **setupAreaModeSelector null クラッシュ修正**: underbarモードのバルク検索中に`area-mixed-notice`のnullアクセスでボタンが押せなくなるバグを修正。currentAreaMode の設定をDOM要素ルックアップより前に移動し、null時はUIスキップして続行。 |
| 2026-08-20 | **itandi 地域モード ward_names API補完修正（commit 5408c1b）**: 地域（所在地）モードでリアプロは正しく選択されるのにitandiでは選択されないバグを修正。根本原因: リアプロは`apiData.realpro.city_codes`でAPI補完するのに対し、itandiは`ward_names`のAPI補完ロジックが存在しなかった。→ popup.js L2790-2795に補完ブロック追加（`apiData.itandi.ward_names`を`allNeighborhoodWards`にpush）。background.jsの一括検索パスでは既に補完済みだったが通常popupパスに欠けていた。 |
| 2026-08-17 | **エリア正規化 + area_normalizedDB書き戻し実装（commit d84eec5）**: ①`STATION_ALIASES`マップ追加（popup.js・resolution-core.js）: ひらがな・略称入力を正式駅名に変換（なんば→難波, 天六→天神橋筋六丁目 等25エントリ）。`resolveStation()`先頭で参照されモード判定・路線解決すべてに波及。②`normalizeAreaWithDeepSeek()`追加（resolve-area/route.ts）: DeepSeekでエリア文字列を正規化しHaikuNL抽出と並行実行。`normalized_area`フィールドをレスポンスに追加。③popup.jsの`resolveAreaWithAPI`に`customerId`引数追加。API応答の`normalized_area`を`property-customers`テーブルにPATCH書き戻し（fire-and-forget）。④`migrate-schema/route.ts`に`area_normalized TEXT`カラム追加。 |
| 2026-08-17 | **LEARNED_STATION_MAP収録駅が地域モード誤判定されるバグ修正**: `setupAreaModeSelector`の`hasStationToken`がLEARNED_STATION_MAPを参照していなかった。また`buildAreaRouteCodes` autoモードで学習済み駅が`resolveWard`に先取りされ地域コードに落ちるバグを修正。リアプロautofillハンドラにitandi側と同等のLEARNED補正ブロック追加。修正: popup.js(3箇所) + resolution-core.js(1箇所)。commit `cc7cb2d` |
| 2026-08-17 | **リアプロ駅選択 根本修正（station_code[]→station_id[]）**: 診断ログでリアプロのDOM変更が判明（`station_code[]`=0件、`station_id[]`=56件）。page-script.jsの全箇所（STEP Dガード・vis guard・残留クリア・STEP6・checkboxNames・_doReset）を`station_id[]`に全置換。STEP DのvisガードもラベルベースからSTEP D`station_id[]`親要素ベースに変更（駅セクション描画待ちの確実化）。コミット`f6f29fe` |
| 2026-08-16 | **itandi BB 間取り選択 + リアプロ駅選択 2バグ修正**: ①itandi-page-script.js: `tick(querySelector(id))`がnull時にsilent failしていたのを修正。`tickFloor()`追加→IDセレクタ失敗時はラベルテキストでフォールバック検索。②page-script.js: `selectStationsByName`にSTEP6追加→`input[name="station_code[]"]`を直接親テキストで検索（ラベルにcheckboxが紐づかないDOM構造対応）。③STEP D検証にinput-based fallback追加→`_checkedCount=0`のとき全station_code[]を走査して照合・駅モーダルに存在しない地域名（堀江等）は自動スキップ→実在する駅が1件でも確認できれば検索通過 |
| 2026-08-06 | **「依頼中…」停止バグの根本修正**: 根本原因はVercel本番に`SUPABASE_SERVICE_ROLE_KEY`未設定で/api/automation/pending・status・update・triggerが空500クラッシュ→拡張ポーリングが無音スキップ→scrape_and_compareが一切実行されず。①4ルートにanonキーフォールバック+明示的JSONエラーガード追加（automation_commandsはRLS無効のため機能同等。ただしservice_roleキーのVercel設定は依然推奨）②background.js `_pollAndRunBatch`のHTTPエラーをconsole.warn+`chrome.storage.local.lastPollError`に記録（無音スキップ廃止）③`_webappAutofill`のリアプロタブ検索をmain.php優先に修正（ログイン画面タブを掴むと条件送信が無音消失するバグ）、main.php以外のタブしか無ければナビゲートしてから使用④executeScriptフォールバック失敗時はthrowしてstatus:'error'がDBに記録されるように⑤page.tsx: ScrapeCompareStatusに"timeout"追加、6分でdone/error未到達なら「⏰タイムアウト」表示→5秒後idle（旧実装はrunningのまま永久固着）、ボタンに状態別カラー（done=緑/error=赤/timeout・noext=アンバー）⑥滞留していたpending 8件はDBでstatus='error'に掃除済み |
| 2026-08-08 | **区名+駅名連結トークン分解バグ修正**: "鶴見区横堤駅 稲田新町近辺"のような「区名+駅名」連結テキストが正しく分解できなかったバグを修正。①`decomposeToken`に第3フォールバック追加（末尾がSTATION_LINE_MAPにある駅名で前半がresolveWardで解決できる場合に分解: "鶴見区横堤"→["大阪市鶴見区","横堤"]）②wardモードの`buildAreaRouteCodes`を`resolveWard`→`resolveWardLoose`に変更（区名+後続テキストの連結でも先頭の区名を正しく抽出）③`computeUnknownTokens`の排除ガード`!/[都道府県市区郡]/`を`!resolveWardLoose(t)`に変更（区を含む連結トークンが誤ってAPIスキップされないように） |
| 2026-08-06 | **v2.5.0: WebApp→Chrome拡張 物件検索ブリッジ実装**: page.tsxの顧客条件パネルに「🔍 物件検索」ボタン＋「リアプロで検索」「itandiで検索」サブメニューを追加。押すとwebapp-bridge.js(content script)経由でbackground.jsに転送→対象サイトのタブを開いて自動入力実行。Chrome拡張IDをWebAppに公開しないpostMessage+origin検証設計 |
| 2026-07-23 | v2.4.2: 連結区名対応（「西区北区都島区中央区」→「大阪市西区　大阪市北区　大阪市都島区　大阪市中央区」）。decomposeToken第2フォールバック追加（NEIGHBORHOOD_WARD_MAP+WARD_CODE_MAP）・realpro表示にmultiWardLabel追加 |
| 2026-07-15 | Chrome拡張フィードバックUI追加: popup.html に💬ボタン＋モーダル・popup.js に送信ロジック（POST /api/chrome-extension-feedback）・styles.css にスタイル追加 |
| 2026-07-15 | NEIGHBORHOOD_WARD_MAP から重複トークン4件削除（天満・日本橋・帝塚山・文の里）: STATION_LINE_MAPに収録済みのため地域として検索されてしまうバグを修正 |
| 2026-07-15 | /api/chrome-extension-feedback 新設: POSTでフィードバック保存・GETで最新50件取得。Supabase chrome_extension_feedback テーブル新設（category/content/area_raw/token/site/resolved）|
| 2026-07-06 | score-overlay.js 新規追加: 物件検索結果に条件マッチ度スコア表示（◎85+/○70+/△55+/×）。API不使用・コスト0・MutationObserver自動再スコア |
| 2026-06-09 | itandi PDF キャプチャ時にAdobeが開く問題を修正: onCreated内でchrome.downloads.cancel()を即座に呼ぶことでファイル保存をキャンセル（LINEにだけ送る用途なのでファイル不要） |
| 2026-06-08 | ミニボタン→パネル再展開バグ修正: doExpand()のcross-origin contentDocument=null問題を修正（`!fr.contentDocument\|\|` 削除）✅ |
| 2026-06-04 | parseAreaTokens に「か・や」区切り対応追加（「豊崎か北区」→「豊崎,北区」に分割） |
| 2026-05-17 | Chrome拡張を初期作成（リアプロ・itandi・レインズ対応） |
| 2026-05-17 | サイドパネル化（setPanelBehavior API使用） |
| 2026-05-17 | ピンポイント/広げて検索モード追加 |
| 2026-05-17 | 所在地/沿線の自動判定ロジック追加（町を除外） |
| 2026-05-17 | 駅→沿線マッピング（STATION_LINE_MAP）追加 |
| 2026-05-17 | 駅→市区マッピング（STATION_WARD_MAP）追加 |
| 2026-05-17 | 広げて検索時の所在地アナウンス追加 |
| 2026-05-17 | アンダーバーモード実装（リアプロでviewport幅を狭めない固定バー）v1.3.0 |
| 2026-05-17 | content.css追加（manifest css注入でCSSが文字列として表示されるバグを修正） |
| 2026-05-17 | フローティングミニボタン実装（左上52×52px）v1.3.5 |
| 2026-05-17 | ⚡リアプロ自動入力ボタン実装 v1.3.6〜1.3.9 |
| 2026-05-17 | ピンポイント/広げて検索をサイト選択後に移動・折りたたみボタン追加 v1.4.0 |
| 2026-05-17 | 一時調整フォームに構造・ペット相談フィールド追加 v1.4.0 |
| 2026-05-17 | 賃料一時調整のステップを1000円単位に変更 v1.4.0 |
| 2026-05-17 | リアプロpage-script.jsに構造(structured_type[])・ペット相談(eq_rm[]=113)自動入力追加 |
| 2026-05-17 | bulk-dl.js: リアプロ印刷用PDF一括ダウンロード機能追加（フローティングバー）|
| 2026-05-17 | 駅・沿線マッピング精度向上（阪神・おおさか東線・モノレール・近鉄南大阪線等追加） |
| 2026-05-17 | 三国ヶ丘の路線マッピングバグ修正（大阪環状線→阪和線）|
| 2026-05-17 | itandi BB手順を実際のDevTools調査に基づき精度向上（ITANDI_LINE_MAP追加）v1.4.6 |
| 2026-05-17 | itandi BB自動入力機能追加（賃料・徒歩・間取り・構造・ペット）v1.4.7 |
| 2026-05-17 | itandi BB所在地・路線自動選択追加（モーダル自動操作）v1.4.8 |
| 2026-05-18 | itandi BB 検索ボタン自動クリック追加（条件入力→検索まで全自動）v1.4.9 |
| 2026-05-18 | itandi BB 路線モーダルで駅選択を実装（路線チェック後800ms待機→駅を部分一致で選択→確定）v1.5.0 |
| 2026-05-18 | itandi BB 駅名から「駅」サフィックス除去して検索（「堺筋本町駅」→「堺筋本町」）v1.5.0 |
| 2026-05-18 | itandi BB 広げて検索で前後1駅＋当駅を複数選択（LINE_STATION_ORDER自動導出）v1.5.1 |
| 2026-05-18 | itandi BB ナビタブ誤クリック修正: clickNav()新設（完全一致）で「近畿」「大阪府」タブを正確にクリック v1.5.1 |
| 2026-05-18 | itandi BB 当駅除外バグ修正: 駅選択をforEach→順番クリック（300ms間隔）に変更（React再描画対策）v1.5.2 |
| 2026-05-18 | 拡張ツール初期サイズ1.5倍化: INIT_W 360→540px, INIT_H 520→780px (underbar.js) v1.5.2 |
| 2026-05-18 | itandi・レインズに一時調整フォーム追加（リアプロと同機能・DBは変更しない一時変更）v1.5.3 |
| 2026-05-18 | itandi条件バグ修正: isUnderbar→!isUnderbarに変更（サイドパネルでautofillBtn表示されない問題）v1.5.3 |
| 2026-05-18 | renderInstrSteps()にcOverrideパラメータ追加（レインズ手順更新機能の基盤）v1.5.3 |
| 2026-05-18 | リアプロ自動入力後の検索ボタン自動クリック実装（駅あり→1200ms / なし→600ms遅延）v1.5.4 |
| 2026-05-18 | リアプロ page-script.js に selectStationsByName()追加（ラベル文字列一致で駅チェックボックス選択）v1.5.4 |
| 2026-05-18 | Clipboard API Permissions Policyエラー修正: isUnderbar=trueのときclipboard API完全スキップ→execCommand直接使用 v1.5.4 |
| 2026-05-18 | ITANDI_LINE_MAP_FILLをonclick内からトップレベルconstに移動（パフォーマンス改善）v1.5.4 |
| 2026-05-18 | 顧客データsessionStorageキャッシュ実装（TTL 5分・更新ボタンで強制リフレッシュ）v1.5.4 |
| 2026-05-18 | Manifestに"tabs"権限追加・chrome.tabs.get()にlastErrorチェック追加（拡張エラーバッジ修正）v1.5.4 |
| 2026-05-18 | Clipboard API Permissions Policy完全修正: underbar.jsからiframe.allow="clipboard-write"削除・navigator.clipboard削除→execCommandのみ v1.5.6 |
| 2026-05-18 | itandi自動入力のchrome.tabs→postMessage中継に変更（iframe内でchrome.tabs使用不可のため）popup.js→underbar.js→itandi-content.js v1.5.7 |
| 2026-05-18 | itandi 広げて検索で当駅が選択されないバグ修正: clickLabel()に!inp.checked ガード追加（React自動チェック→再クリックでトグルOFFになる問題）v1.5.8 |
| 2026-05-18 | レインズ手順を実際のフォーム画面をもとに実装: 物件種別/沿線・駅or所在地/徒歩/賃料/間取タイプ/築年月/設備・条件 v1.6.0 |
| 2026-05-18 | REINS_LINE_MAP追加: 内部名(大阪市高速軌道/阪急電鉄/南海電鉄など)→REINS表記(大阪メトロ/阪急/南海など)変換 53路線対応 v1.6.1 |
| 2026-05-18 | REINSフォーム調査: 全フィールドはselect/option構造(li不使用)・沿線モーダルは2ステップ(地域→都道府県→次へ→路線select) |
| 2026-05-18 | REINS自動入力実装: reins-page-script.js/reins-content.js新規作成・manifest.jsonにsystem.reins.jp追加 v1.7.0 |
| 2026-05-18 | REINS自動入力: 物件種別/沿線名/駅名/徒歩/賃料/間取タイプを自動入力→検索ボタン自動クリック |
| 2026-05-18 | REINS登録年月日ラジオボタン自動選択追加（指定なし/当日/3日以内/1週間以内/1ヶ月以内）・popup.htmlに登録日ドロップダウン追加 |
| 2026-05-18 | REINSフォーム遅延レンダリング問題を発見・修正: fill()の先頭でwindow.scrollTo(0,0)+800ms待機を追加（フォーム下部表示時にindexがズレる問題の対策）|
| 2026-05-18 | REINSフィールドインデックス確定（DevTools全調査完了）: 沿線名1=47, 駅名FROM1=48, 駅名TO1=49, 徒歩1=50, 徒歩unit=51 / フィールド総数=139固定 |
| 2026-05-19 | 大阪全駅対応: STATION_LINE_MAP/LINE_STATION_ORDER/STATION_WARD_MAP大幅拡充 +35駅 |
| 2026-05-20 | itandi 500エラーの根本原因特定・修正: モーダルが開けないとき即座にcallback()→検索が発火していたバグ→boolean返却+安全網タイマーパターンに変更 |
| 2026-05-20 | itandi clickNav()バグ修正: LABELタグが検索対象に含まれていなかった→querySelector に label を追加 |
| 2026-05-20 | ITANDI_LINE_MAP_FILL修正・15路線追加: 関西本線表記修正・南海空港/汐見橋/多奈川/高師浜・京阪中之島/交野・JR桜島/福知山/東海道/関西空港・近鉄長野/道明寺・阪堺電軌阪堺/上町・能勢電鉄・水間鉄道 |
| 2026-05-20 | リアプロ自動入力タイミング延長: 沿線クリック後1800ms→「駅の設定へ進む」2900ms→駅選択4000ms→モーダル閉4900ms→検索5700ms |
| 2026-05-20 | 3サイト路線名分離ルール確立: #43-RP/#43-IT/#43-RN を各サイト表記の守護者に指定（竹内悠馬明示的指示） |
| 2026-05-20 | itandi 複数駅パース対応: desired_areaが「吉田町、東花園、新石切」等の複数駅指定の場合、split→各駅ごとにSTATION_LINE_MAP照合→全路線を集約してitandi_linesに渡す。末尾「町/村」を除いて再試行する部分一致フォールバック付き |
| 2026-05-20 | リアプロ 詳細地域対応: NEIGHBORHOOD_WARD_MAP追加（大阪府全域・約150エントリ）。区略称（平野区→大阪市平野区）＋地域名（喜連西等）対応。ピンポイント: 詳細地域モーダル自動クリック（8段階フォールバック）。広げて検索: 区選択のみ |
| 2026-05-20 | リアプロ 所在地モーダル: 広げて検索でもモーダル経由に変更（直接checkboxが反映されなかったバグ修正）。popup.js: 広げて検索でもdetail_wardを渡す。page-script.js: hasModalWard=detail_wardで判定・ステップ間隔1200ms（500→1700→2900→[4100]→5300→6500ms） |
| | 追加路線: 今里筋線全11駅・南港ポートタウン線全7駅・南海本線市内(今宮戎/粉浜/七道) |
| | JR阪和線市内(美章園/南田辺/鶴ヶ丘/我孫子町/杉本町/浅香)・JR難波(関西本線) |
| | 近鉄けいはんな線(長田/荒本/新石切)・阪急箕面線(石橋阪大前/桜井/牧落/箕面) |
| | 片町線追加(徳庵/住道)・大阪梅田に阪神本線追加 |
| 2026-05-20 | NEIGHBORHOOD_WARD_MAP大幅拡充（60+エントリ追加）: 城東区(稲田本町・稲田新町・稲嶋等)・平野区(長吉西・川筋・川保本町・加美・瓜破等)・東住吉区・生野区・旭区・西成区・住吉区・阿倍野区・淀川区・東大阪市・枚方市・高槻市・茨木市・八尾市 #43-GK新設 |
| 2026-05-20 | 新メンバー追加: #43-GK（大阪地域博士・NEIGHBORHOOD_WARD_MAP守護者）・#43-EK（大阪駅博士・不明トークン第一相談窓口）・#43-AX・#43-RG・#43-WD・#43-WX |
| 2026-08-10 | 乗り換えグラフDB実装: build-transit-graph.js自動生成→transit_graph.js（422駅・全沿線・1048エッジ）。getStationsWithinTransfers() BFS追加。乗り換えN回UI（enableTransfer/maxTransfers）追加。popup.htmlスクリプト順: popup-maps.js→transit_graph.js→popup.js |
| 2026-08-10 | BFS走査バグ修正: node.adjはオブジェクトのためfor..ofが失敗→Object.values(node.adj)でedge.to/edge.lineを取り出すよう修正 |
| 2026-08-11 | **itandi ハブ駅展開実装**: popup.js itandiLines構築ループをSTATION_HUB_MAP対応に変更。梅田→[梅田,東梅田,西梅田,大阪梅田,大阪]等、全ハブ駅のDB/静的マップ路線を集約（リアプロと同等の路線数を選択）。stationNames構築にもハブ展開追加（各路線モーダルで駅クリックが効くよう）。commit 38bbbe3 |
| 2026-08-11 | **ITANDI_LINE_MAP_FILL欠落キー追加**: 能勢電鉄妙見線/日生線・近鉄信貴線・近鉄西信貴ケーブル線をITANDI_LINE_MAP_FILLに追加（STATION_LINE_MAPで使われるリアプロ路線名なのに変換エントリが無かった）。commit 38bbbe3 |
| 2026-08-12 | **itandi BB 路線・駅が自動選択されないバグ3箇所修正（Fable5調査）** commit b3af969。[BUG-1] itandi-content.js L210-211: URLパラメータ経由（スマホ/LINEリンク）で`itandi_lines:[]` `station_names:[]`がハードコードされており、常に路線・駅が未入力になっていた → `c.itandi_lines||[]` `c.station_names||(c.station?[c.station]:[])` に修正。[BUG-2] itandi-page-script.js pollLineList(): `document.querySelectorAll("label")`が全ページ対象のため間取り等の常時表示チェックボックスに早期反応し、路線リスト未描画の段階でstartClickLines()が発火→全路線false→_abort()していた → `[role="dialog"]`内のラベルのみに限定。[BUG-3] clickLabel()にcontainerパラメータ追加、startClickLines(dlg)が受け取ってclickLabel(lineNames[lineIdx], dlg)で渡す。 |
| 2026-08-12 | **v2.5.0: 顧客間条件混線バグ完全修正（Fable5調査→実装）** commit 876b95d。[CRITICAL-1] `_fillDoneWaiters`に`customerId`追加 → `_notifyFillDone(site, customerId, error)`が一致したウェイターのみ解決（顧客Aの遅延fill-doneが顧客Bのウェイターを誤解決するバグ根絶）。[CRITICAL-1] content.js/itandi-content.js に`axlx-set-fill-customer`受信処理追加 → fill-done relay時に`customerId`を付与。`_batchAutofill`の各サイト分岐でswitch-customer送信前に`axlx-set-fill-customer`を送信。[HIGH-1] `_batchCustomerDoneWaiters`に`customerId`追加 → `_notifyBatchCustomerDone(customerId, propertyCount)`でフィルタ。[HIGH-2] popup.js: `searchMode` reset 3箇所に`else`分岐追加（`is_wide=false`時も`pinpoint`ボタンをクリック・前顧客のwide状態引継ぎバグ防止）。 |
| 2026-08-13 | **リアプロ「全ページ送る」タイムアウトバグ修正（Fable5調査→実装）**。[ROOT-CAUSE] `hasNextPageBtn()`がdisabled属性・CSSクラス.disabledの「次」ボタンを「次ページあり」と誤検出。→ `clickNextPageBtn()`がdisabledボタンをクリックして失敗 or 同じページに留まる → `axlx-batch-customer-done`シグナル未送信 → background.js 5分タイムアウト → LINEにタイムアウト警告。[FIX-1] `_isDisabledEl(el)`ヘルパー追加（el.disabled/aria-disabled/disabled属性/.disabled/.is-disabled/.btn-disabled/.pagination-disabled クラスを検出）。[FIX-2] `hasNextPageBtn()` / `clickNextPageBtn()` の両フェーズで`_isDisabledEl(el)`チェックを追加しdisabledボタンをスキップ。[FIX-3] `tryNext()` line 723-725: `clickNextPageBtn()`がfalseを返した場合（=クリック失敗）にも`axlx-batch-customer-done`シグナルを送信するフェイルセーフ追加。 |
| 2026-08-16 | **本町・福島・新大阪がリアプロ駅選択されないバグ修正** commit 45879a2。resolve-area APIのClaude Haikuシステムプロンプトで「本町」「福島」「新大阪」が`areas`に分類→CONCEPT_AREA_MAP経由でcity_codesのみ生成→wardモード切替→station_names消去の連鎖バグ。梅田/難波/心斎橋と同様に駅名exemptionリストに追加して`stations`として分類されるよう修正。 |
| 2026-08-16 | **要対応タブ判定をアプリと統一** commit TBD。`needsActionToday()` を `linked_conversation.is_flagged===true && !_POST_APPLY_STATUSES.has(conv.status)` に変更。アプリのフラグトグルと完全同期。タブクリック時に `loadCustomers(true)` で強制リフレッシュ（キャッシュバイパス）。 |
| 2026-08-16 | **リアプロ駅選択：前顧客の駅残留混入バグ修正（Fable5調査→実装）** commit TBD。page-script.js のみ変更。[ROOT-CAUSE] 沿線・駅モーダルはJS内部状態で前回選択を記憶し再描画時にcheckedを復元するが、STEP Dの残留クリアが「一回限りフラグ＋ページ全体labelでの描画判定」だったため、駅リスト未描画の初回パスでクリアが空振り→永久ロックし、同一沿線の前顧客駅が混入していた（例: もえさん京橋・桜ノ宮検索）。[FIX-1] STEP D描画判定を `input[name="station_code[]"]` の存在に変更＋`_modalStationsCleared`フラグ撤廃で毎パスクリア（`:checked`のみ対象＋`__axPending`＋実行時checkedガード`_unclickIfChecked`で冪等・二重トグル防止）。isVisibleフィルタ除去で非表示セクションの残留も解除。温存判定を双方向includes→完全一致＋双方向前方一致（selectStationsByNameと同一基準）に厳格化。[FIX-2] 沿線のみ（hasStation=false）パスにも駅全クリア追加（最大3秒待機、未描画なら従来どおり閉じて検索）。[FIX-3] STEP D成功判定を`.some()`→「DOMにマッチする指定駅は全てchecked かつ1駅以上checked」に変更（複数駅指定で一部未選択のまま検索されるバグ修正。全滅時はfallbackSearchWithoutStationで中止＝全件検索防止は維持）。[FIX-4] selectStationsByName STEP2〜4に`isElChecked()`トグルガード追加（checked済みならfireClickスキップ、STEP1/5と同等）。 |
| 2026-08-16 | **itandi BB 間取りCB silent fail 修正 + リアプロ駅選択タイムアウト修正** commit 5ccd825。[itandi] `tickFloor(id)` 追加: ID失敗時にラベルテキストでフォールバック検索（5K_OVER→"5K以上"マッピング含む）。[リアプロ] `selectStationsByName` STEP6追加: `input[name="station_code[]"]` を親テキストで直接照合。`_allMatchedChecked` 検証に input-based fallback追加: ラベル↔checkbox 紐付きなし構造で `_checkedCount=0` になる場合を救済（駅モーダルに不存在の名前はスキップ=通過）。 |
| 2026-08-16 | **APIレスポンスの非駅トークンをstation_namesから除外** commit 5020a51。`isKnownStation(name)` 追加（STATION_LINE_MAP / _dbStationRouteMap / LEARNED_STATION_MAP の順で照合）。リアプロ・itandi両側のAPI補完パス（`apiData.realpro.station_names` / `apiData.itandi.station_names`）に適用。resolve-area AIが "堀江" 等の地域名を駅と誤分類しても station_names に混入しない。非駅トークンは `[AX] API補完: 非駅トークンを除外: xxx` でログ出力。 |
| 2026-08-18 | **一括検索2バグ修正（Fable5）**: ①複数顧客で全ページ送る失敗（偽0件レース＋固定5分タイムアウトの送信中破壊）→ pagehideタイマー破棄・0件確定を tracked=0 限定＋25秒化・`axlx-batch-progress` ハートビートで無進捗5分タイムアウト化。②一括検索でもLINEに🌟一番オススメ → `current_customer_conditions` をstorage保存しフォールバックで条件をAIランキングに復元。詳細は下記「一括検索『複数顧客で全ページ送る失敗』」セクション。bulk-dl.js / itandi-bulk-dl.js / popup.js / background.js |
| 2026-08-18 | **AIXLINX顧客リストに地域/駅バッジ表示追加** commit ceb0b5f。`computeAreaModeBadgeHtml(areaText)` 追加（popup.js:2011）。駅判定: /駅\|線/ or STATION_LINE_MAP/LEARNED_STATION_MAP。地域判定: /市区府県都郡/ or WARD_CODE_MAP/NEIGHBORHOOD_WARD_MAP。renderCustomerRowのc-nameにバッジ埋め込み。駅バッジ（青 #1565c0）・地域バッジ（緑 #2e7d32）CSSをstyles.cssに追加。両方ある場合は両バッジ表示。 |
| 2026-08-16 | **popup UI 3点改善** commit 96e99b9。[1] 要対応タブ（`🔥 要対応` `data-acct="__needs_action__"`）を「すべて」の左に追加（popup.html）。フィルター処理はpopup.jsで `data-acct === "__needs_action__"` 時に未対応（approved/lost/contracted以外）顧客のみ表示。[2] `bulk-dl.js` フローティングバーを右下→上部中央に移動（`top:10px;left:50%;transform:translateX(-50%)`）＋ドラッグハンドル追加（`#axlx-drag-handle`、mousemove/mouseup/mouseleaveでtransformを上書き）。[3] `#staff-mode-btn` のテキストから「🙋」を削除。ON時「スタッフモード中」/OFF時「スタッフモード」のみ。 |

---

## 👥 チーム編成（2026-05-20更新）

| メンバー | 役割 |
|---------|------|
| **#43-AI** | **竹内AI分身**（ビジョン・判断軸・優先順位） |
| **#43-SZ** | **鈴木AI分身**（実装・運用・実行の右腕） |
| **#43-SM** | **スモ山分身**（部署全体統括・メンバー調整） |
| **#43-AX** | **AIXLINX部長分身** ← 2026-05-20新設（#36部長コピー。現場業務フロー全体を監視・他部署連携・バグの現場インパクト評価） |
| **#43-RG** | **変更影響分析専任** ← 2026-05-20新設（変更"前"に影響範囲を分析・依存マップ管理・`dept_feature_manifest.md`でベースライン維持） |
| #43 部長 | 全体統括・手順精度・記録監督 |
| #43-T | テスト・動作確認 |
| #43-B | バグ根本原因特定 |
| #43-KN | **大阪地名・駅名専門家** 兼 マッピング管理（STATION_LINE_MAP・STATION_WARD_MAP・ITANDI_LINE_MAP_FILL・REINS_LINE_MAP）|
| **#43-RP** | **リアプロ専任**（最重要・所在地/沿線/自動入力・**リアプロ路線名表記の守護者**） |
| **#43-IT** | **itandi BB専任**（手順整備・自動入力実装済み・**itandi路線ラベル名の守護者**） |
| **#43-RN** | **レインズ専任**（手順整備中・**REINS路線テキスト名の守護者**） |
| **#43-DOM** | **DOM診断専任**（実DOM構造を事前調査・`dept_dom_db.md`に記録・バグを予防） |
| **#43-QA** | **デグレ監視担当**（変更後に全サイト全機能チェックリストを実行・壊れを即検知） |
| #43-UX | UI/UX改善・**自動入力進捗表示**（STEP N/M: ○○中…をUI上に表示） |
| #43-W | 第1倉庫管理人（dept_search_tool.md 一次記録） |
| #43-W2 | 第2倉庫管理人（バックアップ・断絶時代行） |
| **#43-W3** | **DOM倉庫管理人**（`dept_dom_db.md` 一次記録・確認済みDOM情報の管理） |
| **#43-EV** | **イベント専任**（native .click / simulateClick / fireClick 使い分け・サイト別イベントメソッド台帳）【2026-05-20新設】 |
| **#43-CP** | **条件パーサー担当**（「3LDK以上」等テキストパターン変換・エッジケース管理・条件フォーマット品質保証）【2026-05-20新設】 |
| **#43-ST** | **状態機械専任**（多段モーダルの全入口状態設計・ensureXxx()系関数設計・「どの状態から入っても動く」保証）【2026-05-20新設】 |
| **#43-GK** | **大阪地域博士** ← 2026-05-20新設（大阪府全域の地名・町域を完全把握。`NEIGHBORHOOD_WARD_MAP`の守護者） |
| **#43-GKA** | **大阪地域リサーチ助手** ← 2026-05-20新設（#43-GK助手。地名追加前に隣接区・市境を3点チェック。⚠️フラグで不確実エントリ管理。川保誤登録の再発防止役） |
| **#43-EK** | **大阪駅博士** ← 2026-05-20新設（大阪府全域の全駅・全路線を完全把握。「これは駅か？」の最終判断を下す） |
| **#43-EKA** | **大阪駅リサーチ助手** ← 2026-05-20新設（#43-EK助手。駅・路線追加前に路線図と照合。⚠️フラグで不確実エントリ管理） |

---

## ⚡ リアプロ自動入力機能（v1.4.0 完成）

ボタン1つでリアプロの検索フォームにお客さんの条件を自動入力する機能。
**アンダーバーモード（フローティングパネル）限定**。

### 自動入力される項目
| 条件 | リアプロフォーム |
|---|---|
| 希望エリア（駅名）| route_id[]（沿線）+ city_code[]（市区） |
| 希望エリア（市区名）| city_code[]（市区） |
| 賃料上限 | rental_cost2 (SELECT) |
| 賃料下限 | rental_cost1 (SELECT) |
| 徒歩分数 | transportation_id=1 + required_time |
| 築年数 | structured_date (SELECT) |
| 間取り | room_layout_id[] (checkbox) |
| 構造 | structured_type[] (checkbox) |
| ペット相談 | eq_rm[]=113 (checkbox) |

### 一時調整フォーム（adj-form）
アンダーバーモードでリアプロ選択時に表示。DBを変更せず一時的に条件を調整できる。
項目: エリア / 賃料上限（1000円刻み）/ 徒歩 / 築年数 / 間取り / 構造 / ペット相談チェック

---

## ⚡ itandi BB自動入力機能（v1.4.9 完成）

ボタン1つでitandi BBの検索フォームに条件入力→検索まで全自動。
**サイドパネルモード限定**（itandibb.com を開いている状態）。

### 自動入力される項目
| 条件 | itandiフォーム |
|---|---|
| 賃料上限 | `rent:lteq`（万円単位に変換）|
| 管理費込み | `totalRentCheck`（常にチェック）|
| 駅徒歩 | `station_walk_minutes:lteq` |
| 築年数 | `building_age:lteq` |
| 間取り | `room_layout:in`（1R〜5K_OVER）|
| 構造 | `structure_type:in`（wooden/rc/src/steel等）|
| ペット相談 | `option_id:all_in[22010]` |
| バス・トイレ別 | `option_id:all_in[11010]`（preferences検出時）|
| 所在地 | 「所在地で絞り込み」モーダル（市区名指定時）|
| 路線 | 「路線・駅で絞り込み」モーダル（駅名指定時・路線チェック→駅選択→確定）|
| 検索実行 | 「検索」ボタン自動クリック（全入力完了後）|

### desired_area の判定ロジック
- 市区名（大阪市北区等）→ 所在地モーダル（大阪府 → 市区選択 → 確定）
- 駅名（梅田等）→ STATION_LINE_MAP → ITANDI_LINE_MAP_FILL で変換 → 路線モーダル

### ITANDI_LINE_MAP_FILL（リアプロ路線名 → itandi正式路線名）
DevTools実測に基づく正式名称を使用。大阪メトロは「高速電気軌道第N号線(大阪メトロ〇〇線)」形式（半角カッコ）。

### メッセージフロー
```
popup.js（サイドパネル）
  → chrome.tabs.sendMessage({ type: "axlx-itandi-autofill", conditions })
  → itandi-content.js（コンテンツスクリプト）
  → itandi-page-script.js を<script>タグで注入
  → CustomEvent "axlx-itandi-fill" で conditions を転送
  → fill(cond) → フォーム入力 → モーダル操作 → 検索ボタンクリック
```

---

## 📦 bulk-dl.js（リアプロ一括PDFダウンロード）

リアプロの物件一覧に各物件の「印刷用PDF」ボタン横にチェックボックスを注入。
フローティングバー（右下固定）から一括DLできる。

- チェックボックス: `.axlx-cb` クラス
- フローティングバー: `#axlx-bar`（全選択/全解除 + 一括DLボタン）
- 1.8秒間隔でPDFを順番にDL（ブラウザのダウンロード制限回避）
- MutationObserverで動的ページ変化に追従

---

## 🗺️ LINE_STATION_ORDER（路線別駅順・地理的手書き定義）

`popup.js` 内に全23路線を地理的正順で手書き定義済み（2026-05-18）。
自動導出（STATION_LINE_MAP定義順）は多路線共有駅で順序が狂うため廃止。

**収録路線一覧**（STATION_LINE_MAP収録駅のみ・中間未収録駅は省略）:
| 路線 | 駅数 | 備考 |
|---|---|---|
| 御堂筋線 | 18 | 江坂〜なかもず |
| 谷町線 | 25 | 大日〜八尾南（太子橋今市含む）|
| 四つ橋線 | 9 | 西梅田〜住之江公園 |
| 中央線 | 13 | コスモスクエア〜長田（**本町・谷町四丁目の順序修正**）|
| 千日前線 | 10 | 野田阪神〜今里 |
| 堺筋線 | 9 | 天神橋筋六丁目〜天下茶屋 |
| 長堀鶴見緑地線 | 14 | 大正〜門真南 |
| 今里筋線 | 11 | 井高野〜小路（全駅完全収録）|
| 北大阪急行 | 6 | 江坂〜箕面萱野 |
| 阪急神戸線 | 6 | 大阪梅田〜武庫之荘 |
| 阪急宝塚線 | 11 | 大阪梅田〜蛍池 |
| 阪急京都線 | 7 | 大阪梅田〜茨木市 |
| 阪急千里線 | 10 | 天神橋筋六丁目〜北千里 |
| 阪神本線 | 6 | 福島〜杭瀬 |
| 阪神なんば線 | 6 | 桜川〜西九条 |
| 南海南本線 | 7 | 新今宮〜堺 |
| 南海高野線 | 9 | 新今宮〜なかもず |
| 京阪本線 | 13 | 淀屋橋〜門真市 |
| 大阪環状線 | 17 | 大阪〜天満（環状）|
| JR東西線 | 6 | 北新地〜放出 |
| おおさか東線 | 6 | 放出〜JR久宝寺 |
| 近鉄難波・奈良線 | 10 | 大阪難波〜近鉄八尾 |
| 近鉄南大阪線 | 7 | 大阪阿部野橋〜帝塚山 |
| 近鉄大阪線 | 8 | 大阪上本町〜近鉄八尾 |
| 近鉄けいはんな線 | 3 | 長田〜新石切 |
| モノレール本線 | 8 | 大阪空港〜門真市 |
| モノレール彩都線 | 3 | 万博記念公園〜彩都西 |
| 南港ポートタウン線 | 7 | コスモスクエア〜住之江公園（全駅）|
| 阪急箕面線 | 4 | 石橋阪大前〜箕面 |
| JR阪和線 | 11 | 天王寺〜和泉府中（市内駅追加）|
| 片町線 | 4 | 放出〜住道 |
| 関西本線 | 1 | JR難波 |

**追加する際のルール**:
- STATION_LINE_MAP に駅を追加したら LINE_STATION_ORDER の該当路線にも地理的順序で追加
- 兵庫・京都・奈良の駅は該当路線の terminus 側に追記していく

---

## ⚡ REINS自動入力機能（v1.7.0 実装・テスト待ち）

**確定フィールドインデックス**（DevTools全調査完了・2026-05-18）:
| フィールド | idx | 備考 |
|---|---|---|
| 物件種別1 | 5 | SELECT → "賃貸マンション" をテキスト一致で選択 |
| 沿線名1 | 47 | text input (完全一致) |
| 駅名FROM1 | 48 | text input (完全一致) |
| 駅名TO1 | 49 | text input (完全一致) |
| 徒歩1 | 50 | text/number input |
| 徒歩単位1 | 51 | SELECT [/分/ｍ] |
| 沿線名2 | 54 | 広げて検索の将来対応用 |
| 賃料上限 | 76 | 万円単位で設定 |
| フィールド総数 | 139 | querySelectorAll('input[text/number], select') の合計 |

**遅延レンダリング問題**: フォーム下部が表示されているとき querySelectorAll が上部フィールドを含まず idx がズレる
→ **fix**: fill() 先頭で `window.scrollTo(0, 0)` + `await sleep(800)` で全フィールドを確実にレンダリング

**所在地/沿線 の構造**（所在地が沿線より前にある）:
- 所在地1 (idx ~20-28): 都道府県名・所在地名1・所在地名2・建物名 + 各match SELECT
- 所在地2 (idx 29-34): 同上
- 所在地3 (idx 35-46): 同上（idx 46がSELECT[前方/部分] = 所在地3 建物名 match）
- 沿線1 (idx 47-53): 沿線名・駅FROM・駅TO・徒歩・unit SELECT・車km・バス分
- 沿線2 (idx 54-60): 同上
- 沿線3 (idx 61-67): 同上

**自動入力される項目**:
| 条件 | REINSフォーム |
|---|---|
| 物件種別 | idx 5 SELECT → "賃貸マンション" |
| 沿線名 | idx 47 text (REINS_LINE_MAP変換: 大阪市高速軌道→大阪メトロ等) |
| 駅名FROM/TO | idx 48/49 text (沿線設定後に400ms待機してから入力) |
| 徒歩 | idx 50 text |
| 賃料上限 | idx 76 text (万円単位) |
| 間取タイプ | checkByLabel (ワンルーム/K/DK/LDK等) |
| 築年月FROM | selectで2028年を持つselectを検索→目標年を選択 |
| ペット相談 | 入力ガイドモーダル（最後のボタン）→チェック→決定 |
| 登録年月日 | ラジオボタンをlabel text完全一致でクリック |
| 検索実行 | "検索"ボタン自動クリック |

**メッセージフロー**:
```
popup.js (サイドパネル)
  → chrome.tabs.sendMessage({ type: "axlx-reins-autofill", conditions })
  → reins-content.js (コンテンツスクリプト)
  → reins-page-script.js を<script>タグで注入
  → CustomEvent "axlx-reins-fill" で conditions を転送
  → fill(cond) → scrollTo(0,0) → フォーム入力 → 検索ボタンクリック
```

---

## 🚨 絶対ルール：3サイトの路線名・駅名表記は完全に独立管理（2026-05-20 竹内悠馬指示）

**背景**: itandiで「大和路線(JR関西本線)」（リアプロ内部名）を使ってラベル検索が失敗し続けたバグが発生。3サイトの表記を混同することで検索エラーが起きると確認済み。

### 各サイトの路線名表記（御堂筋線の例）

| サイト | 表記例 | 管理ファイル |
|---|---|---|
| **リアプロ** | `大阪市高速軌道御堂筋線` | STATION_LINE_MAP / LINE_ROUTE_MAP（popup.js） |
| **itandi** | `高速電気軌道第1号線(大阪メトロ御堂筋線)` | ITANDI_LINE_MAP_FILL（popup.js） |
| **レインズ** | `大阪メトロ御堂筋線` | REINS_LINE_MAP（popup.js） |

### 変換マッピングの構造

```
駅名入力（お客さん条件）
    ↓
STATION_LINE_MAP（駅名 → リアプロ内部路線名）
    ↓ 分岐
    ├── リアプロ → LINE_ROUTE_MAP（内部名 → route_id）
    ├── itandi  → ITANDI_LINE_MAP_FILL（内部名 → itandiラベル名）
    └── レインズ → REINS_LINE_MAP（内部名 → REINSテキスト名）
```

### 主な差異（混同しやすいもの）

| リアプロ内部名 | itandi表記 | レインズ表記 |
|---|---|---|
| 関西本線 | JR関西本線(加茂～ＪＲ難波)(大和路線) | 大和路線 |
| 南海電鉄南海本線 | 南海本線 | 南海本線 |
| 阪急電鉄京都線 | 阪急京都本線 | 阪急京都本線 |
| 近鉄難波・奈良線 | [近鉄難波線, 近鉄奈良線]（2路線に分割） | — |
| 大阪市高速軌道御堂筋線 | 高速電気軌道第1号線(大阪メトロ御堂筋線) | 大阪メトロ御堂筋線 |

### 禁止事項（絶対）
- リアプロ内部路線名をitandi/レインズのラベル検索にそのまま使う
- itandiのラベル名をリアプロのroute_id変換に使う
- 3サイトのマッピングを1つの変数でまとめる（分離が原則）

### 各サイト表記の守護者
| サイト | 担当 |
|---|---|
| リアプロ | **#43-RP**（リアプロ内部名の責任者）＋ #43-KN |
| itandi | **#43-IT**（itandiラベル名の責任者）＋ #43-KN |
| レインズ | **#43-RN**（REINS表記名の責任者）＋ #43-KN |

---

## 📋 調整中・保留事項

| 項目 | 内容 | 優先度 | 状態 |
|---|---|---|---|
| REINS自動入力 実機テスト | scrollTo(0,0)修正済み。実際のお客さんデータで動作確認が必要 | 高 | テスト待ち |
| REINS 賃料idx確認 | idx 76を使用中だが実機確認未完了 | 中 | テスト待ち |
| 駅マッピング追加 | 兵庫・京都・奈良方面の駅が未収録 | 低 | 未着手 |
| リアプロ自動入力後の検索実行 | 実装済み（v1.5.4）| - | ✅完了 |
| itandi大阪モノレール路線名確認 | 60件制限でモーダル取得できず。「大阪モノレール線」で動くか未確認 | 低 | 未確認 |

---

## 🏗️ リアプロの検索フロー（確認済み）

```
1. 住居 → 住居検索
2. 左メニュー「所在地絞り込み ＋」または「沿線・駅絞り込み ＋」
   ├─ 所在地: 都道府県 → 市区郡 → 詳細地域 → 確定
   └─ 沿線: 駅名から絞り込み → 沿線選択 → 駅の設定へ進む → 駅選択 → 確定
3. 駅からの移動手段（分数入力）
4. 右側で賃料・間取り・築年数等を設定
5. 「検索」ボタン
```

---

## 🗾 2026-07-22 富田林→高槻市 誤判定の修正（v2.4.1）

**原因**: pg_trgm fuzzy検索（token-resolve ②）が「富田林」を region_map の「富田(高槻市)」に similarity 0.40 でマッチさせていた（LLMは無関係・AIは呼ばれてすらいなかった）。富田林は駅マップ・地名マップのどこにも未登録だった。

**修正内容**:
1. **NEIGHBORHOOD_WARD_MAP 追加**（popup-maps.js）: `富田林→富田林市`・`富田林市→富田林市`・`河内長野→河内長野市`・`大阪狭山→大阪狭山市`（南河内セクション新設。「富田」(高槻市の町名)とは別物・混同禁止のコメント付き）
2. **近鉄長野線を新規収録**: STATION_LINE_MAP に 喜志・富田林西口・川西・滝谷不動・汐ノ宮（各ward=富田林市をSTATION_WARD_MAPにも追加）、LINE_STATION_ORDER に全8駅（古市〜河内長野）。「富田林」トークン自体は地域として解決させるためSTATION_LINE_MAPには入れない
3. **市サフィックス補完ルール**（popup.js resolveWard / computeUnknownTokens、token-resolve/route.ts）: 「トークン+『市』がWARD_CODE_MAP（サーバー側はOSAKA_WARDS）に実在」ならコスト0で市名に解決。fuzzy検索・AIより前に実行。サーバー側は region_map に source="rule", confidence=95 で保存
4. **fuzzy誤マッチガード**（token-resolve/route.ts `isSuperstringMismatch`）: クエリがマッチ先の完全上位互換（富田林⊃富田）の場合は棄却。station_map/region_map/line_stations の3つのfuzzy検索すべてに適用。「梅田駅→梅田」のような駅サフィックスのみの差は許可
5. **✗間違いボタンの正解学習UI**（popup.js `showCorrectionForm`/`correctLearnedToken`、region-map/route.ts POST新設）: ✗押下→インライン入力フォーム表示→正しい市区名を入力して保存すると region_map に source="manual", confidence=100 でupsert＋station_map誤エントリ削除＋token_blockブロック解除。「わからない」ボタンで従来どおり削除＋永久ブロック（オプションA+Bのハイブリッド。Bを主にした理由: ブロックのみだと正解が永久に学習されず未登録地名のまま検索に乗らないため）
6. **Supabase直接投入済み**: region_map 4行（富田林/富田林市/河内長野/大阪狭山）・line_stations 近鉄長野線8駅・station_map 5駅（喜志/富田林西口/川西/滝谷不動/汐ノ宮）

**注意**: window.prompt/alert はChrome拡張ポップアップでは動かないため、正解入力はインラインDOM フォームで実装している。

---

## 🛡️ 2026-07-23 chrome API ガード追加（score-overlay.js L321エラー対応）

**結論**: chrome://extensions に出ていた「Cannot read properties of undefined (reading 'onChanged') at score-overlay.js:321」は**旧バージョン(4ad32a8・storage権限なし時代)の残骸ログ**。現行コードのL321はコメント行で再発不可能。score-overlay.js は修正済み（typeofガード+try/catch完備）のため無変更。

**予防措置として4ファイルのガードなし `chrome.runtime.onMessage.addListener` に `typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage` ガードを追加**（拡張リロード後の孤児content script対策）:
- `itandi-content.js`（旧L18）/ `reins-content.js`（旧L18）/ `itandi-bulk-dl.js`（旧L627）/ `reins-bulk-dl.js`（旧L633）
- background.js:347 はservice worker本体で chrome.runtime 保証のため対象外。popup.js / page-script.js / content.js / underbar.js は問題なし（調査済み）

**ユーザー操作**: ①chrome://extensions→AIXLINXの「エラー」→すべてクリア ②拡張を再読み込み ③リアプロ/itandi/レインズの開きっぱなしタブを全リロード ④再発時のみ新規調査（タイムスタンプ確認）

---

## 🛤️ 2026-07-23 「御堂筋線」が駅名扱いされリアプロ自動検索が死ぬバグの根治

**症状**: 「大阪市内の御堂筋線」で自動検索 → 沿線未選択のまま「指定の駅が選択できませんでした。駅: 御堂筋線」alert。

**根本原因**: Supabase `station_map` に「御堂筋線」等12件の**路線名が"駅"として誤学習**されていた（2026-06-24 web_search由来）。popup.js の線名ガード `!LEARNED_STATION_MAP[part]` が汚染データで false になりすり抜け → station_names=["御堂筋線"] 送信。さらに学習データの路線名表記が「大阪市高速**電気**軌道御堂筋線」（現名称）で LINE_ROUTE_MAP キー「大阪市高速軌道御堂筋線」と不一致 → route_ids も空。

**修正内容（5層防御）**:
1. **popup.js**: `lineNameToRouteId()` 新設（buildAreaRouteCodes直前）。短縮名/リアプロ内部名/「電気軌道」表記ゆれ/サフィックス一致で route_id 解決
2. **popup.js**: 線名ガード2箇所（buildAreaRouteCodes 駅モード・realproボタンonclick）から `!LEARNED_STATION_MAP[part]` を削除。路線として解決できるなら学習データより優先
3. **popup.js**: `computeUnknownTokens` で既知路線名を除外（線名→AI→駅誤学習の汚染ループ遮断）＋ `resolveUnknownTokensWithAI` で「〜線」トークンの駅学習を一律スキップ
4. **page-script.js**: `fillRealpro` 冒頭に `reclassifyLineTokens()` 追加。station_names に路線名が混入しても ROUTE_LINE_MAP 照合で route_ids に再分類（防御的フォールバック）
5. **app/api/token-resolve/route.ts**: `isLineName()` ガード追加（既知路線名は駅解決スキップ・汚染キャッシュも無害化）＋「〜線」トークンの station_map 保存を禁止

**DBクリーンアップ実施済み**: station_map から路線名12件削除（御堂筋線・谷町線・千日前線・四つ橋線・高野線・南海高野線・南海本線・片町線・阪急千里線・阪急神戸線・阪急宝塚線・近鉄奈良線）。

**補足**: 「分からないトークンをDeepSeekで探す仕組み」は既存（`/api/token-resolve`: DB完全一致→市名ルール→pg_trgm fuzzy→DeepSeek-V3→Claude web_search の5段）。今回のバグはその学習結果の汚染が原因で、上記3・5で再発を遮断。`npx tsc --noEmit` パス済み・両JS `node --check` パス済み。**実機（リアプロ実ページ）での動作確認は未実施 → 次セッションで要確認**。

---

## 🙋 2026-08-16 スタッフモード実装（自動化コマンド無視トグル）

**目的**: 自動物件出しが動いている間、スタッフのPCのChrome拡張が勝手に動かない（顧客切替・autofillクリック・タブナビゲート・openPopup割り込みが起きない）ようにする。

**設計（案A: chrome.storage.local + claim前ガード）**:
- 状態: `chrome.storage.local { staffMode: boolean, staffModeAt: timestamp }`（**PCごと**。DBやサーバー変更ゼロ）
- 自動化はDBキューを各PCがポーリングして早い者勝ちでclaimする方式のため、**claim前（pending fetch前）にローカルで離脱**すればコマンドはpendingのまま残り、30秒以内に別PC（自動化PC）が拾う → 自動化全体は止まらない
- 消し忘れ防止: **TTL 2時間で自動OFF**（`STAFF_MODE_TTL_MS`、batchRunningロックと同型）

**background.js のガード3箇所**（`_isStaffModeActive()` / `_updateStaffModeBadge()` は BATCH_LOCK_TTL_MS 直後に定義）:
1. `_pollAndRunBatch()` 冒頭 — pending fetch前に return（最重要。openPopup割り込みも根絶）
2. `axlx-poll-now` ハンドラ — `{ok:false, reason:"staff-mode"}` を返す
3. `_sbHandleCommand()` 冒頭 — Realtime `scrape_command` を無視（broadcastは全PCに届くので別PCが処理）
- **意図的にガードしない**: `stop_command`（停止は常に安全）／ `axlx-webapp-search`・`axlx-scrape-and-compare`（このPCのスタッフ自身のWebAppボタンクリック由来＝手動操作なので通す）
- バッジ: ON中は「手動」緑バッジ常時表示。`chrome.storage.onChanged` でトグル・TTL失効を即時反映。SW再起動時も復元

**popup.html / popup.js / styles.css のUI**:
- ヘッダーに `#staff-mode-btn`「スタッフモード」トグル（ON時「スタッフモード中」、絵文字なし・緑 `.staff-btn.on`）＋ヘッダー直下に `#staff-mode-banner` 緑バナー「スタッフモード中 — 自動化は停止しています」
- popup.js `_initStaffModeUI()`（Init直前に定義・DOMContentLoaded先頭で呼ぶ）: storage読取→描画、`chrome.storage.local.onChanged` で全popupインスタンス（サイドパネル+各タブのアンダーバー）同期
- バッジクリア2箇所（pendingPopupCmd処理時の `setBadgeText('')`）を `_staffModeOn ? '手動' : ''` に変更（スタッフバッジを消さない）
- mini-mode では `#staff-mode-btn` / `#staff-mode-banner` を非表示（styles.css の mini-mode 非表示リストに追加）

**検証**: 両JS `node --check` パス。**実機での動作確認（トグルON→自動化コマンドが別PCに流れること）は未実施 → 次セッションで要確認**。

---

## 🖱️ 2026-08-16 リアプロ自動入力の「機械的クリック」解消（人間らしいクリックキュー導入）

**目的**: page-script.js は同種要素の複数クリック（駅×N・区×N・町字×N・路線×N・チェックボックス×N・基本条件フォーム一括セット）が全て同期 forEach/for ループの **0ms連打** で、ログ・イベント間隔が機械的だった。itandi-page-script.js（1クリックずつ setTimeout チェーン + ランダム間隔 + 低確率長ポーズ）の設計を踏襲して直列化した。

**修正ファイル**: `chrome-extension/page-script.js` のみ（他ファイル無変更）

**コア実装（L140-189 に新設）**:
- `enqueueHumanClick(el, fn, minGap, maxGap)` / `enqueueHumanAction(fn, ...)`: FIFOクリックキュー。1件ずつランダム間隔（60〜200ms）で実行、8%の確率で 300〜700ms の「迷い」ポーズ追加
- `el.__axPending` フラグでポーリング再実行時の二重エンキュー防止（実行後クリア）
- `isClickQueueBusy()` / `whenClickQueueIdle(cb)` / `clearClickQueue()`（fillRealpro 開始時に前回残留キュー破棄）

**順序保証の仕掛け（機能を壊さないための核心）**:
1. `waitForClick.attempt()` 冒頭: キュー消化中は判定・クリックを開始しない（150ms後再試行・試行回数は消費しない）→ 前ステップの全クリック完了後に次ステップへ進む
2. `clickSearch()` 冒頭: キュー消化中は検索送信しない（200ms後再試行）→ 条件反映前の検索を防止
3. `_doReset`: モーダル内クリア→閉じるボタンを同一キューFIFOで順次実行し、フォームクリア（checked=false直接セット）は `whenClickQueueIdle` 後に実行（順序が逆だと解除クリックが後から走って再チェックされる）

**キュー化した箇所**: `setCheckboxes`（間取り/構造/市区郡/沿線）・`clickLineButtons` PASS1/2・`selectStationsByName` STEP1〜5・`clickDetailArea` PASS0（町字複数）・`_doReset` モーダルクリア・T=0基本条件ブロック（`queueSelVal`/`queueTxtVal` 新設で select/text も1項目ずつ）・ペット/敷礼/共益費チェック・STEP2 stale市区郡解除・STEP B 路線残留クリア・STEP D 駅残留クリア。`simulateClick` は mousedown→(40〜90ms)→mouseup+click の押下時間を再現。

**非同期化に伴うロジック修正（重要・削除禁止）**:
- `selectStationsByName` STEP1/STEP5: **checked済み・クリック予約済みも found=true（処理済み扱い）** に変更。旧コードは checked済みで found が立たず STEP2 の直接テキストクリックにフォールスルーし、キュー化後だと駅がトグル解除される事故があり得た
- STEP B（路線）/ STEP D（駅）の前顧客残留クリア: **今回選択予定の路線・駅はクリア対象から除外**（解除→再選択がキューで非同期になると順序が保てず選択が消えるため。checked済みは選択側が再クリックしないのでそのまま活きる）
- 所在地フォールバックの `city_code[]` 反映確認（applied カウント）も `whenClickQueueIdle` 後に判定

**検証**: `node --check` パス。**実機（リアプロ実ページ・連続バッチ検索）での動作確認は未実施 → 次セッションで要確認**（特に: 複数駅選択・複数町字選択・前顧客残留クリアの3ケース）。

---

## 🔁 引き継ぎ事項（次セッションへ）

- 現在のバージョン: **v2.4.8**（manifest.json 記載）
- **2026-08-24 setupAreaModeSelector クラッシュ修正**:
  - **症状**: 一括検索中に `axlx-switch-customer` を受信すると popup.js:2501 で `TypeError: Cannot read properties of null (reading 'style')` が発生し、その後のリアプロ/itandi ボタンが押せなくなる
  - **根本原因**: `setupAreaModeSelector` が DOM要素（`area-mixed-notice` 等）の存在を前提にしていたが、underbar モードの一括検索フロー（`openSiteView → openInstructions`）では instructions パネルの DOM 要素が存在しない状態で呼ばれる
  - **修正（popup.js `setupAreaModeSelector`）**: `defaultMode` 計算・`currentAreaMode` のセットを先に行い、その後で DOM 要素の null チェック。DOM がなければ UI 更新のみスキップ（`currentAreaMode` はセット済みなので自動入力は正常動作する）
- **2026-08-11 itandi station_map DB統合**:
  - `/api/itandi-resolve` 新設: station_map テーブルの itandi_lines カラムを直接返す itandi 専用軽量API。入力: `{ tokens: string[] }`、出力: `{ resolved: {[token]: {itandi_lines, ward}}, unknown_tokens }`
  - `popup.js` L2545〜: itandiLines 構築を `LEARNED_STATION_MAP[token].itandi_lines`（DB全件キャッシュ）優先に変更。DB未登録駅のみ `ITANDI_LINE_MAP_FILL` 静的変換にフォールバック
  - 未知トークンを /api/itandi-resolve で fire-and-forget 解決し LEARNED_STATION_MAP を更新（次回以降に反映）
  - これにより「難波」→「なんば（御堂筋線）」等の正確な itandi 路線名が使われる（STATION_LINE_MAP の南海本線誤マッピングを克服）
- **2026-08-11 一括検索で物件が送られないバグ修正 (bulk-dl.js)**:
  - `axlx-autofill-initiated` ハンドラで sessionStorage(`axlx_auto_send`)を即時クリア → 前バッチ中断で残留した stale state が次バッチの Case A `!getAutoSendState()` チェックをブロックするバグを修正
  - fill-done ハンドラに **2秒フォールバックタイマー** 追加 → AJAX がDOM要素を再利用して `_hasNewBtn = false` になり Case A が起動しないケースを救済（`_autoSendArmed && tracked.length > 0 && !getAutoSendState() && !_pendingAutoSendDispatched` の条件が2秒後も成立していれば強制送信）
- **2026-08-12 梅田20分圏内の駅選択不完全バグ修正（Fable5調査済み）**:
  - **根本原因**: `popup.js` autofill onclick の Dijkstra が `getReachableStations()`（METRO_GRAPH: 大阪メトロ9路線のみ）を使っていた → JR東海道本線・大阪環状線途中駅に到達不可。新大阪が偶然選ばれた理由: 御堂筋線の新大阪を選択 → page-script.js の `selectStationsByName` が同名駅全路線クリックするため東海道本線の新大阪も選ばれていた
  - **副根本原因**: 「梅田まで**徒歩**20分」の regex が `徒歩` を挟むためマッチしなかった（`transitRe`・`hasCommutePattern`・`parseAreaTokens` の3箇所）
  - **修正ファイル（popup.js）**:
    1. L294: `hasCommutePattern` regex に `(?:徒歩|電車|バス|歩いて)?` を挿入
    2. L484-485: `parseAreaTokens` の `まで/から\d+分` regex に「徒歩」対応
    3. L498: `parseAreaTokens` に `(?:徒歩|電車|バス|歩いて)?\d+分(?:以内|圏内)` 除去パターン追加
    4. L2879-2890: `transitRe` に「徒歩」対応 + `getReachableStations` → `getStationNamesWithinMinutes`（TRANSIT_GRAPH: 436駅・JR含む全路線）に変更
  - **修正ファイル（resolution-core.js）**: L1133 `parseAreaTokens` に「徒歩N分以内」除去パターン追加
  - **修正効果**: 梅田から20分圏内に塚本(8分)・福島(7分)・天満(7分)・野田(9分)・西九条(10分)等JR・環状線途中駅が正しく station_names に追加される
- **2026-08-11 バッチ0件停止バグ修正 + 0件LINEアナウンス**:
  - `bulk-dl.js`: 0件タイムアウトを **1200ms → 4000ms** に延長（遅いAJAX検索で0件誤判定するバグ修正。1人目0件→2人目で止まる現象の根本原因）
  - `bulk-dl.js`: `axlx-batch-customer-done` に `propertyCount: 0` を付加して0件確定を伝播
  - `background.js`: `_notifyBatchCustomerDone(propertyCount)` で propertyCount を waiter に伝播
  - `background.js`: リアプロ・itandi 両方で 0件検出時に `/api/notify-group` API 経由で LINE グループ通知（「🔍【物件0件】〇〇さんのリアプロ検索が0件でした」）
  - `app/api/notify-group/route.ts`: LINE グループ汎用通知エンドポイント新設
- **2026-08-11 itandi バッチ検索を popup.js 経由に統一**: `background.js` `_batchAutofill` の itandi 分岐を変更。旧: `axlx-itandi-autofill` を itandi-content.js に直送信（popup.js バイパス）→ 新: `axlx-switch-customer` → `underbar.js` → `popup.js`（ITANDI_LINE_MAP_FILL・Dijkstra 路線展開含む完全条件構築）で リアプロと同一フロー。フォールバックあり（popup.js 未応答時は旧方式）。`underbar.js` も変更: itandi-autofill ハンドラの `source !== "automated"` 条件を削除し `axlx-itandi-autofill-initiated` を常に送信（バッチ・手動どちらでも itandi-bulk-dl.js 自動送信フローが起動するよう統一）。
- **2026-08-10 一括検索バグ修正**: `background.js` の `_batchAutofill` realnetpro 分岐を修正。旧: `executeScript` で直接 `"aixlinx-fill"` 注入（popup.js をバイパスして Dijkstra 路線展開なし）→ 新: `chrome.tabs.sendMessage("axlx-switch-customer")` → `underbar.js` → `popup.js` で完全条件構築（個別検索と同一フロー）。フォールバックあり（popup.js 未応答時は旧方式）。
- **✅ 2026-06-07 a34f535 が最も安定したベースライン（竹内悠馬確認済み）**
- 拡張ツールはChromeに手動インストール済み（開発者モード）
- 変更後は chrome://extensions で再読み込み必要
- GitHub push → ローカルで git pull → Chrome再読み込み の流れ
- **itandi自動入力・所在地/路線・駅選択モーダル・検索ボタン自動クリックが実装済み（v1.5.2〜v1.5.4）**
- **Clipboard API Permissions PolicyエラーをunderbarのexecCommandのみに完全移行（v1.5.6）**
- **itandi自動入力をchrome.tabs→postMessage中継に変更（v1.5.7）**
- **itandi 広げて検索で当駅が選択されないバグを修正（v1.5.8）**
- **レインズ手順を実際のフォーム画面をもとに実装（v1.6.0）** → 実機確認が必要
- **2026-07-05 保守修正4件**:
  - popup-maps.js: REINS_LINE_MAP に「南海電鉄南海本線」キー追加（「南海電鉄南本線」のみで欠落していた）
  - popup.js: needsActionToday の hot 判定をサーバー版（property-tasks/property-customers の route.ts）と統一（hot_confirmed_at / property_viewed_at も見る）
  - popup.js: itandi/REINS 自動入力の chrome.tabs.sendMessage に chrome.runtime.lastError チェック追加（失敗時ボタンに「⚠ ○○のタブで開いてください」表示）
  - popup.js: 学習済みトークン自動解決表示の innerHTML に esc() 適用＋インライン onclick を data-token 属性 + addEventListener に変更（XSS対策）
- **2026-07-05 レインズ一括DL 信頼性修正3件（未コミット）**:
  - background.js: `axlx-reins-watch-tab` ハンドラで既存watcherの旧タイマーを clearTimeout せず上書きしていたレース修正（逐次モードで旧タイマーが35秒後に新watcherを削除→2件目以降のPDF捕捉が失敗するバグ。onCreated側と同じ clearTimeout パターンに統一）
  - background.js: `uploadPdfToBlob` / `callMergeApi` の fetch に `signal: AbortSignal.timeout(60000)` 追加（サーバー無応答時に「Blobアップ中...」で最大5分固まる問題を60秒タイムアウトに）
  - reins-bulk-dl.js: `captureOnePdf` の `!freshBtn` rejectパスで `customEvtHdlr` の removeEventListener 漏れを修正（リークしたハンドラが次物件のPDFイベントで発火し進行中キャプチャに干渉）
- フロー: 路線・駅で絞り込み → 近畿(完全一致) → 大阪府(完全一致) → 路線チェック → 駅列描画待ち(800ms) → 駅を全選択 → 確定
- 広げて検索: 当駅＋前後各1駅を `clickLabel` で全選択（LINE_STATION_ORDER で隣駅を自動取得）
- ピンポイント検索: 当駅のみ選択
- ナビタブ（近畿・大阪府）は `clickNav()`（完全一致）で誤クリックを防止
- 駅名は「駅」サフィックスを除去してから検索（「堺筋本町駅」→「堺筋本町」）
- 駅選択は部分一致（`textMatch`/`includes`）で柔軟にマッチ
- タイミングが合わない場合は値を調整すること（800ms/600ms等）
- **REINS自動入力（v1.7.0）**: scrollTo(0,0)修正済み・実機テスト待ち（特に賃料idx 76の確認）
- **大阪全駅対応完了（v1.7.1・2026-05-19）**: 今里筋線全11駅・南港ポートタウン線全7駅・南海本線市内・JR阪和線市内・JR難波・近鉄けいはんな線・阪急箕面線・片町線追加。合計約185駅収録
- **itandi複数駅パース実装済み（2026-05-20）**: desired_areaを「、・,/スペース」で分割→各トークンをSTATION_LINE_MAP照合（末尾「町/村」除去フォールバック付き）→全路線集約→全駅名をstation_namesに渡す
- **リアプロ所在地モーダル修正（2026-05-20）**: 広げて検索でもモーダル経由に変更。直接checkboxではUI反映されない問題を解消。detail_wardが渡されるときはhasModalWard=trueで必ずモーダルを使う。タイミング1200ms間隔（駅モーダルと同等）
- **次の課題**: リアプロ所在地モーダル修正後の動作確認（広げて検索+ピンポイント両方）・REINS実機テスト・itandi大阪モノレール路線名確認・yumiko案件（吉田町/東花園/新石切）でのitandi複数駅動作確認
- **市区郡トグル防止修正（2026-05-20）**: `div.next_step_button2`の視覚チェックをやめ`input[name="city_code[]"]:checked`でward選択状態を判定。`clickWardPrecise()`でcity_code[]を持つlabel限定・checked済み再クリック禁止。根本原因: next_step_button2はdisplay:block常時→isVisible()が誤判定→未選択でもSTEP4進行→町字ページに遷移しない
- **isWardButtonY()セレクタ根本修正（2026-05-20）**: `.next_action_town_search_Y`（存在しない複合クラス）→`classList.contains('town_search_Y')`に修正。常にfalseを返していたためN状態ループが止まらなかった根本原因
- **ensureWardButtonY()新設・N状態無限ループ根絶（2026-05-20）**: native.click()でdeselect→300ms→simulateClickでselect→400ms→Y確認の3段シーケンス。診断スクリプトで実証済みの動作を完全再現。clickNextStepBtnのN状態ward再クリックループを廃止
- **リアプロ ピンポイント検索（喜連西）完全動作確認✅（2026-05-20）**
- **間取り「以上」パターン対応（2026-05-20）**: 「3LDK以上」→FLOOR_RANKで順位付け→3LDK以上の全間取り(3LDK/4K/4DK/4LDK/5K/5DK/5LDK/6LDK/メゾネット)を自動選択。page-script.js
- **新設部署（2026-05-20）**: #43-EV（イベント専任）・#43-CP（条件パーサー担当）・#43-ST（状態機械専任）
- **#43-AX 新設（2026-05-20）**: AIXLINX部長分身。#36部長のコピーを#43に配備。「バグが現場にどう影響するか」をビジネス視点で評価する役割。検索→顧客管理→LINE送付の全フロー統合監視担当。
- **#43-RG 新設（2026-05-20）**: 変更影響分析専任。変更"前"に影響範囲を分析・GOサイン制。`memory/dept_feature_manifest.md`で現在動いている機能ベースラインを管理。主要関数依存マップ・死守リストも同ファイルに収録。バグ対応フロー: 新機能は PRE-1〜PRE-4 の事前分析を経てから実装開始。
- **#43-WD 新設（2026-05-20）**: 倉庫博士。7本の倉庫ファイル全体の品質・精度・整合性を統括。知識を✅/⚠️/❌でタグ付け・精錬・黄金ルールに昇格させる。倉庫チームのトップ。
- **#43-WX 新設（2026-05-20）**: 倉庫実行役。倉庫知識→実作業への橋渡し専任。セッション開始時に全7倉庫を読んで `dept_session_brief.md` を作成。チームはこれ1枚で作業開始できる状態を作る。
- **dept_session_brief.md 新規作成（2026-05-20）**: セッション開始時のブリーフィングファイル。次回TOP5・保留タスク・黄金ルール・倉庫全体マップを1枚に集約。毎セッション最初にこれを読む。
- **知識永久機関プロトコル確立（2026-05-20）**: セッション開始時の3ファイル読み込み→実装中の事前確認→修正後の即記録→デグレチェック→git pushの一連フローを部署全員の絶対ルールとして文書化（AGENTS.md）
- **setModeバグ修正（2026-05-20）**: setupAreaModeSelector内 renderInstrSteps(siteKey)→renderInstrSteps(siteKey, buildAdjCustomer(c))に修正。駅/地域切替ボタンで手順が更新されるように
- **レインズ複数駅パース対応（2026-05-20）**: rawAreaを単一トークンとして扱っていたバグを修正。areaToks分割→各トークンでSTATION_LINE_MAP照合→全路線集約に変更
- **レインズOOM/クラッシュ修正（2026-06-07）**: manifest.jsonのbulk-dl.jsマッチパターンを`main.php*`のみに制限。underbar.jsのiframe遅延生成（初回展開まで作らない）でメモリ節約。v2.3.0
- **itandi PDF重複バグ修正・LINE送信信頼性向上（2026-06-07）**: sendMessageTextのdedup修正。line-webhookでテキストメッセージを直接保存+line_message_id dedup。sync-from-screeningでスキップロジック追加
- **itandi PDFキャプチャ修正（2026-06-07）**: createObjectURLフックで空typeのBlob（size>=30KB）も補足対象に追加。detached anchorのblob:URL除外を撤廃
- **レインズGBK002200警告エラー修正（2026-06-07）**: 非結果ページ除外リストにGBK002200追加。console.warn→console.logに変更でChrome拡張エラーログ非表示化
- **レインズGBK002200 LINE送信復旧（2026-06-15）**: GBK002200はREINS賃貸検索結果一覧の本体URL（42件表示確認済み）。2026-06-07に誤って除外リストに追加していたため「0件を選択中」で送信ボタン無効化されていた。GBK002200をNON_RESULT_PAGESから削除（全4箇所）→ 物件行検出・送信機能が復活
- **拡張コンテキスト無効化クラッシュ防止（2026-06-07）**: background.js編集後にChromeがSWを自動再起動し既存タブのchrome.runtime.getURL()が「Extension context invalidated」例外を投げて3サイト同時にパネル消滅するバグを修正。underbar.jsのensureIframe()にtry-catch追加・doExpand()にnull guard追加・background.jsのsetupSidePanel()にtry-catch追加
- **パネル毎回更新問題を修正（2026-06-07）**: underbar.jsをsessionStorage→localStorageに変更。「明示的にたたんだ記録がなければ展開」をリアプロ・itandiにも適用（レインズと同じ動作）。これにより新タブを開くたびにリロード不要になる。v2.4.0
- **✅ 2026-06-07 時点が最も安定したベースライン（竹内悠馬確認済み）**: git commit a34f535
- **itandi PDFキャプチャ 3大バグ修正（2026-06-07）**: (1) itandiDownloadWatcher Mapベース→時刻ベース変数（`itandiWatchExpiry` + `itandiWatchOriginalTab`）に変更 (2) BGサービスワーカーから直接fetch（`host_permissions: itandibb.com/*`）→失敗時のみMAIN worldフォールバック (3) `window.open(https:URL)` を「suppress+fetch」から「passthrough」に変更し `chrome.downloads.onCreated` に委譲。**PDF取得＋LINE送信 実機確認済み（竹内悠馬）✅**
- **itandi ラジオ選択 5段階フォールバック（2026-06-07）**: `input[name="layoutType"][value="detailed"]`が実DOMに存在しないことが確認済み。5段階フォールバック: (1)`name=layoutType` (2)モーダル内全radio+ラベルテキスト「12枚」「間取り図」 (3)`closest("label")`/`aria-label` (4)`[role="radio"]` (5)最後のradio。`[AXLX] 12枚ラジオが見つかりません`エラー解消。
- **AIXLINXパネル 白画面バグ 3原因修正（2026-06-07）**: (1) iframeのcompositing layer突き抜け → `iframe.style.visibility="hidden/visible"` でsetSize(false/true)時に制御 (2) `setSize(false)`でdisplay:`"block"` → `"flex"` に修正（ミニオーバーレイのflexboxセンタリング崩壊防止） (3) React SPAページ遷移でwrapがDOMから消えるバグ → MutationObserverでdocument.bodyを監視しwrap消滅時に即再appendChild
- **underbar.js 常時展開＋ignoreNextCollapseフラグ（2026-06-07）**: ロード時の自動折りたたみ誤動作を防ぐ `ignoreNextCollapse` フラグ追加。拡張コンテキスト無効化時のchrome.runtime.sendMessage リトライロジック追加。
- **ミニボタン→パネル再展開バグ修正（2026-06-08）✅**: 最小化後にAIXLINXミニボタンをクリックしてもパネルが開かないバグを修正。根本原因: `doExpand()`の`!fr.contentDocument`条件がクロスオリジン（chrome-extension://）iframeでnullを返すため常にpendingExpandになり展開できなかった。修正: `!fr.contentDocument ||` を削除し、contentDocumentがnullの場合はロード済みとみなして即座に`setSize(true)`を呼ぶ。commit e109588。動作確認済み（竹内悠馬）✅

---

## 🔌 itandi PDFキャプチャフック カバレッジマップ（2026-06-08更新）

`background.js` に7経路のフックを実装済み。新しい配信パターンが出たら必ずここに追記する。

| 経路 | フック | 条件 | 状態 |
|---|---|---|---|
| `URL.createObjectURL(blob)` | createObjectURL上書き | `type includes "pdf"` OR `type includes "octet-stream"` OR `(!type && size>=30KB)` | ✅ 対応済 |
| `fetch()` レスポンス | window.fetch上書き | `Content-Type includes "pdf"` OR `includes "octet-stream"` | ✅ 対応済 |
| `window.open(blob:URL)` | window.open上書き | `capturePending && url.startsWith("blob:")` | ✅ 対応済 |
| `window.open(https:URL)` | **chrome.downloads.onCreated（時刻ベース）** | DLウォッチャーが捕捉→BGからfetch | ✅ 対応済（2026-06-08修正） |
| DOM anchor `.click()` | document capture-phase click | `capturePending && download属性あり` | ✅ 対応済（blob:含む） |
| detached anchor `.click()` | HTMLAnchorElement.prototype.click上書き | `capturePending && download属性あり && !javascript:` | ✅ 対応済（blob:含む） |
| XHR responseType="blob" | XMLHttpRequest.send上書き | `capturePending && Content-Type pdf/octet` | ✅ 対応済 |
| XHR responseType="" (text) | 同上 → URL再fetch | `_axlxUrl`を再fetchしてarrayBuffer取得 | ✅ 対応済（一時URL無効の場合失敗） |

**未対応ケース（今後遭遇したら対応）**:
- `window.location.href = url` によるページ遷移型ダウンロード → 未実装

**フック有効化タイミング**:  
`axlx-start-pdf-capture` メッセージ受信 → `__axlxCapturePending = true` → 60ms後 PDFボタンクリック → いずれかのフックが発火 → `__axlxCapturePending = false` → b64をpostMessage

**downloads.onCreated ウォッチャー（2026-06-08修正詳細）**:
- 旧バグ: `itandiDownloadWatcher = Map<originalTabId, timerId>` だが `downloadItem.tabId` は新タブID → 永久にマッチしない
- 旧バグ2: `chrome.tabs.sendMessage(dlTabId)` で新タブに送信 → コンテンツスクリプトがない
- 新実装: `itandiWatchExpiry`（エポックms）+ `itandiWatchOriginalTab`（元タブID）で時刻ベース管理
- PDF DL検知時: BGサービスワーカーからfetch（itandibb.comはhost_permissionsでCORSなし）→ 失敗時はexecuteScriptで元タブのMAIN worldからfetch → 元タブに `axlx-itandi-pdf-by-download` 送信
- window.open(https:URL): 旧設計「suppress+MAINfetch」を廃止。パススルーにして自然DLを発生 → onCreatedで捕捉する形に変更

---

## ⚠️ レインズ 非結果ページ除外リスト（2026-06-07確立）

`findResultRows` / `ensureBar` / `retryTimer` / `MutationObserver` の4箇所に統一定義:

```javascript
var NON_RESULT_PAGES = ["GBK001310"];
```

| ページコード | 種別 | 除外理由 |
|---|---|---|
| GBK001310 | 検索条件入力フォーム | チェックボックスがフォーム要素（物件行でない） |
| ~~GBK002200~~ | ~~物件詳細/登録系ページ~~ | ~~2026-06-15 削除。実際は賃貸検索結果一覧ページだった~~ |

**新しいページでエラーが出たら**: そのページコードを `NON_RESULT_PAGES` 配列に追加し、4箇所全てに適用すること（`reins-bulk-dl.js` 内 `NON_RESULT_PAGES` を一括検索して更新）。

---

## 🛠️ 物件検索フロー Fable5全体監査・抜け修正（2026-08-06）

**目的**: リアプロボタン1回押し→自動検索→AI採点→売上番長LINE送信のエンドツーエンド信頼性確保。

### 修正一覧（12件）
| # | 内容 | ファイル |
|---|---|---|
| 1 | リアプロ物件のフィールド名不一致修正: `_normalizeRealproProperties()` で name→building_name / access→station_info / move_in→available_date / detail_url→url に変換してから compare-properties へ送信。API側にも building_name 欠落で400を返すバリデーション追加 | `background.js`, `app/api/compare-properties/route.ts` |
| 2 | batchRunning を `{running:true, startedAt}` のTTL方式（15分）に変更、onStartup/onInstalled でリセット。pending API に「running かつ picked_up_at が30分前」の行を pending に戻すサーバー側ウォッチドッグ追加 | `background.js`, `app/api/automation/pending/route.ts` |
| 3 | pending API の claim を条件付きUPDATE + `.select()` で確認（0行なら command:null）。複数PC同時ポーリングの二重実行防止 | `app/api/automation/pending/route.ts` |
| 4 | 固定8秒/3秒待ちを廃止し fill-done シグナル待機に変更。page-script.js の `aixlinx-fill-done` を content.js / itandi-content.js が `axlx-fill-done` として background へ中継。itandi-page-script.js にも検索クリック後のシグナル発火を追加。background 側は `_createFillDoneWaiter(site, 60000)` を **autofill発火前** に作成 → シグナル受信+3秒でスクレイプ開始、60秒タイムアウト時はスクレイプ中止して error | `background.js`, `content.js`, `itandi-content.js`, `itandi-page-script.js` |
| 5 | is_wide のキュー経路伝搬: queuePropertySearch → trigger API（payload.is_wide 保存）→ `_runBatchSearch` → `_batchAutofill(customer, site, isWide)` → resolve API 呼び出し + `_buildBatchConditions(c, isWide)` | `page.tsx`, `trigger/route.ts`, `background.js` |
| 6 | itandi二重実行解消: webapp-bridge.js が受領ACK `aixlinx-webapp-received` を即時 postMessage。firePropertySearch が Promise<boolean> でACKを1.5秒待ち、拡張検出時はキュー投入スキップ。trigger API 側にも customer_ids+sites+is_wide 単位の直近5分デデュープ（force でも有効） | `webapp-bridge.js`, `page.tsx`, `trigger/route.ts` |
| 7 | 通常バッチの realnetpro 分岐に `_scrapeAndSendRealpro()`（fill-done待機→全ページスクレイプ→正規化→AI比較→LINE送信）を追加。従来は autofill+3秒で終了し結果が届かなかった | `background.js` |
| 8 | compare-properties: max_tokens 2048→8000、stop_reason ログ+レスポンス付与、pushToLine を boolean 返却にして lineSent に反映、AIパース失敗は ok:false / error:'ai_parse_failed' / raw_head 付き 502 | `route.ts` |
| 9 | 拡張の外部fetchにタイムアウト統一: resolve系15秒、pending/update系10秒、compare-properties 60→120秒（サーバー maxDuration=120 と整合） | `background.js` |
| 10 | automation pending/update に x-automation-key 認証追加（env `AUTOMATION_API_KEY` 設定時のみ強制）。update は許可フィールドのホワイトリスト+status enum検証。拡張側は `chrome.storage.local` の `automationApiKey` からヘッダー付与 | 両route.ts, `background.js` |
| 11 | リアプロボタンのフィードバック: コマンドIDを保持して5秒間隔ポーリング、queued/running/done(LINE送信済み)/error/noext(PC拡張未起動?) をボタン表示。実行中は disabled。状態キーは通常=c.id / 広=c.id+"-wide"。キュー投入失敗は消えない赤色エラー表示 | `page.tsx` |
| 12 | スクレイプ失敗と0件の区別: `_scrapeRealproPage` が lastError 時 `{error}` を返し、1ページ目失敗は throw → バッチ/コマンドの status:'error' + error_message としてサーバーに記録 | `background.js` |

### ⚠️ 運用メモ
- **AUTOMATION_API_KEY**: Vercel 環境変数に設定 + 各PCの拡張SWコンソールで `chrome.storage.local.set({automationApiKey: "同じ値"})` を実行すると認証が有効化。未設定なら従来通り認証なしで動く（後方互換）
- **fill-done 未着時の挙動**: 60秒以内にシグナルが来ないとスクレイプせず error になる（前回結果の誤送信防止）。page-script が検索ボタンを押せなかった場合もここで検知される
- **拡張の再読み込みが必要**: content.js / itandi-content.js / itandi-page-script.js / webapp-bridge.js / background.js を変更したため chrome://extensions で再読み込みすること
- ステータス語彙: サーバー側 ALLOWED_STATUS = pending / running / done / completed / error（done と completed は両方 done 扱いでUI表示）

---

## 🛠️ リアプロ自動検索「条件が反映されない」根本原因修正（2026-08-06 Fable5）

**症状**: リアプロボタンで「⏳依頼中...のまま」→「条件が反映されず全件検索に見える」。

**確定した根本原因**（DB実レコード + error_message で確定）:
1. 「依頼中のまま」= pending API 500（SUPABASE_SERVICE_ROLE_KEY 未設定）でコマンド滞留 → **コード側は anon フォールバック実装済み・復旧済み**。Vercel に SUPABASE_SERVICE_ROLE_KEY を設定すること（運用）
2. 「条件が反映されない」= リアプロ未ログインで main.php がログイン画面へリダイレクト → content.js（main.php* 限定注入）不在 → autofill メッセージが誰にも届かず無音失敗
3. resolve 空解決時に条件なし全件検索がサイレント実行される構造問題

### 修正一覧（5件）
| # | 内容 | ファイル |
|---|---|---|
| 1 | handleScrapeCompare がクライアント側で resolve-search-conditions を呼び、解決済み条件（station_names/route_ids/city_codes/itandi_line_names/reins_line_names/detail_ward/detail_area/unknown_tokens + rent_min/area_min/area_max）を payload に含める（itandi/レインズ経路と対称化。拡張側 resolve はフォールバックとして残存） | `page.tsx` |
| 2 | _webappAutofill: タブ準備後に URL 再検証し main.php でなければ「リアプロが未ログインです」と明示 throw。sendMessage を1.5秒間隔3回リトライ。realnetpro の executeScript フォールバック（content.js不在なら受け手ゼロで無意味）を廃止し明示エラー化 | `background.js` |
| 3 | _scrapeAndCompareForCustomer: エリア入力があるのに resolve 後も駅/路線/区コード/区名が全空なら「エリア条件を解決できませんでした」で error 終了（条件なし全件検索→無関係物件LINE送信を防止）。mergedConditions に itandi_line_names / reins_line_names / unknown_tokens を追加 | `background.js` |
| 4 | _doReset に route_id[] / station_code[] を追加（前顧客の沿線・駅選択が残るバグ修正） | `page-script.js` |
| 5 | UI: noext表示中もボタン disabled（重複INSERT防止）。error 時に automation_commands.error_message をボタン下に赤字表示（「未ログイン」等が直接見える） | `page.tsx` |

### ⚠️ 運用メモ
- **実行PCでリアプロにログインした状態を維持すること**（未ログインは即 error_message で可視化される）
- manifest 2.4.4 へ bump。background.js / page-script.js 変更のため chrome://extensions で**拡張の再読み込み必須**
- Vercel 環境変数 SUPABASE_SERVICE_ROLE_KEY の設定を確認（未設定でも anon フォールバックで動くが本来は設定すべき）

---

## 🛠️ fill-done タイムアウト問題の恒久対策（2026-08-06 Fable5）

**症状**: リアプロ autofill 中にエラー・タイムアウトが起きると fill-done が永遠に届かず、background.js が60秒待ってタイムアウト → status:error。

### 修正一覧（コミット 040f76e）
| # | 内容 | ファイル |
|---|---|---|
| 1 | notifyDone をべき等化（1回のfillRealproにつき1回だけ送信）+ 85秒フェイルセーフ watchdog 追加。全経路が沈黙しても必ず fill-done が送られる | `page-script.js` |
| 2 | waitForClick に try-catch 追加（tryFn/onDone/onFail の例外で静かに死なない）。onFail 未指定時のタイムアウトも notifyDone を送る | `page-script.js` |
| 3 | fillRealpro エントリ・本体・_doReset に例外保護。cond が falsy でも notifyDone | `page-script.js` |
| 4 | ブロッキング alert()（alertStop）を廃止 → 非ブロッキングトースト showWarnToast に変更。無人運転で alert が fill-done 配送を止めるバグを解消 | `page-script.js` |
| 5 | 所在地モーダルのタイムアウト時 → fallbackSearchWithoutArea（モーダル閉じて所在地条件なしで検索）。沿線・駅モーダルも同様に fallbackSearchWithoutStation | `page-script.js` |
| 6 | closeAreaModal / closeStationModal 待機（従来 onFail 未指定＝最大のハングポイント）に onFail 追加。閉じ失敗でも検索実行 | `page-script.js` |
| 7 | realnetpro の fill-done タイムアウトを 60秒→90秒（3箇所+デフォルト値）。itandi は60秒のまま。モーダル操作＋タブロード時間で60秒では余裕ゼロだった | `background.js` |

### 設計メモ
- タイムアウト序列: page-script watchdog 85秒 < background ウェイター 90秒（watchdog が必ず先に発火し、90秒タイムアウト経由の error を回避）
- フォールバック検索の思想: 「何もせず fill-done だけ送る」と前回結果ページを誤スクレイプする恐れがあるため、タイムアウト時も必ず clickSearch を実行してから通知する
- **拡張の再読み込み必須**: page-script.js / background.js 変更のため chrome://extensions で再読み込みすること

---

## 🛠️ エリア条件解決のローカルファースト化（2026-08-06 Fable5）

**目的**: バッチ/自動検索の Phase 1 が毎回 resolve-search-conditions API（DeepSeek 最大20秒 + 失敗モード）を往復していた。静的マップで解決できる大多数のケースをネットワークなしで完結させる。

### 修正一覧
| # | 内容 | ファイル |
|---|---|---|
| 1 | `resolution-core.js` を静的 `import` で読み込み（manifest の background.type="module" のため importScripts 不可。`globalThis.SUMORA_RESOLUTION` ブリッジ経由で参照） | `background.js` |
| 2 | `_getLearnedMapsCached()` 新設: region-map / station-map / line-stations を6秒タイムアウトで取得し `{wards, stations, lineOrder}` に整形。成功6時間・失敗10分キャッシュ。失敗時 `{}`（静的マップのみで解決続行） | `background.js` |
| 3 | `_resolveLocalFirst(baseConditions, isWide)` 新設: Phase 1a=resolveConditionsLocal（popup.jsと同一ロジック）→ Phase 1b=`unknown_tokens あり || (エリア入力あり && ローカル全空)` のときだけAPIフォールバック。APIには未解決トークンのみ投げる（全部未解決なら desired_area 全体・lines/stations は常に空）。resolution-core 未ロード時は従来どおりフルスコープAPI | `background.js` |
| 4 | `_mergeResolved(local, api)` 新設: 配列はローカル優先の和集合（city_codes/route_ids/station_names/ward_names/itandi_line_names/reins_line_names）。detail_ward/detail_area は local優先。unknown_tokens はAPIの最終判定を採用（二重報告防止）。rent_max_resolved / building_age_resolved はローカル値（wide時 +5000/+10000・+5年 の二重適用防止） | `background.js` |
| 5 | `_scrapeAndCompareForCustomer` Phase 1 のAPI直呼びを `_resolveLocalFirst` に置換。Phase 2 の length-check マージ・city_codes>=2→detail_ward null 化・`hasAreaInput && !hasAreaResolved → throw`（サイレント全件検索防止）は一切変更なし | `background.js` |
| 6 | `_batchAutofill` itandi 分岐・realnetpro 分岐の resolve API 直呼びも `_resolveLocalFirst` に置換（発火条件・結果の反映ロジックは従来のまま） | `background.js` |

### 設計メモ
- ハッピーパス（全トークンが静的マップで解決）は Phase 1 で一切ネットワークに触れない
- API失敗/タイムアウト時は `resolved = local`（部分解決）で続行。最終安全網の throw は既存のまま
- **拡張の再読み込み必須**: background.js 変更のため chrome://extensions で再読み込みすること

---

## 🛠️ APIフォールバック強化: resolveAreaWithAPIにlocalEmpty判定追加（2026-08-08 Fable5）

**対象**: `chrome-extension/popup.js` L217〜（`resolveAreaWithAPI`）

**問題**: popup 側の `resolveAreaWithAPI` の発火条件が `hasRoute || hasUnknown` の2つだけだった。
「トークンはマップ上既知だがコード化できない」ケース（例: `NEIGHBORHOOD_WARD_MAP` にはあるが `WARD_CODE_MAP` に無い区、路線も所在区も引けない駅）は
`computeUnknownTokens` が 0 を返すため API が呼ばれず、`buildAreaRouteCodes` が `{city_codes:[], route_ids:[]}` を返したまま
**エリア無条件の全件検索が黙って走っていた**。background.js は同じ判定を
`unknownTokens.length > 0 || (hasAreaInput && localEmpty)` で持っており、popup だけ抜けていた。

### 修正内容（popup.js 1ハンク・呼び出し側は無変更）
| # | 内容 |
|---|---|
| 1 | 発火条件を `needApi = hasRoute \|\| hasUnknown \|\| (localEmpty && hasMeaningfulToken)` に拡張。`localEmpty` は `buildAreaRouteCodes({desired_area: rawArea}, "auto")` の city_codes/route_ids がどちらも空かで判定（"auto" は最も広く解決するモードなので、auto で空なら ward/station でも必ず空） |
| 2 | `hasMeaningfulToken`（2文字以上・数字始まりでないトークンが1つ以上）でAPIの無駄打ちを抑制 |
| 3 | **キャッシュ判定をガードより前に移動**（必須）。API結果で `LEARNED_*_MAP` が埋まると `hasUnknown` は反転するが `localEmpty` は真のまま残りうる → キャッシュが後ろだと毎クリック7秒タイムアウトPOSTを撃ち続ける再フェッチループになる。前に出すことで `(rawArea, mode)` あたり1回に固定 |
| 4 | ローカル空でAPI補完したときは `[AX] resolve-area: ローカル解決が空 → API補完:` をログ出力 |
| 5 | ついでに L2220 の `forEach(c => ...)` を `forEach(cc => ...)` にリネーム（外側の `const c = selectedCustomer` をシャドウしていた。実害はなかったが紛らわしい） |

### 影響範囲
- 呼び出し4箇所（L1658 fire-and-forget / L1898 / L2189 autofill / L2407 reins）は全て `"auto"` を渡し非nullの `apiData` を正しく扱うため、**呼び出し側の変更ゼロ**でそのまま恩恵を受ける
- `hasRoute || hasUnknown` が先に短絡するので既存パスの挙動はビット単位で同一。キャッシュは移動しただけで書き込み位置は不変（ヒットは増えることはあっても減らない）
- マージ処理は全て `includes` 重複排除の加算なので、API呼び出しが増えても壊れる方向のリスクはない（コスト増のみ）

### 既知の残課題（今回のスコープ外）
- `_resolveAreaCache` は `rawArea` 完全一致の**1スロット**。顧客を交互に切り替える／`#adj-area` を1文字編集するだけで飛ぶ。呼び出し量が増えたぶん影響が出やすくなった → `Map` 化（キー `${areaMode}\0${rawArea}`・上限付き）が改善案
- **in-flight の重複排除なし**。L1658 の fire-and-forget が L1898/2189/2407 と同一 rawArea でレースするとPOSTが2本出る（キャッシュ書き込みはレスポンス着弾後のため）→ `_resolveAreaInflight` でPromise共有する対策が有効
- L2410 の reins パスがモード補正で `apiData.realpro` を読みつつデータは `apiData.reins` から取る不整合。今回の修正で発火頻度が上がるため、`reins` は埋まっているが `realpro` が空のレスポンスだとモード補正が黙って no-op になる → 要フォローアップ

**拡張の再読み込み必須**: popup.js 変更のため chrome://extensions で再読み込みすること

---

## 🛠️ 駅→沿線マッピングのDB動的取得化（2026-08-09 Fable5）

**目的**: `getHubLines` がハードコードの `STATION_LINE_MAP` に依存していたため、DBの `station_map`（realpro_lines）を最優先で参照するように変更。DBに新駅を追加すれば拡張の再デプロイなしで反映される。

### 修正一覧
| # | 内容 | ファイル |
|---|---|---|
| 1 | `GET /api/station-route-cache` 新設: `station_map` から `token, realpro_lines` を全件取得（source='unknown' のネガティブキャッシュ行・realpro_lines 空の行は除外）。1000行ページング。レスポンス `{ data: { 駅名: [路線名,...] } }`。Cache-Control: public, max-age=86400 | `app/api/station-route-cache/route.ts`（新規） |
| 2 | `fetchStationRouteCache()` 新設: chrome.storage.local の `stationRouteCache` キーを確認し ts が24時間以内ならそれを使用。期限切れ/なしなら API を10秒タイムアウト付き fetch → `{data, ts}` 形式で保存。失敗時は console.warn して null（hardcodedマップで動作継続） | `popup.js` L15〜 |
| 3 | `getHubLines` の各駅ループで `_dbStationRouteMap` を最優先参照。値は「配列」「{realpro_lines:[...]}」両形式対応。DBに無い/空の駅のみ従来の `STATION_LINE_MAP` → `LEARNED_STATION_MAP` フォールバック。引数・戻り値インターフェース不変 | `popup.js` L701〜 |
| 4 | DOMContentLoaded に `fetchStationRouteCache()` 追加（seedMapsIfEmpty/fetchLearnedMaps と独立・非ブロッキング） | `popup.js` L2770 |

### 設計メモ
- realpro_lines のみ使用。itandi_lines / reins_line は含めない（サイト別表記の独立管理方針・feedback_site_naming_separation.md 準拠）
- 初回ポップアップ表示直後は `_dbStationRouteMap=null` のため hardcoded マップで動作（仕様どおり）。2回目以降はローカルキャッシュから即時ロード
- `getOneTransferLines` と resolution-core.js 側の `STATION_LINE_MAP` 参照は今回スコープ外（未変更）
- API失敗時は期限切れキャッシュも使わず null 返却（stale-while-error が必要なら catch 内で cached.data を返す1行で対応可）
- **拡張の再読み込み必須**: popup.js 変更のため chrome://extensions で再読み込みすること

---

## 🛠️ 一括検索「2人目以降の全ページ送りが発火しない」根本修正（2026-08-17）

**症状**: リアプロ一括検索（3人）で1人目（恋さん）は `fill-done → 全ページ送信完了` まで通るのに、2人目（友哉さん）は `fill-done` 受信後 bulk-dl.js のログが一切出ず（`Case C: ページリロード初回起動` も出ない）、background.js が `axlx-batch-customer-done` を5分待ってタイムアウトする。

### 根本原因（確定）
1. リアプロは検索実行（`page-script.js` の `div.go_search` クリック）で**ページが再読み込みされる**。よって結果ページでは bulk-dl.js のモジュール変数（`_autoSendArmed` / `_preAutofillBtns` / `_pendingAutoSendDispatched`）は全て初期化済み → **Case A（AJAX前提）は構造上発火できず、Case C（`chrome.storage.session.axlx_pending_auto_send`）だけが唯一の起動経路**。
2. その Case C 用フラグを立てているのは `popup.js` の autofill onclick の1箇所のみで、条件が **`if (!isAutomated)`（手動クリック限定）** だった（commit `fa6b217` で無条件→手動限定に変更されたもの）。
3. 一括検索は `background.js _batchAutofill` → `axlx-switch-customer` → `underbar.js` → `popup.js` L3657 の経路で、そこで **`aBtn.dataset.automated = "1"` をセットしてから click している**。つまり一括検索の autofill は常に `isAutomated=true` → **フラグが1度も立たない**。
4. それでも1人目だけ動くのは、`chrome.storage.session` に残っていた**古いフラグ1個を1人目が消費**するため。Case C は消費時に `remove` するので、2人目以降は永久に無音で死ぬ。
   → `fa6b217` 当時は自動バッチが bulk-dl の自動送信を使わない設計だったが、現在は `_scrapeAndSendRealpro` が `axlx-batch-customer-done`（= bulk-dl の全ページ送信完了）を待つ設計に変わっており、**このガードが実態と矛盾した残骸になっていた**。

### 修正内容（2ファイル・3ハンク）
| # | 内容 | ファイル |
|---|---|---|
| 1 | `if (!isAutomated)` ガードを削除し、**手動・自動バッチ共通で `chrome.storage.session.set({axlx_pending_auto_send:true})`** を実行（`isAutomated` は従来どおり `source` 判定に使用） | `popup.js` L3165付近 |
| 2 | `autoSendAllPages()` の冒頭（スタッフモード判定の直後）で `chrome.storage.session.remove("axlx_pending_auto_send")` を実行。Case A / Case C / 手動ボタンのどの経路で起動してもフラグを1回で消費する単一地点にした（Case A 内の個別 remove は残置＝冗長だが無害） | `bulk-dl.js` |
| 3 | 15秒0件確定ブランチでも同フラグを `remove`。0件顧客のフラグが残って次のページロードで Case C が誤発火するのを防ぐ | `bulk-dl.js` |

### 設計メモ（デグレ防止）
- **二重送信は起きない**: AJAX でたまたま Case A が先に走った場合、`autoSendAllPages()` 冒頭でフラグが消えるため後続の Case C は空振りする。逆に Case C が先なら `_pendingAutoSendDispatched=true` で Case A/B がブロックされる。
- **フラグは「起動権1回」のトークン**として扱うこと。新しい起動経路を足すときは必ず `autoSendAllPages()` を通す（そこで消費される）。
- itandi 側（`itandi-bulk-dl.js`）はSPAでページリロードが起きないためこのフラグを使っておらず、今回の変更対象外。
- **拡張の再読み込み必須**: popup.js / bulk-dl.js 変更のため chrome://extensions で再読み込みすること。
- **実機未確認**: 3人以上の一括検索で「全員分の全ページ送りが走るか」を次セッションで要確認。

---

## 🛠️ 一括検索「複数顧客で全ページ送る失敗」＋「一括でも一番オススメ表示」修正（2026-08-18 Fable5）

**症状**: ①1顧客なら自動の全ページ送るが成功するのに、2顧客以上の一括検索だと失敗することが多い。②一括検索のLINEメッセージに単発検索と同じ「🌟 一番オススメ」判定が効かない。

### Bug A 根本原因（2つの複合）
1. **偽0件レース（bulk-dl.js）**: fill-done 後の15秒0件確定ポーリングは「旧ページ」（前顧客の結果画面）上で動く。リアプロ検索リロードのサーバー応答が15秒を超えると、旧ページ上のタイマーが誤って0件確定 → `axlx-batch-customer-done {propertyCount:0}` 送信 ＋ **Case C 起動フラグ（axlx_pending_auto_send）を削除** → リロード後の結果ページで全ページ送るが永久に起動しない。確率レースのため顧客数が増えるほど「よく失敗する」。
2. **固定5分タイムアウトによる送信中破壊（background.js）**: `_createBatchCustomerDoneWaiter` が固定300秒。多ページ送信（20件/バッチ×複数ページ、merge-pdfs 1回最大60秒）は5分を超えることがあり、タイムアウト → background が次顧客の autofill を開始 → **検索リロードが送信中のページを破壊**して残ページ消失。1顧客だけなら誰もタブを触らないため完走する＝「1件なら成功・複数で失敗」の非対称性の正体。

### Bug A 修正内容
| # | 内容 | ファイル |
|---|---|---|
| 1 | `pagehide` リスナー追加: ページ離脱（検索リロード開始）時に `_zeroDetectTimer` を必ず破棄 | `bulk-dl.js` |
| 2 | 0件確定ポーリングを15秒→25秒に延長。さらに期限切れ時 `tracked.length > 0`（前顧客の結果が残っている＝リロード待ちの可能性大）なら**0件確定せずフラグも消さない**（リロード後の Case C / AJAX の Case A に委譲）。0件確定は tracked=0 の場合のみ | `bulk-dl.js` |
| 3 | 進捗ハートビート `axlx-batch-progress {customerId}` を新設: LINEバッチ送信1回ごと＋ページ遷移ごとに送信 | `bulk-dl.js` |
| 4 | itandi 側も PDF キャプチャ1件ごとにハートビート送信 | `itandi-bulk-dl.js` |
| 5 | `_createBatchCustomerDoneWaiter` を「固定5分」→「**無進捗5分**」に変更: `entry.resetTimer()` を追加し、`axlx-batch-progress` 受信（`_notifyBatchProgress`）のたびにタイムアウトを延長。送信が続く限り次顧客へ移らない | `background.js` |
| 6 | itandi Blob アップロードループ（`axlx-send-pdf-data-to-line`）内でも1件ごとに `_notifyBatchProgress(null)` | `background.js` |

### Feature B 根本原因と修正
- 「🌟 一番オススメ」はサーバー側 `/api/merge-pdfs` の `rankAndAnnotateSummaries`（Haiku AIランキング・顧客条件文字列で判定）＋ `buildLineMessage`（メッセージ先頭に🌟ブロック挿入）で生成される。単発・一括とも同じAPIを通るが、**一括検索はリアプロのページリロードで popup iframe が消えるため `getCustomerFromPopup` が storage フォールバックになり、`customer_conditions` が常に null** → AIランキングが顧客条件なしで実行され単発検索と同じ判定にならなかった。
- 修正: popup.js の `_buildConditionsString` をトップレベル `buildCustomerConditionsString()` に昇格し、顧客選択時（`openSiteView`）に `current_customer_conditions` として `chrome.storage.local` に保存。`bulk-dl.js` / `itandi-bulk-dl.js` の `getCustomerFromPopup` フォールバックが名前・IDに加えて条件文字列も返すようにした。これで一括検索でも単発検索と同一基準（顧客条件つきAIランキング）で「🌟 一番オススメ」がメッセージ先頭に入る。

### デグレ防止メモ
- ハートビートは waiter を **customerId 厳密一致 → 最古 waiter** の順で解決（`_notifyBatchCustomerDone` と同一ロジック）。顧客直列処理のため安全。
- 0件顧客の高速スキップは維持: tracked=0 のときは従来どおり25秒で0件確定送信。真の0件でリロードが来た場合は新ページ側 `autoSendOnePage` の4秒ポーリング → `propertyCount:0` で報告される（こちらが本線）。
- **拡張の再読み込み必須**: bulk-dl.js / itandi-bulk-dl.js / popup.js / background.js 変更のため chrome://extensions で再読み込みすること。
- **実機未確認**: 3人以上のリアプロ一括検索（多ページ顧客含む）で全員分の全ページ送る＋🌟一番オススメ表示を次セッションで要確認。

---

## 🛠️ itandi 一括検索 0件時フリーズ修正（2026-08-18）

**症状**: itandi で検索結果が0件の顧客がバッチに含まれると `axlx-batch-customer-done` が送信されず、background.js が5分間タイムアウト待機してバッチが大幅遅延する。

### 根本原因
- `itandi-bulk-dl.js` のアームメカニズム（Step2 fill-done → inject() → `_hasNewBtn` チェック → `autoSendAllPages`）は `tracked.length > 0`（物件資料ボタンあり）を前提にしている。
- 0件検索では `tracked` が空のまま → inject() の条件が通らず `autoSendAllPages` も `axlx-batch-customer-done` も送信されない。
- `bulk-dl.js` には15秒0件確定タイマーがあるが、`itandi-bulk-dl.js` にはなかった。

### 修正内容（itandi-bulk-dl.js 1ファイル）
| # | 内容 |
|---|---|
| 1 | `var _zeroDetectTimer = null;` を変数宣言に追加（L18） |
| 2 | Step1（`axlx-itandi-autofill-initiated`）で前顧客の残留タイマーをクリア |
| 3 | Step2（`aixlinx-fill-done`）でアーム後、15秒0件確定ポーリングを開始。`tracked.length > 0` になるか `_autoSendArmed` がクリアされれば即停止、15秒経過しても物件なしなら `getCustomerFromPopup` でIDを取得して `axlx-batch-customer-done {propertyCount:0}` を送信 |

### 設計メモ
- `_autoSendArmed = false` チェックで autoSendAllPages 発火時に自動停止（二重送信なし）
- `tracked.length > 0` チェックで物件ありの場合は即停止（Case A に任せる）
- Staff mode 有効時は `_autoSendArmed = false` にされるためタイマーも自動停止（5分タイムアウトは許容範囲）
- commit: TBD
