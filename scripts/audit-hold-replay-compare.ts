// scripts/audit-hold-replay-compare.ts — 保留の番の柔らかい次の一手: 前（HOLD_SOFT_NEXT=off）と後の再生（yuma-repeat-replay.ts の jsonl）を竹内さんの実送信と比べる（読むだけ・LLM なし）
// 実行: npx tsx scripts/audit-hold-replay-compare.ts <before.jsonl> <after.jsonl>
import fs from "node:fs";
import { softNextMoveOf } from "../app/lib/hold-soft-next";

const read = (f: string) => new Map(fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).map((r) => [String(r.id), r]));
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]/gu, "");
function dice(a: string, b: string): number {
  const x = norm(a), y = norm(b); if (!x || !y) return 0;
  const A = new Map<string, number>(); for (let i = 0; i < x.length - 1; i++) A.set(x.slice(i, i + 2), (A.get(x.slice(i, i + 2)) ?? 0) + 1);
  let inter = 0; for (let i = 0; i < y.length - 1; i++) { const g = y.slice(i, i + 2); const v = A.get(g) ?? 0; if (v > 0) { inter++; A.set(g, v - 1); } }
  return (2 * inter) / (x.length - 1 + y.length - 1);
}
const [bf, af] = process.argv.slice(2);
const B = read(bf), A = read(af);
let n = 0, simB = 0, simA = 0, agB = 0, agA = 0, overB = 0, overA = 0, missB = 0, missA = 0;
for (const [id, a] of A) {
  const b = B.get(id); if (!b) continue;
  const db = String(b.draft_after ?? ""), da = String(a.draft_after ?? ""), st = String(a.staff ?? "");
  if (!db || !da || !st) { console.log(`${id} 下書きなし（前 ${db ? "あり" : String(b.skip_draft_after ?? b.no_draft ?? b.error ?? "-")}・後 ${da ? "あり" : String(a.skip_draft_after ?? a.no_draft ?? a.error ?? "-")}）`); continue; }
  n++;
  const ms = softNextMoveOf(st), mb = softNextMoveOf(db), ma = softNextMoveOf(da);
  simB += dice(db, st); simA += dice(da, st);
  if (!!mb === !!ms) agB++; if (!!ma === !!ms) agA++;
  if (mb && !ms) overB++; if (ma && !ms) overA++;
  if (!mb && ms) missB++; if (!ma && ms) missA++;
  const one = (s: string) => s.replace(/\n+/g, " ／ ").slice(0, 150);
  console.log(`\n==== ${id} 竹=${ms ?? "-"} 前=${mb ?? "-"} 後=${ma ?? "-"}  近さ ${dice(db, st).toFixed(2)}→${dice(da, st).toFixed(2)}`);
  console.log(`脳前: ${String((b.brain as Record<string, unknown> | undefined)?.dir ?? "").slice(0, 110)}`);
  console.log(`脳後: ${String((a.brain as Record<string, unknown> | undefined)?.dir ?? "").slice(0, 110)}`);
  console.log(`前: ${one(db)}\n後: ${one(da)}\n竹: ${one(st)}`);
}
const p = (x: number) => (n ? (x / n).toFixed(3) : "-");
console.log(`\n=== ${n} 番: 竹内さんとの近さ 前 ${p(simB)} → 後 ${p(simA)}／柔らかい一手の有無が竹内さんと同じ 前 ${agB}/${n} → 後 ${agA}/${n}（足りない 前 ${missB}→後 ${missA}・言い過ぎ 前 ${overB}→後 ${overA}）`);
