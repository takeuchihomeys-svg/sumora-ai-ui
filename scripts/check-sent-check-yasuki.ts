// 実行: npx tsx --env-file=.env.local scripts/check-sent-check-yasuki.ts
// 2026-10-01 /api/automation/sent-check と同じ判定（filterOutAlreadySent・既定は建物ごと）を、yasuki さんの画面の3件に当てる（読むだけ）
import { createClient } from "@supabase/supabase-js";
import { filterOutAlreadySent, type SentProperty } from "../app/lib/sent-property-filter";

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data: c } = await sb.from("property_customers").select("id").like("id::text" as never, "458cbd41%").limit(1);
  let id = (c?.[0] as { id?: string } | undefined)?.id;
  if (!id) {
    const { data: all } = await sb.from("property_customers").select("id").limit(5000);
    id = ((all ?? []) as Array<{ id: string }>).find((x) => x.id.startsWith("458cbd41"))?.id;
  }
  if (!id) throw new Error("yasuki が見つからない");
  const { data } = await sb.from("sent_properties").select("property_name, room_no, property_url").eq("property_customer_id", id).limit(2000);
  const rows = [
    { propertyName: "水上ビル東館", roomNo: "655", url: "https://www.realnetpro.com/common/factsheet.php?id=1&org=1" },
    { propertyName: "ラパンジール道頓堀", roomNo: "106", url: "https://www.realnetpro.com/common/factsheet.php?id=2&org=1" },
    { propertyName: "ラパンジール今宮", roomNo: "803", url: "https://www.realnetpro.com/common/factsheet.php?id=3&org=1" },
  ];
  const r = filterOutAlreadySent(rows, (data ?? []) as SentProperty[], "building");
  console.log("送付記録", (data ?? []).length, "件");
  rows.forEach((p, i) => {
    const d = r.dropped.find((x) => x.index === i);
    console.log(p.propertyName, p.roomNo, "→", d ? "外す（" + d.reason + "）" : "送る");
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
