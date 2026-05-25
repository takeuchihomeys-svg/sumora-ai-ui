# LINE返信AI部署 倉庫（#L）

最終更新: 2026-05-25

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

## 保留・引き継ぎ事項

- [ ] **ANTHROPIC_API_KEY を Cloudflare Worker に登録する**（AIXボタンが動かない）
  ```powershell
  cd "c:\Users\竹内 悠馬\sumora-ai-core\workers"
  npx wrangler secret put ANTHROPIC_API_KEY
  ```
- [ ] 過去のLINEやりとりをインポートする（竹内悠馬が貼り付け予定）
- [ ] インポート後にKPI初回測定を実施（#L-QC）
- [ ] ai_use_rate が安定したらプロンプト改善サイクルを開始（#L-PR）
