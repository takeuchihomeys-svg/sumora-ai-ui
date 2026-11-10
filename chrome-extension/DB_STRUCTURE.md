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

## リアプロと ITANDI で混ざっている所（直す候補）
1. ~~**`site` の値が2通り**~~ → 11/10 DB で揃えた（migration `ext_db_site_runs_views_1110`）。本番の値は automation_commands.sites と extension_devices.current_site だけ `realnetpro`、他の11の表は realpro/itandi/reins で揃っていた。DB の関数 `ext_site_key()`（realnetpro・リアプロ→realpro）と、site の列がある10表の trigger `trg_site_norm`（入る時に揃える・拒まない）を足した。拡張との指示のやり取り（sites の `realnetpro`）は変えない。サーバーの揃える関数4か所（search-audit-check.ts・screen-watch-server.ts・search-update-days-server.ts・search-widen-chain.ts pickupSiteOf）は残っている。
2. **一括検索・自動の便では ITANDI もリアプロの更新日を使う**: cron と automation の payload は `rp_update_days` しか持たない（v2.5.76 で列を分けたのは popup だけ）。
3. **`line_stations` はリアプロの内部名だけ**: ITANDI の駅の順番は持っていない。
4. **`station_map.itandi_lines` はリアプロの路線名から変換して作った物**。`reins_line` は最初の1本だけ。~~スタッフの手直し（station-map の POST）はリアプロの列しか直さない。~~ → 11/10 直した: POST はリアプロの路線が来たら `app/lib/station-line-maps.ts` の `deriveSiteLines` で ITANDI・REINS も作り直す（表に無い路線の列は前の値を残し warning で返す）。既存の行は 767行中 344行が表と違う（空を埋める 317・上書き 19・リアプロの列が表に無い名前 8）＝書き換えは未実施（統括役の判断待ち・`scripts/audit-station-map-site-lines.ts`）。
5. **対応表の写しが5か所以上**: popup-maps.js（正本）・resolution-core.js・popup.js の中・seed-maps・token-resolve・DB（station_map・line_meta）。11/10: token-resolve の写しは `app/lib/station-line-maps.ts` に移し、正本とのずれをテストで見張る（他の写しはまだ）。
6. ~~**token-resolve の AI への例が対応表と違う**（阪急神戸線の名前）。~~ → 11/10 直した（例を表から作る）。
7. **memory の記録とコードの食い違い**（REINS の阪急神戸線・宝塚線・京都線: memory は「〜本線」・コードと DB は「阪急神戸線」）。search_audits に reins の行が無く画面の表記が分からない → 竹内さんに確認中・決まるまで変えない。
8. ~~**sent_properties に site が無い**~~ → 11/10 列を足した。新しい行は merge-pdfs（source=line_group）と AIX で送った行（aix:property_send）に入る。古い行は pickup_id がある 507 行だけ、22時以降に pickups.site から埋め戻す。line_group の古い行は property_url も NULL なので埋めない。
9. **property_customers に古い列が並ぶ**（area/desired_area・max_rent/rent_max・layout/floor_plan）。

## 拡張の中だけにある物（DB に無い）
- 対応表（popup-maps.js・resolution-core.js に同じ物）: STATION_WARD_MAP・NEIGHBORHOOD_WARD_MAP・STATION_LINE_MAP・LINE_STATION_ORDER・WARD_CODE_MAP（リアプロ）・TOWN_CODE_MAP（リアプロ）・ITANDI_LINE_MAP_FILL・LINE_ROUTE_MAP（リアプロ）・LINE_ALIAS_MAP・REINS_LINE_MAP ほか
- サイトの画面用: リアプロ（page-script.js・realpro-guide-plan.js の ROUTE_LINE_MAP・STATION_NAME_ALIASES ほか）／ITANDI（itandi-page-script.js・itandi-guide-plan.js の ITANDI_STATION_ALIAS_MAP・option_id ほか）／REINS（MADORI_LABELS）
- 通勤: transit_graph.js・osaka-transit.js・commute-*.js
- chrome.storage / localStorage: モード・今のお客様・一括検索の状態・送付の状態・誤送の防止（axlx_search_for）・案内（リアプロ／ITANDI で別のキー）・一時調整（tempAdj_<id>・DB に残らない）

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
