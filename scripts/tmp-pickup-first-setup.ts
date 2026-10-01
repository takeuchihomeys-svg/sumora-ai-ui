// tmp(コミットしない): YUMA の送った行 2675/2676/2678 の sent_at を今に・AIX の記録（property_send・first_pickup_id）を1行入れる／--restore で戻す
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync } from "node:fs";
import { sortForReview } from "../app/lib/pickup-review-order";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const Y = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const IDS = [2675, 2676, 2678];
const SNAP = "C:/Users/竹内悠~1/AppData/Local/Temp/claude/c--Users-------sumora-ai-ui/90d5437f-9ec8-479d-94e9-1097dde86432/scratchpad/rcv2/pickup-snap.json";
async function main() {
  if (process.argv.includes("--restore")) {
    const snap = JSON.parse(readFileSync(SNAP, "utf8")) as { rows: Array<{ id: number; sent_at: string | null }>; logId: string | null };
    for (const r of snap.rows) await sb.from("property_pickups").update({ sent_at: r.sent_at }).eq("id", r.id);
    if (snap.logId) await sb.from("aix_usage_logs").delete().eq("id", snap.logId);
    console.log("restored", snap);
    return;
  }
  const first = Number(process.argv.find((a) => a.startsWith("--first="))?.slice(8) ?? "0") || null;
  const { data } = await sb.from("property_pickups").select("id, rank, recommended, score, verdict, reason_codes, created_at, image_analysis, property_name, room_no, sent_at").in("id", IDS);
  const rows = (data ?? []) as any[];
  console.log("sortForReview:", sortForReview(rows).map((r) => `${r.id} ${r.property_name} ${r.room_no} score=${r.score} rank=${r.rank}`));
  const now = new Date().toISOString();
  let logId: string | null = null;
  if (first) {
    const { data: ins, error } = await sb.from("aix_usage_logs").insert({ conversation_id: Y, aix_type: "property_send", sent_at: now, picker_choices: { first_pickup_id: first, image_count: 3 }, generated_text: "tmp test (closing v2)" }).select("id").single();
    if (error) throw error;
    logId = (ins as { id: string }).id;
  }
  writeFileSync(SNAP, JSON.stringify({ rows: rows.map((r) => ({ id: r.id, sent_at: r.sent_at })), logId }));
  for (const id of IDS) await sb.from("property_pickups").update({ sent_at: now }).eq("id", id);
  console.log("set", { now, first, logId });
}
main().catch((e) => { console.error(e); process.exit(1); });
