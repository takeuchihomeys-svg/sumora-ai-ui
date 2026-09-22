// 下書き本文に「お客様に送ってはいけない物」が混ざっていないかを数える（読み取りのみ）
//
// 2026-09-23 竹内「通常返信が自動返信の部分になるのでかなり重要。ずれている部分の本質や足りていない部分は調査可能か」
//   → 大幅に書き直された通常返信の実物を読んだら、本文が悪いのではなく**混入**が原因の例が並んでいた。
//     自動返信はスタッフが直さないので、混ざったまま送られる。
//
// 数えるもの:
//   ① <<<FINAL_CHECK:{...} — 最終チェックの結果 JSON が本文に残っている
//   ② AI の作業メモ（「情報を持ち合わせていないため」「定義が不明確です」「ご確認させていただきたい点」等）
//   ③ 生成失敗の印が下書きとして保存されている
//   ④ その他の制御っぽい印（<<< >>> ・ ```json 等）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-draft-contamination.ts [DAYS=180]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = { created_at: string; conversation_id: string | null; ai_draft: string | null; sent_reply: string | null; was_ai_used: boolean | null; aix_action: string | null };
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(2)}%`);
const jstMonth = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 7);

const CHECKS: Array<[string, RegExp]> = [
  ["最終チェックのJSONが本文に残る", /<<<\s*FINAL_CHECK/],
  ["制御の印（<<< >>>）", /<<<(?!\s*FINAL_CHECK)|>>>/],
  ["コードブロック（```）", /```/],
  ["AIの作業メモ（〜のため対応します/不明確です/ご確認させていただきたい点）", /(情報を持ち合わせていない|持ち合わせておりません).{0,20}(ため|ので)|定義が不明確|ご確認させていただきたい点|下記フォーマットの通り対応|再生成をお試し/],
  ["生成失敗の印", /AI返信の生成に失敗しました/],
  ["JSONの断片", /"(ok|issues|severity|passes_completed)"\s*:/],
];

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("created_at, conversation_id, ai_draft, sent_reply, was_ai_used, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const withDraft = rows.filter((r) => (r.ai_draft ?? "").trim());
  console.log(`直近${days}日の下書き ${withDraft.length}件（うち通常返信 ${withDraft.filter((r) => !r.aix_action).length}件）\n`);

  for (const [name, re] of CHECKS) {
    const hit = withDraft.filter((r) => re.test(r.ai_draft ?? ""));
    if (hit.length === 0) { console.log(`✓ ${name}: 0件`); continue; }
    // ⚠ 設計知見「差分に出た重大な不具合は月別に数えてから直す」: 既に直っている過去の傷を掘り返さない
    const byMonth = new Map<string, number>();
    for (const h of hit) byMonth.set(jstMonth(h.created_at), (byMonth.get(jstMonth(h.created_at)) ?? 0) + 1);
    const months = [...byMonth].sort();
    const sentHit = hit.filter((r) => re.test(r.sent_reply ?? ""));
    console.log(`\n⚠ ${name}: 下書き ${hit.length}件（${pct(hit.length, withDraft.length)}）／ **実送信にも残った ${sentHit.length}件**`);
    console.log(`   月別: ${months.map(([m, n]) => `${m} ${n}件`).join(" ／ ")}`);
    console.log(`   通常返信 ${hit.filter((r) => !r.aix_action).length}件 ／ AIXあり ${hit.filter((r) => !!r.aix_action).length}件`);
    const ex = hit[hit.length - 1];
    const m = (ex.ai_draft ?? "").match(re);
    const at = (ex.ai_draft ?? "").indexOf(m?.[0] ?? "");
    console.log(`   一番新しい例（${jstMonth(ex.created_at)}）: …${(ex.ai_draft ?? "").slice(Math.max(0, at - 40), at + 60).replace(/\n/g, " / ")}…`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
