// 売上サポから AIX で送った回（2件以上）: 送った画像の1枚目（rank 順）・sortForReview の先頭・👑（まとめの best_id）が一致するか（読むだけ）
import { createClient } from "@supabase/supabase-js";
import { sortForReview } from "../app/lib/pickup-review-order";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const { data, error } = await sb.from("property_pickups").select("id, batch_id, rank, recommended, score, verdict, reason_codes, image_analysis, created_at, sent_at, sent_by, conversation_id, property_name, room_no, complete_group_id").not("sent_at", "is", null).order("sent_at").limit(5000);
  if (error) throw error;
  const rows = (data ?? []) as any[];
  const groups = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.conversation_id}|${r.sent_at}`; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const gids = [...new Set(rows.map((r) => r.complete_group_id).filter(Boolean))];
  const best = new Map<string, number>();
  for (let i = 0; i < gids.length; i += 200) { const { data: c } = await sb.from("property_pickup_completions").select("group_id, best_id").in("group_id", gids.slice(i, i + 200)); for (const x of c ?? []) if (x.best_id) best.set(x.group_id, x.best_id); }
  let n = 0, rankEqReview = 0, withBest = 0, bestIsRankFirst = 0, bestIsReviewFirst = 0, test = 0;
  for (const [k, g] of groups) {
    if (g.length < 2) continue;
    n++; if (isTestConversation(g[0].conversation_id)) test++;
    const rankFirst = [...g].sort((a, z) => a.rank - z.rank || a.id - z.id)[0];
    const rev = sortForReview(g)[0];
    if (rankFirst.id === rev.id) rankEqReview++;
    const b = g.map((r) => r.complete_group_id && best.get(r.complete_group_id)).find((x) => x && g.some((r) => r.id === x));
    if (b) { withBest++; if (b === rankFirst.id) bestIsRankFirst++; if (b === rev.id) bestIsReviewFirst++; }
    console.log(k.slice(0, 8), k.split("|")[1].slice(0, 16), `n=${g.length}`, `rank1=${rankFirst.property_name} ${rankFirst.room_no}`, `review1=${rev.property_name} ${rev.room_no}`, b ? `👑=${g.find((r) => r.id === b)?.property_name}` : "👑なし", isTestConversation(g[0].conversation_id) ? "[YUMA]" : "");
  }
  console.log({ groups: n, test, rankEqReview, withBest, bestIsRankFirst, bestIsReviewFirst });
}
main();
