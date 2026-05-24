# LINE返信AI部署 倉庫（#L）

最終更新: 2026-05-24

---

## 部署概要

スモラのLINE営業AIシステム。お客様メッセージに対して文案を生成し、使うたびに自己学習して品質を高め続ける。

---

## 管轄ファイル

| ファイル | 役割 |
|---------|------|
| `app/api/generate-reply/route.ts` | 文案生成・intent分類・state遷移 |
| `app/api/save-reply-example/route.ts` | 例の保存 + Claude深層分析 |

---

## 管轄DBテーブル

| テーブル | 役割 |
|---------|------|
| `ai_reply_examples` | 実際に送った返信の蓄積（☆・AI使用フラグ付き） |
| `ai_reply_knowledge` | Claudeが抽出したパターン・口調・フレーズ・原則 |

---

## 学習ループ

```
送信 → save-reply-example → ai_reply_examples
  ↓（☆ or 手動インポート）
Claude深層分析 → ai_reply_knowledge（pattern/style/phrase/principle）
  ↓（次回の generate-reply 呼び出し時）
knowledge + examples をプロンプトに注入 → 品質向上
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

## SYSTEM_PROMPT 管理

### 現行バージョン（2026-05-24）

スモラLINE営業AI。丁寧・親しみやすい・営業感強くない。詳細な説明ルール（具体的な築年・帖数・徒歩分）、内覧誘導・申込誘導の文例含む。

→ 詳細: `app/api/generate-reply/route.ts` の `SYSTEM_PROMPT` 定数

### 変更履歴
| 日付 | 変更内容 | 担当 |
|------|---------|------|
| 2026-05-24 | 初版作成（OpenAI→Anthropic切替と同時） | #L-PR |

---

## ナレッジ現状（#L-KN 管理）

| 日付 | ai_reply_examples | ai_reply_knowledge | 備考 |
|------|------------------|-------------------|------|
| 2026-05-24 | 0件 | 0件 | テーブル作成直後・インポート待ち |

---

## KPI履歴（#L-QC 管理）

| 日付 | ai_use_rate | star_rate | edit_rate | 備考 |
|------|------------|-----------|-----------|------|
| 2026-05-24 | 未測定 | 未測定 | 未測定 | データ蓄積待ち |

---

## インポート履歴（#L-IMP 管理）

| 日付 | インポート件数 | state | 備考 |
|------|-------------|-------|------|
| （未インポート） | - | - | 竹内悠馬が貼り付け待ち |

---

## 保留・引き継ぎ事項

- [ ] 過去のLINEやりとりをインポートする（竹内悠馬が貼り付け予定）
- [ ] インポート後にKPI初回測定を実施（#L-QC）
- [ ] ai_use_rate が安定してきたらプロンプト改善サイクルを開始（#L-PR）
