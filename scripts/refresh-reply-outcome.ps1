# scripts/refresh-reply-outcome.ps1 — 結果から学ぶ（reply-outcome-learn）の数え表を週1回作り直す（本番 DB は読むだけ・LLM なし・$0）
#   1) scripts/audit-reply-outcome.ts --write-table で app/lib/reply-outcome-table-data.ts を書き直す（数だけ・古い／新しいで向きが保たれたかの印つき）
#   2) 差分を見せるだけ（コミット・push はしない＝人が見てから）
# 本番の Vercel cron にしない理由: 表はコードのファイル（デプロイで届く）で、cron からはリポジトリに書けない。
#   本番で毎週自動にするなら、表を DB の1行（例: brain_outcome_tables）に置いて cron が書く形にする（テーブル追加は竹内さんの OK 待ち）。
# 実行: powershell -File scripts/refresh-reply-outcome.ps1   （Windows のタスク スケジューラで毎週月曜に回してもよい）
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
npx tsx --env-file=.env.local scripts/audit-reply-outcome.ts --write-table | Select-Object -Last 25
git diff --stat -- app/lib/reply-outcome-table-data.ts
