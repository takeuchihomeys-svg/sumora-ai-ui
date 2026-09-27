// scripts/audit-pickup-deal-status.ts — ピックアップの資料の「現況/入居時期」に書かれた申込の状況（審査中・商談中）の今の扱いを数える（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-deal-status.ts
//
// 2026-09-27 竹内「申込以降のステータス審査中は審査中としておく」（app/lib/listing-deal-status.ts）:
//   ・資料の文字に審査中・商談中がある行の件数・判定（pass/hold/drop）・送ったか・terms.evidence.moveIn に残っているか
//   ・カードの「状態/入居」と畳んだ時の1行の前後（buildPickupCardView）
//   ・会話ごとにブレインへ渡す一段（buildScreeningRoomsBrainText・送った行だけ）
import { createClient } from "@supabase/supabase-js";
import { pickupDealStatus, listingDealStatus, buildScreeningRoomsBrainText } from "../app/lib/listing-deal-status";
import { buildPickupCardView } from "../app/lib/pickup-card-view";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  for (let f = 0; ; f += 500) {
    const { data, error } = await sb.from("property_pickups")
      .select("id,site,rank,property_name,room_no,summary_text,pdf_text,image_lines,verdict,score,ad_yen,recommended,reason_codes,reasons_ja,terms,location,equipment,status,created_at,conversation_id")
      .order("id").range(f, f + 499);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? [])); if ((data ?? []).length < 500) break;
  }
  const RAW_RE = /審査中|商談中/;
  const inText = rows.filter((r) => RAW_RE.test(String(r.pdf_text ?? "")));
  const noTerms = rows.filter((r) => !r.terms?.evidence?.moveIn);
  console.log(`行 ${rows.length}・資料の文字に審査中/商談中 ${inText.length}・terms.evidence.moveIn の無い行 ${noTerms.length}（最新 ${noTerms.map((r) => r.created_at).sort().pop() ?? "-"}）`);
  const tally: Record<string, number> = {};
  for (const r of inText) {
    const byEvidence = listingDealStatus({ evidenceMoveIn: r.terms?.evidence?.moveIn ?? null });
    const byAny = pickupDealStatus(r);
    const k = `${byAny ?? "読めない"}｜判定 ${r.verdict}｜${r.status}${byEvidence ? "" : "｜根拠の欄に無い（PDF の文字だけ）"}`;
    tally[k] = (tally[k] ?? 0) + 1;
    const before = buildPickupCardView({ ...r, terms: r.terms ? { ...r.terms, evidence: { ...r.terms.evidence, moveIn: undefined } } : null });
    const after = buildPickupCardView(r);
    const cell = (v: ReturnType<typeof buildPickupCardView>) => v.cells.find((c) => c.key === "state");
    console.log(`#${r.id} ${r.property_name} ${r.room_no ?? ""} [${r.verdict}/${r.status}] 資料「${r.terms?.evidence?.moveIn ?? "-"}」\n   状態: ${cell(before)?.value}／${cell(before)?.sub} → ${cell(after)?.value}／${cell(after)?.sub}\n   1行: ${before.headline?.text ?? "-"} → ${after.headline?.text ?? "-"}`);
  }
  console.log("\n内訳:", tally);
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) if (r.status === "sent" && r.conversation_id) { const a = byConv.get(r.conversation_id) ?? []; a.push(r); byConv.set(r.conversation_id, a); }
  console.log("\nブレインへの一段（送った行のある会話ごと）:");
  for (const [cid, rs] of byConv) {
    const t = buildScreeningRoomsBrainText(rs);
    if (t) console.log(`- ${cid.slice(0, 8)}:${t.replace(/\n/g, "\n    ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
