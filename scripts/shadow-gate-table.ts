// scripts/shadow-gate-table.ts — 影の関所の当たりの表（直近 N 日・DB は読むだけ＝evaluateLineWatchTurns の dry＋判定済みの番も読み直す・書かない・送らない・LLM なし）
//   ①影の関所が止めた線の数 ②自信の段ごとの当たり（自信が当たるか）③場面×自信の組ごとの 番・一致・変えずに送った・影が送っていた番の当たり
//   ④場面が付かず「返信:意図:〜」に落ちた番（--unscened=20 で実物を JSON に出す）
//   2026-11-11 竹内さんの決定「まだ今まで通りのやり方で行っていく」＝自動送信は始めない。この表は弱い場面を見つける物差し（測るだけ）。
// 実行: npx tsx --env-file=.env.local scripts/shadow-gate-table.ts [--days=28] [--out=<json>] [--unscened=20]
//   営業時間（JST 9〜22時）は DB を重く読まない（--days=7 まで）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { evaluateLineWatchTurns } from "../app/lib/line-watch-eval-server";
import { shadowUnlockTable, confidenceCalibration, type UnlockTurn } from "../app/lib/shadow-unlock";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
let DAYS = Number(arg("days", "28")) || 28;
const jstHour = new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (jstHour >= 9 && jstHour < 22 && DAYS > 7) { console.log(`営業時間（JST ${jstHour}時）なので --days=7 に絞る`); DAYS = 7; }
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  const r = await evaluateLineWatchTurns(sb, { dry: true, days: DAYS, backlogDays: DAYS, limit: 20_000, reevalFinal: true, collect: true });
  const rows = (r.rows ?? []).filter((x) => !isTestConversation(x.conversation_id));
  const turns: UnlockTurn[] = rows.map((x) => ({
    scene_key: (x.patch.scene_key as string) ?? null, verdict: (x.patch.verdict as string) ?? null,
    verdict_detail: (x.patch.verdict_detail as UnlockTurn["verdict_detail"]) ?? null,
    auto_eligible: (x.patch.auto_eligible as UnlockTurn["auto_eligible"]) ?? null,
    final_check: (x.final_check as UnlockTurn["final_check"]) ?? null,
  }));
  console.log(`=== 影の関所（${DAYS}日・番 ${rows.length}・記録 ${r.shadow.recorded}・送っていた ${r.shadow.would_send}）・errors ${r.errors.length} ===`);
  for (const e of r.errors) console.log("  err:", e);
  // ① 止めた線（全部の線）
  const lineCount: Record<string, number> = {};
  for (const x of rows) for (const l of ((x.patch.auto_eligible as { lines?: string[] } | undefined)?.lines ?? [])) lineCount[l] = (lineCount[l] ?? 0) + 1;
  console.log("\n① 止めた最初の線:", Object.entries(r.shadow.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" ・ "));
  console.log("   当たった線（全部）:", Object.entries(lineCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" ・ "));
  // ② 自信が当たるか（返信の道だけ・AIX の道だけ）
  for (const p of ["返信", "AIX"]) {
    console.log(`\n② 自信の段ごと（${p}の道）: 段 / 番 / 一致 / 変えずに送った`);
    for (const c of confidenceCalibration(turns.filter((t) => t.verdict_detail?.path === p))) console.log(`   ${c.band.padEnd(5)} ${String(c.n).padStart(4)}  ${Math.round(c.matchRate * 100)}%  ${Math.round(c.asIsRate * 100)}%`);
  }
  // 影が送っていた番だけの当たり
  const sent = turns.filter((t) => t.auto_eligible?.would_send);
  const sentCal = confidenceCalibration(sent);
  console.log("\n   影が送っていた番だけ: 段 / 番 / 一致 / 変えずに送った");
  for (const c of sentCal) console.log(`   ${c.band.padEnd(5)} ${String(c.n).padStart(4)}  ${Math.round(c.matchRate * 100)}%  ${Math.round(c.asIsRate * 100)}%`);
  // ③ 場面×自信
  const table = shadowUnlockTable(turns);
  console.log("\n③ 場面×自信: 場面 | 段 | 番 | 一致 | 変えずに | 影が送った番 | その一致 | その変えずに | 残り");
  for (const t of table.filter((x) => x.n >= 5)) console.log(`   ${t.scene} | ${t.band} | ${t.n} | ${pct(t.match, t.n)} | ${pct(t.asIs, t.n)} | ${t.shadowN} | ${pct(t.shadowMatch, t.shadowN)} | ${pct(t.shadowAsIs, t.shadowN)} | ${t.remaining}`);
  const byScene = shadowUnlockTable(turns, { byBand: false });
  console.log("\n③' 場面だけ（段をまとめる・10番以上）");
  for (const t of byScene.filter((x) => x.n >= 10)) console.log(`   ${t.scene} | ${t.n} | 一致 ${pct(t.match, t.n)} | 変えずに ${pct(t.asIs, t.n)} | 影 ${t.shadowN}番 → 一致 ${pct(t.shadowMatch, t.shadowN)}・変えずに ${pct(t.shadowAsIs, t.shadowN)}`);
  // ④ 場面が付かない番
  const unscened = rows.filter((x) => String(x.patch.scene_key ?? "").startsWith("返信:意図:"));
  console.log(`\n④ 場面が付かず「返信:意図:〜」の番 ${unscened.length}/${rows.length}（${pct(unscened.length, rows.length)}）`);
  const n4 = Number(arg("unscened", "0"));
  const out = arg("out");
  if (out) {
    writeFileSync(out, JSON.stringify({
      days: DAYS, shadow: r.shadow, lines: lineCount, table, byScene, sentCal,
      unscened: unscened.slice(-Math.max(n4, 0)).map((x) => ({ id: x.id, conv: x.conversation_id.slice(0, 8), at: x.customer_turn_at, scene: x.patch.scene_key, verdict: x.patch.verdict })),
    }, null, 2));
    console.log(`→ ${out}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
