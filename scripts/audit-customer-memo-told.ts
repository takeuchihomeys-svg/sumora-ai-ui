// scripts/audit-customer-memo-told.ts — 「もう伝えた事」の種類（customer-memo.toldKindsOf）で、下書きが前に伝えた種類を言い直し・人は言い直さなかった番を数える（読むだけ・LLM なし）
//   入力: 下書き×実送信の組の meta（scripts/audit-r7-text-diff 系・11巡目の r12 pairs.txt.meta.json の形: hist[{s,at,aix,t}]・draft・staff）
// 実行: npx tsx scripts/audit-customer-memo-told.ts <meta.json> [--show=kind]
import { readFileSync } from "node:fs";
import { toldKindsOf, TOLD_JA, type ToldKind } from "../app/lib/customer-memo";
const file = process.argv[2]; const SHOW = process.argv.find((a) => a.startsWith("--show="))?.slice(7) ?? "";
const meta = JSON.parse(readFileSync(file, "utf8")) as Array<{ k: number; same: boolean; hist: Array<{ s: string; t: string | null }>; draft: string; staff: string }>;
const agg = new Map<ToldKind, { told: number; aiRepeat: number; humanRepeat: number; aiRepeatHumanNot: number; ex: number[] }>();
let pairs = 0, anyAiOnly = 0;
for (const m of meta) {
  if (m.same) continue; pairs++;
  // 会話の最後の通が竹内さんの送信そのもの（下書きの後の実送信）の事がある＝それ以降は数えない
  const cut = m.hist.findIndex((h) => h.s !== "customer" && (h.t ?? "").slice(0, 40) === m.staff.slice(0, 40));
  const hist = cut >= 0 ? m.hist.slice(0, cut) : m.hist;
  const told = new Set<ToldKind>(); for (const h of hist) if (h.s !== "customer") for (const k of toldKindsOf(h.t)) told.add(k);
  const ai = new Set(toldKindsOf(m.draft)); const hu = new Set(toldKindsOf(m.staff));
  let hit = false;
  for (const k of told) {
    const a = agg.get(k) ?? { told: 0, aiRepeat: 0, humanRepeat: 0, aiRepeatHumanNot: 0, ex: [] }; a.told++;
    if (ai.has(k)) a.aiRepeat++; if (hu.has(k)) a.humanRepeat++;
    if (ai.has(k) && !hu.has(k)) { a.aiRepeatHumanNot++; a.ex.push(m.k); hit = true; }
    agg.set(k, a);
  }
  if (hit) anyAiOnly++;
}
console.log(`不一致の組 ${pairs}・下書きが前に伝えた種類を言い直し人は言い直さなかった組 ${anyAiOnly}`);
for (const [k, a] of [...agg].sort((x, y) => y[1].aiRepeatHumanNot - x[1].aiRepeatHumanNot)) console.log(`  ${TOLD_JA[k].padEnd(20)} 前に伝えた ${a.told}・AI も言う ${a.aiRepeat}・人も言う ${a.humanRepeat}・AI だけ言う ${a.aiRepeatHumanNot}  #${a.ex.slice(0, 12).join(" #")}`);
if (SHOW) for (const m of meta) { if (!agg.get(SHOW as ToldKind)?.ex.includes(m.k)) continue; console.log(`\n#${m.k}\n AI: ${m.draft.replace(/\n/g, "⏎").slice(0, 200)}\n 竹: ${m.staff.replace(/\n/g, "⏎").slice(0, 200)}`); }
