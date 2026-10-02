// scripts/apply-mynumber-mask-template-20261002.ts — 2026-10-02 夜 竹内さん「それで」（提案 562287ff の承認）:
//   ②申込時フォーマット（続き）の2行（4b712d16・696d0402）の「…裏表の写真をお送りください！！」の次に
//   「※マイナンバーカードの場合は番号部分をマスキングいただけますと幸いです😌！！」を足し、提案を承認・反映済みにする。元の値は backup の JSON
// 実行: npx tsx --env-file=.env.local scripts/apply-mynumber-mask-template-20261002.ts [--dry]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DRY = process.argv.includes("--dry");
const IDS = ["4b712d16-ad36-4ce5-9e75-4c359f01b695", "696d0402-012b-4488-9385-30f660f466c1"];
const LINE = "※マイナンバーカードの場合は番号部分をマスキングいただけますと幸いです😌！！";
(async () => {
  const st = await sb.from("aix_feature_suggestions").select("status").limit(1000);
  const counts: Record<string, number> = {}; for (const r of st.data ?? []) counts[String(r.status)] = (counts[String(r.status)] ?? 0) + 1;
  console.log("提案の status の使われ方", JSON.stringify(counts));
  const { data } = await sb.from("templates").select("id, text").in("id", IDS);
  writeFileSync("scripts/backup-templates-mynumber-mask-20261002.json", JSON.stringify(data, null, 1));
  for (const r of data ?? []) {
    const cur = String(r.text);
    if (cur.includes("マスキング")) { console.log(r.id, "既に入っている"); continue; }
    const next = cur.replace("の裏表の写真をお送りください！！", `の裏表の写真をお送りください！！\n${LINE}`);
    if (next === cur) { console.log(r.id, "入れる場所が見つからない（触らない）"); continue; }
    console.log(r.id, "→\n" + next);
    if (!DRY) { const u = await sb.from("templates").update({ text: next }).eq("id", r.id); console.log("  ", u.error?.message ?? "足した"); }
  }
  if (!DRY) {
    // 承認済みの提案は status=implemented（既にある値・2件）。元の implementation_notes は残して反映の記録を足す
    const { data: sg } = await sb.from("aix_feature_suggestions").select("implementation_notes").eq("id", "562287ff-f720-4b8c-a5fd-c1d2e34233b8").maybeSingle();
    let notes: Record<string, unknown> = {}; try { notes = JSON.parse(String(sg?.implementation_notes ?? "{}")); } catch { notes = { before: sg?.implementation_notes }; }
    const u = await sb.from("aix_feature_suggestions").update({ status: "implemented", implementation_notes: JSON.stringify({ ...notes, implemented_at: new Date().toISOString(), approved_by: "竹内さん 10/02「それで」", templates: IDS }) }).eq("id", "562287ff-f720-4b8c-a5fd-c1d2e34233b8");
    console.log("提案 562287ff:", u.error?.message ?? "implemented にした");
  }
})();
