// AIX【物件確認した】の「場面」と「文の構成」を、実送信と生成文で比べる（読み取りのみ）
//
// 2026-09-23 竹内「場面の部分と文の構成の部分に着眼して実際のLINEと生成される文の違いを分析する」
//
// 【なぜこの場面か】独立な3つの測り方すべてで最下位だった:
//   そのまま送信 23.9% ／ 半分以上書き直し 64.2% ／ 締めの能動のずれ 16.4%
//
// 【場面】確認の結果は1つではない。募集中／募集終了／複数件の混在／条件（設備・交渉）の回答 で
//   スタッフの書き方が変わるはず。まず場面を分けて数える。
// 【構成】行ごとの役割（挨拶・受領のお礼・結果報告・見積書の同封・次の一手・締め）に分け、
//   実送信と生成文で「どの役割が何%出るか」「順番」を比べる。
//
// ⚠ 竹内「物件確認したの部分だけでなくて通常返信も」→ TARGET で切り替える
//   TARGET=check（既定・AIX 物件確認した） ／ TARGET=plain（通常返信＝AIXなし・全体の53%）
//
// 🔴 2026-09-23 訂正（私の測り違い）: 最初は check を property_check_result* で**ひとまとめ**に数えて
//   「探索の継続が 実送信6.9% ／ 生成25.9%」と出し、そこを直そうとした。**型ごとに割ると別の絵**になる:
//     property_check_result_available   (67件) ピックアップ 実送信 0.0% ／ 生成  1.5%  ← ズレていない
//     property_check_result_unavailable (20件) ピックアップ 実送信35.0% ／ 生成100.0%  ← 穴はここだけ
//   available は per-property の固定テンプレなので元から揃っていた。混ぜたので穴の場所を取り違えた。
//   → ⑥で **必ず aix_action ごとに割って**見ること。全体の率だけで直す場所を決めない。
// 実行: npx tsx --env-file=.env.local scripts/audit-check-result-structure.ts [TARGET=check|plain] [DAYS=180] [SHOW=5]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました[^）]*）|\[返信不要\])\s*$/;

/** 場面（確認の結果は何だったか） */
const SCENES: Array<[string, RegExp]> = [
  ["募集中（空いている）", /現在?募集中|空室|ご案内(可能|出来)|内覧(可能|出来)/],
  ["募集終了（埋まった）", /募集(が)?(終了|終わ)|申込が入|埋ま(って|り)|募集(に)?出ていな|募集されていな/],
  ["条件・設備の回答", /(駐車場|ペット|エアコン|инドア|設備|フリーレント|礼金|敷金|更新料|退去|クリーニング)[^。\n]{0,20}(確認|とのこと|となり|可能|不可)/],
  ["交渉の結果", /(交渉|値引|割引)[^。\n]{0,16}(させて|しました|頂き|結果|可能|不可)/],
];

/** 文の構成（行の役割） */
const ROLES: Array<[string, RegExp]> = [
  ["呼びかけ＋挨拶", /お世話になっております|^[^\n]{0,12}さん\s*$/],
  ["お待たせ", /お待たせ(致しました|いたしました|しました)/],
  ["受領のお礼", /(お送り|ご送付|ご共有)(頂|いただ)き(まして)?ありがとう/],
  ["確認したと述べる", /確認(させて|いたしました|しました|致しました)/],
  ["結果の報告", /(現在?募集中|募集(が)?(終了|終わ)|空室|申込が入|ご案内(可能|出来)|とのこと(です|でした))/],
  ["見積書の同封（割引つき）", /最大限割引[^。\n]{0,12}(御見積書|お見積書|見積書)/],
  ["見積書の同封（短い形）", /(?<!最大限割引[^。\n]{0,12})(御見積書|お見積書|見積書)[^。\n]{0,10}(同封|お送り|ご査収)/],
  ["次の一手（内覧・申込）", /(ご内覧|ご案内|お申込)[^。\n]{0,14}(させて(頂き|いただき)|いかが|承っ|可能)/],
  ["次の一手（探索の継続）", /(ピックアップ|お探し|探させて|新着)[^。\n]{0,14}(させて(頂き|いただき)ます|お送り|出次第)/],
  ["ご査収ください", /ご査収(ください|下さい)/],
  ["受け身の締め", /(お知らせ|ご連絡|ご質問)[^。\n]{0,6}(ください|下さい)|お待ちしております/],
  ["何卒", /何卒(よろしく)?/],
];

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const SHOW = Number(process.env.SHOW ?? 5);
  const TARGET = (process.env.TARGET ?? "check").trim();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Row = { customer_message: string | null; ai_draft: string | null; sent_reply: string | null; aix_action: string | null };
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("customer_message, ai_draft, sent_reply, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const cases = rows.filter((r) => {
    const d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    if (!d || !s || MARK.test(d) || MARK.test(s)) return false;
    return TARGET === "plain" ? !r.aix_action : String(r.aix_action ?? "").startsWith("property_check_result");
  });
  console.log(`${TARGET === "plain" ? "通常返信（AIXなし）" : "AIX【物件確認した】"}で下書きと実送信が両方ある ${cases.length}件\n`);

  console.log(`① 場面（実送信が何を報告しているか）`);
  for (const [name, re] of SCENES) {
    const s = cases.filter((r) => re.test(r.sent_reply ?? "")).length;
    const a = cases.filter((r) => re.test(r.ai_draft ?? "")).length;
    console.log(`   ${name.padEnd(22)} 実送信 ${pct(s, cases.length).padStart(6)} ／ AI ${pct(a, cases.length).padStart(6)} ／ 差 ${((a - s) / cases.length * 100 >= 0 ? "+" : "") + ((a - s) / cases.length * 100).toFixed(1)}pt`);
  }

  console.log(`\n② 文の構成（どの役割が何%出るか）`);
  console.log(`   ${"役割".padEnd(26)} 実送信 ／ AI ／ 差`);
  for (const [name, re] of ROLES) {
    const s = cases.filter((r) => re.test(r.sent_reply ?? "")).length;
    const a = cases.filter((r) => re.test(r.ai_draft ?? "")).length;
    const d = (a - s) / cases.length * 100;
    const mark = Math.abs(d) >= 12 ? (d > 0 ? "  ← AI が書きすぎ" : "  ← AI が書けていない") : "";
    console.log(`   ${name.padEnd(26)} ${pct(s, cases.length).padStart(6)} ／ ${pct(a, cases.length).padStart(6)} ／ ${(d >= 0 ? "+" : "") + d.toFixed(1)}pt${mark}`);
  }

  console.log(`\n③ 行数と長さ`);
  const lines = (t: string) => t.split("\n").filter((l) => l.trim()).length;
  const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  console.log(`   実送信 ${med(cases.map((r) => lines(r.sent_reply ?? "")))}行・${med(cases.map((r) => (r.sent_reply ?? "").length))}字`);
  console.log(`   AI     ${med(cases.map((r) => lines(r.ai_draft ?? "")))}行・${med(cases.map((r) => (r.ai_draft ?? "").length))}字`);

  console.log(`\n④ 実送信の構成の型（役割の並び・上位）`);
  const seqOf = (t: string) => ROLES.filter(([, re]) => re.test(t)).map(([n]) => n).join(" → ");
  const seqs = new Map<string, number>();
  for (const r of cases) { const k = seqOf(r.sent_reply ?? ""); seqs.set(k, (seqs.get(k) ?? 0) + 1); }
  for (const [k, n] of [...seqs].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`   ${String(n).padStart(3)}件  ${k || "（役割なし）"}`);

  // ⑥ 型ごとに割る（全体の率で直す場所を決めないための歯止め・2026-09-23 の取り違えの再発防止）
  if (TARGET !== "plain") {
    console.log(`\n⑥ 型（aix_action）ごとに割る ← ここを見ないと穴の場所を取り違える`);
    const byAction = new Map<string, Row[]>();
    for (const r of cases) { const k = r.aix_action ?? "(なし)"; const a = byAction.get(k) ?? []; a.push(r); byAction.set(k, a); }
    for (const [k, list] of [...byAction].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`   ${k}（${list.length}件）`);
      for (const [name, re] of ROLES) {
        const s = list.filter((r) => re.test(r.sent_reply ?? "")).length;
        const a = list.filter((r) => re.test(r.ai_draft ?? "")).length;
        const d = (a - s) / list.length * 100;
        if (Math.abs(d) < 12) continue; // ズレている役割だけ出す
        console.log(`      ${name.padEnd(26)} ${pct(s, list.length).padStart(6)} ／ ${pct(a, list.length).padStart(6)} ／ ${(d >= 0 ? "+" : "") + d.toFixed(1)}pt${d > 0 ? "  ← AI が書きすぎ" : "  ← AI が書けていない"}`);
      }
    }
  }

  console.log(`\n⑤ 実物（実送信とAIを並べる・${SHOW}件）`);
  for (const r of cases.slice(0, SHOW)) {
    console.log(`\n   客   : ${one(r.customer_message ?? "").slice(0, 60)}`);
    console.log(`   AI   : ${one(r.ai_draft ?? "").slice(0, 120)}`);
    console.log(`   実送信: ${one(r.sent_reply ?? "").slice(0, 120)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
