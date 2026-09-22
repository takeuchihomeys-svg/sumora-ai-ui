// 通常返信（AIXなし＝自動返信になる経路）で大幅に書き直された例を、下書きと実送信を並べて読む（読み取りのみ）
//
// 2026-09-23 竹内「通常返信が自動返信の部分になるのでかなり重要。ずれている部分の本質や足りていない部分は調査可能か」
//
// ⚠ 設計知見「人の目を通らない経路は既存の品質指標が付かない」:
//   自動返信オンの会話はスタッフが直さないので、ここで読めるのは**スタッフが確認した分**だけ。
//   ただし生成の経路は同じなので、ここで直されている内容＝自動返信ならそのまま送られていた内容。
//
// 設計知見「実物を1通持ってくる（想像で始めない）」。率ではなく本文を並べて読む。
// 実行: npx tsx --env-file=.env.local scripts/peek-plain-reply-rewrites.ts [DAYS=120] [N=14] [MAX_SIM=0.35]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = { created_at: string; conversation_id: string | null; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; ai_similarity: number | null; aix_action: string | null };
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました）|\[返信不要\])\s*$/;
const one = (s: string) => s.replace(/\n+/g, " / ").replace(/\s+/g, " ").trim();

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const N = Number(process.env.N ?? 14);
  const MAX_SIM = Number(process.env.MAX_SIM ?? 0.35);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("created_at, conversation_id, customer_message, ai_draft, sent_reply, ai_similarity, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const plain = rows.filter((r) => {
    const d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    return !r.aix_action && d && s && !MARK.test(d) && !MARK.test(s) && typeof r.ai_similarity === "number";
  });
  const worst = plain.filter((r) => (r.ai_similarity ?? 1) < MAX_SIM).sort((a, b) => (a.ai_similarity ?? 1) - (b.ai_similarity ?? 1));
  console.log(`通常返信 ${plain.length}件 ／ 似ている度 ${MAX_SIM} 未満（＝別の文に書き直された）${worst.length}件（${((worst.length / plain.length) * 100).toFixed(1)}%）\n`);
  console.log(`${"═".repeat(76)}`);
  for (const r of worst.slice(0, N)) {
    console.log(`\n■ ${new Date(Date.parse(r.created_at) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ")}  似ている度 ${(r.ai_similarity ?? 0).toFixed(3)}  ${(r.conversation_id ?? "").slice(0, 8)}`);
    console.log(`  お客様 : ${one(r.customer_message ?? "").slice(0, 110)}`);
    console.log(`  AI     : ${one(r.ai_draft ?? "").slice(0, 150)}`);
    console.log(`  実送信 : ${one(r.sent_reply ?? "").slice(0, 150)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
