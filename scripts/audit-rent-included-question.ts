// scripts/audit-rent-included-question.ts
// 実行: npx tsx --env-file=.env.local scripts/audit-rent-included-question.ts      （DAYS=365 既定・読み取りのみ・何も書かない）
//
// 2026-10-01 竹内「『家賃込の価格でしょうか？』…家賃込みだけの部分ならAIXじゃなくて自動返信からでも大丈夫」:
//   お客様の発言のうち、家賃が含まれるかの語がある通（広い候補）を全部並べ、
//     ・rent-included-question.isRentIncludedQuestion（家賃込みかだけ）に当たるか
//     ・cost-breakdown.customerAsksCostComposition（初期費用の中身＝AIX【初期費用について】）に当たるか
//     ・その後スタッフが何をしたか（2時間以内に押した AIX／最初の手打ちの返信）
//   を目で読む。線は「当たる通でスタッフが AIX を押していない（手打ちで答えた）」こと
import { createClient } from "@supabase/supabase-js";
import { isRentIncludedQuestion } from "../app/lib/rent-included-question";
import { customerAsksCostComposition } from "../app/lib/cost-breakdown";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 365);
const SINCE = new Date(Date.now() - DAYS * 86400_000).toISOString();
/** 広い候補（家賃・前家賃と、込み・含む・入っての語） */
const BROAD_RE = /(?:家賃|前家賃)[^\n。]{0,12}(?:込|含|入って|入る)/;

type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 300; p++) { const { data, error } = await q(p * 1000, p * 1000 + 999); if (error) throw new Error(error.message); const r = data ?? []; out.push(...r); if (r.length < 1000) break; }
  return out;
}
const one = (s: string | null | undefined, n = 90) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

async function main() {
  const cands = (await pageAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").eq("sender", "customer").gte("created_at", SINCE).or("text.ilike.%家賃%込%,text.ilike.%家賃%含%,text.ilike.%家賃%入って%").order("created_at").range(f, t)))
    .filter((m) => !isTestConversation(m.conversation_id) && BROAD_RE.test(m.text ?? "") && !/^\[画像\]/.test(m.text ?? ""));
  let hit = 0, hitAix = 0, s9 = 0;
  for (const m of cands) {
    const t0 = Date.parse(m.created_at);
    const { data: after } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", m.conversation_id)
      .gt("created_at", m.created_at).lt("created_at", new Date(t0 + 2 * 3600_000).toISOString()).order("created_at").limit(8);
    const { data: aix } = await sb.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", m.conversation_id)
      .gt("created_at", m.created_at).lt("created_at", new Date(t0 + 2 * 3600_000).toISOString()).order("created_at").limit(3);
    const staff = (after ?? []).find((x) => x.sender !== "customer");
    const r = isRentIncludedQuestion(m.text);
    const c = customerAsksCostComposition(m.text ?? "");
    if (r) { hit++; if ((aix ?? []).length) hitAix++; }
    if (c) s9++;
    console.log(`${r ? "◎家賃込み" : "　　　　"} ${c ? "S9" : "  "} ${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)}「${one(m.text, 70)}」`);
    console.log(`        → AIX: ${(aix ?? []).map((a) => a.aix_type).join(",") || "なし"}／スタッフ${staff?.is_aix_generated ? "(AIX文)" : "(手打ち)"}: ${one(staff?.text, 110)}`);
  }
  console.log(`\n候補 ${cands.length}通・家賃込みかだけ ${hit}通（うち2時間以内に AIX 押下 ${hitAix}）・初期費用の中身（S9）${s9}通`);
}
main().catch((e) => { console.error(e); process.exit(1); });
