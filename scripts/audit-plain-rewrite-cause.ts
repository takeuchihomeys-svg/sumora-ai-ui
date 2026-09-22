// 通常返信が大幅に書き直された例を「なぜ書き直されたか」で分類する（読み取りのみ）
//
// 2026-09-23 竹内「ずれている部分の本質や足りていない部分は調査可能か」
//   ここまでで分かったこと: 混入（FINAL_CHECK・作業メモ）は全体の0.4%、返し方の型の差は3〜7pt。
//   どちらも「大幅書き直し31%」の説明にならなかった。
//   → 上位（似ている度が低い順）に並べて読むと混入が目立ったので、**書き直された例の中だけで**
//     原因の内訳を数える（混入は件数は少ないが、似ている度を大きく下げているはず）。
//
// 分類（上から順に当てる。1件は1つに数える）:
//   ①混入      … FINAL_CHECK・JSON・作業メモ・生成失敗の印が本文にある＝そもそも文になっていない
//   ②答えを持っていない … AI は「確認します」だけ／スタッフは結果・URL・金額・日時を出している
//   ③場面が違う … AI とスタッフで話題の語が1つも重ならない＝読み違い
//   ④言い方だけ … 話題は重なるが言い回しが違う
//
// 実行: npx tsx --env-file=.env.local scripts/audit-plain-rewrite-cause.ts [DAYS=180] [MAX_SIM=0.35] [N=6]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = { created_at: string; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; ai_similarity: number | null; aix_action: string | null };
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました[^）]*）|\[返信不要\])\s*$/;
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\n+/g, " / ").replace(/\s+/g, " ").trim();

const CONTAMINATED = /<<<|>>>|"(ok|issues|severity|passes_completed)"\s*:|AI返信の生成に失敗しました|定義が不明確|ご確認させていただきたい点|(情報を持ち合わせていない|持ち合わせておりません).{0,20}(ため|ので)/;
const WILL_CHECK = /(確認|お調べ|問い合わせ)[^。\n]{0,10}(させて(頂き|いただき)ます|いたします|します)|確認(出来|でき)次第/;
const ANSWERED = /(となります|でございます|可能です|募集中|募集終了|出来ます|できます)|https?:\/\/|[0-9０-９,]{3,}円|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\/\d{1,2}/;
/** 話題の語（内容語）。定型の挨拶・締めは落とす */
const topics = (s: string) => new Set(
  (s.match(/[一-龥]{2,}|[ァ-ヶー]{3,}/g) ?? []).filter((w) =>
    !/^(世話|連絡|確認|返信|何卒|宜敷|了解|承知|失礼|本日|明日|今日|担当|対応|場合|内容|以下|以上|必要|可能|頂き|致します|御座|ございます|お客様|お手数|お願|ありがとう|よろしく|かしこまり)/.test(w)),
);

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const MAX_SIM = Number(process.env.MAX_SIM ?? 0.35);
  const N = Number(process.env.N ?? 6);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("created_at, customer_message, ai_draft, sent_reply, ai_similarity, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const plain = rows.filter((r) => {
    const d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    return !r.aix_action && d && s && !MARK.test(d) && !MARK.test(s) && typeof r.ai_similarity === "number";
  });
  const worst = plain.filter((r) => (r.ai_similarity ?? 1) < MAX_SIM);
  console.log(`通常返信 ${plain.length}件（似ている度が付いている物）／ 似ている度 ${MAX_SIM} 未満 ${worst.length}件（${pct(worst.length, plain.length)}）\n`);

  const buckets: Record<string, Row[]> = { "①混入（文になっていない）": [], "②答えを持っていない": [], "③場面が違う（読み違い）": [], "④言い方だけ": [] };
  for (const r of worst) {
    const d = r.ai_draft ?? "", s = r.sent_reply ?? "";
    if (CONTAMINATED.test(d)) { buckets["①混入（文になっていない）"].push(r); continue; }
    if (WILL_CHECK.test(d) && !ANSWERED.test(d) && ANSWERED.test(s)) { buckets["②答えを持っていない"].push(r); continue; }
    const td = topics(d), ts = topics(s);
    let share = 0; for (const w of td) if (ts.has(w)) share++;
    if (td.size > 0 && ts.size > 0 && share === 0) { buckets["③場面が違う（読み違い）"].push(r); continue; }
    buckets["④言い方だけ"].push(r);
  }
  console.log(`【なぜ書き直されたか】`);
  for (const [k, v] of Object.entries(buckets)) console.log(`   ${k.padEnd(24)} ${String(v.length).padStart(4)}件（${pct(v.length, worst.length)}）`);

  for (const [k, v] of Object.entries(buckets)) {
    if (v.length === 0) continue;
    console.log(`\n${"═".repeat(72)}\n■ ${k}（${v.length}件・実物${Math.min(N, v.length)}件）`);
    for (const r of v.slice(0, N)) {
      console.log(`\n  ${new Date(Date.parse(r.created_at) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ")} 似ている度 ${(r.ai_similarity ?? 0).toFixed(3)}`);
      console.log(`  お客様 : ${one(r.customer_message ?? "").slice(0, 78)}`);
      console.log(`  AI     : ${one(r.ai_draft ?? "").slice(0, 104)}`);
      console.log(`  実送信 : ${one(r.sent_reply ?? "").slice(0, 104)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
