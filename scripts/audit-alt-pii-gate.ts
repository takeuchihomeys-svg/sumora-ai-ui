// scripts/audit-alt-pii-gate.ts — DeepSeek の出口の門（alt-pii-gate.altPiiSignal）が実データでどれだけ当たるかを数える（読むだけ・LLM なし・$0）
//   ①伏せた後（maskPII・本番で DeepSeek に回す時の形）に当たる通＝門が Claude に戻す回数の見込み（誤って戻す＝費用の損）
//   ②伏せる前に当たる通＝入口の伏せが無かったら漏れていた物（門が守る相手）
// 実行: npx tsx --env-file=.env.local scripts/audit-alt-pii-gate.ts [--days=14] [--limit=6000]
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

async function main() {
  const { altPiiSignal } = await import("../app/lib/alt-pii-gate");
  const { maskPII } = await import("../app/lib/pii-mask");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const since = new Date(Date.now() - Number(arg("days", "14")) * 86400e3).toISOString();
  const limit = Number(arg("limit", "6000"));
  const rows: Array<{ sender: string; text: string | null; is_aix_generated: boolean | null }> = [];
  for (let from = 0; from < limit; from += 1000) {
    const { data, error } = await db.from("messages").select("sender, text, is_aix_generated").gte("created_at", since)
      .order("created_at", { ascending: false }).range(from, Math.min(from + 999, limit - 1));
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  const count = (pick: (r: (typeof rows)[number]) => string) => {
    const by: Record<string, number> = {};
    let n = 0;
    for (const r of rows) {
      const sig = altPiiSignal(pick(r));
      if (!sig) continue;
      n++;
      const k = `${r.sender}${r.is_aix_generated ? "(AIX)" : ""}:${sig}`;
      by[k] = (by[k] ?? 0) + 1;
    }
    return { n, by };
  };
  const masked = count((r) => maskPII(r.text ?? "", []));
  const rawHits = count((r) => r.text ?? "");
  console.log(JSON.stringify({ messages: rows.length, since, maskedHits: masked, rawHits }, null, 1));
  // 伏せた後も当たった物の形（数字は X に・値そのものは出さない）
  const { MOBILE_RE } = await import("../app/lib/test-pii-guard");
  for (const r of rows) {
    const m = maskPII(r.text ?? "", []);
    if (!altPiiSignal(m)) continue;
    const hit = m.match(MOBILE_RE)?.[0];
    console.log("  伏せ漏れの形:", hit ? hit.replace(/\d/g, "X") : "(携帯以外)", "／前後:", JSON.stringify((hit ? m.slice(Math.max(0, m.indexOf(hit) - 12), m.indexOf(hit)) : m.slice(0, 20)).replace(/\d/g, "X").replace(/[一-龯ぁ-んァ-ヶ]{2,}/g, (w) => (/電話|携帯|番号|氏名|生年月日|勤務先|年収|住所|連絡先|記入欄/.test(w) ? w : "＊"))));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
