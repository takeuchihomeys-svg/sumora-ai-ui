// 退去予定の一文（退去日なし）の形をスタッフの文で数える（読むだけ）
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const out: any[] = [];
  for (let p = 0; p < 200; p++) { const { data } = await sb.from("messages").select("conversation_id, text, is_aix_generated").eq("sender", "staff").order("created_at").range(p * 1000, p * 1000 + 999); out.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  const rows = out.filter((r) => r.text && !isTestConversation(r.conversation_id));
  const pats: [string, RegExp][] = [
    ["退去予定のお部屋となります！", /退去予定のお部屋となります[！!]/],
    ["退去予定のお部屋となり、", /退去予定のお部屋となり[、,]/],
    ["退去予定のお部屋で", /退去予定のお部屋で/],
    ["退去予定のお部屋（全部）", /退去予定のお部屋/],
    ["◯月◯旬ごろご入居可能", /\d{1,2}月(?:上旬|中旬|下旬|末)(?:ごろ|頃)?に?ご?入居可能/],
    ["日付なし退去予定のお部屋となります(行全体)", /(?:^|\n)(?:こちら)?退去予定のお部屋となります[！!]+(?:😊|😌)?(?:\n|$)/],
  ];
  for (const [k, re] of pats) { const h = rows.filter((r) => re.test(r.text)); console.log(k, h.length, "人", h.filter((r) => !r.is_aix_generated).length); for (const x of h.slice(0, 4)) { const i = x.text.search(re); console.log("   ", x.text.slice(Math.max(0, i - 25), i + 45).replace(/\n/g, "⏎")); } }
}
main();
