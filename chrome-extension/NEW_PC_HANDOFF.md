# 新しい PC の Cursor への指示（そのままコピペ用）

## ① 最初に開くフォルダ

```
C:\Users\<ユーザー名>\sumora-ai-ui
```

Cursor で「フォルダーを開く」から上のフォルダを開く。

---

## ② Cursor のチャットにそのまま貼る文（1回目・状況をつなぐ）

```
このリポジトリの続きをやります。まず以下を読んで、状況を把握してください。

1. .cursor/rules/sumora-ai-ui.mdc（このリポジトリの絶対ルール・Claude Code との分担）
2. memory/dept_search_tool.md の最後の3つの節（2026-11-10 の v2.5.92・v2.5.93・スマホ確認・人と自動の比べ）
3. chrome-extension/DB_STRUCTURE.md
4. chrome-extension/AUTO_MODE_HANDOFF.md

【今のブランチ】
git checkout cursor-ext
git log --oneline -1    ← dd4016f1 が出れば正しい

【今日やった事（2026-11-10）】
- 拡張 v2.5.93: 3つのモード（通常／スタッフ／自動）・GUIDE_ONLY をモードで切り替える形にした
- 自動モード: 勤務時間のゲート（JST 9-21時・12-13時休憩・土日なし・90分で小休憩）・ITANDI の更新日（itandi_update_days）を読む
- 人間らしい動き: 対数正規の間隔・1文字ずつ打つ・マウスの軌跡・スクロールは少しずつ・ITANDI も1件ずつチェック
- 案内モードでも search_audits.filled.form に実際に入った値を送る（10/05 から0件だった原因を直した）
- スマホで見る画面: /api/extension-live（読み取りだけ）
- 人が動いているかの記録: chrome-extension/human-trace.js（isTrusted で人と拡張の操作を区別）
- 人と自動の比べるツール: scripts/audit-human-vs-auto.ts

【まだ終わっていない事】
- cursor-ext を main にマージ（Claude Code 側の担当）
- 実機での確認: 案内モードで YUMA を1回検索して filled.form と filled.human が入るか
- そのあと scripts/audit-human-vs-auto.ts を回して、人と自動の動きの差を見る

【守る事】
- 返事とコミットの文は日本語
- 拡張（chrome-extension/）は Cursor の担当・DB と API（app/api・app/lib）とブレインは Claude Code の担当
- 型チェックは重いので npx tsc --noEmit -p tsconfig.cursor-ext.json（範囲を絞った物）を使う。
  全ファイル版はこの PC のメモリでは落ちる（実績あり）。どうしても全ファイルで見たい時は
  timeout 付きで前景実行し、バックグラウンドに流しっぱなしにしない
- DB の構造は竹内さんの OK 無しに変えない
- 拡張を直したらすぐ memory/dept_search_tool.md に記録する

まず読んだ結果の要約と、次にやるべき事の提案を3つ出してください。まだコードは変えないでください。
```

---

## ③ 実機確認を頼む時の文（2回目）

```
実機で確認したいです。次の手順を一緒に進めてください。

1. Chrome の chrome://extensions で「AIXLINX 物件検索」が 2.5.93 になっているか確認
2. 案内モード（スタッフが押す方）で YUMA を1回検索する
3. そのあと点検の記録を読んで、次が入っているか確かめる
   - search_audits.filled.form（実際に入った値）
   - search_audits.filled.human（人の操作の回数）
   - search_audits.filled.ops（人の操作の時刻）
4. 入っていれば、scripts/audit-human-vs-auto.ts を回して人と自動の動きの差を見る

読み取りだけで、DB は書き換えないでください。
```

---

## ④ 人と自動の差を直す時の文（3回目）

```
scripts/audit-human-vs-auto.ts の結果を見て、足りていない所を直してください。

直し方の原則:
- 「間のばらつきが足りない」→ 一様乱数や固定値を対数正規（human-wait.js の logNormalDelay）にする
- 「一息が足りない」→ 低確率（8%ほど）で長めの間（+400〜1100ms）を入れる
- 「20ms 以内に続く操作がある」→ 1件ずつ人の間を空ける
- 「案内モードで人の操作が0回」→ 案内が止まっている疑い。光が見えているか・条件が届いているかを調べる

直す前に、直す物と直し方を箇条書きで出して、竹内さんに確認してください。
直したら node tests/chrome-extension/*.test.js を回して、全63本が通る事を確かめてください。
```

---

## 補足: 環境が無い場合

```powershell
# 依存（初回のみ・5分ほど）
npm install

# うまく動かない時の確認
git status -sb
git log --oneline -3
node --version     # 22 以上が望ましい
```

`.env.local` は USB（`D:\sumora-ai-ui\.env.local`）から
`sumora-ai-ui\.env.local` にコピーする。**中身をチャットに貼らない。**
