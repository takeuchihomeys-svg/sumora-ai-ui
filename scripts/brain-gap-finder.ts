// scripts/brain-gap-finder.ts — ブレインの穴を自分で見つける（手元で回す・DB を読むだけ・LLM なし・$0）
//   2026-10-15 竹内さん「ブレインを強化するのが質を上げるために最重要。足りていない部分を見つけられるようにする」（設計知見【最優先】97ea82f3）
//   決まり: app/lib/brain-gap-finder.ts／DB: app/lib/brain-gap-finder-server.ts。毎週月曜の見張りは /api/cron/reading-audit-weekly（cron_run_logs の brain-gap-finder）
//   出力は個人名を伏せた要旨30字・会話は id の先頭8字だけ（外に貼る時もこのまま）
// 実行: npx tsx --env-file=.env.local scripts/brain-gap-finder.ts [--days=7] [--examples=3] [--kind=edited,final_miss] [--cause=knowledge] [--tag=parking] [--list=20] [--json]
import { createClient } from "@supabase/supabase-js";
import { runBrainGapFinder } from "@/app/lib/brain-gap-finder-server";
import { gapSummaryLines, KIND_JA, CAUSE_JA, TAG_JA, type GapFinding } from "@/app/lib/brain-gap-finder";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Math.max(1, Number(arg("days", "7")) || 7);
const EXAMPLES = Number(arg("examples", "3"));
const LIST = Number(arg("list", "0"));
const KIND = arg("kind", ""), CAUSE = arg("cause", ""), TAG = arg("tag", "");

(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL / key が未設定（--env-file=.env.local）"); process.exit(2); }
  const sb = createClient(url, key);
  const r = await runBrainGapFinder(sb, { days: DAYS, examples: EXAMPLES });
  if (process.argv.includes("--json")) { const { findings: _f, ...rest } = r; void _f; console.log(JSON.stringify(rest, null, 2)); return; }
  if (r.summary) for (const l of gapSummaryLines(r.summary, DAYS)) console.log(l);
  console.log(`● 確認事項: 未対応のまま48時間以上 ${r.ledger.open}（${Object.entries(r.ledger.topics).map(([k, v]) => `${k} ${v}`).join("・") || "-"}）／完了の判定が覆った ${r.ledger.reopened}`);
  console.log(`● 初回の持ち込み: 番 ${r.brought.turns}・下書きあり ${r.brought.withDraft}・最大限割引の御見積書の一言なし ${r.brought.missing}（うちスタッフは書いた ${r.brought.staffHad}）`);
  console.log(`● 新しい turn_contract の軸（about/property/when/whose）が入った番: ${r.axisTurns}${r.axisTurns ? "" : "（本番に入る前＝語と前後の流れの手がかりだけで分けた）"}`);
  if (r.skippedOutage) console.log(`● 下書きも判断も届いていない番が続いた区間（障害の疑い・穴に数えない）: ${r.skippedOutage}番（${r.outageRange?.from.slice(5, 16)}〜${r.outageRange?.to.slice(5, 16)} UTC）`);
  if (r.errors.length) console.log("⚠ 読めなかった物:", r.errors.slice(0, 5).join(" / "));
  if (LIST > 0) {
    const pick = (f: GapFinding) => (!KIND || KIND.split(",").includes(f.kind)) && (!CAUSE || CAUSE.split(",").includes(f.cause)) && (!TAG || f.tags.some((t) => TAG.split(",").includes(t)));
    const rows = r.findings.filter(pick).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, LIST);
    console.log(`\n● 一覧（${rows.length}件）`);
    for (const f of rows) console.log(`  ${f.conversationId.slice(0, 8)} ${f.at.slice(5, 16)} ［${KIND_JA[f.kind]}］${CAUSE_JA[f.cause].replace(/（.*$/, "")}: ${f.sub}${f.tags.length ? ` {${f.tags.map((t) => TAG_JA[t]).join("・")}}` : ""}\n      客「${f.customer}」→ 実「${f.staff}」`);
  }
})();
