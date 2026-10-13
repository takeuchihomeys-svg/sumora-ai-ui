// 読むだけ（LLM なし）: 送った物件（sent_image_properties.facts）で場所が分からない（AREA_UNKNOWN）原因を型ごとに数える。
// 使い方: npx tsx --env-file=.env.local scripts/audit-area-unknown.ts [--days=90]
import { createClient } from "@supabase/supabase-js";
import { parseAreaWant, buildPropertyLocation, matchArea, matchAnchors } from "../app/lib/area-want";
import { stationsInText } from "../app/lib/osaka-geo";
import { normalizeBuildingName } from "../app/lib/property-brain";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 90);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function all<T>(q: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await q(f); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
  return out;
}
(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const imgs = await all<any>((f) => sb.from("sent_image_properties").select("conversation_id,property_name,facts,created_at").gte("created_at", since).not("facts", "is", null).range(f, f + 999));
  const sp = await all<any>((f) => sb.from("sent_properties").select("conversation_id,property_customer_id,sent_at").not("property_customer_id", "is", null).gte("sent_at", new Date(Date.now() - 200 * 864e5).toISOString()).range(f, f + 999));
  const conv2pc = new Map<string, string>(); for (const r of sp) conv2pc.set(r.conversation_id, r.property_customer_id);
  const ids = [...new Set(conv2pc.values())];
  const pcs = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) { const { data } = await sb.from("property_customers").select("id,desired_area,preferences,other_requests").in("id", ids.slice(i, i + 200)); for (const p of data ?? []) pcs.set(p.id, p); }
  const types: Record<string, number> = {}, unknownNames: Record<string, number> = {};
  const seen = new Set<string>();
  let n = 0;
  const unreadRows: Array<{ conv: string; name: string }> = [];
  for (const r of imgs) {
    const f = r.facts; if (!f || typeof f !== "object" || /申込/.test(String(f.status ?? ""))) continue;
    const pc = pcs.get(conv2pc.get(r.conversation_id) ?? ""); if (!pc) continue;
    const key = `${r.conversation_id}|${r.property_name ?? ""}|${f.room_no ?? ""}`; if (seen.has(key)) continue; seen.add(key);
    const sts: any[] = Array.isArray(f.stations) ? f.stations : [];
    const summary = "x\n" + sts.filter((s) => s?.station).map((s) => `${s.line ?? ""}「${String(s.station).replace(/駅$/, "")}」徒歩${s.walk ?? ""}分`).join("\n");
    const loc = buildPropertyLocation(summary, null);
    const want = parseAreaWant(pc.desired_area, [pc.preferences, pc.other_requests].filter(Boolean).join("\n"));
    if (!want.any) continue;
    const am = matchAnchors(want, loc) ?? matchArea(want, loc);
    if (am?.code !== "AREA_UNKNOWN") continue;
    n++;
    let t: string;
    if (!sts.length) {
      t = f.station ? "駅の配列が空（最寄りの1つだけ）" : "資料から駅を読めていない";
      unreadRows.push({ conv: r.conversation_id, name: String(r.property_name ?? "") });
    }
    else if (!loc.stations.length) t = "駅名はあるが交通の行として読めない";
    else if (loc.stations.every((s) => !s.known)) {
      t = "駅の表に無い駅名";
      for (const s of loc.stations) {
        const alt = stationsInText(s.station)[0]?.station;
        unknownNames[`${s.station}${alt ? `→${alt}` : ""}`] = (unknownNames[`${s.station}${alt ? `→${alt}` : ""}`] ?? 0) + 1;
      }
    } else if (loc.stations.every((s) => s.walk != null && s.walk > 15)) t = "徒歩15分超の駅だけ（距離で見る位置が無い）";
    else t = "その他（位置はあるが照合できない）";
    types[t] = (types[t] ?? 0) + 1;
  }
  // 読めていない物のうち、同じ会話の売上サポの行（property_pickups.location＝検索の資料の交通）で場所が埋まる数（案: 画像の読み取りの予備）
  let fillable = 0, noName = 0;
  const convsU = [...new Set(unreadRows.map((u) => u.conv))];
  const pk: any[] = [];
  for (let i = 0; i < convsU.length; i += 100) pk.push(...(await all<any>((f) => sb.from("property_pickups").select("conversation_id,property_name,location").in("conversation_id", convsU.slice(i, i + 100)).not("location", "is", null).range(f, f + 999))));
  const bk = (s: string) => normalizeBuildingName(String(s).replace(/\s*\d{2,4}\s*号?室?$/, "")).slice(0, 10);
  for (const u of unreadRows) {
    if (!u.name.trim()) { noName++; continue; }
    if (pk.some((p) => p.conversation_id === u.conv && bk(p.property_name ?? "") === bk(u.name) && (p.location?.station || p.location?.stations?.length || p.location?.ward))) fillable++;
  }
  console.log(JSON.stringify({ unreadNoStations: unreadRows.length, fillableFromPickupLocation: fillable, noPropertyName: noName }));
  console.log(JSON.stringify({ days: DAYS, unknown: n, types, unknownStationNames: Object.entries(unknownNames).sort((a, b) => b[1] - a[1]).slice(0, 60) }, null, 1));
})();
