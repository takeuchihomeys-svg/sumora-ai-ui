// scripts/audit-walk-minutes.ts — 読むだけ。お客様の発言に walkMinutesInText（徒歩 N 分以内の決定論の読み）を当てて、当たった文・当たらなかった近い文を目で読む
//   実行: npx tsx --env-file=.env.local scripts/audit-walk-minutes.ts --days=180
//   2026-09-30 YUMA「これからは駅10分以内でお願いします」で登録の徒歩が変わらなかった件の線引き（app/lib/walk-minutes-text.ts）
import { createClient } from "@supabase/supabase-js";
import { walkMinutesInText } from "../app/lib/walk-minutes-text";

const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").split("=")[1]) || 180;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const sb = createClient(url, key);

async function main() {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ text: string | null; created_at: string; conversation_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("text, created_at, conversation_id")
      .eq("sender", "customer").gte("created_at", since).or("text.ilike.%徒歩%,text.ilike.%駅%分%,text.ilike.%歩いて%")
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) { console.error(error.message); process.exit(1); }
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const near = rows.filter((r) => r.text && /\d\s?分/.test(r.text.normalize("NFKC")) && r.text.length <= 400);
  const hit = near.filter((r) => walkMinutesInText(r.text) !== null);
  const miss = near.filter((r) => walkMinutesInText(r.text) === null);
  console.log(`お客様の発言（${days}日・徒歩／駅…分／歩いて を含む・400字以内・「N分」あり）: ${near.length}件 → 読めた ${hit.length}件・読まない ${miss.length}件`);
  console.log("\n── 読めた文（全部）");
  for (const r of hit) console.log(`  [${walkMinutesInText(r.text)}分] ${String(r.text).replace(/\s+/g, " ").slice(0, 110)}`);
  console.log("\n── 読まない文（60件まで）");
  for (const r of miss.slice(0, 60)) console.log(`  ${String(r.text).replace(/\s+/g, " ").slice(0, 110)}`);
}
main();
