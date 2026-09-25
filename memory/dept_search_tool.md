# #43 物件検索ツール部署 記録ファイル

> セッションをまたいで記録を継続する。更新時は日付を必ず記録する。

---

## 2026-09-25 ブレインを独立の切り替えに・モードはドロップダウン（通常／スタッフ／AIX連動）— ブレインは3つのどれとも組み合わせる（v2.5.20・竹内）
竹内「スタッフモード等はこのブレインの横に付ける。ブレインだけ別で、ほかはドロップダウン方式で行う。ブレインでもスタッフモードや AIX モード、通常モードを行うため」
- 旧（v2.5.9〜2.5.19）: ヘッダーの select 1つで 通常／スタッフモード／AIX連動／ブレイン の4択（ブレイン＝AIX連動＋判定・排他）。画面の「ブレイン」の丸いピルはこの select、横の「∨」は `#collapse-btn`（サイドパネル＝お客さん一覧に戻る／下のバー＝折りたたむ・モードとは無関係）
- 新: `#brain-toggle`「🧠 ブレイン」（ON で水色）＋ 横に `#mode-select`（通常／スタッフ／AIX連動・▾ 付き）。帯は `#mode-banner` 1つで組み合わせごとに文言と色を変える。狭い幅（≤400px）では「物件検索サポート」を隠す
- **仕様は `chrome-extension/mode-core.js`（純関数・`self.AxlxModeCore`）の1か所**: readState（storage→モード・TTL）／storageUpdateForMode／storageUpdateForBrain／behavior（組み合わせ→動き）／badge／banner。popup.html（`<script>`）と background.js（`import`）が読む。`web_accessible_resources` にも追加（下のバーの iframe が popup.html を開くため）。テスト `tests/chrome-extension/mode-core.test.js`（45件）

| 組み合わせ | コマンドの claim | AIX・自動便の受け取り | 自動送信 | 送付済みの除外 | ブレイン判定 | drop を外す | LINE 末尾の「🧠 ブレイン判定」 | 売上サポに記録（brain_mode） | 11:00/17:00 自動便 | バッジ |
|---|---|---|---|---|---|---|---|---|---|---|
| 通常 | ○ | × | ○ | ○ | × | × | × | × | 届かない | なし |
| スタッフ | ×（別PCが拾う） | × | ×（手動のみ） | ×（人が選んだ物は減らさない） | × | × | × | × | 届かない | 手動 |
| AIX連動 | ○ | ○ | ○ | ○ | × | × | × | × | ○ 実行 | AIX |
| 🧠×通常（新） | ○ | × | ○ | ○ | ○ | ○※ | ○ | ○ | 届かない | 脳通 |
| 🧠×スタッフ（新） | × | × | × | × | ○（記録だけ） | **×（拡張もサーバーも外さない）** | **×（スタッフの文は変えない）** | ○ | 届かない | 手脳 |
| 🧠×AIX（＝旧「ブレイン」） | ○ | ○ | ○ | ○ | ○ | ○※ | ○ | ○ | **見送り（cancelled）** | 脳 |
※ drop を外すのはサーバーの `PROPERTY_BRAIN_DROP=on` の時だけ（今は影の運用＝1件も外さない）。判定はリアプロの一括DL・自動送信だけ（itandi・レインズは判定なし・売上サポの記録は3サイトとも）

- **storage のキーは変えていない**（staffMode／staffModeAt／aixMode／brainMode）。変わったのは brainMode の意味だけ: 旧「aixMode && brainMode」→ 新「brainMode 単独」。
  旧「ブレイン」{aixMode:true, brainMode:true} は新の ブレイン×AIX（同じ動き）、旧 AIX／スタッフ／通常 もそのまま＝**書き込み（移し替え）は要らない**。旧 `_applyMode` は brainMode:true を必ず aixMode:true と一緒に書いていたので、意味が変わって動きが変わる PC は無い
- モードの書き込み（`_applyMode`）は brainMode に触らず、ブレインの書き込み（`_applyBrain`）はモードに触らない＝片方を変えてももう片方が残る。スタッフの2時間 TTL はそのまま（切れると スタッフ→通常、ブレインは残る＝🧠×スタッフ → 🧠×通常）
- 直した所（旧は「スタッフならブレインを切る」だった）: background `callMergeApi` の `brain_mode = staffMode ? false : …` → `isBrainModeOn()`（スタッフでも売上サポに記録）／`isBrainModeOn()` は brainMode だけを見る／bulk-dl `buildSendItemsBrain` はスタッフ中も判定を呼ぶが、呼んだ時点がスタッフなら apply_drop を無視し note_line を足さない（`_staffAtJudge`）
- 二重押し: ブレインの切り替えは 400ms 以内の2回目を無視。次の値はボタンの見た目でなく storage から読んだ状態の反対。select は値を比べてから入れる（自分で change を起こさない）
- 確かめ: ヘッドレス Chrome（chrome.* の差し替え＋本物の popup.html/popup.js/mode-core.js）で 初回・ブレインON・二重押し・スタッフ・開き直し・AIX・別画面の書き込みの同期・旧「ブレイン」/旧「AIX連動」の値・TTL 切れ・スタッフ時の要対応 を確認。実機の拡張読み込みは未確認
- 竹内さんに確認（今は安全側で入れた）: ①🧠×スタッフでも LINE の説明文末尾に「🧠 ブレイン判定」を付けるか（今は付けない）②🧠×AIX で 11:00/17:00 の自動便も走らせるか（今は旧「ブレイン」と同じく見送り）③🧠×スタッフで売上サポに記録してよいか（今は記録する・DeepSeek の画像費用が手動の送信分も増える）
- ⚠ 別件（触っていない）: `chrome-extension/webapp-bridge.js` が **構文エラー**（`var site`（47行）と `const { site }`（93行）が同じ関数内）で `node --check` が通らない。2026-08-10 の 497a94e9 から。Chrome でも読み込み時に落ちている可能性が高い（ウェブアプリ→拡張の橋渡し: 見積書自動・ウェブからの検索・scrape-and-compare）
- 戻し方: 拡張を v2.5.19 に戻せば、storage はそのまま旧の4択で読める（旧は brainMode:true かつ aixMode:false を「ブレインOFF」と読むので、🧠×通常／🧠×スタッフにしていた PC はブレインが切れた扱いになるだけ）

## 2026-09-25 候補の記憶を太くする — 候補の記録に全項目＋生の文字・🌟の時点の候補一覧・送った画像ごとの値（v2.5.19・竹内）
竹内「候補の記憶を太くする。会話を見たりオススメしている部分を見ればギャップが分かる」
- **拡張（v2.5.19）**: 候補の記録（property_pool → /api/log-property-candidates → property_candidate_pools.candidates の jsonb）を太くした。送る物・説明文・判定の payload は変えない
  - itandi: `itandi-row-parse.js` に **敷金・礼金**（賃料と間取りの間がちょうど6つの並びの時だけ・「なし」=0・「入力なし」=null）、建物の段の **築年月・築年数・階建** を追加。
    `toPoolData()` で 家賃・管理費・敷礼・間取り・㎡・号室・所在地・交通（全行）・徒歩・築・階建・AD・資料URL を候補に（旧は rank・name・ad_months だけ）。
    資料URL は background が Blob に上げた後に付ける（**候補の記録はアップロードの後**に送る。件数が合わない時は URL を付けない）
  - リアプロ: `bulk-dl.js` の buildPropertyData に **㎡**・**管理費の読み違いの直し**（見出し「賃料/管理費」が1列で 管理費＝家賃 が 865/865件 → セルの2つ目の金額）・
    **生の文字**（行のセル全部 cells・見出し head・建物の段 bld_text＝`findBuildingText`）・資料URL（`poolWithUrl`）。駅・徒歩・所在地・築年は拡張で決め打ちせずサーバーが読む（見出しの並びは実機未確認のため）。判定（brain judge）には生の文字を送らない
  - レインズ: 行の文字 row_text を残す
- **サーバー**: `app/lib/candidate-facts.ts`（純関数）の `enrichCandidate` が拡張の値を最優先に、空いている項目だけ生の文字から埋め、出どころを `src` に（ext / text:cells / pickup / image / sent）。`facts_v=2`。
  列 `property_candidate_pools.facts_version / enriched_at`（migrate-schema・本番適用済み）。建物名の照合は2文字組の近さ **0.75** 以上で一番近い物（`bestBuildingMatch`。0.6 だと ハーモニーテラス今林↔田島 のような同じシリーズの別の建物が当たる）
- **🌟の時点の候補一覧**: 新しい表 `recommendation_snapshots`（`app/lib/recommendation-snapshot-server.ts`）。/api/log-aix-usage が property_recommendation の時に waitUntil で1行（送信・本文は変えない・失敗で止めない・予約送信は残さない）。
  候補＝同じ会話でお客様に直近72時間に送った物件（sent_properties・お客様に届いた行）＋🌟。値は 送付記録 → 送った画像ごとの値 → 拡張の回 → 売上サポの行 の順に埋める。🌟の本文の値は `star_text_facts` に分けて持つ（混ぜると🌟に有利）。お客様の発言は写さず希望の話題だけ
- **送った画像ごとの値**（追加の指示）: readPropertyImage（DeepSeek・同じ1回の読み取り）に 管理費・間取り・㎡・最寄り駅と徒歩・築年月・AD を足し、`sent_image_properties.facts`（jsonb・本番適用済み）に1枚ごとに残す（一覧の画像は残さない・記録と分析だけに使い本文の材料にしない）
- **ギャップを見る道具**: `scripts/audit-recommendation-gaps.ts`（読むだけ）。365日の結果: 🌟748回・点を比べた310回で🌟1位 13.5%（でたらめ 22.7%）・全部同点 153回＝**候補の値が薄くて点が分かれない**。
  9/20 以降（送った画像を読むようになってから）は🌟が直近の送付の中 86.4%・候補の家賃 35.6%／敷金・㎡・徒歩・築 0%。🌟の本文には 家賃 89%・敷礼 56%・駅徒歩 70%・築 53%・設備 89% が書いてある＝**スタッフは知っているがブレインに届いていない**。
  訴求した話題のうち候補の値でブレインに見える物はほぼ0（2階以上だけ号室から見える）。希望があるのに訴求が少ない話題: 入居時期 21%・審査 9%・通勤 14%・2階以上 27%・駐車場 30%
- **埋め戻し**: `scripts/backfill-candidate-facts.ts`（拡張の回 4,522回を facts_version=2 に・🌟の候補一覧 748行を source='backfill' で書いた）／`scripts/backfill-sent-image-facts.ts`（**dry-run まで**: 3,532枚・約 $3.60・DeepSeek。YUMA の2枚だけ書いて確認済み）
- テスト: `app/lib/__tests__/candidate-facts.test.ts`（60）・`tests/chrome-extension/itandi-row-parse.test.js`（27）
- **竹内さんが確かめること（拡張の再読み込み後）**: ①itandi・リアプロで「売上番長に送る」→ 1〜2分後に property_candidate_pools の最新行の candidates に 敷礼・築・徒歩（itandi）／cells・bld_text（リアプロ）が入っているか ②リアプロの bld_text が建物の段（住所・沿線）を拾えているか（拾えていなければ cells の中身を見て読み方を決める）③AIX 物件オススメを送った後に recommendation_snapshots に source='live' の行ができるか（デプロイ後）

## 2026-09-25 拡張でも「◯◯まで一本／◯分以内」を理解する — 路線のつながりをサーバーと1か所に（v2.5.17・竹内）
竹内「地図の部分や沿線の部分の位置関係の強化は拡張ツールでも理解できるようにする。例えば梅田駅まで電車で一本の場合、梅田駅や大阪梅田駅に一本で通える沿線を全て理解して、そこの駅を理解していれば分かるし、位置関係も理解していれば、電車で何分以内で通える駅かも分かる」
- **元データは1か所**: `app/lib/osaka-geo.ts`（駅の座標・路線の直し LINE_FIXES・足した路線・**直通の運転 THROUGH_SERVICES**・**駅のまとまり STATION_GROUPS**・歩きの乗り換え WALK_LINKS・名前の揺れ ALIASES/PREFIXES）＋拡張の popup-maps.js の写し（osaka-transit-data.ts）。
  `npx tsx scripts/build-osaka-transit-data.ts` が ①`app/lib/osaka-transit-data.ts` ②**`chrome-extension/osaka-transit.js`**（UMD・`self.AxlxOsakaTransit`・55KB）を生成。**どちらも手で編集しない**（直したら流し直す）
- **関数も1つ**: `app/lib/transit-core.ts`（import なしの純関数）を生成時に JS へ変換して osaka-transit.js に入れる＝サーバー（`app/lib/transit-route.ts`）と拡張で同じ関数・同じデータ。テストで結果が一字一句同じことを確かめる
  - `oneRideStations(目的地)` → 乗り換えなしで行ける全駅（路線ごと・直通の運転を含む・目的地のまとまりの駅は除く）
  - `stationsWithin(目的地, 分, {maxTransfers})` → 所要の目安付きの駅（隣の駅の分＝停車0.8分＋1.1分/km・乗換5分・歩きの乗換5分・既定 乗換2回まで・分の短い順）。**各駅停車の目安**（新快速・特急は無い: 京都河原町→梅田 72分・三ノ宮→梅田 43分）
  - `shortestRoute`・`groupOf`・`commuteAsks(文)`（「梅田まで電車1本」「大阪駅から30分以内」「北新地にアクセスがいい」「会社が淀屋橋にあり通勤しやすい」を読む・徒歩/車/バスの分は読まない・「大阪市内」「川俣本町」は駅にしない）・`extName/extNames`（拡張の辞書の言い方に戻す）
- **駅のまとまり**（着いたと同じ）: 梅田＝梅田/大阪梅田/東梅田・JR大阪・西梅田・北新地／なんば＝難波/大阪難波/南海難波/JR難波（日本橋は別）／天王寺＝天王寺・大阪阿部野橋・天王寺駅前／心斎橋＝心斎橋・四ツ橋／上本町＝大阪上本町・谷町九丁目／京橋・本町・新大阪・新今宮・南森町・淀屋橋・北浜・十三・鶴橋・三ノ宮
- **直通の運転**（12本・向きのある並び）: 御堂筋⇔北急／阪急千里線⇔堺筋線／阪急京都線(高槻市)⇔堺筋線／中央線⇔けいはんな線／近鉄奈良線⇔阪神の**快速急行（止まる駅だけ）**／泉北⇔南海高野線／近鉄長野線⇔南大阪線／JR宝塚線⇔大阪／JR宝塚線⇔東西線⇔学研都市線／JR神戸線⇔東西線⇔学研都市線／JR神戸線⇔JR京都線／京阪本線⇔中之島線。**入れていない**（全部の電車ではない・要判断）: 大和路快速・関空/紀州路快速の環状線、阪急千里線→梅田、能勢電→梅田、おおさか東線→大和路線（拡張の「電車1本」と同じ扱い）
- **目で読んだ結果**（`npx tsx scripts/audit-osaka-transit.ts [--full] [--min=30]`・サーバーと拡張の食い違い 0）:
  | 目的地 | 一本 | 30分以内（乗換2回まで） |
  |---|---|---|
  | 梅田 | 203駅・17経路 | 292駅 |
  | なんば | 143駅・11経路 | 292駅 |
  | 天王寺 | 117駅・9経路 | 266駅 |
  | 京橋 | 98駅・8経路 | 251駅 |
  | 本町 | 49駅・5経路 | 276駅 |
  | 新大阪 | 66駅・5経路 | 225駅 |
  - 読んで直した誤り: ①**環状線が輪になっていなかった**（京橋→大阪を天王寺回りで数えていた）→ transitData で輪を閉じた ②JR宝塚線（尼崎から）→大阪が乗り換え1回・逆に三ノ宮まで直通扱い（路線の組の直通は向きが無い）→ 並びの直通に ③阪神なんば線の直通で出屋敷（快速急行が止まらない）を一本にしていた → 止まる駅だけ ④天王寺に阪堺上町線（天王寺駅前）が入っていなかった ⑤拡張の言い方「能勢電平野」を谷町線の平野に戻していた・「住吉(神戸)」を大阪の住吉に戻していた
  - **サーバーの最短の乗り方も変わった**（area-want の通勤の札・担当 A に影響）: 代表12駅×全駅 6,000組のうち 1,687組 — 乗換が減った 1,319（直通・まとまり）／分が減った 335／分が増えた 26（±1分の丸め）／乗換が増えた 7（分の短い方を選んだ）。area-commute 116・property-brain 88 ほか関連テストは全部通過
- **拡張への組み込み（候補として見せてスタッフが選ぶ・自動の検索は変えない）**: `chrome-extension/commute-candidates.js`（UMD・`self.AxlxCommuteCandidates`）
  - 一時調整フォームの「駅」欄の下（`#commute-candidates`・3サイト共通の adj-form）に、お客様の 通勤の列（commute_station/commute_minutes）・希望エリア・条件欄から読んだ目的地ごとに
    - 🚃「梅田まで一本（乗り換えなし）」: 経路ごとのチップ（＋阪急宝塚線 18 等）・「＋全部を駅に入れる」
    - ⏱「本町まで20分以内（乗り換え1回まで）」: 駅ごとのチップ（駅名＋分・乗換）・分（10〜60）と乗換（0〜2）の切替・「＋全部を駅に入れる」
  - 押すと駅欄に**拡張の辞書の駅名**（STATION_LINE_MAP・学習済み・DB の駅）で入れ、input の出来事を出す（手で打った時と同じ＝一時調整優先・履歴保存）。駅欄の「梅田まで電車1本」等の通勤の言い方の語は外す。そこから先のリアプロ／itandi／レインズの駅名・路線名は**既存の対応表のまま**（ここではサイトの表記を作らない）
  - 駅の言い方は乗る路線で選ぶ: なんば×大和路線→JR難波・×南海→難波・×近鉄→大阪難波・×御堂筋→なんば、平野×大和路線→JR平野、梅田×阪急→大阪梅田。拡張の辞書に無い駅（京都・兵庫の一部・JR京都線の岸辺〜茨木 等）は入れず数だけ出す
  - **変えていない**: 「電車1本」の自動（resolveDirectCommute＝沿線を選んで全駅）・「◯分」の自動（TRANSIT_GRAPH の展開）・popup-maps.js の辞書（LINE_STATION_ORDER 等）。読み込み: popup.html に `osaka-transit.js`→`commute-candidates.js`→popup.js、manifest の web_accessible_resources に2つ、styles.css に `.commute-candidates`
- **拡張の辞書の誤り（直していない・判断待ち）**: 御堂筋線の新大阪／西中島南方の順・中央線に森ノ宮なし・片町線の放出→鴫野・東海道本線の大阪→塚本→新大阪・関西本線の加美／平野、JR東西線の末尾に放出、能勢電の「平野」が谷町線の平野と同じ名前。直すと LINE_STATION_ORDER の範囲指定（本町〜南森町）・TRANSIT_GRAPH（◯分の自動展開）が変わる。**今の TRANSIT_GRAPH の「梅田まで30分」には能勢電の 多田・一の鳥居 が入る**（平野の取り違え）。新しいつながりとの差（30分）: 梅田 旧256／新292駅・旧だけ23（多田・一の鳥居・高槻 等）・新だけ57（尼崎・甲子園 等 兵庫側）。自動の展開を新しい方に替えるかは実機で確かめてから
- テスト: `node tests/chrome-extension/osaka-transit.test.js`（35・self で UMD を読む・辞書の駅名に戻す・サイトの路線名を入れない・読み込みの順）・`npx tsx app/lib/__tests__/transit-core.test.ts`（80・サーバーと拡張が同じ・一本／◯分／最短／文の読み）
- **実機で確かめること（拡張の再読み込みが必要・version 2.5.17）**: chrome://extensions → 🔄 → リアプロ／itandi で「梅田まで電車1本」や通勤の列があるお客様を選ぶ → 一時調整の「駅」欄の下に 🚃／⏱ の候補が出るか → チップを押して駅欄に入り「🚉 駅で検索中（一時調整優先）」になるか → 自動入力で検索できるか（駅数が多い時にサイト側の上限で止まらないか）。コンソール `[AX] 通勤の候補:`・`[AX] 通勤の候補の駅を駅欄に追加:`

## 2026-09-25 売上サポ: 画像・資料の保存期間 72時間（竹内「3日前の画像は消されるように。保存期間が終了しましたと出る感じで（実際の LINE のように）」）
- 調べた量（9/25 時点）: property_pickups 36行（9/24 の1日分・お客様4人＝18／12／3／3行）。1行 ≈ PDF 250KB〜1.8MB＋p1・p2 各 260〜650KB＋トリミング 200〜540KB ≈ **1.7MB/行**（36行で ≈ 61MB）。**消す仕組みは無かった**（cleanup-images は messages の line-images 30日と property-images 90日だけ）
- 置き場: PDF・p1・p2・トリミングは Vercel Blob の `pickups/`（`pickups/trim/`）。切り出し画像は保存していない（メモリの中だけ）。**LINE で送った画像は AIX が Supabase property-images へ写してから送る**（AixModal の uploadImage）ので、Blob を消しても LINE の会話の画像は消えない
- 仕組み: `/api/cron/pickup-retention`（毎日 UTC 19:40＝JST 4:40・CRON_SECRET・`?dry=1&measure=1`）→ `app/lib/pickup-retention-server.ts`。選び方は純関数 `app/lib/pickup-retention.ts`（テスト 27件 `npx tsx app/lib/__tests__/pickup-retention.test.ts`）
  - 消すのは **Blob の pickups/ 配下だけ**。消さない: messages / sent_properties / sent_image_properties が同じ URL を指す物（完全一致＋Blob の pickups/ を指す行の総なめ・照会に失敗したら消さない側）・まだ期限内の行が使っている URL・pickups/ 以外（Supabase・結合 PDF）
  - 消した行は `expired_at` を入れ、4つの URL の列を空にする（行の説明文・判定・札・分析の文字・PDF の文字層は残す）。Blob の削除に失敗した行は印を付けず翌日やり直す。1回 300行まで
  - property_sheet_facts・image_details（読み取りの文字）は消さない
- 画面: `GET /api/property-pickups`（一覧・詳細・?ids）は `withPickupRetention` で **72時間ちょうどで** expired（URL を空）にする（cron の前の数時間も LINE と同じ見え方）。PickupReview は画像のかわりに灰色の枠「🔒 保存期間が終了しました」・💾 画像保存／🔍 画像で分析／📤 AIXで送る は押せない（理由を1行）・残り12時間を切ると「⏳ あと◯時間で…」。AIX に渡す画像（?ids）も期限切れは null
- 列: `property_pickups.expired_at`（migrate-schema＋`scripts/apply-pickup-expired-column.ts` で本番に適用済み）
- 点検: `npx tsx --env-file=.env.local scripts/pickup-retention.ts [--now=ISO]`（既定 dry-run）。9/28 の時刻で dry: 36行・消す Blob 96個 ≈ 41MB・残す 9（YUMA のテスト行 9〜11 の Supabase の画像＝LINE で送った物 6・pickups/ 以外 3）・**消す物のうち送信の表に出る物 0/96**
- YUMA で確かめた（行を作って片付け済み）: Blob の鍵が無い時は消さず印も付けない／Blob が無い行は印＋列が空／API は 96時間前＝expired・65時間前＝残り7時間の警告・AIX に渡す画像は期限切れだけ null
- 未確認: 実際の Blob の削除（手元に BLOB_READ_WRITE_TOKEN が無い）。デプロイ後に `curl -H "Authorization: Bearer $CRON_SECRET" …/api/cron/pickup-retention?dry=1&measure=1` を見てから、最初の本番の実行（9/27 JST 4:40 に 9/24 分が対象）後に `expired_at` の件数と Blob の URL が 404 になるかを見る
- 残り（竹内さんが決める）: 結合 PDF（Blob 直下・LINE グループに貼るリンク）は今回消していない／送った行の画像を売上サポに残したい場合は sent_properties の property-images の写しを見せる形にできる

## 2026-09-25 売上サポ: 資料の表の敷礼・築年・入居時期・契約・入居の条件を判定に組み込む（竹内「敷金礼金と入居時期、組み込みたい」）
- きっかけ（9/24「ほかにもれないか」の監査）: 判定の仕組みはあるのに物件側の値が届いていなかった — property_pickups 36行中33行が INITIAL_COST_UNKNOWN（説明文に敷礼が無い）・BUILDING_AGE_* は本番で0行・入居時期はどこでも照らしていない
- 部品（純関数・DeepSeek 0円）:
  - `app/lib/listing-terms.ts`（parseListingTerms・termsToBrainData・moveInAvailableFrom・compareMoveIn・formatListingTerms）— **import なし**（未コミットの listing-text.ts への依存を外し、NFKC・部首補助・「‧」・空白の正規化を中に持たせた。listing-equipment の norm と同じ中身・直す時は3か所を揃える）。36行で旧版と完全一致・誤読0（`scripts/audit-listing-terms.ts`）
  - `app/lib/move-in-want.ts`（parseMoveInWant）: お客様の move_in_time → 'YYYY-MM-DD'。上旬=10日・中旬/半ば=20日・下旬/末/月だけ=末日・月が複数は一番遅い月・すぐ/最短/至急=今日（照合に14日の猶予）・今年中/年内=12/31。**札を付けない**: 目安（◯ヶ月後くらい・◯ヶ月以内・半年以内）・季節・始まりだけ（5月以降・7月末〜）・未定/いつでも/見つかり次第・**過ぎた日**（登録日 created_at 基準で年を決める。5〜7月登録の「7月」は情報が古い）
    - 全件監査 `scripts/audit-move-in-want.ts`（234人）: by 93／過ぎた日 63／決まっていない 35／すぐ 24／目安・季節 12／始まりだけ 7。値ごとに目で読み読み違い0（初回の「5月登録の4月→来年」は前月までは今年に直した）
  - `app/lib/pickup-terms.ts`（buildPickupTerms・formatTermsLine・moveInLabel）: 保存形と画面の1行
- **recordPickupBatch**: pdfText に parseListingTerms → `fillFactsFromTerms`（説明文・拡張の値が無い所だけ敷金・礼金・築年を埋める）→ judgeProperty の `{ terms }` → `property_pickups.terms`（jsonb・本番に適用済み）。落とした部屋の判定にも当てる。ログ `property-pickups:terms`
- **判定の札**（property-brain.ts・drop には使わない）:
  - 入居時期（希望が by/asap の時だけ）: `MOVE_IN_OK` +5／`MOVE_IN_LATE` −10 保留（入れる一番早い日が希望日より14日超遅い）／`MOVE_IN_UNKNOWN` 0（相談・居住中・記載なし）
  - 契約: `CONTRACT_FIXED` −5 保留（定期借家は誰でも）／条件欄に定期借家・契約期間の語がある時だけ `CONTRACT_NORMAL`・`CONTRACT_UNKNOWN` 0
  - 更新料（語がある時だけ・点0）: `RENEWAL_FEE_NONE`／`_SET`／`_UNKNOWN`。フリーレント: `FREE_RENT_MATCH` +3（初期費用を抑えたい人）／`FREE_RENT` 0／語があるのに記載なし `FREE_RENT_UNLISTED` 0
  - 入居の条件（条件欄にその語がある時だけ・NG 欄は見ない・「楽器は使わない」等の否定は外す）: `CONDITION_<INSTRUMENT|CORPORATE|FOREIGNER|STUDENT|OFFICE|SINGLE|TWO_PERSON|ROOM_SHARE|CHILDREN>_OK` +3／`_NG` −10 保留／`_ASK` 0／`_UNLISTED` 0。**二人入居は設備の照合（EQUIP_TWO_PERSON_*）と1つだけ**（設備で決まれば terms は付けない・terms で決まれば設備の「記載なし」を外す・applyEquipmentMatch も同じ）
  - REASON_POINTS・reasonPoints・reasonJa・HOLD_REASON_CODES・画面の短い札（pickup-review-order の CHIP_JA）に入れた
- **画面**（PickupReview の TermsLine）: 「💴 敷0/礼1ヶ月 築18年 入居:11月上旬 普通2年 更新1ヶ月（資料の表から）」＋「希望: 入居○（希望 11/10まで）法人契約相談 楽器－」。API は terms を返す
- **拡張の判定**（`/api/property-brain/judge`・PDF なし）は今まで通り（terms を渡さない＝新しい札は付かない）
- YUMA（scripts/yuma-condition-leak-test.ts --apply → --cleanup 済み・DeepSeek なし・資料 リアプロ #45/#44/#43・itandi #67/#66/#65 → 5行）: 漏れ **16→8種類**。初期費用・敷礼ゼロ（材料なし→届いた・札5/5）・築年（🌟だけ→届いた）・入居時期（札3・残り2は相談で要確認）・定期借家・更新料・フリーレント・楽器・法人 が全部「届いた」。ただしフリーレント・楽器は5件とも「記載なし＝要確認」
- テスト: listing-terms 89・move-in-want 57・pickup-terms 50（50＋合計＝score・drop なし・二人入居1つ）。関連 listing-equipment 159・pickup-equipment 64・property-brain 88・pickup-review-order 58・property-pickups 44・pickup-dedupe 33
- 残り: 既存の property_pickups 行の terms は空（付け直しは未実施）／お客様の「築浅」の自由文を年数の希望にしていない／短期解約違約金・保証会社・鍵交換は未計算／audit-condition-coverage.ts と yuma-condition-leak-test.ts は itandi の途中（pickup-rank の enrichSummariesFromPdf）に依存するので itandi と一緒にコミット

## 2026-09-24 深夜 売上サポ: 資料の設備欄 × お客様の条件を判定に組み込む（竹内「HONOKA さんの場合、宅配BOX付きなども条件なのにそこちゃんと入れていない」「設備面も見るように」「202号室なら2階」）
- 部品: `app/lib/listing-equipment.ts`（文字層から所在階・設備の有無を決定論で読む・DeepSeek 0円）＋組み込み `app/lib/pickup-equipment.ts`（`buildBatchEquipment`・`toPickupEquipment`・`matchFromSummary`・`floorLabel`・純関数・画面と共用）
- **recordPickupBatch**（`app/lib/property-pickups-server.ts`）: すでに取っている pdfText に parseListingEquipment → **回の全部の行（同じ建物で落とした部屋も文字層だけ取って含める）**を mergeBuildingEquipment で補う（エレベーター・宅配ボックス・オートロック・ネット無料・駐車場だけ「○〔建〕」）→ parseEquipmentWants(条件欄) と matchEquipment → `property_pickups.equipment`（jsonb・{facts 要約, match, floor, floorSource, uncovered, line}）に保存。判定は設備の照合の後で行う（judgeProperty の第4引数 `{ equipment }`）。ログ `property-pickups:equipment`
- **判定**（`app/lib/property-brain.ts`）: `EQUIP_<KEY>_OK` +3（合計 +15 まで・越えた分は `_OK_MAX` 0点）／`_NG` −10 で保留（外す候補には使わない）／`_UNLISTED` 0点で札「要確認: 宅配ボックス」／ペット相談は `_ASK` 0点／必須（strong）の × は `EQUIP_MUST_NG_CAP` で上限20（画像で分析と同じ）。reasonPoints・reasonJa に入れた（50＋合計＝score のテスト込み）
  - 設備欄で ○/× が決まった希望（バストイレ別・独立洗面・南向き・2階以上）は **imageChecks から外す**＝画像（readFloorPlanFacts）で読み直さない・二重に数えない（費用も減る）
  - PET_NG（説明文の「ペット不可」）は、設備欄でペットが決まった時だけ EQUIP_PET_* に置き換え（決まらない時は今まで通り）。文字層のある18行で食い違い0
  - 保存済みの行の付け直しは `applyEquipmentMatch`（元の家賃・徒歩・AD・画像のコードは残す。説明文が古い形の行で judgeProperty をやり直すと材料が消えるため）
- **拡張の判定**（`app/api/property-brain/judge/route.ts`）: PDF が無いので説明文から読めた分だけ（号室から推した階・説明文に書いてある設備）。記載なし（要確認）は付けない
- **画面**（`PickupReview.tsx` の EquipmentLine）: 「🏢 9階（所在階）／5階（号室から推定） 条件: 2階以上○ エレベーター○〔建〕 宅配ボックス－ …」（× 赤・－ 灰・○ 緑・△ 橙）。印をタップで根拠（資料の文字）。照らせない条件は「照らせない条件: …」。API（`GET /api/property-pickups`）は equipment を返す
- 列: `property_pickups.equipment JSONB`（migrate-schema・`scripts/apply-property-pickups-table.ts` で本番に適用済み）
- 付け直し: `npx tsx --env-file=.env.local scripts/backfill-pickup-equipment.ts --ids=50-67 [--apply] [--backup=<path>]`（既定は dry-run）
  - **id 50〜67 は dry-run だけ（本番への書き込みは許可が下りず未適用）**。前後（dry-run）: 50 105→105／51 105 hold→101 hold（1階×）／52 105→105／53 100→102／54 105→99（エレベーター・宅配－）／55 115→117／56 100→102／57 90→84／58 120→120／59 120→120／60 65 hold→80 hold／61 90→102／62 55→70／63 90→105（〔建〕で補う）／64 90→99／65 65 hold→64 hold（1階×）／66 90→99／67 90→105
- テスト: `app/lib/__tests__/pickup-equipment.test.ts`（54件）・pickup-review-order に EQUIP 込みの 50＋合計＝score
- 残り: 落とした部屋の文字層は保存しないので、既存行の付け直しは保存した行の中でしか〔建〕を補えない／uncovered（防音 等）を文字で聞く buildEquipmentAskPrompt の呼び出しはまだ無い

## 2026-09-24 深夜 売上サポ: 並び順（🌟→点）・外す候補の理由の札・💾 画像保存（一括）・分析結果に画像（竹内「なんで全部外す候補20でばらつきないのか」）
HONOKA さんの itandi の回（property_pickups id 50〜67）で 18件中15件が「外す候補 20」で横並びだった。
- **原因（2つ重なっていた）**: ①itandi の説明文は拡張が名前を取れず全件「【n】物件」→ `property-brain` の送付済みの建物（sentBuildings）に「物件」が入り、今回の「物件」全件が ALREADY_SENT（−30・drop）＝ 50−30＝20 ②その「物件」18行は sent_properties の **delivery='shared'・source='line_group'**（同じ回を売上番長グループに共有しただけ）＝ 自分自身の共有で「送付済み」になっていた。お客様に届いた送付ではない
- **直し（`app/lib/property-brain.ts`）**: 一般名（`app/lib/generic-building-name.ts` の `isGenericBuildingName`＝物件・マンション・物件3・【4】物件…。pickup-dedupe と同じ決まりを1つに）は送付済みに入れず照合もしない。`isCustomerDelivery`（delivery='customer'、または delivery 無し・source≠line_group）の行だけ送付済みに入れる（読み込みは `property-pickups-server.loadProfile`・`/api/property-brain/judge` が delivery・source も select）
- **管理費**: リアプロの説明文「75,000円 10,000円」の2つ目（言葉なし）を管理費として読む（pickup-dedupe の adminFeeOf と同じ線）。id 34〜45 は全件「家賃は上限内 +15」だったが、実際は家賃＋管理費 81,100〜85,000 で上限 8万を少し超過（0点）
- **点の表**: `REASON_POINTS`・`reasonPoints(code)`・`BASE_SCORE`（judgeProperty の点と同じ。テストで全コード 50＋合計＝score を確かめる）。画面の「点の内訳」はここから作る
- **並び順**（`app/lib/pickup-review-order.ts` の `sortForReview`）: 🌟★ → 🌟 → 点の高い順（点なしは最後）→ 同点は元の順位。API（view=detail）と画面の両方で同じ関数。分析結果の吹き出しは画像で分析の点の高い順（要確認・点なしは後ろ）
- **理由の札**（`buildReasonView`・`formatScoreBreakdown`）: 点の横に「✕ 送付済みの建物 −30」（外す理由＝赤）・減点（橙）・「材料なし: 家賃・敷礼・AD」（灰＝点が動かない理由）・加点（緑）・利益目安。「点の内訳」を押すと「基準50 −30 送付済みの建物 ＋15 家賃は上限内 … ＝ 35」。reason_codes が無い古い行は reasons_ja をそのまま
- **💾 画像保存**（旧 ✂️ 画像トリミング）: チェックした物件のお客様に送る1ページ目（`pickSaveImageUrl`＝トリミング→文字のある page_image_url。**元付の資料 agent_image_url は選ばない**）。無い物件は先にトリミング。スマホは `navigator.share({ files })`（canShare で確認）→ 共有シート「N枚の画像を保存」で写真へ。画像の用意中に押した操作の有効期限が切れると NotAllowedError → 下に「📲 写真に保存（N枚）」を出してもう一度押してもらう。パソコンは1枚ずつダウンロード（400ms 間隔）。画像は Vercel Blob（Access-Control-Allow-Origin: *）なのでプロキシは不要（実測）。1枚の「💾 保存」もスマホは共有シート
- **分析結果の吹き出し**: 各物件に送る形の画像（88×62・押すと原寸）とチェック（上の一覧と同じ checked）。下に「この分析から n件を選択中」「点の高い3件だけ選ぶ」「📤 AIXで送る（n件）」「💾 画像保存」＝ 分析で絞った物件をそのまま送る／保存
- **👑 全体で一番条件に合う**: 画像（1ページ目・押すと原寸・💾 保存）。API の best に `image_url`（pickSaveImageUrl・元付は返さない）を足した
- **id 50〜67 の付け直し**（本番の行を更新・前の値は scratchpad `pickups_50_67_before.json`）: 前 drop 20 ×15・hold 50・pass 60/65 → 後 pass 90〜120（13件）・hold 65 ×2（AD より割引が大きい）・hold 105（1階＝画像）・pass 55（家賃が上限を少し超過）。材料は PDF の文字層（listing-text の fillSummaryFromListing＝v2.5.16 の説明文と同じ形）＋保存済みの画像の読み取り。**summary_text は変えていない**
- **リアプロ id 34〜45 の点のばらつき（行は更新していない・試算だけ）**: 直した判定で 80（AD 2ヶ月）／65（AD 1.5ヶ月）の2段。家賃は全件が上限を少し超過（同じ段）・徒歩／敷礼／築年は説明文に無く「材料なし」。→ 点を分けるには材料（交通・敷礼）を説明文に入れるのが先（段の中の家賃の差を点にするかは未決・実送信で線を引いてから）
- テスト: `app/lib/__tests__/pickup-review-order.test.ts`（58件）

## 2026-09-24 夜 売上サポ →「📤 AIXで送る」で AIX に今回の物件の事実を渡す／スマホの点検（竹内「改善する。DeepSeek でテストする」）
- **売上サポ → AIX の受け渡しに行 ID を足した**: `app/page.tsx` の pickupHandoffRef が画像と同じ並びの property_pickups の行 ID を `aixInitialPickupIds` に持ち、AixModal（`initialPickupIds`）が **画像がセットされた時のまま（同じ File・同じ並び）の時だけ** `body.pickup_ids` で送る。外した・足した時は送らない。手で選んだ画像（onAixMultiImagesSelected）は ID を空にする
- サーバー（`app/api/aix/action/route.ts`）は pickup_ids を会話 ID で絞って読み、**間取り・家賃だけ**（`app/lib/pickup-send-facts.ts` parsePickupFact・AD／利益／🌟／管理費は読まない）を【今回お送りする物件】として生成に渡す。行の数と画像の枚数が違えば使わない
- GET /api/property-pickups?ids= の6つの鍵は変えていない（事実はサーバーが自分で読む＝説明文は画面を通らない）
- **スマホの点検（PickupReview.tsx）で直した穴**: ①会話は古い順なのに開くと一番上（古い方）から出ていた → 開いた時・メモを残した後・キーボードが出た時は一番下へ（画像の遅延読み込みに合わせて 350ms 後にもう一度）②画像を大きく開いている時に端末の「戻る」を押すと会話ごと閉じていた → 画像だけ閉じて履歴を積み直す（LINE と同じ）
- 点検して問題なかった所: 下の余白（visualViewport か 100dvh の fixed 全画面・親は 100svh）、入力欄（viewport が maximumScale 1 なので 14px でも拡大されない・キーボード時は下の余白 4px）、右スワイプ（入力欄・ボタンからは始めない・スワイプ後 500ms はクリックを止める）、PC の2列（md 以上は static のまま）。**iPhone 実機は未確認**
- 設計知見: 「AIX の生成は画像を読まない → 今回の物件の事実は売上サポの行から渡す」（AIX・売上サポ）

## 2026-09-24 夜 スマホの LINE トーク UI・余白・説明文が送られた件（竹内・スクショ2枚）

**① 説明文がお客様に届いた（2枚目）— 送信の出口をサーバーで断った**
- 実物: お客様の LINE に画像の後で「【1🌟★】ダイレ・エヌ／80,000円 10,500円／1LDK 39.23㎡／AD 1ヶ月／【2🌟】Abelia…」が届いた
- 出どころ: 旧 UI の「確認してお客様に送る」→ `/api/property-pickups/send` の action:"send" が `buildCustomerPickupMessage`（summary_text＝拡張の説明文。AD・🌟 入り）を本文にして `/api/send-line-message` へ送っていた。本番ビルドが a135f0de〜a4254e3c の間落ちていたので、画面は旧版（直接送るボタン）のままだった
- 直し:
  - `send/route.ts`: 直接の送信の分岐を削除。send・action 無し・知らない値は **410**（「お客様への送信は AIX【物件ピックアップした】から行います」）。残る操作は skip と mark_sent だけ（どちらも LINE に送らない）。旧画面・開いたままのタブ・PWA のキャッシュから押されても届かない
  - `app/lib/property-pickups.ts`: `buildCustomerPickupMessage` を削除（説明文をお客様向けの本文に変える関数を残さない）。`classifyPickupSendAction`・`toPickupHandoffItem`（AIX への受け渡しは id・順位・物件名・号室・会話・画像の6つだけ）を追加
  - `GET /api/property-pickups?ids=`（AIX への受け渡し）が summary_text を返すのをやめた
  - `page.tsx` の pickupHandoffRef は画像（setAixInitialSendImages）と openAixDirect だけで、入力欄に文を入れない（確認のみ・変更なし）
  - テスト: `app/lib/__tests__/property-pickups.test.ts`（実物の説明文を使い「AD・🌟・広告料・利益・説明文が受け渡しに無い」「send の API が send-line-message を呼ばない・summary_text を読まない・410」を固定）
  - `scripts/yuma-trim-send-test.ts` の /send は 410 が返れば正しい（冒頭に注記）

**② スマホで LINE のトーク画面と同じ UI（`app/components/PickupReview.tsx`）**
- スマホ（md 未満）で開いた会話は `fixed inset-0 z-[60]` の全画面（下ナビ z-40・売上サポのヘッダー z-20 より上）。高さは visualViewport（height・offsetTop）、無ければ 100dvh
- ヘッダーは LINE と同じ（‹ 戻る＋未確認数／中央に名前とアカウント／右に「LINE」「更新」の札・rgba(218,238,253,0.88)＋blur）。背景は LINE と同じ水色のグラデーション。日付の区切りも同じ
- 左＝起きた事（🧠ピックアップ・✂️画像・🔍分析・📦送った物件の履歴）は白い吹き出し＋32px のアイコン・時刻は吹き出しの外の右下。送った物件の履歴は上のカードをやめて左の吹き出しの中で開閉
- 右＝こちら（メモ・送った・見送り）は緑の吹き出し rgba(220,248,198,0.55)・時刻は外の左下
- 下の入力欄は LINE と同じ形（丸い灰色の欄＋水色の紙飛行機ボタン・safe-area）。日本語の変換確定の Enter でメモが送られていた不具合を直した（isComposing）
- 右スワイプ 90px 超・端末の「戻る」で一覧に戻る（履歴を1つ積む）
- PC（md 以上）の左390px＋右会話の2列とヘッダー・背景はそのまま

**③ スマホで下に資料1枚分の余白が出た — 原因と直し**
- 原因: 外枠が `calc(100vh - 230px)`・minHeight 480 の PC 向け決め打ち（iOS の 100vh は大きい方・親は 100svh）／`conditions/page.tsx` の pb-16 が内外で二重（128px）／開いた会話がページの流れの中／画像を `<a target=_blank>` で直接開き、縦持ちで A4 横の資料の下が空く
- 直し: スマホの一覧は `h-[calc(100svh-160px)]`（PC は `md:h-[calc(100vh-230px)] md:min-h-[480px]` のまま）・内側の pb-16 を `md:pb-16` に・会話は fixed 全画面・画像はスマホだけ LINE と同じライトボックス（黒背景・中央・object-contain・max-h-[90svh]・✕・💾 保存）。PC は今のまま新しいタブ

**確認**: `npx tsc --noEmit` 0 件・`npx next build` 成功・`npx tsx app/lib/__tests__/property-pickups.test.ts` 44/44

---

## 2026-09-24 送済みバッジの名前の照合を「行・セルの先頭から・名前の終わりまで」に（反証・v2.5.15）

- v2.5.14 はカード本文**全体**に `name_key` が部分一致するかで当てていた → 名前が別の名前に含まれると別の建物に出る（60日の名前キー5,063種類のうち195種類・435組。例「スプランディッド新大阪vi」⊂「…viii」、「グランツ」⊂「エスリード弁天町グランツ」「グランツ上新庄」、「axia」⊂「modernpalazzo江坂axia」）。スタッフが未送付の物件を送った物と見て外してしまう
- → `cardTokens`（本文を改行・タブで行・セルに切る・NFKC・小文字）＋ `nameStartsToken`（行の**先頭から**、空白と「・･」を飛ばして1文字ずつ鍵と比べ、**直後で名前が終わる**時だけ当てる。終わり＝行末・空白・3〜5桁の数字（号室）・記号や括弧。英字・かな・漢字・短い数字が続けば別の名前）
- 当たった名前が別の当たった名前に含まれる時は長い方だけ採る（vi と viii の両方を送った時）
- 取りこぼし（安全側）: 同じ行の中で住所などの**後ろ**に名前が来る形は当たらない。実機で名前が行の先頭に無いカードがあれば直す
- 確認: scratchpad の照合テスト13例（上の誤爆例はすべて当たらない・「コル・デ・ソル杭全 0203号室」「フォルモント寺田町（賃貸）」「エスリード 弁天町 グランツ 203」は当たる）・`node --check` 通過
- 実機確認（未）: v2.5.15 を再読み込み → 実在の顧客でリアプロの一覧。**名前付きで当たるか・vi/viii のような似た名前の建物に出ないか・別の建物の101号室に出ないか**

## 2026-09-24 送済みバッジを経路別に・名前で照合（竹内・v2.5.14）

竹内「売上サポの部分お客さんの物件送った部分のテーブルとも連携されてる形かな？…どれ物件ピックアップで送ったか物件オススメで送ったかもわかる。ここと拡張ツールも連携されてかなり効率の良いサイクルとなる」

- **サーバー**: `sent_properties` に `delivery`（shared＝グループに共有しただけ／customer＝お客様に送った）・`channel`（pickup / recommendation / check / estimate / aix_other / staff_image / extension_group）・`pickup_id` を足した。source の値と意味は変えていない（`vision`＝照合できなかった印のまま）。列が NULL の古い行は source から導く（`app/lib/sent-delivery.ts`）
  - 「売上番長に送る」（merge-pdfs）の行は `delivery=shared, channel=extension_group`。**除外（skip-sent・送済み建物を外す）は今まで通り共有も数える**
  - 売上サポ「📤 AIXで送る」で送り終えると、ピックアップの行から直接 `channel=pickup, pickup_id` 付きで記録（`app/lib/pickup-sent-record.ts`）
- **`/api/check-property-duplicate`**: list と duplicates の各行に `kind`（recommend / pickup / sent / shared）・`name_key`・`room_key` を、個別照合に `best_kind` を**足した**（今あるキーは残す＝古い拡張も動く）
- **score-overlay.js `runDupCheck`**: 旧は**号室だけ**で照合（101号室はどの建物にもある＝別の建物に出る／DB の号室は 0.1% しか無く殆ど出なかった）。
  → カード本文を `nameKey`（NFKC→小文字→空白と「・･」を除く・3文字未満は空。サーバーの `badgeNameKey` と同じ3行）にし、行の `name_key` が含まれる行を候補に。**号室が両方ある時だけ**号室（数字だけ・先頭0を除く）でも絞る。片方しか無ければ建物単位
  - 複数当たったら **オススメ＞ピックアップ＞送付＞共有のみ**（同じ種類なら新しい方）で1件
  - **後方互換**: 応答に `name_key` が無い（古いサーバー）なら今までの号室だけの照合
- **`injectDupBadge(el, sentAt, kind)`**: 位置・形・大きさは今のまま、色と文言だけ変える
  - pickup → 緑 #2e7d32「🟢ピックアップ送信 M月D日」／recommend → 青 #1565c0「🔵オススメ送信 M月D日」／sent → 赤 #c62828「送済み M月D日」（従来）／shared → 灰 #757575「⚪共有のみ M月D日」
  - `extractPropertyInfo` の物件名の除外を `/^(送済み|🟢|🔵|⚪)/` に広げた（バッジの文言を物件名として拾わない）
- ⚠ ここの nameKey と `app/lib/sent-delivery.ts badgeNameKey` は同じ入出力（テスト `app/lib/__tests__/sent-delivery.test.ts` に例を固定）。片方だけ変えない
- 実機確認（未）: v2.5.14 を再読み込み → 実在の顧客でリアプロの一覧 → バッジが名前付きで当たるか・位置と形が今と同じか・**別の建物の101号室に出ないか**

## 2026-09-24 更新日が「すべて表示」のまま検索されていた（竹内・v2.5.12）

竹内「更新日が抜けているので、ちゃんと更新日設定されるようにする。ブレインモードも更新日ちゃんと分かるようにしておく」（スクショ: 送済み 9/22 のお客様なのにリアプロの更新日が「すべて表示」）

- **原因**: 更新日（1/3/7/14日以内）は popup の `calcUpdateDays(前回出した日)` で決まるが、**リアプロの「売上番長に送る」は `last_property_sent_at` を更新していなかった**（itandi だけ `itandi-bulk-dl.js` が `/api/property-tasks` を叩く）。前回の日付が空 → `""` → page-script が `update_date` を「すべて表示」にリセット。確認（`property_viewed_at`）だけの人も同じく空だった
- **直した物**:
  - サーバー `merge-pdfs`: LINE 送信成功後に `PATCH /api/property-customers { last_property_sent_at }`（waitUntil・新規→毎日物件出しの自動昇格と送信回数の管理はそこにある）。全サイト・古い拡張でも残る
  - popup.js `lastPropertyTouchDateJst(c)`: 送った日と**確認した日の新しい方**（自動便の `lastPropertyTouchAt` と同じ線）・JST。`preloadAdjForm` の更新日と「最終送信日」欄がこれを使う。コンソールに `[popup] 更新日: 3日以内 (前回=2026-09-22)` を出す
  - ブレインモードの条件バー（score-overlay.js）に「**更新3日内(前回09/22)**」／「更新日:絞らず」／「初回(更新日なし)」を表示（`axlx_score_data` に `rp_update_days`・`last_touch_date` を追加）
- ⚠ 一括検索（background の `_buildBatchConditions`）は今も `rp_update_days` を自動便以外で渡さないが、リアプロは popup 経由（`axlx-switch-customer`→autofill-btn）で入るので更新日は効く。itandi・レインズの更新日は別（itandi は `reg-date`）
- 実機確認: 拡張 v2.5.12 再読み込み → 送済みのお客様で検索 → リアプロの更新日が「N日以内」になるか・条件バーに「更新N日内」が出るか

## 2026-09-24 ピックアップを「売上サポ」に飛ばして確認→送る／手直しの学習／PDF の文字層（竹内・v2.5.11）

竹内「拡張で地域や駅が分からなかったり従業員が手直ししたところは DB に入って学習されているのか」「PDF は DeepSeek が読めるか」「ピックアップを一度アプリの売上サポに飛ばして、LINE のトーク一覧のように並べ、送る物件とオススメを DeepSeek が判断して共有。スタッフは確認して送るだけ」

### ① 学習の現状（調査・Explore）
- **分からなかった語は既に DB に残り次回から効く**: `/api/token-resolve`（DB→市名ルール→pg_trgm→DeepSeek→Claude web_search）・`/api/resolve-search-conditions`（一括・DeepSeek）が `region_map`／`station_map`／`unknown_tokens` に書き、拡張は起動時に `LEARNED_*_MAP` へ読む
- **残らなかった手直し**: 駅／地域ボタンの切替（メモリのみ）・リアプロ画面での駅の選び直し（送信経路なし）・一時調整（localStorage）。残るのは「✗ 間違い→市区名」と「本条件に反映」だけ
- **ハードコード語は学習で上書きできなかった**（classifyAreaTokens は STATION_LINE_MAP 優先）
- 溜まるだけで誰も読まない: `unknown_tokens.to_review`・`chrome_extension_feedback`

### ① 直した物
- `region_map`／`station_map` に **`priority`**（manual＝100）。`/api/station-map` に **POST**（駅として登録）を新設（今まで駅の手動正解 API が無かった）
- popup.js: `LEARNED_OVERRIDE_MAP`（priority≥100 の語→station/area）を `classifyAreaTokens` の**先頭**で見る（reason=staff_override）。「✗ 間違い」のフォームに **「🚉 駅として登録」** ボタン（`registerStationToken`）
- ⚠ 一括検索側（background.js／resolution-core.js）はまだ override を見ない（個別検索の popup だけ）。駅／地域ボタンの切替そのものは記録しない（顧客ごとの選択を全体の規則にすると誤る）

### ② PDF
- DeepSeek の API は**画像だけ**（JPEG/PNG/GIF/WebP・公式仕様 2026-09-24 確認）。PDF は受けない。チャット画面が PDF を読めるのは文字を取り出しているから
- 今までリアプロの印刷用 PDF は**どの AI にも渡していなかった**（merge-pdfs で結合→Blob→LINE のリンクだけ）
- `app/lib/pdf-text.ts`（pdfjs-dist・純 JS・文字層を取り出す）
- **画像化**（竹内「文字だけではよくない。資料を読み取れる形に」）: `app/lib/pdf-render.ts`（pdfjs-dist ＋ `@napi-rs/canvas`・1ページ目を PNG・約200万画素・ローカル 0.6秒）→ Blob に置き `property_pickups.page_image_url`
  → DeepSeek が画像を読む: `readPropertyImageDetail`（資料の条件＝有無・可否 → `image_lines`・`image_details` にも残す）＋ `readFloorPlanFacts`（希望に画像でしか分からない語がある時 → `image_facts`・判定を更新）。1回分10枚まで・25秒/枚・並列
  → お客様へは **画像→本文** の順で送る（LINE に PDF は送れないが画像は送れる）
- ⚠ Vercel: `next.config.ts` の `outputFileTracingIncludes["/api/merge-pdfs"]` に pdfjs の cmaps・standard_fonts と `@napi-rs/canvas*` を同梱、`serverExternalPackages` に両方。**本番でネイティブが動くかは初回デプロイのログで確認**（落ちれば `[pdf-render] 画像にできない` が出て文字層だけで進む＝止まらない）
- ⚠ 日本語フォントが PDF に埋め込まれていない時は文字が抜けた画像になる（cmaps/standard_fonts で大半は出る想定・実物で確認）
- ⚠ **本番の初回（2026-09-24 10:51 JST・ブレインモードの送信）で文字層も画像も全滅**: `Setting up fake worker failed: Cannot find module '.../pdfjs-dist/legacy/build/pdf.worker.mjs'`。disableWorker でも pdfjs は worker ファイルを動的 import する（fake worker）ので、`outputFileTracingIncludes` に `./node_modules/pdfjs-dist/legacy/build/**/*` を足した。記録自体（property_pickups 3行・判定 pass・PDF の Blob）は入っていた＝fail-open は効いた
- **AD が5件中1件しか取れていなかった**（竹内「今回、他の物件も AD あった」・v2.5.13）: 実物は AD 列が「250% [備考有]」「1ヶ月」「20,000円」。候補プールは5件全部 `read_mode=heuristic` ＝ **見出し行が見つからず**、予備の読み方は「Nヶ月」だけ拾っていた。
  - 竹内の定義: **250% ＝ 家賃の2.5ヶ月分／20,000円 ＝ AD の報酬額**
  - 直し①（拡張）: 見出し行の探し方を多段に（同じ table の th/td「AD」→ 親 table 3段 → 前の行を遡る → 文書全体で row より前の最後の「AD」セル → th 最多行）。コンソール `[AXLX bulk-dl] 列見出し(<strategy>)` で当たった手段が分かる。予備の読み方でも「N%」を月数に
  - 直し②（サーバー・全モード）: merge-pdfs `enrichSummariesWithPdfAd` が、説明文に AD の無い物件だけ資料（元付2ページ目）の文字層から「AD Nヶ月／N円」を足す（🌟 の順位付け・LINE 本文・sent_properties・売上サポの判定が全部これを読む）。ログ `merge-pdfs:ad-from-pdf`
  - 実機確認: 次の送信でコンソールの `列見出し(...)` と、LINE 本文に 250%→「AD 2.5ヶ月」・20,000円→「AD 20,000円」が出るか
- **ブレインモード中は自動便（11:00／17:00 の auto_schedule）を実行しない**（竹内「ブレインモードならブレインモードのままで AIX モードは連動されない」・v2.5.13）: background `_pollAndRunBatch` が auto_schedule のコマンドを `cancelled`（理由付き）で閉じる。pending に残すと後でモードを戻した時に古い便が走るため。手動の一括検索・AIX 起点（source=aix）の検索は今まで通り
- **AD の重みを上げた**（竹内 2026-09-24「優先順番 AD の価値をもっと上げる。AD は報酬なので重要。2ヶ月以上（200%以上）なら追加で点数を上げる」）:
  - `property-brain.ts judgeProperty`: 割引をまかなえる +10（旧5）／AD 1ヶ月以上 +5（AD_1M）／2ヶ月以上 さらに +20（AD_HIGH・旧5）／3ヶ月以上 さらに +5（AD_VERY_HIGH）。円だけの AD は家賃で月数に直す。**上限を 100→130** に（条件が全部合う物件は AD なしで 88〜100 に達し、100 で切ると AD の差が消えるため。100 超は AD の上乗せ）。条件の hold/drop は AD で覆さない
  - 🌟 の順位付け（DeepSeek の文）: 基準2を「条件に合う物件の中では AD を最も重視。2ヶ月／200% 以上は必ず最上位」に
  - 拡張の点数バッジ（score-overlay.js）: AD ≥300% +30／≥200% +25（旧15）／≥150% +15／≥100% +10
- **🌟 の順位付けは DeepSeek**（竹内 2026-09-24「ここ Haiku じゃなくて DeepSeek 使う」）: merge-pdfs `rankAndAnnotateSummaries` → `rankWithDeepSeek`（deepseek-flash・reasoning low・文字だけ・25秒）。文は `buildRankPrompt` で DeepSeek と失敗時の Claude Haiku が同じ物を使う。費用は llm_usage_logs action=property_rank。🌟★ は「お客様の条件への合致→AD→㎡単価→広さ→駅距離」の順で選ぶ（物件検索ブレインの点数とは別の判断・今回は一致していた）
- 売上サポの見え方（竹内「売上サポに反映されていない。紐付け済みのお客さんの UI が LINE チャットに変わっていない」）: ピックアップは別タブに入っていて一覧からは見えなかった → アナウンス／一覧の行に **「🧠 物件 N件 未確認」** の印を出し、押すとピックアップタブでそのお客様の会話風画面が開く（`PickupReview` の `focusKey`）。タブ名にも未確認のお客様数
- **印刷用 PDF は物件ごとに2ページ組**（竹内 2026-09-24「奇数ページ＝弊社に帯替えされた資料・偶数ページ＝元付業者の資料で AD の記載がある。1&2・3&4 がセット」）
  - `property-pickups.ts` の `CUSTOMER_PAGE=1`（お客様に送る画像 `page_image_url`）／`AGENT_PAGE=2`（元付の資料 `agent_image_url`・**DeepSeek はこちらを読む**・お客様には送らない・画面では「🏢 元付の資料」）
  - AD は表の文字に無ければ **PDF の文字層（元付側）から `parseAdFromText`** で補って判定し、`sent_properties.ad_months/ad_yen`（同じ印刷用 URL・未記入の行）にも入れる
  - `pdf-render.ts` は無いページを丸めず null（1ページしか無い PDF の「2ページ目」を弊社の1ページ目と取り違えない）

### ③ 売上サポ「ピックアップ」タブ
- 2026-09-24 夕 竹内「一覧が出るように・開くと履歴・開くとき重い（画像を全部読む）・並びは LINE と連動・幅も LINE と同じ」→ **LINE と同じ左右2列（左 390px・右に会話）**。`GET ?view=list`（要約だけ・ピックアップのあるお客様＋直近30日に物件を送ったお客様・並びは会話の updated_at・30秒ごと／画面に戻った時に取り直す）と `?view=detail&pcid|conv&batches=3`（開いた1人分・直近3回＋「もっと見る」・sent_properties の履歴40件＝🟢ピックアップ／🔵オススメ／⚪共有のみ）。画像は lazy・トリミング画像は2列の小さな表示。売上サポ全体（299件）の読み込みを待たない
- 同日: sent_properties の delivery/channel を**埋め戻し済み**（22,753行・sent_image_properties 97行）
- **2026-09-24 午後（YUMA テスト・DeepSeek）で見つけて直した物**:
  - 🌟 の順位付けは**本番でも毎回 Claude Haiku に落ちていた**（callVisionAlt は画像が無いと送らない）→ `callDeepSeek`（文字も通す）に。順位付けの関数は `app/lib/pickup-rank.ts` に移した（テストから本番と同じ関数を呼ぶ）
  - 元付資料の読み取りが **25秒で時間切れ**（実測1枚 27〜40秒）→ 70秒・merge-pdfs の maxDuration 300
- **トリミングは100%**（竹内「縦横100%でも大丈夫。PDF 1枚目は帯替え済み。元付業者の資料は送らない」）: `REALPRO_SHEET_KEEP_RATIO=1.0`（実測の 86% は `REALPRO_SHEET_TRIM_RATIO_MEASURED` に残す）
- **「確認してお客様に送る」→「📤 AIXで送る（物件ピックアップした）」**: 押すと画像が無い物件は先に画像にし、`/?conv=…&aix=property_send&pickup=<行ID>&batch=…` で LINE 画面を開く → page.tsx が `/api/property-pickups?ids=` の画像（1ページ目だけ・元付は返さない）を File にして AIX【物件ピックアップした】を開く → 送信後（onAfterSend）に `/send {action:"mark_sent"}` で「送った」印
- **「🔍 画像で分析」**（竹内「水回り・キッチン・リビングと洋室の位置関係・収納（WIC）を判断。一番条件に合った物件がわかる」）: `app/lib/pickup-image-analysis.ts`・`POST /api/property-pickups/analyze`。1物件1回・並列・DeepSeek（deepseek-flash・low・12000）。希望は property_customers の条件欄だけ（名前・電話は入れない）。`image_analysis` JSONB に残し、会話画面に「🔍」の吹き出しと「👑 一番条件に合う」。⚠ 最初「対面キッチン」を推測で書いた（セレニティ）→「設備欄にあるか、間取り図でリビング側を向く時だけ」に締めて直った。WIC は読み直しで揺れた（ダイレ・エヌのシューズ WIC を WIC と読んだ回あり）＝参考として使う
- **画像で分析の強化（希望を1つずつ判定）**（竹内 2026-09-24「希望条件や NG 条件の細かい部分も画像から判断できているか。会話から画像でしか分からない希望を拾う。物件オススメで訴求している部分も」）:
  - `app/lib/image-wants.ts`（純関数）: 条件欄・お客様の会話（120日・「欲しい／嫌／お願い」の文とフォームの答え・[画像] の貼り付けは除く）・訴求点（selling_points）から、**資料で確かめられる話題だけ**（水回り・キッチン・部屋の配置・収納・広さ・日当たり/角部屋・階・ペット・設備）を W1… の一覧に。エリア・家賃は入れない。NG・[必須] に印。`image-wants-server.ts loadImageWants` が DB から集める（名前は maskPII）
  - DeepSeek は希望ごとに ok／ng／unknown＋根拠（「設備欄: バス・トイレ別」等）。**点は決定論**（scoreChecksDetail: NG・必須は2倍・必須 NG なら上限20・同点は上限前の点で並べる）
  - YUMA 実測: ペット可NG[必須] を3件とも「ペット相談」で × と判定。YUMA の会話から「お風呂トイレ別・お風呂綺麗・オートロック・クローゼットが壁に埋め込まれてる」を拾えた。⚠「リビングと寝室を分けたい」の判定は読み直しで揺れた（1LDK はどれも隣接なので ◎/× が割れる）
- **トリミングは画面（スタッフの PC）で元の資料を描いて切る**（竹内 2026-09-24「何で元の物件資料で共有できないのか。元の物件資料をトリミングすれば良いだけ」）: リアプロの印刷用 PDF は**フォント埋め込みなし**（開いた PC のフォントで文字を描く）。サーバー（Linux）では文字が抜け、同梱の Noto Sans JP で描くと書体が変わる。→ `app/lib/pdf-trim-browser.ts`（pdfjs-dist をブラウザで・useSystemFonts・worker/CMap/標準フォントは `public/pdfjs/`＝pdfjs-dist 6.3.289 のコピー。**pdfjs-dist を上げたらコピーし直す**）で描いて上86%を切り、JPEG を `/trim {images}` に送って Blob に置くだけ。描けなかった物件だけサーバー側（Noto Sans JP）の予備に回す
- **✂️ 画像トリミング**（竹内 2026-09-24「押すと選択している物件の PDF 1枚目（弊社帯替え分）がトリミングされて画像となって送られる。形は実際にお客さんに送ってる形」）: `app/lib/pdf-trim.ts`（`cropRectForSheet` 純関数・`trimSheetImage` canvas→JPEG）。形は実送信の画像（messages のスタッフ画像 パレ城北 1324×790 ≒ 元 1548×1093 の上 84.5%）と会社の帯の罫線（86.5%）から **上 86%・左右そのまま**。`POST /api/property-pickups/trim {item_ids}` が PDF（Blob）→1ページ目→切る→Blob（`pickups/trim/…jpg`）→ `trim_image_url`。`/send` は trim_image_url を優先。テスト: `scripts/try-trim-pickup.ts`（ローカルで形を見る）・`scripts/yuma-trim-send-test.ts`（YUMA で本番 API を通す・LLM なし）
- 2026-09-24 13:05 竹内「ピックアップを一番左にする・順番も LINE と同じに連動・一覧は LINE と同じ UI（アイコン付き）・ブレインモードで送った日時も出す」→ タブ順 ピックアップ／アナウンス／一覧・既定はピックアップ。GET API が conversations（profile_image_url・updated_at・account）を付け **LINE の updated_at 順**で返す（`order_at`）。行は LINE 一覧と同じ形（アイコン＋🧠・名前＋アカウント札・未確認・プレビュー・右に時刻と緑の件数）。届いた日時（`last_pickup_at`＝batch の created_at）を行と会話風の吹き出し「🧠 ブレインモードで M/D HH:MM に届きました」に出す
```
拡張「売上番長に送る」→ merge-pdfs（今まで通りグループへ）→ **ブレインモードの時だけ**（brain_mode=true・通常／スタッフモードは記録しない・竹内 2026-09-24「ブレインモード限定機能」）waitUntil で property_pickups に1回分を記録
  行＝物件: 説明文・🌟（Haiku の順位）・判定（property-brain 純関数）・PDF の文字層・物件ごとの PDF（Blob）
売上サポ（/conditions）→「ピックアップ」タブ（app/components/PickupReview.tsx）
  → **LINE の一覧と同じ形**でお客様が並ぶ（🏠・名前・「🧠 N件・🌟物件名」・時刻・未確認の数）→ タップで**会話風**
     左＝🧠 ブレイン（1回分の物件・🌟・判定・資料リンク・チェック）／右＝スタッフ（送った・見送り・メモ）。下にメモ欄（property_pickup_notes）
  → チェック（既定: 外す候補以外）→「確認してお客様に送る」→ /api/property-pickups/send → /api/send-line-message（本文＋PDF のリンク）
  ※ 2026-09-24 夜に廃止（説明文の AD・🌟 がお客様に届いた）。今は「📤 AIXで送る」→ AIX【物件ピックアップした】に画像だけをセット。/send の action:"send" は 410
  → status=sent・messages に記録・property_customers.last_property_sent_at 更新。「見送り」= skipped
```
- ⚠ LINE は PDF を画像として送れないので、今は**説明文＋物件ごとの PDF のリンク**を本文で送る。画像で送る（PDF の画像化）は次の段
- お客様の会話に紐付いていない（`conversations.property_customer_id` なし）と送れない → 画面に「LINE未紐付け」の印
- DeepSeek の「送る物件・オススメ」の総合判断はまだ入れていない（判定は決定論・🌟は既存の Haiku）。PDF の文字層が取れると分かってから、文字で「有無」を DeepSeek に聞く段を足す
- 実機での確かめ方: 拡張を再読み込み（v2.5.11）→ 検索して「売上番長に送る」→ アプリの売上サポ→ピックアップ に並ぶか → 「📄 資料を見る」が開くか → コンソール `property-pickups:record` の withText が 0 でないか

## 2026-09-24 夜 売上サポの画像の文字抜けの根本修正・同じ建物の重複・画像で分析の強化（竹内「文字が反映されていないバグ」「同じ建物だと平米数2㎡以内は家賃の低い部屋だけ」「一番オススメを全体の中で」「WIC 等は画像読み取りを推奨」）
- **文字抜けの本当の原因**: 日本語フォントではなく **pdfjs に cMapUrl が一度も渡っていなかった**。`require.resolve("pdfjs-dist/package.json").replace(...)` を Turbopack（本番ビルド）が**モジュール番号（数値）に置き換え** → `.replace` が TypeError → catch で黙って undefined。埋め込みなしの MS ゴシック（Identity-H）の文字は描画命令ごと捨てられ（fillText 0回）、文字層（pdf-text）も空（本番ログ `withText:0`・`Ensure that the cMapUrl API parameter is provided`）。tsx では通るのでローカルでは気付けない
- **直し方**: `app/lib/pdfjs-assets.ts`（サーバー専用）が `process.cwd()/node_modules/pdfjs-dist/{cmaps,standard_fonts}/` を existsSync で求め、無ければ必ず `[pdfjs-assets]` の警告。pdf-render・pdf-text の両方が `...pdfjsAssetParams()` を渡す。可変フォントの Noto は ctx.font の太さを `fontVariationSettings "wght"` に写す（細字・bold が太らない問題も直した）
- **見張り**: `renderPdfPageToPng` が `textDraws`（描いた文字の数）を返す。recordPickupBatch は文字層があるのに 0 なら警告し、`property-pickups:record` のログに `noTextDraw` を出す（**本番確認はこの値が 0・withText>0 であること**）。テスト `app/lib/__tests__/pdf-render-text.test.ts`（実物の PDF `fixtures/realpro-sheet-2p.pdf` で文字層・描いた数・表の欄の色の乗り方を見る＋ソースに require.resolve が戻っていないかの静的な見張り）
- **作り直し**: `scripts/backfill-pickup-images.ts`（既定 dry-run・`--out=<dir>` で画像を保存・`--apply [--reset-analysis] [--delete-old]`）。2026-09-24 の dry-run: 対象 15行（#9〜11・#34〜45）全部作り直せる（p1 768〜1447字・p2 942〜1627字）・画像で分析済み 14行。**本番のデプロイが READY で record ログの noTextDraw=0 を見てから --apply**（BLOB_READ_WRITE_TOKEN が要る）
- **同じ建物の重複**（`app/lib/pickup-dedupe.ts` の `dedupeSameBuilding`）: 同じ建物（名前の完全一致＋Ⅶ↔VII・号棟↔棟）で面積差 2㎡以内は**家賃が一番低い1部屋だけ**売上サポに記録（同じ家賃は 家賃＋管理費→AD 高→面積 広→順位）。面積・家賃・名前が読めない物／間取りが違う物は残す。数珠つなぎにしない（残した部屋と比べる）。落とした 🌟 は残した部屋に引き継ぎ、reasons_ja に「同じ建物の近い広さ（2㎡以内）の部屋を n件省略」。**LINE グループ・結合 PDF・sent_properties は変えない**（recordPickupBatch の最初で絞るだけ・順位【N】は元の番号）。実例: 10件 → 3件（エスリード難波AGREA 8件 → 73,100円の【5🌟】1件）。ログ `property-pickups:dedupe`
- **画像で分析**: ①文字のある画像だけ渡す（`app/lib/pickup-image-url.ts`: トリミング → 文字層が取れた回の page_image_url → 無ければ画面が先に ✂️）②画面は1件ずつ・同時3件で送り、1件ごとに結果を出す。スマホで fetch が切れても再送せず、保存済みを読み直す（分析中と切れた後 2分半は 30秒ごとに詳細を取り直す・画面に戻った時も）③**👑 全体で一番**（`app/lib/pickup-best.ts` の `pickCustomerBest`・最新の回から6時間以内の未送信・点→上限前の点→🌟→新しい回→順位）を詳細 API の `customer.best` で返し、一番下の吹き出しに1つ（同点・未判定の数・「この物件を AIXで送る」）。回ごとの 👑 は全体と違えば「この回で一番」と灰色に ④同じ設備の希望は1つにまとめる（`dedupeWantsByTopic`・ペットが条件・会話・訴求で3重に数えられアイコン1つで100点になっていた）
- **推奨のボタン**: `imageAnalysisNeed`（image-wants.ts・決定論）— WIC・収納・対面/独立キッチン・バストイレ別・独立洗面・室内洗濯機置場・部屋の配置が希望にあれば recommended → 「🔍 画像で分析（推奨: WIC・対面キッチン）」を先頭・全幅・濃い色、吹き出しに「画像で確かめたい希望」。ペット・設備だけは今のまま。希望なしは灰色で小さく（消さない）。判定は詳細 API の `customer.image_need`（分析済みの希望があればそれ・無ければ条件欄だけ。会話は引かない）
- **iPhone のトリミング**: `pdf-trim-browser.ts` が描いた文字の数を数え、資料に文字があるのに 0 なら投げる → サーバーで描く予備（Noto・cMap 直した）に回る。実機の iPhone では未確認
- **費用**（調査・ローカルから実測）: 画像で分析 1件 $0.0010〜0.0048（中央値 約0.25円）・10件で約2〜4円。キャッシュは固定の指示（約640）が毎回命中・同じ物件の読み直しは91%。並べ替えは効果が小さいので入れていない（固定を先頭に置く見張りのテストだけ）。本番の llm_usage_logs は e5b41fbd（lazyAltRecorder）より前は0件 → 次に押した後に `action=pickup_image_analysis` の行を確かめる

## 2026-09-24 深夜 画像で分析の作り直し — 型の前置きでキャッシュ・間取り図だけ切り出す・物件と一致の確かめ・物件ごとの保存（竹内「2つの型を使ってプロンプトキャッシュ」「必要な所だけ切り出す。表の文字は文字層」「物件のずれ・間取り図と一致しているか。食い違いは要確認」「物件ごとに保存し2回目以降は画像を読み直さない」）
- **拡張の送り元＝資料の型**: `property_pickups.site` に拡張の送り元が入る（`realpro`＝リアプロ／`itandi`／`reins`）。型は `app/lib/sheet-layout.ts` の `detectSheetType`: site → 無ければ PDF の URL が realnetpro → 文字層の目印（Powered by RealNetPro・物件種目・号室名・間取タイプ・開口部方位）→ 型不明。reins は型なし（1ページ全体）
- **切り出し**（`planSheetCrop`・サーバーの `app/lib/pdf-sheet-crop.ts` が pdfjs の描画命令から画像の位置を取る）:
  - リアプロ: 間取り図 x.343 y.296 w.255 h.362（余白 0.003）。**間取り図と地図の位置の両方に画像がある時だけ**切る（資料画像の15%は別の形）→ 無ければ1ページ全体
  - itandi: 画像の範囲 x.010〜.505・y.085〜.82（表を除く）を1枚。最初の枠の固定は27%で外れるので使わない。⚠ **itandi の PDF の実物は未確認**（property_pickups に site=itandi の行が0件）。YUMA で itandi の物件を1回通して、描画命令の座標と文字層を確かめてから固定する
  - 室内写真の位置も取るが読ませない（写真の帯を足すと質が下がった）
- **表の文字は文字層**（`app/lib/sheet-facts.ts` の `parseSheetText`）: 物件名・号室・階・所在地・間取タイプ（括弧の帖数）・専有面積・賃料・方位・備考〜設備〜条件の文。見出しの行（「設 備」）だけを区切りにする（上の注意書きの「設備」に当てない）
- **固定の前置き**（`app/lib/sheet-prompt.ts`）: 共通の頭（役割・返す形・間違えやすい所・see 欄）→ 型ごとの説明（realpro_floor／itandi_area／page）→ 画像。推論なし（thinking disabled）・max_tokens 600。崩れた／fp_ok=false の時だけ推論 low・12000 で1回読み直す。前置きのハッシュをテストで固定（変えたら `SHEET_PROMPT_VERSION` も上げる）。希望は前置きに入れない
- **一致の確かめ**（`checkSheetConsistency`）: 説明文と文字層の物件名・賃料・面積・間取り・号室／1・2ページ目の物件名と号室／fp_ok・other_unit／読んだ間取りの型／文字層の帖数と 0.3帖超の差／帖数の合計×1.62 が専有面積超・25%未満／図の中の㎡ → 1つでも違えば **要確認（点を出さない・画像の事実は照合に使わない）**。画面に「⚠ 要確認」と理由、👑 の吹き出しに要確認の件数
- **物件ごとの保存**: 新しい表 `property_sheet_facts`（migrate-schema と `scripts/apply-property-sheet-facts-table.ts`・本番に作成済み）。引く順: この行の前回（image_analysis.sheet.facts_id）→ 物件の鍵 unit_key（物件名＋号室＋所在地）→ 切り出した画素の sha256（fp_hash・同じ図）→ 読む。PDF の中身は出力日で変わるので鍵にしない。近い画像を同じと見なすハッシュは使わない（別の部屋の事実の使い回しを0に）
- **希望との照合は文字だけ**（`matchWantsWithFacts`・決まった手順）。設備に当たらない希望（「洋室が小さいのは嫌」等）だけ文字で1回聞く（`judgeWantsByText`・推論なし・要確認の時は聞かない）。1件分は `app/lib/pickup-analyze-server.ts` の `analyzePickupRow`（route と YUMA のスクリプトが同じ関数）
- **実測（YUMA #9〜11・DeepSeek）**: 1回目 画像の読み 入力 1,469（2件目から命中 1,024）・出力 172〜187・1.3〜2.0秒、文字の照合 入力 560〜890・出力 18〜24。1件 約0.03〜0.04円（以前 0.2〜1円）。2回目（別の希望）は source=saved_unit で画像を読まない。別の鍵・同じ図は saved_fp。説明文を別物件にすると要確認・点なし。llm_usage_logs に conversation_id・sys_head「【🔍 画像で分析・realpro_floor】sheet-v1」。テストで作った property_sheet_facts の4行は消した（image_analysis は書いていない）
- **前回の反証の直し**: 同点は「合う」の数（ok_count）が多い方を上に（pickBest・pickCustomerBest・画面）／「物件」「マンション」等の一般名は同じ建物の判定から外す（`isGenericBuildingName`）／条件欄の「1階NG」が先頭の数字ごと消えて希望から落ちていた（image-wants の clean）／メモの「ペット可NG」を ng の印が無くても嫌の向きで読む
- PDF がある物件は画面のトリミング不要（`needsTrimBeforeAnalysis`）。`/api/property-pickups/analyze` を next.config の outputFileTracingIncludes に追加（pdfjs・canvas・フォント）
- テスト: `pickup-sheet.test.ts`（74）・`pdf-sheet-crop.test.ts`（16・fixture の描画命令と切り出しのハッシュ）・`pickup-image-analysis.test.ts`（23）・`pickup-best`（13）・`pickup-dedupe`（33）・`image-wants`（20）

## 2026-09-24 利益（AD − 見積書の割引）を物件ごとに残し、物件検索ブレインと連動（竹内）

竹内「物件ピックアップ・物件オススメで送った物件は分かっている。見積書送るの本文から割引も分かる。その物件が送った物件なら AD も理解しているはず。連動する」

### 仕組み
```
AIX【見積書送る】（log-aix-usage）
  → 本文「【物件名 号室】…🌟N円割引…初期費用：N円」を物件ごとに分ける（app/lib/estimate-profit.ts parseEstimateItems）
  → 候補プール（property_candidate_pools・検索時の表）→ 送付記録（sent_properties）の順に名前0.7＋シリーズ番号＋号室で結び付け
  → AD円 = ad_months × 家賃、利益 = AD円 − 割引 → estimate_records に upsert（waitUntil・失敗しても本処理は変えない）
merge-pdfs（物件ピックアップの送信）→ 説明文の「AD 2ヶ月」を sent_properties.ad_months / ad_yen に残す（parsePropertyFacts と同じ読み方）
/api/property-brain/judge → 割引の既定値は estimate_records の中央値を最優先（無ければ本文・無ければ 42,000円）
```
| ファイル | 役 |
|---|---|
| `app/lib/estimate-profit.ts`（＋テスト17） | 純関数: 本文の分解・AD の結び付け・利益・中央値 |
| `app/lib/estimate-profit-server.ts` | 記録を引いて書く（loadAdSources・recordEstimateFromAix・loadCustomerProfit） |
| `estimate_records`（migrate-schema・`scripts/apply-estimate-records-table.ts` で適用済み） | 物件ごとの割引・AD・利益 |
| `scripts/backfill-estimate-records.ts` / `backfill-sent-properties-ad.ts` | 埋め戻し（365日） |

### 実測（2026-09-24・365日）
- 見積書の AIX 291通 → 物件の行 256（本文から読めない 72）。**AD と結び付いた 14（5.5%）・AD円まで出た 1**
- 送付記録 2,073件（line_group・AD 未設定）→ 同じ顧客の候補プールに同名 **99.9%**・そのうち **ad_months あり 30%**（627件に埋め戻し）
- 割引の中央値 44,000円。見積書の物件が sent_properties に同名で存在 64/120、AD あり 2
- ⚠ property_candidate_pools の時刻の列は **sent_at**（created_at は無い）。最初の実装は created_at で絞って0件だった

### 拡張側の反映（2026-09-24・v2.5.10）竹内「拡張ツールの方もこれで反映」
- `bulk-dl.js` に **列の見出し（th）から読む** `findHeaderIndex` / `cellByHeader` / `parseMonthsText` / `parseYenText` を追加。
  AD の th がある行を見出し行とみなし（score-overlay と同じ）、AD・賃料・管理費・敷金・礼金・間取り・徒歩・築年の列番号を取る
- `buildPropertyData`: 見出しから取れた項目は見出し優先（ad_months／ad_yen・rent・admin_fee_yen・deposit_months／key_money_months（円なら _yen も）・floor_plan・walk_minutes・building_age）。
  **無ければ今までの読み方**（間取りの後ろの Nヶ月 セル等）。`data.read_mode`（header／heuristic）を候補プールに残す＝率を数えられる
- `buildPropertySummary`: 説明文の「AD Nヶ月」「敷X 礼Y」も見出し優先（merge-pdfs が説明文から sent_properties.ad_months を書くので、ここが AD の出所）
- ⚠ **見出しの文言・列の並びは実機未確認**。見つからなければ従来どおり動く（推測で別の列を触らない）
- 実機での確かめ方: 拡張を再読み込み（v2.5.10）→ リアプロで検索 → 一括DL のバーが出た後、コンソールに
  `[AXLX bulk-dl] 列見出し: {"ad":11,...} 見出し=[...]` が1回出る。「見つからない → 今までの読み方」なら th の文言をこの行から読んで `findHeaderIndex` の正規表現に足す。
  送った後 `property_candidate_pools.candidates[].read_mode` が header になっていれば効いている

### 率を上げる所（連動の上流）
1. **拡張の AD の列読み**: ↑で見出し読みを入れた（v2.5.10）。実機で「列見出し」のログを確かめるまでは 37% のまま
2. **家賃**: 候補プール 0%・送付記録 17.8%（9/21〜 merge-pdfs が説明文から読むので上がる）。AD円＝ad_months×家賃なので家賃が無いと利益が出ない
3. 利益の線（AD<割引 で hold）は estimate_records が溜まってから引く（今は既定の割引で PROFIT_NEGATIVE を出すだけ）

## 2026-09-23 物件検索ブレイン＋拡張の「ブレインモード」（竹内・Fable）— v2.5.9

- 竹内「**Deepsheekで物件検索のブレインをつくる**。敷金礼金0円や初期費用抑えたいひとは敷金礼金0でADも高くて割引が出来るお部屋で。…AD−見積書の割引金額が利益となるから利益面も理解できるようにする。**物件検索の拡張ツールでもブレインモードつくる。スタッフモードのところダウンドロップで切り替えれるようにする**」

### 仕組み（判定はサーバー・拡張は「呼んで、外して、番号を詰める」だけ）

```
拡張（ブレインモード）bulk-dl.js buildSendItemsBrain
  → background「axlx-brain-judge」→ POST /api/property-brain/judge {property_customer_id, items:[{summary,data,url,image_url}]}
  → サーバー: 条件（property_customers）＋過去に送った物件（sent_properties 180日）＋選定パターン（selected の selling_points）
              ＋見積書の割引額（aix_usage_logs estimate_sheet 本文「N円割引」・無ければ 42,000）
  → 純関数 app/lib/property-brain.ts で1件ずつ pass / hold / drop（点数・理由コード・利益 = AD円 − 割引）
  → 画像でしか分からない希望（バストイレ別・独立洗面・収納・南向き・2階以上）がある時だけ DeepSeek で有無を読む（5枚まで・失敗は無視）
  → 返事 {apply_drop, judgments, note_line}。拡張は apply_drop=true の時だけ drop を外し、【N】を1から詰め直し、
     最後の説明文の末尾に「🧠 ブレイン判定 N件（通す a・保留 b・外す候補 c）／外す候補: 〇〇（理由）／保留: …」を1ブロック
  → 記録 property_brain_judgments（facts・説明文・判定・利益。誤削除を後で数える材料）
```

| ファイル | 何を足したか |
|---|---|
| `app/lib/property-brain.ts`（新・純関数） | 説明文→事実（家賃 万/円/¥・管理費・敷礼（小数可）・AD ヶ月/円・徒歩・間取り・築年）／間取りの希望文の正規化（以上・〜・列挙・平米・ワンルーム）／「初期費用を抑えたい」の検出（否定文は除く）／割引額の読み取り／プロフィール／判定／末尾の1ブロック |
| `app/lib/property-brain-image.ts`（新） | DeepSeek（vision-alt-provider・reasoning low）で間取り図から**有無だけ**。費用は llm_usage_logs（action=property_brain_image） |
| `app/api/property-brain/judge/route.ts`（新） | HTTP の包み。maxDuration 30。dry_run=true で記録も画像もしない |
| `app/lib/__tests__/property-brain.test.ts`（新・82件） | 実データの実物（希望文の上位40種・見積書本文・フォームの自由文）で回帰 |
| `scripts/audit-property-brain.ts`（新） | 直近の property_candidate_pools（送った物件）に判定を当て、実送信の drop 率（誤削除の上限）を出す |
| `app/api/migrate-schema/route.ts` | `property_brain_judgments`（本番にも作成済み） |
| 拡張 `popup.html` / `popup.js` | AIX／スタッフの2ボタン → `<select id="mode-select">`（通常／スタッフモード／AIX連動／ブレイン）。`_applyMode(mode)` の1か所だけが storage を書く |
| 拡張 `background.js` | `isBrainModeOn()`（aixMode && brainMode）／`axlx-brain-judge`（30秒）／バッジ「脳」（手動 > 脳 > AIX）／callMergeApi に `brain_mode`（記録用） |
| 拡張 `bulk-dl.js` | `_brainModeOn` キャッシュ／`buildSendItemsBrain`（mergePdfs・autoSendOnePage の両方が通る）／`extractCard` に間取り図の `imageUrl`／`buildPropertyData` に rent（万・円・¥）・敷礼・ad_yen・小数 AD |
| 拡張 `styles.css` / `manifest.json` | `.mode-select`・`.brain-banner`・mini-mode の非表示。**version 2.5.9** |

### storage の互換（壊しやすい所）

- キーは今まで通り `staffMode` / `staffModeAt` / `aixMode`。**`brainMode` を足しただけ**。
- **ブレイン ＝ `aixMode:true` ＋ `brainMode:true`**。自動便（11:00/17:00・AIX）の claim（`_isAixModeActive`・`pending?aix=1`）は無変更。
  ⚠ ブレインを選んで aixMode が false になる実装ミス＝自動便が止まる。`_applyMode` 以外で書かない。
- 表示値は storage から導く: staffMode→staff／aixMode&&brainMode→brain／aixMode→aix／それ以外 normal。TTL で background が `staffMode:false` を書けば select も通常に戻る。
- スタッフモード中は判定を呼ばない（bulk-dl）＋サーバーも `staff_mode=true` なら `apply_drop=false`（二重の歯止め）。

### 落とすかどうか（今は「影の運用」＝1件も外さない）

- サーバーの `PROPERTY_BRAIN_DROP` が未設定 → `apply_drop=false`。判定と末尾の1ブロックだけ付き、**全件送る**。
- `PROPERTY_BRAIN_DROP=on` で drop を実際に外す。**外す前に** `npx tsx --env-file=.env.local scripts/audit-property-brain.ts --days=30` と
  `property_brain_judgments` × `sent_properties` で「外す候補をスタッフが実際に送った数」（誤削除）が 0 であることを確かめる。
- drop にする形は**実送信でほぼ0の形だけ**: 送付済みの建物（ALREADY_SENT）・家賃比 1.30 超（上限が正しい時だけ RENT_OVER_130）。
  hold（送るが印）: 家賃比 1.10 超・敷礼あり（抑えたい人）・間取り不一致・徒歩 1.5 倍超・築年超過・AD より割引が大きい・画像で希望が無い。
- 線が引けなかった物（今の DB に材料が無い）: 敷礼・徒歩・管理費・利益の閾値。`property_candidate_pools` は rent 2件・敷礼 0件・徒歩 0件。
  影の運用で `property_brain_judgments.facts` に溜まってから決める。

### 実機での確かめ方（**拡張の再読み込みが必要・version 2.5.9**）

1. `chrome://extensions` → AIXLINX の 🔄。ヘッダー右のボタン2つが**ドロップダウン**になっていれば更新済み。
2. ドロップダウンで「ブレイン」→ バッジが「脳」・水色バナー。`chrome.storage.local.get(["staffMode","aixMode","brainMode"])` が `{staffMode:false, aixMode:true, brainMode:true}`。
   「AIX連動」に戻すと `brainMode:false, aixMode:true`、「スタッフモード」で `staffMode:true, aixMode:false`。
3. リアプロで検索 → 「売上番長に送る」。コンソールに `[AXLX bulk-dl][brain] 判定 N件: 通す a・保留 b・外す候補 c（影の運用・外さない）` と、保留・見送り候補の1行ずつ。
   LINE の最後の物件の説明文の下に「🧠 ブレイン判定 …」の1ブロック。件数は減っていない（影の運用）。
4. `[AXLX bulk-dl][brain] 判定できず → 全件送る（fail-open）` が出たら API 側のエラー（Vercel ログ tag `property-brain:judge-failed`）。送信自体は止まらない。
5. 間取り図の画像: コンソールの判定に `IMAGE_*` が出るか。出なければ `extractCard` の `findFloorPlanImage` が一覧の <img> を拾えていない（実機未確認）。
6. DB: `select verdict, count(*) from property_brain_judgments where created_at > now() - interval '1 day' group by 1`。

### 費用（2026-09-23 時点の見積もり）

- 判定（家賃比・敷礼・間取り・徒歩・築年・AD・利益）は純関数 ＝ **$0**。DB の読み取りだけ。
- 画像（間取り図）は DeepSeek（deepseek-flash・reasoning low）で **1枚 ≈ $0.002（オフピーク）〜0.004（ピーク）**。読むのは「希望に画像でしか分からない語がある × 行に間取り図の画像がある」物だけ・1検索5枚まで。
- 1検索は平均7.6件・p90 10件・最大38件。全件読んだ場合の上限は 1日 ≈1,033件 → **月 ≈$71〜130**。ゲートで半分以下。実額は `llm_usage_logs where action='property_brain_image'` で見る。
- 監査（2026-09-23・30日 pools 1,000件・4,343件）: drop 0・hold 24（0.6%・FLOOR_PLAN_MISMATCH のみ）。

### 戻し方

- 判定を止める: ドロップダウンを「AIX連動」に戻す（自動便はそのまま動く）。サーバーは触らなくてよい。
- 落とすのを止める: Vercel の `PROPERTY_BRAIN_DROP` を消す（影の運用に戻る）。
- 旧 UI に戻す必要は無い（storage のキーは互換）。

---

## 2026-09-19 毎日11:00・17:00の自動物件検索（竹内）— AIXモードのPCが実行

- 竹内「**拡張ツールAIXモードにしている場合、毎日11:00になったら3日以内物件確認している人や新規のお客さんの物件検索自動ですることできるか（AD高い順）。ルールは昨日のお客さんなら更新日昨日で3日前物件出しした人なら3日内等本来の通り。そして17:00に今日出た新規物件をおくる為本日の更新日付で検索したの送る形出来るか（最新物件・この場合AD順ではなくて更新順とする・そして項目は１ページだけで本来のように３ページ迄いかなくて大丈夫）こうしたら最新でオススメ出来る物件出た際に見落とさなくて良いから**」

### 仕組み（既にあった物に「時刻で積む」だけを足した）

```
Vercel cron（JST 11:00 / 17:00）
  → /api/cron/auto-property-search?mode=am|pm  … 対象を選んで automation_commands に1人1件 積む
  → 拡張の AIX モードの PC が /api/automation/pending?aix=1 で claim（既存）
  → リアプロ自動入力 → 検索 → bulk-dl が PDF と説明文を売上番長グループへ（既存）
```
- 検索も送信も**既存のまま**。足したのは「誰を・いつ・どの条件で」だけ。
- `payload.source="auto_schedule"` は **AIX モードの PC だけ**が受け取る（`pending` の判定を `aix` と同じ扱いに広げた）。
  誰も AIX モードでなければ3時間で `error` に閉じる（既存の仕組み）。

### 誰を選ぶか（`app/lib/auto-search-schedule.ts`・純関数・テスト33件）

| 条件 | 中身 |
|---|---|
| ① 直近3日に物件出しした人 | `RECENT_SENT_DAYS=3`。**送信（`last_property_sent_at`）と確認（`property_viewed_at`）の新しい方**で数える。**JSTの日付**で数える（時刻差だと3日前が1時間の違いで外れる） |
| ② 新規のお客さん | 登録から `NEW_CUSTOMER_DAYS=3` 日以内で**まだ一度も出していない**人 |
| 除外 | 申込以降・終了・保留（`applying / closed_* / cancelled / pending`）、エリア条件が無い人 |
| 上限 | `MAX_TARGETS_PER_RUN=40`（hot → 直近の物件出し → 新規 の順に切る） |

**①で「確認」も含める理由（2026-09-19 竹内「物件出ししたお客さんっていうのは送信じゃなくて確認したお客さんも含む」）**:
拡張の一覧のバッジ「**送:**」＝`last_property_sent_at`、「**確:**」＝`property_viewed_at`（`popup.js` の
`markPropertyViewed` ＝ 顧客画面の確認ボタン）。送っていなくても確認していれば動いている人なので対象にする。
更新日も**新しい方**から計算する（`lastPropertyTouchAt`）＝「前回そのお客様に物件を出してから」の新着だけが出る。

**②で登録日を見る理由（実データ 2026-09-19）**: まだ出していない人は109人いるが、
**1か月より前の登録が98人**（うち80人が property_search）＝古い放置客。毎日回す相手ではない。

**実データの対象（2026-09-19）**: **31人** ＝ 直近3日に物件出し26人（送信が最後18／**確認が最後8**）＋ 新規5人。
更新日の内訳は 1日以内21・3日以内5・絞らない5。

### どの条件で検索するか

| | 11:00（am） | 17:00（pm・最新物件） |
|---|---|---|
| 更新日 | **前回出した日から計算**（昨日→1日以内／3日前→3日以内。拡張 `calcUpdateDays` と同じ線） | **1日以内（本日の更新日付）** |
| 並び | AD高い順（＝**触らない**） | **更新順**（＝既定に戻す） |
| ページ | 3ページまで（今まで通り） | **1ページだけ** |
| 検索 | **広げて検索**（`is_wide=true`） | **ピンポイント検索**（`is_wide=false`） |
| コマンド | **1人1コマンド**（更新日が人ごとに違う） | **1コマンドに全員**（同じ条件なので一括検索でまとめて回る） |

（2026-09-19 竹内「拡張ツールのAIXの11:00の検索は広げて検索／17:00の検索はピンポイント検索で一括で行うようにする」）

### 拡張側の直し

- `_buildBatchConditions(c, isWide, autoSched)` に `rp_update_days` / `sort_order` / `max_pages` を足した。
  **自動便の時だけ**入る（手動の一括検索は今までどおり）。
  ※ 一括検索は元々 `rp_update_days` を渡しておらず、更新日で絞っていなかった（個別検索だけが渡していた）。
- `bulk-dl.js` の3ページ上限を `state.customerConditions.max_pages`（既定3）で可変に。
- `page-script.js` に並び順のセット。**⚠ リアプロの並べ替えの DOM は実機未確認**なので、
  `select[name=sort|order|sort_order|disp_sort]` が見つかった時だけ設定し、見つからなければ
  **今の並びのまま＋コンソールに画面の select 一覧を出す**（推測で別の select を触らない）。
  → 実機で1回コンソールを見て名前が分かれば `SORT_SELECTORS` に足す（それまで17時便は更新日1日以内で絞るだけ効く）。

### 点検

```
npx tsx app/lib/__tests__/auto-search-schedule.test.ts            # 43件
npx tsx --env-file=.env.local scripts/audit-auto-search-targets.ts # 本番で何人が対象になるか
curl "https://sumora-ai-ui.vercel.app/api/cron/auto-property-search?mode=am&dry_run=1"  # 積まずに中身だけ見る
curl "https://sumora-ai-ui.vercel.app/api/cron/auto-property-search?mode=am&limit=2"    # 2人だけ積む（初回の試運転）
```

### 使い始める手順（2026-09-19・拡張 v2.5.8）

1. **拡張を再読み込み**（`chrome://extensions` → AIXLINX の 🔄）。バージョンが **2.5.8** になっていれば更新済み。
2. その PC の拡張で **AIX モードを ON**（`auto_schedule` のコマンドは AIX モードの PC だけが受け取る）。
   リアプロにログイン済みのタブを開いておく。
3. **初回は `?mode=am&limit=2` で2人だけ積んで様子を見る**（いきなり31人を走らせない）。
   途中で止めたい時は拡張のストップ（`batchStopRequested`）。
4. 問題なければ翌日から自動（JST 11:00 / 17:00）。誰も AIX モードでなければ3時間で `error` に閉じる。

### 並び順（2026-09-19 竹内の補足で単純になった）

竹内「**AD順じゃなくて、指定しなければ更新順になるから17時の時だけ並び替え順をAD順にしなければ大丈夫**」
＝ **リアプロの既定が更新順**。だから拡張がやるのは1つだけ:

| 便 | 並び替え | 拡張の動き |
|---|---|---|
| 11:00（am・AD高い順） | 今の並びのまま | **何もしない**（`sort="ad"` は「触らない」印） |
| 17:00（pm・最新物件） | 既定＝更新順 | 並び替えの select を**既定へ戻す** |

**「指定しない」ではなく「戻す」**なのは、リアプロが**前の検索の値を残す**画面だから。
同じ罠を更新日フィルターで踏んでいる（`page-script.js` の `update_date` も「前の顧客の選択値が残らないよう "" にリセット」）。
並び替えの select が見つからない時は触らず（＝既定のまま）、コンソールに画面の select 一覧を出す。
11時便が AD 順を**指定していない**今の作りでは AD 順が残らないので、見つからなくても実害は出にくい。

---

## 2026-09-18 【重大】送った一覧と PDF の中身が食い違うバグ（竹内）— 3サイト共通の原因

- 竹内「**SATOKOさんのURL開いたらMATSUOさんの物件が出てきた**。ズレて、前のお客さんのデータのままLINEに共有された可能性がたかい」（v2.5.7）
- **実データで確かめたこと**（`property_candidate_pools`・JST）
  - 16:38:12〜16:38:49 MATSUO YUYA（5バッチ）→ 16:39:35〜16:40:16 SATOKO♪（5バッチ）＝**隣り合う顧客**
  - SATOKO のバッチ1の先頭2件は「ロハス江坂／ロハス江坂」で MATSUO のバッチ1の先頭2件と同じ。ただし江坂は御堂筋線で SATOKO の条件にも合うため、**これだけでは混線と断定できない**
  - 一方、送った PDF は「ロハス江坂×3枚」なのに一覧は「ロハス江坂2件」＝**PDF と説明文の件数が食い違っていた**
- **コード上の確定的な欠陥（3サイトとも同じ形）**
  「**送る PDF の配列**」と「**説明文の配列**」を**別々に作って、位置（index）で対応**させていた。片方だけ1件落ちると、そこから後ろが全部1つずつズレる。

  | サイト | ズレ方 |
  |---|---|
  | リアプロ `bulk-dl.js` | `getSelectedUrls()` は「checked かつ http(s) の href あり」で絞るのに、説明文は **`checked` だけ**で作っていた。**印刷用PDFのリンクが取れない行が1つあると、その行以降が全部ズレる**。さらに `slice(i, i+10)` のバッチ分割でズレたまま切られる（`mergePdfs` と `autoSendOnePage` の2か所） |
  | itandi `itandi-bulk-dl.js` | PDF 取得に失敗した行は `pdfBase64List` に push されないのに、名前・AD は `propertyInfos[j]`（＝**成功分の位置**）で引いていた。**1件失敗すると以降の PDF に前の物件の名前・AD が付く** |
  | レインズ `reins-bulk-dl.js`（逐次モード） | 説明文は `targets` 全件・PDF は成功分だけ＝**件数すら食い違う** |

- **直し（1件 = 1つの組にしてから分ける）**
  - `chrome-extension/send-pairing.js`（**新規・純関数・テスト15件**）
    - `selectSendableTargets()` … 「**送れる行**」の判定を1か所に（一覧を作る側と送る側が別の条件で絞らない＝四者同名）
    - `prepareItems()` … 中身（url / pdf）が欠けた組を落とし、**【1】【2】… を1から詰め直す**（ズレたまま送るより、その1件が出ない方が被害が小さい）
    - `splitBatches()` / `pluck()` … **組のまま**分け、同じ組から urls / summaries / pool を取り出す
  - `bulk-dl.js` … `buildSendItems()` で `{url, summary, data}` の組を作り、`mergePdfs` と `autoSendOnePage` の**両方**がこれを使う
  - `itandi-bulk-dl.js` … 取れた PDF に「その行の情報」を**組で push**（`captured=[{pdf,name,info}]`）。**並行配列 `pdfBase64List` / `capturedNames` は削除**（残すとまた同じ事故が起きる）
  - `reins-bulk-dl.js` … `buildReinsSummary` / `buildReinsData`（rank を引数に）を切り出し、一括モードと逐次モードが同じ関数を使う。逐次は `captured=[{pdf,target}]` の組から説明文を作り直す
  - manifest … 3サイトの `content_scripts` の js 配列の**先頭**に `send-pairing.js` を追加（同じ拡張の content script は同じ isolated world を共有するので、先に読ませれば `AxlxSendPairing` が見える）
- **同時に塞いだ穴（顧客の紐づけ）**: `axlx_pending_auto_send` が**ただの `true`** で「**誰の検索の再開か**」を持っていなかった。リアプロは検索でページがリロードされ bulk-dl.js のモジュール変数が消えるため、再開時は `chrome.storage.local.current_customer_*`（＝**その時点で選ばれている顧客**）を読み直していた。background が次の顧客へ進んだ後にこのページが送ると、**前の顧客の検索結果に次の顧客の名前が付く**。
  - popup.js … フラグに `{customerId, customerName, conditions, ts}` を載せる
  - bulk-dl.js … Case C はそのフラグの顧客を使う（`autoSendAllPages(_manual, _flagSnap)`）。**10分より古い再開フラグは送信しない**（前バッチの取り残しで今の画面を別の顧客として送らないため）
- **テスト**: `app/lib/__tests__/send-pairing.test.ts` 15件（3サイトそれぞれの穴に回帰テスト）。`node --check` で変更5ファイル OK ／ manifest の JSON OK ／ tsc 0 ／ lib テスト96ファイル全 PASS
- **実機での確かめ方**（**拡張の再読み込みが必要・version 2.5.7**）
  - 一括検索を2人以上で回し、LINE の**一覧の件数と PDF の枚数が一致**しているか、【1】の説明文と PDF の1枚目が同じ物件か
  - コンソール: `印刷用PDFのリンクが取れない行を N件 送信から外しました`／`図面が取れなかった N件は送信から外しました`／`再開フラグの顧客を使用: 〇〇 (id=…)`／`再開フラグが古い（…）→ 送信しない`
- **未確認**: Chrome 拡張は実機でしか動かせないため、**本番検証は未実施**（竹内さんの実機確認待ち）

---

## 2026-09-18 【重大】一括検索で違うお客さんの条件が送られるバグ（竹内）— 原因と直し

- 竹内「一括検索する際に**情報ずれて、違うお客さんの条件で送られてしまっている**バグも発生している」
- **原因は3つ重なっていた**
  1. `page-script.js` / `itandi-page-script.js` は fill-done（自動入力完了の合図）に**顧客 ID を載せていなかった**。中継する `content.js` が「**その時点の** `_pendingFillCustomerId`」を付けていた
  2. background の照合が「**片方でも ID が無ければ site だけで解決**」＝ ID があっても素通りできた
  3. **ID 無しのシグナルが「最古の待ち」を解決**していた（別顧客の待ちでも解決できた）
- **起きる順番**（これで「違うお客さんの条件」になる）

  ```
  顧客A の待ちがタイムアウト → 次へ進む
  顧客B の待ちを作る
  顧客A の fill-done が遅れて到着 → content.js が「今の ID＝B」を付ける
  → 顧客B の待ちが解決 → まだ検索が終わっていない画面を「B の結果」としてスクレイプ・送信
  ```

- **直し（誰の入力かを送る側が持つ）**。設計知見「rowKey は URL の ID を使う（位置ではなく）」＝**その時の状態ではなく対象そのものに紐づける**
  - `content.js` / `itandi-content.js` … 自動入力の**依頼と一緒に** `customerId` を page-script へ渡す。fill-done を中継する時は**シグナルに載っている ID を最優先**（今の値では上書きしない）
  - `page-script.js` / `itandi-page-script.js` … 受け取った ID を覚え、`notifyDone` / `_safeDone` / watchdog が**そのまま載せて返す**
  - `chrome-extension/fill-done-match.js`（新規・純関数・テスト11件） … 「このシグナルは今待っている顧客のものか」を1か所で判定。**待ちが ID を持つなら必ず一致**／ID 無しのシグナルは**ID を持たない待ち（旧経路・reins）だけ**を1件／**タイムアウトで捨てた顧客の遅延シグナルは何も解決しない**
  - `background.js` … `_notifyFillDone` をこの純関数に一本化。タイムアウト時に `_markFillDoneAbandoned` で顧客 ID を覚える（10分）。同じ顧客を新しく待ち始める時は記録を消す（再検索が詰まらないように）。解決しなかった時は理由と待ち行列をログに出す
- **テスト**: `app/lib/__tests__/fill-done-match.test.ts` 11件（3つの原因それぞれに回帰テスト）
- **確認**: `node --check` で変更した6ファイルとも構文 OK ／ tsc 0 ／ lib テスト95ファイル全 PASS
- **実機での確かめ方**: 一括検索を2人以上で回し、拡張のコンソールで `[fill-done] 解決しない（abandoned / no-match）` が出ないか、`[fill-done-waiter] タイムアウト customerId=…` の後に別顧客の送信が起きていないかを見る

## 2026-09-18 一括検索を「広げて検索」でもできるようにし、検索日を記録する（竹内）

- 竹内「物件検索と一括検索を**条件広げて検索でもできる**ようにする。また**一括検索したお客さんも項目のところに日付と一括検索した日にちをいれる**ようにする」
- **調べて分かったこと（2つの依頼は同じ根だった）**
  - 記録の仕組みは**既にあった**。`property_customers.search_history` に `realpro_p` / `realpro_w` / `itandi_p` / `itandi_w` / `reins_p` / `reins_w`（サイト×モードの検索日時）。顧客リストの **RP / IT / RE の ✓ と P・広 のグリッド**（`buildSshGrid`）がこれを描いている
  - **書いていたのは popup.js の個別検索だけ**。`background.js` の一括検索は `search_history` を**1行も書いていなかった** → 一括検索しても行の日付が埋まらない
  - 一括検索は `_batchAutofill(customer, site, isWide)` の **isWide を常に false** で呼んでいた（関数は元から受け取る作りだった）→ 広げて検索で一括できない
- **直し**
  - `chrome-extension/search-history.js`（新規）… キーの作り方（サイト名のゆれ吸収・p/w）と保存を1か所に。**popup.js（個別）と background.js（一括）が同じ関数を使う**（四者同名）。popup.html の `<script>`・manifest の web_accessible_resources・background の `import` の3つに登録
  - popup.html / styles.css … 一括検索ツールバーに**モードの2択**（🎯 ピンポイント／🔎 広げて）。個別検索の `mode-toggle` と同じ考え方
  - popup.js … `bulkSearchMode` を持ち、`executeBulkSearch` が `isWide` を送る。個別検索の記録2か所（itandi・リアプロ）も `recordSearchForSelected(site)` に寄せた（旧: 同じコードが別々に書かれ、キーも手で組み立てていた）
  - background.js … `axlx-manual-bulk-search` が `msg.isWide` を受け、`_batchAutofill` に渡す。検索後に `_recordBulkSearch` で検索日を記録（記録の失敗で検索は止めない）
- **テスト**: `app/lib/__tests__/search-history.test.ts` 16件（拡張にテストの置き場が無いので既存のハーネスに乗せた）。`node --check` で popup.js / background.js / search-history.js とも構文 OK
- **見つけた別の穴（未対応）**: **レインズは個別検索でも `search_history` を書いていない**（`reins_p` / `reins_w` が常に空＝グリッドの RE 列がいつも未検索のまま）。一括検索の分は今回から記録される。個別のレインズも同じ関数を1行呼ぶだけで直る
- 設計知見: 「**記録の仕組みがあるのに書いていない経路がある**＝『その形が DB に何件あるか』ではなく『どの経路が書いているか』で探す」「関数が引数（isWide）を受ける作りなのに、呼び出し側が固定値を渡している所は、機能が半分眠っている印」

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
| 2026-09-14 | **一時調整に「賃料下限」欄を追加（v2.5.6・竹内指示）**: popup.html 賃料上限の上に `adj-rent-min`（円）。preloadAdjForm が DB の `rent_min` を入れる → **欄の値が正（空欄＝下限なし）**、上限以上の下限は0件になるだけなので送らない（`readAdjRentMin(c, rentMax)`・popup.js）。「反映」ボタンで `rent_min` を DB 保存（PATCH の許可リストに既存）。顧客別の一時調整履歴（localStorage `tempAdj_{id}`）に `rent_min` を追加・チップは「6万〜11万」表記・下限導入前の履歴は下限欄を触らない。**サイト別**: リアプロ＝page-script.js の既存 `rental_cost1`（nearestDown）へ一時調整値を渡すよう変更（従来は DB 値固定）／itandi＝`input[name="rent:gteq"]`（面積 `floor_area_amount:gteq` と同じ命名・万円・欄が無ければ警告だけ）／レインズ＝idx 75（TO=76 の隣。面積 87/88 と同じ並び）。**idx 75 は実機未確認**のため「76 と同じ賃料の行（共通の親に『賃料』の文字・入力欄4つ以下）」と確かめてから入れ、違えば入れない（`Math.floor` で万円）。自動（sumora_cid）経路は content.js / itandi-content.js が既に DB の rent_min を送っていたので、itandi・レインズでも下限が入るようになる |
| 2026-09-14 | **itandi 駅選択の「途中で止まって、また動き出す」を解消＋締切 150秒→240秒（v2.5.5・竹内指示・SATOKO♪ 事例）**: 根本原因は itandi-page-script.js `startClickLines` の駅ループ。路線ごとに**全駅名**を1つずつ試し、選択済みの駅・その路線に無い駅でも毎回 300〜800ms 待っていた＝「路線数×駅数×0.55秒」の空回り（何もクリックしない数十秒）で止まって見え、駅の多い広げて検索では150秒の見張りに掛かっていた（例: 5路線×40駅≒110秒の待ち）。→ **実際に駅をクリックした時だけ** 300〜800ms 待ち、押していない時は待たずに次へ（クリック間隔は従来どおり）。安全幅として watchdog 150→**240秒**・background `FILL_DONE_TIMEOUT_MS.itandi` 155→**245秒**（watchdog < background のルールは維持）。一括の無進捗5分・ロック15分の範囲内 |
| 2026-09-12 | **itandi 自動入力の締切 85秒→150秒（v2.5.4・竹内指示）**: itandi-page-script.js `fill()` のウォッチドッグ（固まった時に fill-done を強制送信して一括検索を止めない安全装置）を 150秒に。background.js に `FILL_DONE_TIMEOUT_MS = { itandi: 155000, realnetpro: 90000 }` と `_fillDoneTimeoutMs(site)` を新設し、fill-done 待ち（個別検索 L887・手動一括 L1028・自動バッチ `_runBatchSearch`）の上限を itandi 155秒（ウォッチドッグ＋5秒）に。リアプロは 90秒のまま。`_scrapeAndSendRealpro` のタイムアウト文言も秒数を連動。**ルール: page-script のウォッチドッグは必ず background の待ち上限より短くする**（逆だと合図より先に background が時間切れでスキップする） |
| 2026-09-12 | **「電車1本」itandi 対応（v2.5.3・竹内指示）**: popup.js itandi autofill でも `resolveDirectCommute(rawArea)` を使い、沿線（`_direct.lines` → `ITANDI_LINE_MAP_FILL` で itandi 路線名。東海道本線は京都線・神戸線の2本 → 計13路線）を itandi_lines に追加・station_names にハブ駅・駅モード化・`select_all_line_stations:true`（手動の駅入力／手動の地域モード／`area_mode_locked=ward` は対象外。リアプロ側にも locked=ward ガード追加）。**itandi-page-script.js `selectItandiLines(…, selectAllStations)`**: itandi は路線ごとに駅リストが切り替わるため、路線クリック → 900〜1500ms 待機 → `selectAllStationsOfLine` でその路線の駅を全チェック（40〜100ms 間隔）→ 次の路線。駅ラベルの判定は「路線一覧が出た時点の checkbox ラベル文言（`_lineLabelTexts`）」と「線/電鉄/鉄道/モノレールを含む文言」を除いたもの（React 再描画でノードが替わっても文言で判定）。「すべて選択」系ラベルがあれば先に押し、残った未選択だけを個別に押す（トグル解除防止）。路線が見つからなかった時は駅を押さない（前の路線の駅リストのまま）。**制約**: 大阪府タブ内だけ（兵庫・京都側の駅＝阪急神戸線の塚口以西・JR神戸線・JR京都線の京都府内等は選ばれない）。**実機未確認**（13路線 × 駅全選択が watchdog 85秒以内に収まるか・駅リストの DOM が想定どおりか） |
| 2026-09-12 | **「梅田まで電車1本」＝乗り換えなしで着く沿線の駅をすべて選択（v2.5.2・竹内指示）**: 旧は「梅田まで電車1本」が1トークンのまま resolveStation のあいまい一致で「梅田」1駅だけが駅指定され、API が沿線（阪急3線・阪神・御堂筋・谷町・四つ橋・環状線等）を選んでも設定中の駅＝梅田のみ→沿線の他の駅が検索から漏れていた。**popup.js `resolveDirectCommute(rawArea)`**: 区切り（、・/ 空白）ごとに `DIRECT_COMMUTE_RE`（「〇〇まで電車1本／一本／乗り換えなし／直通」）を判定 → 目的駅は STATION_HUB_MAP（梅田＝梅田・東梅田・西梅田・大阪梅田・大阪）か既知駅の**完全一致のみ**（「梅田までバス1本」は対象外）→ ハブ各駅の STATION_LINE_MAP 路線＋直通運転（`DIRECT_THROUGH_LINES`: 御堂筋⇄北急、JR東西線→福知山線・片町線／`DIRECT_THROUGH_BY_STATION`: 大阪→福知山線）を route_ids に。リアプロ autofill で route_ids に追加・station_names にハブ駅・駅モード化・`select_all_line_stations:true` を送る（手動の駅入力／手動の地域モードは優先）。**page-script.js STEP D `selectAllLineStations()`**: 駅ページに出ている `station_id[]`（選んだ沿線の全駅・拡張の LINE_STATION_ORDER より網羅的）を全部チェック（20〜45ms 間隔）。前回試行から選択数が増えない（サイト側上限等）時は選べた駅で検索＋トースト（全件検索にはしない）。**データ修正**: STATION_LINE_MAP「大阪」を環状線のみ→環状線・東海道本線・おおさか東線（popup-maps.js / resolution-core.js 両方）。**既存バグ修正**: `updateAreaModeUI` が未定義のまま3箇所で呼ばれ、通勤時間展開等で地域→駅に自動昇格する時に ReferenceError で自動入力が止まっていた → popup.js に関数を定義。parseAreaCondition に「電車1本」→ transfers:0（直通バナー）。**対象外（要判断）**: 大和路快速・関空/紀州路快速（環状線経由で大阪直通だが全列車ではない）・北新地（JR東西線）。itandi 側は未対応（リアプロのみ）。**実機未確認**（リアプロの駅選択上限の有無・12沿線の全駅チェック時間） |
| 2026-09-12 | **AIXモード（v2.5.1）**: ヘッダーのスタッフモードの左に `#aix-mode-btn`「AIX」トグル（ON時「AIX連動中」紫 `.aix-btn.on`＋紫バナー `#aix-mode-banner`）。状態は `chrome.storage.local.aixMode`（PCごと・TTLなし）。**スタッフモードと排他**（片方ONでもう片方OFF・popup.js `_initAixModeUI` / スタッフ側クリックでも `aixMode:false`）。background.js `_isAixModeActive()` → `_pollAndRunBatch` が pending API を `?aix=1` 付きで呼ぶ。バッジは スタッフ=「手動」緑 ＞ AIX=「AIX」紫。**サーバー側**: ブレインが AIX要対応（aix_action_items）を「物件ピックアップした／物件オススメ／物件を探す」で新規・変更登録した時、`app/lib/aix-action-items.ts enqueueAixPropertySearch` が紐付き物件顧客の `batch_property_search`（sites=["realnetpro"]・payload.source="aix"）を automation_commands に積む（同顧客の pending/running があれば積まない）。`/api/automation/pending` は `?aix=1` の PC にだけ source=aix を渡し、どの PC も AIX モードにしないまま3時間経過したものは error で閉じる。`/api/automation/trigger` の既存コマンド再利用判定から source=aix を除外。検索→売上番長グループ送信は既存の一括検索（_runBatchSearch → _scrapeAndSendRealpro → bulk-dl → merge-pdfs）そのまま。**実機未確認**（AIXモードON→ブレインが物件ピックアップ判定→自動検索→LINE送信の通し）。拡張の再読み込み必須（background.js / popup.* 変更） |
| 2026-09-05 | **一時調整→DB反映ボタン追加 (commit 3a82a0c9)**: 一時調整フォームに「💾 本条件に反映する」ボタンを新設。押下で PATCH /api/property-customers を呼び顧客のDB条件を上書き更新（賃料上限・面積min/max・エリア）。地域/駅フィールドの入力状況に応じて `area_mode` も自動設定（地域→ward・駅→station）。保存中/成功/失敗のフィードバックを `#adj-save-status` に表示。成功時はメモリ内顧客オブジェクトと sessionStorage キャッシュも同期更新（再読込不要で反映）。popup.html / popup.js / styles.css |
| 2026-09-05 | **一時調整: 地域/駅検索切り替え＋顧客別履歴保存 (commit a1b4b4c0)**: ①地域/駅欄への手動入力が顧客DB条件より優先して検索軸を確定（`computeTempAdjOverride()`・最後に編集した欄で判定・`_areaModeSource="user"`で自動補正③/③-pre/⑤を全スキップ。自動バッチの`area_mode_locked`時は無効）。上書きモード時は該当欄のテキストのみ検索エリアに使用。②一時調整5フィールド（地域/駅/賃料上限/面積min/max）をlocalStorage `tempAdj_{customerId}` に顧客別保存（直近3件・800msデバウンス・同一セッション連続編集は先頭更新）、顧客選択時に最新を自動復元（`restoreTempAdj`・自動バッチ中は`_adjRestoreSuppressed`で抑止）。③直近3件を履歴チップで表示・クリック再適用（`renderTempAdjChips`）。④🏙️地域(青)/🚉駅(緑)インジケーター（`#adj-mode-indicator`）で上書きモードを可視化。popup.js / popup.html / styles.css。※実装時の未定義`escapeHtml`→既存`esc()`に修正済み |
| 2026-09-05 | **サイト別検索履歴グリッド追加 (commit a6d31439)**: search_history JSONB カラム追加（migrate-schema）。リアプロ/itandi/レインズの自動入力ボタン押下時に realpro_p/w・itandi_p/w・reins_p/w をPATCH記録。顧客行の確認ボタン横に RP(青)/IT(橙)/RE(緑) × P/広 グリッドを表示（検索済=青・未=グレー）。ホバーで日付ツールチップ。c-datesの汎用P:/広:チップを削除しグリッドに統合。 |
| 2026-09-05 | **顧客行に検索・送付・確認日付チップ追加 (commit 037e9f27)**: `last_pinpoint_search_at` / `last_wide_search_at` カラムをmigrate-schemaに追加。リアプロ・itandi自動入力ボタンクリック時にfire-and-forget PATCHで日付記録。`renderCustomerRow` に `daysAgoText()` ヘルパーと `.c-dates` 日付チップ行を追加（送:N日前 確:N日前 P:N日前 広:N日前）。styles.cssに .dc-sent/.dc-viewed/.dc-pin/.dc-wide のカラーバッジCSSも追加。 |
| 2026-09-05 | **熱いお客さんリスト欠落バグ修正 (commit 643f1702)**: `needsActionToday()` が `is_flagged` のみ確認し `is_hot` を無視していた。アプリの「🔥あついお客さん」タブは `is_hot===true` で絞り込むが拡張では未参照だった → `is_flagged \|\| is_hot` の両方チェックに変更。あわせて sessionStorage キャッシュTTLを5分→90秒に短縮（フラグ変更後最大5分遅延バグ修正）。 |
| 2026-09-02 | **リアプロ 構造チェックボックス未選択バグ修正 (popup.js 2箇所)**: ①line 2480: `customer.building_structure \|\| customer.structure` → `customer.structure_types`（存在しないフィールド参照を修正）②lines 3567-3569: リアプロブランチの adjC.structure_types 計算が `adjStructure ? [...] : []`（fallbackなし）だったのを itandi ブランチと同じ `(adjStructure \|\| c.structure_types \|\| "").split(...)` に統一。これにより DB の `structure_types` カラム値が adj フォームで上書きなしのときも正しくページスクリプトへ送信される。DB カラム自体は migrate-schema/route.ts line 2816 で 2026-09-01 追加済み（00:10 JST の cron で適用済みのはず）。 |
| 2026-09-01 | **Chrome拡張 送信エラー根本修正 (commit 48ed88cf)**: ①background.js: callMergeApi の AbortSignal を 60s→85s に延長（Vercel maxDuration=90s に対してクライアントが先にタイムアウトしていた）② bulk-dl.js: 送信エラー時にアラートで resp.error の実メッセージを表示（セッション切れ・タイムアウト・APIエラーを区別できるよう改善） |
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
| 2026-08-25 | **itandiチェックボックス不可＋リアプロSUUMO誤表示修正（Fable5調査→実装）**。[バグA主因] `underbar.js` ミニボタンドラッグの `mousemove` に `e.buttons===0` 復帰ガード欠落（5ecee612でwrap側のみ修正した直し漏れ）→ ウィンドウ外/iframe上mouseupで `miniBtnDrag` 残留 → ミニボタン（z-index 2147483647）がカーソルに貼り付き全クリック横取り → itandiチェックボックスが押せず「0件を選択中」。wrap側と同じガードを移植。[バグA副因] `itandi-bulk-dl.js` mutObs の uninj 判定が CommonButton サブツリー内しか見ず break（cbは CommonButton の兄弟に注入される）→ 常に「未注入」誤判定で inject() が250〜600msごとに永久再実行＋`injectSuumoButtons()` の毎cycle全削除→再注入でDOM churn倍増。→ uninj判定を親要素の兄弟チェックに修正＋SUUMO全削除行を撤去（dedupeチェックで冪等）。[バグB] `bulk-dl.js` のリアプロSUUMOボタン（7802123d実装）がフリーワード検索結果にも注入されていた（L5のmain.phpガードのみで画面種別判定なし）→ `isFreewordSearchActive()` 追加（keyword系input値の有無で判定）し該当時は注入スキップ（案A: 機能は建物モードに残す）。underbar.js / itandi-bulk-dl.js / bulk-dl.js |
| 2026-09-02 | **大阪市内（地域バッジ）→駅モード昇格バグ修正** commit 6f8df70b。[ROOT-CAUSE-1] `classifyAreaTokens` の `/[市区郡]$/` が "大阪市内"（末尾「内」）にマッチせず unknown→stationTokens に分類→`currentAreaMode=station` に設定されていた。→ `/[市区郡府県]$|(?:市|府|県|都)内$/` に拡張し area に分類。[ROOT-CAUSE-2] APIがstation_names（例: "大阪"）とcity_codes（大阪市24区分）を両方返した場合、station_names補完ブロック（popup.js L3760）でcity_codes存在を無視して無条件に `currentAreaMode='station'` にフリップしていた。→ `&& (apiData?.realpro?.city_codes ?? []).length === 0` ガードを追加。city_codesがある地域指定はバッジの「地域」判定を尊重し昇格しない。`computeAreaModeBadgeHtml`・`classifyAreaTokens` を同一正規表現で完全同期。popup.js + popup-maps.js（MULTI_WARD_MAP "大阪市内"追加）。 |
| 2026-08-25 | **Fable5 HIGH深刻度8件バグ一括修正** commit 16325169（+80/-13行）。[B1] popup.js itandi autofill 臨機応変ブロックで `adjC` 未宣言→ReferenceError: `const adjC = buildAdjCustomer(c)` 追加。[B2] axlx_score_data全箇所に `ng_points` 追加＋score-overlay.js に NGキーワードペナルティ（-10点/ワード、最低0）実装。[B3] background.js area_mode='both'で0件LINE通知が2通重複→各パスのtotalCountを集計し全パス完了後に1回のみ通知。[B4] page-script.js tryLabel: チェック済みcheckboxをラベルクリックで解除するバグ→inpが存在する場合はlabels[i].click()スキップ。[B5] STEP D _allMatchedChecked: matched=false（未紐づきlabel）を安全側（false）に変更。[B6] resolve-search-conditions/route.ts に `export const maxDuration = 60` 追加（Vercel 30秒強制終了対策）。[B7] reins-page-script.js fill(): 90秒ウォッチドッグ＋try-catch＋完了通知イベント追加。[B8] itandi-page-script.js pollLineList: _dlg=nullのdocumentフォールバックを削除→_safeDone中断に置換。 |
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

- 現在のバージョン: **v2.5.17**（manifest.json 記載・2026-09-25 通勤の候補の駅 osaka-transit.js／commute-candidates.js）
- **2026-09-14 賃料下限 実機確認待ち（v2.5.6）**: 拡張を再読み込み → 一時調整の「賃料下限」に 60000 を入れて各サイトで検索。リアプロ＝賃料の下限プルダウンが 6万（無ければ直下の選択肢）／itandi＝賃料の下限欄に 6、コンソール `[AX] itandi 賃料下限: 6万`（`rent:gteq が見つかりません` が出たら欄の name を DevTools で確認）／レインズ＝賃料FROM に 6、コンソール `[AX] 賃料下限 FROM(idx75)`（`idx75 が賃料FROM欄と確認できない` が出たら idx を調べ直す）
- **2026-09-14 itandi 実機確認待ち（v2.5.5）**: 拡張を再読み込み → 駅の多い条件（SATOKO♪ 様の広げて検索など）で itandi 自動検索 → 駅チェックが途切れず続き、途中で数十秒止まらないか。コンソール `[AX] 駅クリック:` が連続して出ること・`watchdog: 240s` が出ないこと
- **2026-09-12 itandi「電車1本」実機確認待ち**: みく様で itandi 自動入力 → 路線13本が順に選ばれ、各路線の駅が全部チェックされて検索まで進むか。コンソール `[AX] 電車1本: <路線> の駅 X/Y 選択` と `沿線の駅を計N駅選択`。150秒 watchdog（v2.5.4 で85秒から延長）に掛かるならクリック間隔・路線後待機を詰める。兵庫・京都側の駅も必要なら都道府県タブ切替の DOM 確認から
- **2026-09-12 「梅田まで電車1本」実機確認待ち**: 拡張を再読み込み → みく様（駅＝梅田まで電車1本）でリアプロ自動検索 → 沿線12本が選ばれ、駅ページで全駅にチェックが入り「設定中の駅」が梅田だけでないこと・検索が走ることを確認。コンソール `[AX] 電車1本:` / `[AX] STEP D(電車1本): 沿線の全N駅を選択` を見る。選択が途中で止まる（トースト「沿線の駅をX/Y駅選択しました」）ならリアプロ側の駅数上限 → 対応を検討
- **2026-09-12 AIXモードの自動検索が起きる条件**: ①初回（スタッフ未返信）でお客様が条件フォーム・物件探しを送った（brain meta `first_contact_pickup`。挨拶下書きは従来どおり）②ブレインが AIX【物件ピックアップした／物件オススメ／物件を探す】と判断（reply_mode=aix）③物件ピックアップ待ちのままお客様が条件を変えた（brain meta `condition_change_type` あり → 同じ指示でも再検索）。いずれも会話が物件出し顧客（conversations.property_customer_id）に紐付いている時だけ。条件フォームは cached にせず必ず再分析（brain-core isIncrementalBypass）
- **2026-09-12 AIXモード 実機確認待ち**: 自動化用PCで拡張を再読み込み → リアプロにログインしたタブを開いたまま「AIX」ON → ブレインが物件ピックアップ/物件オススメの AIX要対応を出した顧客（物件出し顧客に紐付き）で、30秒以内に自動検索→売上番長グループへ物件が届くかを確認する
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
- **2026-09-01 Chrome拡張 送信エラー根本修正**:
  - **症状**: 物件送信時に「送信エラー（次顧客へ）」が表示され、原因が分からない状態
  - **根本原因①**: callMergeApi の AbortSignal が60s → Vercel maxDuration=90s なのに、クライアントが先にタイムアウトしてエラーになる。多PDFの場合に顕著
  - **根本原因②**: エラー時に resp.error の実メッセージをUIに表示しておらず、console.errorのみ → 原因が分からない
  - **修正①（background.js）**: AbortSignal.timeout(60000) → AbortSignal.timeout(85000)（Vercel 90s より5s短く）
  - **修正②（bulk-dl.js）**: 送信エラー時に alert() で resp.error の実メッセージを表示 + セッション切れ/タイムアウト別のガイダンスを添付
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

---

## 🛠️ 今セッションの修正（2026-09-02）

### A. リアプロPDF一括DL時にAdobeが自動起動する問題（完了）
- `btn.click()`がnavigation扱いでAdobeに横取りされる → `chrome.runtime.sendMessage({type:"axlx-download-realpro-pdf",url})`に変更
- `background.js`で`chrome.downloads.download()`を使うメッセージリスナーを追加

### B. 1SLDK間取りの代替マッピング（完了）
- リアプロ: 1SLDK → 1LDK(6) + 2DK(8) + 2LDK(9)
- itandi: 1SLDK → 1LDK + 2DK + 2LDK
- `page-script.js`に`SLDK_SUBSTITUTE`/`SLDK_UPPER_LDK`、`itandi-page-script.js`に`SLDK_SUBSTITUTE_IT`/`SLDK_UPPER_IT`を追加

### C. リアプロ全ページ送信前にAD高→低ソート自動適用（完了）
- `autoSendAllPages()`冒頭でURLパラメータ確認、未適用なら`key=ad&odr=desc`リンクへ遷移→sessionStorage経由でCase B再開
- セレクタは`a[href*="key=ad&"]`（`key=addr`との誤マッチ防止のため`&`必須）

### D. 大阪市内で検索時に沿線モーダルが開く問題（完了）
**根本原因**: `popup-maps.js`の`MULTI_WARD_MAP`に「大阪市内」が未登録のため、`classifyAreaTokens`が「大阪市内」を`unknown`→`station`と誤分類していた

**修正**:
1. `popup-maps.js`の`MULTI_WARD_MAP`に`"大阪市内": [大阪市全24区]`を追加
2. `popup.js`の`classifyAreaTokens`の`inWard`チェックに`|| MULTI_WARD_MAP[t]`を追加

これにより：
- 「大阪市内」が`area`として分類 → `currentAreaMode = "ward"`
- `preloadAdjForm`が`adj-area-ward = "大阪市内"`, `adj-area-station = ""`に設定
- page-scriptで`area_mode: "ward"`が渡され、地域モーダルで検索される

---

## 2026-09-20 送った物件が「誰に送ったか」記録されていなかった（background.js 2行修正・**拡張の再読み込み必須**）

### 何が起きていたか
`sent_properties`（送付物件の履歴）の実測（直近180日 15,599件・`scripts/audit-sent-prop-link.ts`）:

| source | 件数 | 会話ID | 物件顧客ID | 号室 |
|---|---|---|---|---|
| `line_group`（物件出しツール→LINEグループ） | 14,129（**91%**） | **0%** | **0%** | **0%** |
| `vision`（送信画像の読み取り） | 1,470 | 100% | 87% | 100% |

→ **会話に辿れる物件は 1,470/15,599 = 9.4% だけ**。
物件出しツールで送った物件は「誰に送ったか」も「どの部屋か」も残っておらず、
ブレインも返信AIも**送った物件を読めない**状態だった。

### 原因
`background.js` の `callMergeApi` が `property_customer_id` を渡していなかった（2か所）。
サーバー（`/api/merge-pdfs`）は受け取れば `sent_properties` に入れる作りになっていて、
拡張は `customer_id` を手元に持っていた（`log-property-candidates` には渡していた）のに、
**merge-pdfs にだけ渡していなかった**。

### 直したもの
1. `background.js` リアプロ経路（`axlx-send-to-line`）: `property_customer_id: customer_id || null`
2. `background.js` itandi 経路（Blob アップ後の merge）: `property_customer_id: msg.customer_id || null`
3. `/api/merge-pdfs`: 紐付けがどちらも無い時、重複チェックが**全顧客の履歴から**同名物件を探して
   「重複」と判定し記録をスキップしていた副作用を塞いだ（`limit(0)` ＋ 警告ログ `merge-pdfs:sent-properties:no-link`）

### 確認方法（次に物件を送った後）
```
npx tsx --env-file=.env.local scripts/audit-sent-prop-link.ts
```
`line_group` の「物件顧客ID」が 0% から上がっていれば効いている。
上がらない場合は**拡張の再読み込み**（background.js の変更は再読み込みしないと反映されない）。

### 号室が 0% なのは別の原因（未対応）
`merge-pdfs` は `property_summaries` の1行目から `/[\s　]+(\d{1,4})(?:号室?)?$/` で号室を切り出す。
`line_group` は号室 0% なので、**送っているサマリーの1行目に号室が無い**形になっている。
号室が無いと重複判定が名前だけになる（`sent-property-record.isSameProperty` は号室が無ければ名前 0.95 で判定）。
→ 次にやる: `property_summaries` の実物を見て、号室を含む形にするか、別の場所から号室を取る。

## 2026-09-21 一度送った物件を次から外す（サーバー側だけで完結・**拡張の変更なし**）

竹内さん「拡張ツールで物件出した事あるのは出さないようにできるか？／物件一括で検索して送るAIXボタン押した／
11:00と17:00の部分も／一度共有した物件を除いてLINEに送ることが出来ればかなり質高くなる。
何度も同じ物件がLINEグループに送られると、一度見た物件をまたみる必要があったりするので効率が悪い」

### 3つの経路は全部 merge-pdfs に集まる

| 経路 | 実体 |
|---|---|
| 拡張の一括検索・全ページ送る | `bulk-dl.js` → `axlx-send-to-line` → `/api/merge-pdfs` |
| AIXモードの自動（11:00 / 17:00） | `vercel.json` の `auto-property-search?mode=am/pm`（UTC 2時/8時）→ `automation_commands` を積むだけ → 拡張が claim して同じ経路 |
| itandi・レインズ | `axlx-send-pdf-data-to-line` → Blob → `/api/merge-pdfs` |

→ **除外は `/api/merge-pdfs` 1か所で効く**（拡張を触らない＝再読み込み不要）。

### 困りごとは実測できた

`scripts/audit-room-identity.ts`（直近60日・物件19,209件）:
**一度送った物件をまた送っているのは 6,863件（35.7%）**。
間隔は 1〜3日 25.8% ／ 3〜7日 13.9% ／ **1〜2週 18.9%** ＝ 日をまたいで繰り返している。

### 邪魔をしていた3つ（全部サーバー側だった）

**① 物件名に【N】が残っていた（81.2%・14,746件）**
`merge-pdfs` が `/^【\d+🌟?★?】\s*/` で番号を剥がしていたが、**🌟 はサロゲートペア**なので
`u` フラグ無しの `🌟?` は「前半は必須・後半は任意」になり、**🌟 が付かない「【1】」に当たらない**。
＝ オススメに選ばれなかった大多数の名前が「【5】エスリード新北野」のまま保存されていた。
名前が違えば突き合わせは当たらないので、重複の警告も除外も効かない。
→ `parseSummaryHead`（`u` フラグ付き・テスト済み）に統一。既存データも
`scripts/fix-sent-property-names.ts --apply` で 14,743件を修復（14,746 → 11件）。

**② 「誰に送ったか」が 9/21 に 0.1% へ戻っていた**
9/20 に `background.js` を直して 79.2% になったが、**翌日 0.1%**。
＝ 修正が**再読み込みされていない端末**で動いている（`scripts/audit-sent-prop-recent.ts` の日別表）。
→ `merge-pdfs` が `customer_name` から `property_customers` を引き直す（`lookupCustomerByName`）。
名前は LINE の見出しに使うため必ず届いているので、**拡張を待たずに紐付く**。
⚠ 同姓同名は引かない。実測（`scripts/audit-name-to-customer.ts`・293人）で
1人に決まる名前は **91.4%**、残り 23種類・50人（17.1%）は同名が複数いる。
別人の履歴で外すのがいちばん重い失敗なので、曖昧なら何もしない。

**③ 号室が 0.1% しか取れない**
`scripts/audit-summary-room.ts`（物件20,716件）: 名前の末尾に号室があるのは **12件（0.1%）**。
しかも **1回の送信の 74.2%** に「同じ建物名が2件以上」入っている（＝別の部屋を同時に送っている）。
同じ建物名のまとまりの **98.0%** は家賃・間取りでも見分けられない（家賃は 0.1% しか無い）。
→ **名前だけで外すと、74.2% の送信で別の部屋まで消える**。
代わりに **リアプロの印刷用PDFの URL** を鍵にする（`pdf_urls[i]` は既にサーバーに届いている）。
リアプロは直近60日の物件の **98.6%**（itandi 1.2% / レインズ 0.1%）。

### 入れたもの

`app/lib/sent-property-filter.ts`（純関数・テスト35件）
- `normalizePropertyUrl` … クエリを落として `host + path` にする。Vercel Blob は毎回変わるので鍵にしない
- `isSameOutgoing` … ① URL 一致 ② 号室が両方あって名前0.95以上＋号室一致 ③ それ以外は**外さない**
- `filterOutAlreadySent` … 並びは元のまま返す（PDF と説明文の対応が崩れない）
- `urlKeysAreDistinct` … ⚠ **自分を守る確認**。URL の鍵がユニーク1つだけなら「URL は物件を指していない」と見なして使わない
  （リアプロの URL が `path は同じでクエリで物件を指す` 形だった場合に**全件消える**のを防ぐ）
- `renumberSummaries` … 外した後に【1】から詰め直す
- `buildExcludedNotice` … LINE の末尾に「（送付済みのため N件を除きました）」

`app/api/merge-pdfs/route.ts`
- PDF を**取りに行く前**に外す（外した物をDLしても捨てるだけ）
- 全部外れたら PDF を作らず「今回の候補はすべて送付済みでした」を1通だけ送る（黙って終わらない）
- `sent_properties.property_url` に URL を残す（次に外す時の鍵）
- 戻す時は環境変数 `SKIP_SENT_PROPERTIES=off`
- ログ: `{"tag":"merge-pdfs:skip-sent", incoming, known, dropped, unmatchable, url_unusable}`
  ／ `merge-pdfs:name-lookup` ／ `merge-pdfs:url-not-distinct`

### 全件監査（誤除外0）

`scripts/audit-skip-sent-dryrun.ts`（過去60日の送信2,824回を時系列で再生）:
```
これから送る物件 19,209件
外す              2件（0.0%）  ← どちらも名前・号室が完全一致（目で読んで確認）
判断できず残す  19,197件（99.9%）← 号室も URL も無いので触らない
全部外れて送る物が無くなった送信: 0回
```
＝ **誤って外す道が無い**。今の効き目が 0.0% なのは号室が無いからで、
**URL は今回から溜まる**ので次の送信から効く。

### 次に確かめること（次に物件を送った後）

```
npx tsx --env-file=.env.local scripts/audit-sent-prop-recent.ts   # 紐付きが戻ったか（日別）
npx tsx --env-file=.env.local scripts/audit-skip-sent-dryrun.ts   # 外れる数
```
Vercel のログで `merge-pdfs:skip-sent` の `url_unusable` を見る。
**`true` なら URL が物件を指していない形**なので、号室を取る方（拡張側）に切り替える必要がある。

### 2026-09-21（追記）単位を「マンションごと」に変えた（竹内さんの選択）

竹内さん「これで一度グループに送った物件（マンションごと）は送られんようになってるかな？」
→ 最初の実装は**同じ部屋だけ**外す形だったので「なっていない」。数字を出して決めてもらった。

**竹内さんの選択: マンションごと（期間なし）／1回の送信の中の同じマンションは全部残す**

| | 外れる物件 | 送る物が0件になる送信 |
|---|---|---|
| 部屋ごと（前の実装） | 2件（0.0%） | 0回 |
| **マンションごと** | **11,086件（57.7%）** | **1,063回 / 2,638回（40.3%）** |

期間で切ってもほぼ変わらない（3日以内でも53.2%）＝ 再送のほとんどが数日以内に起きている。

#### ⚠ いちばん危なかったのは「〇〇Ⅱ」「〇〇Ⅲ」

`similarity` は**2文字のかたまりの集合**（Dice）なので、繰り返しの長さの違いが消える:
```
「マスターズレジデンス道頓堀Ⅱ」 ↔ 「マスターズレジデンス道頓堀Ⅲ」 = 1.000
```
（どちらも "ii" という組を1つ持つだけなので集合が同じになる。線を上げても外れない）
実測（`scripts/audit-building-name-threshold.ts`・建物名3,409種類）で 0.95 以上の9組のうち **7組がこの形**だった。

→ `buildingWing()` で末尾の棟・号館（Ⅰ〜Ⅻ・i/ii/iii・数字・N番館・N号棟）を取り出し、
**違えば別の建物**にする。棟を分けた後に線ごとの巻き込みを数え直した:
```
0.90 → 11組 ／ 0.95 → 1組 ／ 0.96 → 0組 ／ 0.97 → 0組
0.95 で残る1組は「ブエナビスタ難波サウスタワー」↔「ブエナビスタ難波サウス」＝ 別の建物
```
→ `BUILDING_MIN_SCORE = 0.97`（巻き込み0になる 0.96 より内側）。

#### 全件監査（過去60日・送信2,638回を時系列で再生）

```
外す 11,086件（57.7%）／ 外した理由 building 11,084件・room 2件
「名前が違うのに同じ建物と判定した」= 33件 → **全部が空白・全角半角の違いだけ**
  「メゾン ブランカ あびこ南」 ← 「メゾンブランカあびこ南」
  「Brillia　Tower　堂島」     ← 「Brillia Tower堂島」
  「maison de villa 北畠」      ← 「maison de Villa 北畠」
＝ 別の建物は1件も消していない
```

#### 線の使い分け（混ぜないこと）

| 判定 | 線 | 根拠 |
|---|---|---|
| 同じ**部屋**か（`isSameProperty`） | `DUP_MIN_SCORE = 0.95` ＋ 号室一致 | 号室と組で検証した線 |
| 同じ**建物**か（`isSameBuilding`） | `BUILDING_MIN_SCORE = 0.97` ＋ 棟が一致 | 名前だけで判断するので厳しく |

#### 戻し方

- `SKIP_SENT_LEVEL=room` … 部屋ごとに戻す（同じマンションの別部屋は送る）
- `SKIP_SENT_PROPERTIES=off` … 除外そのものを止める

ログ `merge-pdfs:skip-sent` に `level` が出る。

## 2026-09-21 拡張は検索結果から何を読み取れているか（実測）

竹内さん「あとちゃんと物件を読み取ることできてるんかな？拡張ツールで物件検索するさい」

`scripts/audit-extension-read-quality.ts`（直近60日・送信2,868回・物件21,134件）:

| サイト | 件数 | 物件名 | 家賃 | 間取り | 徒歩 | AD |
|---|---|---|---|---|---|---|
| realpro | 20,854 | 100% | **0.0%** | 96.4% | **0.0%** | 33.7% |
| itandi | 254 | 100% | **0.0%** | **0.0%** | **0.0%** | 11.4% |
| reins | 26 | 100% | 100% | 0.0% | 0.0% | 0.0% |

### 物件名は読めている（98.8%）

```
物件名として問題なし  20,877件（98.8%）
「物件」（既定値）       239件（1.1%）← 名前を取れなかった
画面の文字が混ざる        18件（0.1%）（「設備・詳細」等）
空・数字だけ・40字以上・【N】残り  すべて 0件
同じ建物で書き方が2通り以上   15種類 / 3,409種類（0.4%・空白と全角半角だけ）
```
→ 除外（マンションごと）の土台は問題ない。

### ⚠ 家賃が 0% なのは「読めていない」のではなく「数値にする所だけ」が壊れている

`bulk-dl.js` は同じセルの文字を2か所で使っている:
- `buildPropertySummary` … `rentText` を**そのまま**説明文に入れる → **LINE には家賃が出ている**
- `buildPropertyData` … `/(\d+)万/` で数値にする → **「58,000円」「¥58,000」に当たらない**

だから LINE の表示にも、オススメ順の判定（説明文をそのまま LLM に渡している）にも家賃は効いていた。
抜けていたのは**構造化して残す側**だけ（`property_candidate_pools.rent` と `sent_properties.rent`）。
設計知見「『条件を広げた』は履歴からは渡せない — 必要なのは送った物件の家賃・エリア（実測 rent 0%）」が
ここで詰まっていた。

→ **サーバー側で説明文から読み直す**ことにした（`app/lib/property-summary-parse.ts`・テスト15件）。
説明文は merge-pdfs に届いているので拡張の再読み込みが要らない。
「58,000円」「¥58,000」「5.8万円」「7万円」「全角」に対応し、
**2万円未満・50万円超は捨てる**（読み違いを記録しない）。物件名の行は見ない（名前の数字を拾わないため）。
ログ `merge-pdfs:sent-properties:write` に `with_rent / with_url / with_room` が出る。

### ⚠ 名前を読めなかった物件が互いを消し合う穴（除外を入れたことで生まれた）

拡張は名前を取れないと既定値 **「物件」** を入れる（239件）。
建物ごとに外す作りでは、この「物件」同士が名前一致して**同じマンション扱い**になり、
**読み取りに失敗しただけの物件が全部消える**。
→ `isUsablePropertyName()` で「物件」「設備・詳細」「金額だけ」「1文字」を判定から外した。
号室が一致していても、名前が既定値なら外さない（別の建物の同じ号室かもしれない）。
URL が一致した時だけは名前に関係なく外す（URL は確実）。

### 残っている読み取りの穴（未対応・拡張側の変更が要る）

| 項目 | 状態 | 原因 |
|---|---|---|
| 徒歩分数 | 0% | `buildPropertyData` は「徒歩」を含むセルしか見ない（説明文の方は「駅」でも拾う） |
| 号室 | 0.1% | 検索結果の名前に号室が入っていない。PDF 側にはあるはず |
| itandi の間取り | 0% | itandi 経路は `buildPropertyData` を通っていない可能性 |
| AD の異常値 | 5件 | 「200ヶ月」「15000ヶ月」。`^(\d+)[ヶか]月$` に広告料の円が混ざっている疑い |

徒歩は説明文から読めるので、家賃と同じくサーバー側で足せる（`parseWalkMinutesFromSummary` は作ってある。
`sent_properties` に列が無いので配線はしていない）。

## 2026-09-21 スタッフモードの時は「送付済みの除外」を省く（**拡張の再読み込み必須**）

竹内さん「スタッフモードで送るときはちゃんとLINEに共有できるように／これを省く（スタッフモード）の時」

スタッフが自分で選んで送る時は、意図して選んだ物なので**1件も減らさない**。
自動（AIXモード・11:00/17:00）の時だけマンションごとに外す。

### 直した場所は1つだけ（`background.js`）

判定を3つのサイトのファイル（bulk-dl / itandi-bulk-dl / reins-bulk-dl）に書くと、
1つ足し忘れた経路だけ動きが変わる（設計知見「出口の配線は経路ごとに確かめる」）。
**送信の3経路は全部 `callMergeApi` を通る**ので、そこで判定を付ける。

```js
function isStaffModeOn() {   // chrome.storage.local の staffMode / staffModeAt（TTL 2時間）
  ...
}
async function callMergeApi(payload) {
  const staffMode = await isStaffModeOn();
  ... body: JSON.stringify({ ...payload, staff_mode: staffMode })
}
```
※ レインズ（`reins-bulk-dl.js`）は `_staffModeOn` のキャッシュを持っていないが、
  background で判定するのでそのまま効く。

### サーバー側（`/api/merge-pdfs`）

```ts
const skipSent = process.env.SKIP_SENT_PROPERTIES !== "off" && staff_mode !== true;
```
- `staff_mode === true` … 除外しない（全部LINEに送る）
- それ以外 … 今までどおりマンションごとに外す
- ⚠ **記録（`sent_properties` への書き込み）は止めない**。
  スタッフが送った物も「次に自動で送る時に外す材料」なので残す。
- ログ `merge-pdfs:staff-mode` が出る。

### ⚠ 拡張の再読み込みが要る変更が**2つ**たまっている

| 日付 | 変更 | 再読み込みしないとどうなるか |
|---|---|---|
| 2026-09-20 | `background.js` が `property_customer_id` を渡す | 「誰に送ったか」が残らない（9/21 実測 **0.1%**）<br>※ ただしサーバー側で `customer_name` から引き直す保険を入れたので 91.4% は紐付く |
| 2026-09-21 | `background.js` が `staff_mode` を渡す | **スタッフモードでも除外される**（古い拡張は `staff_mode` を送らないので「自動」と同じ扱い） |

→ 拡張を**再読み込み**すれば2つとも効く。
   確認は Vercel のログで `merge-pdfs:staff-mode` が出るか、
   `npx tsx --env-file=.env.local scripts/audit-sent-prop-recent.ts` の紐付きが上がるか。
## 2026-09-24 v2.5.16 itandi の説明文に賃料・間取り・㎡・号室・交通・AD を入れる（itandi-row-parse.js）
- 竹内「賃料と間取りも㎡数取り入れるようにする。そうじゃないとちゃんと判断できないので」「駅名や徒歩数もリアプロ itandi ともに読み取れているのか」
- 実態: 旧 extractPropertyInfo は class 名（h3・[class*='name']）で物件名を探し、itandi の class は `itandi-bb-ui__Box css-xxxx`（自動生成）で当たらず **全件「物件」**。賃料・間取り・㎡・駅・徒歩は読まず、説明文は「【n】物件／AD」だけ → LINE グループも「【1】物件 AD 1ヶ月」。AD は12段上（一覧全体 7,000字超）から最初の「AD/広告費」を拾い、別の物件の AD を拾い得た。property_pool の ad_months は「AD 100%」を 100 と数えていた
- 画面の作り（竹内さんのコンソール出力・2026-09-24）: 「物件資料」ボタン（DIV.CommonButton isDetail）から上へ
  - 部屋の段 = 最初に「円」と「㎡」が両方入る所（3段上 `itandi-bb-ui__Flex`）: 募集中／物確不要／3日前／**612**／**5.7万円**／管理費／共益費／敷金／礼金／保証金／**1K**／**20.88㎡**／内見開始日／入居可能時期／**13枚**（画像枚数）／**広告費（100%・入力なし）**／取引態様／広告掲載
  - 建物の段 = 最初に「徒歩」が入る所（8段上）: 写真の枚数／**物件名**／**所在地**／**交通の行（路線 駅 徒歩N分）**／階建・築年／管理会社／（以下 表の見出しと部屋の段）
- 直し: `chrome-extension/itandi-row-parse.js`（UMD・`self.AxlxItandiRowParse`）を itandi-bulk-dl.js の前に読む（manifest）。class 名に頼らず文字の並びで読む。AD は部屋の段の「N枚」の次の値だけ（100% → 1ヶ月・250% → 2.5ヶ月・円表記は円）
- 説明文（リアプロと同じ並び・サーバーの parsePropertyFacts が読める）: `【n】物件名／67,000円 [管理費]／1K 20.8㎡／405号室／交通（最大3行）／AD 1ヶ月`
- テスト: `node tests/chrome-extension/itandi-row-parse.test.js`（実物の innerText・18件）
- ⚠ 拡張の再読み込みが要る（chrome://extensions で更新）。サーバー側でも PDF の文字層から補う（itandi の作業で並行）

## 2026-09-25 売上サポ「🔍 画像で分析」の itandi の読み取りを正解表で直す（sheet-v3 → sheet-v8）
- 竹内「なんで itandi のやつできなかったのか。原因見つけて改善する。テストを行う。ちゃんと読み取れるようになるまで。プロンプトキャッシュで」
- 正解表（目で作った・DeepSeek 不使用）: itandi の資料画像 26枚（重複1を除き25）＋本物の PDF 18件（property_pickups 50〜67）。scratchpad の it/truth.json・truth_pdf.json。「不明」は採点しない
- 採点: `npx tsx --env-file=.env.local scripts/eval-itandi-reading.ts --dir=<正解表のフォルダ> --round=t1`（本番と同じ readSheetCanvas・保存を使わない＝毎回読み直す・llm_usage_logs の cache_read／費用を表に）
- 原因（画像だけの資料）: 左の列（帯＋枠＋写真の格子）を1枚で渡していた。DeepSeek は画像を決まった大きさに縮めるので、間取り図は画像の 1/4 ほどで字・記号がつぶれた
- 直し:
  1. 枠を画素で探す（sheet-layout.findItandiFrameBox・左辺の縦の罫線→上下端→右端・itandi の位置の範囲で確かめる）: 25枚中24枚が ±0.005、ほかの資料112枚で誤検出0。画像1＝枠だけ、画像2＝上の帯と右の表を縦に並べた物（pdf-sheet-crop.cropCanvasStack）。2枚とも2倍まで拡大
  2. 収納は字を並べさせて数える（storage.labels → sheet-prompt.closetsOf・CLOSET_LABEL／NOT_CLOSET_LABEL）。数だけ答えさせると下足入・Shoes・棚まで数えた
  3. 設備欄の語がはっきりしている時だけ水回りを決める（settleByEquipText: 「バス・トイレ一緒」だけ→同室・浴室内／「別」だけ→別／独立洗面台→独立／室内洗濯機置場→室内。両方ある時は触らない）。PDF は文字層の設備で WIC も決める
  4. 読み取りは温度 0（callDeepSeek に temperature を渡せるように）。既定だと同じ資料で回ごとに読みが入れ替わった
  5. 前置き（共通の頭の「間違えやすい所」）: 引き戸・3点ユニット／パウダールーム・壁付けキッチン・1R・単室・納戸を rooms に。itandi の画像の型に部屋の関係と独立洗面の見本の文
- 結果（全体 項目別の正答率・不明を除く）: t1 94.6% → t6 **97.4%**（450/462）。95% 未満で残ったのはキッチン 93.8%（2件）・部屋の関係 94.3%（2件）・収納 89.3%（3件）＝小さい A 形の枠（元画像 270px）の字と、境目の判断
- 費用: 初めて読む資料で 1件 約0.06〜0.07円・2.2〜2.5秒（入力 約3,400 のうち前置き 約2,500 が2件目から命中）。以前の 0.03円より上がった（前置きが長くなり画像が大きくなった分）
- リアプロの確認: YUMA #9〜11 の帖数（10.2/5.0・11.1/5.4・11.9/4.4）と #9 壁付けは正しい・突き合わせは15件とも ok。リアプロの「Clo.」「クローク」を収納の字の一覧に足した（入れないと収納 0 になっていた）
- ⚠ 2026-09-25 07:20 に node_modules の pdfjs-dist・rimraf・@napi-rs/canvas の中身が空になっていた（npm の処理が途中で失敗した形）。lock のとおりに `npm install` で戻した（package.json・lock は変わっていない）

## 2026-09-25 売上サポ: 届いた時の自動の読み取り・判定の穴埋め（家賃下限・間取りの「も可」・広さ・築浅・エリア・通勤）・条件の要約
- 竹内「売上サポに送られたら、条件指定あれば間取り図とか設備も自動的に読み取る」「家賃の下限入れる」「1DKも可…評価は希望の間取りの方が少し高め」「文章の部分も要約」「エリア…大阪の理解」「通勤…沿線の知識。拡張ツールの物件検索のデータベースを使う」「喫煙とかは不要」
- **自動の読み取り**（app/lib/pickup-auto-analyze.ts・読む物件の選び方は pickup-auto-targets.ts）: recordPickupBatch の最後（同じ waitUntil）で、imageAnalysisNeed が recommended（WIC・対面キッチン・収納・部屋の配置・水回り）のお客様だけ、この回の物件を analyzePickupRow（ボタンと同じ）で読む。外す候補・保存済み・資料なし・推奨の希望が全部設備欄で決まった物件は読まない。最大20件・同時3件・開始から110秒を過ぎたら新しい物件は始めない（反証レビューで150→110）。結果は image_analysis に {…, auto:{at, labels}}。画面は「🔍 自動で読みました（n件・推奨: WIC）」。ボタンは残す
  - llm_usage_logs の action は **pickup_image_analysis_auto**（analyzePickupRow は itandi 作業中で触れないので、llm-action-scope.ts の AsyncLocalStorage で recordAltUsage の action を読み替え）・conversation_id 入り
- **判定の穴埋め**（property-brain.ts・点は REASON_POINTS）: RENT_BELOW_MIN（下限の85%未満 −3・情報）／FLOOR_PLAN_ALT_MATCH（「1DKも可」「厳しければ2LDK」「1LDK or 2K」＝+8・本命は +15。条件の記録の古い「間取り:」は最後の1つだけ・フォームの質問の例「(1K、1LDKなど)」は読まない・フォームの「希望」の行は本命）／SQM_OK +3・SQM_UNDER −10 保留（9割未満）・SQM_UNKNOWN 0（列 floor_area_min・間取りの「30平米以上」・自由文の「25平米」）／BUILDING_AGE_TEXT_OK +3（築年の列が空で「新築 3年・築浅 10年・新しめ 15年」の目安・古くても 0点）
- **エリア・通勤**（area-want.ts・osaka-geo.ts・transit-route.ts・DeepSeek 0円）: AREA_STATION_MATCH +10／WARD +8／LINE +6／NEAR（2km・「周辺」「◯km圏内」「車で15分」は半径）+5／REGION（大阪市内・環状線内・北摂）+3／CLOSE（4km・隣の区）+2／FAR −3 情報（保留にしない）／EXCLUDED（◯◯以外）−10 保留／UNKNOWN 0。COMMUTE_OK +8／SLIGHTLY_OVER 0／OVER −5 情報／INFO（分の指定なし）0／UNKNOWN 0。売上サポの行に「📍 新大阪 徒歩8分・淀川区｜希望の駅（新大阪）｜梅田まで約13分（乗換0回）／希望20分」（property_pickups.location）
  - 路線・駅→区・町名→区・隣接区は拡張の popup-maps.js を `scripts/build-osaka-transit-data.ts` で写した app/lib/osaka-transit-data.ts（**自動生成・手で編集しない**）。拡張の並びの誤り（御堂筋線の新大阪/西中島南方の順・中央線に森ノ宮なし・片町線・JR東海道線の塚本・大和路線の平野/加美・能勢電の平野が大阪の平野と同じ名前）は osaka-geo.ts の LINE_FIXES で直した。**拡張側は直していない**（拡張の検索で使う並びを変える時は拡張も直す）
  - 座標は駅 500 全部（按分 25）・区と市 70。所要は距離から（停車0.8分＋1.1分/km）・乗換5分・直通の組は乗換にしない
- **条件の要約**（condition-summary.ts・condition-summary-server.ts）: 決定論（家賃・間取り・広さ・徒歩・築年・入居・エリア・通勤・設備・入居の条件）＋読めない節だけ DeepSeek（推論なし・温度0・固定の前置き・名前/電話/メール/番地を伏せる）。自由文のハッシュ＋版を property_customers.condition_summary_hash に持ち、文が変わらない限り呼ばない。売上サポに「📝 条件の要約: …」「照らせない条件: 内装: 白基調…」（喫煙・家具家電は出さない）
- DB: property_pickups.location・property_customers.condition_summary / condition_summary_hash（migrate-schema・本番に適用済み `scripts/apply-pickup-location-columns.ts`）
- 監査: `scripts/audit-area-commute.ts --customers|--summary|--sample|--pickups`・`scripts/audit-condition-coverage.ts`（U＝照らせない条件に表示・喫煙/家具家電は不要）。全298人で漏れ（人×種類）383 → 123（残りの大半は入居時期の「目安」57）
- YUMA（テスト顧客2人・片付け済み `scripts/yuma-auto-analyze-test.ts`）: A（WIC・対面キッチン）4件を自動で読み DeepSeek 7回・入力 15,298（命中 12,544）・出力 835・9.5秒、2回目は保存済みで 0回。B（宅配BOX・2階以上だけ）は読まない 0回。条件の要約 1回（2回目は呼ばない）
- ⚠ 既存の recordPickupBatch の「資料の画像の読み取り」（readPropertyImageDetail＝property_image_detail・推論 low）は希望に関係なく全行で動く（今回は変えていない）。「文字で決まる希望だけのお客様は DeepSeek 0回」はこの自動の読み取りについて
- テスト: `npx tsx app/lib/__tests__/area-commute.test.ts`（104件）
- 反証レビュー（2026-09-25）: ①自動の読み取りの保存は `image_analysis IS NULL` の時だけ（読んでいる間にボタンで先に保存された結果を上書きしない）②自動の読み取りを始める線を 150→110秒（merge-pdfs の結合・LINE 送信の時間も 300秒に入る・1件は最悪 約175秒）③座標（梅田＞難波の北・天王寺は難波の東南 等 28組）・路線の隣駅の距離・50＋合計＝点・「も可」＜本命（109 対 102）を確かめて問題なし。⚠ 点の上限 130 に両方が届くと「も可」と本命が同点になりうる
- YUMA の2回目（2026-09-25 午前・itandi #50/#52/#55・リアプロ #35/#36/#45 を本番と同じ recordPickupBatch に通した）で見つけて直した物:
  ①「難波より南は避けたい」を「南の希望」と読み、新大阪の物件に「なんばより南の希望に反する」を付けていた → area-want.ts の directionAfter で「より南は避けたい／NG／以外」を反対の向きで持ち、札の文は「なんばより南は避けたいに当たる」（全299人に向きの希望は0人＝既存のお客様への影響なし）
  ② 売上サポの設備の行の「照らせない条件」に家具家電付きが出ていた → pickup-equipment.ts の NOT_NEEDED_CLAUSE_RE で保存時に外し、PickupReview でも表示時に外す（保存済みの行にも効く）
  ③ 鍵の無い環境で条件の要約が「呼んだ」扱いになり llm_usage_logs に空の行（status 0）を残していた → condition-summary-server.ts で鍵が無ければ呼ばない（テストで出た4行は消した）
  ④ yuma-condition-leak-test.ts を今の判定に合わせた（📍・判定が読む・照らせない条件・不要を分けて数える・旧基準も並べる）。広さの「材料なし」の正規表現の \ が抜けていて常に材料なしだったのも直した
  - 漏れテスト: 旧基準 8→5種類（家賃下限＝判定は読むが今回の物件が下限の85%以上・内装と周辺環境＝照らせない条件に表示・喫煙と家具家電＝不要）→ 今の基準の漏れは 0種類
  - 自動の読み取り: A（WIC・対面キッチン）5件を読み DeepSeek 10回・入力 未命中 2,812／命中 13,440（83%）・出力 1,147・約0.035円/件、2回目は保存済みで 0回。B（宅配BOX・2階以上だけ）は 2回とも 0回。条件の要約は1人1回（入力363・出力28・約0.008円）、2回目の回・最後の呼び出しでは呼ばない

## 2026-09-25 判定の点を拡張の「広げて検索」の幅に合わせる・点の上限 130→200（担当 A・拡張のコードは読んだだけ）
- 竹内「広げて検索した場合も、お客さんの希望の駅の方が点数少し大きくするように。隣の駅だからって点数が大幅に低くなるようにしない。これは家賃とかでもそう。判断基準、広げて検索の部分（拡張ツール）も理解してスコアリングを精密に強化」
- **拡張の広げ方（実物のコード）**:
  | 項目 | 広げ方 | 場所 |
  |---|---|---|
  | 駅 | 解決した駅ごとに**同じ路線の前後1駅**（手動は同じ事業者4路線以上の大きな駅だけ足さない） | resolution-core.js resolveConditionsLocal ④ getAdjacentStations・popup.js 3832/4243 |
  | 地域（区） | 難波・心斎橋（中央区・浪速区・西区）を3区まとめて足す。itandi は町名まで行かず区まで | popup.js expandNambaCodes/Wards・ward_town_map は wide で null・page-script.js 1351 |
  | 家賃 | 上限 **＋5,000円（10万円以下）／＋10,000円（10万円超）**。サイトの賃料の欄＝**管理費を含まない** | resolution-core.js ⑧・popup.js 3885/4382・background.js 3175 |
  | 間取り | **LDK の希望に同じ部屋数の DK** を足す（1LDK→1DK） | page-script.js 1044・itandi-page-script.js 780・reins-page-script.js 260 |
  | 築年 | **＋5年**（リアプロの手動・background の scrape 経路だけ。itandi の手動 popup 3897 は足していない） | resolution-core.js ⑧・popup.js 4438 |
  | 広さ | −5㎡（**手順の表示だけ**・自動入力の area_min には入っていない） | popup.js buildCondData 2110 |
  | 徒歩 | 広げない | — |
- **広げた回かはサーバーに届いていない**: merge-pdfs の body（callMergeApi）は is_wide を送らない・sent_properties / property_pickups に列なし。property_customers.search_history（{realpro_w: 時刻}）と last_wide_search_at は最後の1回だけ。→ **判定は回の種類に関係なく「拡張が広げる幅」で帯を作る**（ピンポイントでも管理費で上限を超える物・別の駅の交通で拾う物は同じ扱いでよい）
- **新しい配点**（property-brain.ts REASON_POINTS・area-want.ts matchArea）:
  - 駅: 希望 +10／**隣（AREA_STATION_WIDE・広げた検索の駅）+8**／**同じ路線で2駅（AREA_STATION_2STOPS）+6**（旧: 隣も距離で見て 2km 以内 +5・4km 以内 +2）。徒歩15分以内の駅だけ。並びは 駅 → 隣 → 区 +8 → 2駅 → 難波の3区（AREA_WARD_WIDE）+6 → 路線 +6 → 2km +5 …
  - 家賃: 上限内 +15／**幅の中（RENT_WIDE）+10**＝管理費込みで 上限＋幅 以内、または家賃だけなら上限内で管理費込み1割以内（旧: 0）／幅の外で1割以内 0／1割超は保留（変えていない）
  - 間取り: 本命 +15／「も可」+8／**LDK→同じ部屋数の DK（FLOOR_PLAN_WIDE）+8**（旧: 近い +5）／近い +5
  - 築年: 希望内 +5／**＋5年まで（BUILDING_AGE_WIDE）+2**（旧: ＋3年まで −3・＋4〜5年は −10 保留）。BUILDING_AGE_SLIGHTLY_OVER は保存済みの行のために表に残した
  - 広さ: 9割以上 0／**−5㎡まで（SQM_WIDE）−3 情報**（旧: −10 保留）／それより下は保留
  - どれも保留・外す候補にしない。札は「広げた検索の駅（新大阪＝希望の東三国の隣・御堂筋線）」「広げた家賃の幅（上限＋5千/1万円）」（pickup-review-order.ts CHIP_JA）
- **点の上限 130→200（SCORE_MAX）**: 条件が全部合う物件は AD なしで 136点 → 130 で切ると AD 1ヶ月 151・2ヶ月 166・3ヶ月 171 が全部 130 で同点だった（テストで確認）。AD の重み（AD_HIGH +20・AD_VERY_HIGH +5）は変えていない。実送信で AD の月数が分かる 937件は 1〜2ヶ月 14%・2〜3ヶ月 51%・3ヶ月以上 35%
- **線を引いた実データ**: sent_properties（家賃あり 2,205件・46人・家賃だけ）で 上限内 94.8%／上限〜幅 2.0%／**幅〜1.10 は 0件**／1.10〜1.30 1.6%／1.30超 1.6% ＝ 幅の内側は実際に送っていて、幅の外は拡張が切っている
- **監査（本番 property_pickups 全36行・判定できる33行・6回・3人）**: 点が変わったのは 26行（全部上がった・下がった行 0）・保留→通す 1行（#1 1LDK 35.19㎡・広さの希望の −5㎡以内）。
  - リアプロ #34〜45（上限8万・管理費込み 81,100〜85,000）: 全12行 RENT_SLIGHTLY_OVER 0 → RENT_WIDE +10（80→90・65→75）。並びは同じ（AD 2ヶ月 ＞ 1.5ヶ月のまま）
  - itandi #50〜67（希望 東三国）: 新大阪の11行 AREA_NEAR +5 → AREA_STATION_WIDE +8、西中島南方の1行 AREA_CLOSE +2 → 2駅 +6。18件中13か所で並びが入れ替わり、東三国の駅の物件と隣の駅の物件が他の条件（敷礼0・設備・AD）で並ぶようになった（同じ条件なら希望の駅が +2 上）
- **全お客様の希望の駅（287人・168種類）で判定の「隣」と拡張の getAdjacentStations を照合**（resolution-core.js を vm で読み込み）: 一致 84・違う 42・拡張の辞書に無い 42。違いの多くは判定の方が本当の隣を多く持つ物（梅田は拡張の STATION_LINE_MAP が御堂筋線だけ＝十三・福島・南森町 等を足さない／なんば・尼崎・久宝寺は拡張で隣が0）
- **⚠ 拡張側に要る変更（担当 B へ）**:
  1. 拡張の路線の並びの誤りで、広げて検索が**間違った駅を隣として足している**: 東三国→西中島南方（本当は新大阪）・西中島南方→東三国・新大阪→中津・中津→新大阪・塚本→新大阪・谷町四丁目→緑橋（中央線に森ノ宮が無い）・緑橋→谷町四丁目。直しは osaka-geo.ts の LINE_FIXES と同じ並びを popup-maps.js の LINE_STATION_ORDER（と resolution-core.js の写し）に
  2. 大きな駅（梅田・なんば・尼崎・天王寺）は STATION_LINE_MAP に一部の路線しか無く、広げても他の路線の隣が入らない
  3. 広さの −5㎡ は手順の表示だけで自動入力に入っていない（popup.js buildCondData だけ）・itandi の手動（popup.js 3897）は築年 ＋5年を入れていない ＝ 経路で広げ方が違う
  4. 広げた回かをサーバーに届ける: callMergeApi の body に `search_mode: 'wide'|'pinpoint'`（bulk-dl.js・itandi-bulk-dl.js が今の検索のモードを storage に持って渡す）→ merge-pdfs → recordPickupBatch → property_pickups.search_mode（新しい列・migrate-schema も）。届けば札を「広げた検索の回」と出せる。点の帯は今のままでよい
- テスト: `npx tsx app/lib/__tests__/wide-search-score.test.ts`（34件・新規）・area-commute 116・property-brain 88・pickup-review-order 58・pickup-terms 50・pickup-equipment 64 ほか全通過。上限は SCORE_MAX を import して 50＋合計＝score を確かめる

### 2026-09-25 反証レビュー（広げて検索の帯・通勤の候補）で直した物
- **駅のまとまりを希望の駅に**（area-want.ts `stationGroupOf`）: 梅田の希望で JR大阪・西梅田・北新地の物件が AREA_NEAR +5、隣の中津が AREA_STATION_WIDE +8 と**広げた駅の方が高かった**。STATION_GROUPS（梅田＝梅田/大阪/西梅田/北新地、天王寺＝天王寺/大阪阿部野橋/天王寺駅前、心斎橋＝心斎橋/四ツ橋 等）の駅は AREA_STATION_MATCH、まとまりの駅の隣（中崎町＝東梅田の隣）も WIDE に
- **環状線の輪**（`stopsBetween`）: LINES の環状線は 大阪…天満 の両端がつながらない形 → 天満の希望で大阪が 18駅扱い。輪で数える（`adjacentStations` は拡張の getAdjacentStations の写しなのでそのまま）
- **家賃の幅**（property-brain.ts judgeProperty）: 2つ目の条件を「家賃だけ上限内」→「家賃だけ 上限＋幅 以内」かつ管理費込み1.10以内に。旧は 83,000＋管理費3,000（計86,000・広げた検索で拾う）が 0点、78,000＋9,000（計87,000）が +10 と**安い方が低かった**。property-brain.test の「1.10 ちょうど」（72,000＋5,000・上限7万）は RENT_WIDE に
- **拡張 commute-candidates.js mergeStationField**: 通勤の言い方を外す正規表現の「分」が駅名の 河内国分 まで消していた → 数字＋分だけ外す（osaka-transit.test.js に1件）
- 確かめた（問題なし）: AD の重み不変・外す／保留の候補は増えない（札は全部保留にしない）・全行 50＋合計＝score（SCORE_MAX 200）・UMD は node（module.exports）とブラウザ（self）両方・manifest の web_accessible_resources に2ファイル・popup.html の読み込み順・osaka-transit.js は生成し直しても同じ（md5 一致）

## ⚠ 2026-09-25 拡張が読み込めなかった（v2.5.16・v2.5.17）: chrome-extension/ の中に「_」で始まるフォルダを置かない
- 竹内さんの Chrome:「Cannot load extension with file or directory name __tests__. Filenames starting with "_" are reserved for use by the system.」
- 原因: 9/24 の itandi-row-parse のテストを chrome-extension/__tests__/ に置いた（v2.5.16）。拡張のフォルダの中の「_」始まりのファイル・フォルダは Chrome が読み込みを拒否する
- 直し: テストは tests/chrome-extension/ に移した（node tests/chrome-extension/itandi-row-parse.test.js・osaka-transit.test.js）。**拡張のテストは chrome-extension/ の外に置く**

## 2026-09-25 売上サポの点数の監査（任務A）と、スタッフが選んだ🌟で重みを確かめる（任務B）→ 強化（サーバーだけ・拡張の再読み込み不要）
竹内「ちゃんと評価されているか・点数化は正確か・AIX 物件オススメと物件ピックアップで実際に送ったデータも見て、なぜ一番オススメなのかを調べてスコアリングを強化。YUMA で徹底的に・DeepSeek」
### 監査で見つけた誤り（property_pickups 全36行を本番と同じ手順で当て直し・scripts/audit-pickup-scores.ts）と直し
- **E1 リアプロの AD が読めない**: 元付資料は「A D 250%(税込)」「A D 10000円」（A と D の間に空白・19件全部）→ property-pickups.ts `parseAdFromText` を `A\s?D`＋全角そろえ、pickup-rank.ts `enrichSummariesWithPdfAd` の AD 行の判定も同じ形。id 1 は AD 2.5ヶ月（+30）、id 3 は AD 1万円＝利益が出ない（−10・保留）
- **E2 itandi「広告費 なし」を不明扱い**: `adMonths: 0` を返す（null と分ける）。説明文には「AD なし」の行を足す。新しい札 **AD_NONE −5**（＋家賃が読めれば PROFIT_NEGATIVE −10 保留）→ AD なしが AD 0.5ヶ月より下に並ぶ（id 57: 104→89・id 62: 98→83）
- **E3「2階以上はエレベーター必須」を「2階以上が必須」と読んでいた**: listing-equipment.ts `conditionalFloorOf`＝「N階以上は／なら／の場合」の後に別の設備がある節は階の希望を作らず、設備の希望に `ifFloorAtLeast` を付ける。`matchEquipment` は部屋が N 階未満ならその行を出さない（階が分からない時は残す）。画面の名前「エレベーター（2階以上の時）」。property-brain `IMAGE_WANT_RES` の floor_2_plus も「2階以上は…」を拾わない。**id 2（DeepSeek の🌟★）は上限20点→68点**
- **E4「退去予定(10/31)/相談」の退去日を使っていない**: listing-terms.ts `vacateNextDay`・`compareMoveIn` は相談・居住中でも退去日の翌日が希望日＋14日より遅ければ late（早い時は ok にせず要確認のまま）。id 1 は「入居が遅い」−10・保留
### スタッフが選んだ🌟で重みを確かめて入れた物（property-brain.ts judgeProperty）
- **送付済みは号室で見る**: `splitBuildingRoom`・`normalizeRoomKey`・profile.history.sentRooms（sent_properties.room_no を judge route と売上サポで引く）。同じ建物の別の部屋＝ **ALREADY_SENT_OTHER_ROOM −3（情報）**。号室を読んで初めて当たる同じ部屋（旧は名前が合わず当たらなかった）＝ **ALREADY_SENT_SAME_ROOM −10（保留）**。名前の一致（旧の線）は今まで通り外す候補＝**外す候補は増やしていない**。`normalizeBuildingName` と `parsePropertyFacts` は【1🌟★】の番号も落とす（旧は🌟の物件が送付済みに当たらなかった）
- **間取りの帯**: 2DK↔1LDK＝ **FLOOR_PLAN_SAME_CLASS +8**（🌟で4人5件）・希望より部屋数が多い＝ **FLOOR_PLAN_LARGER +5**（5人9件・上限を書いた希望「1DK〜2K」には当てない）・狭いは今まで通り不一致の保留・2K↔1LDK（1人に偏る12件）は入れない
- **家賃の超過は金額の線も**: 上限＋1万円以内は比が 1.10 超でも RENT_SLIGHTLY_OVER 0点／上限＋2万円以内は外す候補にせず保留（RENT_OVER_SOFT_YEN・RENT_OVER_DROP_MIN_YEN）。🌟の超過は中央値 5,000円・1万円以内 80%
- **AD は月数だけでも段の点**（AD_1M・AD_HIGH・AD_VERY_HIGH）。利益の札（まかなえる／利益が出ない）は家賃が読めて円にできる時だけ
- 🌟（pickup-rank.ts）: **固定の前置き `RANK_PROMPT_PREFIX` を先頭**（条件・物件一覧は後ろ＝キャッシュ）。「㎡あたりの家賃が安いほど良い」をやめ（🌟は予算の 0.95）、スタッフの訴求の多い順（敷礼0・築浅・駅近・広さ・オートロック・独立洗面・ネット無料・宅配BOX・浴室乾燥・角部屋）、2DK↔1LDK、同じくらいなら元の並び。merge-pdfs は `buildRankMaterials` で物件ごとに「資料: 敷なし・礼1ヶ月 ／ 築2年 ／ 入居11月上旬〜（退去予定も） ／ 設備: …」をプロンプトだけに足す（説明文・LINE は変えない）。**AD「2ヶ月以上は必ず最上位」は竹内さんの 9/24 の指示のまま（データでは🌟は AD で選ばれていない＝判断待ち）**
- 🌟の DeepSeek は **推論なし（thinking:false・温度0・max 300）** に固定: 推論 low・max 4000 は YUMA テストで 9回中5回が約20秒で答え0文字（推論で上限を使い切り Haiku に落ちる）。推論なしは 9回とも答え・1秒未満・2回目も同じ答え・2回目は入力の 84〜94% がキャッシュ
### 前後の当たり方（scripts/audit-star-rank.ts・--until=2026-09-25T12:00Z・直近90日・旧のコードと同じデータで続けて実行）
| | 旧 | 新 |
|---|---|---|
| 🌟の回（候補2件以上） | 82 | 82 |
| 相対順位（0=1位・でたらめ 0.5） | 0.461 | 0.466（変わらない） |
| 3位以内（同点は平均） | 58.5% | 58.5%（でたらめ 67.4%） |
| 単独の1位 | 6.1% | 15.9% |
| 候補の点が全部同じ回 | 54/82 | 15/82 |
| 🌟の AD がプールにある回（28）の相対順位 | 0.435 | 0.157 |
| 🌟の本文の値で保留・外す候補の札が付く（誤保留） | 74/549（13.5%） | 50/549（9.1%） |
| 🌟が外す候補 | 0 | 0 |
- **正直な読み**: 候補プールの材料（名前・順位・間取り・AD 37%・家賃 0.4%・敷礼 0）では、点はまだスタッフの選び方をでたらめ以上に当てられない。改善したのは同点の解消と誤保留（13.5→9.1%）。AD の有無の欠けが順位を動かす（🌟の AD がある回は上がり、無い回は下がる）ので、AD の重みそのものは全候補の AD が分かる回（1回だけ）が溜まるまで判断できない。拡張の順位（1位 41.5%・3位以内 80.5%）が今いちばん強い材料
- 監査の実物（売上サポ）の変化: id 1 120→137（AD 2.5 読めた・入居が遅い保留）／id 2 20→68／id 3 53→43（利益が出ない）／id 57 104→89・id 62 98→83（AD なし・保留）。**保存済みの行の点は付け直していない**（書き込みを伴うので未実施）
### 残り
- 候補の記録を太くする（log-property-candidates／候補プールに 家賃・管理費・敷礼・徒歩・築年・㎡ と、🌟を押した時の回の候補 id）＝点の当たり方を測れるようにする一番の手
- 拡張の判定（/api/property-brain/judge）は資料が無いので敷礼・築年を埋められない（売上サポだけ）
- 🌟に渡る条件の文（拡張の buildCustomerConditionsString）に自由文の設備の希望（2階以上・宅配BOX 等）が入っていない＝ DeepSeek が 1階の部屋を選ぶことがある
- listing-equipment の設備欄は「エレベーターなし」も ○ と読む（ok を先に見る決まり・今回は触っていない）
- YUMA テストで上げた資料の画像 8枚（property-images/aix/YUMA/pickup_test_1790300773594_*）は公開キーでは消せなかった（物件資料・お客様の情報なし）
- 反証レビュー（2026-09-25）で直した: ①番号の印の読み取りを【N🌟★】だけに（旧の [^】]{0,4} は「【2024年築】」を番号 2024 と読み名前を削った）②画像の階の希望で「2階以上は必須／希望」まで落としていた否定先読みをやめ、conditionalFloorOf が数を返す節だけ消す ③1月の基準で「退去予定(12/31)」を今年12月と読み「入居が遅い」の誤保留→10か月以上先の月は去年 ④お客様向けの事実（pickup-send-facts）の AD 行の読み飛ばしを「A D」にも
- テスト: app/lib/__tests__/pickup-score-audit.test.ts（77件）・wide-search-score の 90,000円（上限＋1万円ちょうど）を RENT_SLIGHTLY_OVER に

## 2026-09-25 YUMA で条件の違うお客様6人を本番の資料で通して目で確かめる → 直した物（サーバーだけ・拡張の再読み込み不要）
- 道具: `scripts/yuma-pickup-customers-test.ts`（`--run` / `--report` / `--cleanup`・`--state=<json>`）。本番の property_pickups の資料（itandi id 50〜67・リアプロ 34〜45）で、お客様A〜F（設備重視・駅近＋送付済み・家賃＋初期費用・画像の希望・通勤・広げた検索＋入居時期）を作り、merge-pdfs と同じ順（説明文の補い → 🌟の材料 → 🌟 DeepSeek → recordPickupBatch）に通す。ローカルに Blob の鍵が無いので `@vercel/blob` だけ `scripts/yuma-blob-shim.cjs` に差し替え（借りた本番の資料の URL に `?yst=<印>` を付けて返す・何も上げない）。片付けで property_pickups・property_customers・sent_properties・image_details（?yst=）・property_sheet_facts（新しい行は消し wants_judged は元に戻す）を全部戻す
- 見つかって直した物（3回まわして目で確認）
  1. **🌟★ が保留の物件に付く**（お客様A・C）: 同じ建物の間引き（pickup-dedupe）が AD 2.5ヶ月の 🌟★（907号室）を落とし、2,000円安い AD 0.5ヶ月の部屋（413号室・利益が出ない保留）に 🌟★ を引き継いでいた（C は 50点・保留に 🌟★）。→ `adTier`（判定の AD の札と同じ段）: 🌟 の部屋の段が残す部屋より高い時は落とさない。同じ段以上の部屋をもう残していればそちらに寄せて印を引き継ぐ（同じ建物を3部屋並べない）
  2. **送付済みの部屋が「残す部屋」になる**（お客様B）: 一番安い 710号室（送付済み・保留）が残り、まだ送っていない 907号室を落としていた。→ `dedupeSameBuilding(summaries, { isSent })`・`property-brain.isSentRoom`（judgeProperty の ALREADY_SENT / SAME_ROOM と同じ線）。recordPickupBatch は判定の材料（loadProfile）を間引きの前に読む
  3. **送付1件で「いつもの家賃帯より高め」−5 がほぼ全件に付く**（お客様B）→ `RENT_USUAL_MIN_SENT = 3`（`history.rentRatioN`）
  4. **👑 が同点の保留に付く**（お客様C）→ `pickCustomerBest` と画面の回ごとの一番（PickupReview）で、点・上限前の点・「合う」の数が同じなら判定（通す＞判定なし＞保留＞外す候補）を 🌟 より先に見る（`verdictOrder`）
  5. **🌟 に渡る条件の文が粗い**: 拡張の `buildCustomerConditionsString` は家賃を万で丸め（7.5万→「予算8万円以内」・6.2万→「6万円」）、設備・入居時期・初期費用・通勤が入らない。→ `pickup-rank.loadRankConditions`（merge-pdfs）: DB の「条件の要約」（condition-summary の line・DeepSeek は呼ばない）を正にし、拡張の文は要約が無い時だけ。初期費用を抑えたい方は「初期費用を抑えたい（敷金・礼金0の物件を優先）」を足す。固定の前置きより後ろ＝キャッシュは割らない。結果: E（入居10月中旬）で入居が遅い物件に 🌟 が付かなくなり、6人とも 🌟★ が点の1位（か同点1位）になった（1回目は A 92点・保留、C 50点・保留に 🌟★）
  6. **間取り図の有無の読み取り（readFloorPlanFacts）が 31% 失敗**: 推論 low・max 1,500 は同じ 21枚で 9枚が答え0文字（約9秒）。→ callDeepSeek・推論なし・温度0・max 300: 21/21・中央 1.7秒・2回目同じ 20/21・項目の一致 55/57。拡張の判定（judge・8秒で打ち切り）でもほぼ間に合っていなかった
- 目で見て問題なしとした物: 家賃の帯（管理費込み・上限＋5千円の幅・＋1万円まで保留にしない）・敷礼0（抑えたい方は +20）・入居時期（10月中旬に 11/28・12/1 は −10 保留）・設備（宅配BOX必須の記載なしは 0点の要確認・1階は 2階以上 ×）・通勤（梅田まで 17分 乗換0）・AD（171,600円÷78,000円＝2ヶ月以上）・同じ建物の間引き（AGREA 8部屋→1部屋）
- AIX 物件オススメ（property_recommendation・DeepSeek flash）を YUMA で3回: 社内の文・AD は0。敷礼0 は点の札と一致・「浴室乾燥機」（資料に記載なし＝要確認）は書かない。**物件名を2回とも「エキスプレス」と読み違え**（正: エキスプレイス）。9/24 09:01 の回のリアプロの1ページ目の画像は文字抜け（9/24 20:16 の cMap の直しより前）で、その画像を渡すと「🌟お部屋」になる
- 費用（llm_usage_logs・env=local・3回分＋比較）: 合計 約$0.40（約60円）。9割は元付の資料の読み取り property_image_detail（推論 low・1回 出力 約4,700・約$0.003）。Claude は 0回
- 残り: ①拡張の条件の文の丸め（popup.js・サーバーは要約で上書きするので 🌟 には効かない・要約が無い時だけ残る）②property_image_detail の推論（費用の9割・20〜40秒）を推論なしで足りるか正解表で測る ③AIX 物件オススメの物件名の読み違い（売上サポから渡す時は行の物件名を渡す）④エリアの駅の一致は徒歩の長い副駅（新大阪 徒歩15分）でも「希望の駅 +10」

## 2026-09-25 v2.5.21 🧠×スタッフでも売上番長グループに「🧠 ブレイン判定」のまとめを付ける
- 竹内「共有しておく」（🧠×スタッフの LINE の説明文に判定のまとめを付けるか → 付ける）
- mode-core.js の behavior: brainNote = brain（スタッフでも true）。bulk-dl.js の buildSendItemsBrain: スタッフでも note_line を末尾に付ける。外すのは今まで通りしない（brainDrop = brain かつ スタッフでない・サーバーも staff_mode=true で apply_drop=false）
- 🧠×AIX の 11:00/17:00 の自動便は見送りのまま（竹内「質が上がったら出来るようにするから、まだこのまま」）
- ブレインが ON なら、通常・スタッフ・AIX のどれでも売上サポに連動（竹内「ブレインモードの場合は売上サポに連動される形」）

## 2026-09-25 v2.5.22 お客様の作業を終えた時（確認☑／✅ 送った）に、売上サポの回をまとめて分析する
竹内（売上サポのスマホの画面を見て）「まとめられていない。スタッフモードで送った時は、拡張ツールはお客さんのところ完了ボタン押したら、リアプロと itandi の全部分析されるようにする」
- **今まで**: merge-pdfs の1回（サイト・ページごと）が1バッチ＝ property_pickups の batch_id。🧠×スタッフで手で送るとリアプロと itandi が別々のバッチで届き、自動の読み取り（pickup-auto-analyze）もバッチごと（110秒の締め切り・20件まで）、👑 は画面で「最新の回から6時間」をまとめて計算。お客様の「確認」は property_viewed_at を書くだけ、「✅ 送った」は property-tasks を書くだけで、売上サポとは無関係だった
- **今**: 「完了」＝ お客様一覧の **「確認」**（押すと ☑・`markPropertyViewed`）と、リアプロの下のバーの **「✅ 送った」**（`adj-mark-sent-btn`）。押して記録が書けたら `completePickupsForCustomer(id, trigger)` → background `axlx-pickups-complete` → **POST /api/property-pickups/complete**（待たない・結果はトースト `#pickup-complete-toast`）
  - ☑ をもう一度押した時は、確認の記録は書き直さず、まとめだけ行う（☑ の後に送った回もまとめられる）
  - 呼ぶかは `mode-core.js` の behavior **completeGroup ＝ ブレイン ON**（🧠×スタッフ・🧠×通常・🧠×AIX のどれでも）。ブレイン OFF は呼ばない（売上サポに届いていない）。サーバーも brain !== true なら何もしない（二重の歯止め）
  - 二重押し: 拡張は同じお客様を結果が返るまで＋返ってから10秒は呼ばない。サーバーも冪等
  - 認証: 拡張は自動化の API と同じ `x-automation-key`（chrome.storage.local.automationApiKey・サーバーの AUTOMATION_API_KEY が無ければ通す）。アプリ・scripts は内部認証（Bearer INTERNAL_API_SECRET）
- **サーバー**: `app/lib/pickup-complete.ts`（純関数）・`app/lib/pickup-complete-server.ts`・`app/api/property-pickups/complete/route.ts`
  - 対象＝そのお客様の `complete_group_id` が空の行（前の完了より後）で、押した時から24時間以内（状態は問わない・送った行・自動送信の回も入る）
  - まとめ ID ＝ `cg_<お客様 id 先頭8文字>_<一番古い行の id>`（2台が同時に押しても同じ ID）。行には「complete_group_id が空の行だけ」書く＝先に書いた方だけが行を取り、後の方は 0件（読まない）
  - 応答はまとめ ID を付けたらすぐ（YUMA で 2台同時 830ms）。後ろ（waitUntil・締め切り200秒）で ①取った行だけ自動の読み取り（`autoAnalyzeBatch`・DeepSeek だけ・保存済み／外す候補は読まない・画像でしか分からない希望がある人だけ）②まとめた全件で順位（`complete_rank`：外す候補は最後→判定の点→画像の点→通す＞保留→🌟→新しい回）と 👑（画像の点があれば画面と同じ `pickCustomerBest`、無ければ判定の点の一番＝`best_basis`）
  - 新しい列・表（migrate-schema・本番適用済み `scripts/apply-pickup-complete-columns.ts`）: `property_pickups.complete_group_id / complete_rank`、`property_pickup_completions`（group_id 主キー・trigger・mode・requested_by・status running/done/error・item_ids・batch_ids・sites・best_id・best_basis・result）
- **YUMA**（`scripts/yuma-pickup-complete-test.ts --run / --cleanup`）: テスト用のお客様（WIC・対面キッチン）にリアプロ6件＋itandi 7件を2回に分けて入れ（本番の資料を写す）→ ブレイン OFF は0件 → 2台同時は片方13件・片方0件（同じ cg_…）→ 二重押し0件 → 後ろで13件を自動で読み（27秒・llm_usage_logs 24行すべて deepseek-flash・Claude 0）→ 👑 は itandi の回の物件（67点）＝リアプロだけでは出ない物をまとめた全件から選んだ。片付け済み（行・まとめ・お客様・property_sheet_facts 11行消し2行戻し）
- ~~画面（売上サポ）はまだまとめ ID を使っていない~~ → **反証レビューでつないだ**: 画面の担当は `round_id` という列を読んでいた（本番に無い列・error を握りつぶして30分の時刻でしか寄せていなかった）→ `/api/property-pickups` の `readRoundIds` を `complete_group_id` に直した。YUMA で 5時間離れたリアプロと itandi の回（同じまとめ ID）が「ピックアップ 6件（リアプロ 3・itandi 3）・2回分をまとめて表示」の1つの吹き出しになり、印なしの回は別になるのを 390px で確かめた（横スクロールなし）。👑 はまだ画面の決め方（`pickCustomerBest`・直近6時間）で、`property_pickup_completions.best_id` は読んでいない（どちらを一番にするかの竹内さんの判断待ち）
- 反証レビューで足した歯止め: `/send` は batch_id を「,」で100回分まで受け、別のお客様の行が混ざった頼みは 400（送った印・sent_properties を別のお客様に書かない）／「📤 AIXで送る」はチェックが10件を超えたら止める（AIX は10件で切るのに mark_sent は渡した id 全部に印を付けていた）
- 気付いた事（直していない）: ①👑（画像の点）と順位（判定の点）が食い違う — YUMA では 👑 の物件が判定 65点・保留で順位12位（画像の点 67 が一番）。画面の 👑 も同じ決め方（pickCustomerBest は画像の点が先・判定は同点の時だけ）。どちらを「一番」にするか竹内さんに確認 ②9/24 の itandi の行は物件名が「物件」だけ（説明文が「【1】物件\nAD 1ヶ月」）＝リアプロの一覧の形に物件名を出すには itandi の名前の取り方が要る
- テスト: `app/lib/__tests__/pickup-complete.test.ts`（33）・`tests/chrome-extension/mode-core.test.js`（50）
- **竹内さんが確かめること（拡張の再読み込み後）**: 🧠 ブレイン ON・スタッフで、同じお客様にリアプロと itandi から「売上番長に送る」→ お客様一覧で「確認」→ 下に「売上サポにまとめました: リアプロ N件・itandi M件」→ 1〜3分後に売上サポ。ブレイン OFF では何も出ない

## 2026-09-25 webapp-bridge.js の文法の誤りを直す（8/10〜9/25 の約6週間、ウェブアプリ→拡張の橋渡しが全部止まっていた）
竹内「文法の誤り直す」
- **原因**: 497a94e9（8/10 見積書自動モード）で `var site`（estimate-auto の枝）を足した時、同じ関数の下に `const { site }` があり二重の宣言 → ファイル全体が読み込みで SyntaxError。content script は1行も動かず、ウェブアプリは「拡張の返事が 1.5秒来ない → キューへ」の予備の道だけで動いていた（だから気付かれなかった）
- **止まっていた機能**: ①poll-now（キューに入れた直後の即時の拾い → 30秒のアラーム待ちになっていた）②物件の比較のスクレイプの直接の道（aixlinx-webapp-scrape → キュー scrape_and_compare で代わりに動いていた）③物件検索の直接の道（aixlinx-webapp → /api/automation/trigger で代わりに動いていた）④見積書の「自動」の新フロー（物件名でリアプロを検索 → 客付業者様へ）と旧フロー（開いている詳細タブを読む）＝**予備の道が無く「タイムアウト（Chrome拡張が応答しません）」になっていた** ⑤ポップアップの「見積書自動」で開いた見積書（?pendingSupp=1）への補足情報の受け渡し（ページは開くが補足情報は入らなかった）⑥一括の1人完了の中継（顧客リストの一括の進み具合が進まない）⑦app/page.tsx の条件パネルの「🔍 物件検索」（予備の道なし・何も起きない）
- **直した事**: 見積書の枝の `var site` → `estimateSite`（node --check を通る）
- **動き出す道の安全の確認（1つずつ）**
  - poll-now → 動かす。background はスタッフモード・ロック中は断る。ただし同じ PC で続けて押すと、アラームと poll-now（または poll-now 2回）が「ロックが無い」を見てから別々のコマンドを claim して2本同時に走りうる → `background.js` の `_pollAndRunBatch` に `_pollClaimInFlight`（拾ってロックを書くまで2本目を始めない）
  - 物件検索・比較のスクレイプの直接の道 → **止めたまま**（`webapp-bridge.js` の `DIRECT_SEARCH_ENABLED = false`・ACK も返さない＝6週間の本番と同じくキュー＋poll-now）。理由: 直接の受け口（axlx-webapp-search / axlx-scrape-and-compare）にはキューの道の歯止め（スタッフモードなら拾わない・ロック）が無い／要対応一括（customers/page.tsx の flagged）はキューに全員入れた上で1人目にも直接の検索（auto_send_all）を出し、1人終わるごとに次の人へも出す＝同じリアプロのタブで2本同時（8/12 に通常の一括で外した「条件混線」と同じ形）／地域＋駅（both）のお客様は直接の道だと10秒後に2本目を出す。戻す時は受け口に歯止め＋画面の二重の発火を消してから
  - 見積書 新フロー（axlx-estimate-realpro-search）→ 動かす。main.php のタブで検索を押すので、**キューの一括のロック中は断る**（「物件の一括検索の実行中です…」・ポップアップからの時も同じ）
  - 見積書 旧フロー（axlx-estimate-auto）→ 動かす。開いている詳細タブを読むだけ（押さない・遷移しない）
  - 補足情報の受け渡し → 動かす。6週間分の読み残しが古いまま入らないよう、保存時に `axlx_pending_supplementary_at` を書き、**10分を過ぎた物・時刻の無い古い形は渡さずに消す**
  - 一括の1人完了の中継 → 動かす（表示だけ）。⚠ 画面の onBatchCustomerDone が一括中かを見ないので、画面で一括を始めていない時に自動便などが走ると「全員分の検索が完了しました！」が出る（操作は起きない・画面側で batchMode を見るのが直し方・未対応）
  - 入口: `e.source !== window` も足した（ページの iframe からの postMessage を受けない）
- テスト: `tests/chrome-extension/webapp-bridge.test.js`（29・拡張の全25ファイルの node --check・manifest の js の実在・偽の window/chrome で分かれ道・DIRECT_SEARCH_ENABLED=true の時も読める）。直す前の版は `Identifier 'site' has already been declared` で落ちるのを確認
- manifest の version は上げていない（同じ日の別の担当が上げる。この変更も再読み込みが要る）
- **竹内さんが確かめること（拡張の再読み込み後）**: ①見積書の画面（sumora-ai-ui.vercel.app/estimate）で物件の画像を入れて「自動」→「リアプロで物件を検索中...」→ 補足情報に「客付業者様へ」が入る（リアプロにログイン済みのタブが要る・一括の実行中は断りの文）②拡張のポップアップの「見積書自動」（リアプロのフリーワードに物件名が入った状態）→ 見積書の画面が開いて補足情報が入る ③顧客リストで itandi の検索ボタン → 30秒待たずに拡張が動き出す（キュー＋poll-now）

## 2026-09-25 v2.5.23 売上サポの 👑 をお客様ごとに（画像で分析の点／判定の点）・最後の送信から10分で自動まとめ
竹内「画像で分析必要なお客さんなら画像で分析の点、画像で分析不要なお客さんは判定した点」「スタッフモードで最終更新した10分間物件がなければ、その間の物件でまとめる。毎回完了おすよりも…10分たてば自動的に送られた物件まとめて、ほかの一括検索や自動モードのときのようにまとめて判定する」
- **👑 の決め方**（`app/lib/pickup-best.ts` の `pickCustomerBest(rows, { basis, preferId })`・画面とまとめの API が同じ関数）:

| お客様 | 👑 の点 | 同じ点の時 |
|---|---|---|
| 画像で分析が必要（`imageAnalysisNeed`=recommended・WIC/対面キッチン等） | 画像で分析の点（点の無い物件は候補にしない） | 上限前の点 →「合う」の数 → 判定（通す＞保留＞外す候補）→ 判定の点 → 🌟 → 新しい回 |
| 　└ 画像の点が1件も無い | 判定の点で補う | ↓ と同じ |
| 画像で分析が不要（optional / none） | 判定の点（外す候補・送った物は候補にしない） | 判定（通す＞保留）→ 🌟★/🌟 → 新しい回 → 順位 |
| 　└ 判定の点が1件も無い古い行 | 画像の点 | |
  - 「必要か」は `customerImageNeed`（分析済みの回に保存した希望＝会話・訴求込みがあればそれ、無ければ条件欄だけ）→ `bestBasisFor`。⚠ 会話にだけ希望がある人は、自動の読み取りが走るまで画面は条件欄だけで「不要」扱い（読み取り後は「必要」）
  - まとめ（`rankCompleteGroup(rows, { basis })`）の 👑 は順位（complete_rank）でも1番。`property_pickup_completions.result.basis_rule` に決まりを残す
  - 画面: 一番新しい回がまとめてあれば、そのまとめの行だけに同じ関数を当て、`best_id` が今も候補（未送信・まとめの後に分析し直していない・決まりが同じ）ならそれを 👑（`preferId`）。まとめていなければ直近6時間。吹き出しの見出しに「まとめた N回分・画像で分析／判定の点」、点は `bestPointLabel`（「67点」／「判定 105点」）
- **10分の自動まとめ**（純関数 `app/lib/pickup-complete.ts` の `autoCompleteDue`／`isQuietFor`／`lastOpenAt`・`AUTO_COMPLETE_QUIET_MINUTES=10`）: そのお客様のまだまとめていない一番新しい行（`property_pickups.created_at`＝売上サポに届いた時刻）から10分、新しい行が届かなければ「完了」と同じまとめ（complete_group_id・自動の読み取り・順位と 👑）。ちょうど10分でまとめる。「完了」ボタンは残す（すぐまとめたい時）
  - 入口は3つ・どれか1つが動けばまとまる（全部 `claimCompleteGroup(..., { quietMs })`＝同じまとめ ID・「空の行だけ書く」で冪等）:
    ① **Vercel Cron** `/api/cron/pickup-auto-complete`（`*/2 * * * *`・1回 最大3人・`runAutoCompleteSweep`）＝本体。PC が消えていても動く。最長12分でまとまる
    ② **拡張** background.js `_schedulePickupIdle`: `callMergeApi` が成功し ブレイン ON・お客様あり の時に `chrome.alarms` の `axlx-pickup-idle:<お客様id>` を「今から10分半後」に置き直す（同じ名前＝最後の送信から数える）→ 鳴ったら `/api/property-pickups/complete {idle:true, trigger:"idle"}`。サーバーがまだなら `not_due`＋`due_at` → その30秒後に置き直す。呼ぶかは mode-core の `completeGroup`（＝ブレイン ON）
    ③ **売上サポの詳細を開いた時**（`GET /api/property-pickups?view=detail&pcid=`）: 10分を過ぎていればその場でまとめ ID を付け（数百ms）、読み取り・順位は waitUntil
  - 止まった時: まとめ ID を付けた後に関数が切れたまとめは `status=running` のまま → Cron が15分過ぎた running を条件付き UPDATE で `retry` に取り、1回だけやり直す（保存済みの分析は読まない）
  - 対象はブレイン ON の回＝ property_pickups の全行（🧠×スタッフ・🧠×通常・🧠×AIX・一括検索）。行にモードの印が無く、一括検索もお客様→サイトの順に回す（`_runBatch` の二重ループ）ので同じお客様のサイトは数分おきに続いて届く＝10分で1つに寄る
- 変更: `app/lib/pickup-best.ts`・`pickup-complete.ts`・`pickup-complete-server.ts`・`app/api/property-pickups/route.ts`・`complete/route.ts`・`app/api/cron/pickup-auto-complete/route.ts`（新）・`vercel.json`・`app/components/PickupReview.tsx`・`chrome-extension/background.js`・`mode-core.js`（コメント）・`manifest.json`（2.5.23）
- テスト: `app/lib/__tests__/pickup-auto-complete.test.ts`（43・👑 の決まり・10分の境目・冪等）・既存の pickup-best（15）・pickup-complete（33）・tests/chrome-extension 全部通過
- **YUMA**（`scripts/yuma-pickup-auto-complete-test.ts --run / --cleanup`）: A（WIC・対面キッチン・会話 YUMA）と B（条件欄だけ・会話なし）にリアプロ6件（14分前）＋itandi 7件（6分前）→ 6分の時点は Cron 0件・拡張 idle は not_due（due_at 付き）・詳細を開いても0件 → itandi を10分1秒前にずらす → A は Cron で13件（自動の読み取り13件・DeepSeek 24回・Claude 0）・B は詳細を開いた時に13件（643ms）→ 👑: A は画像の点の一番（67点・判定65点の保留）＝判定の点なら別の物件（105点）、B は判定の点の一番（105点・通す）。どちらも画面の 👑＝まとめの best_id＝順位1番 → もう一度 Cron は0件・後から鳴った alarm は already。片付け済み
  - 1回目は B にも YUMA の会話を付けたら、会話の「バストイレ別・収納」で B も画像が要る人になった（自動の読み取りは会話の希望も見る）→ B の行は会話なしでやり直した
- **竹内さんが確かめること（デプロイと拡張の再読み込みの後）**: 🧠 ON・スタッフで、同じお客様にリアプロ → itandi を送り、何も押さずに10〜12分待つ → 売上サポでそのお客様が「まとめた N回分」の1つの吹き出し・👑 の見出しが「画像で分析の点」（WIC 等の希望がある人）か「判定の点」（無い人）
- **反証レビュー（2026-09-25・サーバー側だけ・拡張は変えていない）**:
  - 👑 の決まりが画面とまとめで割れうる所を直した: まとめ（`loadBestBasis`）は「まとめの行だけ」の保存した希望を見ていて、画面の詳細 API は「お客様の新しい順 300行」の希望を見ていた → まとめ側も同じ 300行から取る（`image_analysis->wants` だけ読む）
  - 画面が best_id を使う条件: 分析し直しの判定を文字の比べ方から `Date.parse` に／`basis_rule` の無い前の版のまとめは best_id を使わず並べ直す
  - `/api/property-pickups`（詳細を開いた時の自動まとめ）に `maxDuration = 300`（waitUntil の読み取りが途中で切れて running のまま残らないように）
  - 本番の今の状態（dry）: Cron が最初に拾うのは 3人・34件（24時間以内のまとめ前の行）。最初の1回で自動の読み取りが走る
  - `chrome-extension/.tmp.driveupload/`（Google ドライブの同期の一時フォルダ・「.」始まり）は別の物。拡張の読み込みは妨げないが、コミットには入れない

## 2026-09-25 案B（書いた条件だけ重く・全部合う・AD 1未満）／一番オススメ＝👑 に1つ／カードに項目ごとの点（サーバー・画面だけ・拡張は変えていない）
- **竹内さん決定の案B**（`scripts/audit-fit-balance.ts` の PLAN_B）を `app/lib/property-brain.ts` に入れた。点は今まで通り「50＋札の点の合計」・上限200・外す候補／保留の決まりは不変
  - 書いた条件だけ重い札（`writtenWeightCodes`・純関数）: 築浅の自由文 `AGE_W5/10/15` +12/+8/+3・`AGE_W_OLD` −3（BUILDING_AGE_TEXT_OK は 0点の○×の札に）／築年の列の人 `AGE_COL_W5/10`（BUILDING_AGE_OK +5 に上乗せで 12/8）／書いていない人 `AGE_N5/10` +3/+1
  - 駅近を書いた人 `WALK_NEAR_W5/7` +5/+2（徒歩の列が空なら `WALK_TEXT_OK/OVER/FAR` +10/−3/−8・保留にしない）／書いていない人 `WALK_NEAR_N` +2
  - 家賃を低くしたい人 `RENT_CHEAP_W80/90/95` +8/+5/+2／強さ `_MUST`（×1.3）・`_SOFT`（×0.6）は札ごとに丸めた点
  - 敷礼0: 書いた +20（ZERO_ZERO_MATCH）・推した +14（**ZERO_ZERO_INFERRED** 新）・書いていない +8／設備 ○: 必須 `EQUIP_<KEY>_MUST_OK` +5・普通 +3・できれば `_SOFT_OK` +2（合計 +15 を越える ○ は `_OK_MAX` 0点＝案の端数足しはしない）
  - AD: なし −10（旧 −5）・1ヶ月未満 `AD_UNDER_1M` −8（利益が出ない保留の時は重ねない）・不明 0・1ヶ月 +15・1.5ヶ月 +17・2ヶ月以上 +20
  - 全部合う `FIT_ALL` +15・1つだけ外れ `FIT_ONE_MISS` +5（条件2つなら半分 `_HALF` +8/+3）: `summarizeFit`／`settleFitBonus` を judgeProperty・applyImageFacts・applyEquipmentMatch の3か所で通す。読めない・要確認・推した敷礼0は数えない／幅の内側は外れにしない／保留・外す候補には付けない
  - 学習（scoring-learning `isFrozenCode`）: `FIT_*` は凍結（他の札から決まる上乗せ・二重に学ぶため）。`AD_*`（AD_UNDER_1M 含む）は今まで通り凍結。書いた条件の重みの札は学ぶ
  - 全お客様 303人の条件欄で読み取りを目で確認: 駅近 11人（できれば 2）・家賃を低く 8人・築浅 23人（できれば 3）・必須 0。読み違い2件を直した: 「姫路駅近」（駅名＋近く）は駅近にしない／「初期費用・家賃はできるだけ安いほうが良い」を「初期」で落としていた → 「初期」は家賃の語と安さの語の間にある時だけ除く（`isRentCheapClause`）
  - テスト: `app/lib/__tests__/fit-balance.test.ts`（例の25問が全部合格・点も audit の案B と一致＋judgeProperty を通した確かめ 118件）
- **一番オススメ＝👑 に1つ**（野口さんの回: 162点に🌟★・164点に🌟）: 並び `compareForReview` は点 → 同点だけ🌟★/🌟 → 順位。画面のカードの「👑 一番オススメ」は `pickup-best.roundBestId`（全体の 👑 がその回にあればそれ・無ければ pickCustomerBest の同じ決まり）。DeepSeek の印は「🌟 候補」として小さく残す。一覧の「🧠 N件・👑名前」は完了のまとめの best_id → 無ければ判定の点の1位
  - `property_pickups.recommended` は DeepSeek の印のまま（書き換えない）。LINE グループの文の🌟も送信の時点の DeepSeek の順のまま（点はその後の waitUntil で付く・スタッフ向けの文）。理由は merge-pdfs の buildLineMessage・recordPickupBatch のコメント
- **カードの項目ごとの点**（`pickup-card-view.buildFitCells`）: 書いた条件の項目（★の茶色の見出し）→ 全部合う → AD（必ず）→ 書いていない条件 → 事実 → 点数。項目ごとに点（+20）と「初期費用を抑えたい・一致」、合う緑・合わない赤・要確認灰・幅の中は薄い緑。パソコンは6列
  - YUMA に野口さんの回の資料の行を写して 390px・1280px で撮って確認（横スクロールなし・項目の点の合計＋50＝184）→ 行は消した
- **野口さんの回（本番 id 358・359・369・370）に案B を当てた結果**（読むだけ・DB の点は古いまま）: アリビオ夕陽丘 162→**184**（👑）／アクアプレイス上本町（🌟★）162→177／CITY SPIRE難波WEST 163→160／ルクレ難波（🌟）164→156 ＝ 案Bの試算と一致（保存の札の付け直しと判定のやり直しの両方）
- 保存済みの行の点は付け直していない（新しい回から新しい点）。付け直しが要るなら竹内さんの判断
- **反証レビュー（同日）で直した3点**: ①保存が前の配点の行（野口さんの回など）は項目の点の合計＋50（184）と合計（162）が黙って食い違っていた → 点数の項目に「今の配点では 184点」（`pickup-card-view.scoreGapNote`・上限200／必須の×の上限20で丸めた時は素点も出す）②全体の 👑 が別の回にある時、各回の一番まで「👑 一番オススメ」と出て 👑 が2つに割れた → その回は「この回で一番（全体の👑は別の回）」（色を弱める・金枠は全体の 👑 だけ）③画像で分析の吹き出しだけ DeepSeek の印を「🌟★ 一番オススメ」と出していた → カードと同じ「🌟 候補」
  - 残り（直していない）: 一覧の「🧠 N件・👑名前」は、まとめていない回だと判定の点の1位（画像で分析が要るお客様でも画像の点を見ない）＝詳細の 👑 と違う名前になりうる。一覧で画像の読み取りを全件読むと重いので保留

## 2026-09-25 案B の YUMA テスト（本番と同じ流れ・DeepSeek だけ）と直した2点（サーバー・画面だけ・拡張は変えていない）
- `scripts/yuma-fit-balance-test.ts`（--run／--report／--cleanup）: 条件の違うテスト用のお客様8人（築浅・駅近・家賃を低く×2・初期費用を抑えたい・必須の設備・築浅必須＋駅近できれば・条件なし）に本番の物件資料（property_pickups 34〜67・358/359/369/370 を借りる）を当て、
  enrichSummariesFromPdf → buildRankMaterials → loadRankConditions → 🌟（DeepSeek）→ recordPickupBatch（判定・自動の読み取り・条件の要約）→ claimCompleteGroup＋finishCompleteGroup（まとめ・best_id）に通す。表は詳細 API と同じ純関数（customerImageNeed → bestBasisFor → pickCustomerBest（best_id を preferId）→ roundBestId → sortForReview → buildPickupCardView）
  - 機械の確かめ（全員 問題なし）: カードの項目の点の和＋50＝合計点（108行すべて）／並びが点の順／👑＝決め方の点の1位／全部合う物件は同じ AD の段で外れのある物件より上／書いた条件の札が同じ物件どうしは AD の高い方が上／AD なし・1ヶ月未満は保留で下
  - 注意: 会話に YUMA を結び付けると、YUMA の会話の「バストイレ別・収納」を拾って全員が「画像で分析 推奨」＝画像の点で 👑 になる（設計どおりの経路）。判定の点で 👑 を決めるお客様は noConv（会話なし）で回す
- **直した①カードの一言**: 必須の設備が × ／読めない時、札（`EQUIP_X_NG`／`_UNLISTED`）に強さが無く「宅配ボックス － +0（希望・要確認）」と出ていた → 保存した照合（`equipment.match[].strong`）から「必須・要確認」「必須・外れ」（`pickup-card-view.wantWordOf` の strongEquip）。できれば の × ／読めないは照合に印が無いので「希望」のまま
- **直した②条件の要約**（`condition-summary.buildConditionSummary`・🌟 に渡る条件と売上サポの「条件の要約」）: 点の計算と同じ読み取り（`profile.written`）で出す。旧は自由文の築浅をいつも「できれば」（「築浅は必須です」が「築年 できれば 築浅」）、駅近・家賃を低くは要約に無かった → 築年は強さどおり（必須は［必須］・普通は本命・できればは できれば）／「徒歩 駅近（徒歩N分以内）」／「家賃 …・できるだけ安く」。駅近の節は DeepSeek に回さず（COVERED_ELSEWHERE_RE）、保存済みの AI の「立地 駅近」は重ねない（`dropAiCoveredByRule`）。全311人で変わるのは39人（駅近 7・家賃を低く 10・築年の自由文 25）を目で確認
- **直していない（竹内さんの判断待ち）**: 画像で分析が要るお客様は 👑 を画像の点で決めるので、画像の点が全部100で並ぶと「合う」の数 → 判定の点の順になり、👑 の判定の点が2番目より低いことがある（お客様E: 👑 125点・2番目 135点＝浴室乾燥機が資料で ○ か要確認かの差／お客様F: 👑 96点・2番目 98点＝収納が画像で読めたかの差）。決まり（9/24「同点は合う数の多い方」）どおり。画面の 👑 の吹き出しは「画像の点 100点」と出るので、同点の理由は見えない
- 費用: テストの呼び出し 161回・全部 deepseek-flash（env=local）・約 $0.35（ほぼ資料の画像の読み取り property_image_detail の出力）
