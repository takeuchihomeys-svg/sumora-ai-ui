// scripts/audit-waiting-customer-info.ts
// 2026-10-06 ⑫（末桜「移動の連絡まち」）: waiting-customer-info.waitingOnCustomerInfo の線。読むだけ・LLM なし。
//   本番の会話で waiting=true になるお客様の番について、スタッフの次の動き（返事なし／手打ちの短い受け止め／ピックアップの約束・物件の AIX）を数え、手打ちの例を目で読む
// 実行: npx tsx --env-file=.env.local scripts/audit-waiting-customer-info.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { waitingOnCustomerInfo, WAITING_CUSTOMER_INFO_RE } from "../app/lib/waiting-customer-info";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=180").slice(7));
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const seeds: Array<{ conversation_id: string; text: string | null }> = [];
  for (let f = 0; f < 50_000; f += 1000) {
    const { data } = await sb.from("messages").select("conversation_id, text").neq("sender", "customer").gte("created_at", since).or("text.ilike.%ましたら%,text.ilike.%次第%").order("created_at").range(f, f + 999);
    seeds.push(...((data ?? []) as typeof seeds)); if ((data ?? []).length < 1000) break;
  }
  const convs = [...new Set((seeds ?? []).filter((m) => WAITING_CUSTOMER_INFO_RE.test(String(m.text ?? ""))).map((m) => m.conversation_id as string))].filter((c) => !c.startsWith("dd34f5b0"));
  console.log("会話", convs.map((c) => c.slice(0, 8)).join(","));
  let turns = 0; const tally: Record<string, number> = {}; const ex: string[] = [];
  for (const cid of convs) {
    const { data: ms } = await sb.from("messages").select("sender, created_at, text, is_aix_generated").eq("conversation_id", cid).order("created_at").limit(3000);
    const list = ms ?? [];
    const { data: ps } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", cid);
    for (let i = 0; i < list.length; i++) {
      // お客様の連投の終わり（次がこちら・または次のお客様の発言が30分以上あと＝その時点でブレインが判断した番）
      if (list[i].sender !== "customer" || (list[i + 1] && list[i + 1].sender === "customer" && Date.parse(list[i + 1].created_at) - Date.parse(list[i].created_at) < 30 * 60_000)) continue;
      const w = waitingOnCustomerInfo(list.slice(0, i + 1).map((m) => ({ sender: m.sender, text: m.text })));
      if (!w.waiting) continue;
      turns++;
      const at = Date.parse(list[i].created_at);
      const nextAny = list[i + 1];
      const next = nextAny && nextAny.sender !== "customer" ? nextAny : undefined;
      const gapH = next ? (Date.parse(next.created_at) - at) / 3600_000 : Infinity;
      const pressed = (ps ?? []).some((p) => Date.parse(p.created_at) > at && Date.parse(p.created_at) < at + 6 * 3600_000);
      const t = String(next?.text ?? "");
      const k = pressed ? "AIX を押した" : !next || gapH > 24 ? "返事なし（24時間以内に無い）" : /ピックアップ|お探し|お送りさせて/.test(t) ? "ピックアップ・探すの約束" : "短い受け止め";
      tally[k] = (tally[k] ?? 0) + 1;
      if (ex.length < 14) ex.push(`${k} | 客: ${String(list[i].text).replace(/\n/g, " ").slice(0, 30)} → ${t.replace(/\n/g, " ").slice(0, 80)}`);
    }
  }
  console.log(`お客様の情報待ちの番（${DAYS}日・会話 ${convs.length}）: ${turns} → ${JSON.stringify(tally)}`);
  for (const e of ex) console.log("   " + e);
})();
