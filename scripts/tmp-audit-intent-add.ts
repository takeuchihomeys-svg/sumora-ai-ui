// tmp: classifyByKeywords の「追加・許容 → ADD」で判定が変わる実物を読む（2026-09-30）
import { createClient } from "@supabase/supabase-js";
import { classifyByKeywords } from "../app/lib/condition-intent";
import { detectConditionExpansion } from "../app/lib/condition-expansion";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function main() {
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  let all: { text: string }[] = [];
  for (let from = 0; from < 60000; from += 1000) {
    const { data } = await sb.from("messages").select("text").eq("sender", "customer").gte("created_at", since).not("text", "is", null).range(from, from + 999);
    if (!data?.length) break;
    all = all.concat(data as { text: string }[]);
  }
  let changed = 0;
  for (const m of all) {
    const t = m.text;
    const now = classifyByKeywords(t, null);
    if (now?.intent !== "ADD") continue;
    const addPatterns = ["追加", "も見たい", "も含め", "も検討", "プラス", "も良い", "もOK", "も可", "もあり", "もお願い", "もいいです", "も希望"];
    if (addPatterns.some((k) => t.includes(k))) continue;
    changed++;
    console.log(`[${detectConditionExpansion(t).reason}] ${t.replace(/\n/g, " ⏎ ").slice(0, 140)}`);
  }
  console.log(`\n読んだ ${all.length} 通 / 新しく ADD になった ${changed} 通`);
}
main();
