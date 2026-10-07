// scripts/audit-r7-replay-score.ts — 7巡目: YUMA の再生（scripts/yuma-r3-replay.ts の書き出し）を回ごと・場面ごとに採点する（読むだけ・LLM なし）
//   一致の物差し（app/lib/text-diff-types.ts）: 完全一致＝文字が同じ（前後の空白だけ違う物を含む）／近い＝芯（絵文字・記号・空白・表記を寄せた物）の Dice 0.8 以上／似ている度＝芯の Dice の平均
//   型ごとの差の残り（冒頭・挨拶・改行・！・絵文字・足した・消した…）も並べる
// 実行: npx tsx scripts/audit-r7-replay-score.ts <回の名前>=<jsonl> [<回の名前>=<jsonl> …] [--key=draft_A] [--detail]
import { readFileSync } from "node:fs";
import { diffTexts, DIFF_TYPES, DIFF_TYPE_JA } from "../app/lib/text-diff-types";
import { REPLY_SCENE_JA, type ReplyScene } from "../app/lib/reply-scene";
import { subSceneOf } from "../app/lib/reply-subscene";

const args = process.argv.slice(2);
const KEY = args.find((a) => a.startsWith("--key="))?.slice(6) ?? "draft_A";
const DETAIL = args.includes("--detail");
const runs = args.filter((a) => !a.startsWith("--")).map((a) => { const i = a.indexOf("="); return { name: a.slice(0, i), file: a.slice(i + 1) }; });
type Rec = { id: string; scene: ReplyScene; staff?: string; customer?: string[]; [k: string]: unknown };
const NEAR = 0.8;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const SCENES: ReplyScene[] = ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other"];

for (const run of runs) {
  const recs = readFileSync(run.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  const keys = [...new Set(recs.flatMap((r) => Object.keys(r).filter((k) => k === KEY || k.startsWith(`${KEY}_`))))];
  const rows: Array<{ id: string; scene: ReplyScene; d: ReturnType<typeof diffTexts>; draft: string; staff: string }> = [];
  let noDraft = 0;
  for (const r of recs) {
    if (!r.staff) continue;
    let any = false;
    for (const k of keys) { const d = r[k]; if (typeof d !== "string" || !d.trim()) continue; any = true; rows.push({ id: `${r.id}${k === KEY ? "" : k.slice(KEY.length)}`, scene: r.scene, d: diffTexts(d, r.staff), draft: d, staff: r.staff }); }
    if (!any) noDraft++;
  }
  const line = (label: string, l: typeof rows) => `${label.padEnd(10)} n=${String(l.length).padStart(3)} 完全一致 ${pct(l.filter((x) => x.d.same).length, l.length).padStart(4)}・近い ${pct(l.filter((x) => x.d.same || x.d.sim >= NEAR).length, l.length).padStart(4)}・似ている度 ${l.length ? (l.reduce((a, x) => a + x.d.sim, 0) / l.length).toFixed(2) : "-"}`;
  console.log(`\n■ 回「${run.name}」（${run.file}・下書きなし ${noDraft}番）`);
  console.log(`  ${line("全体", rows)}`);
  for (const s of SCENES) { const l = rows.filter((x) => x.scene === s); if (l.length) console.log(`  ${line(REPLY_SCENE_JA[s], l)}`); }
  // 小場面（app/lib/reply-subscene.ts）× 一致: 100% に届いたか（完全一致＝n）を判定できる表
  const subs = new Map<string, typeof rows>();
  for (const x of rows) { const r = recs.find((y) => x.id.startsWith(y.id))!; const k = subSceneOf({ customerText: (r.customer ?? []).join("\n"), prevStaffText: (r.prevStaff as string | undefined) ?? "", scene: r.scene }); if (!subs.has(k)) subs.set(k, []); subs.get(k)!.push(x); }
  console.log(`  小場面（完全一致が n に届いた＝★・型の差の残り）:`);
  for (const [k, l] of [...subs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const same = l.filter((x) => x.d.same).length;
    const types = DIFF_TYPES.map((t) => [t, l.filter((x) => x.d.types.includes(t)).length] as const).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${DIFF_TYPE_JA[t]}${n}`).join(" ");
    console.log(`    ${same === l.length ? "★" : "　"} ${k.padEnd(28)} n=${String(l.length).padStart(2)} 完全 ${same}/${l.length}・近い ${l.filter((x) => x.d.same || x.d.sim >= NEAR).length}・似 ${(l.reduce((a, x) => a + x.d.sim, 0) / l.length).toFixed(2)}  ${types}`);
  }
  console.log(`  型ごとの差の残り: ${DIFF_TYPES.map((t) => [t, rows.filter((x) => x.d.types.includes(t)).length] as const).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${DIFF_TYPE_JA[t]} ${pct(n, rows.length)}`).join("・")}`);
  if (DETAIL) for (const x of rows.filter((x) => !x.d.same)) console.log(`   ${x.id} [${x.scene}] sim=${x.d.sim} ${x.d.types.join(",")}\n     AI: ${x.draft.replace(/\n/g, "⏎").slice(0, 160)}\n     人: ${x.staff.replace(/\n/g, "⏎").slice(0, 160)}`);
}
