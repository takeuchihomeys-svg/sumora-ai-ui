// scripts/audit-unseen-how.ts — 見ていない番（gold-unseen-1112）で「どうやって」の表（compose-how-table）と型ごとの足し（COMPOSE_HOW_BY_TYPE）を測る（AI を呼ばない・DB を読まない・費用0）
//   決まりはこの番を見て変えない（11/12 統括役）。答案（ブレイン）が無い番も多いので、場面と竹内さんの主の役目・誘導先から表を引く＝ブレインの誘導先が当たった時の上限
//   当たり: 竹内さんの札と1つでも重なる（audit-compose-understanding の setHit と同じ）
// 実行: npx tsx scripts/audit-unseen-how.ts [--show]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { takeuchiHowFor } from "../app/lib/compose-how-table";
import { howByType } from "../app/lib/compose-sentence-plan";
import { orderTypeOf } from "../app/lib/compose-order-table";

const ROOT = resolve(__dirname, "..");
const show = process.argv.includes("--show");
type G = { id: string; type: string; scene: string; mainRole: string; leadTo: string; property: string | null; keyHow: string[]; trustHow: string[] };
const turns = (JSON.parse(readFileSync(join(ROOT, "scripts/compose-understanding/gold-unseen-1112.json"), "utf8")) as { turns: G[] }).turns;
const hit = (g: string[], p: string[]) => (g.length ? (p.some((x) => g.includes(x)) ? 1 : 0) : null);
const T: Record<string, { n: number; kOff: number; kOn: number; tOff: number; tOn: number }> = {};
for (const g of turns) {
  const main = g.mainRole as never;
  const lead = g.leadTo !== "none" ? g.leadTo : main === "keep" ? "keep" : main === "answer" ? "answer_only" : null;
  const tbl = takeuchiHowFor(g.scene, lead);
  const keyOff = (tbl?.key ?? []).filter((k) => g.mainRole === "uke" || k !== "accept_first") as string[];
  const trustOff = (tbl?.trust ?? []) as string[];
  const bt = howByType(orderTypeOf(g.scene, main), { hasAnswer: g.mainRole === "answer", property: g.property });
  const keyOn = bt.key.length ? (bt.key as string[]) : keyOff, trustOn = bt.trust.length ? (bt.trust as string[]) : trustOff;
  const r = (T[g.type] ??= { n: 0, kOff: 0, kOn: 0, tOff: 0, tOn: 0 });
  r.n++; r.kOff += hit(g.keyHow, keyOff) ?? 0; r.kOn += hit(g.keyHow, keyOn) ?? 0; r.tOff += hit(g.trustHow, trustOff) ?? 0; r.tOn += hit(g.trustHow, trustOn) ?? 0;
  if (show) console.log(`- ${g.id} ${g.type} [${g.scene}/${lead}] 押さえ 竹内=${g.keyHow.join("+")} 表=${keyOff.join("+") || "空"} 型=${keyOn.join("+") || "空"}｜信頼 竹内=${g.trustHow.join("+")} 表=${trustOff.join("+") || "空"} 型=${trustOn.join("+") || "空"}`);
}
let a = { n: 0, kOff: 0, kOn: 0, tOff: 0, tOn: 0 };
console.log("型（番）｜押さえ方 表→表＋型｜信頼 表→表＋型");
for (const [k, r] of Object.entries(T)) { console.log(`${k}（${r.n}）｜${r.kOff}→${r.kOn}｜${r.tOff}→${r.tOn}`); a = { n: a.n + r.n, kOff: a.kOff + r.kOff, kOn: a.kOn + r.kOn, tOff: a.tOff + r.tOff, tOn: a.tOn + r.tOn }; }
console.log(`全部（${a.n}）｜押さえ方 ${a.kOff}→${a.kOn}｜信頼 ${a.tOff}→${a.tOn}`);
