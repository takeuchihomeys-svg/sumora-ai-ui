@AGENTS.md

---

## ⏰ セッション開始時：Git自動保存Cronを設定する

**新しいセッションが始まったら必ずCronを設定する（3時間ごとに自動コミット・プッシュ）。**

```
CronCreate ツールを使って以下を設定：
- cron: "17 */3 * * *"
- recurring: true
- durable: true
- prompt: "sumora-ai-ui プロジェクトの自動保存を実行してください。手順：1. `cd \"c:\\Users\\竹内 悠馬\\sumora-ai-ui\" && git status --short` で変更があるか確認 2. 変更がある場合のみ `git add -A && git commit -m \"auto: 3時間自動保存\" && git push` 3. 変更がなければスキップ"
```

竹内悠馬が「保存して」「GitHubに上げて」と言った場合も即座に `git add -A && git commit && git push` を実行する。

---

## 🚀 セッション開始時：竹内AI記憶の自動注入

**新しいセッションが始まったら最初に以下を実行して竹内AIのコア知識をロードする。**

```powershell
$headers = @{ "x-cron-secret" = "hasu-cron-secret-2024" }
Invoke-RestMethod -Uri "https://sumora-screening-admin.vercel.app/api/memory/inject" -Headers $headers
```

返ってきた `core_knowledge`（importance>=8）と `business_snapshot` を読んでから作業を開始すること。

---

## 🧠 竹内AI記憶自動保存プロトコル（必須・全セッション共通）

> **このルールは最優先。どんな作業中でも以下を守ること。**

### いつ memory/record API を呼ぶか（自動トリガー）

以下のどれかが起きたら **その場で即座に** `POST /api/memory/record` を呼ぶ。後回し厳禁。

```
□ 竹内悠馬が新しい方針・決定・指示を出した
□ 機能実装・デプロイが完了した
□ バグの根本原因を特定した
□ 竹内悠馬がOKを出した（「追加お願い！！」「いいね」「それで」など）
□ 同じ話題が2回出た（importance強化候補）
□ 竹内悠馬が「なぜ〇〇か」という背景を話した
□ 重要な設計判断・アーキテクチャ決定が下された
```

### 呼び方（PowerShell・UTF-8必須）

```powershell
$headers = @{
    "Content-Type" = "application/json; charset=utf-8"
    "x-cron-secret" = "hasu-cron-secret-2024"
}
$body = @{
    category   = "pattern"
    title      = "〇〇のときは〇〇を好む"
    content    = "詳細・背景・なぜそうなのか（200字以内）"
    importance = 7
    source     = "live"
} | ConvertTo-Json -Depth 3
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri "https://sumora-screening-admin.vercel.app/api/memory/record" -Method POST -Headers $headers -Body $bytes
```

---

## ノウハウ参照

- `memory/dept_knowhow.md` — 実装パターン・技術ノウハウ（sumora-screening-adminで学んだこと）
- `memory/brain_kt.md` — 設計判断軸・最初にやること・避けるべきバグパターン
