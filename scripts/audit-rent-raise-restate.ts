// scripts/audit-rent-raise-restate.ts — 監査（読むだけ・DB に書かない）2026-09-27 app/lib/rent-raise.ts を作った時の物
//   ①家賃を上げてと頼まれた会話で、その時の上限・新しい決まりの上限・次の検索の家賃 ②「N帖/畳以上」の言い直しと面積の下限
//   ③条件の言い直し（ブレインの cond）が30分以内に登録の条件に入った痕跡 ④検索が登録の条件と違う駅・低い家賃で入った回
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-raise-restate.ts [PART=1234] [OUT=入らなかった番の書き出し先.txt]
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import { applyConditionGuards, detectRentRaiseRequest, roomJoMinInText, floorAreaMinFromJo } from "../app/lib/rent-raise";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const OUT = process.env.OUT ?? "audit-rent-raise-misses.txt";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
async function pcOf(conv: string) { const { data } = await sb.from("conversations").select("property_customer_id,customer_name").eq("id", conv).maybeSingle(); return data; }
const one = (s: string, n: number) => s.replace(/\n/g, " / ").slice(0, n);
async function main() {
  const part = process.env.PART ?? "1234";
  if (part.includes("1")) {
    console.log("===== ① 家賃を上げて（実物）");
    const found = new Map<string, { conversation_id: string; created_at: string; text: string }>();
    for (const p of ["%家賃%上げ%", "%家賃%あげ%", "%家賃%上が%", "%予算%上げ%", "%予算%あげ%", "%高くても%", "%家賃%アップ%", "%予算%アップ%", "%賃料%上げ%", "%もう少し高%", "%家賃%高め%", "%予算%上が%"]) {
      const { data } = await sb.from("messages").select("id,conversation_id,created_at,text").eq("sender", "customer").ilike("text", p).gte("created_at", "2026-03-01").limit(500);
      for (const m of data ?? []) found.set(m.id as string, m as never);
    }
    const rows = [...found.values()].filter((m) => m.conversation_id !== YUMA).sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const m of rows) {
      const r = detectRentRaiseRequest(m.text);
      if (!r) continue;
      const c = await pcOf(m.conversation_id);
      const pcId = c?.property_customer_id as string | undefined;
      const hist = pcId ? (await sb.from("property_condition_history").select("changed_field,old_value,new_value,created_at").eq("property_customer_id", pcId).in("changed_field", ["rent_max", "rent_min"]).gte("created_at", m.created_at).order("created_at").limit(4)).data ?? [] : [];
      const aud = pcId ? (await sb.from("search_audits").select("id,created_at,trigger,intended,customer_snapshot").eq("property_customer_id", pcId).gte("created_at", m.created_at).order("created_at").limit(2)).data ?? [] : [];
      const pc = pcId ? (await sb.from("property_customers").select("rent_max,rent_min").eq("id", pcId).maybeSingle()).data : null;
      const firstMax = hist.find((h) => h.changed_field === "rent_max");
      const maxAt = firstMax ? Number(firstMax.old_value) : (pc?.rent_max as number | null) ?? null;
      const g = applyConditionGuards(m.text, { rent_max: maxAt }, {}, "p4");
      console.log(`\n[${m.created_at.slice(0, 16)}] ${m.conversation_id.slice(0, 8)} ${c?.customer_name ?? ""} pc=${pcId?.slice(0, 8) ?? "なし"}\n  文: ${one(m.text, 120)}\n  読み: ${JSON.stringify(r).slice(0, 60)}\n  その時の上限: ${maxAt} → 新しい決まり: ${g.extracted.rent_max ?? "（変えない）"}`);
      for (const h of hist) console.log(`  履歴 ${h.created_at.slice(0, 16)} ${h.changed_field} ${h.old_value}→${h.new_value}`);
      for (const a of aud) console.log(`  次の検索 ${a.created_at.slice(0, 16)} ${a.trigger} 入れた家賃 ${(a.intended as Record<string, unknown>)?.rent_min ?? ""}〜${(a.intended as Record<string, unknown>)?.rent_max} 登録 ${(a.customer_snapshot as Record<string, unknown>)?.rent_max}`);
      if (!aud.length) console.log("  次の検索: 点検の記録なし（search_audits は 9/26〜）");
    }
  }
  if (part.includes("2")) {
    console.log("\n===== ② 「N帖/畳以上」をお客様が言った（4/1〜）");
    const seen = new Map<string, { conversation_id: string; created_at: string; text: string }>();
    for (const p of ["%畳以上%", "%帖以上%", "%畳は%", "%帖は%", "%畳くらい%", "%帖くらい%", "%畳の部屋%", "%帖の部屋%"]) {
      const { data } = await sb.from("messages").select("conversation_id,created_at,text").eq("sender", "customer").like("text", p).gte("created_at", "2026-04-01").limit(300);
      for (const m of data ?? []) seen.set(m.conversation_id + m.created_at, m as never);
    }
    let n2 = 0, conv2 = 0, sqmOk = 0;
    for (const m of [...seen.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      const jo = roomJoMinInText(m.text);
      if (jo === null || m.conversation_id === YUMA) continue;
      n2++;
      const c = await pcOf(m.conversation_id);
      if (!c?.property_customer_id) { console.log(`  [${m.created_at.slice(0, 10)}] ${m.conversation_id.slice(0, 8)} 紐付けなし ${jo}帖: ${one(m.text, 80)}`); continue; }
      conv2++;
      const { data: pc } = await sb.from("property_customers").select("floor_area_min,preferences,other_requests,floor_plan").eq("id", c.property_customer_id).maybeSingle();
      const fa = floorAreaMinFromJo(m.text, pc?.floor_plan as string | null); const want = fa?.sqm ?? -99;
      if (pc?.floor_area_min != null && Math.abs(Number(pc.floor_area_min) - want) <= 2) sqmOk++;
      console.log(`  [${m.created_at.slice(0, 10)}] ${m.conversation_id.slice(0, 8)} ${c.customer_name} ${jo}帖 → 今 floor_area_min=${pc?.floor_area_min ?? "なし"}・間取り ${pc?.floor_plan ?? "なし"}（新しい決まり: ${fa ? fa.sqm + "㎡" : "変えない"}）: ${one(m.text, 70)}`);
    }
    console.log(`  計 ${n2} 通（紐付けあり ${conv2}・今の面積の下限が帖数の換算に近い ${sqmOk}）`);
  }
  if (part.includes("3")) {
    console.log("\n===== ③ 条件の言い直し（ブレインの cond あり・9/5〜）が30分以内に登録の条件に入ったか");
    const logs: Array<{ conversation_id: string; analyzed_msg_ts: string | null; digest: Record<string, unknown> | null }> = [];
    for (let off = 0; off < 30000; off += 1000) {
      const { data, error } = await sb.from("brain_decision_logs").select("conversation_id,analyzed_msg_ts,digest").not("digest->>cond", "is", null).range(off, off + 999);
      if (error) { console.log(error.message); break; }
      if (!data?.length) break; logs.push(...(data as never[]));
    }
    const uniq = new Map<string, (typeof logs)[number]>();
    for (const l of logs) { const k = l.conversation_id + (l.analyzed_msg_ts ?? ""); if (!uniq.has(k)) uniq.set(k, l); }
    let total = 0, linked = 0, reflected = 0; const byCond: Record<string, [number, number]> = {}; const misses: string[] = [];
    for (const l of uniq.values()) {
      if (!l.analyzed_msg_ts || l.conversation_id === YUMA) continue;
      total++;
      const c = await pcOf(l.conversation_id);
      if (!c?.property_customer_id) continue;
      linked++;
      const t0 = Date.parse(l.analyzed_msg_ts), t1 = t0 + 30 * 60 * 1000;
      const { data: h } = await sb.from("property_condition_history").select("changed_field").eq("property_customer_id", c.property_customer_id).gte("created_at", new Date(t0).toISOString()).lte("created_at", new Date(t1).toISOString()).limit(1);
      const { data: pc } = await sb.from("property_customers").select("additional_conditions").eq("id", c.property_customer_id).maybeSingle();
      const j0 = new Date(t0 + 9 * 3600e3);
      let autoHit = false;
      for (const mm of String(pc?.additional_conditions ?? "").matchAll(/\[(\d+)\/(\d+) (\d+):(\d+)\|(?:auto|format)\]/g)) {
        const ts = Date.UTC(j0.getUTCFullYear(), Number(mm[1]) - 1, Number(mm[2]), Number(mm[3]), Number(mm[4])) - 9 * 3600e3;
        if (ts >= t0 - 60e3 && ts <= t1) autoHit = true;
      }
      const ok = !!h?.length || autoHit;
      const cond = String(l.digest?.cond ?? "?");
      byCond[cond] = byCond[cond] ?? [0, 0]; byCond[cond][0]++; if (ok) { byCond[cond][1]++; reflected++; }
      else {
        const { data: msg } = await sb.from("messages").select("text").eq("conversation_id", l.conversation_id).eq("created_at", l.analyzed_msg_ts).maybeSingle();
        misses.push(`${l.analyzed_msg_ts.slice(0, 16)} ${l.conversation_id.slice(0, 8)} ${c.customer_name} [${cond}] ${one(String(msg?.text ?? ""), 100)}`);
      }
    }
    console.log(`  言い直しの番 ${total}（物件出し顧客に紐付き ${linked}）・30分以内に登録の条件が変わった形跡あり ${reflected}（${(reflected / Math.max(1, linked) * 100).toFixed(0)}%）`);
    for (const [k, v] of Object.entries(byCond).sort((a, b) => b[1][0] - a[1][0])) console.log(`   ${k}: ${v[1]}/${v[0]}`);
    fs.writeFileSync(OUT, misses.join("\n"));
    console.log(`  入らなかった番 ${misses.length} 件 → ${OUT}`);
  }
  if (part.includes("4")) {
    console.log("\n===== ④ 検索が登録の条件と違う駅・低い家賃で入力された回（search_audits・メモの上書き・広げて以外）");
    const { data: auds } = await sb.from("search_audits").select("id,created_at,property_customer_id,trigger,mode,intended,customer_snapshot").order("created_at");
    let na = 0, nd = 0;
    for (const a of auds ?? []) {
      const it = a.intended as Record<string, unknown> | null, sn = a.customer_snapshot as Record<string, unknown> | null;
      if (!it || !sn || sn._search_override || it.is_wide) continue;
      na++;
      const st = (it.station_names ?? []) as string[];
      const area = String(sn.desired_area ?? "");
      const stationOff = sn.area_mode === "station" && st.length > 0 && st.some((x) => !area.includes(x));
      const rentOff = !!sn.rent_max && !!it.rent_max && Number(it.rent_max) < Number(sn.rent_max);
      if (stationOff || rentOff) { nd++; console.log(`  #${a.id} ${a.created_at.slice(0, 16)} ${a.trigger}/${a.mode} 登録 ${area}・〜${sn.rent_max} → 入れた 駅${JSON.stringify(st)}・〜${it.rent_max}`); }
    }
    console.log(`  ${nd}/${na} 回`);
  }
}
main();
