# LINE返信AI部署 セッションブリーフ（#L-WX 管理）

最終更新: 2026-06-09（セッション2）

---

## 現状サマリー（2026-08-14時点）

| 項目 | 件数 | 状態 |
|------|------|------|
| ai_reply_knowledge | **6,200件以上** | ✅ 稼働中 |
| うち applying_pattern（申込ケースフロー） | **24件** | ✅ 新設（2026-08-14） |
| うち embedding NULL（pgvector不可） | **976件** | 🔧 バックフィル実行中 |
| 成約/申込会話学習済み | **14/19件** | 🔧 残5件修正デプロイ済み |
| 週次analyze-applying cron | ✅ 毎週日曜JST21:30 | ✅ 設定済み |
| brain/list Section B（追客サイレント） | ✅ 実装済み | 新機能（2026-08-14） |
| ポジティブ強化D（AI未修正=正解） | ✅ analyze-diffs内 | 新機能（2026-08-14） |

---

## フェーズ別☆実例内訳

| フェーズ | ☆件数 | 評価 |
|---------|-------|------|
| proposing（物件提案） | 85件 | ✅ |
| hearing（条件ヒアリング） | 27件 + old 1件 | ⚠️ 少ない |
| property_recommendation（旧） | 24件 | ✅（proposingに統合） |
| first_reply（初回） | 20件 | ⚠️ 少ない |
| applying（申込・審査） | 10件 | 🚨 最弱・要強化 |
| availability_check / screening | 14件 | 🚨 少ない |

---

## 黄金ルール（2026-06-09更新）

1. **☆は「AIが間違えて直したとき」につける** → 差分学習の教師信号になる
2. **applyingフェーズのデータが最弱** → 申込・審査中のやりとりを意識して☆をつける
3. **AI文案を修正して送った場合は必ず☆をつける** → 差分ルール126件を増やし続ける
4. **AIそのまま使用率が0.3%** → 精度改善の余地あり・使ったら☆で記録する

---

## 現在のアーキテクチャ（2026-06-10時点）

```
生成時に注入するもの（generate-reply/route.ts）:
  1. 🔴 AIが過去に間違えたパターン（差分学習ルール・最新15件）
  2. 🟠 スタッフが修正したポイント（修正対比・フェーズ別8件）
  3. ⚠️ 絶対ルール（importance9・10件）
  4. 営業パターン・原則（importance7-8・8件）
  5. フレーズ集（6件）
  6. ⭐実例（pgvector類似検索 最大20件 or フォールバック☆30件）
  7. customerSummary（AI要約：条件・人物像 + 今の状況・次のアクション）
     ※ ai_summaryがnullの場合はHaikuで条件から即席合成

enhance-reply/route.ts（AI文案生成ボタン）も同様にpgvector対応済み
```

---

## 🔜 次に実装したい改善（竹内AIより）

- **AI要約（ai_summary）に今のステータスも含めて文案生成の精度を上げる**
  - ai_summaryは「①条件・人物像」「②今の状況・次のアクション」の2軸で生成済み
  - generate-reply の `buildGenerationMessages` で `summaryNote` として注入済み
  - 改善案: ai_summaryの「今の状況」セクションと `conversationState` を明示的に紐付けて
    プロンプトで「このフェーズではこの状況のお客さんに対してこのアクションが最適」という
    文脈をより強く与えると文案の質がさらに上がる可能性あり

---

## 次セッションで確認すること TOP5

1. **成約パターン24件がRAGに届いているか** → generate-reply ログで fetchApplyingPatterns() 動作確認
2. **embedding NULL 976件のバックフィル完了後に pgvector 精度が上がったか**
3. **importance filter（97%がimportance≥7=フィルター死）の修正** → knowledge_apply_logから重要度再計算
4. **analyze-applying 残5件の処理完了確認** → conversations.learned_at が19/19になるか
5. **brain/list Section B（追客コホート）がスタッフに使われているか** → priority_score上位確認

---

## 部署メンバー早見表

| メンバー | 役割 |
|---------|------|
| #L-AI | ビジョン・☆の基準定義 |
| #L-SZ | API実装・運用 |
| #L-SM | 全体統括 |
| #L-KN | 件数確認・バランスチェック |
| #L-QC | KPI測定（ai_use_rate・star_rate・edit_rate） |
| #L-PR | プロンプト改善サイクル |
| #L-WX | このブリーフを毎週自動更新（Cron設定済み） |


---

## reply_modeゲート実装済み（2026-08-14）
- brain判定 `suggested_aix_meta.reply_mode="aix"` の会話は自動ドラフト生成ブロック → `ai_draft="[AIX誘導中]"` + スタッフグループ通知
- ゲートは generate-reply 内2チェックポイント・オプトインフラグ `enforceReplyModeGate`（自動経路3つのみ送信、UI手動生成は素通し）
- 詳細は dept_line_reply.md「reply_modeゲート実装（2026-08-14）」参照
