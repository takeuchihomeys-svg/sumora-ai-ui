// scripts/fix-property-names-stored.ts — 保存済みの「読み取りの物件名」（照合できなかった source=vision）の化けを数え、直す（既定は数えるだけ・LLM なし・$0）
//
// 2026-10-14 竹内さん「物件名の化け（梅出・戸原橋・令福・速里）を正しい地名に直す（候補が1つの時だけ）」。直しの決まりは app/lib/property-name-fix.ts。
//   対象: sent_image_properties.property_name（source=vision・2026-10-15 から既定で backfill も＝--sources=vision で戻す）／sent_properties.property_name（source=vision）／sent_image_properties.facts.station（確かな直しだけ）
//   スタッフが送った記録（aix_usage_logs.property_names）・照合済みの行は触らない（送った事実の記録）。source は vision のまま（会話の物件には寄っていない印）
// 実行: npx tsx --env-file=.env.local scripts/fix-property-names-stored.ts [--show=30] [--apply]
//   --apply は親（承認の後）が流す
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=30").split("=")[1]);
// 2026-10-15 竹内さん「入れる」: 古い取り込みの資料の読み（sent_image_properties の source=backfill）も直しの対象に入れる（既定）。
//   戻す: --sources=vision（旧の対象＝読み取りの行だけ）。sent_properties は従来どおり vision だけ
const SIP_SOURCES = new Set((process.argv.find((a) => a.startsWith("--sources=")) ?? "--sources=vision,backfill").split("=")[1].split(",").map((x) => x.trim()).filter(Boolean));

async function all<T>(t: string, cols: string, f?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { let q = sb.from(t).select(cols).range(i, i + 999); if (f) q = f(q); const { data, error } = await q; if (error) throw new Error(`${t}: ${error.message}`); out.push(...((data ?? []) as T[])); if (!data || data.length < 1000) break; }
  return out;
}
async function main() {
  const fix = await import("../app/lib/property-name-fix");
  type Src = import("../app/lib/property-name-fix").LedgerSource;
  const rows: Array<{ name: string | null; source: Src }> = [];
  for (const r of await all<{ property_name: string | null }>("property_pickups", "property_name")) rows.push({ name: r.property_name, source: "text" });
  for (const r of await all<{ property_names: string[] | null; line_message_id: string | null }>("aix_usage_logs", "property_names, line_message_id", (q) => q.not("property_names", "is", null))) { if (String(r.line_message_id ?? "").startsWith("bexam")) continue; for (const n of r.property_names ?? []) rows.push({ name: n, source: "staff" }); }
  const sp = await all<{ id: string; property_name: string | null; source: string | null }>("sent_properties", "id, property_name, source");
  for (const r of sp) rows.push({ name: r.property_name, source: r.source === "vision" ? "read" : "shared" });
  const ledger = fix.buildLedger(rows);
  const sip = await all<{ image_url: string; property_name: string | null; source: string | null; facts: Record<string, unknown> | null }>("sent_image_properties", "image_url, property_name, source, facts");

  const memo = new Map<string, ReturnType<typeof fix.fixReadPropertyName>>();
  const fixOf = (n: string) => { if (!memo.has(n)) memo.set(n, fix.fixReadPropertyName(n, ledger, {})); return memo.get(n)!; };
  const examples = new Map<string, string>();
  let nSip = 0, nSp = 0, nStation = 0, wrote = 0;
  const nSipBy = new Map<string, number>();
  for (const r of sip) {
    const patch: Record<string, unknown> = {};
    if (SIP_SOURCES.has(r.source ?? "") && r.property_name) {
      const f = fixOf(r.property_name);
      if (f.status === "fixed" && f.name !== r.property_name) { patch.property_name = f.name; nSip++; nSipBy.set(r.source ?? "", (nSipBy.get(r.source ?? "") ?? 0) + 1); examples.set(r.property_name, `${f.name} [${f.rule}]${r.source === "backfill" ? " (backfill)" : ""}`); }
    }
    const st = SIP_SOURCES.has(r.source ?? "") && typeof r.facts?.station === "string" ? r.facts.station as string : null;
    if (st) {
      const fs = fix.fixReadStationName(st, {});
      if (fs && fs !== st) {
        const stations = Array.isArray(r.facts?.stations) ? (r.facts!.stations as Array<Record<string, unknown>>).map((x) => (x.station === st ? { ...x, station: fs } : x)) : r.facts?.stations;
        patch.facts = { ...r.facts, station: fs, ...(stations ? { stations } : {}) }; nStation++; examples.set(`駅 ${st}`, fs);
      }
    }
    if (APPLY && Object.keys(patch).length) { const { error } = await sb.from("sent_image_properties").update(patch).eq("image_url", r.image_url); if (error) console.log("  ✗", error.message); else wrote++; }
  }
  for (const r of sp) {
    if (r.source !== "vision" || !r.property_name) continue;
    const f = fixOf(r.property_name);
    if (f.status !== "fixed" || f.name === r.property_name) continue;
    nSp++; examples.set(r.property_name, `${f.name} [${f.rule}]`);
    if (APPLY) { const { error } = await sb.from("sent_properties").update({ property_name: f.name }).eq("id", r.id); if (error) console.log("  ✗", error.message); else wrote++; }
  }
  const visionNames = new Set([...sip.filter((r) => SIP_SOURCES.has(r.source ?? "")), ...sp.filter((r) => r.source === "vision")].map((r) => r.property_name ?? "").filter(Boolean));
  const st = { known: 0, fixed: 0, uncertain: 0, unchanged: 0 };
  for (const n of visionNames) st[fixOf(n).status]++;
  console.log(`対象の source: ${[...SIP_SOURCES].join(",")}（sent_image_properties: ${[...SIP_SOURCES].map((x) => `${x} ${sip.filter((r) => r.source === x).length}行`).join("・")}）`);
  console.log(`読み取りの名前 ${visionNames.size}種類: 帳簿にある ${st.known}・直す ${st.fixed}・確かではない ${st.uncertain}・そのまま ${st.unchanged}`);
  console.log(`直す行: sent_image_properties ${nSip}（${[...nSipBy].map(([k, n]) => `${k} ${n}`).join("・")}）・sent_properties ${nSp}・駅（facts.station）${nStation}${APPLY ? `・書いた ${wrote}` : "（数えただけ・--apply で書く）"}`);
  for (const [a, b] of [...examples].slice(0, SHOW)) console.log(`   ${a} → ${b}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
