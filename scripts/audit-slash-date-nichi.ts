// scripts/audit-slash-date-nichi.ts — スタッフの実送信（手打ち・AIX）と手本で「M/D日」を数え、直しの前後を並べる（読むだけ）
// 実行: npx tsx --env-file=.env.local scripts/audit-slash-date-nichi.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { fixSlashDateNichi } from "../app/lib/slash-date-nichi";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? "365");
(async () => {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  let n = 0, hit = 0, skipped = 0; const samples: string[] = [], kept: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("messages").select("text").neq("sender", "customer").gte("created_at", since).like("text", "%/%日%").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ text: string | null }>) {
      const t = r.text ?? ""; n++;
      const f = fixSlashDateNichi(t);
      if (f.fixed.length) { hit++; if (samples.length < 40) { const i = t.indexOf(f.fixed[0]); samples.push(`「${t.slice(Math.max(0, i - 12), i + 20).replace(/\s+/g, " ")}」→「${f.text.slice(Math.max(0, i - 12), i + 19).replace(/\s+/g, " ")}」`); } }
      else if (/[0-9]{1,2}\/[0-9]{1,2}日/.test(t)) { skipped++; if (kept.length < 15) { const i = t.search(/[0-9]{1,2}\/[0-9]{1,2}日/); kept.push(`「${t.slice(Math.max(0, i - 8), i + 16).replace(/\s+/g, " ")}」`); } }
    }
    if ((data ?? []).length < 1000) break;
  }
  console.log(`こちらの送信（/ と 日を含む）${n}通・直す ${hit}通・M/D日 だが触らない ${skipped}通`);
  console.log("== 直す（前→後）"); for (const s of samples) console.log("  " + s);
  console.log("== 触らない"); for (const s of kept) console.log("  " + s);
  process.exit(0);
})();
