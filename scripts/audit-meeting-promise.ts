// scripts/audit-meeting-promise.ts
// 2026-10-02 ⑫ 21巡（待ち合わせまで行く流れ flow2_fbffca）: スタッフの「待ち合わせ場所（追って／改めて）ご連絡させて頂きます」の約束の後、
//   次のお客様の番でスタッフが AIX【待ち合わせ】を押したか（約束を果たす AIX として立ててよいか）。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-meeting-promise.ts
import { createClient } from "@supabase/supabase-js";
import { MEETING_PROMISE_RE } from "../app/lib/meeting-promise";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
(async () => {
  const { data } = await sb.from("messages").select("conversation_id, created_at, text").neq("sender", "customer").ilike("text", "%待ち合わせ%").order("created_at", { ascending: false }).limit(1000);
  let n = 0, pressedNext = 0, pressedLater = 0, none = 0; const shown: string[] = [];
  for (const m of data ?? []) {
    if (!MEETING_PROMISE_RE.test(String(m.text))) continue;
    n++;
    const at = m.created_at as string;
    const { data: next } = await sb.from("messages").select("sender, created_at").eq("conversation_id", m.conversation_id).gt("created_at", at).order("created_at").limit(20);
    const ci = (next ?? []).findIndex((x) => x.sender === "customer");
    const custAt = ci >= 0 ? (next ?? [])[ci].created_at : null;
    const { data: ps } = await sb.from("aix_usage_logs").select("created_at").eq("conversation_id", m.conversation_id).eq("aix_type", "meeting_place").gt("created_at", at).order("created_at").limit(1);
    const p = ps?.[0]?.created_at ?? null;
    const { data: later } = await sb.from("messages").select("text, created_at").eq("conversation_id", m.conversation_id).neq("sender", "customer").gt("created_at", at).order("created_at").limit(15);
    const manual = (later ?? []).find((x) => /待ち合わせ(?:場所)?(?:は|：|:)|〒|丁目/.test(String(x.text)));
    if (!p && manual) shown.push(`  手で待ち合わせを送った: ${String(manual.text).replace(/\n/g, " ").slice(0, 70)}`);
    if (!p) none++;
    else if (!custAt || p < custAt) pressedNext++;
    else pressedLater++;
    if (shown.length < 10) shown.push(`${p ? (custAt && p >= custAt ? "お客様の後に押した" : "お客様の前に押した") : "押していない"} | ${String(m.text).replace(/\n/g, " ").slice(0, 90)}`);
  }
  console.log(`待ち合わせの約束 ${n}: 次のお客様の番より前に AIX【待ち合わせ】 ${pressedNext}・お客様の番の後 ${pressedLater}・押していない ${none}`);
  for (const s of shown) console.log("  ", s);
})();
