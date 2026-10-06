// scripts/audit-recommend-bundle-frame.ts
// 物件オススメの「お送りした中でも」（比較の形）を、今の判定（ピッカー＋送付ログ・7日）と新しい判定（直近の束の中から・束の直後だけ）で決めた時、
// スタッフが実際に送った2通目（オススメの後 10分以内の手打ち）と比較の形を使うかがどれだけ合うかを数える（読むだけ・LLM なし・費用0）。
// 2026-10-06 ⑰ 竹内「お送りした中でもは物件ピックアップの中の物件オススメの物件についてオススメしている形」
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-bundle-frame.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { resolveRecommendationScenario, type PropertySendFacts } from "../app/lib/recommendation-frame";
import { loadRecommendBundleFacts } from "../app/lib/recommend-bundle-server";
import { starHeadOf } from "../app/lib/recommendation-gaps";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = Record<string, any>;
const STAFF_COMPARE_RE = /(?:お送り|ピックアップ)(?:させて|させ)?(?:頂|いただ)きました(?:お部屋|物件)の中で|お送りした(?:お部屋|物件)の中で|中でも/;

(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  let recs: Row[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("aix_usage_logs").select("conversation_id, created_at, picker_choices, generated_text").eq("aix_type", "property_recommendation")
      .gte("created_at", since).neq("conversation_id", YUMA_CONVERSATION_ID).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    recs = recs.concat(data as Row[]);
    if (data.length < 1000) break;
  }
  let n = 0, staffCmp = 0, agreeOld = 0, agreeTime = 0, agreeNew = 0, recent = 0, agreeOld30 = 0, agreeNew30 = 0;
  let inB = 0, outB = 0, unkB = 0, outBStaffCmp = 0, outB1h = 0, outB1hS = 0;
  const outShow: string[] = [];
  const cut30 = Date.now() - 30 * 864e5;
  for (const r of recs) {
    const t = Date.parse(r.created_at);
    const { data: sec } = await sb.from("messages").select("text, created_at").eq("conversation_id", r.conversation_id).neq("sender", "customer")
      .gt("created_at", new Date(t + 5_000).toISOString()).lt("created_at", new Date(t + 10 * 60_000).toISOString()).order("created_at").limit(10);
    const second = ((sec ?? []) as Row[]).map((m) => String(m.text ?? "")).find((x) => x && !/^\[画像\]/.test(x) && !/^🌟/.test(x) && !/^[（(]室内/.test(x));
    if (!second) continue;
    const { data: logs } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", r.conversation_id)
      .in("aix_type", ["property_send", "property_recommendation"]).lt("created_at", new Date(t - 1_000).toISOString()).order("created_at", { ascending: false }).limit(20);
    const prior = (logs ?? []) as Row[];
    const facts: PropertySendFacts = {
      priorSentPropertyCount: prior.length,
      priorBulkSendCount: prior.filter((l) => l.aix_type === "property_send").length,
      priorSingleSendCount: prior.filter((l) => l.aix_type === "property_recommendation").length,
      hoursSinceLastSend: prior.length ? (t - Date.parse(prior[0].created_at)) / 3_600_000 : null,
    };
    const pickupType = (r.picker_choices?.pickup_type as string | undefined) ?? null;
    const star = starHeadOf(String(r.generated_text ?? ""))?.name ?? null;
    const bundle = await loadRecommendBundleFacts(sb as never, String(r.conversation_id), star, t - 1_000);
    const oldSc = resolveRecommendationScenario({ actionType: "property_recommendation", pickupType, checkPattern: null, facts });
    const timeSc = resolveRecommendationScenario({ actionType: "property_recommendation", pickupType, checkPattern: null, facts: { ...facts, hoursSinceLastBundle: bundle.hoursSinceLastBundle ?? null, starInLastBundle: null } });
    const newSc = resolveRecommendationScenario({ actionType: "property_recommendation", pickupType, checkPattern: null, facts: { ...facts, hoursSinceLastBundle: bundle.hoursSinceLastBundle ?? null, starInLastBundle: bundle.starInLastBundle ?? null } });
    const s = STAFF_COMPARE_RE.test(second);
    n++; if (s) staffCmp++;
    if ((oldSc === "compare") === s) agreeOld++;
    if ((timeSc === "compare") === s) agreeTime++;
    if ((newSc === "compare") === s) agreeNew++;
    if (bundle.starInLastBundle === true) inB++;
    else if (bundle.starInLastBundle === false) {
      outB++; if (s) outBStaffCmp++;
      if ((bundle.hoursSinceLastBundle ?? 99) <= 1) {
        outB1h++; if (s) outB1hS++;
        if (outShow.length < 8) outShow.push(`${star} ｜ 束: ${(bundle.members ?? []).join("・")} ｜ 2通目: ${second.slice(0, 50).replace(/\n/g, " ")}`);
      }
    } else unkB++;
    if (t >= cut30) { recent++; if ((oldSc === "compare") === s) agreeOld30++; if ((newSc === "compare") === s) agreeNew30++; }
  }
  const pc = (a: number, b: number) => `${a}/${b}（${b ? Math.round(a / b * 100) : 0}%）`;
  console.log(`=== 物件オススメの2通目の比較の形（${DAYS}日・2通目のある ${n}通・スタッフが比較の形 ${staffCmp}）===`);
  console.log(`今の判定（ピッカー＋送付ログ・7日）: ${pc(agreeOld, n)}`);
  console.log(`束の時間だけ（束の直後1時間）     : ${pc(agreeTime, n)}`);
  console.log(`束の中から＋束の時間（新）         : ${pc(agreeNew, n)}`);
  console.log(`直近30日: 今 ${pc(agreeOld30, recent)} → 新 ${pc(agreeNew30, recent)}`);
  console.log(`🌟の部屋: 束の中 ${inB}・束の外 ${outB}（うちスタッフが比較の形 ${outBStaffCmp}・束の直後1時間 ${outB1h}・そのうちスタッフが比較の形 ${outB1hS}）・分からない ${unkB}`);
  for (const s of outShow) console.log(`   束の外（1時間以内）: ${s}`);
})().catch((e) => { console.error(e); process.exit(1); });
