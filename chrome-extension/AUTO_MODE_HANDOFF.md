# 自動モードの引き継ぎ書（Claude Code → Cursor）

2026-11-10 物件検索の作業員C が作成（コードを読み、本番の DB は読むだけ・何も書き換えていない）。
竹内さんの方針（11/10）: 拡張に3つのモード「通常モード／スタッフモード（今の人が押す案内）／自動モード（もともとの自動検索）」を並べ、自動モードを Cursor 側で完成させる。

---

## 0. 竹内さんの自動の決まり（全部守る）
| 決まり | 出どころ | 今のコードでの場所 |
|---|---|---|
| 1台の PC で回す | 11/10 竹内さん | 拾う PC の指定は `payload.target_install`（`app/lib/automation-sources.ts` notForThisInstall・`app/api/automation/pending/route.ts` 118〜120行）。**全体を1台に絞る口は無い** |
| お客様1人ずつ、リアプロ → ITANDI を終えてから次へ | 09/30 | `chrome-extension/auto-run.js` orderSites（278行〜）・planSites（225行）・background.js v2.5.42 |
| 開始は毎日ランダム（10:15〜11:15・16:15〜17:15） | 09/27 | cron は 10:00/16:00 JST に積むだけ（`vercel.json` `0 1 * * *`・`0 7 * * *`）・`payload.not_before` を窓の中で日ごとに（`app/lib/auto-search-schedule.ts` autoStartAtMs / notBeforeSchedule）・pending が not_before より前は渡さない |
| ページ上限 5 | 09/30 | `auto-run.js` 204行 `DEFAULT_MAX_PAGES = 5`・サーバーも 5 |
| 人の速さで待つ | 09/27 | `chrome-extension/human-wait.js`（humanDelay・settleDelay・pollDelay）・`auto-run.js` siteGapMs（251行・8〜28秒、時々40〜95秒）・customerGapMs（261行・15〜60秒、時々90〜200秒）・nextCommandGapMs（273行） |
| 送付済みは選ばず DL せず再送しない | 09/29〜30 | `chrome-extension/sent-skip.js`（建物名＋号室の完全一致・迷ったら飛ばさない）＋サーバー merge-pdfs の除外＋見張り（sent_selected） |
| まず YUMA と数人で試し、`search_audits` で確かめてから広げる | 11/10 | **お客様を絞る口は無い**（下の 5） |
| 大量の自動の試し（何百回）をしない | 09/27 | 人が1回ずつ押した形で、点検の記録（search_audits・操作ごとの時刻）を読む |
| 状態での分け方（新規＝未送付→AD 順・更新日14／送った後→更新順・前回以降だけ／要対応は毎日・それ以外の止まった人は週2） | 09/30 | `app/lib/auto-search-plan.ts`（戻すのは `AUTO_SEARCH_PLAN=legacy`） |

YUMA（テスト用の会話）: `dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7`（竹内さん本人）。

---

## 1. 今の版
- `chrome-extension/manifest.json` は **2.5.91**（index に入っているが未コミット・HEAD は 2.5.88）。2.5.89〜91 の中身: 同じ名前のお客様カードにアカウントの札（popup.js）／検索中はミニボタンで起動・開いた時に白くなるのを直す（underbar.js・styles.css）。**memory/dept_search_tool.md には 2.5.89〜91 の記録がまだ無い**（最新の記録は v2.5.88）。
- 本番の PC（extension_devices・11/10 10:58 時点）: 直近は 2.5.91 が4台（brain_normal×2・normal・brain_staff）。**古い版が残っている**: 2.5.88（11/04 まで2台）・**2.5.51（8a13886e・brain_normal・11/04 17:09 まで）**・2.5.48（74a7a6fa・**brain_aix**・10/01 まで）。
- 直近の拡張のコミット（`git log -- chrome-extension`）: v2.5.88 AIX【物件を探す】→📌・v2.5.87 一覧の重さ・v2.5.86 会話から物件検索・v2.5.80〜85 案内の駅・誰の検索か（search-stamp）・**v2.5.77 光って選択するモードだけ（GUIDE_ONLY）**・v2.5.69 一時停止中は trigger 409・pending が待ちを取り消す。

## 2. 自動の便の流れ（ファイル:行）
```
① 積む（サーバー）
   cron  app/api/cron/auto-property-search/route.ts  … 10:00/16:00 JST。対象は auto-search-schedule.ts（MAX_TARGETS_PER_RUN=60・64行／sites=realnetpro,itandi・275行）
         ・auto-search-plan.ts。insert は 175行（まとめ）・206行（1人1命令）。?dry_run=1 で積まずに誰を・何時からを返す。?limit= あり
   AIX   app/lib/aix-action-items.ts 197〜249行 enqueueAixPropertySearch … 物件ピックアップ・オススメ・物件を探す の AIX で source="aix" を1人1件
   広げて app/lib/search-widen-chain-server.ts 106行 … ピンポイントで足りない時 source="web_brain"・is_wide・payload.chain
   見張り app/lib/screen-watch-server.ts 804行／手の一括 app/api/automation/trigger/route.ts 110行
② 受け取る口（サーバー） app/api/automation/pending/route.ts
   29〜44行 paused なら pending を全部 cancelled にして command:null
   46〜58行 running のまま30分 → pending に戻す
   72〜108行 aix/auto_schedule・web_brain は拾い手が3時間いなければ error で閉じる（not_before から数える）
   110〜125行 ?aix=1 / ?brain=1 / ?rp=0 で出どころを絞り、pickClaimable で1件 claim（版と PC を行に残す）
③ 拡張（background.js）
   3700〜3760行 _pollAndRunBatch（30秒おき）: スタッフなら取りに行かない → mode-core の effectiveBehavior で claimCommands/claimAix/claimBrainCommands
                → 前のお客様からの間（batchNextNotBefore）→ /api/automation/pending を fetch
   3776行 auto_schedule は runAutoSchedule=false なら見送り
   3856〜3862行 _runBatchSearch: GUIDE_ONLY なら stop_all 以外は cancelled で返す（二重の歯止め）
   batch-guard.js（タブの確かめ・地域が空なら検索しない・失敗の知らせ）→ 各サイトの自動入力（page-script.js・itandi-page-script.js）
   → bulk-dl.js / itandi-bulk-dl.js（並べ替え・ページ上限・sent-skip で送付済みを選ばない・auto-run.js forCustomer で便の指定を読む）
④ 送る（サーバー） app/api/merge-pdfs/route.ts → 売上番長グループ・property_pickups（ブレインなら判定・記録）→ 足りなければ ① の広げて
```

## 3. 止めている所（2重）
| 止め | 場所 | 効き方 |
|---|---|---|
| サーバーの一時停止 `automation_settings.paused=true`（id=1・10/01 から・note「いっかい今はとめておく」） | pending 29〜44行／cron 50〜55行（積まない）／trigger 131〜137行（409） | **aix-action-items・widen-chain・screen-watch は paused を見ずに積む**（だから 16件たまる）。pending を誰かが呼ぶと全部 cancelled |
| 拡張の `GUIDE_ONLY = true`（**コードに固定**・v2.5.77） | `chrome-extension/mode-core.js` 210〜243行（effectiveState・effectiveBehavior・guideOnlyMigration）／background.js 356〜368行（起動・更新で aixMode=false・guideMode=true に書き直す）・1673行（手の一括検索）・2352行（Realtime の scrape_command）・3725行・3858行／popup.js 4600・5617・6108行／bulk-dl.js 243〜246行・itandi-bulk-dl.js 46〜49行（`_GUIDE_ONLY = true`） | 2.5.77 以上の拡張は **pending を取りに行かない**・自動送信・自動便・AIX連動・web_brain を全部 false |

→ paused を外すだけでは 2.5.77 以上の PC は何も動かない。自動モードを作るには GUIDE_ONLY を「モードで決まる」形に変える必要がある。

## 4. モードの切り替えの場所
- モードの表: `mode-core.js` 27行 `MODES = ["normal","staff","aix"]`・39〜48行（storage の staffMode/aixMode との対応）・66〜100行 `behavior(mode, brain)`（claimCommands・claimAix・autoSend・excludeSent・runAutoSchedule・claimBrainCommands 等）。ブレイン（brainMode）はモードと別の切り替え。
- 書き込みは popup.js の2か所だけ: `_applyMode`（6104行〜・今は 6108行で "aix" を "normal" に落とす）／`_applyBrain`（直後）。6040行に「モードとブレインは別々に書く」の注意。
- 表示: mode-core.js 113行（バッジ「AIX」「脳」）・125〜139行（説明の文・一時停止中の文 PAUSED_TEXT）。
- 「案内モード」（guideMode）は別の値で、今は常に ON（guideOnlyMigration）。
- 竹内さんの3モードとの対応の案: 通常＝normal／スタッフ＝staff（人が押す・光らせる）／自動＝aix（＝もともとの AIX連動・自動便）。※今の「スタッフモード」は「スタッフが選んだ物を減らさない（sent-skip・merge-pdfs の除外をしない）」意味も持つ（behavior の excludeSent・sent-skip.js）。案内（光らせる）は今は全モード共通。名前の付け替えで意味が混ざらないよう注意。

## 5. お客様・PC を絞る口
| 口 | 有無 |
|---|---|
| お客様を絞る（YUMA だけ・数人だけ） | **無い**。cron は全員から状態で選ぶ・AIX は AIX を出したお客様・広げては続き。`?limit=` は数だけ（Vercel の cron の path は固定） |
| 1台に絞る | 命令ごとの `payload.target_install` だけ（cron・AIX は付けない）。拡張側でも「この PC だけ自動」の値は無い（モードは PC ごとなので、自動モードを1台だけで選べば実質1台） |
| 古い版を拾わせない | **無い**（pending は x-ext-version を記録するだけ） |
→ 作る時は既定 off で: 例 `automation_settings` に許可するお客様の列／拾ってよい最小の版（2.5.77 未満の PC は GUIDE_ONLY を持たず昔の自動で動く）。新しい列は `app/api/migrate-schema/route.ts` も同時に・DDL は竹内さんの OK の後（Claude Code 側が作る）。

## 6. たまっている指示 16件（11/10 10:58 の読み取り・status=pending）
| 出どころ | 件数 | 中身 | 作られた日時（JST） |
|---|---|---|---|
| aix（`aix_action=property_send`・1人1件・sites=realnetpro+itandi・not_before なし・is_wide=false） | 14 | AIX【物件ピックアップ】を出したお客様の検索（aix-action-items） | 11/04 19:18 〜 11/10 10:47（11/04×2・11/05×4・11/06・11/07×2・11/08×3・11/09・11/10） |
| web_brain（広げての続き・is_wide=true・sort=ad・max_pages=5・payload.chain） | 2 | 11/08 のピンポイントの後の広げて（リアプロ1・ITANDI 1） | 11/08 15:19・15:32 |
- **YUMA は16件に入っていない**。全部本物のお客様（お客様の名前はここに書かない・DB の id で見る）。
- 11/04 16:37 までは消えていた（cancelled の aix 138件）＝ 2.5.51 の古い PC（8a13886e）が pending を呼び、paused なので全部取り消していた。その PC が 11/04 17:09 以降来ていないので、11/04 19:18 からたまっている。
- **戻した時に流れる恐れ**:
  1. paused=false にして自動モードの PC が拾うと、まず 3時間を過ぎた aix・web_brain は error で閉じる（pending 72〜108行・not_before が無いので作られた時刻から）。**3時間以内の物（例 11/10 10:47 の1件）はそのまま本物のお客様で検索して売上番長グループに送る**。
  2. **paused=false のまま古い版の PC（2.5.48 brain_aix・2.5.51 brain_normal）が起動すると、GUIDE_ONLY が無いので昔の自動の動き（自動入力・自動送信）で拾う**。
  3. paused=true のままでも、古い PC が起動すれば 16件は全部 cancelled になる（勝手に消える事がある）。
  4. 自動モードを試す前に、16件をどうするか（消す／残す）を竹内さん・統括役に決めてもらう。**勝手に消さない**。

## 7. 確かめる物（試す時）
- `search_audits`（1回の検索＝1行・site・trigger・command_id・steps＝操作ごとの時刻・result・ext_version・checks・watch）で: 開始時刻が窓の中か／お客様ごとにリアプロ→ITANDI の順か／ページ数 ≤5（cut_by_pages）／間の時間がばらついているか／送付済みの選択0（sent_selected）。
- `automation_commands` の picked_ext_version・picked_install_id（どの版・どの PC が拾ったか）。
- 送った物は property_pickups・sent_properties（再送0）。
- 営業時間（JST 9〜22時）は DB の全件読みをしない。サイトへの連続アクセス・繰り返し検索をしない。

## 8. 関連
- 記録: `memory/dept_search_tool.md`（v2.5.42 お客様ごと・v2.5.43 古い行で止める・v2.5.44 状態で分ける・v2.5.69 一時停止・v2.5.77 GUIDE_ONLY）・`chrome-extension/DB_STRUCTURE.md`
- 並んで作業中（読むだけにする所）: 作業員A＝一括検索の ITANDI の更新日（cron と background.js・DB_STRUCTURE.md の「混ざっている所 2」）、作業員B＝station-map・token-resolve
- 規約の背景（10/01 に止めた理由）: 拡張は欄に直接書き込み・一覧の吸い上げ・資料のまとめて取得をしていた／「規約上問題の方が多そう」。自動モードでも人の速さ・少ない回数を崩さない。

## 9. Cursor に頼む所 — ITANDI の更新日を payload の itandi_update_days で読む（作業員A・2026-11-10・DB_STRUCTURE.md の混ざっている所 2）

### サーバー側（済み・main に入った）
- 一括検索・自動便の命令（automation_commands.payload）に **`itandi_update_days`**（ITANDI の更新日）が入る。
  - 中身: ITANDI の手の指定（property_customers.itandi_update_days）→ 無ければ自動（前回物件を出した日から・リアプロと同じ）。**リアプロの手の指定 rp_update_days は使わない**（popup の site-update-days.js manualFor と同じ線）。
  - 計画（前回の検索から空いた時間で広げる）がある命令は、`update_days_plan.by_customer[id].itandi_days` にも ITANDI の計画の値が入る（`days` はリアプロのまま）。広げ方・前回の検索・止める線はリアプロと同じ。
  - 出す所: `app/lib/web-brain-search.ts` buildWebBrainCommands（AIXツールの一括・リアプロだけの命令にも載せる＝後から itandi を足す fold のため）／`app/api/automation/trigger/route.ts`（計画の後）／`app/api/cron/auto-property-search/route.ts`（計画のある人だけ・計画が作れない時は載せない）。純関数は `app/lib/rp-update-days.ts` effectiveItandiUpdateDays・`app/lib/search-update-days.ts` itandiPlanFrom・planPayload（テスト `app/lib/__tests__/itandi-update-days-payload.test.ts`）。
  - **キーが無い命令（古い・手の一括の今の形）は今まで通り rp_update_days に落とす**。

### 拡張側（未・Cursor の自動モードで入れる）— 今のコードで ITANDI がリアプロの値を使っている所（origin/main 65c1c120 の行）
1. `chrome-extension/auto-run.js` 129〜148 `payloadForCustomer`: `update_days_plan.by_customer[id].days` を `rp_update_days`・`_update_days` に写すだけ。`itandi_days` を読まない。
2. `chrome-extension/background.js` 4330 `_batchAutofill(customer, site, …, opts)` → 4367 `_buildBatchConditions(customer, isWide, opts)`（4641〜・4643 `_rpDays = opts.rp_update_days`）と 4374 `_autoRunMsg = optsFromPayload(opts)`: site を見ずに `opts.rp_update_days` を使う。ITANDI の直接入力（cond.rp_update_days）にも、popup の ITANDI の回の autoRun（4533）にもリアプロの値が行く。
3. `chrome-extension/background.js` 1712〜1714（手の一括検索）: `effectiveRpUpdateDays(_bc)`（リアプロの手の指定）を ITANDI の回にも渡す。
4. 読む側（変えなくてよい・cond.rp_update_days を読む）: `chrome-extension/itandi-page-script.js` 165・`chrome-extension/itandi-guide-plan.js` 277・`chrome-extension/itandi-update-days.js`。

### 最小の直しの案（作業員Aが書いて、コミットしなかった差分）
- `_batchAutofill` の最初で `if (site === "itandi" && self.AxlxAutoRun && self.AxlxAutoRun.optsForSite) opts = self.AxlxAutoRun.optsForSite(opts, site);`（下の関数・auto-run.js の返す物に `optsForSite` を足す）。手の一括（1712〜1714）は `{ rp_update_days: _bulkRpDays, itandi_update_days: effectiveRpUpdateDays(Object.assign({}, _bc, { rp_update_days: _bc.itandi_update_days }), Date.now()) }` を渡す。
- 版は manifest の決まりどおり上げる（今 2.5.91 → 次の版）・dept_search_tool.md に記録。
- 点検（`app/lib/search-audit-check.ts` 401 expectedUpdateDays）は今は rp の値で決まりを出す。拡張が ITANDI の値を使い始めたら、ITANDI の回は `itandi_days`／`itandi_update_days` で見るようにサーバー側で直す（Claude Code 側・拡張の版が入った後に）。

```diff
--- a/chrome-extension/auto-run.js
+++ b/chrome-extension/auto-run.js
@@ payloadForCustomer の return out; の前
+    // 2026-11-10 ITANDI の計画（サーバーの itandi_days）。今の時刻で数え直すのはリアプロと同じ。
+    //   itandi_days の無い計画（古いサーバー）は上の itandi_update_days を消す（計画の前の値＝広げていない・ITANDI だけ狭くならないように）
+    if ("itandi_days" in e) {
+      var ni = e.itandi_days == null ? null : Number(e.itandi_days);
+      var wi = widenForNow(ni != null && isFinite(ni) && ni > 0 ? Math.floor(ni) : null, e.last_search_at || null, nowMs != null ? nowMs : Date.now());
+      out.itandi_update_days = wi.days;
+      out._update_days_itandi = { days: wi.days, widened: wi.widened || (wi.days !== out._update_days.days), gap_hours: out._update_days.gap_hours };
+    } else {
+      delete out.itandi_update_days;
+      delete out._update_days_itandi;
+    }
     return out;
   }
+
+  // ITANDI の検索の時だけ、payload の itandi_update_days（と _update_days_itandi）を rp_update_days（と _update_days）の位置に写した写しを返す。
+  //   リアプロ・レインズ、itandi_update_days の無い payload は元のまま（今まで通りリアプロの値に落とす）
+  function optsForSite(payload, site) {
+    if (!payload || typeof payload !== "object" || String(site || "") !== "itandi") return payload;
+    if (!Object.prototype.hasOwnProperty.call(payload, "itandi_update_days")) return payload;
+    var out = Object.assign({}, payload);
+    var n = payload.itandi_update_days == null ? null : Number(payload.itandi_update_days);
+    out.rp_update_days = n != null && isFinite(n) && n > 0 ? Math.floor(n) : null;
+    if (payload._update_days_itandi && typeof payload._update_days_itandi === "object") out._update_days = payload._update_days_itandi;
+    out._site_update_days = "itandi";
+    return out;
+  }
```

---

## 9. サーバーでした事（2026-11-10 作業員C・竹内さんの答え「古い版をサーバーで断る＋16件は残す」）
拡張の中は変えていない（Cursor の担当）。関所は `app/lib/automation-pause-gate.ts` の1か所・テスト `app/lib/__tests__/automation-pause-gate.test.ts`（31件・配線の順も見る）。
| 何を | 場所 | 既定 | 戻す・変える |
|---|---|---|---|
| 拾いに来た拡張の版が最小の版より古い・版の見出し（x-ext-version）が無い時は指示を渡さない。指示は pending のまま（取り消さない・30分の戻しもしない）。返す JSON は `{ command: null, refused: "ext_version_too_old" \| "ext_version_missing", min_ext_version, ext_version, message }`・ログ tag `automation-pending:ext-refused` | `app/api/automation/pending/route.ts` の最初（止めの印より前） | on・最小の版 **2.5.77**（GUIDE_ONLY の入った版） | env `AUTOMATION_MIN_EXT_VERSION=2.6.0` 等で上げる・`off` で版を見ない |
| 止めの印（paused=true）の間に pending を呼ばれても**取り消さない**（`{ command: null, paused: true, cancelled_while_paused: 0 }`） | 同じ所 | on（残す） | `AUTOMATION_PAUSE_CANCEL_PENDING=on` で昔の動き（全部取り消す） |
| 止めの印の間は新しい指示を積まない（積もうとした物はログ tag `automation-paused-skip` に by・お客様の id の頭8字・sites だけ残す） | `app/lib/aix-action-items.ts`（AIX の物件ピックアップ等）・`app/lib/search-widen-chain-server.ts`（広げての続き・decision は skip/paused）・`app/lib/screen-watch-server.ts` reSearchTemp（見張りの再検索のボタン・「一時停止中です」を返す） | on | `AUTOMATION_PAUSE_BLOCK_ENQUEUE=off` で昔の動き（積む） |
- cron（auto-property-search）と trigger（手の一括・409）は前から止めの印を見ている（作業員A の持ち場なので触っていない）。
- たまっていた16件はそのまま（消していない）。止めの印を外した時の扱い（3時間を過ぎた物は pending が error で閉じる・3時間以内は流れる）は 6. のとおり。
- **Cursor に頼む事**: 自動モードの拡張は必ず `x-ext-version` を付けて pending を呼ぶ（今の background.js は付けている）。自動モードを入れた版を出したら、最小の版をその版に上げる（env）と、それより前の PC は拾えなくなる。
