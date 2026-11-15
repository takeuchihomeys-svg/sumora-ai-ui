# 物件出しツール（AIX ツールの物件出し・ブレイン）部署の倉庫

## 2026-11-15 作業員K: 条件の読み取りと採点の当たりを数で測る・条件の書き手の取り合いを止める（既定 off）

竹内さん 11/15「AIX ツール（物件出し）との連携を細かく具体的に…お客さんの条件をちゃんと読み取る部分と正確なスコアリングの部分で、今の返信のブレインの質と比べて」。

### 測り方（読むだけ・費用0）
- 採点: `scripts/audit-prop-brain-score.ts --days=30 --fill`（正解＝スタッフの🌟。書き手は messages.staff_writer。ずれた項目は `app/lib/prop-brain-score-category.ts`）
- 条件の届き: `scripts/audit-condition-reach.ts --days=30`（既存）
- 条件の自動の書き込みの当たりと取り合い: `scripts/audit-condition-write-arbiter.ts --days=30`

### 30日の数（2026-11-15 時点）
- 採点（🌟の回 95・竹内さん 48・従業員 46）: 今の点の1位＝スタッフの🌟 40%（ランダム 23%）・竹内さん 40%（ラ 18%）・従業員 38%（ラ 29%）。
  本番の売上サポの🌟が束に残る回で、ツールの🌟＝スタッフの🌟 57%（竹内さん 59%・従業員 52%）。拡張の順位で🌟が上位3 91%・上位10 100%。売上サポで送った行のまとめの順位 10位以内 411/413。
  外れ 61回のずれた項目: AD 19・初期費用（敷礼0）13・合い方 8・同点 8・駅 6・家賃帯 5・築年 2（竹内さんの外れは初期費用 9・AD 8 が上）
- 条件の自動の書き込み 206行（format・p4・brain_bridge・condition_brain・path_c）・14日以内に画面で直された 0。
  取り合い・読み直し 8行（brain_bridge の同じ発言の読み直し 6・brain_bridge↔condition_brain の戻し 2）。根拠が物件の問い合わせ・書類だけの書き込み 9/118
- 物件顧客の行: 同じ LINE のお客様の重複 6人（sync-from-screening が 5ms 差で2行作る・片方は会話に結ばれない new_inquiry）・10倍の家賃 4行（全部その重複の行）・requirement_strength が入っている行 37/135

### 入れた物（2026-11-15 統括役の決め: CONDITION_WRITE_ARBITER は既定 shadow・SYNC_SCREENING_PC_GUARD は既定 on）
- `app/lib/condition-write-arbiter.ts`（純関数）＋`-server.ts`: `CONDITION_WRITE_ARBITER=shadow（既定）|on|off`。brain_bridge（generate-draft-bg-async）と condition_brain（property-brain-core）の書く前に通す。
  止めるのは ①同じ書き手が同じ発言からその欄を既に書いた（読み直し）②別の自動の書き手が6時間以内に書いた値を同じ発言から前の値に戻す（足した語が残りに含まれる片付けは止めない）③画面の直しより古い発言からの上書き。
  30日に当てると 8行止まり・人の直しと決まった戻しは 0行。8行は目で読んで全部止めるのが正しい側（ただし件数が少ない＝まず shadow）
- `app/lib/rent-units.ts`＋sync-from-screening: `SYNC_SCREENING_PC_GUARD`（既定 on・=off で戻す）で家賃の単位の直しと、同じ LINE のお客様の行が既にあれば作らずに結ぶ
- テスト: `app/lib/__tests__/condition-write-arbiter.test.ts`（実物の履歴の値で 23件）
- 画面の案: aix_feature_suggestions f1045de3（「条件の更新の案」の欄）

## 2026-11-15 続き（統括役の決めを入れる・次の3つ）
- 既定の切り替え: `CONDITION_WRITE_ARBITER` 既定 shadow（ログ condition-arbiter:shadow を1週間見て誤り0なら on）・`SYNC_SCREENING_PC_GUARD` 既定 on
- ① 書式の通の取りこぼし（家賃6）を確かめた: 6通とも行を作った時に値が入っていた（作る時は履歴を書かないので監査が「届いていない」と数えていた＝数え方の誤り・本当の取りこぼし 0）。
  代わりに見つけた読み違い: 「ちなみに同じ条件で間取りが3DKのものはございますか」で間取り「2LDK以上」を「3DK」に置き換えた（足すのが正しい）。
  「同じ条件で〜」は120日で7通あり、足す／場所の差し替え／他の物件の質問が混ざる＝決定論の線は引かない（迷う物＝案に回す）
- ② 物件の問い合わせから書く線: `CONDITION_INQUIRY_SHAPES_1115=on`（既定 off）で condition-source-gate に2つの形（部屋の札「（3階/304/1LDK/30.58m²）」・
  「〇〇の初期費用を知りたい」「過去気になっていた物件」）。30日のお客様の発言 2,250通で種類が変わるのは4通（全部物件の質問）・
  audit-condition-source-gate の B（誤って止める）は 12→12 で増えない・D で止まるのは 88f68b の2行（その他に物件名・質問を書いた誤り）だけ。
  「根拠が物件の問い合わせだけ」の9行は、通の前後を読むと7行は正しい条件（根拠の id がその番の最後の通なだけ）で、本当の誤りは88f68bの2行
  ＋読み違い1（「出来れば35㎡超え…なければ小さくても」を floor_area_min=35 の必須にした＝できればの読み）
- ③ 送ってきた物件・刺さった物件の像: `app/lib/sent-like-fit.ts`（純関数）・`sent-like-server.ts`。`STAR_SENT_LIKE=on`（既定 off）で
  🌟の並べ方（StarSituation.like・合い方に上限10点）と judgeProperty（opts.sentLike → SENT_LIKE_HIGH +6／_LOW +3・加点だけ）に入る。
  当て直し `scripts/audit-star-sent-like.ts --fill`: 60日 211回（像のある回 82）で🌟の並べ方の1位 37→38%・後だけ当たり3／前だけ当たり1、竹内さんの番 43→44%（前だけ 0）・従業員は変わらない。30日は後だけ1／前だけ0。
  悪化が1回あるので既定 off のまま（竹内さんの番では悪化0）
