// scripts/audit-trust-repeat.ts — 書き手の下書きで、信頼の言い回しの核（compose-order-table の TRUST_PHRASES）を何回繰り返しているか（AI を呼ばない・読むだけ）
//
// 2026-11-12 作業員10（竹内さん「言い回しも同じのを何回も使わないように臨機応変に」）。
//   本番の下書き（line_watch_turns.draft_first）と竹内さんの送信（staff_texts）で、言い回しの核ごとに「出た下書きの数・割合」を並べ、
//   同じ会話の中で同じ核が続いた回数（直前の下書きにも出ていた）も数える。DB を読むので営業時間の外（22時以降）に流す。
// 実行: npx tsx --env-file=.env.local scripts/audit-trust-repeat.ts [--days=14] [--limit=2000]
import { createClient } from "@supabase/supabase-js";
import { trustRepeatCount, TRUST_PHRASES } from "../app/lib/compose-order-table";

const args = process.argv.slice(2);
const arg = (k: string, d = "") => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
if (h >= 9 && h < 22 && !args.includes("--force")) { console.error("営業時間（9〜22時）は DB を読まない（--force で上書き）"); process.exit(1); }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const since = new Date(Date.now() - Number(arg("days", "14")) * 86_400_000).toISOString();
  const limit = Number(arg("limit", "2000"));
  const rows: Array<{ conversation_id: string; customer_turn_at: string; draft_first: string | null; staff_texts: string[] | null }> = [];
  for (let from = 0; rows.length < limit; from += 500) {
    const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, draft_first, staff_texts").gte("created_at", since).not("draft_first", "is", null).order("id").range(from, from + 499);
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < 500) break;
  }
  const drafts = rows.map((r) => r.draft_first ?? "");
  const sent = rows.flatMap((r) => (r.staff_texts ?? []).slice(0, 1));
  const d = trustRepeatCount(drafts), s = new Map(trustRepeatCount(sent).map((x) => [x.key, x]));
  // 同じ会話で直前の下書きにも同じ核が出ていた（続けて使った）回数
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) { const l = byConv.get(r.conversation_id) ?? []; l.push(r); byConv.set(r.conversation_id, l); }
  const streak = new Map<string, number>();
  for (const l of byConv.values()) { l.sort((a, b) => a.customer_turn_at.localeCompare(b.customer_turn_at)); for (let i = 1; i < l.length; i++) for (const p of TRUST_PHRASES) if (p.re.test(l[i].draft_first ?? "") && p.re.test(l[i - 1].draft_first ?? "")) streak.set(p.key, (streak.get(p.key) ?? 0) + 1); }
  console.log(`下書き ${drafts.length}・送信 ${sent.length}（${arg("days", "14")}日）`);
  console.log("言い回しの核｜下書きに出た数（割合）｜送信に出た数（割合）｜同じ会話で続けて使った回数");
  for (const x of d) console.log(`- ${x.key}｜${x.drafts}（${Math.round(x.share * 100)}%）｜${s.get(x.key)?.drafts ?? 0}（${Math.round((s.get(x.key)?.share ?? 0) * 100)}%）｜${streak.get(x.key) ?? 0}`);
})();
