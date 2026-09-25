// scripts/audit-structure-wants.ts
// 構造・物件種別・エレベーターの読み（2026-09-25 竹内「構造も指定あればちゃんと見る」「エレベーターなしを○と読む誤り」）の全件監査。読むだけ（DB に書かない・LLM を呼ばない）。
//   ① 全お客様の条件欄（preferences・ng_points・other_requests・additional_conditions・structure_types）→ 構造・種別の希望を今のコードで読み、
//      構造・種別の言葉がある節と並べて出す（目で読む用）。--old=<旧 listing-equipment.ts のパス> があれば、設備の希望全体の読みが変わったお客様を差分で出す
//   ② 本番の property_pickups の文字層（無ければ Blob の PDF から取る）→ 構造・段・物件種別・エレベーターの読みと根拠の行
//   npx tsx --env-file=.env.local scripts/audit-structure-wants.ts [--old=path]
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "url";
import { extractPdfText } from "../app/lib/pdf-text";
import { parseEquipmentWants, parseListingEquipment, wantLabel, STRUCTURE_TIER_NAMES } from "../app/lib/listing-equipment";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const oldPath = process.argv.find((a) => a.startsWith("--old="))?.slice(6) ?? null;
type Row = Record<string, any>;
const RE = /木造|鉄骨|鉄筋|(?<![A-Za-z])S?RC(?![A-Za-z])|ＲＣ|構造|マンション|アパート|コンクリ/;
const FIELDS = ["preferences", "ng_points", "other_requests", "additional_conditions", "structure_types"];

async function main() {
  const old = oldPath ? await import(pathToFileURL(oldPath).href) as { parseEquipmentWants: typeof parseEquipmentWants; wantLabel: typeof wantLabel } : null;
  const all: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("property_customers").select(`id, pet, ${FIELDS.join(", ")}`).range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`■ ① 条件欄 お客様 ${all.length}人`);
  let places = 0, withWant = 0, changed = 0;
  const table: string[] = [];
  for (const c of all) {
    const hits: string[] = [];
    for (const f of FIELDS) for (const seg of String(c[f] ?? "").split(/[\n、。,，/]/)) if (RE.test(seg)) hits.push(`${f}「${seg.trim().slice(0, 60)}」`);
    const w = parseEquipmentWants(c);
    const sw = w.wants.filter((x) => x.key === "structure" || x.key === "bldg_type");
    if (hits.length) places += hits.length;
    if (sw.length) withWant++;
    if (hits.length || sw.length) table.push(`${String(c.id).slice(0, 8)} | ${hits.join(" ／ ") || "（言葉なし）"} → ${sw.map((x) => `${wantLabel(x)}${x.key === "structure" ? `[${STRUCTURE_TIER_NAMES[x.structureMin ?? 0]}〜]` : ""}`).join("・") || "希望なし"}`);
    if (old) {
      const a = old.parseEquipmentWants(c).wants.map((x) => `${x.key}:${x.mode}${x.strong ? "!" : ""}${x.soft ? "~" : ""}`).sort().join(",");
      const b = w.wants.map((x) => `${x.key}:${x.mode}${x.strong ? "!" : ""}${x.soft ? "~" : ""}`).sort().join(",");
      if (a !== b) { changed++; console.log(`  差分 ${String(c.id).slice(0, 8)}: 旧 [${a}] → 新 [${b}]`); }
    }
  }
  console.log(table.join("\n"));
  console.log(`  構造・種別の言葉のある節 ${places}か所・希望になったお客様 ${withWant}人${old ? `・設備の希望全体が変わったお客様 ${changed}人` : ""}`);

  console.log("\n■ ② property_pickups の文字層");
  const { data, error } = await sb.from("property_pickups").select("id, site, pdf_text, pdf_blob_url").order("id");
  if (error) throw new Error(error.message);
  const tiers: Record<string, number> = {};
  for (const r of (data ?? []) as Row[]) {
    let text = String(r.pdf_text ?? "");
    let src = "pdf_text";
    if (!text && r.pdf_blob_url) {
      try { const res = await fetch(r.pdf_blob_url); if (res.ok) { text = (await extractPdfText(Buffer.from(await res.arrayBuffer()).toString("base64"), { maxPages: 2, maxChars: 8000 })).text; src = "blob"; } } catch { /* 読めない */ }
    }
    if (!text) { console.log(`  id ${r.id} ${r.site} 文字なし`); continue; }
    const f = parseListingEquipment(text);
    const lines = text.normalize("NFKC").split("\n");
    const ev = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => l.replace(/\s+/g, " ").trim().slice(0, 70)).slice(0, 2).join(" | ") || "－";
    const tier = f.structureTier != null ? STRUCTURE_TIER_NAMES[f.structureTier] : "－";
    tiers[tier] = (tiers[tier] ?? 0) + 1;
    console.log(`  id ${r.id} ${r.site}(${src}) 構造「${f.structure ?? "－"}」→ ${tier}・種別 ${f.buildingType ?? "－"}・EV ${f.items.elevator.status}(${f.items.elevator.evidence ?? ""})\n      資料: ${ev(/構造/)} ／ ${ev(/物件種目|物件種別/)} ／ ${ev(/エレベ|(?<![A-Za-z])EV/)}`);
  }
  console.log(`  段の内訳: ${JSON.stringify(tiers)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
