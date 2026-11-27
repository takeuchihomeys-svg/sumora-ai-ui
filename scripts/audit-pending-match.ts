// scripts/audit-pending-match.ts — 待ちの物件 × 送った AIX の物件名 の突き合わせを写し（problems.json）で数える（2026-11-27 作業員A）
//   LLM も DB も使わない。数えるもの: 両方がある問題・前の比べ（名前全体）で合う問題・今の比べで合う問題・
//   誤一致の疑い（合った組のうち、建物名の頭だけが同じ別の建物・号室が違う）を別に数え、合った組は目で読む用に出す
//   実行: npx tsx scripts/audit-pending-match.ts [problems.json] [--show]
import { readFileSync } from "node:fs";
import { pendingMatchedOf, splitPropertyName } from "../app/lib/pickup-link-stages";

const path = process.argv.find((a) => a.endsWith(".json")) ?? "scripts/brain-exam/problems.json";
const show = process.argv.includes("--show");
type Row = Record<string, unknown>;
const probs = JSON.parse(readFileSync(path, "utf8")) as Array<{ id: string; ledger?: Record<string, Array<{ row: Row }>> }>;
const oldNorm = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/[\s　]/g, "");
let both = 0, oldHit = 0, newHit = 0, pairs = 0, prefixOnly = 0, roomDiff = 0, noRoomSide = 0;
for (const q of probs) {
  const L = q.ledger ?? {};
  const pend = (L.property_pickups ?? []).map((r) => r.row).filter((r) => r.status === "pending") as Array<{ property_name: string | null; room_no: string | null }>;
  const names = (L.aix_usage_logs ?? []).map((r) => r.row).filter((r) => ["property_send", "property_recommendation"].includes(String(r.aix_type))).flatMap((r) => (r.property_names as string[] | null) ?? []);
  if (!pend.length || !names.length) continue;
  both++;
  const os = new Set(names.map(oldNorm));
  if (pend.some((p) => os.has(oldNorm(p.property_name)))) oldHit++;
  const hit = pendingMatchedOf(pend, names);
  if (hit.length) newHit++;
  for (const p of pend) {
    const a = splitPropertyName(p.property_name);
    for (const n of names) {
      const s = splitPropertyName(n);
      if (a.building && s.building && a.building !== s.building && a.building.length >= 3 && s.building.length >= 3 && (a.building.startsWith(s.building) || s.building.startsWith(a.building))) prefixOnly++;
      if (a.building && a.building === s.building) {
        const room = p.room_no ? String(parseInt(String(p.room_no).replace(/\D/g, ""), 10)) : a.room;
        if (room && s.room && room !== s.room) roomDiff++;
        else { pairs++; if (!s.room || !room) noRoomSide++; if (show) console.log(`  合 ${q.id} | ${p.property_name} ${p.room_no ?? ""} | ${n}`); }
      }
    }
  }
}
console.log(JSON.stringify({ 両方ある問題: both, 前の比べで合う問題: oldHit, 今の比べで合う問題: newHit, 合った組: pairs, うち号室が片方だけ: noRoomSide, 外した_号室違い: roomDiff, 外した_頭だけ同じ別の建物: prefixOnly }));
