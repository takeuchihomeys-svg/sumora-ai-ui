// 連用形「〜く・」の数を実送信（スタッフの文・YUMA 除く）で数える（読むだけ）
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const since = new Date(Date.now() - 400 * 86400_000).toISOString();
async function main() {
  const out: { conversation_id: string; text: string | null; is_aix_generated: boolean | null }[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, is_aix_generated").eq("sender", "staff").gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    out.push(...((data ?? []) as typeof out)); if ((data ?? []).length < 1000) break;
  }
  const rows = out.filter((r) => r.text && !isTestConversation(r.conversation_id));
  console.log("staff msgs", rows.length);
  const pats: [string, RegExp][] = [
    ["く・(any)", /く・/],
    ["形容詞く・", /(?:浅|広|近|良|よ|安|多|少な|高|低|新し|明る|大き|小さ|長|短|早|遅|強|嬉し|美し|綺麗)く・/],
    ["浅く・", /浅く・/],
    ["浅く、", /浅く、/],
    ["浅く(次が漢字/カナ)", /浅く[^\s、。！!・]/],
    ["く、", /(?:浅|広|近|良|安|多|高|低|新し|明る|大き)く、/],
  ];
  for (const [k, re] of pats) {
    const hit = rows.filter((r) => re.test(r.text!));
    const human = hit.filter((r) => r.is_aix_generated !== true);
    console.log(`${k}: ${hit.length}（is_aix_generated≠true ${human.length}）`);
    for (const h of hit.slice(0, 12)) { const t = h.text!; const i = t.search(re); console.log("   ", h.is_aix_generated ? "[AIX]" : "[人]", t.slice(Math.max(0, i - 30), i + 40).replace(/\n/g, "⏎")); }
  }
}
main();
