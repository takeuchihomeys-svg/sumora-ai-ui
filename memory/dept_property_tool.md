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

### 入れた物（全部既定 off）
- `app/lib/condition-write-arbiter.ts`（純関数）＋`-server.ts`: `CONDITION_WRITE_ARBITER=off|shadow|on`。brain_bridge（generate-draft-bg-async）と condition_brain（property-brain-core）の書く前に通す。
  止めるのは ①同じ書き手が同じ発言からその欄を既に書いた（読み直し）②別の自動の書き手が6時間以内に書いた値を同じ発言から前の値に戻す（足した語が残りに含まれる片付けは止めない）③画面の直しより古い発言からの上書き。
  30日に当てると 8行止まり・人の直しと決まった戻しは 0行。8行は目で読んで全部止めるのが正しい側（ただし件数が少ない＝まず shadow）
- `app/lib/rent-units.ts`＋sync-from-screening: `SYNC_SCREENING_PC_GUARD=on` で家賃の単位の直しと、同じ LINE のお客様の行が既にあれば作らずに結ぶ
- テスト: `app/lib/__tests__/condition-write-arbiter.test.ts`（実物の履歴の値で 23件）
- 画面の案: aix_feature_suggestions f1045de3（「条件の更新の案」の欄）
