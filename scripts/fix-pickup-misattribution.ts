// scripts/fix-pickup-misattribution.ts — 別の検索の物件が付いた売上サポの回（property_pickups）に印を付ける（既定は数えるだけ・書かない）
// 2026-10-06 竹内「違うお客さんの物件がまぎれている」（あ・10/04 14:11 の回 物件まとめ_2026-10-4_1791090665735.pdf）
//   付け直す先のお客様が分からない（その一覧は誰の条件の検索でもない・元付アズ・スタットの1K）ので、行は消さず
//   status="misattributed" にして、AIXツールの「まだ見ていない・通す」の一覧（status=pending だけを見る）から外す案。
//   ⚠ コーディネーター・竹内さんの確認の後でだけ --apply を付ける
// 実行: npx tsx --env-file=.env.local scripts/fix-pickup-misattribution.ts --batch=1791090665735            … 数えるだけ
//       npx tsx --env-file=.env.local scripts/fix-pickup-misattribution.ts --batch=1791090665735 --apply    … 書く
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const batch = (process.argv.find((a) => a.startsWith("--batch=")) ?? "").split("=")[1] ?? "";
const apply = process.argv.includes("--apply");
(async () => {
  if (!/^\d{10,}$/.test(batch)) { console.error("--batch=<回の番号（物件まとめ_…_の後ろの数字）> が必要"); process.exit(1); }
  const { data, error } = await sb.from("property_pickups").select("id, batch_id, property_customer_id, customer_name, property_name, room_no, status, sent_at").ilike("batch_id", `%${batch}%`);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: number; batch_id: string; property_customer_id: string; customer_name: string; property_name: string; room_no: string; status: string | null; sent_at: string | null }>;
  console.log(`=== 回 ${batch}: ${rows.length}行（${apply ? "書く" : "数えるだけ"}）`);
  for (const r of rows) console.log(`  #${r.id} ${r.property_name} ${r.room_no}  status=${r.status ?? "-"}${r.sent_at ? "・お客様に送付済み " + r.sent_at.slice(0, 16) : ""} → misattributed`);
  if (rows.some((r) => r.sent_at)) console.log("  ⚠ お客様に送った行があります（送った記録は残し、印だけ付けます）");
  if (!apply) return;
  const { error: e2 } = await sb.from("property_pickups").update({ status: "misattributed" }).in("id", rows.map((r) => r.id));
  if (e2) throw new Error(e2.message);
  console.log(`  ${rows.length}行に印を付けました`);
})().catch((e) => { console.error(e); process.exit(1); });
