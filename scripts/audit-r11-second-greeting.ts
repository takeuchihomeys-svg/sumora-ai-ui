// scripts/audit-r11-second-greeting.ts — 11巡目（10/08 竹内「AIX テンプレート竹内の方に寄せる」）: AIX（物件オススメ・見積書）の直後の竹内さんの2通目が挨拶から始まるかを、
//   その日の前の会話文の有無・AIX の文の挨拶の有無で数える。読むだけ・LLM なし。
// 実行: npx tsx --env-file=.env.local scripts/audit-r11-second-greeting.ts [property_recommendation,estimate_sheet] [2026-08-01]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
async function readAll(q: (f: number, t: number) => any) { const out: any[] = []; for (let i = 0; ; i += 1000) { const r = await q(i, i + 999); if (r.error) throw r.error; out.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break; } return out; }
const ms = (s: string) => Date.parse(s);
const jstDay = (s: string) => new Date(ms(s) + 9 * 3600_000).toISOString().slice(0, 10);
(async () => {
  const types = (process.argv[2] ?? "property_recommendation").split(",");
  const ps = await readAll((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").in("aix_type", types).gte("created_at", process.argv[3] ?? "2026-08-01").order("created_at").range(f, t));
  const convs = [...new Set(ps.map((r) => r.conversation_id))];
  const msgs: any[] = [];
  for (let i = 0; i < convs.length; i += 100) msgs.push(...await readAll((f, t) => sb.from("messages").select("conversation_id, created_at, staff_writer, is_aix_generated, text, sender, image_url").in("conversation_id", convs.slice(i, i + 100)).gte("created_at", "2026-07-25").order("created_at").range(f, t)));
  const mBy = new Map<string, any[]>(); for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const st: Record<string, number> = {};
  const bump = (k: string) => (st[k] = (st[k] ?? 0) + 1);
  const ex: string[] = [];
  for (const p of ps) {
    const t = ms(p.created_at); const all = mBy.get(p.conversation_id) ?? [];
    const aixMsgs = all.filter((m) => m.sender !== "customer" && m.is_aix_generated && Math.abs(ms(m.created_at) - t) < 15 * 60_000);
    if (!aixMsgs.length) continue;
    const lastAix = Math.max(...aixMsgs.map((m) => ms(m.created_at)));
    const firstAix = Math.min(...aixMsgs.map((m) => ms(m.created_at)));
    const second = all.find((m) => m.sender !== "customer" && !m.is_aix_generated && !m.image_url && ms(m.created_at) > lastAix && ms(m.created_at) <= lastAix + 20 * 60_000 && (m.text ?? "").length > 8);
    if (!second) continue;
    if (all.some((m) => m.sender === "customer" && ms(m.created_at) > lastAix && ms(m.created_at) < ms(second.created_at))) continue;
    if (second.staff_writer !== "takeuchi") continue;
    const day = jstDay(new Date(firstAix).toISOString());
    const priorToday = all.some((m) => m.sender !== "customer" && ms(m.created_at) < firstAix - 1000 && jstDay(m.created_at) === day && (m.text ?? "").length > 3);
    const aixHasGreet = aixMsgs.some((m) => /お世話になっております|お待たせ/.test(m.text ?? ""));
    const greet = /^[^\n]{0,16}(お世話になっております|お待たせ致しました|夜分遅くに)/.test(second.text ?? "") || /^[^\n]{0,12}さん\n(お世話になっております|お待たせ)/.test(second.text ?? "");
    const k = `${p.aix_type}｜今日の前の送信${priorToday ? "あり" : "なし"}｜AIXの文に挨拶${aixHasGreet ? "あり" : "なし"}`;
    bump(`${k}｜n`); if (greet) bump(`${k}｜挨拶あり`);
    if (!priorToday && !aixHasGreet && ex.length < 8) ex.push(`${second.created_at.slice(0, 10)} ${greet ? "挨拶" : "なし"}｜${(second.text ?? "").replace(/\n/g, "⏎").slice(0, 90)}`);
  }
  for (const [k, v] of Object.entries(st).sort()) console.log(k, v);
  for (const e of ex) console.log("  " + e);
})();
