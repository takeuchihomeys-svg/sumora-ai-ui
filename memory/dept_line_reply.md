# LINE返信AI部署 倉庫（#L）

最終更新: 2026-07-11

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
