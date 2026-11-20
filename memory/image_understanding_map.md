# 画像の把握の表（土台 → 細分化 → 状況ごとの重要）

最終更新: 2026-11-21 深夜 作業員G（竹内さん 11/21「画像の把握の部分を、打ち合わせした時のように細かく行う」）
出所の数: `scripts/audit-image-understanding.ts`（読むだけ・LLM なし・9〜22時は回さない）・`scripts/audit-own-property-image.ts`（on/off）。
本番のスイッチ: brain_switch_versions の最新の行（c91e3d8）に画像のスイッチは無い＝**コードの既定**で動いている（下の「既定」はコードの既定・`app/lib/linkage-switch-defaults.ts`）。
地図: `app/lib/linkage-map.ts` の行 `in.image_label`・`in.own_property`・`in.portal_title`・`in.image_link`・`in.customer_sent_pref`・`sent.images`・`sent.image_role`・`sent.image_facts`・`sent.image_rooms`・`bridge.image_pref`・`tool_react.customer_sent`。
決まり（KB）: 546dd10d（画像の文はお客様の発言ではない・意図は言葉だけ）・33a30792（DeepSeek に出す所は受け取った時の仕分けの線）・277094fd（取り出しは広く・言い切りは狭く）・1d2400c6（H-14 画像の3つの型）・acda2b5c（読めなくても送ってきた物件への返信）・359c8c60（引用した画像の種類）・e54c0e34（持ち込みは🌟の好みの参考）・2dab3589（物件の台帳は2本柱）。

外れの原因の3つ（CLAUDE.md の絶対的な考え方）: **[届]** 材料が AI に届いていない ／ **[読]** 場面や決まりの読み違い ／ **[AIX]** AIX の番を返信にしている（またはその逆）。

---

## 0. 流れ（どこで読んで、どこへ届くか）

```
お客様の画像 ─ line-webhook ─ Vision（1回・受け取り時）─ image-label の見出し ─ messages.text「[画像] 【見出し】＋書き起こし」・image_type
   │                                   └ 書類（本人確認・収入・契約・支払い）は種類だけ（中身は保存しない）
   ├ own-property-server（取り出し＋照合）──────────→ ブレイン（brain-core）・返信の生成（generate-reply）
   ├ customer-image-link（種類・物件・照合・関連・一言・行き先の決まり）→ ブレインの材料の1ブロック（CUSTOMER_IMAGE_LINK）
   ├ customer-sent-property（値＋前後20分の一言）──→ 🌟の順位付け（pickup-rank・DeepSeek）
   ├ image-taste-wants（好みの手本の特徴）────────→ AIX ツールの要望の欄（CUSTOMER_IMAGE_TASTE_WANTS・既定 off）
   └ reply-context（画像の通は言葉から外す）───────→ 意図・質問・条件変更の判定は言葉だけ（546dd10d）

こちらが送る画像 ─ send-line-message／AIX ─ sent-image-record（DeepSeek 1回）─ sent_image_properties（物件名・号室・facts）
   ├ estimate-image-role ─ image_details.kind=estimate（AIX_ESTIMATE_IMAGE_ROLE）
   ├ image-detail-store ─ image_details.lines（引用された時の読み）
   ├ sent-props-text ─ ブレインの「送付済みの物件」（facts は SENT_IMAGE_FACTS_TO_BRAIN・既定 off・作業員L）
   └ sent-image-reread（読み取り失敗の読み直し待ち・SENT_IMAGE_REREAD）
```

---

## A. お客様が送る画像（60日 394枚・180日 1,267枚）

60日の枚数: ポータルの画面 92・書類（本人確認・収入）91・見出しの無い昔の行 64（9月後半の見出し前＋書類）・種類不明 31・物件の写真 28・物件の資料 21・SNS 広告 18・個人情報の載った画像 13・見積書 10・手続きの画面 7・契約書 6・支払いの控え 5・やり取りのスクショ 3・人物 2・ペットの書類 1・**読み取り前のまま 2**（9月後半から読み取り漏れはほぼ0。180日では 424 枚＝8月以前の物）

| 行 | 種類 | 何を読むべきか | 今読めているか（60日） | 届く所（今届いているか） | 竹内さんの決まり | 外れの例と原因 |
|---|---|---|---|---|---|---|
| C1 | ポータルの画面（SUUMO・HOME'S）【物件の画面（ポータル）】 | 物件名・号室・家賃・管理費・敷礼・間取り・面積・駅徒歩・築年・（好みの特徴） | 92枚: 名前 **14%**（OWN_PROPERTY_PORTAL_TITLE=on で 35%）・号室 2%・家賃 89%・管理費 86%・間取り 74%・面積 69%・駅 23%・徒歩 23%・築年 47% | ブレイン（結び付け・on）・照合（on）・🌟の好み（on）・物件ごとの記録（**無い**＝下の ③） | 持ち込み＝募集状況の確認と最大限割引の御見積書の約束→後で AIX【物件確認した】（acda2b5c）。こちらの送った物件の他社の画面は決め打ちせず後の一言で（1d2400c6 ①） | [届] 名前が取れず結び付けが「名前なし」→ 確かさ low→ スタッフに回す。直し中（C1-a）。[読] ブレインが AIX【見積書送る】を選んだ番 2/35（店は物件確認の約束）＝C1-b |
| C2 | 物件の資料（こちらの資料の送り返し・他社の資料）【物件の資料】 | 物件名・号室（言い切りに要る）・現況・こちらが送った物か | 21枚: 名前 76%・号室 67%・家賃 91%・間取り 95%・面積 95%・駅 81%・築年 14% | ブレイン・照合（same_room で「募集状況確認の宣言をしない」） | 送り返し＝確認済み・費用は AIX【見積書送る】を直接・内覧は AIX【内覧調整】（932e73a9・359c8c60） | 一致 7/11。築年 14% は資料の形（築年月）が取れていない＝C2-a |
| C3 | SNS・広告の画面【物件の画面（SNS・広告）】 | 物件名（大抵無い）・家賃・間取り・駅（好みの手本） | 18枚: 名前 6%・家賃 56%・間取り 100%・駅 39% | ブレイン（結び付け）・🌟の好み | 広告に書いてある条件は「聞かれた事」ではない（546dd10d・Hina 事例）。持ち込みとして募集状況の確認＋見積の約束 | 一致 7/9（60日）。最初の数えでは 3/9 に見えたが、ブレインの「後で送る AIX」を今の番と数えた誤り（C の注）。残りの AIX 3 は退役した決まり 5aa28356 の頃 |
| C4 | 物件の写真（室内・外観）【物件の写真】 | どの物件か（名前は殆ど無い）・好みの特徴（白基調・広いリビング） | 28枚: 名前 11%・家賃 21%・間取り 21% | ブレイン（結び付け・物件が引けない＝スタッフに回す） | 好みの手本（「こんな感じが良い」）＝好みを条件に足して約束の返信→物件の AIX（1d2400c6 ②） | 一致 2/4。数が少ない |
| C5 | 見積書（弊社・他社）【見積書・初期費用の明細】 | 会社（弊社か他社か）・物件名・号室・内訳（敷礼・仲介・保証・鍵・保険・日割・前家賃）・総額。宛名は伏せる | 10枚: 内訳が取れた 6（弊社 4・他社 2）・総額 5 | ブレイン（結び付け: 他社＝相見積もり／弊社＝送り返し） | 他社＝比べて最大限割引した御見積書の約束と申込への背中押し（87ff68e1・1c4dddf7）。弊社の送り返し＝質問に答える／無ければ内覧・退去予定なら申込へ（1d2400c6 ③） | 11/21 に10枚を1通ずつ読んだ（C5-a 済み）: ブレインと店の中身は揃っていた（費用＝最大限割引の約束の返信・代表に更なる割引の確認）。前の 2/7 は AIX の画像送りを型で数えた差。判定（C0-a）でも 5/6。**穴: 【見積書】の見出しなのに内訳が取れない 3/10**（書き起こしの形が見出し＋値の表でない）＝C5-b |
| C6 | 好みの手本（C3・C4 の中で「こういう・こんな」の一言つき） | 特徴（白基調・広いリビング・築浅・ペット・駅近・バストイレ別・独立洗面・2口コンロ・対面キッチン・オートロック・宅配・浴乾・WIC・角部屋・南向き） | 決定論の15の特徴（customer-image-link の TASTE_RULES）。関連が「似た別の物件」の時だけ | ブレインの材料（on）。要望の欄へは **CUSTOMER_IMAGE_TASTE_WANTS=off**（blocked） | 1d2400c6 ②「特徴を AIX ツールの条件・要望に反映」 | 45日の実送信で0〜少数（1d2400c6 の根拠）＝C6-a で範囲を決める |
| C7 | 書類（本人確認・収入・申込書・契約書・保証会社） | **種類だけ**（中身は読まない・保存しない） | 書類 91＋契約書 6・取り違え 0（IMAGE_LABEL_1115・400日の当て直しで誤り0） | 申込の手続き（received-document）・ブレイン（「書類が届いた」） | 申込以降は対象外（project_post_apply_out_of_scope） | 店は返信「申込」19/36、ブレインは AIX【申込へ】3/10。申込以降の番が多い＝対象外として数えから外す（C7-a） |
| C8 | 物件以外（支払いの控え・手続きの画面・地図・経路・やり取り・ペット・人物） | 種類（物件の確認・見積の理由にしない） | 見出しあり。支払い・個人情報の載った物は書き起こしを残さない | ブレイン（「物件以外」） | — | 少数・一致 |
| C9 | 種類不明【種類不明】 | 推測で物件と言わない | 31枚 | ブレイン（「何の画像か分からない」） | — | 一致 7/9 |
| C10 | 引用された画像（お客様がこちらの画像を引用して一言） | 引用先がこちらの物件資料か見積書か（image_details）・物件名 | image_details（送った画像の 72%）から読む | ブレイン（引用の読み） | 物件資料への「初期費用お願いします」＝物件名を挙げて確認の旨＋AIX で割引した御見積書（359c8c60） | 送った画像の役目が無い 15%（14日）＝O5 |

## B. こちらが送る画像（60日 2,462枚・14日 455枚）

| 行 | 種類 | 何を読むべきか | 今読めているか | 届く所 | 決まり | 外れ・穴 |
|---|---|---|---|---|---|---|
| O1 | 物件資料（AIX 物件送付・オススメ・物件確認した） | 物件名・号室・家賃・管理費・敷礼・間取り・面積・駅徒歩・築年・現況（募集中／退去予定／審査中） | 60日: 物件名 73%・facts 1,669（管理費 99%・家賃 96%・号室 92%・敷金 92%・階 90%・駅徒歩 88%・面積 87%・間取り 85%・現況 83%・築年 82%・礼金 74%） | sent_image_properties → ブレインの送付済み（名前・号室は on・**facts は SENT_IMAGE_FACTS_TO_BRAIN=off**） | 審査中の物件は送らない・退去予定は内覧できない | [届] 中身を読んでいるのにブレインに届いていない＝作業員L の試験待ち（L1120-sipfacts-a/b） |
| O2 | 部屋ごとの帖数（O1 の中） | LDK・洋室の帖数 | **IMAGE_READ_ROOMS=off**（読んでいない） | facts.rooms → O1 | — | 作業員L |
| O3 | 見積書（AIX 見積書送る） | 物件名・号室・総額・内訳 | 14日 12/12 に記録あり。役目 estimate（AIX_ESTIMATE_IMAGE_ROLE=on） | image_details.kind・estimate_records | — | 送り返し（C5）との結び付けは名前だけ（estimate_records の号室とは結んでいない） |
| O4 | 室内写真（AIX 物件確認した のピッカー） | どの物件の写真か | 14日: 物件確認した 118枚のうち役目も物件も無い 26 | （無い） | 室内写真の依頼は返信で答えず AIX【物件確認した】→ピッカー | [届] 写真がどの物件かの記録が無い＝O4-a |
| O5 | 手で送った画像 | 種類・物件 | 14日 27枚のうち 19枚が記録なし | （無い） | — | [届] 送った物の記録が抜ける＝引用された時に読めない |
| O6 | 待ち合わせ場所の地図（AIX 待ち合わせ場所） | 住所（番地まで） | 14日 4/4 記録あり | — | 住所は番地まで | — |

---

## C. 状況ごとの重要（画像の番・店が12時間以内に返した番）

数え方: お客様の画像の連投の束 → 店の最初の通（AIX は前後2分の aix_usage_logs の種類・返信は文の型）／その間の最後のブレインの判断。
⚠ brain_decision_logs.suggested_action には「後で送る AIX」も入る（2段: 今は約束の返信 → 確かめた後で AIX）。digest.dir が「約束する返信」・初回の守り（ds=guard:first_contact）の番は「返信（後で AIX）」と数える（最初の数えはこれを AIX と数えて、SNS・広告の一致を 33% と低く出していた）。
「一致」は AIX の種類が同じか、両方が返信（**返信の型＝約束か答えかまでは比べていない**）。竹内さん＝staff_writer=takeuchi。

60日（142番）:

| 種類 | 番（竹内さん） | ブレインの判断あり | 一致 | 店の返し（多い順） | ブレイン（多い順） | 見立て |
|---|---|---|---|---|---|---|
| ポータルの画面 | 38（14） | 35 | 20（57%） | 返信:物件確認の約束 22・AIX 物件確認した 6・返信:その他 6 | 返信 24・AIX 物件確認した 5・AIX 見積書送る 2・返信（後で見積書送る）2 | 外れの多くは 11/05 前（下の15日では 9/11） |
| 書類 | 36（10） | 10 | 3（30%） | 返信:申込 19・その他 9 | AIX 申込へ 3 | 申込以降が多い＝対象外（C7-a） |
| 見出しの無い昔の行 | 17（4） | 16 | 2（13%） | 返信:物件確認の約束 6・見積 4 | AIX 確認しますの了承 7・物件確認した 4 | 9月の行＝昔の版のブレイン |
| 物件の資料 | 13（5） | 11 | 7（64%） | 返信:物件確認の約束 5・AIX 見積書送る 2 | 返信 8 | — |
| 種類不明 | 11（4） | 9 | 7（78%） | — | — | — |
| SNS・広告 | 10（7） | 9 | 7（78%） | 返信:物件確認の約束 8（竹内さん 5/7） | 返信（後で物件確認した）3・AIX 物件確認した 3・返信 2 | 残りの AIX 3 は 10月（退役した決まり 5aa28356「すぐ AIX」の頃） |
| 見積書 | 7（2） | 7 | 2（29%） | 物件確認した 2・物件確認の約束 2・その他 2 | 返信 3・物件確認した 2・見積書送る 2 | 数が少ない＝1通ずつ読む（C5-a） |
| 物件の写真 | 5（2） | 4 | 2 | 返信:物件確認の約束 3 | 返信 2・物件確認した 2 | 同上（10月） |

15日（11/06〜・持ち込みは「確認の約束 → AIX」cf241dbd の後・31番）: ポータルの画面 9/11・種類不明 3/3・物件の資料 1/2・物件の写真 1/1・見積書 1/1 が一致（物件の種類で 15/18）。
外れの3つ（ポータル 2・資料 1）は、ブレインが返信・店が AIX【物件確認した】／【電話をかける】＝店が既に確かめていた番（[届] 確かめた結果がブレインに届いていない か、スタッフの先回り）。

### C0-a 返信の型まで（line_watch_turns の判定・60日・下書きと店の文を番ごとに比べた verdict）
画像の入った番の判定（same＋same_meaning ／ 判定できた番。na は除く）: ポータル 25/35（71%）・見積書 5/6・SNS・広告 7/12（58%）・物件の資料 6/11（55%）・種類不明 3/6・物件の写真 2/4。全部の番（30日）は 372/595（63%）＝画像の番は平均並み、**物件の資料が一番低い**。
物件の種類の外れ 26番の理由（verdict_detail.reason）:
- text_but_aix 9（下書きは返信・店は AIX）: 10/02〜10/07 の 5番は店が確かめてすぐ AIX【物件確認した／見積書送る】（退役した 5aa28356 の頃の型）。11/06 から 2番（AIX【電話をかける】1・翌朝に AIX【物件確認した】1＝店が約束を飛ばして結果を送った）→ [AIX] ではなく店の先回り。直しは不要（今の決まり cf241dbd は約束→AIX）
- aix_other 5（AIX の種類が違う）: ブレインが AIX【物件確認した】・店は 見積書送る 2／内覧の誘い 1／物件送付 1／内覧の挨拶 1（10/28〜10/30）＝[読] 送り返しの資料・こちらの物件で、確認済みなのに確認を選んだ型（OWN_PROPERTY_RETURNED_ESTIMATE・既定 off の対象）→ C2-b
- acts_extra 6・fact_one_side 5（下書きが店より余計な事をした・片方にだけある事実）: 文の細部＝[読]。1通ずつ読む → C0-c
- acts_conflict 1・fact_conflict 1

**見立て**: 画像の番の「返信か AIX か」は、11/05 の決まり（cf241dbd）の後はほぼ揃っている。60日の外れの大半は退役した決まりの頃の物と数え方の誤り。
**次に細かく見る所（直す順）**: ① 返信の型（約束か・答えか・見積の案内か）まで比べる＝下書き（ブレインの出した文）と店の文の型を番ごとに並べる（C0-a）→ ② 見積書の送り返し 7番を1通ずつ（C5-a）→ ③ 15日の外れ 3番（店が先に確かめていた番）で、確かめた結果がブレインに届いていたか（C0-b）。

---

## D. 細分化の作業（work_items に結ぶ行）

| id | 行 | 中身 | 状態 |
|---|---|---|---|
| C1-a | C1 | OWN_PROPERTY_PORTAL_TITLE: そのまま on は増えた48通のうち23通が物件名でない（伏せた見出し「6階」・「特典あり」・駅の文字・名前の最後の語だけ・括弧ごと）→ 取り出しを直した。直した後 180日: 取り出し 101→141通（25.9→36.0%）・増えた39通を目で読んで誤り0・照合（same_room）23→23。ポータルの画面から取った物は号室まで同じでも same_building（H-14 ①・実物 3890f691 で店は募集状況を確認していた） | コミット待ち（tsc-remote）→ ブレインの組の試験（q096,q174,q179,q325,q326,q330,q359,q419）→ 悪化0なら既定 on |
| C1-b | C1 | ポータルの画面でブレインが AIX【見積書送る】を選んだ 2番＋返信（後で見積書送る）2番を1通ずつ読む | 未着手 |
| C2-a | C2 | 物件の資料の築年 14%（「築年月 2015年3月」の形）を factsFromPropertyText に足す | 未着手 |
| C3-a | C3・C4 | （閉じた）SNS・広告・写真の番の「確認前に AIX【物件確認した】」は、数え方の誤り（後で送る AIX）と退役した決まり 5aa28356 の頃の物だった。11/06 からの15日では外れ0 | 済み（直しは不要・数え方を audit に入れた） |
| C0-a | 全部 | 返信の型まで、ブレインの下書きと店の文を番ごとに比べる（line_watch_turns の判定） | 済み（C の C0-a 節）。物件の資料 55% が一番低い |
| C0-c | C1〜C4 | acts_extra 6・fact_one_side 5 の番を1通ずつ読む（下書きが余計に書いた事・片方だけの事実が画像の読みから来たか） | 未着手 |
| C2-b | C2 | こちらの資料の送り返しでブレインが AIX【物件確認した】を選ぶ（店は見積書送る・内覧）＝ OWN_PROPERTY_RETURNED_ESTIMATE（既定 off）の試験の候補 | 未着手（試験の候補を統括役へ） |
| C0-b | C1・C2 | 15日の外れ 3番: 店が先に確かめていた番で、確かめた結果（物件確認・電話）がブレインに届いていたか | 未着手 |
| C5-a | C5 | 見積書の番を1通ずつ読む（弊社の送り返し／他社の相見積もり） | 済み（中身は揃っていた） |
| C5-b | C5 | 【見積書】なのに内訳が取れない 3/10 の書き起こしの形を読み、estimateFactsFromTranscript を広げる（宛名を伏せる線は変えない） | 未着手 |
| C6-a | C6 | CUSTOMER_IMAGE_TASTE_WANTS（blocked）の範囲: 下の「C6 の決め」 | 案 |
| C7-a | C7 | 書類の番を申込以降で外して数え直す | 未着手 |
| O1 | O1・O2 | SENT_IMAGE_FACTS_TO_BRAIN・IMAGE_READ_ROOMS（作業員L） | L の試験の結果を待つ |
| O4-a | O4・O5 | 室内写真・手で送った画像の物件の記録（送った時に AIX の物件名から結ぶ） | 案 |
| R2 | ②③ | お客様の画像の記録の表と物件ごとの記録へのつなぎ（下の E） | 設計の案（DDL は統括役へ） |
| N1 | C1・C2 | 物件名の読み違い（似た名前の別の建物）: 名前の近さ 0.7 の線（下の F） | 確かめ中 |

### C6 の決め（CUSTOMER_IMAGE_TASTE_WANTS をどこまで要るか）
- 竹内さんの決まり（1d2400c6 ②）は「好みを条件に足して約束の返信 → 物件の AIX、特徴を AIX ツールの要望に反映」。返信の側（ブレインの材料・行き先）は既に on（CUSTOMER_IMAGE_ROUTE_1115）。
- 要望の欄に書くのは「好みの手本」と分かる時だけ（「こういう・こんな・みたいな・イメージ」＋空き・内覧を聞いていない）＝今の網のまま。**持ち込みの物件（空きを聞く）は書かない**（その物件の値を条件にすると、条件が1件の物件に寄る）。
- 書く欄: 設備（ペット・バストイレ別・独立洗面・2口・対面・オートロック・宅配・浴乾・WIC）は preferences、内装・広さ・向き・築浅・駅近は other_requests に1つずつ（feedback_wants_itemized）。「できれば」の強さ（必須にしない）。
- 数が0〜少数なので、on にする前に YUMA で1番だけ確かめる（試験の組に入れる程ではない）。**推奨: 範囲は今の網のまま・既定 on は竹内さんの確認の後**（条件の欄を自動で書くので、竹内さんにだけ決められる）。

---

## E. 画像の記録の②③（設計の案・DDL はまだ当てていない）

② お客様の画像の記録の表 `customer_image_records`（1枚1行・受け取った時に決定論で書く・LLM なし）
- 鍵: message_id（messages.id）・conversation_id・created_at
- 種類: kind（image-label の ImageKind）・link_kind（customer-image-link の LinkKind）・part（外観・室内・間取り図・募集の画面・費用）
- 物件: property_name・room_no・name_via（label／portal_title／first_line）・rent_yen・admin_yen・madori・area_sqm・station・walk_min・age_years・certainty
- 照合: ours_kind（same_room／same_building／none）・ours_property_name・ours_room_no・relation（customer-image-link の Relation）
- 見積: estimate jsonb（会社＝弊社／他社・内訳の数字だけ・**宛名・人の名前は入れない**）
- 一言: asks text[]（空き・費用・内覧・好み・比べ）※お客様の文そのものは入れない
- unit_key（property-key.propertyKey＝物件ごとの記録の鍵）・read_version
- 書類（本人確認・収入・契約）は kind だけ・物件の欄は空。書き起こしは入れない（messages にある・33a30792）
- 書く所: line-webhook の画像の後処理（見出しを付けた後）。読む所: brain-core（customer-image-link を毎回作り直さず読む）・property-thread（③）・監査
- migrate-schema/route.ts も同時に直す（CLAUDE.md 絶対ルール4）

DDL の案（**統括役の確認待ち・まだ当てていない**。サーバーだけが読み書きする表＝RLS は入れたまま・DISABLE を書かない＝migrate-schema の 10/21 の決まり）:

```sql
-- customer_image_records: お客様の画像1枚 → 種類・物件・照合・関連（2026-11-21 作業員G・画像の把握の表 ②）
--   受け取った時に決定論で書く（LLM なし）。書き起こし・お客様の文・宛名は入れない（33a30792）。書類は kind だけ
CREATE TABLE IF NOT EXISTS customer_image_records (
  message_id TEXT PRIMARY KEY,               -- messages.id
  conversation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,           -- 画像を受け取った時刻（messages.created_at）
  kind TEXT NOT NULL,                        -- image-label の ImageKind（document は書類の種類だけ）
  link_kind TEXT,                            -- customer-image-link の LinkKind
  part TEXT,                                 -- exterior | interior | floor_plan | listing | cost
  property_name TEXT, room_no TEXT, name_via TEXT,  -- label | portal_title | first_line
  rent_yen INTEGER, admin_yen INTEGER, madori TEXT, area_sqm NUMERIC, station TEXT, walk_min INTEGER, age_years INTEGER,
  certainty TEXT,                            -- high | mid | low
  ours_kind TEXT, ours_property_name TEXT, ours_room_no TEXT,  -- same_room | same_building | none
  relation TEXT,                             -- reaction_to_ours | ours_on_other_site | similar_other | new_brought | unknown
  estimate JSONB,                            -- {company:'own'|'other', items:{deposit,...,total}}（数字だけ）
  asks TEXT[],                               -- vacancy | cost | viewing | like | compare | question
  unit_key TEXT,                             -- property-key.propertyKey（物件ごとの記録の鍵）
  read_version TEXT,
  recorded_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_image_records_conv ON customer_image_records(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_image_records_unit ON customer_image_records(unit_key) WHERE unit_key IS NOT NULL;
```
- 書き手: line-webhook の画像の後処理（見出しの後）で `linkCustomerImage` の結果を1行 upsert（スイッチ CUSTOMER_IMAGE_RECORD・既定 off・記録だけ＝試験は要らない）。昔の分は夜に backfill（読むだけの決定論）。
- 先に統括役へ見せる → 承認後に migrate-schema/route.ts と同じコミットで足す（絶対ルール4）。

③ 物件ごとの記録につなぐ: property-thread-server は messages・aix_usage_logs・estimate_records・recommendation_snapshots から作り直している。
`customer_image_records` を unit_key（無ければ建物の鍵）で読み、2本柱（2dab3589）の「お客様が送ってきた」の出来事として足す（いつ・どの種類の画像で・何を聞いて・こちらが送った物か）。表は増やさない。

---

## F. 物件名の読み違い（似た名前の別の建物）の線

- 照合は matchKnownProperty（名前の近さ 0.7 以上）＋シリーズ番号（Ⅱ・VIII・数字）が同じ時だけ。号室が無い・ポータルの画面は same_building まで（言い切らない）。
- 11/21 の 180日の on/off で、名前の近さで当たった same_room 23通は全部、読み取りの誤字（「南巽／南泉」「木間／木町」「プリシェ／プリシエ」「ミラージュパレス木町」）で同じ建物＝誤りの当たりは0。
- 似た名前の別の建物（例「サウスプレイスVIII ハイド」と「VI レジダー」）はシリーズ番号で止まる（seriesTokens）。
- 残る穴: 同じ頭の語で番号の無い別の建物（「〇〇本町」と「〇〇本町グラン」）。0.7 の線は名前の長さで効き方が変わる＝次の夜に照合できた行と none の行の近さの分布を出して、0.7〜0.8 の行を目で読む（N1）。

---

## G. 試験と既定 on の候補（統括役が組に入れる）
- OWN_PROPERTY_PORTAL_TITLE=on（CUSTOMER_IMAGE_LINK は既定 on のまま）: q096,q174,q179,q325,q326,q330,q359,q419（取り出しが変わる8問）。ブレインの組。
