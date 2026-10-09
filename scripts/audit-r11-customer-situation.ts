// scripts/audit-r11-customer-situation.ts — 11巡目: app/lib/customer-situation-r11.readSituations を 180日のお客様の発言に当てて、種類ごとの件数と当たりの実物を出す（目で読む・LLM なし）
//   あわせて、その番の竹内さんの手打ちが注記の向き（審査面・お気軽に…）に触れたかの率も出す
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-customer-situation.ts [--days=180] [--show=12] [--kind=credit]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { readSituations, type SituationKind } from "../app/lib/customer-situation-r11";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180")), SHOW = Number(arg("show", "12")), KIND = arg("kind", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
const STAFF_HIT: Record<SituationKind, RegExp> = {
  credit: /審査|保証会社|独立系/, money: /以降|給料|ご用意/, self_see: /現地|ご内覧|ご案内/, partner_hold: /ご相談|お話し|お待ちして/,
  life: /ご事情|お聞かせ/, agent: /お客様|ご依頼|業者/,
};
(async () => {
  const msgs: Array<{ conversation_id: string; sender: string; created_at: string; text: string | null; staff_writer: string | null; is_aix_generated: boolean | null }> = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from("messages").select("conversation_id, sender, created_at, text, staff_writer, is_aix_generated").gte("created_at", new Date(Date.now() - DAYS * 864e5).toISOString()).order("created_at").order("id").range(i, i + 999); if (r.error) throw r.error; msgs.push(...(r.data ?? []) as typeof msgs); if ((r.data ?? []).length < 1000) break; }
  const by = new Map<string, typeof msgs>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const cnt = new Map<SituationKind, { n: number; tk: number; tkHit: number; ex: string[] }>();
  for (const [cid, list] of by) {
    if (isTestConversation(cid)) continue;
    for (let i = 0; i < list.length; i++) {
      const m = list[i]; if (m.sender !== "customer") continue;
      const ks = readSituations(m.text ?? ""); if (!ks.length) continue;
      const next = list.slice(i + 1).find((x) => x.sender === "staff" && !x.is_aix_generated);
      for (const k of ks) {
        const c = cnt.get(k) ?? { n: 0, tk: 0, tkHit: 0, ex: [] }; c.n++;
        if (next?.staff_writer === "takeuchi") { c.tk++; if (STAFF_HIT[k].test(next.text ?? "")) c.tkHit++; }
        if (c.ex.length < SHOW && (!KIND || KIND === k)) c.ex.push(`${(m.text ?? "").replace(/\n/g, " ").slice(0, 90)}｜次:${(next?.text ?? "").replace(/\n/g, " ").slice(0, 60)}`);
        cnt.set(k, c);
      }
    }
  }
  for (const [k, c] of cnt) {
    console.log(`\n■ ${k}: ${c.n}発言・次の手打ちが竹内さん ${c.tk}（注記の向きに触れた ${c.tkHit}）`);
    if (!KIND || KIND === k) for (const e of c.ex) console.log("  " + e);
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
