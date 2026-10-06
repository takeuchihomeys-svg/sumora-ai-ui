// scripts/audit-pickup-misattribution.ts — 売上サポの回（property_pickups）が別の検索の物件をお客様に付けていないかの点検（読むだけ）
// 2026-10-06 竹内「何でこれこんな物件でているのか 原因見つけて改善する 違うお客さんの物件がまぎれている」（あ・10/04 14:11 の回）
//   見るもの（回＝batch_id ごと）:
//   ① 遠い: 物件の場所の判定（location.area.result）が far の割合（お客様の希望の起点から遠い部屋ばかり）
//   ② 検索の点検（search_audits）: 回の送信の前 60分に、そのお客様の検索の記録があるか・別のお客様の検索だけか
//   ③ 条件に合わない: 回の中の間取り・家賃がお客様の条件と大きく違う割合（summary_text の家賃・間取り）
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-misattribution.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]);
const mask = (s: string | null) => { const t = String(s ?? ""); return t.length <= 1 ? "＊" : t[0] + "＊".repeat(Math.min(3, t.length - 1)); };
type P = { id: number; batch_id: string; property_customer_id: string | null; customer_name: string | null; site: string | null; property_name: string | null; room_no: string | null; created_at: string; location: { area?: { result?: string; km?: number } } | null; summary_text: string | null; status: string | null };
(async () => {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const rows: P[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("property_pickups").select("id, batch_id, property_customer_id, customer_name, site, property_name, room_no, created_at, location, summary_text, status").gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as P[]));
    if ((data ?? []).length < 1000) break;
  }
  const { data: audits } = await sb.from("search_audits").select("property_customer_id, site, created_at").gte("created_at", new Date(Date.parse(since) - 3600e3).toISOString()).limit(20000);
  const A = (audits ?? []) as Array<{ property_customer_id: string | null; site: string | null; created_at: string }>;
  const { data: pcs } = await sb.from("property_customers").select("id, rent_max, floor_plan");
  const pcMap = new Map(((pcs ?? []) as Array<{ id: string; rent_max: number | null; floor_plan: string | null }>).map((c) => [c.id, c]));
  const batches = new Map<string, P[]>();
  for (const r of rows) (batches.get(r.batch_id) ?? batches.set(r.batch_id, []).get(r.batch_id)!).push(r);
  const flagged: Array<{ batch: string; at: string; cust: string; n: number; far: number; overRent: number; auditOwn: boolean; auditOther: boolean; reasons: string[]; sample: string[] }> = [];
  for (const [b, list] of batches) {
    const cid = list[0].property_customer_id;
    if (!cid) continue;
    const at = Date.parse(list[0].created_at);
    const withLoc = list.filter((r) => r.location?.area?.result);
    const far = withLoc.filter((r) => r.location?.area?.result === "far").length;
    const c = pcMap.get(cid);
    const rents = list.map((r) => { const m = String(r.summary_text ?? "").match(/([\d,]{5,})円/); return m ? Number(m[1].replace(/,/g, "")) : null; });
    const overRent = c?.rent_max ? rents.filter((x) => x != null && (x as number) > (c.rent_max as number) * 1.15).length : 0;
    const win = A.filter((a) => { const t = Date.parse(a.created_at); return t <= at && at - t <= 60 * 60e3; });
    const auditOwn = win.some((a) => a.property_customer_id === cid);
    const auditOther = win.some((a) => a.property_customer_id && a.property_customer_id !== cid);
    const reasons: string[] = [];
    if (withLoc.length >= 3 && far / withLoc.length >= 0.5) reasons.push(`遠い ${far}/${withLoc.length}`);
    if (overRent >= Math.max(2, list.length / 2)) reasons.push(`家賃が上限の1.15倍超 ${overRent}/${list.length}`);
    if (!auditOwn && auditOther) reasons.push("前60分の検索は別のお客様だけ");
    if (reasons.length) flagged.push({ batch: b, at: list[0].created_at, cust: `${mask(list[0].customer_name)}（${cid.slice(0, 8)}）`, n: list.length, far, overRent, auditOwn, auditOther, reasons, sample: list.slice(0, 4).map((r) => `${r.property_name ?? ""} ${r.room_no ?? ""}`) });
  }
  console.log(`=== 売上サポの回の付け先の点検（${days}日・回 ${batches.size}・部屋 ${rows.length}）: 疑わしい回 ${flagged.length}`);
  for (const f of flagged.sort((a, b) => (a.at < b.at ? -1 : 1))) console.log(`- ${f.at.slice(0, 16)} ${f.cust} ${f.n}部屋 [${f.reasons.join("・")}] 例: ${f.sample.join(" / ")}  (${f.batch.slice(-24)})`);
})().catch((e) => { console.error(e); process.exit(1); });
