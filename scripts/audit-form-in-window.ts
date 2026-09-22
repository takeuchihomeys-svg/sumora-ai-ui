// 「DeepSeek に回りうる会話（申込以降ではない）」の直近15通に、お客様の申込フォームが混ざる頻度（読み取りのみ・LLM 不使用）
// 2026-09-23 竹内「問題は個人情報を deepseek 側が読み取ること」
// 実行: npx tsx --env-file=.env.local scripts/audit-form-in-window.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { isApplicationPayload } from "../app/lib/pii-pseudonym";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];

async function main() {
  const days = Number(arg("days", "30"));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let p = 0; p < 40; p++) {
    const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at").gte("created_at", since).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    const r = (data ?? []) as typeof rows; rows.push(...r); if (r.length < 1000) break;
  }
  const { data: convs } = await sb.from("conversations").select("id, status");
  const statusOf = new Map(((convs ?? []) as Array<{ id: string; status: string | null }>).map((c) => [c.id, String(c.status ?? "")]));
  const by = new Map<string, typeof rows>();
  for (const m of rows) { if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }

  let routable = 0, routableWithForm = 0, skipped = 0, skippedWithForm = 0;
  const examples: string[] = [];
  for (const [cid, arr] of by) {
    const last15 = arr.slice(-15);
    const hasForm = last15.some((m) => isApplicationPayload(m.text ?? ""));
    const post = DRAFT_SKIP_STATUSES.has(statusOf.get(cid) ?? "");
    if (post) { skipped++; if (hasForm) skippedWithForm++; continue; }
    routable++;
    if (hasForm) { routableWithForm++; if (examples.length < 10) examples.push(`${cid.slice(0, 8)} 状態=${statusOf.get(cid) || "（無し）"}`); }
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  console.log(`直近${days}日に動いた会話 ${by.size}件`);
  console.log(`  申込以降（DeepSeek に回さない）: ${skipped}件 ／ うち直近15通に申込フォーム ${skippedWithForm}件`);
  console.log(`  回りうる会話: ${routable}件 ／ うち直近15通に申込フォーム ${routableWithForm}件（${pct(routableWithForm, routable)}）`);
  for (const e of examples) console.log(`     ${e}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
