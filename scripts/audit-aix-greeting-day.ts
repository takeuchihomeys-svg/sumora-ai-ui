// scripts/audit-aix-greeting-day.ts — AIX の挨拶の「今日もう送ったか」を、全部の通で数える（旧）と会話文だけで数える（返信と同じ）で比べる（読むだけ・LLM なし）
//   2026-10-08 竹内さんの決定8「AIX の挨拶の判定を、返信と同じ数え方（🌟物件カード・見積の本体・資料の文は数えない）にそろえる」
//   AIX を押した時（aix_usage_logs.created_at）より前の今日のこちらの通で sentByStaffToday（旧）と staffTalkedToday（新）を出し、
//   判定が変わる押下で、実際に送った AIX の文（messages の line_message_id）の冒頭に「お世話になっております」があったか・スタッフが直したか（was_edited）を見る。
//   ※ 旧の判定で AI が挨拶を消していたので「送った文に挨拶が無い」はスタッフの意思とは限らない（直して足した数・直さず送った数を分けて出す）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-greeting-day.ts [--since=2026-07-01]
import { createClient } from "@supabase/supabase-js";
import { sentByStaffToday, staffTalkedToday } from "../app/lib/daily-greeting";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-07-01T00:00:00+09:00");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEAD_GREET = /^[^\n]{0,20}?(?:お世話になっております|夜分遅くに失礼)/;
const jstDayStart = (ms: number) => { const j = new Date(ms + 9 * 3600_000); return Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()) - 9 * 3600_000; };

type L = { conversation_id: string; aix_type: string | null; created_at: string; line_message_id: string | null; was_edited: boolean | null; generated_text: string | null };
async function main() {
  const logs: L[] = [];
  for (let i = 0; i < 100_000; i += 1000) {
    const r = await sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, line_message_id, was_edited, generated_text").gte("created_at", SINCE).not("line_message_id", "is", null).order("created_at").range(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    logs.push(...((r.data ?? []) as L[]));
    if ((r.data ?? []).length < 1000) break;
    await sleep(200);
  }
  const rows = logs.filter((l) => !isTestConversation(l.conversation_id));
  type Cell = { n: number; greet: number; editedAdd: number; editedDrop: number; samples: string[] };
  const cells: Record<string, Cell> = {};
  const cell = (k: string) => (cells[k] ??= { n: 0, greet: 0, editedAdd: 0, editedDrop: 0, samples: [] });
  const byType: Record<string, number> = {};
  for (const l of rows) {
    // 押した時 ≒ この AIX が送った通の最初の時刻。AIX の記録は送った後に書くので、送った通（🌟カード・画像・本文）の90秒前より前だけを「今日の前の通」にする
    const sent = await sb.from("messages").select("text, created_at").eq("conversation_id", l.conversation_id).eq("line_message_id", l.line_message_id!).limit(1).maybeSingle();
    const sentAt = (sent.data as { created_at: string } | null)?.created_at;
    if (!sentAt) continue;
    const at = Date.parse(sentAt) - 90_000;
    const from = new Date(jstDayStart(at)).toISOString();
    const today = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", l.conversation_id).eq("sender", "staff").gte("created_at", from).lt("created_at", new Date(at).toISOString()).order("created_at").limit(200);
    const msgs = ((today.data ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at }));
    const any = sentByStaffToday(msgs, at), talk = staffTalkedToday(msgs, at);
    const text = (sent.data as { text: string | null } | null)?.text ?? "";
    if (!text) continue;
    const k = `${any ? "旧=送った" : "旧=まだ"}／${talk ? "新=送った" : "新=まだ"}`;
    const c = cell(k);
    c.n++;
    const g = HEAD_GREET.test(text.trim());
    const gg = HEAD_GREET.test((l.generated_text ?? "").trim());
    if (g) c.greet++;
    if (g && !gg && l.generated_text) c.editedAdd++;
    if (!g && gg) c.editedDrop++;
    if (any && !talk) { byType[l.aix_type ?? "?"] = (byType[l.aix_type ?? "?"] ?? 0) + 1; if (c.samples.length < 8) c.samples.push(`${l.created_at.slice(0, 16)} ${l.aix_type} 挨拶${g ? "あり" : "なし"}${g && !gg ? "（スタッフが足した）" : ""}｜今日の前の通: ${msgs.map((m) => (m.text ?? "").slice(0, 14).replace(/\n/g, " ")).join(" / ").slice(0, 80)}`); }
    await sleep(40);
  }
  console.log(`AIX の押下（line_message_id あり・テスト除く・${SINCE}〜）: ${rows.length}`);
  for (const [k, c] of Object.entries(cells)) console.log(`${k}: ${c.n} 件・送った文の冒頭に挨拶 ${c.greet}（${Math.round((c.greet / Math.max(1, c.n)) * 100)}%）・スタッフが挨拶を足した ${c.editedAdd}・消した ${c.editedDrop}`);
  console.log("判定が変わる押下の AIX の種類:", byType);
  for (const [k, c] of Object.entries(cells)) if (c.samples.length) { console.log(`--- ${k} の見本`); for (const s of c.samples) console.log("  " + s); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
