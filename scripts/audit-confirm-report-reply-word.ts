// scripts/audit-confirm-report-reply-word.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-confirm-report-reply-word.ts [--days=180] [--show=80]
//
// 2026-10-06 竹内さん（R 事例）「ここは確認した で管理会社にエアコンを確認した事を入れる形となる」:
//   R 10/5 10:41 スタッフ手打ち「管理会社にエアコンの件確認させていただき、リビング洋室共に備わっております。とのご返答でした！！」が
//   確認結果の報告として記録されず（sent_facts に行なし）、【必ず】設備の確認→ご連絡（10/4 16:09）が開いたまま・台帳は「確認約束未履行」。
//   原因: 報告の語彙が「とのご返答がございました／頂きました」だけで「とのご返答でした」（です・でした）を持っていなかった。
// 線を引く: スタッフの文で「との(ご)?(連絡|返答|返事|回答)(でした|です|となります)」に当たる通を全部出し、
//   今の分類（confirmation_reported か）と、その通が本当に確認結果の報告か（目で読む）を並べる。読み取りのみ・LLM なし。
//   出力は会話の文を含むので共有しない。
import { createClient } from "@supabase/supabase-js";
import { classifyStaffTextFacts } from "../app/lib/action-ledger";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=")[1];
const days = Number(arg("days", "180"));
const show = Number(arg("show", "80"));
const since = new Date(Date.now() - days * 86400_000).toISOString();

const WORD_RE = /との(?:ご)?(?:連絡|返答|返事|回答)(?:でした|です|となります)/;

async function main() {
  const rows: Array<{ conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, text, created_at, is_aix_generated")
      .eq("sender", "staff").gte("created_at", since).or("text.ilike.%とのご返答%,text.ilike.%との返答%,text.ilike.%とのご回答%,text.ilike.%との回答%,text.ilike.%とのご返事%,text.ilike.%との返事%,text.ilike.%とのご連絡%,text.ilike.%との連絡%")
      .order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const hits = rows.filter((r) => WORD_RE.test(r.text ?? ""));
  let reported = 0, notReported = 0;
  const lines: string[] = [];
  for (const r of hits) {
    const facts = classifyStaffTextFacts(r.text ?? "", r.created_at);
    const rep = facts.find((f) => f.kind === "confirmation_reported");
    if (rep) reported++; else notReported++;
    lines.push(`${rep ? "報告" : "なし"}｜要件=${rep?.detail?.object ?? "-"}｜${r.is_aix_generated ? "AIX" : "手打ち"}｜${r.conversation_id.slice(0, 8)} ${r.created_at.slice(0, 16)}\n   ${String(r.text ?? "").replace(/\n/g, " ／ ").slice(0, 220)}`);
  }
  console.log(`=== 「との(ご)返答/回答/返事/連絡 でした/です/となります」${days}日: 候補 ${rows.length}通 → 当たる ${hits.length}通（報告として記録 ${reported}・記録なし ${notReported}）===`);
  for (const l of lines.slice(0, show)) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
