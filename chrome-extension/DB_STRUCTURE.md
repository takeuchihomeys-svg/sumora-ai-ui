# 物件検索ツール（Chrome 拡張）の DB の構造 — リアプロ／ITANDI

2026-11-10 調べ（コードと `app/api/migrate-schema/route.ts` を読んだ結果。本番の DB には問い合わせていない）。Cursor と一緒に直す時の地図。直したらこのファイルも直す。

## 3つの層
1. **お客様の層**: `property_customers`（1人1行・条件の最新の値）。LINE 返信・見積書と共有。
2. **検索〜送付の層**: 表ごとに `site` の列でリアプロ／ITANDI／REINS を分ける。
3. **駅と路線の辞書の層**: サイトごとの表に分けず、1行の中で列を分ける（`station_map` の `realpro_lines` / `itandi_lines` / `reins_line`、`line_meta`）。駅名のサイトごとの表記の違いは DB に無く、拡張の中の別名表だけにある。

## 流れ
```
conversations / messages（LINE・共有）
  │ property_customer_id
  ▼
property_customers（お客様＋条件）── 変更の履歴 → property_condition_history
  │                                └ 会話の「🔍 物件検索」→ property_search_focus（24時間）
  ▼
automation_commands（検索の指示の列・sites[]・payload）← 全体の一時停止 automation_settings
  │ 拡張が /api/automation/pending で拾う（心拍 extension_devices）
  ▼
条件の解決: station_map / region_map / line_stations / line_meta / unknown_tokens / token_block
  ▼
search_audits（検索1回の点検・site）→ search_audit_causes・screen_watch_events・extension_snapshots
  ▼
property_candidate_pools（候補の一覧・site）＋ property_brain_judgments（1件ごとの判定・site）
  ▼
property_pickups（PDF 1件＝1行・site）→ 完了で property_pickup_completions（まとめ・sites）
  │ 足りなければ同じサイトで「広げて検索」を automation_commands に積む
  ▼
sent_properties（送った物件・site の列なし・LINE と共有）→ 重複の確認
```

## 表の一覧
| 表 | 役目 | 区分 | サイトの分け方 |
|---|---|---|---|
| property_customers | お客様と条件 | 両方＋共有 | 列: rp_update_days / itandi_update_days・town_names（リアプロの町字） |
| property_condition_history | 条件変更の履歴 | 共有 | なし |
| property_search_focus | 会話から物件検索の印 | 両方 | なし |
| automation_commands | 検索の指示の列 | 両方＋REINS | sites text[]（値は `realnetpro`/`itandi`/`reins`・拡張とのやり取りはこのまま）＋ **site_keys**（11/10・生成列・`realpro` に揃えた読む用） |
| automation_settings | 全体の一時停止 | 両方 | なし |
| station_map | 駅→区・各サイトの路線 | 列分け | realpro_lines / itandi_lines / reins_line |
| region_map | 地名→区・市 | 両方 | なし（区名は3サイト同じ） |
| line_stations | 路線ごとの駅の順番 | 実はリアプロの内部名だけ | なし |
| line_meta | 路線マスタ（3サイトの名前の対応） | 列分け | internal_name・realpro_route_id・itandi_names[]・reins_name |
| token_block / unknown_tokens | 誤学習の止め／解決できなかった語 | 両方 | なし |
| search_audits / search_audit_causes | 検索の点検／原因の集計 | 両方 | site（`realpro` に揃える） |
| screen_watch_events / extension_devices / extension_snapshots | 画面の見張り・PC の心拍・画面の記録 | 両方 | site / current_site（`realnetpro` が残る）＋ **current_site_key**（11/10・生成列・揃えた読む用） |
| property_candidate_pools | 候補の一覧 | 両方 | site（`realpro`/`itandi`/`reins`）＋ **search_run_id**（11/10・拡張が送るまで空） |
| property_brain_judgments | 1件ごとの判定 | **リアプロだけ**（ITANDI は判定を呼んでいない＝0件） | site |
| property_pickups / property_pickup_completions | ピックアップ／まとめ | 両方 | site / sites ＋ **search_run_id・search_command_id**（11/10・merge-pdfs が batch_owner から入れる） |
| sent_properties | 送った物件 | 共有 | **site**（11/10 足した・merge-pdfs の共有の行と AIX で送った行が入れる・LINE の画像の読み取り vision は NULL） |
| chrome_extension_feedback | 拡張からの声 | 両方 | site |

## リアプロ・ITANDI・REINS を混ぜない決まりと見張り（2026-11-26・必ず守る）
- **箱**: サイトの名前が付いたファイルは、そのサイトだけを扱う（`realpro-*.js`・`itandi-*.js`・`reins-*.js`・`app/lib`・`app/api` の同じ名前）。違う方の名前を使わない。
- **両方を扱う共有ファイル**は、どのサイトの値がどこで切り替わるか（`site` の値・サイトごとの列）を理由に書いて登録する。登録されていない新しい共有ファイルは止まる。
- **見張りの正本**: `tests/chrome-extension/site-split-rules.json`（名前の一覧・箱の決まり・登録の理由）と `tests/chrome-extension/site-split-guard.test.js`（`ext-test-all` が毎回回す）。`node tests/chrome-extension/site-split-guard.test.js --report` で今の一覧を出す。
- **新しい名前（地図・画面の名前）を足す時**: 先に `site-split-rules.json` の名前の一覧に入れる（どちらのサイトの物か）。両方の名前が1ファイルに入ったら、見張りが「登録してください」と止める。
- 注釈（`//`・`*` の行）は数えない。行の途中の注釈は残る。
- **サイトの呼び名は `app/lib/site-key.ts` だけで変える**（`siteKeyOf`＝realpro・realnetpro・リアプロ→realpro、itandi、reins・レインズ。`commandSiteKeyOf`＝拡張の呼び名 realnetpro）。他の所で `=== "realnetpro"` と比べない（見張り ④）。試験: `npx tsx app/lib/__tests__/site-key.test.ts`。
- **コミットの前に自動で回る**: `.githooks/pre-commit`（見張りの試験＋site-key の試験）。この PC では `git config core.hooksPath .githooks` を1回だけ設定済み（取り消しは `git config --unset core.hooksPath`）。TypeScript の型チェック（`npx tsc --noEmit`）は既存のエラーがあるので、フックには入れていない（CLAUDE.md の型チェックは別途）。
- 今の結果（2026-11-26）: 箱の違反 0・両方を扱う共有ファイル 6（登録済み）・サイト名の直接比べ 4（登録済み・理由付き）。（2026-11-27 に `app/lib/human-motion-sanitize.ts` を追加し共有ファイル 7 に更新・箱の違反 0 を維持）

## リアプロと ITANDI で混ざっている所（直す候補）
1. ~~**`site` の値が2通り**~~ → 11/10 DB で揃えた（migration `ext_db_site_runs_views_1110`）。本番の値は automation_commands.sites と extension_devices.current_site だけ `realnetpro`、他の11の表は realpro/itandi/reins で揃っていた。DB の関数 `ext_site_key()`（realnetpro・リアプロ→realpro）と、site の列がある10表の trigger `trg_site_norm`（入る時に揃える・拒まない）を足した。拡張との指示のやり取り（sites の `realnetpro`）は変えない。→ 2026-11-26 に直した: サーバーの揃える関数（search-audit-check・screen-watch-server・search-update-days-server・search-widen-chain・human-motion・extension-live-server・sheet-layout・search-condition-drift・search-update-days）を `app/lib/site-key.ts`（唯一の正本）へ集めた。サイトの名前を直接比べる残りは見張り（site-split-guard ④）で理由付きの4か所だけ。
2. ~~**一括検索・自動の便では ITANDI もリアプロの更新日を使う**~~ → 直っている（2026-11-26 に裏付けを確認）: 手の一括は `background.js` 6264〜（`_bulkItDays` に `itandi_update_days` を使う）・自動便は `auto-run.js` の `optsForSite`（207）／`optsForSiteRecord`（273）が ITANDI の回だけ `itandi_update_days` を `rp_update_days` の位置へ写す（読む側の itandi-page-script.js は `cond.rp_update_days` のまま＝写しの仕組み）。payload に `itandi_update_days` が無い古い命令は今まで通りリアプロの値に落ちる。
3. **`line_stations` はリアプロの内部名だけ**: ITANDI の駅の順番は持っていない。
4. **`station_map.itandi_lines` はリアプロの路線名から変換して作った物**。`reins_line` は最初の1本だけ。~~スタッフの手直し（station-map の POST）はリアプロの列しか直さない。~~ → 11/10 直した: POST はリアプロの路線が来たら `app/lib/station-line-maps.ts` の `deriveSiteLines` で ITANDI・REINS も作り直す（表に無い路線の列は前の値を残し warning で返す）。既存の行は 2026-11-26 の再計測で 778行中 337行が表と違う（ITANDI: 空を埋める 305・名前のずれ 20・表に無い 12＝触らない／REINS: 空を埋める 315・ずれ 3）。読む道具: `scripts/audit-station-map-site-lines.ts`。書く道具: `scripts/apply-station-map-site-lines.ts`（既定は dry-run・`--mode=fill` は空だけ・`--mode=fill-and-fix` はずれも直す・`--apply` には `--backup-dir` が要る・22時以降に書く）。**2026-11-26 22:19 に `--mode=fill` で書いた**（ITANDI 305・REINS 315 の空の列を埋めた＝317行・控え `C:\Users\Admin\Desktop\station-map-backup-2026-11-26\`）。書いた後の読み直し: ITANDI のずれ 20 行・REINS のずれ 3 行は今も残す（竹内さんの選択は「空を埋めるだけ」）。対応が無い 12 行は触らない。
5. **対応表の写しが5か所以上**: popup-maps.js（正本）・resolution-core.js・popup.js の中・seed-maps・token-resolve・DB（station_map・line_meta）。11/10: token-resolve の写しは `app/lib/station-line-maps.ts` に移し、正本とのずれをテストで見張る（他の写しはまだ）。2026-11-26: サイトの呼び名の変換は `app/lib/site-key.ts` に一本化（見張り ④ で直接比べを止める）。対応表の写し（popup-maps.js ほか）はまだ一本化していない。
6. ~~**token-resolve の AI への例が対応表と違う**（阪急神戸線の名前）。~~ → 11/10 直した（例を表から作る）。
7. **memory の記録とコードの食い違い**（REINS の阪急神戸線・宝塚線・京都線: memory は「〜本線」・コードと DB は「阪急神戸線」）。search_audits に reins の行が無く画面の表記が分からない → 竹内さんに確認中・決まるまで変えない。
8. ~~**sent_properties に site が無い**~~ → 11/10 列を足した。新しい行は merge-pdfs（source=line_group）と AIX で送った行（aix:property_send）に入る。古い行は pickup_id がある 507 行だけ、22時以降に pickups.site から埋め戻す。line_group の古い行は property_url も NULL なので埋めない。
9. **property_customers に古い列が並ぶ**（area/desired_area・max_rent/rent_max・layout/floor_plan）。

## 拡張の中だけにある物（DB に無い）
- 対応表（popup-maps.js・resolution-core.js に同じ物）: STATION_WARD_MAP・NEIGHBORHOOD_WARD_MAP・STATION_LINE_MAP・LINE_STATION_ORDER・WARD_CODE_MAP（リアプロ）・TOWN_CODE_MAP（リアプロ）・ITANDI_LINE_MAP_FILL・LINE_ROUTE_MAP（リアプロ）・LINE_ALIAS_MAP・REINS_LINE_MAP ほか
- サイトの画面用: リアプロ（page-script.js・realpro-guide-plan.js の ROUTE_LINE_MAP・STATION_NAME_ALIASES ほか）／ITANDI（itandi-page-script.js・itandi-guide-plan.js の ITANDI_STATION_ALIAS_MAP・option_id ほか）／REINS（MADORI_LABELS）
- 通勤: transit_graph.js・osaka-transit.js・commute-*.js
- chrome.storage / localStorage: モード・今のお客様・一括検索の状態・送付の状態・誤送の防止（axlx_search_for）・案内（リアプロ／ITANDI で別のキー）・一時調整（tempAdj_<id>・DB に残らない）
- chrome.storage.session `axlx_auto_next_page`（2.8.104）: 自動が「次」を押す前に置く続きの印（頁・回数・累計・お客さん・時刻）。`td.pager` が読み直した後の `start()` Case E が読んで消す。2分で無効
- chrome.storage.session `axlx_fill_busy`（2.8.106 で中身を足した）: 条件の入力中の印。`{ at, customerId?, why? }`。background が一括で次のお客さんを始める直前に `why:"batch_customer_start"` で置き、同時に前の `axlx_pending_auto_send`・`axlx_auto_next_page` を消す。bulk-dl の Case C は「検索した印（pending.ts）より入力開始（busy.at）が新しい」「お客さんが違う」時は押さない（`customer-handoff.js` の `pendingFlagBlockReason`）
- 2026-11-27（2.8.313・DB の列・表・API は増やしていない）: 拡張の中だけの変更＝リセットで空と確かめた直後は客切替でも「前客の場所の全部外し（強制）」の旗を立てない（`_resetCleanSkipsForcePlace`・audit 段 `page:reset_clean_no_force_place`・決まり `reset_clean_no_force_place`）。手順書側は `learn-flow-steps.ts` の場面ごとの間（`gap_ms`）で 0.15 秒未満（`MIN_REAL_GAP_MS`）を数えない。`task_change_api_every` の旧い文（毎回 force）を 2.8.309 の決まりに合わせて直した。送る値・列は変わらない。
- 2026-11-27（2.8.312・`PLAYBOOK_BUILD_V = 19`・DB の列・表は増やしていない）:
  - **CDN 版付きキャッシュバイパス（`human-learn-profile`）**: `?touch=0` が `bundle_v`（`${generated_at}_${rules_v}_${build_v}`）を返し、拡張（`buildBundleFetchUrl`）は取得 URL に `&v=<bundle_v>` を付けて送信。本体 GET で `forceFresh` / `playbookRefreshed` または `?v=` と実束 `actualBundleV` が不一致の時は `Cache-Control: no-store, no-cache, must-revalidate` を返す。
  - **統括の自己矛盾同期（`syncSupervisorImproveLoop`）**: `shots.learned` 継承後に `自動モード完成度`（`measureAutoCompletion` で `evidence`/`today`/`agenda` 再算定）と `学習完成（期間・土台・つながり・一連）` を実測へ同期。
  - **拡張内のサイト別学習キー完全隔離＆SW耐性**: `chrome.storage.local` の学習キー（`axlx_learn_*__realpro` / `axlx_learn_*__itandi`）へ独立保存し、`projectLearnStorageForSite` で他サイト共有フォールバックを遮断（`_headCheckAtBySite`・`content.js` / `itandi-content.js` / `pointer-ui.js` もサイト別化）。`search-audit.js` の `_auditPersistNow`（即時永続＋`adopt` 復元 `restored: true`）、`background.js` の `superseded_by_new_bulk`・90秒SWウォッチドッグ・`axlx-set-fill-customer` 4秒タイムアウト・`extVer !== ver` 旧タブ強制リロード、リアプロ（ゲート完了後リセット・`notifyDone` キュー掃除）・ITANDI（`_itEnsureLearnReflectedForFill`・`_itSerialType`・学習位置 `aim`）を実装し、`check-playbook-sync.ts` ⑦ の 9項目検査で継続監視。
- 2.8.206: 手順書反映の抜け防止。`attach`／`prepareBundleForWrite` が `generated_at` を上げる・`read_count=0`。light API が `playbook_rules_v` を返す。拡張が rules_v ずれで強制取込。土台 **F63**（DB=コード∧seen rv=コード∧read≥1）。列は増やしていない
- 2.8.205: 手順書穴の土台。決まり `continuous_customer_loop`（AUTO_RULES）を束へ attach（rv **e0b8837b**・39件）。`customer_think` 失敗時も stamp。checkRulesInCode が `background.js` も見る。weak-find の連続客は列 `ext_version`（`extension_version` は誤り）。列は増やしていない
- 2.8.204: 連続客細分化強化。`handoff_atom_send`／`handoff_atom_post_send`／`handoff_atom_ready`／流れ地図に `send_or_pdf`・`post_send_clear`。台帳12細原子＋`planHandoffStrengthen`。土台 **F61（DB計測）**・**F62（細分化）**。`scripts/handoff-loop-strengthen.ts`（列は増やしていない）
- 2026-11-27（2.8.319・PLAYBOOK_BUILD_V = 26・DB の列・表は増やしていない）: 手順書の一覧の手に「全部送付済み→次へ／次頁も全部送付済み→客完了／0件→客完了／客完了→リセットして次客へ」を足した。search_audits.steps に新しい印 dl:list_flow_announce（パネルで言った言葉）・dl:list_flow_wait_reason（物件取得が始まらない理由）・dl:zero_count0_finish（0件で終えた・今まで点検に残らなかった）が残る。送る値・API は変えていない。
- 2026-11-27（2.8.318・PLAYBOOK_BUILD_V = 25・DB の列・表は増やしていない）: 次客の条件を読み直せなかった（3回・または一覧に居ない）時は、古い条件で検索せず、そのお客さんを飛ばす。search_audits.steps の customer_api_reload の本文が「API読み直し失敗→このお客さんは飛ばす（古い条件では検索しない・…）」になった。知らせは AXLX_API_RELOAD_FAILED（検索できなかった扱い）。送る値・API は変えていない。customer_api_reload を見て、飛ばした客を数える。
- 2026-11-27（2.8.317・`PLAYBOOK_BUILD_V = 24`・DB の列・表は増やしていない）: リセット／検索／並べ替えの流れを簡素に。`search_audits.steps` の新しい段 `reset_settled`（リセットを押して30〜34秒待った＝空とみなす）・`customer_api_reload`（次の客の条件を API から毎回読み直した・最大3回）・`page:search_review_wait`（検索を押す前の見直し 9〜12秒）・`dl:sort_mouse_retry`（マウス移動の取り消しを1回だけやり直し）。`reset_before_fill` の本文に `見送り=この一括の最初の客はリセットしない`／`前客のリセットが済んでいる`。旧い段 `reset_shot`／`reset_not_empty`／`reset_count_same`／`lag_grace_after_reset` はもう出さない（過去の記録を読む時だけ）。送る値・API は変えていない。
- 2026-11-27（2.8.310・`PLAYBOOK_BUILD_V = 18`・DB の列・表は増やしていない）:
  - **単発自動のリセットリロード耐性**: `popup.js`（`underbar.js` 内 `iframe`）からリアプロ「リセット」後にタブが再読込されても自動入力が途切れないよう、リセット前に `axlx_pending_auto_send`・`axlx_score_data` を保存し、`axlx-reset-before-fill` の `autoFillAfter` を受けた `background.js` がリロード完了後に `axlx-set-fill-customer` + `axlx-realnetpro-autofill` を直接再送する。
  - **学習データの増分送信とサーバー側浄化（`human_motion` / `human_learn_profile`）**: `human-learn-record.js` はローカル累計と今回の保存窓増分（`_sessionPoints` / `_sessionAutoPoints`、`n <= 200`）を分離し、`U(uploadDelta)` で増分だけを送信。`human-learn-upload.js` と `app/api/human-motion/route.ts` でもサイト別許可欄名（`isAllowedMotionFieldName`）チェックと `point_fields[k].n` 上限（拡張 200 / サーバー 500）を強制し、`0.5,0.5` 爆発ポイント・ゴミ名（`input`/`iframe`/`id`/`-----`）・他サイト混入を遮断。`prepareBundleForWrite` が保存前に `sanitizeBundleForSite(bundle, site)` と `syncSupervisorSceneFlows(bundle, site)` を実行し、`PLAYBOOK_BUILD_V = 18` で手順書の押す位置・`印刷用PDF` 判定・統括同期を整えた。
- 2.8.302: 手を止める停止の長さは 4〜11秒（中央 6.5秒・毎回ちがう）。`page:fill_pause` / `page:fill_resume` の秒は小数2桁（例「6.42秒」）。手の動きの drift に `maxMs`（既定 6000・停止だけ 11000）。DB の列・表は増やしていない。過去の監査（2.8.300 以前）の停止の秒は、ばらつき無しの固定（2.8.300）か予定（2.8.299）なので、実際の長さとして読まない。
- 2.8.300: 手を止める停止の `page:fill_pause` の秒数は最大6秒（実際に止まる長さ＝手の動きの上限）。2.8.299 までの「8〜25秒」の記録は予定で、実際は約6秒だった（過去の監査を読む時の注意）。
- 2.8.299: 人の間（わざとの待ち）を見張りに分からせる（DB の列・表は増やしていない）。`search_audits.steps` の `page:fill_pause` の本文が「N秒（わざと止める・人の間＝止まりではない）」、`page:fill_resume` が「わざと止めた後に再開 予定N秒・実際M秒」に変わった。`page:fill_pause_force` は「予定を15秒超えた（本物の止まり）」。`silence_watch_tick` の `q=` の末尾に `/iw種類`（fill_pause／hesitate／gap／-）。ページの中だけの印 `window.__axlxIntentWait`（DB へは送らない）。
- 2.8.298: 0件の空回りと入力停止（DB の列・表は増やしていない）。`axlx-batch-customer-done` の `auto_pdf.why` に新しい値 `zero_rows_count0`（結果が 0棟0戸 と3回続けて読めた＝押さずに 0件で終えた・`propertyCount: 0`・`skipped: true`）。`search_audits.steps` に新しい段 `dl:zero_count0_finish`（`dl:` の印）・`dl:zero_count0_no_cid`・`page:fill_pause_force`（列の停止が pause＋15秒超えて次へ進めた）。沈黙の見張り `silence_watch_tick` の本文の末尾に `q=列の残り数/いま処理中の1件のラベル/pause=停止中か/hid=画面が隠れているか` を足した（段の形は同じ）。
- 2.8.297: 手順書の反映の連動（DB の列・表は増やしていない）。`human_learn_profile.bundle.playbook` に新しい項目 `rules_up_to`（この手順書を作ったコードの `AUTO_RULES_REVIEWED_UP_TO`・無い＝古い手順書）。`GET /api/human-learn-profile?touch=0`（軽い版確認）の応答に `playbook_rules_up_to`（DB の手順書の版）・`server_rules_up_to`／`server_rules_v`／`server_build_v`（いま動いている本番コードの版）を追加（返さない本番＝2.8.297 より前のコード）。chrome.storage.local `axlx_server_state`（`{behind, server_behind, playbook_behind, server_up_to, playbook_up_to, ext, at}`）。`search_audits.steps` に新しい段 `server_behind`（客ごと・本番コード古い／手順書古い）・`page:playbook_behind`（手順書と拡張の版ずれ・side=手順書が古い|拡張が古い）。段の形に任意項目 `n`（まとめた回数）・`to`（最後の時刻）を追加（待ち・間・見張りの同じ段をまとめた時だけ）。書く側（`prepareBundleForWrite`）は、いまある／履歴にある手順書がコードより新しければ作り直さず残す（結果に `playbook_kept_newer`・止める印 `PLAYBOOK_DOWNGRADE_GUARD=off`）。点検: `scripts/check-playbook-sync.ts`（読むだけ）
- 2.8.296: 条件を入れる前のリセット（DB の列・表は増やしていない）。`search_audits.steps` に新しい段 `reset_before_fill`（`すでに空→押さない`／`空でない（残=N …）→リセットを押す`／`リセットで空を確認 N秒`／`空にできず→…従来の外しへ（理由=…）`／`見送り=off|no_tab|前の入力の最中`）。一括の段 `bulk_phase` に `pre_fill_reset`（条件を入れる前にリセットを押す・上限260秒・次へ進める段ではない）。窓 `axlx_quiet` の `reset` を入力前にも張る（`quiet_off` の理由 `pre_fill_done`）。送る値・API は変えていない
- 2.8.295: 邪魔しない窓（DB の列・表は増やしていない）。chrome.storage.session `axlx_quiet`（`{kind: sort|reset|gap|refill, cid, since, until, owner, runId}`・`owner`＝裏の起動の印:一括の世代・上限 `until` で必ず切れる）。ページには `<html data-axlx-quiet="種類|上限">` で写す。`search_audits.steps` に新しい段 `quiet_on`／`quiet_off`／`quiet_defer`（窓の間に見送った相手と残り秒）／`quiet_inherit`（裏の起き直しで前の回のリセットの残りを待った）／`dl:quiet_on`・`dl:quiet_off`・`dl:quiet_defer`（ページ側）／`reset_clear_marks`（拡張のリセットの前に前客の続きの印を消した）／`dl:sort_wait_stale_reset`（古い並べ替えの待ちの印を外した）。段 `bulk_phase` に `autofill_wait_prev`（前客の送付待ち）。`axlx-webapp-search`・`axlx-poll-now` は一括中・窓の間 `{ok:false, error|reason:"bulk_busy"}` を返す。点検: `scripts/check-quiet-windows.ts`
- 2.8.294: 人のリセットと古い中身（DB の列・表は増やしていない）。`search_audits.steps` に新しい段 `human_reset_press`（人がリアプロの「リセット」を押した・送付中か・一括の段）・`human_reset_wait`（人のリセットから30秒以上あけるために待った秒）。chrome.storage.session `axlx_human_reset_at`（押した時刻）・`axlx_orphan_reload`（`{at, n, ver, reason}`＝拡張の読み直しで入れ替えたタブの数）。拡張の中だけの合図 `axlx-human-reset`（bulk-dl → background）
- 2.8.293: 点検の回が裏の起き直しで消えないように（DB の列・表は増やしていない）。chrome.storage.session `axlx_audit_open_runs`（`{at, runs:[開いている回]}`・1時間以内だけ戻す）。`search_audits.steps` に新しい段 `sw_restart_restored`（起き直して戻した）・`dl:sort_failed_wait_retry`（並べ替え失敗→30〜36秒待ってもう1回）・`dl:ad_sort_reload`（並べ替え後の読み直しで URL が高→低だったか ad_url／no_ad_url）。`dl:` の時刻の印に `wait_sort_cursor`／`wait_sort_retry`（並べ替えの待ち中は一覧から押し始めない）
- 2.8.203: 連続客ループ。`search_audits.steps` に `post_send_clear`（見送り含む・runId明示）／`handoff_loop`／`series_done`。台帳 `app/lib/handoff-loop-ledger.ts`（列は増やしていない）。土台 **F61**
- 2.8.202: 客ごとの検索思考（決定論・LLMなし）`POST /api/customer-search-think` → 監査段 `customer_think`／`customer_think_apply`。storage `axlx_customer_think`・`axlx_last_filled_cid_mirror`（列は増やしていない）。改善検証完了線は `judgeImproveVerified`（F55＋手順書版一致）
- 2.8.201: はる（駅）→指定客（地域）の食い込み止め。`search_audits.steps` に `designated_lock`／`designated_done`／`designated_incomplete`／`designated_hold`。sessionStorage `axlx_last_want_mode`（station|area|none・列は増やしていない）。前客番号の保存は notifyDone／ready_next（fill開始時の上書きをやめた）
- 2.8.107: bulk-dl は `axlx_fill_busy` が変わったら（別タブの入力の開始も）、押し始めの後に始まった入力なら印刷用PDFを黙って止める（`search_audits` の段 `auto_pdf_end=stopped_new_fill_*`・`auto_pdf_load=look_cancel_new_fill`）。background は `chrome.storage.local` の `axlx_pipeline_job`（一連のロック）が別のお客さんで12分以内なら次のお客さんを始めずに待ち（`wait_prev_customer`）、`pipeline_busy` でもロックを強制解除しない（段 `pipeline_busy_other`）。点検の段 `reset_btn`・`clear_method_place=reset_button` は出なくなる（リセットを押さない）。DB の列・表は増やしていない
- `aixlinx-fill-done`／`axlx-fill-done` に `gateKind`（2.8.106）: 関所で止めた理由の種類。`human_takeover`（人が引き取った）・`busy_other_customer`（前のお客さんの入力中に来たので断った）の時は background が一括を止める（次のお客さんへ進まない）。DB の列は増やしていない（`search_audits.error` の文に残る）
- 2.8.104 から、自動の1件ずつ送る流れの `axlx-batch-customer-done` にも `audit`（`_auditResult`・`auto_pdf:true`・`timings`・`sent_skipped`）が載る → `search_audits.result` に検索後の段が残る（列は増やしていない）
- 2.8.125〜126 動きの計画（DB に無い・列も表も増やしていない）: `GET /api/motion-plan`（`app/api/motion-plan/route.ts`・`app/lib/motion-plan.ts`・DB を読まない）→ 拡張 background `_refreshMotionPlan` が**お客さんの入力を始める直前**に取り chrome.storage `axlx_motion_plan`（`{v:1, plan_id, expires_at, run_seed, persona}`）へ。content.js が MAIN world の `window.__axlxMotionPlan` へ中継、pointer-ui.js が persona を作り直す。止める: 環境変数 `MOTION_PLAN_OFF=1`／chrome.storage `axlx_motion_plan_off=true`。取れなければローカル seed で動く。自動の動きの指標は `search_audits.steps` の段 `motion_stats`（列は増やしていない）。サーバーの束の動き `axlx_learn_motion` も MAIN world へ届くようにした（PUSH_KEYS）
- 2.8.132 押しを1つずつ・連続の止まり（DB の列・表は増やしていない）: `search_audits.steps` に新しい段 `sel_retry_human`（プルダウンの値が違った時にもう1回開いて選び直した）。`toggle_fail` の文に「3手後も now=… want=…（押し足さない）」が載る（チェック欄の4回目の押しをやめた）。storage.local `axlx_pipeline_job` に `touchedAt`（検索が終わって送付へ入った時刻・最後の進みから12分／開始から30分で切れる・popup と background で同じ決まり）。`/api/property-customers` の一覧は拡張が3回まで取り直す（API は変えていない）
- 2.8.131 人の押し方・連続のお客さん（DB の列・表は増やしていない）: `search_audits.steps` に新しい段 `hidden_press`（見える欄が無くカーソル無しで押した物・数えて減らす）・`reset_skip_hidden_place`（次のお客さんの前の片付けで、閉じた小窓の中の区・町・駅・沿線を直接外さず小窓の係に任せた数）・`stuck_prev_closed`（3分以上止まった前客を閉じて次へ）。ページ側の失敗 `no_search_form`／`watchdog-timeout`／`stuck_superseded`／`fill_exception` は fill-done の `error`（gate 扱い）で届く。bulk-dl は押さずに終わった時 `axlx-batch-customer-done` を `skipped:true`（`auto_pdf.why` = `zero_rows_after_search`／`no_rows_not_result_page`（件数 null）／`next_page_stale`／`next_page_customer_changed`／`next_page_not_auto`／`next_page_no_rows`／`halt_new_fill_*`）で送る。storage.local `axlx_pipeline_send_hold` は `{cid, at}`（15分で無効・旧の文字だけの形は無効）。リアプロのタブの sessionStorage `axlx_refill_after_nav`（`{cid, cond, at}`・ホーム→住居検索で頁が移った後に同じお客さんの入力を続ける・90秒・1回で消す）。見張りの出来事 `batch_done_late_prev`（前のお客さんの遅れた完了合図を次の人に当てなかった）
- 2.8.130 前客と今客の把握（DB の列・表は増やしていない）: リアプロのタブの sessionStorage に `axlx_last_filled_cid`（`{cid, at}`・6時間で無効＝頁を読み直しても前客の番号が残る）。台帳 `axlx_entered_ledger` に `want`（`{wards: 区コード[], stations: 駅名[]}`＝そのお客さんが入れたかった物）を足し、`cid` は台帳を始めたお客さんで固定。`search_audits.steps` の段 `leftover_ledger` の文に「前客=xxxx→今客=yyyy」と「前客の希望→今客: 外す候補 区n・駅n／共通n」が載る。段 `switch_grasp` は頁を読み直した後も `first_customer` ではなく `need_clear_prev`／`switched_clean` になる
- 2.8.126 手動の単発の autofill に `customerId`（popup→underbar→ページ）を載せた（旧は番号なしで `now_customer cid=-`）。ページ側 `window._axFillRunningCustomerId` が手動でも入る＝一括が「誰の入力中か」を見分けられる。DB の列は増やしていない

## 読みやすい view（2026-11-10 足した・security_invoker）
サイトの名前は全部 `realpro` / `itandi` / `reins` に揃えてある（`ext_site_key()`）。数字は `ext_num()` で数字だけを数にしている（数字でない値は NULL）。**読む時は必ず期間で絞る**（`started_at > now() - interval '3 days'` など）。v_search_runs は古い行を時刻で突き合わせるので、絞らないと重い。

| view | 1行 | 主な列 | 使い方の例 |
|---|---|---|---|
| `v_search_runs` | 検索の1回（search_audits） | run_id・started_at・site・property_customer_id・mode・trigger・is_wide・area_mode・status・cause_key・command_id・command_source・cmd_rp_update_days・cmd_itandi_update_days・intended・filled・result・pickup_rows・pickup_sent_rows・pickup_recommended・sent_rows | この回で何件ピックアップされ、何件送ったか |
| `v_search_runs_realpro` | 上のリアプロの回だけ | update_days（rp）・route_ids・station_names・city_codes・town_names・rent_max・floor_plan・guide_stations | リアプロで入れようとした路線・区のコード |
| `v_search_runs_itandi` | 上の ITANDI の回だけ | update_days（payload の itandi_update_days → 無ければ intended の rp_update_days）・itandi_lines・station_names・ward_names・rent_max・floor_plan・guide_stations | ITANDI で入れようとした路線ラベル |
| `v_search_candidates` | 候補1件（property_candidate_pools.candidates を開いた物） | pool_id・site・property_customer_id・sent_at・search_run_id・rank・property_name・room_no・rent・admin_fee_yen・floor_plan・area_sqm・station・walk_minutes・ward・ad_months・ad_yen・pdf_url・src・raw | 候補の中身をサイトごとに比べる |

- ピックアップとの結び方: `property_pickups.search_run_id = search_audits.run_id`。11/10 より前の行と run_id の無い行は「同じお客様×同じサイト×検索の始まりから終わり（無ければ30分）＋10分」で突き合わせる（11/10 の確かめで 74% が結べる）。
- 候補の形はサイトで違う: リアプロは生の文字（raw の head/cells/bld_text）から区と住所を埋める形で、号室はほぼ無い。ITANDI は項目で読む形で、号室・敷金礼金・築年月がある。値の出所は `src`（`ext`＝拡張が読んだ／`text:bld_text` 等＝生の文字から埋めた）。
- 11/10 の確かめ（直近3日）: v_search_runs 39行（ピックアップ 43件）・_realpro 26行・_itandi 13行・v_search_candidates 70行。

## 物件検索 → 拡張 → AIXLINX の流れ

凡例: 🧠＝ブレイン（LLM の判断）／🔢＝決まった計算（決定論）／💾＝DB に残る／🫥＝残らない（画面・拡張の中だけ）

### ① 検索の始まり（5つの入口）
| 入口 | どこで | 何が起きる | 判断 | 残る物 |
|---|---|---|---|---|
| 会話の「🔍 物件検索」 | app/components/PropertySearchFocusButton.tsx:108 → app/api/property-search-focus/route.ts | お客様に印（24時間）→ 拡張のお客様一覧の一番上「📌」に出る。拡張が開くと GET ?customer_id= で決め手の条件（closing-target）を一時調整の欄に入れる（popup.js:3934） | 🔢 印／🧠 決め手の条件（search-focus-server.ts） | 💾 property_search_focus（1人1行・上書き＝履歴なし）／🫥 決め手の条件を欄に入れた事 |
| AIX【物件を探す】（property_search） | 送信の記録 app/api/log-aix-usage/route.ts:377 → search-focus-server.ts（印を置く）／AIX 要対応の経路 app/lib/aix-action-items.ts `enqueueAixPropertySearch`（:243 で automation_commands に積む・sites=["realnetpro","itandi"] :205） | 10/01 から自動検索は停止中なので、今は印（📌）が主 | 🧠 AIX を出すかはブレイン（brain-core）／🧠 メモの指示の読み取り（search-override.ts:139 の LLM） | 💾 aix_usage_logs・property_search_focus・automation_commands.payload.search_override |
| スタッフの一括検索（AIX ツールでチェック） | app/api/automation/trigger/route.ts（payload {source:"web_brain", is_wide, rp_update_days}・:77-82 で更新日を計画） | 1人1コマンド。拡張のブレインが ON の PC だけ拾う | 🔢 | 💾 automation_commands |
| cron の自動検索 | app/api/cron/auto-property-search/route.ts（:51-54 で paused なら積まない）・app/lib/auto-search-schedule.ts:248 | 11時台・17時台に積む（今は停止中） | 🔢 | 💾 automation_commands（payload.source="auto_schedule"・rp_update_days・sort・max_pages・update_days_plan） |
| 拡張で手で検索（個別・手動の一括） | popup.js（個別）／background.js:1700-1714（手動の一括・trigger="bulk_manual"） | 一時調整の欄（tempAdj）を重ねて検索 | 🔢 | 💾 search_audits（ブレインの時だけ）／🫥 一時調整（localStorage tempAdj_<id>・popup.js:4114-4152） |

拡張が指示を拾う所: background.js:3041 `/api/automation/pending`（app/api/automation/pending/route.ts・automation_settings.paused を見る :33）→ お客様ごと×サイトごと（auto-run.js orderSites・background.js:3943）。進み具合は `/api/automation/update`（background.js:4977）。

### ② 条件の解決（お客様の言葉 → サイトの値）
| 段 | どこで | 判断 | 残る物 |
|---|---|---|---|
| 登録の条件を検索の形に | background.js:4641 `_buildBatchConditions`（一括）／popup.js:3065・5586・5642（個別） | 🔢 | 🫥（その回の conditions。ブレインの時だけ search_audits.intended に写し） |
| 一時調整・メモの上書き・決め手の条件を重ねる | popup.js:5136 `computeTempAdjOverride`・search-override.js（applyToCustomer／merge）・background.js:3973・4173 | 🔢 | 🫥 何を重ねたか（search_override はピックアップの search_override に入る時だけ💾） |
| 地名・駅の解決 | popup.js:340 /api/token-resolve・:511 /api/resolve-area・:4793 /api/itandi-resolve・:573 /api/property-brain/search-params・background.js:2540 /api/resolve-search-conditions | 🔢 辞書（station_map・region_map・line_meta・line_stations）→ 無い語だけ 🧠（Haiku・resolve-area/token-resolve） | 💾 学んだ語は station_map／region_map に upsert（token-resolve:594-620・resolve-area:621）・解決できない語は unknown_tokens |
| サイトの表記に直す | popup-maps.js（STATION_LINE_MAP → LINE_ROUTE_MAP＝リアプロ／ITANDI_LINE_MAP_FILL＝ITANDI／REINS_LINE_MAP） | 🔢 | 🫥 対応表は拡張の中（DB の line_meta・station_map は写し） |
| 更新日 | popup.js:3511-3524（個別はサイトごとの列）・background.js:1713（手動の一括は rp の値）・background.js:4643（指示の payload.rp_update_days を両サイトに） | 🔢 | 💾 手で選び直した値は property_customers の rp_update_days／itandi_update_days（上書き・履歴なし） |

### ③ 拡張がリアプロ／ITANDI で検索
| 段 | どこで | 判断 | 残る物 |
|---|---|---|---|
| 画面に入れて検索 | リアプロ page-script.js（city_codes・route_id）／ITANDI itandi-page-script.js（路線ラベル・option_id）／案内モード realpro-guide.js:457・itandi-guide.js:504 | 🔢 | 💾 search_audits（started→finished・intended・filled・steps・result・ブレインの時だけ background.js:2606）／💾 案内で押せなかった駅は filled.guide_stations（11/10: リアプロ 52・ITANDI 0）／🫥 画面で手で選び直した駅 |
| 一覧を読む・送付済みを外す | bulk-dl.js／itandi-bulk-dl.js・/api/automation/sent-rooms（background.js:1405）・sent-check（:1355） | 🔢 | 🫥 外した数は merge-pdfs の ext_sent_skipped だけ |
| 1件ごとの判定 | bulk-dl.js:760 → background.js:820 `/api/property-brain/judge`（**リアプロだけ**） | 🔢 判定（property-brain.ts「全部決定論」）＋🧠 間取り図の有無だけ DeepSeek | 💾 property_brain_judgments（realpro 9,327・itandi 0） |
| 画面の見張り | background.js:3183 /api/screen-watch | 🔢 →🧠（DeepSeek・screen-watch.ts:9） | 💾 screen_watch_events・extension_snapshots |

### ④ 候補・PDF → ピックアップ
| 段 | どこで | 判断 | 残る物 |
|---|---|---|---|
| 候補の一覧 | background.js:1186 `/api/log-property-candidates`（LINE に送る時だけ・fire-and-forget） | 🔢（生の文字から埋める enrichCandidate） | 💾 property_candidate_pools（10/05 から 1 行 2 件前後＝送る物だけの疑い） |
| PDF をまとめて送る | background.js:589 `callMergeApi` → app/api/merge-pdfs/route.ts（受け取る物 :255-283） | 🧠 🌟（recommended・DeepSeek・pickup-rank.ts:121・281）／🔢 構造×を外す（:181） | 💾 property_pickups（brain_mode の時だけ :556-582 → property-pickups-server.ts:490）・💾 sent_properties（source=line_group・:674-706・11/10〜 site あり）・💾 batch_owner.run_id／search_command_id → property_pickups.search_run_id／search_command_id（11/10〜）|
| まとめ（完了） | background.js:789 /api/property-pickups/complete → pickup-complete-server.ts:90・97 | 🔢 👑 一番オススメ（pickup-best.ts:261-338・recommend-score.ts） | 💾 property_pickup_completions（best_id・basis）／🫥 👑 の点の内訳 |
| 画像を切る・読む | prerender（background.js:731）・trim・analyze | 🧠 資料の読み取り（DeepSeek） | 💾 trim_image_url・image_lines・image_facts・image_analysis |

### ⑤ AIXLINX の画面に物件が出る所
| 段 | どこで | 読む表 | 判断 | 残る物 |
|---|---|---|---|---|
| 物件出しの一覧（売上サポ） | app/conditions/page.tsx:967 → PickupReview.tsx → /api/property-pickups?view=list（pickup-list-load.ts:17-19）・view=detail（PickupReview.tsx:481） | property_pickups・completions・notes・sent_properties・conversations（route.ts:387-514） | 🔢 | 🫥 チェックの状態・一覧の控え（メモリ） |
| AIX へ渡す | PickupReview.tsx:1107 buildPickupAixHref → /?conv=&aix=property_send｜property_recommendation&pickup=&batch= → app/page.tsx:6459 parsePickupAixHandoff（:6471 で画像・72時間を過ぎた行は渡さない）→ AixModal | property_pickups（trim_image_url／page_image_url） | 🔢 | 🫥 受け渡し（useRef・page.tsx:6456） |
| 下書き | AixModal.tsx:2494・2518（pickup_ids）→ /api/aix/action route.ts:2329-2334（summary_text・terms・location・image_lines。AD・利益・🌟は読まない :2323・審査中は止める :2344） | property_pickups | 🧠 文 | 💾 aix_usage_logs |
| トーク画面の新着カード | NewArrivalCard.tsx:27 → /api/property-pickups/talk（読むだけ） | pickups・search_audits・sent_properties | 🔢 | — |
| ブレインが「物件の AIX」を選ぶ | brain-core.ts:3609（pending-pickup.ts）・:156（first-contact-pickup.ts） | — | 🧠＋🔢 の網 | 💾 brain_decision_logs |

### ⑥ 送付の記録と、送った後に戻る所
| 段 | どこで | 判断 | 残る物 |
|---|---|---|---|
| AIX で送った | pickup-sent-plan.ts:146-160（source=aix:property_send・channel=pickup・pickup_id）・send/route.ts:54-70（status=sent・last_property_sent_at） | 🔢 | 💾 sent_properties（11/10〜 site あり・検索の回は pickup_id → pickups.search_run_id） |
| LINE の画像から照合 | sent-image-record.ts:173-183（send-line-message/route.ts:290） | 🧠 画像の読み取り | 💾 sent_properties（照合できない時 source=vision・site 不明） |
| ブレインの材料 | brain-core.ts:1482-1491 → sent-props-text.ts（【送付済み物件】【ベンチマーク物件】:2030-2048・2772） | 🧠 | — |
| 見張り・台帳・学習 | search-audit-check.ts:233・713（SENT_SELECTED）／action-ledger.ts:469（aix_usage_logs の property_send）／customer-pref-learning-server.ts:110・scoring-learning-server.ts:94 | 🔢 | 💾 各表 |
| 次の検索で外す | /api/automation/sent-rooms（sent-rooms-server.ts:5-9）・sent-check（:29 filterOutAlreadySent） | 🔢 | — |

### 流れの中の「切れ目」（DB で追えない所・11/10 時点）
0. **実際に画面に入った値（search_audits.filled.form）が 10/05 の週から両サイトでほぼ 0**（案内モードに変わった時期と同じ）→ Cursor に最優先で頼む
1. 検索の回（search_audits.run_id）→ ピックアップ: 11/10 に property_pickups.search_run_id を足した（merge-pdfs が batch_owner.run_id から入れる・個別の検索の回は拡張が run_id を送るまで空）
2. ピックアップ → 送付: pickup_id は AIX の経路だけ。11/10 に sent_properties.site を足した（line_group にもサイトは入る・vision は NULL）
3. 登録の条件 → その回に実際に使った値: 一時調整・駅/地域の切替・画面での選び直しが残らない（新しい表は今回は作らない・11/10 竹内さん）
4. ITANDI: 判定（property_brain_judgments）と案内の駅（filled）が残っていない・更新日は AUTO_MODE_HANDOFF.md の 10.
5. 👑 の点の内訳・AIX への受け渡しは画面の中だけ（残すかは竹内さんに確認）

詳しい行番号つきの調べは、統括役のセッションの記録にある（作業員の報告 11/10）。

## 表記の違い（リアプロ・ITANDI・REINS）— 2026-11-26 実測
正本は `chrome-extension/popup-maps.js`（駅→路線 `STATION_LINE_MAP`・リアプロの番号 `LINE_ROUTE_MAP`・ITANDI `ITANDI_LINE_MAP_FILL`・REINS `REINS_LINE_MAP`）。3サイトは別の表記。同じ路線でもサイトごとに違い、**REINS が realpro と同じ場合もある**（大阪環状線）ので、見た目で判断しない。

| リアプロ（内部名） | ITANDI（ラベル） | REINS（沿線名） |
|---|---|---|
| 大阪市高速軌道御堂筋線 | 高速電気軌道第1号線(大阪メトロ御堂筋線) | 大阪メトロ御堂筋線 |
| 大阪市高速軌道長堀鶴見緑地線 | 高速電気軌道第7号線(大阪メトロ長堀鶴見緑地線) | 大阪メトロ長堀鶴見線（※REINS の画面は未確認） |
| 大阪環状線 | **大阪環状線**（JR を付けない・2026-11-26 画面で確認） | 大阪環状線（realpro と同じ） |
| JR東西線 | JR東西線 | **東西線** |
| 東海道本線 | **2本**: JR東海道本線(京都～大阪)(JR京都線) と JR東海道本線(大阪～神戸)(JR神戸線(大阪～神戸)) | **未決**: 東海道本線 か 東海道線（下の「未決」） |
| 阪急電鉄神戸線 | 阪急神戸本線 | 阪急神戸線（11/10 竹内さん決定） |
| 阪急電鉄京都線 | 阪急京都本線 | 阪急京都線 |
| 南海電鉄南海本線 | 南海本線 | 南海本線 |
| 南海電鉄泉北線 | 南海泉北線(泉北線) | 南海泉北線 |
| 近鉄難波・奈良線 | **2本**: 近鉄難波線 と 近鉄奈良線 | 近鉄奈良線 |
| 関西本線 | JR関西本線(加茂～ＪＲ難波)(大和路線) | 関西線 |
| 能勢電鉄妙見線／日生線 | 能勢電鉄妙見線／能勢電鉄日生線 | 能勢電鉄（2本とも同じ） |
| 水間鉄道水間線 | 水間鉄道水間線 | 水間鉄道 |
| 大阪モノレール本線 | 大阪モノレール線 | 大阪モノレール本線 |
| 近鉄西信貴ケーブル線 | 近鉄西信貴鋼索線(西信貴ケーブル) | （REINS の表は無し） |

**読み方のルール（今ある仕組み）**
- ITANDI の路線の照合（`itandi-page-script.js` の `textMatch`）は「ラベルが検索語を含む」で当たる。ITANDI の一覧の表示は「大阪環状線」（2026-11-26 竹内さんのスクリーンショットで確認）なので、完全一致で当たる。「神戸線」と「神戸本線」は含まないので当たらない。
- 駅の路線を確かめる時は、リアプロ名→ITANDI名→REINS名の順に表で通す。直接の文字の比べは禁止（見張り ④）。

**見つかったずれ（2026-11-26・読むだけで確かめた）**
1. **一括・自動の経路が使う写し `resolution-core.js` が正本と違っていた → 2026-11-26 に正本と同じに揃えた**（`resolveConditionsLocal`＝background の `_resolveLocalFirst`）。見張り: `tests/chrome-extension/notation-copies-sync.test.js`（`ext-test-all` が回す）。揃える前の状態（参考）:
   - 駅→路線の表: 正本 658 駅のうち写しは 306 駅だけ（352 駅が欠け・DB の学習データ `station_map` に路線があるのは 325 駅・DB に行が無いのは 4 駅: 能勢電平野・妙見線平野・津田・高槻市）。
   - 11 駅で路線が違った（例: 中津・難波・大日・岸里玉出・森ノ宮・塚口・南茨木・淡路・今宮戎・三国ヶ丘・桜井）。写しが DB より優先されるので DB の値は使われなかった。
   - 能勢電鉄妙見線・日生線が `LINE_ROUTE_MAP` に無く、能勢の駅は路線の番号も ITANDI・REINS の路線も出なかった（揃えた後、絹延橋は 6676・ITANDI「能勢電鉄妙見線」・REINS「能勢電鉄」を確認）。
   - 短縮名 `LINE_ALIAS_MAP` 25 件→9 件、駅の順番 `LINE_STATION_ORDER` の阪急京都線 11 駅→28 駅、駅→区 `STATION_WARD_MAP` 8 駅 が無かった。
   - 版（manifest の版）は上げていない。拡張の再読み込みで反映される。
2. **`popup.js` の ITANDI 注記用の写し → 2026-11-26 に揃えた**（手順書の「itandiの路線名」表示だけに使う・検索の条件には使わない）。揃える前は東海道本線が京都線だけ・近鉄難波・奈良線が1つの文字列だった。
3. **東海道本線の粗さ**: 正本は京都線と神戸線の2本を全部の駅に入れる。京都線だけの駅（高槻・茨木・島本・摂津富田・JR総持寺・東淀川・千里丘・岸辺・JR千里丘）や神戸線だけの駅（甲子園口・立花・塚本）にも2本入っている（DB の ITANDI 列・空埋めの前から）。11/10 に千里丘・岸辺・JR千里丘だけ京都線の1本に直した。
4. **REINS の東海道（一部解決）**: 2026-11-26 の空埋めで REINS 列に `東海道本線` を入れた11行は、竹内さんの決定（「空に戻す」）で空に戻した（`reins_tokaido_revert_before_*.json` が戻す前の控え）。茨城は空埋めより前から `東海道本線` だった（触っていない）。千里丘・岸辺・JR千里丘は `東海道線`（11/10 の時のまま）。**ただし REINS の画面の表記（東海道本線か東海道線か）は未確認**。正本 `REINS_LINE_MAP` の `東海道本線` は、写しを揃えたので一括の経路でも出るようになった（以前は出なかった）。
5. **近鉄信貴線・近鉄西信貴ケーブル線は一括・自動の経路で ITANDI・REINS に出ない**（写しを揃えても）: `resolution-core.js` の `resolveConditionsLocal` は、リアプロの路線番号（route_id）が付く路線だけを ITANDI・REINS の路線に回す（`if (id)` の所）。信貴線はリアプロに路線番号が無い（正本の `LINE_ROUTE_MAP` に無い）ので、ITANDI・REINS にも回らない。popup の経路は正本の表を直接引くので、そちらでは出る見込み（コードを読んだ確認・実機は未確認）。一括と個別で結果が違う可能性がある。直すなら「路線番号が無くても ITANDI・REINS は回す」に変え5. **DB の ITANDI 列の 大阪環状線**（17 行）: 2026-11-26 解決。ITANDI の一覧の表示は「大阪環状線」（JR なし）。正本・写し（popup-maps・resolution-core・popup.js・app/lib/station-line-maps.ts）を「大阪環状線」に揃えた。DB の 17 行は書き換え無し（もう一致）。11/10 の「触らない」の理由は記録に無い。る（決定の行は設計知見 2026-11-26）。
6. 駅名 `茨城`（DB の token・東海道本線）は `茨木` の打ち間違いの可能性がある（未確認）。

**2026-11-26 に決めて直したこと（竹内さん）**
- REINS の東海道本線 11 行を空に戻した（控えあり）。
- 写し（`resolution-core.js` の 7 表・`popup.js` の注記用の表）を正本に揃えた。見張り `notation-copies-sync.test.js`。`ext-test-all` は新しい赤 0（基準の赤 115 は変えず）。版は上げていない（拡張の再読み込みで反映）。

**2026-11-26 深夜の決定（竹内さん）: レインズは使わない**
- 実測（直近30日）: search_audits はリアプロ 596 件・ITANDI 84 件・レインズ 0 件。property_pickups の site=reins は 0 件。automation_commands（直近30日 1000 件まで）に reins を含む物は 0 件。
- REINS の項目（上の表の REINS 列・4・A・下の REINS 関係）は**対象外**。見張り（site-split-rules）・写しの試験・拡張の `reins-*.js` 3本・manifest の reins の一覧は、まだ残している（止めるか消すかは未決・下の「未決」）。

- **2026-11-27 同期と仕組み化**:
  - `popup-maps.js`（正本）・`resolution-core.js` 内の重複キー 6件（`吹田` の JR東海道本線消失バグ含む・`三国ヶ丘`・`南港口`・`山之内`・`苅田`・`西宮原`）を解消し、`tests/chrome-extension/notation-copies-sync.test.js` に全マップ重複キー 0 検査を追加。
  - `app/api/seed-maps/route.ts`（`STATION_WARD_MAP` / `STATION_LINE_MAP` / `NEIGHBORHOOD_WARD_MAP` / `LINE_STATION_ORDER`＋`@/app/lib/station-line-maps` import）および `app/api/resolve-search-conditions/route.ts`（`LINE_ROUTE_MAP` / `LINE_ALIAS_MAP`）を正本へ同期し、`notation-copies-sync.test.js` の監視対象に追加。
  - `.githooks/pre-commit` に `realpro-guide-town.test.js`（詳細地域案内＋単発自動 `_resetBeforeFill`）・`playbook-site-split.test.ts`・`auto-rules-verify-exists.test.ts`・`playbook-rule-evidence.test.ts`・`learn-opens-and-itandi-flow.test.ts` を追加。
  - **2.8.311 / 作り方19 手順書浄化・ITANDI 独立・監査同期**:
    - `app/lib/itandi-field-aliases.ts` を新設し、`ITANDI` の `compactBundle` / `buildPlaybook` / `inheritLinkFoundations` がリアプロ別名表 `field-name-aliases.ts` を混ぜない構造に分離。`app/lib/auto-itandi-rules.ts` に独立版 `ITANDI_RULES_REVIEWED_UP_TO` を分離。
    - `app/api/human-learn-profile/route.ts` の `?refresh=1&scope=realpro|itandi` 対象スコープ修正＋`?touch=0` の `rulesReviewedUpToFor(scope)` 統一。
    - `chrome-extension/itandi-page-script.js` が `axlx_learn_playbook__itandi` / `axlx_learn_bundle__itandi` を読み、`search_audits.steps` に `page:page_ver`, `page:playbook_seen`, `page:playbook_none`, `page:playbook_behind` と途中保存（`itandi-content.js` `axlx-guide-live-flush` → `background.js` `axlx-audit-live-step` `site: "itandi"`）を送る経路を追加。`search-audit.js` で `dl:send_bar_show` を畳み込み、`background.js` で反対側サイト更新検知・`perSite.realpro` 混載上書き停止・ITANDI フォールバック `postMessage("axlx-itandi-fill-exec")` ＆ `customerId` 伝播を修正。
    - `learn-supervisor.ts`（`read_count` / `auto_after` 実値伝播）＆ `learn-bundle-preserve.ts` `syncSupervisorImproveLoop`（`shots.learned` 引き継ぎ後の `改善までの一連` 同期）を実装し、`pre-commit` に `playbook-clean-and-itandi-sync.test.ts` 等を追加。

**未決（竹内さんの判断が要る）**
- A. （レインズは使わないので取り下げ）REINS の東海道本線の表記。
- B. 近鉄信貴線・西信貴ケーブル線を一括の経路で ITANDI に回すか（上の 5）。ITANDI 向けのロジックの変更になる。
- C. 東海道本線を駅ごとに京都線／神戸線へ振り分けるか（ITANDI のみ・正本の表の作り直し）。
- D. レインズの拡張（`reins-*.js` 3本・manifest の reins の一覧・見張りの REINS の箱）を止めるか消すか。
