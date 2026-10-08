// scripts/audit-customer-circumstances.ts — 把握「お客様の事情」（app/lib/customer-circumstances.ts）の当たりを目で読む・人が触れたかを数える（読むだけ・LLM なし）
//   お客様の発言（--days 日・YUMA・身内を除く）に extractCircumstances を当て、種類ごとの件数と実物（言葉・暦日）を出す。
//   あわせて「その後の最初のこちらの手打ち（48時間以内）」が事情に触れたか（種類ごとの言葉）を数える＝人が使っている事情か。
// 実行: npx tsx --env-file=.env.local scripts/audit-customer-circumstances.ts [--days=180] [--show=available_from] [--n=40]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { extractCircumstances, type CircumstanceKind } from "../app/lib/customer-circumstances";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180")); const SHOW = arg("show", ""); const N = Number(arg("n", "40"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };
const ECHO: Record<CircumstanceKind, RegExp> = {
  available_from: /以降|以後|ご帰国|お戻り|ご都合|抑え|オンライン|撮影/, cannot_come_soon: /抑え|オンライン|撮影|ご都合|落ち着/,
  remote: /オンライン|撮影|動画|写真|遠方|抑え/, life_timing: /更新|転勤|異動|移動先|ご出産|退去|時期|月/,
  companion: /彼氏|彼女|ご主人|旦那|奥様|ご家族|ご両親|お母様|お父様|パートナー|ご相談|お二人|皆様/, health: /お大事|ご無理|ご静養|落ち着|体調/,
};
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs: M[] = [];
  for (let i = 0; i < 400_000; i += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message); msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }
  const agg = new Map<CircumstanceKind, { n: number; replied: number; echo: number; ex: string[] }>();
  for (const [cid, list] of by) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i]; if (m.sender !== "customer") continue;
      const cs = extractCircumstances([{ text: m.text, createdAt: m.created_at }], Date.parse(m.created_at));
      if (!cs.length) continue;
      // その後の最初のこちらの手打ち（48時間以内・AIX でない）
      const T = Date.parse(m.created_at);
      const reply = list.slice(i + 1).find((x) => x.sender !== "customer" && !x.is_aix_generated && Date.parse(x.created_at) - T <= 48 * 3600_000 && (x.text ?? "").length > 10);
      for (const c of cs) {
        const a = agg.get(c.kind) ?? { n: 0, replied: 0, echo: 0, ex: [] };
        a.n++; if (reply) { a.replied++; if (ECHO[c.kind].test(reply.text ?? "")) a.echo++; }
        const from = c.fromDayMs != null ? new Date(c.fromDayMs + 9 * 3600_000).toISOString().slice(5, 10) : "";
        if (a.ex.length < N) a.ex.push(`${m.created_at.slice(5, 16)} ${cid.slice(0, 6)} ${from ? `[${from}〜] ` : ""}「${c.quote}」→ 人:${(reply?.text ?? "（手打ちなし）").replace(/\s+/g, " ").slice(0, 90)}`);
        agg.set(c.kind, a);
      }
    }
  }
  for (const [k, a] of agg) console.log(`${k.padEnd(18)} n=${a.n} 手打ちの返事あり ${a.replied}・事情に触れた ${a.echo}（${a.replied ? Math.round((a.echo / a.replied) * 100) : 0}%）`);
  for (const [k, a] of agg) if (!SHOW || k === SHOW) { console.log(`\n== ${k}`); for (const e of a.ex) console.log("  " + e); }
}
main().catch((e) => { console.error(e); process.exit(1); });
