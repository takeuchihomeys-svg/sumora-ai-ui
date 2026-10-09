// scripts/audit-r11-wording-exits.ts — 11巡目: 出口 app/lib/takeuchi-wording-r11.fixTakeuchiWording を
//   (a) 竹内さんの手打ち（180日）に当てて変わる通（＝誤って竹内さんの文を変える数・0 が条件）(b) 本番の下書き（60日・line_watch_turns と ai_reply_examples）で変わる通 を数え、
//   変わった前後を目で読めるように並べる（読むだけ・LLM なし）
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-wording-exits.ts [--days=180] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { fixTakeuchiWording } from "../app/lib/takeuchi-wording-r11";
import { cleanDraft } from "../app/lib/line-watch-judge";
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180")), SHOW = Number(arg("show", "20"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
(async () => {
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const msgs = await readAll<{ conversation_id: string; text: string | null; staff_writer: string | null; is_aix_generated: boolean | null }>((f, t) => sb.from("messages").select("conversation_id, text, staff_writer, is_aix_generated").eq("sender", "staff").eq("staff_writer", "takeuchi").gte("created_at", since).order("created_at").range(f, t));
  let n = 0, ch = 0; const kinds = new Map<string, number>(); const ex: string[] = [];
  for (const m of msgs) {
    if (isTestConversation(m.conversation_id) || m.is_aix_generated || !(m.text ?? "").trim()) continue;
    n++; const r = fixTakeuchiWording(m.text!, true);
    if (r.changes.length) { ch++; for (const c of r.changes) { const k = c.split(":")[0]; kinds.set(k, (kinds.get(k) ?? 0) + 1); } if (ex.length < SHOW) ex.push(`${r.changes.join(" / ")}｜${m.text!.replace(/\n/g, "⏎").slice(0, 100)}`); }
  }
  console.log(`(a) 竹内さんの手打ち ${n}通で変わる ${ch}通: ${[...kinds].map(([k, v]) => `${k} ${v}`).join("・")}`);
  for (const e of ex) console.log("  竹", e);
  const since60 = new Date(Date.now() - 60 * 864e5).toISOString();
  const lwt = await readAll<{ conversation_id: string; draft_last: string | null }>((f, t) => sb.from("line_watch_turns").select("conversation_id, draft_last").gte("customer_turn_at", since60).range(f, t));
  let dn = 0, dch = 0; const dk = new Map<string, number>(); const dex: string[] = [];
  for (const w of lwt) {
    const d = cleanDraft(w.draft_last).text; if (!d || isTestConversation(w.conversation_id)) continue;
    dn++; const r = fixTakeuchiWording(d, true);
    if (r.changes.length) { dch++; for (const c of r.changes) { const k = c.split(":")[0]; dk.set(k, (dk.get(k) ?? 0) + 1); } if (dex.length < SHOW) dex.push(`${r.changes.join(" / ")}\n     前:${d.replace(/\n/g, "⏎").slice(0, 110)}\n     後:${r.text.replace(/\n/g, "⏎").slice(0, 110)}`); }
  }
  console.log(`(b) 本番の下書き ${dn}通（60日）で変わる ${dch}通: ${[...dk].map(([k, v]) => `${k} ${v}`).join("・")}`);
  for (const e of dex) console.log("  下", e);
})().catch((e) => { console.error(e); process.exitCode = 1; });
