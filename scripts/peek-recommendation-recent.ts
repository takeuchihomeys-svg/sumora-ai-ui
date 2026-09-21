// AIX【物件オススメ】の直近の実送信をそのまま読む（読み取りのみ）
//
// 2026-09-21 竹内「別のスタッフが送ってる質の悪い言い回しもあるから、そこも含めて改善する。直近の会話をみて。」
//
// ☆付きの手本 331件を測ったら質の低い物は無かった（既存の関門も 0件しか落としていない）。
// ＝ 質の悪い言い回しは**手本ではなく実送信の側**にある（pgvector は☆でない実送信も引く）。
// なので直近の実送信をそのまま並べて目で読む（設計知見「実物を1通持ってくる・件数だけ見ない」）。
//
// 実行: LIMIT=40 npx tsx --env-file=.env.local scripts/peek-recommendation-recent.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const LIMIT = Number(process.env.LIMIT ?? 30);
const DAYS = Number(process.env.DAYS ?? 30);
/** ⚠ 個人情報はマスキング（名前・電話番号） */
const mask = (s: string) => s
  // ⚠ 広く取りすぎると本文を食う（「1LDK・家賃…の〇〇さん」→「1LDK・家〈お客様〉」になった）。
  //   名前らしい2〜6文字だけに絞る（数字・記号・長い語は名前ではない）
  .replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,6}(?:さん|様|さま)/g, "〈お客様〉")
  .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "〈電話番号〉");

async function main() {
  const { data, error } = await sb.from("ai_reply_examples")
    .select("id, sent_reply, ai_draft, is_starred, entry_source, was_ai_used, created_at")
    .eq("aix_action", "property_recommendation")
    .gte("created_at", new Date(Date.now() - DAYS * 86400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(LIMIT);
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`=== AIX【物件オススメ】直近${DAYS}日の実送信 ${rows.length}件 ===\n`);
  rows.forEach((r, i) => {
    const s = mask(String(r.sent_reply ?? "")).trim();
    const d = String(r.ai_draft ?? "").trim();
    console.log(`${"─".repeat(78)}`);
    console.log(`【${i + 1}】${String(r.created_at).slice(0, 16)}  ${r.is_starred ? "☆" : "　"} ${r.entry_source ?? "-"} ${d ? (d === String(r.sent_reply).trim() ? "そのまま送信" : "スタッフが直した") : "下書きなし"}  ${s.length}字`);
    console.log(s.split("\n").map((l) => `   ${l}`).join("\n"));
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
