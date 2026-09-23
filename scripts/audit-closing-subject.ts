// 締めの「主語」のずれを測る（AI は『お知らせください』、スタッフは『お送りします』）（読み取りのみ）
//
// 2026-09-23 竹内「このずれは改善されてるんかな？」
//   直前に見つけたずれ: ピックアップ／新着の型は合っているのに、
//     AI  「…ピックアップさせていただきますので、お気軽にお知らせください！」（お客様に行動を求めて終わる）
//     実送信「日々新着物件確認させて頂き…新着で新しく出次第お送りさせて頂きます」（こちらが動き続ける）
//
// ⚠ 設計知見「繰り返しは禁止にできない」: 「お気軽にご連絡ください」は実送信の締めの2位で、
//   それ自体は正しい。問題は**能動の宣言が1つも無く、受け身だけで終わる**こと。
//   だから「受け身があるか」ではなく「**能動が無いか**」で数える。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-closing-subject.ts [DAYS=180] [SHOW=6]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました[^）]*）|\[返信不要\])\s*$/;

/** こちらが動く宣言（能動） */
const ACTIVE = /(させて(頂き|いただき)ます|いたします|します)[^。\n]{0,4}[！!。]?$|(お送り|ご連絡|ご案内|確認|ピックアップ|お探し|探させて|作成|交渉|手配|進め)[^。\n]{0,10}(させて(頂き|いただき)ます|いたします|します)/;
/** お客様に行動を求める（受け身の締め） */
const PASSIVE = /(お知らせ|ご連絡|ご質問|お申し付け|お問い合わせ|教えて)[^。\n]{0,6}(ください|下さい)|お待ちしております|ご検討[^。\n]{0,6}(ください|下さい|よろしく)/;

/** 行ごとに見て「能動の宣言が1つでもあるか」 */
const hasActive = (t: string) => t.split(/\n|。/).some((l) => ACTIVE.test(l.trim()));
const hasPassive = (t: string) => PASSIVE.test(t);

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const SHOW = Number(process.env.SHOW ?? 6);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Row = { created_at: string; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; aix_action: string | null };
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("created_at, customer_message, ai_draft, sent_reply, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const cases = rows.filter((r) => {
    const d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    return d && s && !MARK.test(d) && !MARK.test(s);
  });
  console.log(`直近${days}日 ${cases.length}件（下書きと実送信が両方ある）\n`);

  const row = (name: string, f: (t: string) => boolean) => {
    const a = cases.filter((r) => f(r.ai_draft ?? "")).length;
    const s = cases.filter((r) => f(r.sent_reply ?? "")).length;
    console.log(`   ${name.padEnd(30)} AI ${pct(a, cases.length).padStart(6)} ／ スタッフ ${pct(s, cases.length).padStart(6)} ／ 差 ${((a - s) / cases.length * 100 >= 0 ? "+" : "") + ((a - s) / cases.length * 100).toFixed(1)}pt`);
  };
  console.log(`① 締めの主語`);
  row("能動の宣言がある（こちらが動く）", hasActive);
  row("受け身の締めがある", hasPassive);
  row("**能動が1つも無い**", (t) => !hasActive(t));
  row("受け身だけ（能動が無く受け身あり）", (t) => !hasActive(t) && hasPassive(t));

  console.log(`\n② AI とスタッフのずれ（同じ場面で比べる）`);
  const aiPassiveOnly = cases.filter((r) => !hasActive(r.ai_draft ?? "") && hasActive(r.sent_reply ?? ""));
  const staffPassiveOnly = cases.filter((r) => hasActive(r.ai_draft ?? "") && !hasActive(r.sent_reply ?? ""));
  console.log(`   AI に能動が無く、スタッフは能動を書いた   ${String(aiPassiveOnly.length).padStart(4)}件（${pct(aiPassiveOnly.length, cases.length)}）← これがずれ`);
  console.log(`   AI に能動があり、スタッフは書かなかった   ${String(staffPassiveOnly.length).padStart(4)}件（${pct(staffPassiveOnly.length, cases.length)}）`);

  console.log(`\n③ AIX の種類別（どの場面でずれるか）`);
  const kinds = [...new Set(cases.map((r) => r.aix_action ?? "通常返信"))]
    .sort((a, b) => cases.filter((r) => (r.aix_action ?? "通常返信") === b).length - cases.filter((r) => (r.aix_action ?? "通常返信") === a).length);
  for (const k of kinds.slice(0, 8)) {
    const xs = cases.filter((r) => (r.aix_action ?? "通常返信") === k);
    if (xs.length < 20) continue;
    const gap = xs.filter((r) => !hasActive(r.ai_draft ?? "") && hasActive(r.sent_reply ?? "")).length;
    console.log(`   ${String(k).padEnd(30)} ${String(xs.length).padStart(4)}件 ／ ずれ ${pct(gap, xs.length)}`);
  }

  console.log(`\n④ 実物（AI に能動が無く、スタッフは書いた・${SHOW}件）`);
  for (const r of aiPassiveOnly.slice(0, SHOW)) {
    console.log(`\n   客   : ${one(r.customer_message ?? "").slice(0, 60)}`);
    console.log(`   AI   : ${one(r.ai_draft ?? "").slice(0, 92)}`);
    console.log(`   実送信: ${one(r.sent_reply ?? "").slice(0, 92)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
