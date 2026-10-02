// scripts/audit-returning-customer-form.ts
// 2026-10-02 ⑫ 22巡の分類（B: first_contact_05「お世話になっております。まだ家探ししてるのですが、相談よろしいでしょうか？」→ スタッフは返信＋AIX【条件ヒアリング】）:
//   しばらく止まっていた後に戻ってきたお客様の番で、スタッフが条件ヒアリング（フォーム）を押した割合を、止まっていた日数で分けて数える。読むだけ・LLM なし
// 実行: npx tsx --env-file=.env.local scripts/audit-returning-customer-form.ts [--days=120]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=120").slice(7));
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
export const RETURNING_RE = /(?:まだ|また|再度|改めて|引き続き)[^。\n]{0,10}(?:家探し|部屋探し|お部屋探し|探して|探し)|お久しぶり|ご無沙汰/;
(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<{ conversation_id: string; sender: string; created_at: string; text: string | null }>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text").gte("created_at", new Date(Date.now() - (DAYS + 120) * 86_400_000).toISOString()).order("created_at").order("id").range(f, t));
  const presses = await readAll<{ conversation_id: string; aix_type: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at").gte("created_at", since).eq("aix_type", "condition_hearing").range(f, t));
  const by = new Map<string, typeof msgs>(); for (const m of msgs) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const cells: Record<string, { n: number; form: number; ex: string[] }> = {};
  for (const [cid, ms] of by) {
    if (cid.startsWith("dd34f5b0")) continue;
    for (let i = 1; i < ms.length; i++) {
      const m = ms[i]; if (m.sender !== "customer" || ms[i - 1].sender === "customer" || m.created_at < since) continue;
      const gapDays = (Date.parse(m.created_at) - Date.parse(ms[i - 1].created_at)) / 86_400_000;
      const said = RETURNING_RE.test(m.text ?? "");
      if (gapDays < 7 && !said) continue;
      const k = `${gapDays >= 30 ? "30日以上" : gapDays >= 7 ? "7〜30日" : "7日未満"}×${said ? "戻った言い方あり" : "言い方なし"}`;
      const form = presses.some((p) => p.conversation_id === cid && Date.parse(p.created_at) > Date.parse(m.created_at) && Date.parse(p.created_at) < Date.parse(m.created_at) + 24 * 3600_000);
      const c = (cells[k] ??= { n: 0, form: 0, ex: [] }); c.n++; if (form) c.form++;
      if (said && c.ex.length < 3) c.ex.push(`${form ? "フォーム" : "なし"} | ${String(m.text).replace(/\n/g, " ").slice(0, 60)}`);
    }
  }
  console.log(`止まっていた後のお客様の番（${DAYS}日）: スタッフが24時間以内に AIX【条件ヒアリング】を押した割合`);
  for (const [k, c] of Object.entries(cells).sort()) { console.log(`  ${k}: ${c.n}番 → フォーム ${c.form}（${Math.round((c.form / c.n) * 100)}%）`); for (const e of c.ex) console.log(`     ${e}`); }
})();
