// scripts/audit-apply-after-hours-line.ts — AIX【申込へ】の「管理会社営業時間外…明日無事1番手でお申込完了しているか確認」の一文の線（読むだけ）
// 2026-10-01 YUMA の再生: お客様が「608で申し込みしたいです」と言っただけ（申込フォームはまだ）の番で、生成の文に営業時間外の一文が足されていた。
//   スタッフの実送信は「かしこまりました！！お申込させて頂きます！！」＋申込フォーム（一文なし）。申込の情報を受け取る前か後かで分けて数える。
// 実行: npx tsx --env-file=.env.local scripts/audit-apply-after-hours-line.ts [--days=180]
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { isMgmtAfterHours, APPLY_INFO_SENT_RE } from "../app/lib/after-hours";
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 180);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data: ps } = await sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").gte("created_at", since).order("created_at");
  const cells: Record<string, { n: number; line: number; ex: string[] }> = {};
  for (const p of (ps ?? []) as Array<{ conversation_id: string; created_at: string }>) {
    if (isTestConversation(p.conversation_id)) continue;
    const at = Date.parse(p.created_at);
    const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", p.conversation_id)
      .gte("created_at", new Date(at - 6 * 3600_000).toISOString()).lte("created_at", new Date(at + 10 * 60_000).toISOString()).order("created_at");
    const rows = (ms ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>;
    const before = rows.filter((m) => Date.parse(m.created_at) <= at);
    const cust = before.filter((m) => m.sender === "customer").slice(-3).map((m) => m.text ?? "").join("\n");
    const sent = rows.filter((m) => m.sender !== "customer" && Date.parse(m.created_at) >= at - 60_000).map((m) => m.text ?? "").join("\n");
    const k = `${isMgmtAfterHours(p.created_at) ? "営業時間外" : "営業時間内"}・${APPLY_INFO_SENT_RE.test(cust) ? "申込の情報を受け取った後" : "受け取る前"}`;
    const c = (cells[k] ??= { n: 0, line: 0, ex: [] });
    c.n++;
    if (/営業時間外/.test(sent)) c.line++;
    if (c.ex.length < 8) c.ex.push(`${/営業時間外/.test(sent) ? "一文あり" : "一文なし"}｜C:${cust.replace(/\n/g, " ").slice(0, 50)}｜S:${sent.replace(/\n/g, " ").slice(0, 80)}`);
  }
  for (const [k, c] of Object.entries(cells)) { console.log(`${k.padEnd(24)} n=${c.n} 営業時間外の一文=${c.line}`); for (const e of c.ex) console.log(`    ${e}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
