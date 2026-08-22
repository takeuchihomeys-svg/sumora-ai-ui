## 🚨 絶対ルール（最優先・常時適用）

1. **screening-adminのコードは一切触れない**（DBのみ操作可・コードは禁止）
2. **Supabaseは必ず別プロジェクト**（sumora-ai-ui: `wfwsmwxakhyxobytszoq`）
3. **認証情報はハードコード禁止**（必ず環境変数）
4. **新カラム追加時は `migrate-schema/route.ts` も同時更新**（後回し厳禁）
5. **コミット前に `npx tsc --noEmit` 必須**（型エラーのある状態でコミット禁止）

---

## 📁 管轄ファイル早見表

| ツール | 主要ファイル | 倉庫 |
|--------|------------|------|
| Chrome拡張（物件検索） | `chrome-extension/popup.js`, `popup-maps.js`, `reins-bulk-dl.js`, `background.js` | `memory/dept_search_tool.md` |
| 物件出しツール | `app/api/property-customers/`, `app/api/property-conditions/` | `memory/dept_property_tool.md` |
| 見積書ツール | `app/api/fill-estimate/`, `app/estimate/page.tsx` | `memory/dept_estimate_tool.md` |
| LINE返信AI | `app/api/generate-reply/`, `app/api/save-reply-example/` | `memory/dept_line_reply.md` |

---

## 📋 作業開始前チェック

- Chrome拡張作業 → `memory/dept_search_tool.md` を必ず読む
- 見積書作業 → `memory/dept_estimate_tool.md` を必ず読む
- LINE返信AI作業 → `memory/dept_line_reply.md` を必ず読む
- 部署詳細・チーム構成が必要な場合 → `AGENTS.md` を読む（常時ロードしない）

---

## ⏰ セッション開始時：Cronを1つ設定する

**新しいセッションが始まったら必ず以下をCronCreateで設定する。**

### ① Git自動保存（3時間ごと）
```
CronCreate ツールを使って以下を設定：
- cron: "17 */3 * * *"
- recurring: true
- durable: true
- prompt: "sumora-ai-ui プロジェクトの自動保存を実行してください。手順：1. `cd \"c:\\Users\\竹内 悠馬\\sumora-ai-ui\" && git status --short` で変更があるか確認 2. 変更がある場合のみ `git add -A && git commit -m \"auto: 3時間自動保存\" && git push` 3. 変更がなければスキップ"
```

※ 差分自動学習（analyze-diffs）はVercel cronで毎日JST 3:23に本番実行済み。CronCreateは不要。

竹内悠馬が「保存して」「GitHubに上げて」と言った場合も即座に `git add -A && git commit && git push` を実行する。

---

## 🎨 LP・デザイン作業開始時：design_knowledge を必ず引く

LP新規作成・リデザイン・Fable5実行の前に**必ず**以下を実行する：

```sql
SELECT title, principle, pattern FROM design_knowledge
WHERE impact = 'high'
  AND is_current = true
ORDER BY created_at DESC
LIMIT 20;
```

取得した知見を「**守るべき原則・禁止パターン**」としてFable5プロンプトの冒頭に含める。
knowledge がない場合はスキップしてよい。

### 知識の更新ルール
- **新しいパターンで古いものが上書きされたら** → 古い行を `UPDATE design_knowledge SET is_current = false WHERE id = '...'` で非現行に設定する
- **セッション終了時の INSERT** → `is_current` を省略（DEFAULT true が自動適用される）
- `is_current = false` の行は参照しない（履歴として残すだけ）

---

## 🧠 設計思考・アーキテクチャ知識の蓄積（セッション終了時）

アーキテクチャの改善・設計判断・新しいパターンが生まれたセッション終了時に**必ず**以下をINSERTする：

```sql
INSERT INTO system_design_thinking (title, category, insight, rationale, context, applied_to, tags)
VALUES (
  '短いタイトル',
  'architecture',  -- architecture | prompt_engineering | data_model | ux | performance | ai_design
  '知見の内容（何をどうしたか）',
  'なぜそうするか（根拠）',
  'どういう状況で生まれたか（日付含む）',
  '適用したファイル・機能',
  ARRAY['タグ1', 'タグ2']
);
```

### 更新ルール
- 古い知見が上書きされたら → `UPDATE system_design_thinking SET is_current = false WHERE id = '...'`
- `is_current = false` の行は参照しない（履歴として残すだけ）

### 参照方法（次セッション冒頭・設計作業前）
```sql
SELECT title, insight, rationale FROM system_design_thinking
WHERE is_current = true
ORDER BY created_at DESC LIMIT 10;
```

---

## ノウハウ参照

- `memory/dept_knowhow.md` — 実装パターン・技術ノウハウ（sumora-screening-adminで学んだこと）
- `memory/brain_kt.md` — 設計判断軸・最初にやること・避けるべきバグパターン

---

## 🔧 セッション開始時：部署記録の読み込み

**Chrome拡張ツール（物件検索）に関する作業をする場合は必ず読む：**

```
memory/dept_search_tool.md
```

このツールはプロジェクト最重要ツールの一つ。前回セッションからの変更・保留事項・引き継ぎを把握してから作業開始すること。

**Chrome拡張への変更後は必ず `dept_search_tool.md` を即座に更新する（後回し厳禁）。**
