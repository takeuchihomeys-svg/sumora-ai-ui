// scripts/audit-r10-viewing-day-greeting.ts — 10巡目（10/08 竹内さん「挨拶は…内覧を忘れないため」）: 確定した内覧の当日に、こちらが内覧前の挨拶を送ったか・
//   お客様の発言を待たずに送ったか（先に送った／お客様の発言の後）を、待ち合わせ場所の AIX（messages.is_aix_generated の待ち合わせの文）から数える（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-r10-viewing-day-greeting.ts [--since=2026-06-26]
import { createClient } from "@supabase/supabase-js";
import { extractViewingAppointment, appointmentYmd } from "../app/lib/action-ledger";
import { VIEWING_DAY_GREETED_RE } from "../app/lib/viewing-day-greeting";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SINCE = process.argv.find((a) => a.startsWith("--since="))?.slice(8) ?? "2026-06-26T00:00:00Z";
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null; staff_writer: string | null };
(async () => {
  const out: M[] = [];
  for (let i = 0; ; i += 1000) { const r = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", SINCE).order("created_at").range(i, i + 999); if (r.error) throw new Error(r.error.message); out.push(...((r.data ?? []) as M[])); if ((r.data ?? []).length < 1000) break; }
  const by = new Map<string, M[]>(); for (const m of out) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const jstYmd = (s: string) => new Date(Date.parse(s) + 9 * 3600_000).toISOString().slice(0, 10);
  const c: Record<string, number> = {}; const ex: string[] = [];
  for (const [, ms] of by) {
    const seen = new Set<string>();
    for (const m of ms) {
      if (m.sender === "customer") continue;
      const a = extractViewingAppointment(m.text, m.created_at);
      if (!a?.dateMD || !/待ち合わせ|現地エントランス|住所/.test(m.text ?? "")) continue;
      const ymd = appointmentYmd(a.dateMD, m.created_at);
      if (!ymd || seen.has(ymd) || ymd === jstYmd(m.created_at)) { if (ymd) seen.add(ymd); continue; } // 当日に決めた内覧は数えない
      seen.add(ymd);
      const day = ms.filter((x) => jstYmd(x.created_at) === ymd);
      if (!day.length) { c["その日 何も無し（記録の外・キャンセル？）"] = (c["その日 何も無し（記録の外・キャンセル？）"] ?? 0) + 1; continue; }
      const g = day.find((x) => x.sender !== "customer" && VIEWING_DAY_GREETED_RE.test(String(x.text ?? "").normalize("NFKC")));
      const firstCust = day.find((x) => x.sender === "customer");
      const k = !g ? "当日の挨拶なし" : !firstCust || Date.parse(g.created_at) < Date.parse(firstCust.created_at) ? "お客様より先に挨拶" : "お客様の発言の後に挨拶";
      c[k] = (c[k] ?? 0) + 1;
      c[`${k}｜書き手=${g?.staff_writer ?? "-"}`] = (c[`${k}｜書き手=${g?.staff_writer ?? "-"}`] ?? 0) + 1;
      if (ex.length < 12 && g) ex.push(`${ymd} ${k}「${String(g.text).replace(/\n/g, "⏎").slice(0, 70)}」`);
    }
  }
  console.log(Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join("\n"));
  console.log(ex.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
