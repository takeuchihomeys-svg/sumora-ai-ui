// 「確認した」系（入居可能日・ペット・駐車場）の資料の読みの監査（読み取りのみ）
// 2026-09-30 竹内「物件資料に記載があればそこで答えて大丈夫・分からなかったら AIX【確認した】」
//   売上サポの行（property_pickups.image_lines・直近 N 日）に routeConfirmTopic を当て、資料で答える（material）／確認（confirm）の件数と、
//   値の種類ごとの実物を並べて目で読む（material に倒した値に「相談・未定・空き確認」が混ざっていないか）
// 実行: npx tsx --env-file=.env.local scripts/audit-confirm-topic-material.ts [DAYS=14]
import { createClient } from "@supabase/supabase-js";
import { routeConfirmTopic, type ConfirmTopic } from "../app/lib/procedure-question";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const since = new Date(Date.now() - Number(process.env.DAYS ?? 14) * 86400_000).toISOString();
  const rows: Array<{ property_name: string | null; room_no: string | null; image_lines: string[] | null }> = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("property_pickups").select("property_name, room_no, image_lines").gte("created_at", since).not("image_lines", "is", null).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    rows.push(...((data ?? []) as typeof rows)); if ((data ?? []).length < 1000) break;
  }
  console.log(`行 ${rows.length}`);
  for (const topic of ["move_in", "pet", "parking"] as ConfirmTopic[]) {
    const by = new Map<string, { n: number; ex: string }>();
    let mat = 0, conf = 0;
    for (const r of rows) {
      const v = routeConfirmTopic(topic, r.image_lines ?? []);
      if (v.route === "material") mat++; else conf++;
      const key = `${v.route}｜${v.why}｜${v.lines.join("／").replace(/[0-9０-９]+/g, "N").slice(0, 70)}`;
      const e = by.get(key) ?? { n: 0, ex: `${r.property_name} ${r.room_no ?? ""}: ${v.lines.join("／")}` }; e.n++; by.set(key, e);
    }
    console.log(`\n■ ${topic}: 資料で答える ${mat}・確認 ${conf}`);
    for (const [k, e] of [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 45)) console.log(`  ${String(e.n).padStart(4)} ${k.split("｜").slice(0, 2).join("｜")}  例: ${e.ex.slice(0, 110)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
