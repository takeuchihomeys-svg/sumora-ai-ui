// scripts/backfill-outcome-ledger.ts — 結果の台帳（deal_outcomes・outcome_events）の埋め戻し（5/30〜・決定論・LLM なし・API 費用0）
//   既定は dry-run（DB に書かない・数字と JSON を出すだけ）。--apply の時だけ新しい2つの表に書く（元の表は1行も書き換えない）。
//   計画: memory/plan_outcome_ledger.md 段3・決まり: app/lib/deal-outcome.ts
// 実行:
//   npx tsx --env-file=.env.local scripts/backfill-outcome-ledger.ts                         # dry-run（全会話・作成日 5/30〜）
//   npx tsx --env-file=.env.local scripts/backfill-outcome-ledger.ts --since=2026-05-01      # 作成日の線を変える（5/17〜の会話も入れる時）
//   npx tsx --env-file=.env.local scripts/backfill-outcome-ledger.ts --out=<file.json>        # 計算した行を JSON に
//   npx tsx --env-file=.env.local scripts/backfill-outcome-ledger.ts --apply                 # 書く（DDL を流した後）
//   --conv=<id> で1会話だけ・--limit=N
import { writeFileSync } from "node:fs";
import { computeConversationOutcome, writeConversationOutcome, listOutcomeConversations, type ComputedOutcome } from "../app/lib/deal-outcome-server";
import { DEAL_STAGES, stageRank, countsAsConfirmedWin } from "../app/lib/deal-outcome";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const APPLY = process.argv.includes("--apply");
const SINCE = arg("since") ?? "2026-05-30";
const LIMIT = arg("limit") ? Number(arg("limit")) : undefined;
const CONV = arg("conv");
const OUT = arg("out");

async function main() {
  const nowMs = Date.now();
  const ids = CONV ? [CONV] : await listOutcomeConversations({ sinceCreated: `${SINCE}T00:00:00+09:00`, limit: LIMIT });
  console.log(`${APPLY ? "【apply】" : "【dry-run】"} 会話 ${ids.length}（作成日 ${SINCE}〜・YUMA と身内を除く）`);
  const results: ComputedOutcome[] = [];
  const errors: string[] = [];
  let i = 0;
  const queue = [...ids];
  const worker = async () => {
    for (;;) {
      const id = queue.shift(); if (!id) return;
      try {
        const o = await computeConversationOutcome(id, { nowMs });
        if (o) {
          results.push(o);
          if (APPLY) await writeConversationOutcome(o);
        }
      } catch (e) { errors.push(`${id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`); }
      if (++i % 50 === 0) console.log(`  …${i}/${ids.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const rows = results.flatMap((r) => r.rows);
  const events = results.flatMap((r) => r.events);
  const count = <T,>(xs: T[], f: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  console.log(`\n案件 ${rows.length}（会話 ${results.length}・2つ目以降の案件 ${rows.filter((r) => r.episode_no > 1).length}）・出来事 ${events.length}・失敗 ${errors.length}`);
  console.log("\n■ 結果×確かさ");
  for (const [k, n] of count(rows, (r) => `${r.result}/${r.result_certainty}`)) console.log(`  ${k}: ${n}`);
  console.log("\n■ 成約の根拠");
  for (const [k, n] of count(rows.filter((r) => r.result === "won"), (r) => `${r.result_certainty}:${r.result_evidence}`)) console.log(`  ${k}: ${n}`);
  console.log(`  → 学習・実績に使える確定の成約: ${rows.filter(countsAsConfirmedWin).length}`);
  console.log("\n■ 失注の型（理由は弱い参考）");
  for (const [k, n] of count(rows.filter((r) => r.result === "lost"), (r) => `${r.lost_type}/${r.result_certainty}${r.after_screening_fail ? "/審査の後" : ""}${r.lost_type === "no_response" ? (r.chased ? "/追いかけ済み" : "/追いかけなし") : ""}`)) console.log(`  ${k}: ${n}`);
  console.log("\n■ 切り替え（審査落ち・取り消し）");
  for (const [k, n] of count(rows.filter((r) => r.result === "switched"), (r) => `${r.switch_reason}`)) console.log(`  ${k}: ${n}`);
  console.log("\n■ 到達した一番上の段階");
  for (const s of DEAL_STAGES) console.log(`  ${s}: ${rows.filter((r) => r.max_stage === s).length}`);
  const applied = rows.filter((r) => stageRank(r.max_stage) >= stageRank("applied"));
  console.log(`\n■ 申込に届いた案件 ${applied.length}: 物件あり ${applied.filter((r) => r.building_key).length}（確定寄り ${applied.filter((r) => r.property_certainty === "confirmed").length}）・申込の時刻が推定 ${applied.filter((r) => r.applied_at_estimated).length}`);
  for (const [k, n] of count(applied, (r) => r.property_evidence ?? "（物件なし）")) console.log(`  ${k}: ${n}`);
  console.log(`\n■ 内覧: 予定 ${rows.filter((r) => r.viewing_at).length}・実施 ${rows.filter((r) => r.viewing_held_at).length}`);
  console.log("\n■ 会話の作成月ごと（案件1）: 会話・内覧の実施・申込・成約（確定）・失注");
  const byMonth = new Map<string, typeof rows>();
  for (const r of rows.filter((x) => x.episode_no === 1)) { const m = (r.started_at ?? "").slice(0, 7) || "不明"; if (!byMonth.has(m)) byMonth.set(m, []); byMonth.get(m)!.push(r); }
  for (const [m, rs] of [...byMonth.entries()].sort()) {
    const conv = new Set(rs.map((r) => r.conversation_id));
    const all = rows.filter((r) => conv.has(r.conversation_id));
    console.log(`  ${m}: ${conv.size}・${all.filter((r) => r.viewing_held_at).length}・${all.filter((r) => stageRank(r.max_stage) >= stageRank("applied")).length}・${all.filter((r) => r.result === "won").length}（${all.filter(countsAsConfirmedWin).length}）・${all.filter((r) => r.result === "lost").length}`);
  }
  console.log("\n■ 出来事の種類");
  for (const [k, n] of count(events, (e) => e.kind)) console.log(`  ${k}: ${n}`);
  console.log(`  ブレインの判断に物件の鍵: ${events.filter((e) => e.kind === "brain_decision" && e.building_key).length}／送った AIX に判断の id: ${events.filter((e) => e.kind === "aix_sent" && e.decision_id).length}/${events.filter((e) => e.kind === "aix_sent").length}`);
  if (errors.length) { console.log("\n■ 失敗"); for (const e of errors.slice(0, 20)) console.log(`  ${e}`); }
  if (OUT) { writeFileSync(OUT, JSON.stringify(results.map((r) => ({ conversationId: r.conversationId, rows: r.rows, events: r.events.length })), null, 1)); console.log(`\n→ ${OUT}`); }
  if (!APPLY) console.log("\n（dry-run: DB には書いていない。書く時は --apply）");
}
main().catch((e) => { console.error(e); process.exit(1); });
