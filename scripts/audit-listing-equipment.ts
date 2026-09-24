// scripts/audit-listing-equipment.ts — 物件資料の文字層から読んだ「所在階・設備」の全件監査（DB は読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-listing-equipment.ts [--rows]
//   property_pickups の pdf_blob_url がある全行の PDF（1ページ目）の文字層に parseListingEquipment を当て、
//   キーごとの ok / ng / unlisted の件数と、ng になった行の根拠の文字を全部出す（誤って ng にした物が 0 か目で読む）。
//   所在階の出どころ（所在階・階部分・号室）と、号室から推した階が表の階と食い違う行も出す。
//   --rows: 行ごとの ok の一覧も出す
// 2026-09-24 初回: 36行（itandi 18・リアプロ 18）。結果と直した経緯は app/lib/listing-equipment.ts の頭のコメント
import { createClient } from "@supabase/supabase-js";
import { extractPdfText } from "../app/lib/pdf-text";
import { parseListingEquipment, mergeBuildingEquipment, EQUIP_KEYS, EQUIP_LABELS, type ListingEquipment } from "../app/lib/listing-equipment";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const showRows = process.argv.includes("--rows");

(async () => {
  const sb = createClient(url, key);
  const { data, error } = await sb.from("property_pickups").select("id, site, pdf_blob_url").not("pdf_blob_url", "is", null).order("id");
  if (error) { console.error(error.message); process.exit(1); }
  const rows: Array<{ id: number; site: string | null; facts: ListingEquipment }> = [];
  for (const r of data ?? []) {
    try {
      const res = await fetch(r.pdf_blob_url as string);
      const buf = new Uint8Array(await res.arrayBuffer());
      // 同じ Uint8Array を2回渡すと2回目が空になる（pdfjs が中身を移す）ので写しを渡す
      const t = await extractPdfText(buf.slice(), { maxPages: 1, maxChars: 20000 });
      rows.push({ id: r.id as number, site: r.site as string | null, facts: parseListingEquipment(t.text) });
    } catch (e) {
      console.log(`#${r.id} 取れない: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const merged = mergeBuildingEquipment(rows);
  console.log(`\n=== 対象 ${merged.length} 行（文字あり ${merged.filter((r) => r.facts.hasText).length}）`);

  console.log("\n■ 所在階の出どころ・食い違い");
  const src = new Map<string, number>();
  for (const r of merged) src.set(String(r.facts.floorSource), (src.get(String(r.facts.floorSource)) ?? 0) + 1);
  console.log("  ", [...src.entries()].map(([k, v]) => `${k}:${v}`).join(" / "));
  for (const r of merged) {
    const f = r.facts;
    if (f.roomFloor != null && f.floor != null && f.roomFloor !== f.floor) console.log(`  食い違い #${r.id} ${f.room}号室 → 号室から${f.roomFloor}階・表は${f.floor}階（${f.floorSource}）`);
    if (f.floor == null) console.log(`  階が取れない #${r.id} room=${f.room} basement=${f.basement}`);
  }

  console.log("\n■ キーごとの件数（ok / ng / unlisted・〔建〕＝同じ建物から補った数）");
  for (const k of EQUIP_KEYS) {
    const st = merged.map((r) => r.facts.items[k]);
    const ok = st.filter((x) => x.status === "ok").length, ng = st.filter((x) => x.status === "ng").length, un = st.filter((x) => x.status === "unlisted").length;
    const b = st.filter((x) => x.fromBuilding).length;
    console.log(`  ${EQUIP_LABELS[k].padEnd(12, "　")} ok ${String(ok).padStart(2)}  ng ${String(ng).padStart(2)}  unlisted ${String(un).padStart(2)}${b ? `  〔建〕${b}` : ""}`);
  }

  console.log("\n■ ng の根拠（全部）");
  for (const k of EQUIP_KEYS) {
    const ngs = merged.filter((r) => r.facts.items[k].status === "ng");
    if (!ngs.length) continue;
    console.log(`  [${EQUIP_LABELS[k]}]`);
    for (const r of ngs) console.log(`    #${r.id} ${r.site} ${r.facts.name ?? "?"} ${r.facts.room ?? ""} → 「${r.facts.items[k].evidence}」${r.facts.items[k].detail ? `（${r.facts.items[k].detail}）` : ""}`);
  }

  console.log("\n■ 手がかり（unlisted だが近い言葉）");
  for (const r of merged) for (const k of EQUIP_KEYS) if (r.facts.items[k].hint) console.log(`  #${r.id} ${EQUIP_LABELS[k]}: ${r.facts.items[k].hint}`);

  console.log("\n■ 同じ建物から補った物");
  for (const r of merged) for (const k of EQUIP_KEYS) if (r.facts.items[k].fromBuilding) console.log(`  #${r.id} ${EQUIP_LABELS[k]}: ${r.facts.items[k].evidence}`);

  if (showRows) {
    console.log("\n■ 行ごと");
    for (const r of merged) {
      const f = r.facts;
      console.log(`  #${r.id} ${r.site} ${f.name} ${f.room} ${f.floor}階(${f.floorSource})/${f.totalFloors}階建 構造=${f.structure} 向き=${f.direction}`);
      console.log(`     ok: ${EQUIP_KEYS.filter((k) => f.items[k].status === "ok").map((k) => `${EQUIP_LABELS[k]}「${f.items[k].evidence}」`).join(" ")}`);
    }
  }
})();
