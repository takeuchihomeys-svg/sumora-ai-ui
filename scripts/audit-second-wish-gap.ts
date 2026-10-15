// scripts/audit-second-wish-gap.ts — 物件オススメの2通目の型（希望とのずれ・相場の好条件）の決め方を、実送信の2通目と比べる（読むだけ・LLM なし・費用0）
//
// 2026-10-15 竹内悠馬（KAORI さん 10/12 21:01「最寄り駅瓢箪山駅となりますがこちらのお部屋如何でしょうか！！ 家賃管理費込75,700円、…と好条件で…」）
//   app/lib/recommend-second-wish-gap.ts が「ずれ」「好条件」を渡す番と、スタッフが実際に2通目でずれ・好条件を書いた番を数える。
//   ⚠ お客様の希望は今の property_customers（その時の希望とは違う事がある）。個人情報は出さない（数だけ・2通目は先頭の型だけ伏せて出す）
// 実行: npx tsx --env-file=.env.local scripts/audit-second-wish-gap.ts [--days=90] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { resolveWishAreaGap, rentTotalOfFirst, planOfFirst, cheapVsMarket } from "../app/lib/recommend-second-wish-gap";
import { headOfFirstMessage } from "../app/lib/recommend-cta";
import { pickSavedReadForHead, type SavedReadRow } from "../app/lib/second-material-saved-read";
import { customerAreaPlan } from "../app/lib/area-want";
import { rentBand, planGroupOf, type RentObs } from "../app/lib/area-rent-explain";
import { isTestConversation } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = Number(args.days ?? 90), SHOW = Number(args.show ?? 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type R = Record<string, any>;
const GAP_RE = /となりますが|外れますが|外れてしまいますが|離れますが/;
const CHEAP_RE = /好条件|相場/;
const mask = (s: string) => String(s ?? "").split("\n")[0].replace(/[^\s、。！!]{1,12}(さん|様)/g, "〇〇$1").replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "").slice(0, 70);

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const { data: sends } = await sb.from("aix_usage_logs").select("conversation_id, created_at, sent_at").eq("aix_type", "property_recommendation").gte("created_at", since).order("created_at").limit(2000);
  const convIds = [...new Set(((sends ?? []) as R[]).map((s) => s.conversation_id))].filter((c) => !isTestConversation(c));
  const { data: convs } = await sb.from("conversations").select("id, property_customer_id").in("id", convIds);
  const pcIds = [...new Set(((convs ?? []) as R[]).map((c) => c.property_customer_id).filter(Boolean))];
  const pcs = new Map<string, R>();
  for (let i = 0; i < pcIds.length; i += 100) {
    const { data } = await sb.from("property_customers").select("id, desired_area, preferences, other_requests, floor_plan, rent_max").in("id", pcIds.slice(i, i + 100));
    for (const p of (data ?? []) as R[]) pcs.set(p.id, p);
  }
  const pcOf = new Map(((convs ?? []) as R[]).map((c) => [c.id, c.property_customer_id ? pcs.get(c.property_customer_id) ?? null : null]));
  const obsCache = new Map<string, RentObs[]>();
  const tally: Record<string, number> = {};
  const inc = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);
  const examples: string[] = [];
  for (const s of (sends ?? []) as R[]) {
    if (isTestConversation(s.conversation_id)) continue;
    const t0 = s.sent_at ?? s.created_at, t1 = new Date(Date.parse(t0) + 30 * 60e3).toISOString();
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", s.conversation_id)
      .gte("created_at", new Date(Date.parse(t0) - 60e3).toISOString()).lte("created_at", t1).order("created_at");
    const M = (msgs ?? []) as R[];
    const first = M.find((m) => m.is_aix_generated && /^🌟/.test(String(m.text ?? "").replace(/^（室内イメージ）[\s\S]*?\n\n/, "")))?.text ?? null;
    if (!first) { inc("1通目の🌟が読めない"); continue; }
    const firstAt = M.find((m) => m.text === first)!.created_at;
    const cust = M.find((m) => m.sender === "customer" && m.created_at > firstAt);
    const second = M.find((m) => m.sender !== "customer" && !m.is_aix_generated && m.created_at > firstAt && m.text && m.text !== "[画像]" && !/^（室内イメージ）/.test(m.text) && (!cust || m.created_at < cust.created_at));
    if (!second) { inc("2通目なし"); continue; }
    inc("2通目あり");
    const pc = pcOf.get(s.conversation_id) ?? null;
    if (!pc) { inc("希望の欄なし"); continue; }
    const head = headOfFirstMessage(first);
    let savedReadStations: Array<{ station: string; walk: number | null }> = [];
    if (head) {
      const { data: sip } = await sb.from("sent_image_properties").select("property_name, room_no, facts, created_at").eq("conversation_id", s.conversation_id).lte("created_at", t1).not("facts", "is", null).order("created_at", { ascending: false }).limit(40);
      const hit = pickSavedReadForHead((sip ?? []) as SavedReadRow[], head, Date.parse(t0));
      savedReadStations = ((hit?.facts?.stations ?? []) as R[]).filter((x) => x?.station).map((x) => ({ station: String(x.station), walk: typeof x.walk === "number" ? x.walk : null }));
    }
    const g = resolveWishAreaGap({ desiredArea: pc.desired_area, freeText: [pc.preferences, pc.other_requests].filter(Boolean).join("\n"), firstMessage: first, savedReadStations });
    const actualGap = GAP_RE.test(second.text);
    inc(`ずれ 渡す=${g.gap ? g.gap.kind : "なし"} × 実送信=${actualGap ? "書いた" : "書かない"}`);
    // 内訳: 竹内さんの送信か／直前24時間にピックアップ（束）を送ったか（束の時に広げた事を伝えている）／前の会話でエリアを広げると伝えたか
    const { data: before } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", s.conversation_id).eq("aix_type", "property_send").lt("created_at", t0).gte("created_at", new Date(Date.parse(t0) - 24 * 3600e3).toISOString()).limit(1);
    const { data: told } = await sb.from("messages").select("text").eq("conversation_id", s.conversation_id).neq("sender", "customer").lt("created_at", t0).gte("created_at", new Date(Date.parse(t0) - 14 * 864e5).toISOString()).or("text.ilike.%広げ%,text.ilike.%外れ%,text.ilike.%離れ%").limit(1);
    const { data: wr } = await sb.from("messages").select("staff_writer").eq("conversation_id", s.conversation_id).eq("created_at", second.created_at).limit(1);
    const tag = `${(wr?.[0] as R | undefined)?.staff_writer === "takeuchi" ? "竹内" : "他"}・${(before ?? []).length ? "束の後" : "単独"}・${(told ?? []).length ? "広げた事を伝え済み" : "未"}`;
    if (g.gap) inc(`  内訳 ずれを渡す[${tag}] 実送信=${actualGap ? "書いた" : "書かない"}`);
    if (actualGap && examples.length < SHOW) examples.push(`  [${g.gap ? g.gap.kind : `なし:${g.reason}`}] ${mask(second.text)}`);
    // 相場
    const rentTotal = rentTotalOfFirst(first), pg = planGroupOf(planOfFirst(first));
    let cheap = false;
    if (rentTotal && pg) {
      const { customerWards } = await import("../app/lib/area-rent-server");
      const wards = customerWards(pc as never, customerAreaPlan(pc.desired_area ?? null, [pc.preferences, pc.other_requests].filter(Boolean).join("\n")));
      const key = wards.join("|");
      if (wards.length && !obsCache.has(key)) obsCache.set(key, await (await import("../app/lib/area-rent-server")).loadRentObservations(wards));
      cheap = wards.length ? cheapVsMarket(rentTotal, rentBand(obsCache.get(key) ?? [], wards, pg)) : false;
    }
    inc(`好条件 渡す=${cheap ? "言ってよい" : "言わない"} × 実送信=${CHEAP_RE.test(second.text) ? "書いた" : "書かない"}`);
    if (/家賃管理費込/.test(second.text)) inc("実送信 家賃管理費込");
  }
  console.log(`期間 ${DAYS}日・物件オススメ ${(sends ?? []).length}回`);
  for (const [k, v] of Object.entries(tally).sort()) console.log(`  ${k}: ${v}`);
  console.log("実送信でずれを書いた2通目（先頭の行・伏せ済み）と、渡す判定:");
  for (const e of examples) console.log(e);
})();
