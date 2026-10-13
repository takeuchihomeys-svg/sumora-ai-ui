// 読むだけ（LLM なし）: 竹内さん＋スタッフが「条件の外に広げて提案した物件」と、その後のお客様の反応（刺さった）を、広げ方×お客様の型で数える。
//   2026-10-13 竹内「広げて検索の部分ではなくて、お客さんに広げて提案できるところの範囲」
//   送った物件 = sent_image_properties.facts（画像の読み取り）。お客様の条件 = property_customers（今の行）。
//   刺さった = その物件（建物）について ①🌟の物件オススメを送った（outcome_events recommendation）②お客様の反応 interested（sent_properties）
//             ③内覧（viewing_history）④申込・成約（deal_outcomes・outcome_events applied/won）のどれか。
//   型 = エリアの強さ（requirement_strength.area）・ブレインの今の状態（customer_mindset.state）・決め手の残り（decideGap.point）
// 使い方: npx tsx --env-file=.env.local scripts/audit-proposal-range.ts [--days=120] [--json=out.json]
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseAreaWant, buildPropertyLocation, matchArea, matchAnchors } from "../app/lib/area-want";
import { normalizeFloorPlanWant, matchFloorPlan, isTooSmallPlan, isWideFloorPlan, isSameClassPlan, isLargerPlan, normalizeBuildingName, isFewerRoomWideLdk } from "../app/lib/property-brain";
import { decideProposalRange, proposalRangeCodes, wideSqmMargin } from "../app/lib/proposal-range";
import { proposalMaterialsOf } from "../app/lib/proposal-range-server";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const DAYS = Number(arg("days") ?? 120);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function all<T>(q: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) { const { data, error } = await q(f); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
  return out;
}
const bk = (n: string | null | undefined) => normalizeBuildingName(String(n ?? "").replace(/\s*\d{2,4}\s*号?室?$/, "")).slice(0, 14);
type Cell = { n: number; hit: number; star: number; viewed: number; applied: number };
const cell = (): Cell => ({ n: 0, hit: 0, star: 0, viewed: 0, applied: 0 });
const add = (m: Record<string, Cell>, k: string, o: { star: boolean; viewed: boolean; applied: boolean; interested: boolean }) => {
  const c = (m[k] ??= cell()); c.n++; if (o.star || o.viewed || o.applied || o.interested) c.hit++; if (o.star) c.star++; if (o.viewed) c.viewed++; if (o.applied) c.applied++;
};

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const imgs = await all<any>((f) => sb.from("sent_image_properties").select("conversation_id,property_name,facts,created_at").gte("created_at", since).not("facts", "is", null).range(f, f + 999));
  const sp = await all<any>((f) => sb.from("sent_properties").select("conversation_id,property_customer_id,property_name,customer_reaction,sent_at").not("property_customer_id", "is", null).gte("sent_at", new Date(Date.now() - (DAYS + 80) * 864e5).toISOString()).range(f, f + 999));
  const conv2pc = new Map<string, string>();
  const interested = new Set<string>();
  for (const r of sp.sort((a, b) => a.sent_at.localeCompare(b.sent_at))) {
    conv2pc.set(r.conversation_id, r.property_customer_id);
    if (r.customer_reaction === "interested") interested.add(`${r.conversation_id}|${bk(r.property_name)}`);
  }
  const ev = await all<any>((f) => sb.from("outcome_events").select("conversation_id,kind,property_name").in("kind", ["recommendation", "applied", "won", "viewing_scheduled", "viewing_held"]).range(f, f + 999));
  const star = new Set<string>(), applied = new Set<string>(), viewed = new Set<string>();
  for (const e of ev) {
    const k = `${e.conversation_id}|${bk(e.property_name)}`;
    if (e.kind === "recommendation") star.add(k); else if (e.kind === "applied" || e.kind === "won") applied.add(k); else viewed.add(k);
  }
  const vh = await all<any>((f) => sb.from("viewing_history").select("conversation_id,property_name").not("property_name", "is", null).range(f, f + 999));
  for (const v of vh) viewed.add(`${v.conversation_id}|${bk(v.property_name)}`);
  const dOut = await all<any>((f) => sb.from("deal_outcomes").select("conversation_id,property_name,applied_at,won_at").not("property_name", "is", null).range(f, f + 999));
  for (const d of dOut) if (d.applied_at || d.won_at) applied.add(`${d.conversation_id}|${bk(d.property_name)}`);

  const ids = [...new Set(conv2pc.values())];
  const pcs = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("property_customers").select("id,desired_area,area_mode,preferences,other_requests,requirement_strength,floor_plan,floor_area_min").in("id", ids.slice(i, i + 200));
    for (const p of data ?? []) pcs.set(p.id, p);
  }
  const convIds = [...conv2pc.keys()];
  const meta = new Map<string, any>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id,suggested_aix_meta").in("id", convIds.slice(i, i + 200));
    for (const c of data ?? []) meta.set(c.id, c.suggested_aix_meta ?? null);
  }
  const byArea: Record<string, Cell> = {}, byAreaType: Record<string, Cell> = {}, bySqm: Record<string, Cell> = {}, byPlan: Record<string, Cell> = {}, byPlanPair: Record<string, Cell> = {};
  const byAreaKm: Record<string, Cell> = {};
  const custOut = new Map<string, { far: number; farHit: number }>();
  const hist = new Map<string, { sent: number; hit: number }>();
  const byPrev: Record<string, Cell> = {};
  const ldkList: string[] = [];
  const byLevel: Record<string, Cell> = {}, byProposal: Record<string, Cell> = {}, sqmJudge: Record<string, Cell> = {}, planJudge: Record<string, Cell> = {};
  imgs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const seen = new Set<string>();
  for (const r of imgs) {
    const f = r.facts; if (!f || typeof f !== "object") continue;
    if (/申込/.test(String(f.status ?? ""))) continue;
    const pcId = conv2pc.get(r.conversation_id); if (!pcId) continue;
    const pc = pcs.get(pcId); if (!pc) continue;
    const key = `${r.conversation_id}|${bk(r.property_name)}`; if (seen.has(key)) continue; seen.add(key);
    const o = { star: star.has(key), viewed: viewed.has(key), applied: applied.has(key), interested: interested.has(key) };
    const m = meta.get(r.conversation_id) ?? {};
    let rs: any = pc.requirement_strength; if (typeof rs === "string") { try { rs = JSON.parse(rs); } catch { rs = null; } }
    const type = `area:${rs?.area?.strength ?? "-"}`;
    // このお客様の提案してよい範囲（ブレインの今の判断・要望の強さ。決め手の条件は読まない＝近似）
    const range = decideProposalRange(proposalMaterialsOf(m, rs, null), {});
    add(byLevel, range.level, o);
    // エリア
    const sts: any[] = Array.isArray(f.stations) ? f.stations : [];
    const summary = "x\n" + sts.filter((s) => s?.station).map((s) => `${s.line ?? ""}「${String(s.station).replace(/駅$/, "")}」徒歩${s.walk ?? ""}分`).join("\n");
    const loc = buildPropertyLocation(summary, null);
    const want = parseAreaWant(pc.desired_area, [pc.preferences, pc.other_requests].filter(Boolean).join("\n"));
    if (want.any) {
      const am = matchAnchors(want, loc) ?? matchArea(want, loc);
      const code = (am?.code ?? "NONE").replace(/^AREA_/, "");
      if (code !== "UNKNOWN" && code !== "NONE") {
        add(byArea, code, o); add(byAreaType, `${code}|${type}`, o);
        for (const pc2 of proposalRangeCodes(range, [`AREA_${code}`])) add(byProposal, `${pc2}|${code}|${range.level}`, o);
        if (code === "FAR" && am?.km != null) add(byAreaKm, am.km <= 6 ? "FAR≤6km" : am.km <= 8 ? "FAR6-8km" : "FAR>8km", o);
        // 前に送った「広げた物件」（2駅・2km・範囲・4km/隣の区・遠い）への反応で、次の広げた物件が刺さるか
        if (/2STOPS|NEAR|REGION|CLOSE|FAR/.test(code)) {
          const h = hist.get(pcId) ?? { sent: 0, hit: 0 };
          const label = h.hit > 0 ? "前に広げた物件が刺さった" : h.sent >= 2 ? "前に広げた物件2件以上・刺さり0" : h.sent === 1 ? "前に広げた物件1件・刺さり0" : "初めて広げた";
          add(byPrev, `${label}|${/FAR/.test(code) ? "FAR" : "点の帯"}`, o);
          h.sent++; if (o.star || o.viewed || o.applied || o.interested) h.hit++; hist.set(pcId, h);
        }
        const cs = custOut.get(pcId) ?? { far: 0, farHit: 0 };
        if (/FAR|CLOSE/.test(code)) { cs.far++; if (o.star || o.viewed || o.applied || o.interested) cs.farHit++; }
        custOut.set(pcId, cs);
      }
    }
    // 広さ
    const fw = normalizeFloorPlanWant(pc.floor_plan);
    const a = typeof f.area_sqm === "number" ? f.area_sqm : parseFloat(f.area_sqm);
    const min = pc.floor_area_min ?? fw.sqmMin;
    if (min != null && Number.isFinite(a)) {
      const d = a - min;
      const band = d >= 0 ? "OK" : a >= min * 0.9 ? "9割以上" : d >= -5 ? "−5㎡まで" : d >= -10 ? "−5〜−10㎡" : "−10㎡超";
      add(bySqm, `${band}${min >= 30 ? "(希望30㎡以上)" : "(30㎡未満)"}`, o);
      // 判定の前と後（前: −5㎡より下は保留／後: 30㎡以上の希望は −10㎡まで情報の札・広さが決め手の人は今まで通り）
      const holdBefore = a < min * 0.9 && a < min - 5;
      const holdAfter = a < min * 0.9 && a < min - wideSqmMargin(min, range.sizeWide);
      add(sqmJudge, `前${holdBefore ? "保留" : "通す側"}→後${holdAfter ? "保留" : "通す側"}`, o);
    }
    // 間取り
    const p = f.floor_plan;
    if (p && !fw.any && (fw.plans.length || fw.minRank != null)) {
      const mm = matchFloorPlan(fw, p);
      const fc = mm === "match" ? "MATCH" : isWideFloorPlan(fw, p) ? "WIDE(LDK→DK)" : mm === "near" ? "NEAR" : isSameClassPlan(fw, p) ? "SAME_CLASS" : isLargerPlan(fw, p) ? "LARGER" : isTooSmallPlan(fw, p) ? "TOO_SMALL" : mm === "mismatch" ? "MISMATCH" : String(mm);
      add(byPlan, fc, o);
      if (fc === "MISMATCH") add(planJudge, `前保留→後${range.sizeWide && isFewerRoomWideLdk(fw, p, Number.isFinite(a) ? a : null, min ?? null) ? "通す側（広い1LDK）" : "保留"}`, o);
      if ((fc === "MISMATCH" || fc === "SAME_CLASS") && /2LDK/.test(String(pc.floor_plan)) && /1LDK/.test(p)) ldkList.push(`${Number.isFinite(a) ? a : "?"}㎡ 希望㎡${min ?? "-"} ${o.star || o.viewed || o.applied || o.interested ? "◎" : "・"}`);
      if (fc === "MISMATCH" || fc === "SAME_CLASS") add(byPlanPair, `${pc.floor_plan}→${p}${Number.isFinite(a) ? (a >= 40 ? "(40㎡以上)" : "(40㎡未満)") : ""}`, o);
    }
  }
  const fmt = (m: Record<string, Cell>) => Object.fromEntries(Object.entries(m).sort((x, y) => y[1].n - x[1].n).map(([k, c]) => [k, `${c.n}件 刺さり${c.hit}(${Math.round((c.hit / c.n) * 100)}%) 🌟${c.star} 内覧${c.viewed} 申込${c.applied}`]));
  let custFar = 0, custFarHit = 0;
  for (const v of custOut.values()) if (v.far) { custFar++; if (v.farHit) custFarHit++; }
  const res = { days: DAYS, area: fmt(byArea), areaFarKm: fmt(byAreaKm), areaByType: fmt(byAreaType), widenedByPrevReaction: fmt(byPrev), sqm: fmt(bySqm), plan: fmt(byPlan), planPairs: fmt(byPlanPair), ldk2to1: arg("ldk") ? ldkList.sort() : ldkList.length, rangeLevels: fmt(byLevel), proposalCodes: fmt(byProposal), sqmJudge: fmt(sqmJudge), planJudge: fmt(planJudge), customersWithFarOrClose: custFar, ofWhichSomeHit: custFarHit };
  console.log(JSON.stringify(res, null, 1));
  const j = arg("json"); if (j) writeFileSync(j, JSON.stringify(res, null, 1));
})();
