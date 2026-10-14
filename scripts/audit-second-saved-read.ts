// scripts/audit-second-saved-read.ts — 物件オススメの2通目（実送信）の事実のうち、2通目の材料が支える割合（前＝売上サポの行だけ／後＝保存した読みも）。読むだけ・LLM なし
// 実行: npx tsx --env-file=.env.local scripts/audit-second-saved-read.ts（30日・読むだけ・LLM なし）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { isTestConversation } from "../app/lib/test-conversations";
import { headOfFirstMessage, pickupForFirstMessage } from "../app/lib/recommend-cta";
import { buildSecondMaterialNote } from "../app/lib/second-message-scene";
import { pickSavedReadForHead, secondRowFromSavedRead, appendSavedReadLines, savedReadFitLines } from "../app/lib/second-material-saved-read";
import { buildAppealPoints } from "../app/lib/recommend-appeal-points";
import { customerWants } from "../app/lib/recommendation-gaps";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const SINCE = new Date(Date.now() - 30 * 864e5).toISOString();
const H = (s: string) => String(s ?? "").normalize("NFKC");
// 実送信の事実（種類: 値）
function factsOf(t: string): string[] {
  const s = H(t); const out: string[] = [];
  for (const m of s.matchAll(/徒歩\s*(\d{1,2})\s*分/g)) out.push(`徒歩:${m[1]}`);
  for (const m of s.matchAll(/(\d{4})年(?:\d{1,2}月)?築/g)) out.push(`築:${m[1]}`);
  if (/敷金礼金(?:なし|無し|0円)|敷礼(?:なし|0)/.test(s)) out.push("敷礼なし");
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*㎡/g)) out.push(`㎡:${m[1]}`);
  for (const m of s.matchAll(/([\d,]{5,7})\s*円/g)) out.push(`円:${m[1].replace(/,/g, "")}`);
  for (const m of s.matchAll(/(\d[LDKSR]{1,4})/g)) out.push(`間取り:${m[1]}`);
  return [...new Set(out)];
}
function supported(f: string, note: string, first: string): boolean {
  const n = H(note) + "\n" + H(first);
  const [k, v] = f.split(":");
  if (k === "敷礼なし") return /どちらもなし|敷金礼金なし/.test(n);
  if (k === "円") return n.replace(/,/g, "").includes(v);
  if (k === "築") return n.includes(`${v}年`);
  if (k === "徒歩") return new RegExp(`徒歩\\s*${v}分`).test(n);
  return n.includes(v);
}
(async () => {
  const { data: tsl } = await sb.from("template_selection_logs").select("conversation_id, created_at, aix_action_type, final_sent_text").eq("aix_action_type", "property_recommendation").gte("created_at", SINCE).not("final_sent_text", "is", null).limit(1000);
  let n = 0, nPick = 0, nAfter = 0, facts = 0, supB = 0, supA = 0, withFit = 0; const samples: unknown[] = [];
  for (const r of (tsl ?? []) as any[]) {
    if (isTestConversation(r.conversation_id)) continue;
    const { data: us } = await sb.from("aix_usage_logs").select("generated_text, sent_at").eq("conversation_id", r.conversation_id).eq("aix_type", "property_recommendation").not("sent_at", "is", null).lte("sent_at", r.created_at).order("sent_at", { ascending: false }).limit(1);
    const first = (us?.[0]?.generated_text as string) ?? ""; const firstAt = us?.[0]?.sent_at as string | undefined;
    if (!first || !firstAt || Date.parse(r.created_at) - Date.parse(firstAt) > 3 * 3600e3) continue;
    const head = headOfFirstMessage(first); if (!head) continue;
    n++;
    const { data: ps } = await sb.from("property_pickups").select("property_name, room_no, verdict, reason_codes, created_at, terms, location, equipment").eq("conversation_id", r.conversation_id).eq("room_no", head.room).limit(20);
    const pick = pickupForFirstMessage((ps ?? []) as any, head);
    const before = buildSecondMaterialNote(pick as any);
    let after = before;
    if (pick) nPick++;
    else {
      const { data: sip } = await sb.from("sent_image_properties").select("property_name, room_no, facts, created_at").eq("conversation_id", r.conversation_id).not("facts", "is", null).lte("created_at", r.created_at).order("created_at", { ascending: false }).limit(60);
      const hit = pickSavedReadForHead((sip ?? []) as any, head, Date.parse(r.created_at));
      const conv = hit ? secondRowFromSavedRead(hit.facts) : null;
      if (hit && conv) {
        const { data: cl } = await sb.from("conversations").select("property_customer_id").eq("id", r.conversation_id).maybeSingle();
        const { data: pc } = cl?.property_customer_id ? await sb.from("property_customers").select("rent_max, floor_plan, walk_minutes, building_age, initial_cost_limit, pet, move_in_time, floor_area_min, preferences, ng_points, other_requests, additional_conditions").eq("id", cl.property_customer_id).maybeSingle() : { data: null };
        const p = pc as any;
        const fit = savedReadFitLines(buildAppealPoints(hit.facts as any, customerWants({ conditions: p, messages: [] }), { rentMax: p?.rent_max ?? null, walkMax: p?.walk_minutes ?? null, ageMax: p?.building_age ?? null, sqmMin: p?.floor_area_min ?? null }));
        if (fit.length) withFit++;
        after = appendSavedReadLines(buildSecondMaterialNote(conv.row), [...conv.extraLines, ...fit]);
      }
    }
    if (after) nAfter++;
    // 1通目に既にある事実は2通目の材料が無くても書ける → 1通目に無い事実だけ数える
    const fs = factsOf(r.final_sent_text).filter((f) => !supported(f, "", first));
    facts += fs.length;
    supB += fs.filter((f) => supported(f, before, "")).length;
    supA += fs.filter((f) => supported(f, after, "")).length;
    if (samples.length < 40 && after !== before) samples.push({ conv: r.conversation_id, at: r.created_at, head, sent: r.final_sent_text, before, after });
  }
  console.log({ n, materialBefore: nPick, materialAfter: nAfter, withFit, factsNotInFirst: facts, supportedBefore: supB, supportedAfter: supA });
  (await import("node:fs")).mkdirSync("scripts/.replay-out", { recursive: true }); writeFileSync("scripts/.replay-out/second-saved-read.json", JSON.stringify(samples, null, 1));
})();
