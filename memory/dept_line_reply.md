# LINE返信AI部署 倉庫（#L）

最終更新: 2026-09-12

---

## 申込中（is_post_apply）もブレインが判断する・帯はブレインの判断が一致した時だけ（竹内・名無しの権兵衛／あや事例・2026-09-12）— 黄金ルール
- 名無しの権兵衛（メゾン加美北を申込中）「因みに、昭和グランドハイツ恵比寿の初期費用教えて下さい」→ AIX 見積書送る が正解なのに AIX なし。実行ログ `[brain-core] skip(stamped): … is_post_apply` ＝申込以降バッジで**ブレインが分析自体をしていなかった**（G2 の最上流）。30日で is_post_apply の会話13件にスタッフが AIX を91回押していた。brain-core の is_post_apply skip と brain-sweep の除外を廃止（status の BRAIN_SKIP_STATUSES＝契約・成約以降だけ skip は維持）。修正後のブレインは同じ会話で estimate_sheet
- 画面の P5.5「次のアクション → AIX 物件確認した」・P6「次のアクション → 物件を送る or 募集状況を確認する」が**やることの有無だけ**で出ていた（ブレインが見積書送る／AIX なしでも出る）→ `brainAixAction` が同じ AIX の時だけ出す（竹内方針「ブレインが判断していないのに帯を出さない」）
- 残っていた物件ピックアップのやること（29件）が bg-async / generate-pending-drafts の下書き生成を止めていた（スタック救済は ai_draft が既に [AIX誘導中] の時だけ＝顧客の新着ごとに空に戻るので永久に救済されない）→ 24時間以上前のやることは下書きを止めない。旧キーワード判定の誤作成（「お部屋お送りいただきありがとうございます」）3件を取り消し（Hayato.I・名無しの権兵衛・✩）
- あや: 22:00 のスクショは分割送信の再分析修正（前節）より前。修正後のブレインは見積書送る。「初期費用を聞いたお客様が物件を送ってきた」後の最初の AIX は 物件確認した 67・見積書送る 24（200日）なので決め打ちせずブレインの判断＋学習に任せる

## お客様が送った物件は「お送り頂きました物件」（竹内・YUYA 事例・2026-09-12）— 黄金ルール
- お客様がポータルの共有文（「阪急神戸本線 十三 徒歩7分 1R 4万円 [詳細] https://…」）＋「ここはどうでしょうか？」→ 下書き「十三徒歩7分の物件、募集状況確認させて頂きます」／実送信「お送り頂きました物件の募集状況確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！」。物件名ではない描写（駅名・徒歩分・家賃・間取り）で物件を呼ぶと違和感（竹内方針2＝物件名・号室を書かない、の延長）
- **決定論の後処理** `shared-property-ref.ts normalizeSharedPropertyReference`（applySurfaceFixes に customerMessage を渡した時だけ）: お客様の連投に物件（URL・画像・「徒歩N分＋N万円」の共有文）がある時、「（共有文の駅名・路線・徒歩分・家賃・間取り・建物名）の物件／お部屋」→「お送り頂きました物件／お部屋」。直前が既に「お送り頂きました」なら描写だけ外す・同じ文で「お送り頂きありがとう」と受けていれば触らない・ひらがなの語は巻き込まない。validateAndClean（aixGates）・final-check の修正版2か所・audit が同じ入口。生成にも【🏠 お客様が送った物件の呼び方】を注入。120日の物件を送ってきた場面127件で実送信の書き換え1件（「お送り頂きました園田1LDK3階のお部屋」→「お送り頂きましたお部屋」）
- **ブレインの抜け（G4）**: 確認の宣言 → お客様「お願いします！」→ ブレインが acknowledge_check に戻していた。`resolveStaffPromiseAix` に customerAckAfter（宣言後の顧客の連投が了承だけ）→ 宣言の AIX を保つ。確認の依頼・持込予告の判定は宣言より前の連投で見る（150日: 確認の宣言＋了承の後の AIX 35件中 物件確認した 26件＝74%・確認します 0件）

## お客様の手元の物件 → 送って頂いたら最大限割引した初期費用の御見積書（竹内・あや事例・2026-09-12）— 黄金ルール（仕組み）
- 「他社で内覧した・気に入った物件があって初期費用を知りたい（まだ送っていない）」＝持込予告と同じ流れ。返信は「〇〇さんお気に召されましたお部屋お送り頂きますと最大限割引しました初期費用御見積させて頂きます！！」（Sana「お部屋お送り頂きましたら物件の募集状況の確認と最大限割引しました初期費用の御見積書作成しお送り」も同じ）。物件が届いたら AIX（あや: URL 到着 → 13:01 見積書送る → 御見積書送付）
- **旧の穴（診断の型）**: G1 手元の物件の見積依頼を持込予告と判定できず質問扱い →「お送り頂きました物件の初期費用確認させて頂きます」（届いた前提）／G3 ブレインが見積書送る・場面の証拠は「内覧したお家」の「内覧」で内覧希望／キーワード検知の別判断: send-line-message の STAFF_SEND_KEYWORDS「お部屋お送り」が「お部屋お送り頂きますと」「お部屋お送りいただきありがとうございます」に当たり物件ピックアップのやることを作っていた（60日で旧だけ73件の大半が誤り）／G2 URL→「こちらです！」の分割送信で最後の1通だけ見て cached（物件の到着に気づかない）
- **直し方（すべて1つの判定を共有）**: `CUST_WILL_SEND_SELF_PRED` に (A') 手元の物件＋見積・確認の依頼を追加（「物件がありまして」＋初期費用/見積/調べて。仮定・否定・「あるか」・「あり次第」・条件フォーム・URL/画像ありは除外。200日で当たったのはあや・Sana の2件）→ 場面の証拠・物件確認の依頼・webhook タスク・画面タスク・ブレイン・返信分類が同じ判定。classifyCustomerResponse は will_send_later（質問の行が1つなら question を落とす）→ PS/ANY_WILL_SEND（direction に「お送り頂きますと…御見積」の形・mustNot に届いた前提の言い切り）。ブレイン: 未返信の連投が持込予告なら AIX なし（rule:customer_will_send）・約束→AIX も物件到着前は null（customerWillSend）・プロンプト【AIX なし・同じ流れ】。分析モードは未返信の連投全体で判定し URL・画像が届いたら必ず incremental。send-line-message のやること作成は台帳の pickup_declared（「新着出次第」の条件付きは除く）
- 台帳の判定の穴も修正: STAFF_CONDITION_ASK_RE が「ご希望条件に合ったお部屋ピックアップ」まで条件ヒアリングにしていた → 尋ねる・入力を頼む形だけ／STAFF_PICKUP_DECL_RE が「お部屋探しを担当させて頂きます」（挨拶）をピックアップ宣言にしていた → 除外（G4「初回挨拶→規則は物件ピックアップ」6件の原因）

## 確認の宣言 → AIX【物件確認した】（竹内・Sさん事例・2026-09-12）— 黄金ルール
- お客様が物件の画像8枚＋「空いているか確認お願いしたいです」→ スタッフ「お送り頂きました物件、募集状況確認させて頂きます😊！！確認出来次第ご連絡させて頂きます！！」→ **旧: AIX が何もセットされなかった**（スタッフの約束 → AIX の規則が見積書・ピックアップだけ／送信後のブレイン再実行もその2種だけ）
- **規則**（aix-task-link `resolveStaffPromiseAix`）: 最後の発言がスタッフの未履行の確認の宣言（台帳 `confirmation_promised`・`confirmationPromisedUnfulfilled`）かつ **お客様から物件確認の依頼があった**（`customerRequestedPropertyCheck`＝line-tasks の物件確認タスクと同じ判定）→ `property_check_result`（decision_source `promise:check`）。割引・交渉の確認は対象外。お客様の依頼が無いスタッフの自発的な確認（管理会社にペット可否等）は対象外
- send-line-message: 確認の宣言の送信後もブレインを forceIncremental で再実行 → AIX要対応に登録・売上番長グループへ「〇〇さん → AIX【物件確認した】」
- 実績（120日）: 「募集状況確認させて頂きます」の後にスタッフが押した AIX 112件中 78件（70%）が物件確認した
- あわせて: 画像受信直後のブレインで「画像のみ→見積書送る」矯正が、同じ連投に物件確認の依頼（文字）がある時にもかかっていた（image_type は画像取得後に埋まるので受信直後は常に未設定）→ 依頼がある時は矯正しない

## 送付物件の一部の見送り＝探索継続（竹内・KENYOU 事例・2026-09-12）— 黄金ルール
- **1件を外した＝残りの物件を選んだ、ではない**。2件送付後「フジパレスは無しでお願いします」の正解（実送信）は「かしこまりました！！ フジパレスは対象から外し、引き続き物件お探しさせて頂きます！！ 新着で…出次第お送りさせて頂きます！！ 何卒…」。下書きは「住之江区平林南2丁目戸建を中心に進めさせて頂きます」になっていた
- **原因（3段）**: ①返信の分類がどれにも当たらず other・セルなし ②ブレインはこの発言を再分析せず cached（INCREMENTAL_BYPASS_RE に無い）→ 1通前（住之江内覧可能でしょうか）の reply_direction「住之江物件の内覧日を確定」・closing_strategy・customer_intent=decision・next_steps（内覧日3枠）が残った ③generate-reply の brainGuidanceNote が stale でも会話スコープの戦略を「最優先・返信末尾に1文」で注入。さらに「こちらの物件は大丈夫です😭 また違う物件探して見ます」は断り語彙に当たりお別れの型（ANY_DECLINE）になっていた（実送信は「新着出次第随時お送り」）
- **判定は1関数** `detectPropertyPass`（reply-context.ts）: 指示語（そちらの物件・ここ）／順番（1枚目）／物件名詞（〜戸建・〜号室）／建物名（カタカナ主体、漢字は直近スタッフ文に建物として出た時だけ）＋「は無しで／はやめときます／は大丈夫です／を外して」。地名・設備・条件語（尼崎・オートロック・家賃）、申込・内覧の取消、質問、お部屋探し自体の終了（SEARCH_END_RE）は対象外。物件送付後だけ
- **使う場所**: classifyCustomerResponse（新 kind `property_pass`・PRIORITY は質問・懸念の後）→ セル `ANY_PROPERTY_PASS`（override_wait）／generate-reply negativeDetail（断りから除外）／brainGuidanceNote（この場面は前回戦略を注入しない）／brain-core（isIncrementalBypass で必ず再分析・current_property をその発言に出ない物件なら null・customer_intent decision/positive→desire・プロンプト ルール⑩）／resolveClosing（1つ前が見送りなら締めにしない）
- 過去全顧客発言 7,596 通で当たったのは5通、全て見送り（誤検出0）。テスト `property-pass.test.ts`（20件）。回帰 25/767=3.3% 変化なし

## AIX のセットはブレインが判断する（竹内方針・統合設計 段1・2026-09-12）— 黄金ルール（下の方針A を上書き）
- **AIX をセットするか・どの AIX か・check_pattern・enforcement はブレイン（brain-core analyzeConversation）だけ**。`resolveReplyAixDecision`（aix-reply-set.ts）はブレインの判断（suggested_aix_meta ?? last_brain_meta）を読んで形を整えるだけ。fresh（analyzed_msg_ts ≥ 最新顧客発言・cached/optional でない）の時だけ AIX をセット。stale/cached/action='' は AIX なし。場面表・断言コードから AIX を足さない
- 場面の検出は `app/lib/aix-scene-evidence.ts` detectAixSceneEvidence（**証拠**）。使い道は ①ブレインの分析モード格上げ（brain-analysis-mode.ts decideAnalysisMode: 新しい顧客発言に証拠 or 前回 action あり → cached→incremental。ログ `brain:mode` upgradeReason）②本文の安全（resolveBodySafety: 橋渡し・禁止・確認約束の根拠 S1/S2/S3）
- cached 返却は action=''・check_pattern=null・reply_mode=auto_reply で書く。runBrainAndNotify は cached なら null を返す
- unresolvedBlock は AIX を選ばない（ブレインに action→required／無い→stopAutoSend で [AIX誘導中]＋suggested_aix=null。ログ `aix:body-block-without-brain-aix`）
- 手動生成で stale → after() でブレインを後ろ起動（60秒以内に分析済みならしない）。page.tsx 4325 の property_check タスク自動作成が初めて動く（キー比較に修正）
- **段2（2026-09-12 完了）: ブレインが場面を材料に判断し、スタッフの AIX から学ぶ**
  - brain-core analyzeConversation: 未返信の顧客発言（unrepliedCustomerTurn）に場面の証拠を1回だけ当て、プロンプトの行動台帳の隣に【今回の顧客発言の場面（証拠。AIX を決めるのはあなた）】【この場面でスタッフが押した AIX の実績】【過去の判断と代わりに押された AIX】を注入（buildSceneEvidencePromptText・規則として書かない）
  - LLM の aix が null で既存の信号（detectSignalBasedAixFallback）も null の時だけ、S2→property_check_result/mgmt_move_in(vacate_date)・S3→/mgmt_guarantor・S5→meeting_place を**加える**（sceneSignalFallback・decision_source='signal:scene_S2|S3|S5'）。既存の信号の結果は変えない。S1/S4/S6/S7 は信号にしない
  - check_pattern の出どころ（resolveBrainCheckPattern）: 場面の信号 → 証拠 S2/S3 → 未返信の顧客発言だけに detectPropertyCheckPattern（旧: 直近8件・スタッフ文込み）
  - meta と brain_decision_logs に decision_source（llm / correction:* / signal:* / guard:viewing / guard:first_contact）・scene_evidence・analysis_mode・analyzed_msg_ts・suggested_check_pattern。generate-reply は body_block_code を最新の判断の行に書く
  - 採択率ゲート: 読み先を SOURCE_ACCEPT_RATE:{a}:brain（trigger_action_rules）→ **brain_aix_feedback**（feedbackGateRate）。**null 化は外し** required→recommended 降格（押された判断の中の一致率 <35%・pressed≥10）だけ。aix_suppressed_by_accept_rate は常に false（互換）
  - 新 cron `/api/cron/brain-aix-eval`（毎日 11:20 UTC）: pairBrainDecisions（次の判断 or 24h までに最初に押された AIX・30分以内の連続押しは1件・acknowledge_check=property_check_result）→ actual_*/matched 書き戻し → brain_aix_feedback に action / action_cp / decision_source / scene_staff を upsert（n≥10）。**trigger_action_rules には書かない**
  - 基準（2026-09-12・30日）: 判断281／押し727／判定264中一致92。action あり190中一致27、そのうち AIX が押された56中27（48%）。action=none は 65/74 が「押されなかった」
  - aix_feature_suggestions に4件（aix-shadow-eval で predictor=brain／log-aix-usage に brain_suggested_*／suggestion_source と suggestion_accepted の数え方／aix-weekly-learning の check_pattern 食い違い）
  - 1〜2週間後の確認: ブレインだけ当たっていた27件相当を落としていないか・場面だけ当たっていた7件相当（S5 meeting_place 等）を拾えているか（scratchpad/scene-vs-staff.ts の A2 と同じ集計）

## （旧）AIX で送る場面は resolveReplyAix 1関数（竹内方針A フェーズ1・2026-09-12）— 段1で上書き済み
- **場面判定は `app/lib/aix-reply-set.ts` resolveReplyAix だけ**。旧 detectAixTiming・AIX_BOUNDARY_TO_ACTION・トレーラーの優先順位（required>brain>aix_timing>hint）は廃止。場面表 S1 空室／S2 入居日（mgmt_move_in・退去予定は vacate_date）／S3 審査（mgmt_guarantor）／S4 内覧／S5 日時指定→meeting_place（bridge=null）／S6 見積／S7 条件変更。場面 > 断言コード > brain の推定の順（1関数の中）
- 生成後は assertionHits（断言・AIX境界コード）と unresolvedBlock（直せなかった block）を足して同じ関数を呼び直し、SUGGESTED_AIX トレーラーと **ai_draft_check.suggested_aix** に保存（check_pattern・timing・bridge 付き）。required は ai_draft="[AIX誘導中]"（suggested_aix_button への書き込みは廃止）
- 時間枠の「空いて」・入居日/審査の質問・橋渡し文は `app/lib/scene-patterns.ts`（依存ゼロ）。後処理の断言置換文も同じ定数（ASSERTION_REPLACEMENT）
- A-3 誤検出修正: SCREENING 願望形・VACANCY 時間枠・MOVEIN 条件の並び・DISCLOSURE キャンセル・E6（検索宣言／isMoveOutReleased を route と共有／号室違い）。audit block 33→25/758（3.3%）。a8aa132e も E6 が route と同じ解除判定になったため外れた
- 未実施: page.tsx（hydrate で chk.suggested_aix を表示・runBrainAix に check_pattern）、フェーズ2（パターンCR・750・reply-context:166）、フェーズ3（brain reply_mode・suggest-next-action）、scripts/audit-aix-set-vs-staff.ts

## 「ご連絡お待ちしております」「承りました」は場面で使う・「次第すぐに」を塞ぐ（竹内方針B・E・2026-09-12）— 黄金ルール
- **2語は禁止語（BANNED_WORDS_DETERMINISTIC）から外した**。根拠はプロンプトの文言だけで件数の根拠が無かった（9a452f16・d73b739f）。audit block 43→33/758（5.7%→4.4%）、baseline 更新済み
- **「ご連絡お待ちしております」の唯一の判定は `resolveAwaitContact`（reply-context.ts）**。resolveTurnPair が1回計算して `pair.awaitContact` に入れ、締め（resolveCloser の await_contact）・検査（AWAIT_CONTACT_MISPLACED）・stance の closer_kind が同じ値を見る
  - allowed: 条件の付かない連絡予告（依頼・質問・条件なし・検討/相談してから は除く）／「お待ちいただけますか」／了承だけで1つ前の顧客発言が予告。いずれも未履行のピックアップ約束が無いこと。時期をなぞる（「明日のご連絡お待ちしております😊！！」・今日→本日）
  - 条件付きの予告（〜次第・〜あれば）→ open_door で条件をなぞる（「決まりましたらいつでもお気軽にご連絡ください😌！！」「何かございましたら〜」）。検討・相談してから連絡 → 従来の wait_softly
  - 誤用は AWAIT_CONTACT_MISPLACED **warning**（依頼・質問・条件への返信か未履行の約束がある時。根拠が下書き削除 3/3 件と少ないので block にしない）
  - 既知の限界: 「近隣駐車場を調べてご連絡します」は analyzeSubstance が「駐車場」を condition と数えるので allowed にならない（保守側）
- **「承りました」**: 目的語の無い形（行頭・！！の直後）は `normalizeBareUketamawari`（banned-phrasing.ts・normalizeBannedPhrasing の中）で「かしこまりました」に置換。目的語付きは残し、キャンセル/内覧/希望の目的語が顧客の直近の発言3件に無ければ UKETAMAWARI_OBJECT_UNANCHORED **block**（`findUnanchoredUketamawari`・スタッフ実送信6通で偽陽性0・CODE_CAPS 0.5%）。修正版のプリスキャンも同じ関数（runAwaitUketamawariChecks）
- **「次第すぐに」**: `SHIDAI_HASTY_RE`（banned-phrasing.ts）を stripHastyAdverb の先頭に追加（20字超・一覧外の動詞の取りこぼし予防。入居・引越・住は残す）。HASTY_ADVERB_TEST_RE は2つの正規表現の合成＝除去と検査が同じ定義
- 注入・出力の穴: brain-core の優良返信例・成約例、enhance-reply の実例と出力、generate-reply-patterns の実例、polish-draft の実例と出力に normalizeBannedPhrasing（＋方針Dの fixExampleWeekdays）を通した
- プロンプト: line-reply-prompts（GENERATION_SYSTEM・SMORA_COMMON_RULES・713 の許可文・一時保留の括弧書き削除）、route.ts NG_PHRASE_NOTE ⑦⑮ を新ルールに。正例（608/703/1082/844/1737）はそのまま
- AIX 側はコードに触らず aix_feature_suggestions に登録: 97fa9db0（S1 全力サポート「次第すぐに」）・2ac5861f（S2 物件確認した MGMT 定型文）
- 竹内さんの画面作業（提案のみ）: 改善案タブの aix_edit 候補7件（「すぐに」入り）の採否、テンプレ 642f8b5c の「新着で出次第すぐに」
- テスト: `npx tsx app/lib/__tests__/await-contact.test.ts`（30）・banned-phrasing.test.ts に H6〜H9

## 呼び名は元の名前で固定（竹内方針C・2026-09-12）— 黄金ルール
- **呼び名の決定は `resolveAddressName`（validate-reply.ts）1つ。サーバーでは `resolveAddressNameForConversation`（app/lib/address-name-server.ts）経由で generate-reply と check-reply が同じ入力（DB名・履歴150件＝顧客発言・is_aix_generated 込み・窓）で決める**。旧 check-reply は窓内の表示名だけだった
- **元の名前の固定**: 最新の呼び名が名前の開示（名乗り「と申します」・申込フォーマットの申込者欄の最初の氏名・本人確認書類 OCR の「氏名」）と同じで、スタッフがその名前を初めて使ったのが開示より後、かつ開示の前は別の名前で呼んでいた → 開示前に最後に使った名前（source=staff_original_locked）。開示名・一時的に使った名前は aliases（unifyAddressAliases が元の名前へ戻す）。実測: yt・まりあ・Noriyuki の3会話で元に戻る時点の予測外れが解消（固定の発火11通）
- 開示名は呼び名に採用しない（清水さんの会話はフォーマットの氏名が同居の別人）。緊急連絡先・連帯保証人・同居人欄は開示に数えない。「〇〇です」は使わない。ローマ字⇔仮名の表記替え（Hitomi→ひとみ）は同じ名前＝固定しない（sameReading）
- **人間スタッフの呼び名を AIX より優先**（AIX の呼び名は人間の呼び履歴が無い時だけ。MATSUO YUYA 型）
- **確定名は再正規化しない**: `canonOf`（export）を nameNote・greetingNote・staffPromise の名前スロット（route.ts sanitizeCustomerName）・buildFirstGreeting・resolveGreeting・validateAndClean の fillNameSlot で使う（「りおなちゃんさん」を崩さない）。空白区切りの生の値は従来どおり姓
- 実測（messages 全体の呼びかけ2,004通）: 一致 1937（96.7%）。変更前 1943/2003 との差は、一時切替中のスタッフ送信が「方針Cには一致・スタッフ実績とは不一致」になった分。audit block 43/756 のまま
- 未対応（竹内さん確認待ち）: page.tsx extractPreferredName の廃止（2通目の「さん」抜け 4534・9762 を含む）。AIX 側の呼び名一本化は aix_feature_suggestions 455e9fba（S3「[呼び名] AIX の呼び名を返信AIの呼び名決定と揃える」）で提案。コードは直接直していない
- テスト: `npx tsx app/lib/__tests__/name.test.ts`（26: R6〜R9・N1〜N3・H1 を追加）

## 曜日は日付を正・日本時間で計算（竹内方針D・2026-09-12）— 黄金ルール
- **日本時間の日付・曜日は `app/lib/jst-date.ts` の関数だけで計算する**（jstParts / jstYmd / jstMD / jstMDHm / jstDateLabel / jstYmdWeekday / jstDayStartMs / jstWeekMondayYmd / weekdayForMonthDay / weekdayTable / fixDateWeekdays）。書き方は「+9h→getUTC*」の1通り。+9h した Date にローカル getter（getMonth/getDay 等）は禁止（ローカル実行で +18h）
- 根本原因: 下書きの曜日の食い違い 26/331件中24件が前年（2025年）の暦＝LLM が明日以降の曜日を自分で計算していた → generate-reply の dateNote と brain の【時間情報】に **14日分の曜日表** を渡し「表に無い日付には曜日を付けない」
- 安全網: 後処理 TYPO_WEEKDAY_MISMATCH（typo-check）は jst-date の correctDateWeekdayMatch を使う（typo-check.weekdayFor は weekdayForMonthDay の再エクスポート）
- few-shot 衛生: example-hygiene.fixExampleWeekdays を注入直前に通す（created_at が分かる経路＝その日の暦で付け替え／pgvector RPC は created_at が無いので食い違う曜日だけ外す）。DB の行は書き換えない
- 実害修正: brain-core の【すでに送付済みの物件】送付日（timeZone 抜けで UTC 日付・sent_properties 144行）→ jstMD。bg-async の条件バナー時刻・daily-brief の曜日 → jstParts。reply-kpi の週キー → JST の月曜
- AIX 側は aix_feature_suggestions a3cc50bf（[曜日] AIX 生成文の曜日を日本時間の暦で補正する）で提案。コードは直接直していない
- 未対応（竹内さん確認待ち）: fill-estimate の作成日（UTC）・property-tasks / hanbancyo-webhook の todayStart（UTC 0時＝JST 9時境界）
- テスト: `npx tsx app/lib/__tests__/jst-date.test.ts`（16）・hygiene.test.ts に W1〜W4

## 見積書の文脈理解（Fable5・2026-09-08）— 黄金ルール

**見積書は state 非依存。解禁は4証拠（費用質問／見積依頼／特定物件送付／送付後前向き反応）＋約束復唱のみ。判定は `isMisumoriContextAppropriate` の単一 verdict を三層共有。**

- **単一 verdict**: `app/lib/estimate-context.ts` の `isMisumoriContextAppropriate()` が `{ mode: declare | echo_only | forbid, trigger, severity, sentPropertiesCount, signals }` を返す。route.ts で1回だけ計算し、生成（`buildEstimateGateNote` → dynamicBlock）・AIX（`detectAixTiming.opts.estimateVerdict`）・検査（final-check `ctx.estimateContext` → E5 ESTIMATE_NO_TRIGGER / E10 TIMING_VOCAB_MISMATCH / ESTIMATE_REPEAT_PROMISE）が同じオブジェクトを参照する。
- **優先順位**: closed_won / brain.avoid_topics ハード禁止 → 顧客の見積依頼（送付済みでも再解禁） → 約束済み＝echo_only（新物件＋費用質問は除外） → 費用質問 → 顧客の物件送付（暗黙の見積依頼） → 送付済み∧前向き反応（条件変更が主題なら不可） → 直前約束の復唱 → none。
- **廃止した誤ルール**: VOCAB_STEP_TIMING「主戦場は viewing・applying／禁止 first_reply・hearing」（state 起点）、`AIX_MONEY_QUESTION_RE`（語出現）、route.ts 独自 `hasPropertyRef`/`asksCost`/`staffPromisedEstimate` regex、brain-core 信号0.96/1 の独自 regex、final-check E5 の `tpoAllows` 死んだ免除、`sentPropertiesCount` インライン式3重複（→ `countSentProperties()`・見積書画像・地図は除外）。
- **共有 RE**（line-reply-prompts.ts）: `CUSTOMER_COST_QUESTION_RE`（費用質問・「気になる／心配／抑えたい」含む）／`CUSTOMER_ESTIMATE_REQUEST_RE`（見積依頼）／`CUSTOMER_ESTIMATE_INTENT_RE`（両者 union・後方互換）／`CUSTOMER_PROPERTY_REF_RE`／`CUSTOMER_PROPERTY_POSITIVE_RE`／`STAFF_ESTIMATE_PROMISE_RE`／`CUSTOMER_CONDITION_CHANGE_RE`／`ESTIMATE_WORD_RE`（export・final-check ESTIMATE_RE と同一）。
- **「最大限割引」の2語彙分離**: (A) 訴求宣言「初期費用も最大限割引させて頂き〜」= 全 state 可。(B) 結合形「最大限割引した御見積書」= verdict declare 時のみ。条件フォーム（①〜⑧）のみ受信 → 見積語彙ゼロ・ピックアップ宣言。
- **将来課題**: `last_brain_meta.estimate_context` JSONB 保存（誤爆の実値再集計）、`SuggestedAixMeta.cost_question / property_reaction` 追加で customer_questions の regex 走査撤去。

---

## 残存ギャップ統合修正 S/A（Fable5・2026-09-08）

TPO判定の「上流と両脇」4層を修正。設計書の優先度S 5件・A 16件を実装（設計知見5件は system_design_thinking に INSERT 済み）。

- **状態層（S-2）**: `resolveState()` が phase / guideKey / searchState の3値を返す単一入口。`viewing` 独立復活・`closed_lost` 新設（PHASE_GUIDE.closed_lost）・未知 state は `state:unknown` ログ＋「初回挨拶を出さない側」へフェイルセーフ。`buildGenerationMessages(..., phaseGuideKey, isConditionPresented)`。STAGE_JP に viewing / closed_lost。
- **名前層（S-5）**: `validate-reply.ts` に `normalizeCustomerName` / `checkNameConsistency`（NAME_MISMATCH / NAME_PLACEHOLDER / NAME_FULLNAME_LEAK / NAME_OVERUSE）。route.ts の貪欲 NAME_MISMATCH ブロックは廃止。final-check `ctx.customerName / allowNames / phaseKey` 追加。
- **鮮度層（S-3 / A-7 / A-9）**: `effectiveAction`（message-local action は fresh かつ非cached のみ）。reply_direction / key_topics / engagement_stance も同ゲート。stale 時は `STATE_FALLBACK_DIRECTION[phaseGuideKey]`。`AIX_ACTION_REPLY_DIRECTION`（aix-taxonomy）で顧客向け方向性を注入（スタッフ操作文の二重注入廃止）。bg-async は burst 検出時に brain を1回再実行（残予算不足なら brainMetaDirect を渡さず T2）。
- **検査対称性層（S-1 / S-4 / A-2 / A-3 / A-11 / §5）**: `GRATITUDE_POS_RE` の `OK`/i が TikTok に一致していた境界バグ修正。final-check 開口語チェックは初回免除＋挨拶ブロック剥がし、INTRO_REPEAT は MEDIA_ONLY 除外。`runDeterministicChecks` を export し、final-check 例外時の決定論 fail-open（A-2）と後処理後の再検査→ハッシュ更新（A-3）。`runDeterministicExtras`（BANNED_PATTERNS / SYSTEM_MARKER_LEAK / EMOJI_RULE_DET / PROMISE_ECHO_MISSING / ESTIMATE_NO_TRIGGER / VIEWING_BEFORE_VACANCY / APPLY_WITHOUT_INTENT / TENSE_MISMATCH / FEEDBACK_PREMATURE / GOCHOUGO_AFTER_FIXED / STATE_REGRESSION）。`PHASE_PROHIBITIONS`（prompts）を生成・検査で共有。check-reply は ai_draft_check.tpo_debug から tpo_label / phaseGuideKey を引いて ctx に渡す。
- **TPO（A-1 / A-4 / A-5 / A-6 / A-12 / A-13）**: `[スタンプ]`・絵文字のみは短い了承。不安対応 `isAnxietyMsg` を applying より先に評価。`shortAckPromise` で「短い了承」ラベルと promiseEchoNote を同述語化。リスケ要望は内覧確定締めにしない。条件提示×condition_change の衝突解消。
- **prompts（A-15 / §4）**: 例文の「すぐに」「承知しました」除去、部屋の「抑え」→「押さえ」統一（43箇所）、`PHASE_COMMON_FORMAT` を全 PHASE_GUIDE 先頭に連結、STYLE_RULE 更新、NG_PHRASE_NOTE ⑪〜⑯。
- **監査**: `ai_draft_check.tpo_debug` に phaseGuideKey / rawState / stateKnown / rawAction / effectiveAction / isCachedMeta を追加。ログ `state:unknown` / `brain:stale-action-dropped`。
- **未実装（B群・次回）**: 英語了承語、深夜挨拶、RENT_RE 数値制限、BROAD_AREA、final_check_codes カラム（migrate-schema 同時更新必須）、lastStaffMsg 4定義の統一、営業日判定共通化。

---

## AIX 待ち合わせ場所 Brain 一本化（2026-09-02）

内覧日調整中に「待ち合わせ場所」AIXを送っても Brain が物件名・住所を把握できていなかった根本バグを修正。

**根本原因（4点）:**
1. `viewing_history` に `property_name`/`property_address` カラムなし → 物件名・住所がDB保存されない
2. `log-aix-usage` の `STAGE_TRANSITION_AIX_TYPES` に `meeting_place` 未登録 → Brain メタパッチが走らない
3. `brain-core.ts` が `viewing_history` から日時・ステータスのみSELECT → viewingsText に物件情報なし
4. AixModal → page.tsx → log-aix-usage の property 情報の橋渡しなし

**修正（5ファイル・commit `d2a86b1d`）:**
1. `migrate-schema`: `viewing_history` に `property_name TEXT / property_address TEXT` 追加
2. `log-aix-usage`: `meeting_place` を `STAGE_TRANSITION_AIX_TYPES` に追加 + 物件名・住所を含む動的 stageNote で Brain メタパッチ + viewing_history の最新未完了予定に upsert
3. `brain-core.ts` 2箇所: viewing_history SELECT に `property_name, property_address` 追加 + viewingsText に「物件: 〇〇 住所: 〇〇」を注入
4. `AixModal.tsx`: `onAfterSend` 型に `meetingPropertyName/meetingPropertyAddress` 追加 + 両コールサイトで値を渡す
5. `page.tsx`: `log-aix-usage` fetch に `meeting_property_name/meeting_property_address` を追加

**動作フロー（修正後）:**
```
meeting_place AIX 送信
 → AixModal.onAfterSend に meetingPropertyName/Address を乗せる
 → page.tsx が log-aix-usage に送信
 → log-aix-usage が viewing_history.最新予定 に property_name/address を PATCH
 → STAGE_TRANSITION で Brain メタパッチ起動（「案内物件: 〇〇（住所: 〇〇）内見当日完了」）
 → 次回 brain-core.ts フル分析で viewingsText に「物件: 〇〇 住所: 〇〇」が注入
 → generate-reply が物件名・住所を把握した状態で返信生成
```

---

## AIX物件本文（property_send / property_recommendation）品質スタック強化（2026-08-29）

文の基本構成は不変のまま「訴求の質」を generate-reply / aix-template-generate 同等に引き上げた。

- **新学習バケット**: `ai_reply_examples.entry_source='aix_property'` — aix_usage_logs の実送信AIX物件本文。`is_starred = customer_reacted`。初回バックフィル527件（rec 299/⭐146・send 228/⭐140）＋embedding全件生成済み
- **新cron**: `/api/analyze-aix-property`（毎週日曜UTC22:00）。冪等ガード `aix_usage_logs.property_example_backfilled_at`（migrate-schema反映済み・本番DB適用済み）。customer_message = 直前顧客3件＋AIX-META主要フィールド（ベストエフォート）
- **RPC拡張**: `match_aix_reply_examples` の entry_source に 'aix_property' 追加（本番適用済み。match_reply_examples は不変）
- **aix/action 強化**（property_send / property_recommendation 限定）:
  1. `getWinningPatternsForProperty()` — match_winning_patterns RAG＋AIX-META再ランキング（checkpoint一致+0.12 / intent一致+0.15 / win_rate×0.1・aix-template-generate H2と同方式）
  2. `getAixPropertyExamples()` — aix_property実例5件（⭐優先）をfew-shot注入
  3. AixLocalBrainMeta に customer_intent / winning_pattern / repeated_concern / human_type_label 追加 → brainContext（RAGクエリ）＋brainGuidanceNote（🧭インテント別訴求ガイド・🔁繰り返し懸念・🏅成功パターン）に配線
  4. キャッシュ設計不変: 新規注入は全てuser側 or 動的systemブロック（静的ブロックのキャッシュHIT率を壊さない）
- **不変**: generate-reply / match_reply_examples / 文の基本構成（🌟フォーマット・①〜⑥構成）は一切変更していない

---

## ⚡ 作業開始前に必ず実行（LINE返信AI作業のたびに毎回）

```sql
SELECT title, insight, rationale
FROM system_design_thinking
WHERE is_current = true
ORDER BY created_at DESC
LIMIT 10;
```

このテーブルに設計思想・アーキテクチャ判断・禁止パターンが蓄積されている。読まずに作業を始めると設計からぶれる（2026-08-25 実証済み）。

### 思った通りに行かない返信・AIX が届いたら（2026-09-12 竹内）— 抜けの見つけ方
```sql
SELECT title, insight FROM system_design_thinking
WHERE is_current = true AND 'ブレイン診断' = ANY(tags);
```
1. 上の「抜けの見つけ方（ブレイン原因診断の型）」の6種類（G1 分類／G2 再分析の引き金／G3 判断／G4 約束→AIX／G5 矯正の誤発火／G6 古い判断の注入）のどれかに当てて診断する（手順①〜⑧）
2. 直したら設計知見に **`穴:Gn` タグ付き**で登録する（同じ種類の過去の直し方を `'穴:G4' = ANY(tags)` で引ける）
3. 先回り: `npx tsx --env-file=.env.local scripts/find-brain-gaps.ts --days=30`（読み取りのみ。G1〜G5 を件数順に束ねて例を出す。出力は個人情報を含むので共有しない）。件数の多い束から直す
   - 2026-09-12 初回: G4「募集状況確認＋確認出来次第お見積書」の複合宣言の後はスタッフが先に【物件確認した】を押す（5件・今の規則は見積書送る）／G1 セルなし 295/882（直前 other×顧客 other 78・物件送付×other 43・ピックアップ宣言×other 36 等）が次の候補
   - 2026-09-12 対応済み: G4 複合宣言 → `resolveStaffPromiseAix` が見積書の宣言でも本文に募集状況の確認宣言があり、お客様の確認依頼がある時は物件確認した（150日: 最初の AIX 48件中 物件確認した 34件＝71%。確認の後に見積書が続いたのは 34件中 11件なので見積書は連鎖させない）。G4 23件→残りは「新着出次第」の条件付き宣言（規則の対象外で正しい）・初回挨拶→条件ヒアリング 5件（初回挨拶の後は物件ピックアップした 60/70＝86% なので規則は維持）
   - 道具の注意: aix_usage_logs は生成時刻 created_at が送信時刻 sent_at より前。押下より前の AIX は `sent_at ?? created_at` で絞り、押下自身を除く（created_at で絞ると押下自身が「履行済み」に数えられ、規則が何も返さないように見える）

---

## 🏗️ 静的/動的レイヤー設計の絶対原則（2026-08-25 確立・system_design_thinkingに永続化済み）

### 設計の対比概念（必ず理解してから作業する）

| レイヤー | 何を入れるか | 実装場所 |
|---------|------------|---------|
| **静的（Static）** | 全顧客共通の汎用ルール・口調原則・横断的パターン | `ai_reply_knowledge`（importance=10→staticBlock / 7〜9→dynamicBlock RAG） |
| **動的（Dynamic）** | 会話ごとの文脈・戦略・顧客固有の状況分析 | AIX-META（`suggested_aix_meta`）→ `brainContext` → RAGクエリ拡張 |

### ai_reply_knowledge への登録禁止事項（毎セッション必ず守る）
- **特定顧客の成約会話JSON・対話ログをそのまま登録禁止**（必ず汎用パターンに抽象化する）
- **content 1000字超のエントリ登録禁止**（500字以内に圧縮してから登録）
- **「あさみさん」「大野さん」等の個人名をタイトルに含む知識エントリ登録禁止**
- **特定日付・特定時期（「7月末」「10月頃」等）を含むルールは登録不可**（time-boundなため）

### なぜぶれが起きたか（2026-08-25 調査結果）
この設計思想は「概念として命名・定義されたことが一度もなかった」のが根本原因。毎セッションのClaudeが文脈から自己推論して実装→間違いを繰り返す構造だった。`system_design_thinking` に12件以上の関連エントリはあったが対比概念の命名がなく判断基準が共有されていなかった。

### staticBlock vs dynamicBlock の境界判断基準
- `staticBlock`（cache_control:ephemeral・1h TTL）→ byte-stable・全顧客共通のテキストのみ
- `conversation_state` フィルタを通るルール → dynamicBlock に入れる（静的注入しない）
- DB由来でも「全顧客共通絶対原則（importance=10）」のみ staticBlock に入れてよい

---

## 最終チェック 接地付き自動修正ループ（前頭前野モデル v2 / 2026-08-14）

生成時の最終チェックが「チェック→接地修正→再チェック」のループになった（チェックは計2回上限・ループカウンタで強制）。

- **場所**: `app/lib/final-check.ts` の `runFinalCheckWithRevision()`。`generate-reply/route.ts` はこれを1回呼ぶだけ（旧 `runFinalCheck` + `runAutoRevision` の組み合わせを置換。`runAutoRevision` は削除済み）
- **フロー**: check1(3パス並列 ≤2.5s) → 指摘0件はそのまま / warningのみは接地修正1回・再チェックなし / **blockありは接地修正(≤3.5s) → check2(≤2.5s)**。worst 8.5s（budget 9.5s・不足時は修正スキップ）
- **接地（ハルシネーション防止）**: 修正Haiku（claude-haiku-4-5・構造化出力）は checkpoint事実 [CHECKPOINT]・顧客条件 [CONDITIONS]・DBルール [RULES] のみを根拠に修正。"replaced" は `ground_truth_quote` の引用必須で、コード側が正規化substring照合で実在検証。引用が根拠情報に無ければ**修正全体を破棄**（決定的ガード。プロンプト任せにしない）
- **採用条件**: 修正版は再チェックで元blockを検出したpassが完走し、block数が減った場合のみ採用。block 0件=クリーン採用、減少=`revision_exhausted: true` 付き採用、改善なし/修正失敗=元ドラフト+check1のまま（強制置換しない→既存の送信確認モーダルでスタッフ確認）
- **監査**: `CheckResult` に `revision_count`（0 or 1）と `revision_exhausted` を追加。FINAL_CHECKトレーラーと `ai_draft_check`（JSONB・カラム追加なし＝migrate-schema変更不要）に載る
- **UI（page.tsx）**: 修正成功時はバッジが「✅ N回修正で問題解消」、修正不能時は指摘リスト末尾に「🤖 AIが自動修正を試みましたが解消できませんでした」
- **不変条件**: check-reply/route.ts（スタッフ編集後の再チェック）は従来どおり `runFinalCheck` のみ・自動修正は絶対にしない（越権禁止）。チェック/修正の失敗は全て fail-open

---

## LINEリプライ（引用）による物件興味判定（2026-07-11）

お客様が物件カードに引用リプライで「ここも気になるかもです！」→ 従来は「気になる物件のURLをお送りください」と的外れ回答していた問題への対応。パターンB（即効プロンプト）+ パターンA基盤整備（引用データの蓄積）を同時実施。

- **パターンB（即効）**: `generate-reply/route.ts` に `QUOTE_REPLY_JUDGE_NOTE` を常時注入。「ここ/こちら/気になる/いいですね/見たい」+ 直近スタッフの物件画像・物件URL送付 → 直前物件への興味と判定し内覧日程調整の方向で生成
- **パターンA基盤（4ファイル）**:
  1. `line-webhook/route.ts` — webhookの `quotedMessageId`（LINE API 2023年9月〜）を `messages.quoted_message_id` に保存（従来は捨てていた）
  2. `migrate-schema/route.ts` — `messages.quoted_message_id TEXT` + インデックス追加。**本番DBにも適用済み**（execute_sql直接実行）
  3. `page.tsx` — スタッフ送信後に send-line-message の `sentMessageIds[0]` を送信前insert行の `line_message_id` に書き戻し（executeSend / sendMessageText 両フロー・テキスト+画像。複数画像は1行にまとまるため先頭画像のidを代表記録）
  4. `generate-reply/route.ts` — `fetchQuotedContext(conversationId)`: 最新顧客メッセージの `quoted_message_id` → `messages.line_message_id` でJOINし「このメッセージは○○への引用です」を最優先文脈としてプロンプト注入（Promise.all並列・失敗時は空文字フォールバック）
- ⚠️ 引用先特定はスタッフメッセージの `line_message_id` が貯まってから効き始める（実装日以降の送信分から有効）。それまではパターンBが受け皿

---

## 引き継ぎ（2026-07-08）

### mgmt_guarantor 大型改善 — 完了
変更対象4ファイル:
1. `app/lib/line-reply-prompts.ts` — 株式会社日本トラストコーポレーション（日本トラスト）を独立系リストに追加
2. `app/components/AixModal.tsx` — 新state追加・canGenerate更新・generate()分岐更新・UI全刷新（テキスト入力・タイプ選択・任意画像OCR・任意誘導ボタン）
3. `app/api/aix/action/route.ts` — mgmt_guarantorハンドラー全刷新：テキスト入力優先・画像OCRはフォールバック・独立系の説明強化・誘導任意化・画像あり時early return（doc_image_url付き）
4. `app/api/extract-guarantor-info/route.ts` — 新規作成：FormData受信→Claude Haiku Vision→{ok, property_name, company_name, guarantor_type}返却

主な改善点:
- 保証会社名と物件名をテキスト入力で渡せる（OCR不要）
- 独立系の説明: 「審査基準緩く、審査通過する可能性十分に御座います！！」
- 誘導（申込/内覧）は任意（報告のみで送れる）
- 画像がある場合は画像を先に送る（doc_image_url経由）
- 日本トラストが「不明」→「独立系」に正しく分類

---

## 部署概要

スモラのLINE営業AIシステム。お客様メッセージに対して文案を生成し、使うたびに自己学習して品質を永久に高め続ける。

---

## チーム体制（三位一体）

| 分身 | 役割 |
|-----|------|
| #L-AI 竹内AI分身 | ビジョン・判断・☆の基準定義 |
| #L-SZ 鈴木AI分身 | 実装・運用・即実行 |
| #L-SM スモ山分身 | 部署全体統括・抜け漏れ防止 |

---

## ⚠️ システム全体アーキテクチャ（必読）

```
LINEメッセージ受信
  → Next.js /api/line-webhook（Vercel）
      → Supabase に保存

管理画面「文案生成」ボタン
  → Next.js /api/generate-reply（Vercel）
      → phrase_dictionary + ai_reply_examples + ai_reply_knowledge を注入
      → Claude Haiku で返信案生成

AIX ボタン（物件オススメ・内覧へ・申込へ・見積書）
  → AixModal.tsx → Cloudflare Worker /api/aix/action
      → phrase_dictionary から専用カテゴリ15件を取得（priority DESC）
      → Claude Sonnet 4.6 で生成（Vision対応）

⚠️ Cloudflare Worker 内の Webhook・generateReply・classifyIntentWithAI は
   Next.js 移行済みのデッドコード。触らなくてよい。
```

---

## 管轄ファイル

| ファイル | 役割 | 場所 |
|---------|------|------|
| `app/api/generate-reply/route.ts` | 文案生成（管理画面ボタン）・Claude Haiku | Next.js |
| `app/api/save-reply-example/route.ts` | 例の保存 + Claude深層分析 | Next.js |
| `app/api/line-webhook/route.ts` | LINEメッセージ受信・Supabase保存 | Next.js |
| `app/components/AixModal.tsx` | AIXボタンUI・Worker呼び出し | Next.js |
| `sumora-ai-core/workers/index.js` | AIXアクション実行・Claude Sonnet呼び出し | Cloudflare Worker |

---

## AIX ボタン詳細（Cloudflare Worker）

### Worker URL
`https://sumora-line-ai.takeuchi-homeys.workers.dev`

### 各ボタンの仕組み

| ボタン | phrase_dictionary カテゴリ | モデル | 入力 |
|--------|--------------------------|-------|------|
| 🏠 物件オススメ | `property_recommendation`（15件） | Claude Sonnet 4.6（Vision） | 条件スクショ＋物件資料の2枚 |
| 💰 見積書送る | なし | Claude Sonnet 4.6（Vision） | 見積書画像 |
| 🔍 内覧へ！ | `viewing_invite`（15件） | Claude Sonnet 4.6 | 候補日時（任意） |
| ✋ 申込へ！ | `application_push`（15件） | Claude Sonnet 4.6 | 補足情報（任意） |

### 必要な環境変数（Cloudflare Worker Secrets）
```
ANTHROPIC_API_KEY   ← AIXボタン生成用（要登録）
OPENAI_API_KEY      ← Webhook自動返信用（デッドコードだが残存）
SUPABASE_URL
SUPABASE_ANON_KEY
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
```

### ANTHROPIC_API_KEY の登録方法
```powershell
cd "c:\Users\竹内 悠馬\sumora-ai-core\workers"
npx wrangler secret put ANTHROPIC_API_KEY
# → プロンプトが出るのでキーを貼り付けてEnter
```

---

## 管轄DBテーブル

| テーブル | 役割 |
|---------|------|
| `ai_reply_examples` | 実際に送った返信の蓄積（☆・AI使用フラグ付き） |
| `ai_reply_knowledge` | Claudeが抽出したパターン・口調・フレーズ・原則 |
| `phrase_dictionary` | カテゴリ別フレーズ辞書（AIX・generate-reply 両方で使用） |

---

## phrase_dictionary 管理状況

| 日付 | 件数 | 作業内容 |
|------|------|---------|
| 2026-05-25 | 438件 | 初期状態 |
| 2026-05-25 | 380件 | Round1: 不要フレーズ削除 |
| 2026-05-25 | 346件 | Round2: AI感・重複・硬すぎる文を削除 |
| 2026-05-25 | 318件 | Round3: 長すぎる文を短縮・削除 |
| 2026-05-25 | 300件 | Round4: 重複クラスター解消・ボトルネック除去・ハードコード修正 |

### Round4 削除内訳（18件）
- 敷金礼金0 重複（id:116・328 削除、100 残存）
- スーパーコンビニ 重複（id:326 削除、299 残存）
- インターネット無料 重複（id:48・193 削除、329 残存）
- 特にオススメ 重複（id:291 削除、292 残存）
- "ので"で終わる断片文（id:252 削除）
- 間取り説明 重複（id:295 削除）
- property_search_start 重複4件（id:211・101・140・141）
- viewing_invite 重複6件（id:195・375・12・25・402・403）

### Round4 修正内訳（6件）
- id:40 「1件」のハードコード除去
- id:166 「1台」のハードコード除去
- id:311・323 "〜となっております" 二重表現を短縮
- id:515 回りくどい説明を短縮
- id:226 「1件目に」を除去

---

## 学習ループ（永久機関）

```
送信 ─────────────────────────────────────────┐
  ↓（自動・毎回）                               │
ai_reply_examples に保存                       │
  ↓（☆ or 手動インポート）                     │
Claude Haiku が深層分析                        │
  ↓                                           │
ai_reply_knowledge に蓄積                      │
  ↓（次回のgenerate-reply）                    │
knowledge + examples をプロンプトに注入         │
  ↓                                           │
より良い文案 ── スタッフが送信 ─────────────────┘
                      ↑
               永久に回り続ける
```

---

## conversation_state 一覧

| state | 意味 |
|-------|------|
| first_reply | 初回返信 |
| condition_hearing | 条件ヒアリング中 |
| property_search | 物件探し中 |
| property_recommendation | 物件提案 |
| viewing | 内覧 |
| estimate_request | 見積もり依頼 |
| availability_check | 空き確認 |
| application | 申込 |
| screening | 審査 |
| contract | 契約 |
| closed_won | 成約済み |

---

## 📐 表記ルール（絶対ルール）

| ルール | 詳細 | 根拠 |
|--------|------|------|
| **号室の先頭0は省略** | 0806号室 → 806号室、0102号室 → 102号室 | 日本の賃貸物件の号室は0から始まらない。資料の印刷フォーマット上0が付くだけで、表記上は不要 |

実装済み対応（2026-06-20）:
- `app/api/aix/action/route.ts` のプロンプトに「号室番号は先頭の0を省略すること」と例示を追加
- 生成後の後処理で `/\b0+(\d+)号室/g` → `$1号室` の正規表現で強制除去

---

## SYSTEM_PROMPT 管理（#L-PR）

### 現行バージョン（2026-05-25）

generate-reply/route.ts と Worker index.js の両方に同一のSYSTEM_PROMPTが存在する。
スモラLINE営業AI。丁寧・親しみやすい・営業感強くない。
詳細な説明ルール（具体的な築年・帖数・徒歩分）、内覧誘導・申込誘導の文例含む。

→ 詳細: `app/api/generate-reply/route.ts` の `SYSTEM_PROMPT` 定数

---

## ナレッジ現状（#L-KN 管理）

| 日付 | ai_reply_examples | ai_reply_knowledge | 備考 |
|------|------------------|-------------------|------|
| 2026-05-24 | 0件 | 0件 | テーブル作成直後・インポート待ち |
| 2026-05-25 | 10件 | 94件 | NAOさんとのやりとり9ペアをインポート・Claude深層分析完了 |

---

## KPI履歴（#L-QC 管理）

| 日付 | ai_use_rate | star_rate | edit_rate | 備考 |
|------|------------|-----------|-----------|------|
| 2026-05-24 | 未測定 | 未測定 | 未測定 | データ蓄積待ち |

---

## インポート履歴（#L-IMP 管理）

| 日付 | インポート件数 | state 内訳 | 備考 |
|------|-------------|----------|------|
| 2026-05-25 | 9件 | first_reply×1 / condition_hearing×1 / property_recommendation×3 / viewing×4 | NAOさんとのやりとり。Supabase直接POST + Claude分析 |

---

## templates テーブル管理（AIXテンプレート）

### 「物件送る【AIX】」カテゴリ整備（2026-07-02）

実スタッフLINEメッセージ（ピックアップ報告A〜I）から10テンプレートを新規作成しSupabase `templates` に登録。
既存「1件のみ【申込訴求】」はエッジケースのため sort_order=10（末尾）へ移動。

| sort | ラベル | 使う場面 |
|------|-------|---------|
| 0 | 【基本】ピックアップ完了 | 最頻。物件送付時の標準報告 |
| 1 | 【条件明示】ピックアップ完了 | ヒアリング済み条件を復唱して送るとき |
| 2 | 【見積書同封】ピックアップ完了 | 物件＋最大割引見積書を一緒に送るとき |
| 3 | 【条件に近い】完全一致なし | 完全一致がなく近い条件で送るとき |
| 4 | 【ピックアップ予告】本日中にお送り | すぐ送れず後で送ると約束するとき |
| 5 | 【間取り幅広げた】ピックアップ完了 | 希望間取りが少なく近い間取りも加えたとき |
| 6 | 【ペット可リスト】物件名リスト送付 | ペット可物件を物件名箇条書きで送るとき |
| 7 | 【全件案内可能】全部ご案内できる | 送った物件が全て内覧可能と伝えるとき |
| 8 | 【現状全部】引き続き新着出たら連絡 | 現状出し切り・新着待ちに切り替えるとき |
| 9 | 【過去気に入り＋新規】両方お送り | 過去気に入り物件の状況＋新規を併送するとき |
| 10 | 1件のみ【申込訴求】（既存） | 条件に合う部屋が1件のみ・申込訴求 |

全テンプレートに構成①②③（structure jsonb）付き。プレースホルダーは「アカウント名さん」「〇〇駅周辺全域」「〇LDK」「〇部屋」等で統一。

---

## 「管理会社に確認した」専用フロー（2026-07-02）

page.tsx のピッカー3ボタンが `check_pattern` をAIXモーダルへ直接引き継ぐ方式に変更。
モーダル内の「空室あり/なし/代替」選択が不要になり、テキスト入力のみで生成可能。

| ピッカー | check_pattern | 入力例 | 生成フォーマット |
|---------|--------------|--------|----------------|
| 退去予定日について | `vacate_date` | 退去予定日：7月31日退去確定 | 退去日報告＋内覧解禁日（退去日の翌日）＋内覧誘導 |
| 入居日について | `mgmt_move_in` | 入居可能日：8月上旬〜 | 入居可能時期報告（即入居可対応） |
| 初期費用について | `mgmt_initial_cost` | 初期費用：礼金なし・敷金1ヶ月 | 費用報告＋費用が安い場合は訴求文 |

- AixModal: `initialCheckPattern` prop 追加。mgmt系パターン時は専用UI（パターンリスト非表示・テキスト入力必須）
- route.ts: `MGMT_PATTERNS` で固定フォーマット生成（物件名は会話履歴から特定・号室先頭0除去済み）
- 既存の `move_in_date`（画像OCR）とは別パターン。混同注意

---

## 申込へ！（application_push）改善（2026-07-04・B2）

監査で application_push の使用が0件（最重要クロージング段階で未使用）だったため改善。

- **原因（UX摩擦）**: ①提案バナー「開く」経由だとモード未選択で開き、申込誘導/確定＋申込パターンの2タップが必要 ②申込パターンにデフォルト選択がなく生成ボタンが無効のまま
- **UX修正**: `page.tsx openAixWithParams` が application_push 時に「申込誘導」モードをプリセット / `AixModal` の申込パターンを「シンプル申込」デフォルト選択に（生成まで0タップ）
- **プロンプト改善**（`app/api/aix/action/route.ts`）: simple/hold_view に【申込の流れ・不安解消（任意・最大1行）】を追加（申込経験者判定→説明省略 / 初回＋不安ありのみ LINE完結・審査通過までキャンセル無料・最短2週間入居 のいずれか1行）。scheduled テンプレにも不安時のみキャンセル無料1行追加の例外ルール
- **SMORA_COMMON_RULES 強化**（`line-reply-prompts.ts`）: 申込後の流れ4ステップ・最短2週間入居・審査通過前キャンセル無料を【不動産ドメイン知識】に追加（AIX全アクションに注入される）
- 備考: `page.tsx` の `triggerAixOneTap` は未使用のデッドコード（呼び出し箇所なし）。将来ワンタップ化するならここを配線する

---

## 書類依頼（docs_request）前提知識の修正（2026-07-08）

竹内悠馬の指摘により `app/api/aix/action/route.ts` の docs_request プロンプトを修正。

- 本人確認書類は「運転免許証」or「マイナンバーカード」の2択のみ（「等」禁止・表裏2枚必須）
- **保険証は申込時に不要**（保証会社・管理会社から請求された場合のみ）→ 依頼リスト・判断手順・フォールバック・例文から全て除去、【絶対禁止】に追加
- 参考知識として「個人事業主＝国保／正社員＝社保」を追記（書類判断には使わない）

---

## 保留・引き継ぎ事項

- [ ] **ANTHROPIC_API_KEY を Cloudflare Worker に登録する**（AIXボタンが動かない）
  ```powershell
  cd "c:\Users\竹内 悠馬\sumora-ai-core\workers"
  npx wrangler secret put ANTHROPIC_API_KEY
  ```
- [ ] 過去のLINEやりとりをインポートする（竹内悠馬が貼り付け予定）
- [ ] インポート後にKPI初回測定を実施（#L-QC）
- [ ] ai_use_rate が安定したらプロンプト改善サイクルを開始（#L-PR）

---

## テンプレソート順を複合スコア化（2026-07-04・B4）
- **並び順**: `TemplateModal.tsx` の一覧ソートを `score = use_count*0.4 + win_rate*100*0.6` の降順に変更。スコア同点は従来どおり sort_order 昇順（現状は全テンプレ score=0 のため表示は従来と同一・手動並べ替えも有効）

---

## 持込予告（will_send_later）の業務フロー統一＋example 前提ラベル機構（2026-09-10・Fable5・あみ事例）

### 事例
あみ（スモラ・物件提案中）。13:24 スタッフ「新着でオススメできるお部屋出次第お送りさせていただきます」（ピックアップ宣言・未実行）→ 15:32 顧客「こちらも気になる物件見つけたら送らせて頂きます！」→ 15:42 AI が「ごゆっくりご相談頂けますと幸いです／また出てきましたら随時ピックアップしてお送りします」を返した。
竹内指摘: **顧客は「相談」と一言も言っていない。顧客が物件を送ってきたら「募集状況の確認＋最大限割引した初期費用の御見積書」を返すのが業務フロー。**

### 根本原因（3つ）
1. `ANY_WILL_SEND` / `PS_WILL_SEND` の example が **rさんの「顧客が相談すると言った」場面の実文**で、前提ラベルが無いため LLM が丸写しした（NG 出力は example とほぼ一字一句同じ）
2. 業務フローの核（募集状況確認＋最大限割引の御見積書）が **`ES_WILL_SEND` の mustInclude にしか無かった**。PS/ANY は「随時ピックアップ」しか要求せず、(B)「我々に送って」場面の語彙が (A)「顧客が送る」場面に混入していた
3. `STAFF_PICKUP_DECL_RE` が「オススメできるお部屋…お送りします」「出次第お送り」に一致せず staff=other → `ANY_WILL_SEND` に落ちていた

### 実装（新コード）
- `reply-context.ts`
  - `CUST_WILL_SEND_RE` を一人称の授受表現のみに限定。`CUST_ASKS_US_TO_SEND_RE`（(B)依頼形）に一致する行は will_send_later から除外
  - `CUST_SEND_PERMISSION_RE`／`classifyWillSendObject()`（property/condition/document/unknown）／`CUST_WILL_SEND_SELF_PRED()` を新設。`PairContext.sendObject` を追加（**分岐軸は state ではなく sendObject**）
  - 業務フロー共有定数: `WILL_SEND_RECEIVE_CHECK_RE` / `WILL_SEND_ESTIMATE_FORECAST_RE` / `WILL_SEND_CONDITION_SEARCH_RE` / `WILL_SEND_ACCEPT_RE` / `isPropertyForecast()`
  - `PairMustInclude` に `when` / `severity` / `fix` を追加。`PairRule` に `examplePremise` / `exampleRequires` / `exampleFallback` を追加
  - **`PD_WILL_SEND` 新設**（pickup_declared × will_send_later＝あみのセル）。ES/PS/ANY_WILL_SEND を統一（example から「ご相談」「随時ピックアップ」を全削除）
  - `STAFF_PICKUP_DECL_RE` 拡張（「オススメできるお部屋…お送りします」「出次第お送り／ご連絡」）
  - `resolveCloser`: 持込予告はセル指定の closer を尊重（deliverableAttached より先。「最大限割引した御見積書」は予告であって添付ではない）
  - §10 `CUSTOMER_ANCHORED_VOCAB` / `checkGoyukkuriMirror()` / `hasGoyukkuriMirrorVerb()` / `buildVocabAnchorNote()`
- `final-check.ts`: `runVocabAnchorChecks()`（`UNANCHORED_VOCAB` / `VOCAB_MIRROR_MISMATCH`）、`PAIR_ELEMENT_MISSING` を `when`/`severity`/`fix` 対応、E5 フォールバックに持込予告免除、`VOCAB_MIRROR_MISMATCH` を block 維持リストへ
- `estimate-context.ts`: `customer_will_send_property` トリガー新設（**予告と実行でゲートの解禁条件を分ける**）。予告形1文のみ解禁・見積本体は従来どおり AIX 専用
- `route.ts`: estimate 入力に予告フラグ、`buildVocabAnchorNote()` を往復文脈ブロック直後に注入
- `line-reply-prompts.ts` `TIMING_FEWSHOT`: 持込予告の ◎/✗ 例3件を追加

### 黄金ルール（追加）
- **example には必ず「成立前提」を添える**。前提が今回成立しないなら実例文を渡さず「骨格のみ・文はそのまま使わない」に切り替える。修正ループの suggestion に example を使わない（NG 文の再注入経路）
- **禁止語を足す時は必ず正しい代替をリテラルで同時に渡す**（禁止だけだと同義語に逃げる。ご検討を抑制→ご相談が出た）
- **「ごゆっくり」の後続語は顧客の動詞の鏡写し**（検討／確認／相談／覧）。顧客がどれも言っていなければ「ごゆっくり」自体を書かない
- **「顧客が送る」(A) と「我々に送って」(B) は別場面**。regex レベルで分離する（語彙統計も分けないと汚染される）

### あみ 15:42 の期待返信（修正後）
```
はい😊！！
気になるお部屋ございましたらいつでもお送りください！！
お送り頂きました物件の募集状況確認させて頂き、最大限割引しました初期費用の御見積書とあわせてご連絡させて頂きます！！
```

### 回帰テスト
`app/lib/__tests__/pair-example.test.ts`（21件）。実行 `npx tsx app/lib/__tests__/pair-example.test.ts`。
既存 `greeting`(19) / `action-ledger`(23) / `stance`(17) も全 PASS・`npx tsc --noEmit` エラー0。

### 引き継ぎ
- [ ] `PD_WILL_SEND` の実運用ログ（tpo_debug の ruleId 分布）で ANY_WILL_SEND への落下が消えたか確認する
- [ ] `UNANCHORED_VOCAB` の発火率を見て、辞書に追加すべき語（「ご家族」以外の創作語）が無いか棚卸しする
- [ ] `sendObject="document"`（書類を送る予告）は現状 受領宣言のみ＝専用セル無し。頻度が出たらセル化を検討
- **DB**: `templates.win_rate NUMERIC DEFAULT 0` を追加（本番適用済み・migrate-schema にも追記済み）
- **同期**: 週次cron `calc-aix-attribution` が集計後に aix_action_attribution 全期間を template_id 単位で集約し `templates.win_rate = Σclosed_won / Σunique_conversations` を更新
- **API**: GET /api/templates が use_count / win_rate を返すようになった
- 注意: 現時点で aix_action_attribution に template_id 付き実績が無いため win_rate は全て0。実績が溜まれば自動で並びが変わる

---

## 日割家賃誤回答の根本対策＋knowledge_gap診断ループ（2026-07-11）

AIが「入居日が早いほど日割家賃は少ない」と**逆に**誤回答（正: 入居日が早いほど残日数が多く高くなる・1日入居は日割なし）。

- **知識登録**: `ai_reply_knowledge` に「日割家賃の正しい計算方法（入居日が早いほど高い）」を principle / **importance=10** / confirmed / embedding付きで登録（id: `760515b9-62bf-47bb-8149-f46da16ebcb8`）
  - ⚠️ 設計メモ: generate-reply の topPrinciples 保証バケットは importance>=9 principle を **importance降順 limit 5** しか取らない（既に9が14件・10が2件）。importance=9 だと注入されない可能性があるため 10 で登録した。バケットは conversation_state でフィルタしないため 1 行で hearing/proposing 全stateをカバーする（stateごとに重複登録すると枠を食い潰すので禁止）
- **corpus2skill `discoverBlindSpots()`**: 材料④として was_ai_modified=true の「AI案 vs 実送信文」（直近30日・12件）を追加。Opus4.8 が根本原因を診断し、`knowledge_gap`（AIが誤った事実を述べた→正しい事実を質問）/ `prompt_ambiguity`（使用条件の誤解→条件を質問）として ai_feedback_items に起票
- **ai-feedback（回答側）**: category=knowledge_gap の回答は ai_prompt_rules に加えて `ai_reply_knowledge` の principle（importance=9・質問文をembedding化）としても保存 → pgvector検索で顧客の類似質問に確実にヒット
- **TemplateModal**: 「❓AI質問」タブに knowledge_gap ラベル「知識不足（AIの誤事実）」追加
- コミット: `4a845ff`

---

## 申込フォーム検知→applying自動昇格をサーバー側に実装（2026-08-03）

**問題**: 申込・審査中(applying)への遷移経路がUI手動バナー（page.tsxの「申込に変更」ボタン）しか無く、会話を開いていないと遷移漏れ。さらにキーワードが個人フォーム専用で法人フォーム（【法人御契約】/法人名/代表者名/登記住所）は検知ゼロ。記入済みフォームの①②番号が isFormatMessage に誤ヒットし希望条件としてAI解析→proposingへ誤昇格するケースもあった。

- **新モジュール** `app/lib/application-form-detect.ts`（サーバー/クライアント共通・キーワード一元化）
  - `isApplicationFormMessage(text)`: 法人→個人の順に判定（代表者生年月日が個人側の生年月日に食われないよう法人が先）。法人=即時 /法人御契約|法人契約|法人名義/ or フィールド2つ以上、個人=即時 /入居申込書|入居申込|申込フォーム等/ or フィールド3つ以上（保証人・年収・職業も追加）
  - `hasApplyHintKeyword` / `PRE_APPLY_STATUSES`（申込前ステータス9種）もexport
- **line-webhook** `handleTextMessage`: isFormatMessage より先に申込フォーム判定→ `update status='applying'` を `.in(PRE_APPLY_STATUSES)` ガード付きで実行（冪等・closed_won/closed_lostからのダウングレード不可）。単発で閾値未満でもヒント語があれば直近8件の顧客メッセージを結合して再判定（分割送信対応）。検知時は isFormatMessage/autoParseFormat をスキップ（希望条件誤解析防止）。after() B は status をDB再読するので昇格後は ai_draft 生成も正しくスキップされる。console.logで昇格/失敗を記録
- **line-webhook** `handleImageMessageSave`: 直近スタッフメッセージが /申込書|申込用紙|ご記入|入居申込/ にヒット＋申込前ステータスなら、顧客画像受信で applying 自動昇格（画像フォーム対策ヒューリスティック: `autoPromoteApplyingOnFormImage`）
- **page.tsx**: isApplyFormDetected を共通モジュール利用に変更（法人対応）、窓を直近6→10メッセージに拡大。バナー却下キーを「会話ID+最新顧客メッセージID」に変更（フォーム再送でバナー再表示）。バナーは画像フォーム等のフォールバックとして存続
- **generate-reply** L720: 申込フォーム正規表現に法人キーワード（法人名|代表者|登記住所|法人契約|法人御契約|法人名義）追加 → 法人申込者にも身分証リクエスト注入が効くように
- **suggest-status-update/route.ts**: 呼び出し元ゼロのデッドコードと判明 → 冒頭にDEAD CODEコメント追記（削除はせず温存）
- 検証: tsc --noEmit パス。検知テスト8ケース（個人/法人/法人2フィールド/入居申込書即時/条件フォーマット非検知/雑談非検知/ヒントのみ/連帯保証人系）全て期待どおり

---

## 前向き反応（「気になります」）→ ご査収感謝＋内覧提案（2026-09-10・Fable5・Sさん事例）

### 事例
Sさん（スモラ・conversation `3890f691-bd82-4196-9fb8-46ddd5e33fc5`）。19:05 AIX 物件強推し（資料7枚＋「お手隙の際にご査収ください😊！！」）→ 20:24 顧客「ありがとうございます！ **アーバネックス気になります！**」→ 20:28 AI が「アーバネックス気になって頂きありがとうございます😊！！／かしこまりました！！」（**2行37字・行動宣言ゼロ**・block 2件を残して `revision_exhausted`）。
20:29 スタッフ実送信（正解）:
```
ご査収頂きありがとうございます😊！！
かしこまりました！！
よろしければSさんご都合よろしいお日にちにお部屋ご案内させて頂きます😌！！
```
竹内指摘: **①見てくれた事への感謝（ご査収頂きありがとうございます）②内覧もご都合よろしいお日にちにご案内させて頂く旨** を入れる。

### 根本原因（A〜E・A+B+C を同時に入れて初めて正解への道が開く）
- **A**: `CUST_POSITIVE_RE` に「気になる」が1語も無く、`KIND_RE` にも前向き語が無い → residue 13字が `statement`（＝下流に写像を持たない残余ラベル）→ customer=`other`
- **B**: `lastStaffEntry` が「±3分窓内で at 最大」だけを見ていたため、AIX 送信が自動で閉じる `line_tasks`（conf2・社内記帳）が **0.898秒差**で conf3 の AIX 実メッセージに勝ち、staff=`check_result` に誤分類
- **C**: PAIR_MATRIX は 100セル中 62セルしか解決できず `property_send × positive` も `check_result × *` も無い → `ruleId=null` → 汎用 direction の WE DO 候補が「ピックアップ・交渉・確認」で閉じており内覧提案に至る言語的経路が消える
- **D**: brain 不在（T3）。brain-sweep は `is_post_apply=true` の3行に飢餓して直近24h **processed 1 / failed 899**（「5分以内に補填」は虚偽）。正解を持つ `last_brain_meta` は generate-reply から一度も読まれていなかった
- **E**: ①direction ②final-check の suggestion ③regen の【必須要素】の3経路から同時に内覧提案が消えるため、修正ループは「回数不足」ではなく**材料不足**で枯れた（C の従属現象）

### 実装（コミット `fb728adf`）
- `reply-context.ts`
  - `SubstanceKind` に `"positive"` 追加＋`KIND_RE` に前向き語行。`has` に `|| kinds.has("positive")`（「良さそうですね」7字が実質なしに落ちるのを止める）
  - `PositiveVerdict`（`viewing_explicit` / `appraisal`）＋`resolvePositive()`。**T1 評価語は直前スタッフが資料送付系（`MATERIALS_SENT_STAFF_KINDS`）の時だけ**／T2 内見明示は無条件／T3 物件名のみは**台帳の送付済み物件名と一致した時だけ**昇格（`propertyMatchKeys()` は「アーバネックス谷町四丁目1102号室」→「アーバネックス」のブランド頭も鍵にする）
  - `CustomerResponseKind` は増やさない（10×10 の空セルを増やさない）。下位種別は `CustomerResponse.positive` フィールドで持つ
  - `classifyCustomerResponse` に `flags.ledger`。`PRIORITY` は動かさず、**T2 のみ質問より上に引き上げる限定オーバーライド**（decline/concern/condition_change には負けたまま）
  - `LEDGER_OUTBOUND_SOURCES`（aix_log / staff_text / aix_history）新設。`classifyLastStaffTurn` の⓪台帳分岐にガード
  - [X]/[Y] 分離: `VIEWING_OFFER_SOFT_RE`（条件節付き宣言形・n=443・**通常返信で可**）／`VIEWING_DATE_ASK_RE`（「御座いますでしょうか」・n=51 の96%が具体日時とセット・**AIX【内覧日調整】専用**）／`isBareViewingOffer()`／`viewingOfferLiteral(name, named, count)`
  - `GRATITUDE_FOR_REVIEW_RE`／`STAFF_MATERIALS_SENT_RE`／`resolveMaterialsContext()`（**staffSent AND customerSaw の時だけ thanksAllowed**）／`resolveNamedProperty()`
  - 新セル4つ: **`PS_POSITIVE`**（property_send × positive）／`CR_POSITIVE`／`ANY_POSITIVE`／`CR_ANY`。網羅 62→79セル（positive 列・check_result 行を完全カバー）。**`ANY_OTHER` / `ANY_ANSWER` は作らない**（other は証拠ゼロの指紋。セルを与えると mustInclude が全会話に流れ込む）
  - `PairContext` に `materials` / `namedProperty` / `customerName`。`fillPairPlaceholders` に `{positiveEvidence}` / `{namedProperty}` / `{viewingOffer}`
- `action-ledger.ts`: `LedgerTask.result` 追加／`property_check=completed` は **result 非 NULL の時だけ** `confirmation_reported`／`pickLastStaffEntry()`（①outbound か ②confidence ③実発言時刻への近さ ④at）
- `final-check.ts`: `pairFixSuggestion()`（選ばれたセルの fix リテラルを suggestion にする）を `EMPTY_CLOSER` / `WE_DO_MISSING_DET` / `GENERIC_ONLY_REPLY` に適用（`rule.example` を suggestion に使うのを廃止）。`PAIR_ELEMENT_MISSING` の fix も `fillPairPlaceholders` を通す。新コード **`VIEWING_DATE_ASK_WITHOUT_AIX`(block)** / **`VIEWING_OFFER_NAME_ECHO`(warning)**
- `route.ts`: `STATE_FALLBACK_DIRECTION.proposing` / `closingFallback` / `tpoNoteForLLM` proposing / `fallbackDirection` の4か所を **WE DO の選択肢①〜⑤（内覧提案が第1）** に統一（四者同名）。`fetchReplyModeGate` が `last_brain_meta` も返し、**conversation-scope 方針のみ**フォールバック（message-local は絶対に流用しない）。regen フィードバックは rule=null でも【WE DO の選択肢】を渡す。`revision_exhausted`＋block 残存を**自動送信のハードストップ**に（`REVISION_EXHAUSTED_AUTO_SEND`）
- `brain-core.ts`: `stampSkipped()` — status / is_post_apply / line_status の早期 return でも `brain_analyzed_at` を打刻して30分バックオフに乗せる
- `brain-sweep/route.ts`: `is_post_apply` / `line_status` フィルタ2行（NULL 行を落とさない `.or` 形式）
- `page.tsx`: `revision_exhausted && block>0` で指摘 `<details>` を既定 open ＋ 送信の二段確認

### 黄金ルール（追加）
- **分類体系を増やす時は必ず「出口」を定義する**。下流のどの列に落ちるかが無いラベル（statement）は、検出できない故障を作る
- **台帳の「直前スタッフ発言」は時刻順で選ばない**。①顧客に送られた証拠か ②confidence の順。`line_tasks` は本文カラムを持たず完了通知先も社内グループ＝100% 社内の記帳
- **同じ日本語でも AIX 専用文型と通常返信可の文型は regex レベルで分離する**。全面禁止にすると正解への道が消える
- **「文を足せ」型の検査が許される3条件**: ①セルの mustInclude として確定 ②成約データの実文型リテラルを渡す ③**リテラル内の全ての名詞・数値・日付が verdict 由来**（汎用名詞のみなら常に可）。SENT_IGNORED が越えていたのは②③であって「追加」という行為ではなかった
- **「後段が拾う」前提は cron ログの実測成功率（n≥100）を確認するまで置かない**。同時に、後段に依存しない一次証拠だけで正解に到達できる経路を必ず用意する（PS_POSITIVE は brain の値を1つも参照しない）
- **内覧のご案内提案では物件名を復唱しない**（内覧は物件非依存）。復唱するのは見積作成・募集状況確認・内覧開始日確認・申込（物件依存）の時だけ

### 回帰テスト
`app/lib/__tests__/positive-viewing.test.ts`（16件・T-01〜T-16）。実行 `npx tsx app/lib/__tests__/positive-viewing.test.ts`。
既存 `brain-scope`(24) / `pair-example`(21) / `greeting`(19) / `action-ledger`(23) / `stance`(17) も全 PASS・`npx tsc --noEmit` エラー0。
※ `action-ledger.test.ts #2` の期待値を更新（miku 10:40 の `classifyLastStaffTurn.source` は `ledger` → `regex`。台帳の直前エントリが line_task＝社内記帳なので⓪で確定させない仕様変更の反映。kind は `pickup_declared` のまま）

### 引き継ぎ
- [ ] デプロイ後1時間、`cron_run_logs` の brain-sweep `result_json` を監視して `processed>0` を確認する（飢餓解除の検証）
- [ ] `MAX_SWEEP_PER_RUN=3`（5分×3＝36件/h）は直近24hの顧客メッセージ122件に対して余裕が薄い。**飢餓解除後に1週間実測してから**見直す（先に上げない）
- [ ] tpo_debug の `ruleId` 分布で `PS_POSITIVE` / `ANY_POSITIVE` の発火率と `ruleId=null` 率（改修前 7/24=29%）を確認
- [ ] Phase 2（未実装・要オーナー承認）: T3 で生成され `revision_exhausted` かつ block≥1、その後 brain が分析を終えた会話に限り1回だけ再生成する（`generate-pending-drafts` の救済条件を narrow に拡張・`ai_draft_check.regen_after_brain` フラグで1会話1回）
- [ ] `revision_exhausted && block>0` のドラフトを `ai_reply_examples` の自動取り込みから外す（壊れたドラフトを正解プールに混ぜない）— 今回は未実装


---

## reply_modeゲート実装（2026-08-14）
brain-core（Haiku）が `conversations.suggested_aix_meta.reply_mode="aix"` と判定した会話は、AI自動ドラフト生成をブロックしスタッフにLINEグループ通知する。
- **ゲート場所**: `generate-reply/route.ts` 内・2チェックポイント方式（webhookは受信毎にmetaをnullワイプ→brain再分析するため、webhook側ゲートは構造的に発火しない）
  - チェックポイントA: リクエスト受理直後（meta既存ケースをAPIコストゼロで中止）
  - チェックポイントB: メイン生成（Sonnet）呼び出し直前（Step1分析45秒の間にbrain再分析3〜10秒が完了しmeta再投入済み — 本命）
- **オプトインフラグ** `enforceReplyModeGate: true`: 自動経路3つ（generate-draft-bg-async / cron generate-pending-drafts / generate-draft-bg）のみ送信。UI手動生成・テンプレ最適化は非送信で従来どおり
- **発火時の挙動**: `ai_draft="[AIX誘導中]"`（既存sentinel再利用・UI対応済み）+ `draft_pending_at=null`（cron永久再試行停止）を `.is("ai_draft", null)` アトミッククレームで保存（通知重複防止兼用）→ `/api/notify-group` でスタッフ通知「{顧客名}さん AIXで対応して / 推奨アクション / 理由」→ メタ行 `{ok:false, reason:"aix_required", aix:{action,note}}` をHTTP 200で返す（呼び出し元は失敗カウントせずスキップ）
- **フォールバック**: meta=null（未分析・brain分析がStep1より遅延/失敗）は従来どおり生成（fail-open）
- **新カラムなし** → migrate-schema更新不要
- 動作確認: `update conversations set suggested_aix_meta = jsonb_set(coalesce(suggested_aix_meta,'{}'), '{reply_mode}', '"aix"') where id = '<テスト会話>'` → bg-async起動 → `ai_draft='[AIX誘導中]'` とグループ通知を確認

## 最終チェック（前頭前野モデル・3重チェック）実装（2026-08-14）
AI返信の送信前チェックを人間の脳の誤り検出機構でモデル化。Haiku 3パス並列（各2.5s abort・structured outputs保証JSON）。
- **共有lib**: `app/lib/final-check.ts` — `runFinalCheck()` / `runAutoRevision()` / `sha1()`
  - Pass1 前頭前野=rule_check（ai_prompt_rules照合＋AIX境界線）/ Pass2 前帯状回=anomaly_scan（金額・空室結果・物件名等の出所検証）/ Pass3 バグ探し思考=context_check（質問取りこぼし・段階ミスマッチ・二重宣言・時刻妥当性）
  - **メタ認知ガード**: severityはコード側の決定的マップが裁く（AIX_BOUNDARY_* と FABRICATED_AMOUNT/AVAILABILITY のみblock）。evidence（本文引用）なし指摘は破棄、evidenceが本文に実在しないblockはwarningに降格。全pass fail-open
- **生成時**（`generate-reply/route.ts` 両ブランチ合流後・enqueue前に一括実行）: フルチェック＋warningのみなら自動修正1回（Haiku 4s）。`<<<FINAL_CHECK:{json}>>>` トレーラーで返し `conversations.ai_draft_check`(jsonb) にも保存（別UPDATE・fail-open）。レスポンスは元々全文バッファ型なので+1.5〜2.5sは構造無害
- **送信時**（`page.tsx executeSend()`）: `sha1(textToSend)` と `checked_text_hash` を照合 — 一致（未編集・大多数）は**0msで通過**、不一致（スタッフ編集＝従来全ゲートを素通りしていた唯一の穴）のみ `POST /api/check-reply`（maxDuration=10・requireInternalAuth・ルール60sキャッシュ・自動修正なし）を2.8sタイムアウトで呼ぶ。block→送信確認モーダルに🔴指摘を出しスタッフ確認後のみ送信。warning/タイムアウトは絶対にブロックしない
- **UI**: 品質バッジが3パス完了＋指摘ゼロで「✅ 3重チェック済み」に格上げ。指摘は🔴/🟡折りたたみリスト（blockあり時は自動展開）。事前生成ドラフト選択時はDBの ai_draft_check をハイドレート
- **新カラム**: `conversations.ai_draft_check JSONB`（migrate-schema 追記済み・**デプロイ後に migrate-schema 実行が必要**。未実行でも全経路 fail-open で従来動作）
- コスト ~$0.01/返信（Haiku 3呼び出し）。モデル: claude-haiku-4-5（thinkingなし・temperature 0）

---

## final-check 生成層vs検査層の矛盾一掃（2026-08-29）
Fable5分析で発見された「正当な文を削除・破壊するルール」を全て修正。優先度: ①全損経路の封鎖 → ②毎回発火する矛盾の除去 → ③誤検知系。

### final-check.ts
- **CONFIRM_PROMISE_RE自己矛盾の封鎖（最重大）**: SONNET_REVISION_STATICのAIX境界置き換え句「確認して(改めて)ご連絡いたします」がCONFIRM_PROMISE_REに自らマッチし修正が必ず破棄→revision_exhausted→ai_draft null全損の経路があった。置き換え句を「改めてご連絡いたします」に統一し、TIME_INVALID_HONIJITSUのsuggestionも「明日一番にご連絡させて頂きます」（「ご確認し」を除去）に変更
- **決定的TIME_INVALID_HONIJITSU**: severity を `ctx.isAutoSend ? "block" : "warning"` に（LLM版TIME_INVALIDと対称化。スタッフ確認経路で不要なblock修正ループを止めた）
- **rule_check**: 冒頭お礼禁止語彙に「頂き/いただき入り（ご連絡頂きありがとうございます）は初回必須挨拶のため対象外」例外を追記。例外2の引用文を「オススメできる物件をピックアップ」に更新しRULE_VIOLATIONも除外対象に追加
- **anomaly_scan**: 会社標準案内ホワイトリスト追加（審査3日〜10日・最短2週間入居・審査通過までキャンセル料無料・審査落ち費用なし・保証会社費用は総賃料50%前後の一般論）→FABRICATED誤blockで正しい定型回答が削除されるのを防止
- **assignSeverity**: isEarlyConversation格下げ対象に FABRICATED_PROPERTY を追加（初回の物件名表記ゆれ誤block防止）
- **context_check**: FILLER_GREETINGを「条件変更・ピックアップ依頼直後のみNG」に限定（生成層は長文・2回目以降で「お世話になっております」必須のため。旧: 無条件NG＝絵文字矛盾と同型の生成層vs検査層矛盾）。出力例13を条件変更文脈に修正+問題なし例13b追加。DOUBLE_DECLARATIONにTikTok二重お礼（ご連絡お礼+動画お礼）の例外追加。WE_DO_MISSING例外の「パターンZ/F3/Y」参照を自己完結の条件記述に置換
- **SONNET_REVISION_STATIC**: 「させていただきます過剰使用を避ける」指示を撤回→「行動宣言文（WE DO文体）は削除・受け身化しない」に変更（WE DO文体破壊とrecheck棄却空振りの原因だった）

### line-reply-prompts.ts
- **INITIAL_COST_EXPLANATION**: 「スモラは」→「弊社は」（BANNED_WORDS_DETERMINISTICの「スモラ」に必ずヒットし初期費用説明が毎回block→破壊されていた）。✨2回→1回（決定的dedup発火も解消）
- **受け身表現「ご条件に合った/合う」の一掃**: 必須パターン・例文の約25箇所を能動表現（「オススメできるお部屋」「〇〇さんご希望の管理費込み〇万以内」等）に置換。物件スクショ時必須ピックアップ宣言・F4のWE DO継続宣言・TikTok例・hearing/proposing例文等。禁止ルール文中の引用（L103/L792/L967/L1257/L1390）はそのまま

### generate-reply/route.ts
- **センシティブ案件（sensitiveGateNote付き）**: runFinalCheck（チェックのみ）に変更。接地修正・フィードバック再生成をスキップ（手動確認前提の草稿に最大90秒+再生成は無駄＋謝罪ニュアンスをrevisionが壊すリスク）
- **テンプレ最適化モード**: 決定的禁止語彙スキャン追加（「スモラ」→「弊社」決定的置換、名称未設定/**/少々お待ちくださいは警告ログ）。従来はfinal-check完全バイパスで無防備だった
- **regen込み総予算**: loop2のbudgetを `min(60s, max(20s, 150s - 経過))` に（最悪2〜3分の膨張を防止）

### DB
- ai_reply_knowledge 25d65b92（confirmed・importance10）: 「ご条件に合うお部屋ピックアップ」→「オススメできるお部屋ピックアップ」にUPDATE済み
- ⚠️ 未対応: 同様の受け身表現を含む知識行が他に約20件ある（45554d85/bb8e736c/db6e678a/cfc13e4c/2cc3cc10/b08cc20f等、importance8-10）。うちe9567579・b1308271は受け身表現を「OK」と教える内容で打ち合わせ合意と真っ向矛盾 → 次セッションで棚卸し・is_current=false化を検討

検証: npx tsc --noEmit パス


---

## TPO判定 7ラベル体系・gratitudeActionHint・conditionDetail（2026-09-08 Fable5監査）
`generate-reply/route.ts` の TPO ブロック（`// ── TPO共通ヘルパ（2026-09-08 誤発動対策 / 監査パッチ）──` 以降）を全面改修。生成（tpoNoteForLLM）・チェック（final-check）・few-shot（line-reply-prompts【📍 TPO別返し方】）の三者で**同名ラベル**を使う。

### 7場面ラベル（tpoNoteForLLM 先頭語 = prompts ■場面【…】 = final-check 正規表現）
| ラベル | フラグ | 開口語 | 字数 | final-check |
|---|---|---|---|---|
| 条件提示 | `isConditionPresented` | かしこまりました！！ | 100〜180 | CONDITION_OPENING |
| 内覧キャンセル | `isViewingCancel` | かしこまりました！！ | 50〜100 | WAIT_TPO / CONDITION_OPENING |
| ネガ文脈（顧客自身の断り） | `negativeDetail.kind="withdrawal"` | かしこまりました！！ | 50〜110 | WAIT_TPO / CONDITION_OPENING |
| ネガ文脈（否決・募集終了報告への了承） | `negativeDetail.kind="staff_report"` | はい！！ | 50〜110 | WAIT_TPO |
| 一時保留 | `isTemporaryLeaveMsg` | はい😊！！ | 30〜60 | WAIT_TPO / GRATITUDE_OPENING |
| 検討中フォロー | `isThinkingMsg`（＋brain follow_up） | はい😊！！ | 70〜120 | WAIT_TPO / GRATITUDE_OPENING |
| 強推し直後の了承 | `isPostStrongRecommendation` | はい😊！！ | 50〜110 | WAIT_TPO / GRATITUDE_OPENING |
| 感謝返し | `isGratitudeReplyTPO` | はい😊！！ | 40〜130 | WAIT_TPO / GRATITUDE_OPENING |

### 主要構造
- **モジュールスコープ共通ヘルパ**（EMOJI_RE 直後）: `stripDecoration` / `coreLength`（絵文字除去後 code point）/ `IMPLICIT_QUESTION_RE`（?なし疑問）/ `IMPLICIT_REQUEST_RE` / `SOFT_DECLINE_RE` / `INFO_PROVIDE_RE` / `GRATITUDE_POS_RE` / `CLOSER_ONLY_RE` / `ACK_TOPIC_EXCL_RE` / `TPO_NEUTRAL_ACK_RE`。`isShortAckMsg`（buildGenerationMessages）と `isGratitudeReplyTPO` が同一集合を共有。**export しない**（Route export 型エラー）
- **TPO_HARD_REQUEST_RE（話題語）/ TPO_SOFT_REQUEST_RE（文型）分離**。isThinkingMsg は SOFT を `TPO_THINK_TIME_REQUEST_RE`（考えさせてください等）で免除。「相談してから決めたい」は HARD の「決めたい」と衝突するため `msgForReq` で先に除去
- **conditionDetail**: `{presented, areas[], rent, hasRequest, changeRequest, reason}`。reason ∈ form / area+rent / existing_property_ref / request_over_condition / no_rent / no_area / empty。`isConditionChangeRequest`（片方のみ＋条件語）は待ち系TPOの誤発動保護専用で方向性は強制しない。`conditionDirection` に areas/rent をリテラル埋め込み
- **negativeDetail**: 断り表現（WITHDRAWAL_SRC）を TPO_REQUEST_RE より**先に**評価し、断り句を除去した `rest` に除外を当てる。スタッフ側走査は「短い了承のみ・72h以内・代替提案なし・結果報告形」に限定。AIX履歴 `最新:property_check_result...結果:unavailable` は決定論で確定。brain `customer_intent=negative` は `engagement_stance=wait` との併用でのみ補助証拠
- **isPostStrongRecommendation**: `/最新:([^\s→]+)/` でラベル抽出（旧 split は「（新→旧順）」ヘッダーの→で割れて恒久 false だった）。`property_recommendation` のみ対象、`property_check_result(結果:available)` は対象外。直近スタッフ1通が `isAix` or 推薦語を含むこと
- **gratitudeActionHint**: 直前スタッフ発言から決定論で1アクション選択（ピックアップ約束→出来次第お送り / ご査収→お手隙＋私の方でも / 確認・交渉中→確認出来次第 / 見積→気になる点 / 内覧→現地でお待ち）。LLM に選ばせない
- **anyPartRestNeutral**: 待ち系（一時保留/検討中）は「1通該当＋残りは TPO_NEUTRAL_ACK_RE」で成立。純感謝のみ everyPart
- **tpo_debug** に `conditionReason` / `isConditionChangeRequest` / `negativeKind` / `isViewingCancel` 追加（A-2）。1週間後に `ai_draft_check->'tpo_debug'` を集計し reason / kind 分布を確認、FPが出たら語彙を**削る**（足さない）

### 回帰テスト
`scratchpad/tpo_regression.mjs`（route.ts からブロックを抽出→ts.transpileModule→100ケース固定）。TPO改修時は必ず実行。テストは route.ts のマーカーコメント（`// ── TPO判定 共通ヘルパ（2026-09-08 監査）` / `// ── TPO共通ヘルパ（2026-09-08 誤発動対策 / 監査パッチ）──` / `const effectiveKeyTopics`）に依存するので、コメントを変えたらテストも直す

### 優先度B（未対応）
- brain-fetch-spec.ts の `lastCustomerMsgAt` null で無条件 T1 → T2 扱いへ
- FRESHNESS_TOLERANCE_MS=5秒連投問題
- `TPO_SOFT_REQUEST_RE` の `できます` を `できます(?:か|でしょ|よね|[?？])` に絞る（「確認できます次第」FN）
- 「10万円台なら厳しいです。梅田で」の否定上限を条件提示から除外
- tpo_debug を reply_logs 側にも複製し is_edited と突合


---

## 優先度S G10/G26/G7/G6/G30 文脈判定統合（2026-09-08 Fable5 実装）

3つの共有モジュールを新設し、生成（route.ts）・検査（final-check.ts）・brain（brain-core.ts）・後処理（validate-reply.ts）が同じ判定オブジェクトを参照する「verdict 1回計算 → 三層同一」型に揃えた。新 TPO を足す時はこの型に従う（route: verdict 計算 → finalCheckCtx / detCtx / postDetCtx の **3か所** に同じ値 → check-reply 経路は ctx から再計算）。

### 四者同名 対応表

| ギャップ | 共有定義 | 生成側（route.ts） | 検査側（final-check.ts） | その他 |
|---|---|---|---|---|
| G10 離脱誤判定 | `app/lib/move-out-context.ts`（`classifyMoveOutSubject` / `moveOutEvidenceText` / `MOVE_OUT_PATTERN` / `CURRENT_HOME_MOVEOUT_CLAUSE_RE`） | `moveOutSubject`（tpoLatestStaffText 直後）→ WITHDRAWAL_SRC 対象名詞必須化＋二重ガード／`isGratitudeReplyTPO` 除外／方向性「入居時期情報」／`detectPropertyStatus` の haystack を evidence 化／`SOFT_DECLINE_RE` の裸「決まりました」廃止 | ctx.moveOutSubject → `FAREWELL_ON_MOVEOUT_INFO`（block）、E6 VIEWING_BEFORE_VACANCY の履歴を `moveOutEvidenceText` 経由に | brain-core.ts 3か所 `moveOutEvidenceFromMsgs`／prompts L220・L369・L1414 に「現住居の退去は除く」 |
| G26 創作約束 | `app/lib/confirmation-context.ts`（`resolveConfirmationContext` / `applyAixTiming` / `stripUnbackedConfirmPromise` / `CONFIRM_PROMISE_SENTENCE_RE`） | `confirmCtx`（route）→ `buildGenerationMessages` 内で `applyAixTiming` → `managementNote` を verdict でゲート＋`confirmationGateNote` 新設／`gratitudeActionHint` 対象付き／bridge から「すぐに」「確認しご連絡（対象なし）」除去／`buildAixTimingNote` の締めを AIX 種別分岐／`confirmCtxFinal` = applyAixTiming(confirmCtx, aixTimingForMeta) を ctx に | V5/V6 を verdict 基準に置換（`CONFIRM_NO_OBJECT` warning→**block**、`CONFIRM_OBJECT_UNSTATED` 新設）／WE_DO・PROMISE_ECHO 判定から根拠無し確認文を除外／修正ループ guard `CONFIRM_PROMISE_RE` を共有定数に | replyHint（property_check タスク）も対象付きに |
| G7 主語逆転 | aix-taxonomy `AIX_ACTION_REPLY_DIRECTION.viewing_invite.weDo` を単一真実源 | `viewingIntentShortReplyNote` 例文／viewing_invite bridge を weDo に／NG_PHRASE_NOTE ⑧ 3動詞パラダイム＋⑯-2 | `BANNED_WORDS_DETERMINISTIC` に「全文脈で誤りの形」のみ追加（お伝え／ご内覧させて頂け／撮影お願い／撮影後すぐに 等。「ご都合よろしいお日にちにご案内」は V3 に残す） | prompts VOCAB_SEMANTICS ■C-2（ご案内＝スタッフ／内覧＝顧客／撮影＝スタッフ／都合＝顧客）・D-④・禁止列挙・few-shot 3場面追加／validate-reply 内覧候補日時 replacement を条件節＋疑問形に |
| G6 断言禁止 | `validate-reply.ts ASSERTION_BAN_RULES`（DISCLOSURE / VACANCY / MOVEIN_DATE / SCREENING） | `aixVacancyDone` を finalCheckCtx に（validateAndClean と同値）／propertyFactGateNote に告知事項・審査を追記 | `runAssertionBanChecks`（block 固定・免除は aixVacancyDone／スタッフ直近3件の完了形報告／AIX 結果フロー＋staffSourceText の3経路のみ。顧客発言は根拠にしない）／`assignSeverity` block 維持 | validateAndClean の旧「確認結果断言」を ASSERTION_BAN_RULES 由来に置換（staffConfirmedRe 免除）／prompts VOCAB_SEMANTICS ■F＋自己チェック(6) |
| G30 宛名・挨拶 | `app/lib/greeting.ts`（`resolveGreeting` / `enforceOpening` / `buildFirstGreeting`）＋`validate-reply.ts PLACEHOLDER_NAME_CORE_RE` | `greetingDecision`（alreadyGreetedToday 直後）→ `greetingNote` リテラル埋め込み（3候補選択を廃止・「夜分遅く禁止」撤廃）／初回強制置換ブロックを `enforceOpening` に統合（非初回も waited / late_apology / 夜間は enforce）／`customerName = normalizeCustomerName()` 単一経路 | ⑦ `OPENING_GREETING_MISMATCH` / `GREETING_WAITED_MISUSE` / `OPENING_GREETING_UNEXPECTED`／`NAME_PLACEHOLDER` 派生形 block＋ctx.customerName 空扱い／GREETING_BLOCK_RE・BOILERPLATE_RE に決定論挨拶を追加 | page.tsx `\|\| "名無し"` → `""`／prompts SMORA_QUICK_PATTERNS 冒頭ルール・確認後に戻る冒頭・VOCAB_SEMANTICS ■G |

### 挨拶の決定論（greeting.ts）
first > late_apology（tpo「進捗催促対応」）> waited（最終スタッフ発言より後の最古顧客 msg から ≥3h）> none（当日挨拶済み）> standard。夜間接頭辞「夜遅くに失礼します！！」は JST 22:00〜04:59 かつ直前スタッフ発言 60 分以上前のみ。`createdAt` 欠落時は waited=null → standard に倒れる。AIX 自動返信も staff 扱いで待ち時間リセット（意図どおり）。

### 監査
`conversations.ai_draft_check.tpo_debug` に `moveOutSubject` / `confirmCtx{allowed,source,object}` / `greeting{kind,reason}` を追加。発動率調査は同カラムから取れる。

### 回帰テスト
`scratchpad/g_all_test.ts`（58ケース: G10 主語14／G26 verdict 10／G30 挨拶13／G6 正負12／final-check 決定論 9）。実行はプロジェクト直下にコピーして `npx tsx`（import を `./app/lib/` に置換）。`g10.mjs`・`g6_test.js` も既存。

### 残存リスク（実装後に監査）
- G26: allowed=true だが本文に対象語が無い `CONFIRM_OBJECT_UNSTATED` が手動時 warning で多発する場合 → `CONFIRM_OBJECT_RE` にラベル語を追加（ラベル語は追加済み）
- G6: 免除経路②はスタッフ直近3件のみ。4件以上前の確認結果を復唱すると block → 実運用で発生したら window を 5 に拡張
- G30: `ai_prompt_rules` に「夜分遅く禁止」「お待たせ致しました禁止」の同旨行が残っていれば必須側が勝てず再発する（実装時に確認・下記参照）
- G13（条件提示誤判定）への引き継ぎ: `PROPOSED_PROPERTY_REF_RE`（move-out-context.ts）に `[①-⑩]` が入っているので「提案物件への言及」判定に再利用できる

検証: `npx tsc --noEmit` パス／回帰 58/58 パス


---

## 往復文脈（Turn-Pair）＋実質判定（Substance）による返信骨格の再建（2026-09-09 Fable5）

**実害**: あみ（内覧打診→「新生児と2階どうかな」）・みく（見積送付→「検討します＋気になる物件を明日以降送ります」）が「はい😊！！…かしこまりました！！」の中身ゼロ返信で「✅そのまま送信OK」。
**根本原因**: ①待ち系TPOは1つも発動せず、生成文を作っていたのは `AIX_ACTION_REPLY_DIRECTION[effectiveAction]`（内覧誘導禁止／オススメ1件）と骨格指示ゼロの4文字ラベル「物件送付後」。brain の正しい reply_direction は action に負けて捨てられていた ②`customerMessage.split("\n")` が1通内改行を「2通」に分割し分割相槌骨格を誘導 ③final-check は検出していたが page.tsx `autoOk` が checkResult を見ず、brain action ありで指摘リスト非表示。修正ループも「文を足す」修正を長さ上限・evidence残存で棄却していた。

### 新モジュール `app/lib/reply-context.ts`（四者同名の単一真実源・他 lib を import しない）
| 関数/定数 | 役割 |
|---|---|
| `MSG_SEP` / `splitMessageUnits` | 複数通結合の専用区切り（`\n⁣\n`）。page.tsx / bg-async / bg が結合＋`customerMessages` 配列も送る。1通内改行は分割しない |
| `analyzeSubstance` → `SubstanceVerdict` | 定型（PURE_ACK_SENT_RE）と待ち句（WAIT_PHRASE_RE）を剥がした残余に KIND_RE（concern/question/request/condition/schedule/decision/decline/info/answer）を当てる。`has` / `isAckOnly` / `concerns[]`（CONCERN_RULES 12種: strongRe 単独 or topicRe＋CONCERN_HEDGE_RE。各 `replyRe`（対応語）と `fix`（条件変換リテラル）付き） |
| `mergeBrainEvidence` | fresh brain（customer_questions / condition_change_type / repeated_concern / customer_concern）を補助証拠として合流 |
| `classifyLastStaffTurn` | 直前スタッフ発話 → viewing_invite / property_send / estimate_send / question_to_customer / confirmation_promise / condition_ask / check_result / apply_push / other。優先: aix_usage_logs（±3分）> 本文regex > brain last_aix_history |
| `classifyCustomerResponse` | 顧客返答 → decline > condition_change > question > concern > will_send_later > thinking > positive > answer > ack_only > other（行単位で最強行。対象語付きの迷いは concern、「また連絡します」は thinking） |
| `PAIR_MATRIX` / `resolveTurnPair` | staff×customer セル（VI_CONCERN / VI_POSITIVE / VI_THINKING / ES_WILL_SEND / ES_THINKING / ES_CONCERN / ES_POSITIVE / PS_CONCERN / PS_THINKING / PS_WILL_SEND / PS_QUESTION / PS_CONDITION_CHANGE / QC_ANSWER / CP_ACK / ANY_DECLINE / ANY_QUESTION / ANY_CONCERN / ANY_WILL_SEND）。各セルに tpoLabel / direction / mustInclude(detect) / mustNot / example / precedence（override_wait＝待ち系TPO・AIX action より先／after_wait＝AIX action より先） |
| `buildPairDirection` / `buildTurnPairNote` | effectiveReplyDirection 用の決定論リテラル／dynamicBlock【🔁 往復文脈】ブロック |

### route.ts の変更点
- `substance` / `lastStaffTurn` / `customerResponse` / `pairContext` を1回だけ計算 → TPOゲート・effectiveReplyDirection・effectiveKeyTopics（mustInclude）・activeAvoidTopics（mustNot 和集合・必須要素と衝突する avoid は除外）・tpoNoteForLLM（`rule.tpoLabel（往復: summary。字数）`）・turnPairNote・finalCheckCtx/detCtx/postDetCtx・tpo_debug が同一オブジェクト
- **待ち系TPOゲート**: `isGratitudeReplyTPO` / `isThinkingMsg` / `isPostStrongRecommendation` は `substance.has` なら false、`isTemporaryLeaveMsg` は schedule のみ許容。`isDecorOnlyMsg` に `[スタンプ]` sentinel
- `tpoMsgParts` / `customerMsgBlock` は通単位（旧 `split("\n")` 廃止）。`anyPartRestNeutral` は stripDecoration 後に中立判定
- 「物件送付後」4文字ラベル → 骨格付き「物件送付後の了承（…）」。hesitancy / latent_intent 指示文から「好条件一言・申込促し」「不安を汲み取る一文」を除去
- tpo_debug に `substance` / `turnPair` / `effectiveReplyDirection` / `brainReplyDirection` / `finalCheckCodes` / `revisionOutcome` / `draftHead` 追加（トレーラーと ai_draft_check 両方）

### final-check.ts の新チェック（`runSkeletonChecks`・runDeterministicChecks 末尾）
| コード | 条件 | severity |
|---|---|---|
| REPLY_SKELETON_MISSING | 実質ありなのに回答文（ANSWER_RE）も行動宣言（ACTION_DECL_RE / RECEIVE_DECL_RE）も無い | has かつ 非一時保留/強推し → block、他 warning |
| CONCERN_UNADDRESSED | 懸念 `replyRe` が「回答文 or 行動宣言文」に無い（共感文のオウム返しは不可） | block |
| EMPTY_CLOSER | 最終行（定型締めを除く）が「かしこまりました／承知しました」等で行動宣言なし | block |
| PAIR_ELEMENT_MISSING | セルの mustInclude 欠落 | override_wait → block、after_wait → warning |
| SPLIT_ACK_REPLY | 「はい😊！！」開始＋「かしこまりました！！」終了＋残量<40字 | block |
| FEELING_TEMPLATE | 「お気持ち…わかります」／「ごゆっくりご検討ください」（命令形）／懸念への「はい😊！！」開始 | warning |
- WE_DO_MISSING_DET / GENERIC_ONLY_REPLY の免除は `sub.isAckOnly` と「待ち系TPO ∧ !has」のみ。`sub.has` or override_wait なら block
- 修正ループ: `SKELETON_CODES` を含む修正は maxLen=max(2倍,400)、evidence残存プリフィルタから除外。SONNET_REVISION_STATIC に骨格系修正ルール、buildSonnetRevisionPrompt に [PAIR_CONTEXT][SUBSTANCE]
- page.tsx: `autoOk` が `parsedCheck.ok !== false && block なし` を見る。バッジ「⚠️ 要修正（N件）」「△ 確認推奨（N件）」。brain action ありでも指摘リスト表示

### DB
- `ai_reply_examples.reply_context_snapshot JSONB`（＋index 2本）: 送信時点の tpo_debug を page.tsx → save-reply-example `tpoDebug` で保存。migrate-schema 追記済み・**本番適用済み（2026-09-09・insert_reply_ctx.mjs で exec_sql 実行）**
- 集計: `SELECT reply_context_snapshot->'turnPair'->>'ruleId', COUNT(*), AVG(was_ai_modified::int) FROM ai_reply_examples WHERE reply_context_snapshot IS NOT NULL GROUP BY 1`
- system_design_thinking に設計知見5件 INSERT 済み

### 回帰テスト
`scratchpad/reply_ctx_test.ts`（17ケース×substance/staff/customer/rule＋PAIR_MATRIX 自己整合＋final-check 骨格 block 正負。151 assert）。実行はプロジェクト直下にコピーして import を `./app/lib/` に置換 → `npx tsx`。

### 判断メモ・引き継ぎ
- 「1度確認してまた改めて連絡します」（B-14）は **thinking → ES_THINKING**（設計書の ES_WILL_SEND ではない）。正解返信（愛乃さん）に「募集状況確認・見積書」が無く ES_WILL_SEND の mustInclude で block されるため。`will_send_later` は「物件を送る」予告（送/共有 語）に限定
- PS_QUESTION の第2要素は「〜させて頂き、〜がオススメです」の提案形も可（成約実例が DECL_TAIL 単独で不合格だった）
- [ ] デプロイ後: あみ・みくの会話で再生成し `ai_draft_check.tpo_debug.turnPair.ruleId` が `VI_CONCERN` / `ES_WILL_SEND`、`finalCheckCodes` に block なし、`draftHead` が「かしこまりました！！」で終わらないことを REST で確認
- [ ] 2週間後: `reply_context_snapshot` で ruleId 別編集率を集計。FEELING_TEMPLATE（お気持ち…わかります）の編集率が warning 平均より高ければ BANNED_WORDS_DETERMINISTIC に昇格。PAIR_ELEMENT_MISSING（override_wait=block）の FP が出たら detect を**緩める**（mustInclude を足さない）
- [ ] staffContextNote は turnPairNote と併存させたまま（設計書は turnPairNote 時に省略）。プロンプト長が問題になれば `${turnPairNote && !isFollowUp ? "" : staffContextNote}` に

---

## 返信の「姿勢」体系化 — ヘッジゲート・締めポリシー・姿勢ギャップ検査（2026-09-09 Fable5・みく事例）
**実害**: みく（イエヤス・条件フォーム受信）のAI締め「35㎡以上は少し難しい可能性もございますので、条件を1つ変えた場合のご提案もあわせて〜」をスタッフが削除し「みくさんがご満足頂くお部屋が見つかるまでお部屋探し全力でサポートさせて頂きます😌！！何卒よろしくお願い致します！！」に差替。
**根本原因**: ①route.ts latent_intent 注入文『代替案（条件を変えた再ピックアップ宣言）で応える』＋ brain が顧客⑧の自己ヘッジ「難しいと思うので条件を変えた場合に…」を winning_pattern/closing_strategy に昇格 → 無加工注入 ②conditionDirection が3行目を「ピックアップ出来次第…何卒」に固定し「全力でサポート」を**禁止語**にしていた（正解の伴走締めを構造的に出せず、LLM が穴をヘッジ文で埋めた） ③REAL_ESTATE_RULES「条件を絞るほど希少。どれか1つ緩めると広がると伝え優先順位を聞くのが正解」が常時注入 ④PAIR_MATRIX に condition_ask×condition_change セルが無く rule=null ⑤final-check にヘッジ・締め種別・復唱率の検査ゼロ。

### 姿勢モデル（「見つかるまで伴走する頼れる担当者」）
①主導権（可否は言い切る・日程は提案形で顧客に返す）②具体（顧客の語のまま復唱）③伴走（具体宣言→伴走締めの順。宣言の代わりにしない）④誠実（探す前に難しさを語らない。探した後の過去形結果報告のみ）⑤温度（😊😌2個・！！3回以内・受け身語で終えない）⑥急かさない ⑦何卒は「お願いの入口」のみ。VOCAB_SEMANTICS「■ 0. 姿勢ガイド」・PHASE_COMMON_FORMAT 締め行・buildStanceNote【🧭 姿勢】が同文。

### 四者同名（reply-context.ts が単一真実源。grep キー: `resolveHedgeAllowance` / `resolveCloser` / `computeStanceFlags`）
| 関数/定数 | 役割 | 参照箇所 |
|---|---|---|
| `resolveHedgeAllowance` → `HedgeVerdict` | 探索済み証拠（aix_usage_logs 顧客最新以降の property_send 系 > AIX物件送付文生成中 > 直前スタッフ本文の過去形結果報告（非条件変更時） > last_aix_history）＞ 顧客の疑問形質問（FEAS_TOPIC＋INTERROGATIVE_END・「あれば教えて」の条件付き依頼は除外）＞ forbid_preemptive。customerSelfHedge / customerStatedRelax も返す | route.ts hedge（pairContext より先・`resolveTurnPair(..., {searched})`）／latent_intent・winning_pattern・closing_strategy・customer_questions の `stripPreemptiveRelax`／budgetInventoryNote 発火ゲート／final-check `resolveReplyContext().hedge`／tpo_debug.hedge |
| `resolveCloser` → `CloserVerdict`（`CloserKind` = commit_until_found / receive_check / open_door / wait_softly / none） | 優先: 断り＞成果物添付（DELIVERABLE_RE）＞日程確定＞検討中＞後日送付＞質問回答＞セル closer＞具体宣言あり節目（condition_change/concern/condition_ask/初回）→commit。nanisotsu = rule.nanisotsu ?? (初回 or condition_ask or 顧客への依頼)、直前スタッフが何卒済みなら false | route.ts closerVerdict（`predictCloserSignals` で生成前予測）→ conditionDirection 3〜4行目リテラル／buildStanceNote 締め行／final-check runCloserChecks／tpo_debug.closer |
| `PAIR_MATRIX.closer / nanisotsu / hedgeAllowed` | 全セルに締め既定を追記。新セル **CA_CONDITION**（condition_ask×condition_change・みく正解 example・commit＋何卒）／**ANY_CONDITION_CHANGE**（*×condition_change・瑞希 example・commit）／**PS_CONDITION_CHANGE_SEARCHED**（旧 PS_CONDITION_CHANGE の結果報告 example・hedgeAllowed・receive_check）。PS_CONDITION_CHANGE は宣言型 example に差替。PS_THINKING / PS_WILL_SEND / CP_ACK / ANY_WILL_SEND の example から何卒を削除 | resolveTurnPair は searched で hedgeAllowed セルを選ぶ |
| `classifyCustomerResponse` ②' | 条件の宣言形（CUST_CONDITION_STATEMENT_RE: 2LDK／7万以内／「家賃…で探」等）を flag/brain 無し経路でも condition_change に寄せる（decline/question/concern/positive/schedule/decision 同居時は付けない）。final-check `resolveReplyContext` は `isConditionFormMessage` で isConditionPresented を再現 | check-reply 経路の CA_CONDITION / PS_CONDITION_CHANGE 到達に必須 |
| `computeStanceFlags` / `computeStanceLite` | closer_kind / closer_expected / hedge_kind / echo_ratio / schedule_commitment / fact_deferred / excuse_flags / emoji_count / exclaim_count / char_len | route.ts tpo_debug.stance_draft（pair 依存）／save-reply-example `stance_sent_lite`（pair 非依存の軽量版。was_ai_modified=false は draft をコピー） |
| `extractEchoTokens` / `evalConditionEcho` / `FORM_LABEL_RE` | 顧客条件トークン（数字・間取り・設備・エリア）を FORM_LABEL_RE 除去後に抽出。FORM_LABEL_RE の定義は reply-context.ts に移動し line-reply-prompts.ts は再 export | buildStanceNote「📌 条件トークン」／CONDITION_ECHO_MISSING |
| `KNOWN_FACT_ANSWERS` / `resolveAnswerability` | 即答してよい既知事実4件（写真のみ契約可・大阪府域対応・カード払い・2番手申込可）。ASSERTION_BAN 対象（告知・空室・入居日・審査）は含めない | buildStanceNote「✅ 即答」／FACT_DEFERRED_ANSWER |
| `classifyScheduleCommitment` / `STAFF_ASSERT_SCHEDULE_RE` | customer_fixed / customer_asking / staff_proposing / none | buildStanceNote「🗓 日程は提案形」／SCHEDULE_ASSERT_UNCONFIRMED |
| `detectExcusePhrases` | widen_excuse / reassurance_no_basis / urgency / consider_push / humble_wait | 5コード |

### final-check.ts 新コード（`runHedgeChecks` / `runCloserChecks` / `runStanceChecks`・runDeterministicChecks ⑪）
| コード | 条件 | severity |
|---|---|---|
| PREEMPTIVE_HEDGE | PRE_PICKUP_HEDGE_RE（難しい可能性／少ない状況になり／条件を1つ変えた場合／優先順位をお聞かせ）が forbid 時、または allow_after_search で当該節が過去形でない | block |
| CONDITION_RELAX_UNASKED | RELAX_PROPOSAL_RE（条件を変えた場合・代替案・優先順位）。免除: 探索後の過去形／顧客の疑問形質問／顧客が緩和条件を明言 | block |
| FABRICATED_SEARCH_REPORT | SEARCH_REPORT_RE（少ない状況でした／募集ございませんでした）が allow_after_search 以外 | block |
| HEDGE_WITHOUT_SEARCH_DECL | allow_on_customer_ask で傾向回答に探索宣言（SEARCH_DECL_RE）が無い | block |
| SELF_HEDGE_ECHO | 顧客の自己ヘッジに同意（難しいと思います／おっしゃる通り） | warning |
| GENERIC_ONLY_REPLY（限定） | `usedCommit && !hasConcreteDeclaration`（具体宣言なしの全力サポート＝あやさん型）に限定。それ以外は WE_DO_MISSING_DET。感謝の「ございます！」を説明文に数えない | block |
| CLOSER_MISSING | closer=commit_until_found なのに COMMIT_CLOSER_RE 無し（SKELETON_CODES＝文を足す修正） | warning |
| COMMIT_AFTER_DELIVERABLE | 成果物添付（🌟・号室・見積書・ピックアップしました）に全力サポート | warning |
| NANISOTSU_MISPLACED | 何卒があるのに verdict.nanisotsu=false（条件変更・事務往復・日程・質問回答・成果物） | warning |
| PASSIVE_CLOSER | commit / receive が期待される場面で「いつでもお気軽に／ごゆっくり」締め | warning |
| RESULT_EXCUSE | 顧客主導の条件変更＋成果物に「少ない状況でしたので広げました」 | warning |
| CONDITION_ECHO_MISSING | 条件トークン≥2 で復唱率<50%（SKELETON_CODES） | 復唱0 → block、他 warning |
| SCHEDULE_ASSERT_UNCONFIRMED | 顧客が日時未確定（customer_asking / staff_proposing）で「〜で何卒」「ご案内させて頂きます」の確定形・「如何でしょうか」無し | warning（isAutoSend → block） |
| FACT_DEFERRED_ANSWER | 既知事実の質問に「確認させて頂きます」で逃げる | warning |
| WIDEN_EXCUSE_REDUNDANT / REASSURANCE_NO_BASIS / URGENCY_NO_INTENT / CONSIDER_PUSH / HUMBLE_WAIT | detectExcusePhrases | warning（URGENCY は isAutoSend → block） |
- route.ts DET_CODES_RE・final-check DIFF_RECHECK_CODES・inferDiffIssuePass に全コード追加済み（後処理後 recheck で置換される）
- FinalCheckContext に `hedge` / `closerVerdict` 追加。route.ts の finalCheckCtx / detCtx / postDetCtx 3か所に同一オブジェクト

### プロンプト（line-reply-prompts.ts）
- PHASE_COMMON_FORMAT: 締め行（resolveCloser と同名）＋先回りヘッジ禁止行を追加
- VOCAB_SEMANTICS 冒頭に「■ 0. 姿勢ガイド」①〜⑦
- TIMING_FEWSHOT 末尾に締め・姿勢の正例4（みく／瑞希／うの結果報告／慶次依頼）・NG例4（先回りヘッジ／あやさん型／事務往復の何卒／日程決め打ち）
- 【予算・条件指定の在庫質問】は「疑問形の直接質問のみ」に限定＋探索宣言必須。「▼ 予算と条件のトレードオフ質問」に条件付き依頼の除外。REAL_ESTATE_RULES「条件を絞るほど〜優先順位を聞くのが正解」→ (a)疑問形質問 (b)探索後の結果報告 のみ可に置換
- route.ts: conditionDirection 禁止語から「全力でサポート」を削除し3〜4行目を closerVerdict リテラルに／inlineConditionsFallback・conditionChangeShapeNote NG例・newConditionRequestNote ⑥・conditionChangeShapeNote ⑤ にヘッジ禁止を追記／budgetInventoryNote を hedge.customerAsked にゲート

### DB
- 新カラム不要（reply_context_snapshot JSONB に hedge / closer / stance_draft / stance_sent_lite）。migrate-schema に `idx_are_ctx_closer` 追記
- 監視 SQL: `SELECT reply_context_snapshot->'stance_draft'->>'closer_kind' AS draft_closer, reply_context_snapshot->'stance_sent_lite'->>'closer_kind' AS sent_closer, reply_context_snapshot->'turnPair'->>'ruleId' AS rule, COUNT(*), AVG(was_ai_modified::int) FROM ai_reply_examples WHERE reply_context_snapshot ? 'stance_draft' AND created_at >= now() - interval '14 days' GROUP BY 1,2,3 ORDER BY 4 DESC`

### 回帰テスト
`app/lib/__tests__/stance.test.ts`（17件・vitest 不要の自己完結ハーネス）。実行: `npx tsx app/lib/__tests__/stance.test.ts`

### 判断メモ・引き継ぎ
- 「全力でサポート」は具体宣言の**代わり**（あやさん型）は GENERIC_ONLY_REPLY block、具体宣言の**後**（みく型）は必須（CLOSER_MISSING）。両者は `hasConcreteDeclaration`（CONCRETE_DECL_RE）で区別
- 「何卒」は文脈依存: 初回・条件受領（condition_ask への回答）・書類依頼のみ付ける。進行中の条件変更（瑞希）・事務往復・日程・成果物・質問回答には付けない（warning 止まり）
- みくの復唱率は「12月／10分以内／20万以内／35㎡」を落とすと 4/8=0.5 でギリギリ。期待返信は 35㎡以上 も復唱する形
- [ ] 2週間後: NANISOTSU_MISPLACED / CLOSER_MISSING / PASSIVE_CLOSER の発火率と編集率を stance_draft→stance_sent_lite 遷移行列で確認し、編集率が高いものを block に昇格。FP が出たら detect を緩める
- [ ] promiseEchoNote（短い了承）の「締め1文」が何卒を生むと NANISOTSU_MISPLACED warning が出る。発火が多ければ promiseEchoNote の締めを「約束復唱で終える」に明文化


---

## 2026-09-09 行動台帳（Action Ledger）— 「我々が何をしたか」を生成・検査・ブレイン・学習に届ける（Fable5 みく事例）

### 事例と根本原因
- みく 10:40 スタッフ「…ピックアップして**お送りさせて頂きます**」（宣言のみ・物件0件）→ 11:45 顧客「大阪の市内付近で（京都・尼崎はNG）」→ AI 11:46「大阪市内に絞って**再度**ピックアップ…」（NG）／実送信 11:48「大阪市内に絞らせて頂き、〔条件復唱〕でピックアップさせて頂きます！！ピックアップ出来次第お送りさせて頂きます！！何卒」
- 生成源: `classifyLastStaffTurn` が未来形宣言を `other` に落とし `ANY_CONDITION_CHANGE` の「再ピックアップ宣言」direction が LLM に渡った。検査側 suggestion（旧 L1032/L1046「再度ピックアップしてお送り」）と DOUBLE_DECLARATION→修正ループが「再度」を挿入する直接機序
- 構造欠陥: 「宣言（promised）」と「実行（done）」を区別する構造が無く、送付実績は `countSentProperties`（🌟 regex・見積本文の🌟割引を誤カウント）だけだった

### 行動台帳の構造（`app/lib/action-ledger.ts`）
- `buildActionLedger({recentAixRows, messages, lineTasks, lastAixHistory, lastCustomerAt})` → `{entries, facts, summary}`
- entries: `kind`（pickup_declared / properties_sent / estimate_declared / estimate_sent / viewing_invited / meeting_place_sent / question_asked / confirmation_promised / confirmation_reported / condition_asked / application_guided / followup_sent / media_sent）× `status`（promised / done）× `source` × `confidence`。promised→done は `fulfilledBy` でリンク。done 直後の顧客反応 `customerReactionAfter`
- 証拠ソース優先順: **aix_usage_logs(3) > line_tasks・brain last_aix_history(2) > スタッフ本文 regex(1)**。AIX 行 ±3分（or line_message_id 一致）のスタッフ本文には regex を当てない（見積 AIX 本文の🌟・[画像]を物件送付に数えない）
- facts: propertiesSentCount / propertiesSentNames / propertiesSentSinceCustomerLatest / estimateSent / pickupPromisedUnfulfilled / confirmationPromisedUnfulfilled / viewingInvited / applicationGuided / lastStaffEntry / recentDone(72h) / redoAllowed
- 依存方向: action-ledger → reply-context（runtime）。reply-context は `import type` のみ。共有 STAFF_* regex は reply-context が定義・export

### 四者同名の接続
- 生成（route.ts）: `ledger` を1回構築 → `buildLedgerNote`【📒 我々の行動台帳】（往復文脈の直前）／`buildLastStaffAnnotation`（staffContextNote 注記）／`classifyLastStaffTurn({ledger})`／`resolveHedgeAllowance({ledger})`／`resolveTurnPair({ledger})`（`{redo}` `{ledger}` `{sentNames}` プレースホルダ）／`resolveCloser({ledger})`／生成直後 `applyLedgerAutoFix`（決定論・Sonnet 不使用）
- 往復セル: `StaffTurnKind` に `pickup_declared` 追加。新セル **PD_CONDITION_CHANGE**（example=みく 11:48 実送信）／**PD_ACK**／**PD_QUESTION**。ANY_CONDITION_CHANGE は `exampleBySent`（none/sent）で出し分け。PS_CONDITION_CHANGE は `{sentNames}` を並行選択肢に
- 検査（final-check.ts）: `runLedgerChecks` — **DONE_PRESUPPOSED_WITHOUT_EVIDENCE**（block: 再度／改めて／追加で／他の／こちらの／ご提案した ＋ 対象。warning: 再度空室確認／〇〇も含め／継続語）・**UNSENT_CLAIM**（お送りした〇〇・by_object）・**PROMISE_ECHO_MISMATCH**（宣言未履行で完了形・warning）。※ SENT_IGNORED（送付済み×条件変更で既送付への言及を強制）は同日廃止 — 成約データにない「選択肢として残しつつ」等の創作文を誘発したため（竹内指摘）。**台帳に無い文は足させない**。免除 4 種: evidence / deliverable_reply / customer_ref / customer_asks_more。`ledgerStrict`（generate-reply=block、check-reply=warning）
- 修正ループ: block が LEDGER_FIX_CODES だけなら `applyLedgerAutoFix` で決定論置換（Sonnet 不呼出）。混在時は `decorateFixInstruction` で台帳根拠を添え、Sonnet 修正プロンプトに `[ACTION_LEDGER]` 注入。DOUBLE_DECLARATION は「約束未履行 × 条件変更」で決定論フィルタ
- suggestion の「再度」は `redoWord(ledger)` で出し分け（検査側 suggestion が禁止語の供給源にならない）
- 学習: `tpo_debug.ledger`（summary / facts / entries / regexSentCount）→ page.tsx → save-reply-example → `reply_context_snapshot`。brain-core: `suggested_aix_meta.action_ledger` ＋ プロンプト【行動台帳（確定事実）】。新カラム不要（JSONB）

### モード（ロールバック）
- `ACTION_LEDGER_MODE` = shadow（計算＋`[ledger-diff]` ログのみ）／**inject（既定）**／enforce（sentPropertiesCount・aixDone.propertySend を台帳に統一）
- check-reply は台帳（aix_usage_logs + line_tasks）で sentPropertiesCount を算出（countSentProperties は @deprecated → enforce 確認後に削除）

### 回帰テスト
- `npx tsx app/lib/__tests__/action-ledger.test.ts`（23件）＋ `stance.test.ts`（17件）全 PASS

### 週次 SQL
```sql
SELECT count(*) FILTER (WHERE (reply_context_snapshot->'ledger'->'facts'->>'redoAllowed')='false' AND sent_reply ~ '再度|改めて') AS redo_without_evidence,
       count(*) FILTER (WHERE (reply_context_snapshot->'ledger'->'facts'->>'pickupPromisedUnfulfilled')='true' AND sent_reply ~ '出来次第') AS promise_echo_ok,
       count(*) FILTER (WHERE (reply_context_snapshot->'ledger'->>'regexSentCount')::int <> (reply_context_snapshot->'ledger'->'facts'->>'propertiesSentCount')::int) AS regex_vs_ledger_diff
FROM ai_reply_examples WHERE sent_at > now() - interval '7 days';
```

### 引き継ぎ
- [ ] 2日後: `[ledger-diff]` の差分が「見積本文／[画像]／地図」に限られることを確認 → `ACTION_LEDGER_MODE=enforce`（sentPropertiesCount・aixDone 統一）→ countSentProperties 削除
- [ ] Phase3: extract-property-info L154（estimate_sheet 由来画像を sent_properties に入れない）・page.tsx property_send 押下時に property_names 全量投入
- [ ] pickupPromiseAckNote は従来通り短い了承限定。条件変更・質問時の約束情報は【📒 行動台帳】＋ PD_* セルで届く（二重注入なし）
- [ ] 顧客の「大阪の市内付近でお願い」「〇〇はNGで」を condition_change に寄せる regex（CUST_CONDITION_STATEMENT_RE / KIND_RE condition）を追加済み。誤発火があれば `市内|付近|NG` を絞る

---

## 2026-09-09 G32 「お待たせ致しました」全廃と冒頭二層（挨拶行＋開口語）の意味ベース確定（Fable5 じゅにあ事例・竹内方針）

### 事例と根本原因
- じゅにあ 11:13 スタッフ送信 → 11:45 顧客「よろしくお願いします🙇」（了承のみ）→ 15:36「我孫子駅から天王寺駅までの間で探して頂いてもいいですか？」＋15:37 条件 → AI 16:16「じゅにあさん**お待たせ致しました**！！…」（NG）／実送信 16:17「**かしこまりました😊！！** 我孫子駅から…探させて頂きます！！」
- 直接原因: G30/G31 の `resolveGreeting` が「時間（3h）」と「成果物有無」で `kind=waited` を決めていた。11:45 の了承のみメッセージが待ち起点になり 4.5h ≥ 3h → waited → `enforceOpening` が無条件前置 → final-check ⑦ が正解の「かしこまりました」を MISMATCH 扱い（生成・後処理・検査の三者で誤りを増幅）
- 構造欠陥: 「お待たせ致しました（結果報告）」と「かしこまりました（引き受け）」が排他的な意味カテゴリであることがコードのどこにも表現されておらず、時間軸と意味軸を1つの分岐に混ぜていた。自動返信へ移行すると「返信を待たせた」前提自体が消える

### 冒頭語セマンティクス（正解 1,355 件・2026-05-25〜09-09）
| 冒頭 | 件数 | 意味 | 使う条件 | G32 |
|---|---|---|---|---|
| 挨拶なし（本題・目的語付き受領礼・物件名・名前行のみ） | 412 (30%) | 会話連続中／受領礼／結果直入 | 当日挨拶済み、または「〇〇お送り頂きありがとうございます」「🌟物件名」で開始 | 維持 |
| かしこまりました | 311 (23%) | 依頼・条件・断り・日程の**引き受け** | customerKind ∈ {condition_change, decline} または依頼形の question／行動要求を含む了承 | 維持・時間に無関係 |
| お世話になっております | 222 (16%) | 名前付きの**再開の挨拶行** | 当日その顧客に未送信 かつ 初回でない | 維持（時刻ベース） |
| はい | 194 (14%) | 了承・お礼・感想・自己宣言の**受け止め** | ack_only／positive／thinking／will_send_later で行動要求なし | 維持 |
| はじめまして | 127 (9%) | 真の初回 | isFirstEverReply | 維持 |
| お待たせ致しました | 13 (1.0%) | 約束した結果を持ってきた | — | **廃止（禁止語）** |
| 承知しました | 4 | — | — | かしこまりました に正規化 |
- 二層は **お世話に→かしこまりました 54／→はい 9 のみ**。「お待たせ→開口語」0、「はじめまして→開口語」0。AI お待たせ→スタッフ修正 4 件の置換先は お世話に／名前行／かしこまりました／催促謝罪。逆方向 0 件

### 新ロジック（`app/lib/greeting.ts`・四者同名: buildGreetingNote／enforceOpening／final-check ⑦／toGreetingLite）
- `GreetingKind` = first | late_apology | standard | none（**waited 廃止**）。挨拶行は接触の事実だけ: 初回→はじめまして／`isProgressPushMessage`（了承のみは催促に数えない）→ご連絡遅くなり／当日挨拶済み→なし／それ以外→〇〇さんお世話になっております。夜間接頭辞は従来どおり
- `resolveOpener`: 開口語は `classifyCustomerResponse.kind` × `substance.kinds`（asksAction）だけで決める。decline/condition_change/依頼形 question→kashikomari、ack_only/positive/thinking/will_send_later（行動要求なし）→hai、情報質問・answer・concern・deliverable→none。`openerAllowed` 内の LLM 出力は尊重、外なら置換／除去、**無い時に足さない**
- 経過時間は `GreetingDecision.audit`（waitedMs / originCreatedAt / originTextHead / alreadyGreetedToday / customerKind / isDeliverableReply）に保存するだけで決定に使わない。起点は「実質のある最古の未返信メッセージ」（了承のみは起点にしない）
- 禁止語: `WAITED_RE` / `stripWaited`（文中どこでも文節ごと除去）／final-check `BANNED_WORDS_DETERMINISTIC` に お待たせ致しました・お待たせいたしました・お待たせしました（block・suggestion は decision 付き）
- `normalizeGreetingLite`: DB の旧形式（kind=waited）を standard に写像し opening の お待たせ→お世話に に置換（check-reply 復元用）
- final-check ⑦: 7-a 確定挨拶行（late_apology／夜間）不一致 → OPENING_GREETING_MISMATCH／7-b 催促でないのに謝罪行・7-c none なのに定型挨拶・7-d 夜間 → OPENING_GREETING_UNEXPECTED／7-e 開口語が openerAllowed の外 → **OPENER_MISMATCH**（新コード・warning）。GREETING_WAITED_MISUSE は廃止
- check-reply: `recentMessages[].createdAt` があれば generate-reply と同じ `resolveGreeting` で再計算、無ければ `tpo_debug.greeting` の復元値（first なのにスタッフ送信済みなら破棄）
- 進捗催促ラベル（route.ts tpoNoteForLLM）も `isProgressPushMessage` に統一

### 生成側・few-shot・テンプレからの「お待たせ」除去（BANNED_WORD block で送信不能になるため同時変更）
- prompts ■G 全置換（二層の説明）・L516 正例・L1674・L1728・PHASE_COMMON_FORMAT（依頼形質問→かしこまりました）
- reply-context: PS_CONDITION_CHANGE_SEARCHED example → お世話に、ES_CONCERN example から「はい！！」除去（concern の許容集合と整合）、PD_QUESTION に `suggestion` 追加（`PairRule.suggestion?` 新設・PAIR_ELEMENT_MISSING が example より優先）＋ mustInclude に「させて頂きます」
- aix/action `buildGreeting`: staffMessagedToday → ""（挨拶行なし）。テンプレ・few-shot の「お待たせいたしました！！」は `${greetingPhrase}`（空なら本題から）に。greetingTimeNote は空フレーズ時「挨拶行を書かない」文に
- template-preprocess `selectGreeting`: 当日送信済み→""（21時以降は夜分遅く）。`applyGreetingSwap` は "" なら改行ごと消す
- aix-template-generate（3か所）・AixModal テンプレ・AixManualModal 説明文・brain-core REPLY_STYLE_RULES から除去。stance.test の fixture を お世話に／はい に
- 残存（意図的）: 検出・剥がし用 regex（GREETING_STRIP_RE / GREETING_BLOCK_RE / BOILERPLATE_RE / GREETING_KEYWORDS / SQL ilike）、禁止を書いた指示文、action-ledger.test の過去スタッフ文 fixture

### 回帰テスト
`npx tsx app/lib/__tests__/greeting.test.ts`（19件: じゅにあ T1〜T4／挨拶行 T5〜T10／催促 T11〜T12／後処理・禁止語 T13〜T17）＋ stance 17件＋ action-ledger 23件 全 PASS。tsc エラー0。コミット `9d4b8d3f`

### 週次 SQL（廃止の妥当性検証）
```sql
SELECT (reply_context_snapshot->'greeting'->>'kind') AS kind, (reply_context_snapshot->'greeting'->>'opener') AS opener,
       width_bucket(((reply_context_snapshot->'greeting'->'audit'->>'waitedMs')::bigint)/3600000.0, 0, 24, 8) AS waited_h_bucket,
       COUNT(*), AVG(was_ai_modified::int) AS edit_rate
FROM ai_reply_examples WHERE reply_context_snapshot ? 'greeting' AND created_at >= now() - interval '14 days'
GROUP BY 1,2,3 ORDER BY 4 DESC;
```

### 引き継ぎ
- [x] page.tsx の送信ボタン側が check-reply に `recentMessages[].createdAt`（`m.rawCreatedAt`）を渡すようにした → 再計算経路が有効（復元経路は createdAt 欠落時のフォールバック）
- [ ] `ai_prompt_rules` に「3時間以上待たせたらお待たせ致しました」等の同旨行が残っていれば is_active=false に（禁止語 block と衝突し修正ループを回す）
- [ ] 2週間後: OPENER_MISMATCH の発火率と編集率を確認。FP が多い kind（特に question の asksAction 判定）は `openerAllowed` を**広げる**（opener を足さない）
- [ ] system_design_thinking に G32 知見 5 件 INSERT 済み（二層・禁止語・audit・四者同名の増幅リスク・了承のみは未返信に数えない）

---

## 2026-09-10 Fable5 みく事例 — ブレインの会話スコープ・フィールドがメッセージ判定を汚染する構造の是正

**症状**: みく 18:50「ありがとうございます！確認させていただきます🙇」に対し、AI が「ご要望お聞かせ頂きありがとうございます😊！！／初期費用を抑えられる、築浅・広めのお部屋を中心に…お調べさせて頂きます！！」と、条件を受け取った直後のテンプレを返した（返信になっていない）。final-check は ok:true / issues:[] / revision_count:1 で素通り。

### 根本原因
1. `repeated_concern`（＝会話全体で2回以上出た論点）を `mergeBrainEvidence` と `classifyCustomerResponse` が「このメッセージが懸念である」証拠として無条件採用していた。実データ 96会話中 70件（73%）が保持、うち 66件（94%）は `customer_concern=null`＝メッセージ由来の証拠ゼロ。
2. 唯一のガードが `isAckOnly` で、待ち句を含む中間状態（`residue="" / isAckOnly=false`）が素通り。誤爆14件中4件がこの「確認します／検討させていただきます」型。
3. `resolveTurnPair` が `customerObject===null`（懸念の対象が本文に無い指紋）を棄却条件に使わず PS_CONCERN を選び、`fillPairPlaceholders` の汎用フォールバック `|| "ご希望条件のお部屋を中心に"` が証拠の欠落を文面の完成度で覆い隠していた。

### 新しい設計（app/lib/reply-context.ts）
- **BrainScope 型分離**: `BrainMessageLocal`（`scope:"message-local"` 必須リテラル。customer_questions / customer_concern / condition_change_type / hesitancy_pattern / customer_intent）と `BrainConversationScope`（`scope:"conversation"`。repeated_concern / engagement_stance / avoid_topics / reply_direction / latent_intent / closing_strategy / winning_pattern / current_property / future_timeline / purchase_signal_level / checkpoint_stage）。変換は `toBrainMessageLocal` / `toBrainConversationScope` の2関数だけが入口（呼び出し側でフィールドを手詰めしない）。分類器は message-local しか受け取れないシグネチャ＝conversation-scope を渡すとコンパイルエラー。
- **`SubstanceVerdict.isPureBoilerplate`（residueLen===0）と `.waitSignal`（検討／確認／相談／連絡）を新設**。brain 合流のガードを `isAckOnly` から `isPureBoilerplate` に移した（`isAckOnly ⊂ isPureBoilerplate`）。`brain.skipped:pure_boilerplate:*` が evidence に残る。
- **`anchorBrainConcern`**: brain の customer_concern は topic/object が本文に実在する時だけ採用（差分分析モードの前回値持ち越し対策）。`repeated_concern` と `customer_intent==="negative"` は加算条件から全廃。旧 `hesitancy_pattern === "concern"`（存在しない値＝永久 false の死んだ条件）は thinking に合流。
- **`CustomerResponse` を判別共用体化**: concern だけ `object: string` 必須＝「対象語のない懸念」を型として作れない。
- **`resolveTurnPair` のセル選択ガード**: `kind==="concern" && !object && substance.concerns.length===0` なら懸念セルを引かず `waitSignal.yes ? thinking : isPureBoilerplate ? ack_only : other` に降格し `pair.cellGuard` に記録（check-reply・古い snapshot 復元経路の二重防護）。
- **`fillPairPlaceholders` の汎用フォールバック廃止** ＋ `assertPlaceholder`（{object}/{fix} が空のままレンダリングされたら dev は throw・本番は console.error）。
- **`WAIT_PHRASE_RE` を thinking の入口に追加**（CUST_THINKING_RE には「確認／拝見／チェック」が1語も無く、PS_THINKING の「確認します→ご確認」鏡写しに到達できなかった）。
- **PS_CONCERN / VI_CONCERN の direction から完成文リテラルを除去**（NG 出力「ご要望お聞かせ頂きありがとうございます😊！！」は direction リテラルとして2箇所に存在し、example と違って**無条件に注入**されていた）。要素ごとに `fix` を付与。
- **`PairMustInclude.preferWhenAvoid`**: 「A or B」の必須要素は brain avoid と衝突する側を除外して残る側をリテラル指名（文を足す指示ではなく選択肢を削る指示＝創作を誘発しない）。PS_THINKING に付与し、`exampleFallback` を「随時ピックアップ」型 →「扉を開ける」型（ES_THINKING/VI_THINKING の成約実文と同型）に差し替え。
- **`detectCellConflicts` / `avoidConflictsWithCell`**: 必須要素ラベルと avoid_topics を意味クラス表（new_pickup / estimate / viewing / apply / vacancy）で正規化してから突き合わせる。旧 `m.label.includes(t)` は「新規物件ピックアップ」と「再ピックアップ宣言」を衝突と認識できなかった。

### 新コード（app/lib/final-check.ts）
| code | 条件 | severity |
|---|---|---|
| `UNPROMPTED_PROPOSAL` | `substance.isPureBoilerplate`（顧客が条件・要望・懸念を1文字も書いていない）のに新規の探索・提案を宣言。免除① 選ばれたセルがまさにその文を要求 ② 未履行ピックアップ約束の復唱 | brain が `engagement_stance=wait` or `avoid_topics` に新規ピックアップ → **block** / それ以外 → warning |
| `CELL_AVOID_CONFLICT` | `ctx.cellConflicts`（セル必須要素 × brain 方針の正面衝突）。診断専用・修正ループから除外 | warning |
| `ECHO_FROM_BRAIN_NOT_CUSTOMER` | 顧客も DB 条件も書いていない条件語の復唱。`UNANCHORED_CONDITION_MODE=shadow`（既定）は tpo_debug 記録のみ | warning（昇格後） |

`CheckResult.pre_revision_issues` を新設（最終 CheckResult は recheck で丸ごと置換されるため、「何を直したのか」を追える唯一の記録）。`SKELETON_CODES` には**入れない**（削除系）。

### tpo_debug の追加項目
`substance.isPureBoilerplate` / `substance.waitSignal` / `turnPair.cellGuard` / `cellConflicts` / `brainStrategy`（engagement_stance・repeated_concern・avoid_topics）/ `preRevisionCodes` / `unanchoredConditionEchoes`。`turnPair.customer*` は降格後の `pairContext.customer` を記録する。

### みく 18:50 の修正後 期待返信（セル: PS_THINKING・開口語 hai・締め wait_softly）
```
はい😊！！
ごゆっくりご確認頂けますと幸いです！！
お部屋お気に召されましたら、実際にお部屋ご案内させて頂きますのでいつでもお気軽にご連絡ください😌！！
```

### 回帰テスト
`npx tsx app/lib/__tests__/brain-scope.test.ts` = **24 PASS**（S: residue と brain スコープ8／T: セル選択7／U: brain 方針3／V: final-check 5）。既存 pair-example 21・greeting 19・action-ledger 23・stance 17 も全 PASS（回帰なし）。`npx tsc --noEmit` エラー0。コミット `9fbd2482`

### 引き継ぎ
- [ ] 1週間後: `tpo_debug.cellConflicts` の発火率と `turnPair.cellGuard.concernDemoted` の件数を SQL で確認。`UNPROMPTED_PROPOSAL:warning` が誤検知ゼロなら block 昇格を検討
- [ ] 2週間後: `reply_context_snapshot->'unanchoredConditionEchoes'` × `ai_draft <> sent_reply` で `ECHO_FROM_BRAIN_NOT_CUSTOMER` の shadow → warning 昇格を判断（`UNANCHORED_CONDITION_MODE=warning`）
- [ ] `preRevisionCodes` が入ったので「revision_count>0 で issues が空」＝誤った direction に合わせて書き換えたケースを SQL で追える。週次で `preRevisionCodes` と `finalCheckCodes` の差分を見る
- [ ] `current_property` / `future_timeline` / `avoid_topics` も conversation-scope。今回は分類器からは切り離したが、生成 note 側で「今回のメッセージの性質」として使っていないか次セッションで棚卸しする
- [x] system_design_thinking に4件 INSERT 済み（意味スコープ2軸・residue が最強の一次証拠・空プレースホルダは証拠ゼロの指紋・衝突したらセル選択を疑う）

---

## 2026-09-11 返信生成 × 最終チェックの衝突解消（経路 A〜G・統合設計）

### 竹内の依頼
「返信とファイナルチェックの部分でぶつかっている。どこかボトルネックになっている。設計知見と協力して改善する」。UI（最終チェックパネル折りたたみ）は 0e50ffe0 で修正済み（page.tsx は今回触らない）。

### 根本原因（1行）
同じ事実（もう送ったか／質問に答えたか／締めの場面か／顧客名）を、生成・後処理・決定論検査・LLM 検査・修正指示が**別の regex・別のデータ源**で判定し、さらに suggestion・後処理の置換文・生成ノートが verdict を経由しない**固定リテラル**（別顧客の example・〇〇・「かしこまりました😊！！」）になっていた。生成が正しく書いた必須文を後処理が消し（F）、検査が狭い語彙で正解を落とし（C・D）、修正ループには材料が無い（A・B）。loop2 で1回タイムアウトすると修正枠ごと消える（G）。

### 経路別の結論と対処
| 経路 | 結論 | 対処（単一真実源） |
|---|---|---|
| A suggestion に別顧客の実文 | 部分（流入は実証・本文への貼り付けは0件） | `PairMustInclude.fix` を**型で必須**化（29要素に追加）・`PairRule.suggestion` 削除・`pairElementSuggestion` は fix のみ・修正プロンプトの例文は `selectPairExample`（生成と同じ前提ゲート） |
| B 〇〇 未置換 | 部分（本文漏れは🐥の1件・suggestion への混入は広い） | `fillNameSlot`（{name}／〇〇さん を確定名で埋める・不明なら呼びかけ＋助詞ごと削除）を reply-context に新設し fillPairPlaceholders・validateAndClean（aixGates 時）・修正版に適用。名前フォールバック「〇〇さん」全廃。confirmationGateNote の固定句を削除 |
| C 回答検出が狭い | 確定（偽陽性 82%） | `hasDirectAnswer` / `ANSWER_FORM_RE`（人の実送信 n=519 の回答形・絵文字後置OK）を ①④⑦・質問セル detect が共有。`questionForm`（依頼形なら行動宣言が回答）。EXPLANATORY_RE / ANSWER_RE 廃止 |
| D 締めの矛盾 | 確定（成約の締め正解 5/5 が block） | `resolveClosing`（decline/farewell）・`ANY_FAREWELL`（closingOnly）・`farewell_ack` staff 種別・`isClosedVerdict` を ①⑦・修正プロンプト（REVISION_MODE=closing）・LLM [STAGE] が共有。足す系の代わりに削る系 `CLOSING_FORWARD_PUSH`(warning) |
| E 台帳 vs staff 判定 | 字義どおりは否定（0件）・実在5経路 | E1 `pickupRound`（「まだ1件も送っていない」を固定文で持たない）／E2 ③ last_aix_history は本文も時刻も無い時だけ／E3 機械的に閉じた property_send を物件送付にしない／E4 重複除去は送信証拠を優先／E5 PROMISE_ECHO_MISSING と生成側の約束検出を台帳で絞る／E6 check-reply も同じ入力で pairContext |
| F 後処理が削りすぎ | 確定（YUYA・it_0 の直接原因） | `resolvePickupGate`（送付後の未履行宣言・条件変更・ピックアップを必須にするセルでは再宣言禁止にしない）で aixDone を整合。`PICKUP_KEEP_RE`（出来次第お送り・全力サポートは消さない）・`protect=isCellRequiredSentence`・受付文は削除位置でなく先頭へ・見積金額内訳ゲートは顧客条件の復唱を免除・安全弁 `GATE_PAIR_CONFLICT`（削除で骨格 block が増えたらピックアップゲートだけ取り消し）・applyLedgerAutoFix を gen2 にも |
| G context_check 未完了 | 部分（落ちるパスは毎回違う・loop2 で致命的） | `runFinalCheck` を deadline 連動（パス上限 20/15/25s）＋失敗パスのみ1回再送・`pass_failures`/`pass_ms` 記録・check1 の締切＝予算−修正枠・差分再検査は完了パスを引き継ぐ（`diff_verified`）・改善比較から UNCHECKED_AUTO_SEND を除外・check-reply は生成時結果の再利用（`context_hash`）＋context_check を Haiku に |

### 矛盾マトリクスの解消規則（抜粋）
足す指示と削る指示が同じ場面で出る時は、その場面の verdict（セル・締め・台帳）が片方を「出さない」。優先順位ルールは足さない。M1 セル必須要素＞ピックアップ再宣言ゲート／M4 締め verdict＞足す系／M7 回答判定は hasDirectAnswer の1関数／M8 thanksAllowed の時だけ BANNED「ご査収頂きありがとう」免除／M13 足す系 block がある時 NANISOTSU は info／M14 確認約束が許可されている時は修正ガードを外す／M16 DOUBLE_DECLARATION はセル必須要素の文なら除去／M18 差分再検査の passes 洗浄を廃止。

### テスト
`npx tsx app/lib/__tests__/gen-check-conflict.test.ts` = **29 PASS**（YUYA / it_0 / 楓馬 / ﾓﾓｶ / 慶次 / うえっち / 🐥 / みく の実文フィクスチャ）。既存 positive-viewing 16・brain-scope 24・pair-example 21・greeting 19・action-ledger 23・stance 17 全 PASS。action-ledger #2・#20 の期待値は E4（送信証拠を優先して残す）に合わせて更新（旧期待値は line_task が staff_text を吸収する挙動そのもの）。`npx tsc --noEmit` エラー0。

### やらなかったこと（理由）
page.tsx・MAX_CHECK_ITERATIONS／予算の引き上げ（材料不足が原因）・UNCHECKED_AUTO_SEND の warning 化（自動送信 fail-closed）・G6 断言禁止の緩和・事実の正確性（ﾓﾓｶ「1時間」）・「再度」の可否を next ラウンドで変えること（成約データで裏付けてから）・STAFF_VIEWING_INVITE_RE の窓拡大・ちあき★の謝罪可否（竹内判断）・差分再検査で欠けたパスの単独再実行（今回は UNCHECKED_AUTO_SEND を引き継ぐだけ）・isGratitudeReplyTPO の farewell 連動（PURE_ACK 拡張で感謝返しに自然に入るため）・aix-template-generate の fixNamePlaceholderAddress 統合。

### 引き継ぎ
- [ ] 3日後: `ai_draft_check->'issues'` の suggestion に他顧客名（みく・瑞希・愛乃・スプランディッド・梅田・9月13日・換気）と 〇〇／△△ が0件か SQL で確認
- [ ] 1週間後: `revision_exhausted` 率（日次）・`tpo_debug.postprocess.reverted`（GATE_PAIR_CONFLICT）件数・`pass_failures` の内訳を確認。check-reply の context_check（Haiku 2.3s）のタイムアウトが30%超なら passes から外す方式へ
- [ ] `CLOSING_FORWARD_PUSH`(warning) の発火と人の削除率を見て、締めの ANY_FAREWELL 例文（成約★舞桜）の妥当性を確認
- [ ] 「再度」の可否（next ラウンド）: ai_reply_examples で propertiesSentCount>0 かつ直前がピックアップ宣言の正解に「再度」が含まれる率を出してから redoWord を見直す


---

## 2026-09-11 竹内方針1〜5（必須要素・物件名の復唱・呼び名・承知・すぐに）統合設計の実装

### 竹内の方針
1. 必須要素（PAIR_ELEMENT_MISSING）はスタッフの実際の返信を優先。最終チェックのこの枠は「誤字の確認」に限定し、必須要素の有無で block しない
2. 物件名・建物名は復唱しない（生成で埋め込まない・検査で要求しない）
3. 呼び名は実際に呼んでいる名前のまま。途中で変えない
4. 「承知いたしました／承知しました／承知致しました」は使わない →「かしこまりました」
5. 「すぐに」は使わない

### 正解文の回帰（常設: `npx tsx --env-file=.env.local scripts/audit-final-check-vs-staff.ts`）
正解 777件（line_reply・修正あり or ☆・会話あり）→ 生成失敗文2件除外・直前に顧客発言なし22件 → 測定753件。
| モード | 変更前 | 変更後 |
|---|---|---|
| 本番同等（未返信の顧客発言を連結・既定） | 361/753＝47.9% | **42/753＝5.6%** |
| 単発（旧測定・--last-unit-only） | 336/753＝44.6%（竹内報告の44%） | 60/753＝8.0%（CONFIRM 20件は単発で前の通の物件名を渡さない測定上の見かけ） |
| 後処理なし（--raw） | ― | 69/753＝9.2%（HASTY 20・承知を含む BANNED が残る＝後処理で直る分） |
| AI 下書き（--draft・下書き≠送信 534件） | ― | 66/534＝12.4%（本当の誤りは止まる。NAME_MISMATCH は清水さん会話の「吉永さん」1件だけ） |
変更前→後（本番同等）: PAIR_ELEMENT_MISSING 186→0 / CONDITION_ECHO_MISSING 82→0 / NAME_MISMATCH 57→0 / CONCERN_UNADDRESSED 52→0 / BANNED_WORD 34→16 / WE_DO_MISSING_DET 28→0 / REPLY_SKELETON_MISSING 25→0 / HASTY_PROMISE 17→0 / GENERIC_ONLY_REPLY 10→0 / CONFIRM_NO_OBJECT 9→1。
既定の閾値 10%・コード別上限（観測専用と ECHO・HASTY は 0件、NAME / CONFIRM は 0.5%）・`scripts/audit-final-check-baseline.json`（id→コードのみ）で回帰を検知。

### 実装（1つの事実を1つの関数で決める）
- **観測専用** `OBSERVE_ONLY_CODES`（PEM / REPLY_SKELETON / CONCERN_UNADDRESSED / WE_DO_MISSING(_DET) / GENERIC_ONLY）は常に info。`isRevisable` で修正ループ（warning・block 両経路・差分再検査）に渡さない。LLM の context_check プロンプトから「欠けていれば指摘」を削除。修正プロンプトの骨格系節は EMPTY_CLOSER / SPLIT_ACK_REPLY の時だけ。後処理ゲートの安全弁は severity 非依存の `cellElementGaps`
- **誤字** `app/lib/typo-check.ts`（敬称の二重・語の重複・脱字辞書・助詞の重複・「！、」・\n 漏れ・曜日＝日付を正）。自動修正は後処理、残りだけ TYPO_* warning（block しない）。誤検出: 正解 13/753（全て実誤字）・人の送信 1.35%・AIX 0.36%・下書き 2.48%
- **承知・すぐに** `app/lib/banned-phrasing.ts`（normalizeShochi / stripHastyAdverb。否定先読みは「に?」の前）。後処理・修正版・few-shot 注入前・HASTY_PROMISE 検査が同じ正規表現。「〜次第すぐに」の BANNED 8語は HASTY と重複なので削除。生成指示の「単独使用禁止」「退去後すぐに」「今すぐピックアップ」「確認してすぐご案内」を書き換え
- **後処理の入口** `applySurfaceFixes`（validate-reply.ts）＝別名の統一→承知・すぐに→誤字→名前スロット。validateAndClean の末尾と final-check の修正版2か所
- **場面の判定** `resolveCustomerDocScope`（reply-context.ts）＝申込フォーム／条件フォーム／物件送付／自由記述の条件／なし。物件送付・申込フォームは tokens 空。建物名・所在階・住所・日付・N円はトークンにしない。CONDITION_ECHO は条件の場面だけ warning。懸念はテンプレート貼り返しとラベルを剥がした本文で「同じ行」のみ・譲歩形を除く
- **物件名を生成に入れない** 台帳 summary・note は件数のみ、{sentNames}/{namedProperty}→「お部屋」、{positiveEvidence} から物件名を除く、他顧客の物件名入り example を削除だけで修正、「物件名は事実に置換」「物件名を添えた受付文でよい」を「物件名は書かない」に
- **呼び名** `resolveAddressName`（直近スタッフの行頭呼びかけ→強いつながり→スタッフ履歴が無い時だけ名乗り→DB名→表示名）。`normalizeDisplayName`（分割・結合しない・ちゃんを残す）。検査は呼びかけ位置の別名だけ block・前方一致・カタカナ「サン」除外・紹介者文脈除外。aliases は後処理で確定名に統一。generate-reply の extractPreferredName を廃止（page / bg で呼び名が変わっていた）。tpo_debug.address_name に根拠
- **PAIR_MATRIX** 質問セルは hasDirectAnswer(request)・ANSWER_FIX 4型（費用は見積宣言）・PD_QUESTION 履行約束と PS_QUESTION 次工程を削除。CA_CONDITION 伴走締め削除（closer none）。条件の探索宣言は「お届け・ご提案・探させて」も。懸念セルは前置き不要・懸念の replyRe で判定。前向きセルは「次の一手を1つ」だけ（ご査収感謝・開口語を削除）
- **CONFIRM_NO_OBJECT** 見積依頼・送付済み物件の名指し・内覧希望・番号の並びを確認対象に。「確認させて頂き、」も確認約束。物件を探す約束（お部屋確認でき次第）は除外。返信の確認対象が会話に実在すれば info（reply_anchored_object）
- **データ衛生** `app/lib/example-hygiene.ts`。失敗文・テスト送信を few-shot・学習・評価から読む側で除外、送信（400）と保存で止める（行は削除しない）

### テスト
新規 banned-phrasing 11 / typo-check 12 / name 14 / echo-scope 10 / concern-confirm 11 / hygiene 6 / skeleton-observe 23（匿名化した正解代表20件）全 PASS。既存7本 gen-check-conflict 32 / positive-viewing 16 / brain-scope 24 / pair-example 21 / greeting 19 / action-ledger 23 / stance 17 全 PASS（期待値の更新は :block→:info／:warning、CA_CONDITION の closer none、前向きセルの「ご案内させて頂きます」を次の一手と認める＝T-10/T-15 を反転）。`npx tsc --noEmit` エラー0。

### 残った block（本番同等 42件）
BANNED 16（ご連絡お待ちしております6・承りました4・ご内覧させて頂き2・見つかり次第ご連絡1・番手確認1・共益費込1・名無し1）＝竹内確認事項⑤／SCREENING_ASSURANCE 5・VACANCY 2・DISCLOSURE 1・MOVEIN 1（宅建業法の断言禁止＝維持）／VOCAB_MIRROR_MISMATCH 5（「拝見します」への「ごゆっくりご確認／ご覧」＝検査側の偽陽性の可能性・要調査）ほか各1〜2件。

### 竹内確認事項（未決）
① EMPTY_CLOSER / SPLIT_ACK_REPLY を block で残すか ② スタッフ履歴がある会話で名乗り後も元の呼び名を続けるか ③「すぐに埋まってしまう」は対象外でよいか ④ 失敗文由来の ai_reply_knowledge 11行を rejected にするか ⑤ スタッフが使う BANNED 語（承りました・ご連絡お待ちしております）の禁止を維持するか ⑥ CLOSER_MISSING を warning 表示で残すか ⑦ 曜日の自動修正は日付を正としてよいか

### 引き継ぎ
- [ ] AIX 側（aix/action の名前解決・「次第すぐに」文言、aix-template-generate の名前解決）は aix_feature_suggestions 経由で提案（直接パッチ禁止）。page.tsx:126 の extractPreferredName コピーも申し送り
- [ ] 1週間後: tpo_debug.address_name.source の分布と NAME_ALIAS_UNIFIED の件数、TYPO_* warning の件数を SQL で確認
- [ ] 常設スクリプトを週1で回し、baseline からの回帰（新たに block になった正解）が出たら原因のコードを調べる
- [ ] VOCAB_MIRROR_MISMATCH（拝見→ご確認）の5件を正解に合わせるか判断

---

## 2026-09-12 要約（竹内方針A〜E・統合設計「AIX のセットはブレインが判断する」段1・段2・仕上げ）

### 竹内の方針（最優先）
「AIX のセットはブレインが判断する。だから、そこはブレインの AIX 判断の部分に学習される」。AIX をセットするか・どの AIX か・check_pattern はブレインが唯一の判断者。返信の生成・後処理・最終チェック・画面はブレインの判断を読むだけ。スタッフが押した AIX はブレインの判断に学習として戻す。固定の場面表をブレインより先に置かない。

### 今日のコミット
| コミット | 内容 |
|---|---|
| 7dadb58f | 方針D: 日本時間の日付・曜日を jst-date.ts に一本化し、LLM に14日分の曜日表を渡す |
| 10157363 | 方針C: 呼び名は元の名前で固定（開示直後の一時切替に追従しない・人間の呼び名を AIX より優先） |
| abe11ce4 | 方針B・E: 「ご連絡お待ちしております」「承りました」は場面で使う・「次第すぐに」の取りこぼしを塞ぐ |
| 2c86c209 | 方針A: resolveReplyAix 新設・断言検査の誤検出修正（**場面表が先に AIX を決める形だったので段1で上書き**。断言検査の修正と scene-patterns.ts は残す） |
| 1113dc4c | 正解文回帰の baseline 更新（block 43/754=5.7% → 25/758=3.3%） |
| 8aecd918 | 統合設計 段1: 判断の持ち主をブレインに一本化・古い判断を AIX に使わない・画面の出どころ |
| dccdc2d8 | 統合設計 段2: 場面を証拠としてブレインに渡す・スタッフの AIX から学ぶ（cron/brain-aix-eval・brain_aix_feedback） |

### 仕上げで確認した数字（2026-09-12）
- `app/lib/__tests__/*.test.ts` 20ファイル全 PASS（aix-reply-set 18・aix-scene-evidence 20・brain-aix-feedback 32 ほか）。`npx tsc --noEmit` エラー0
- 正解文回帰: block 25/759=3.3%（baseline に対する回帰なし・改善なしのため baseline は更新していない）

### どこがブレインの判断を読むか（段1の結果）
- generate-reply: `brainDecision`（suggested_aix_meta ?? last_brain_meta・detectBrainTier と cached/optional で fresh 判定）→ `resolveReplyAixDecision` → プロンプトの「どの AIX で送るか」・SUGGESTED_AIX トレーラー・ai_draft_check.suggested_aix（source は常に brain）・[AIX誘導中]
- 本文の安全は証拠で動く: `resolveBodySafety`（橋渡し・禁止）・`confirmationBasisAction`（S1/S2/S3 の証拠 or ブレインの action で確認約束を認める）。AIX は選ばない
- page.tsx: P3.5 / P3.6 / P4.5 の説明文は suggestedAixMeta.note、P5 の runBrainAix はブレインの check_pattern を渡す

### ブレインがどの場面でどの AIX をセットするか
- 決めるのは LLM（analyzeConversation）。場面の検出は【今回の顧客発言の場面（証拠。AIX を決めるのはあなた）】と【この場面でスタッフが押した AIX の実績】として渡すだけ
- LLM も既存の信号（detectSignalBasedAixFallback）も AIX を返さない時だけ: S2 入居日 → property_check_result / mgmt_move_in（退去予定は vacate_date）、S3 審査 → property_check_result / mgmt_guarantor、S5 日時指定 → meeting_place（decision_source=signal:scene_*）
- S1 空室・S4 内覧・S6 見積・S7 条件変更は信号にしない（LLM と既存の信号・矯正に任せる。空室は acknowledge_check / property_check_result、画像だけの送信は estimate_sheet への矯正、内覧は guard:viewing で顧客の反応が無ければ出さない・退去予定なら application_push）
- check_pattern: 場面の信号 → 証拠 S2/S3 → 未返信の顧客発言だけに detectPropertyCheckPattern

### 学習ループ（スタッフが押した AIX → ブレイン）
- 直したもの: brain_decision_logs に10列（decision_source・analysis_mode・analyzed_msg_ts・scene_evidence・body_block_code・actual_*・matched 等）、brain_aix_feedback（pressed 列あり）、cron/brain-aix-eval（毎日 11:20 UTC）、ブレインの降格ゲートの読み先を brain_aix_feedback に（null 化は外した）
- 基準: action あり190件のうち AIX が押された56件中27件一致（48%）。押されなかった判断まで分母にすると 27/190（14%）
- aix_feature_suggestions に登録（AIX 学習パスはコードを直さない）:
  - 段2: 4d32b711（aix-shadow-eval で predictor=brain）・b20e86bb（log-aix-usage に brain_suggested_*）・884b76d4（suggestion_source と suggestion_accepted の数え方）・d5b8f9d7（aix-weekly-learning で check_pattern の食い違い）
  - 仕上げ: fd0ef481（suggest-next-action の P8 AIXバナーが固定ルールでブレインと別に AIX を出している。30日で chain_rule 由来の提示105件・09-05以降 property_recommendation 23件のうちブレインは property_send 11・acknowledge_check 4・なし 5）・e101a27d（/api/aix/suggest に鮮度を見ずに brain_action を渡している・fresh でブレインが AIX なしでも頻度トップを推薦）・f971f9cd（P5 ブレインカードの ✕ がどこにも記録されない → brain_decision_logs.outcome に戻す）
- system_design_thinking に5件: 8b66c4c7（AIX のセット判断はブレインが唯一の持ち主）・a9c8b06b（古い判断・cached を AIX に使わない）・3d11a730（押した AIX とブレインの判断を対にする・分母は押された判断）・bde79ebe（方針B・E）・1270ee36（方針D）。方針C は 83617cc2（09-11 登録済み）

### 引き継ぎ
- [ ] cron/brain-aix-eval の初回実行を確認（brain_aix_feedback に行が入るか・scene_staff が n≥10 たまるか）。プロンプトに入る実績欄の実際の中身を1件見る
- [ ] 本番で ai_draft_check.suggested_aix.source が aix_reply_set / final_check_assertion の件数が0か、ブレインが '' なのに AIX がセットされた件数が0か SQL で確認
- [ ] ログ `brain:mode` の upgradeReason 件数で、cached→incremental 格上げによる LLM 呼び出しの増加を測る
- [ ] 1〜2週間後: ブレインだけ当たっていた27件相当を落としていないか・場面だけ当たっていた7件相当（S5 meeting_place など）を拾えているか（scratchpad/scene-vs-staff.ts の A2 と同じ集計）
- [ ] 未確認: brain-sweep が T2（stale）の会話も補うか／analyzeAndSaveBrainMeta の同じ会話での排他／page.tsx 4325 修正で動き出した property_check タスク自動作成の運用影響／brain_decision_logs に 09-05 より前のデータが無い理由
- [ ] cached で runBrainAndNotify が null を返すため、brain-sweep の集計でその分が「失敗」と数えられる（ログの数字だけの影響）

### 竹内確認事項（未決）
① P8 AIXバナー（suggest-next-action）: ブレインが fresh で「AIX なし」の時もバナーを出すか（fd0ef481 の方針）
② AIX ボタンの点滅（guideToCheckResult: status=availability_check や直前のスタッフ発言で決まる）もブレインの判断に揃えるか
③ property_check タスクの自動作成（4325 修正で初めて動く）をそのまま運用してよいか
