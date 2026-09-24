// property_pickups の既存の行に、資料の設備欄の照合（equipment 列）と EQUIP_* 入りの判定を付け直す（2026-09-24）
//   既定は dry-run（書き込みなし）。--apply で書く。--backup=<path> で前の score・verdict・reason_codes・reasons_ja・equipment を控える
//   npx tsx --env-file=.env.local scripts/backfill-pickup-equipment.ts --ids=50-67 [--apply] [--backup=<path>]
// 決まり: 保存済みのコード（家賃・徒歩・AD・画像）は残し、設備欄の照合だけ付け直す（applyEquipmentMatch）。
//   説明文が古い形の行（itandi の「【1】物件\nAD 1ヶ月」）で judgeProperty をやり直すと、家賃・徒歩・AD の材料が消えるため
//   同じ建物の補いは同じ回（batch_id）の中の保存済みの行だけ（落とした部屋の文字層は保存されていない）
//   お客様の名前・電話番号は出さない
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildBatchEquipment } from "../app/lib/pickup-equipment";
import { parseListingEquipment } from "../app/lib/listing-equipment";
import { applyEquipmentMatch, reasonJa, type CustomerLike } from "../app/lib/property-brain";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3);
const APPLY = process.argv.includes("--apply");
const BACKUP = arg("backup");
const [ID_FROM, ID_TO] = (arg("ids") || "50-67").split("-").map((x) => parseInt(x, 10));

type Row = { id: number; batch_id: string; property_customer_id: string | null; rank: number; pdf_text: string | null;
  score: number | null; verdict: string | null; reason_codes: string[] | null; reasons_ja: string[] | null; equipment: unknown };

async function petAudit() {
  // 説明文の「ペット不可」（PET_NG の語）と設備欄のペット（items.pet）を比べる（置き換えで誤りが増えないか）
  const { data } = await sb.from("property_pickups").select("id, summary_text, pdf_text").not("pdf_text", "is", null).limit(3000);
  let rx = 0, eqNg = 0, eqOk = 0;
  const disagree: unknown[] = [];
  for (const r of (data ?? []) as Array<{ id: number; summary_text: string; pdf_text: string }>) {
    const re = /ペット不可|ペット×|ペットNG/.test(r.summary_text);
    const p = parseListingEquipment(r.pdf_text).items.pet;
    if (re) rx++;
    if (p.status === "ng") eqNg++;
    if (p.status === "ok") eqOk++;
    if (re && p.status === "ok") disagree.push({ id: r.id, ev: p.evidence });
  }
  console.log(`PET 監査: 文字層のある行 ${(data ?? []).length}・説明文の語で不可 ${rx}・設備欄で不可 ${eqNg}・設備欄で可/相談 ${eqOk}・食い違い ${disagree.length}`, JSON.stringify(disagree).slice(0, 300));
}

async function main() {
  await petAudit();
  const { data, error } = await sb.from("property_pickups").select("id, batch_id, property_customer_id, rank, pdf_text, score, verdict, reason_codes, reasons_ja, equipment")
    .gte("id", ID_FROM).lte("id", ID_TO).order("id");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  if (BACKUP) writeFileSync(BACKUP, JSON.stringify(rows.map(({ pdf_text, ...r }) => (void pdf_text, r)), null, 1));
  const updates: Array<{ id: number; patch: Record<string, unknown> }> = [];
  const batches = [...new Set(rows.map((r) => r.batch_id))];
  for (const bid of batches) {
    const br = rows.filter((r) => r.batch_id === bid);
    const pcid = br[0].property_customer_id;
    const { data: cust } = pcid ? await sb.from("property_customers").select("preferences, ng_points, other_requests, additional_conditions, pet").eq("id", pcid).maybeSingle() : { data: null };
    const eq = buildBatchEquipment(br.map((r) => ({ key: r.id, pdfText: r.pdf_text })), (cust ?? null) as CustomerLike | null);
    for (const r of br) {
      const e = eq.rows.find((x) => x.key === r.id)!;
      const j = applyEquipmentMatch({ reasonCodes: r.reason_codes ?? [] }, e.match);
      // 前の reasons_ja のうちコードから作っていない一文（同じ建物の省略）は先頭に残す
      const fromCodes = new Set((r.reason_codes ?? []).map(reasonJa));
      const extra = (r.reasons_ja ?? []).filter((s) => !fromCodes.has(s));
      const chips = j.reasonCodes.filter((c) => c.startsWith("EQUIP_")).map(reasonJa);
      console.log(`#${r.id} 【${r.rank}】 ${r.score} ${r.verdict} → ${j.score} ${j.verdict} | ${e.saved.line} | 所在階 ${e.saved.floor ?? "?"}(${e.saved.floorSource ?? "-"}) | ${chips.join("・")}`);
      updates.push({ id: r.id, patch: { score: j.score, verdict: j.verdict, reason_codes: j.reasonCodes, reasons_ja: [...extra, ...j.reasonsJa], equipment: e.saved } });
    }
  }
  if (!APPLY) { console.log(`（dry-run・書き込みなし・${updates.length} 行）`); return; }
  let ok = 0;
  for (const u of updates) {
    const { error: uErr } = await sb.from("property_pickups").update(u.patch).eq("id", u.id);
    if (uErr) console.log(`⚠ #${u.id} ${uErr.message}`); else ok++;
  }
  console.log(`✅ ${ok}/${updates.length} 行を付け直した`);
}
main().catch((e) => { console.error(e); process.exit(1); });
