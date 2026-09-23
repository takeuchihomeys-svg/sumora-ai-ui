// AI の下書きとスタッフの実送信で「ピックアップ型／新着型」がズレていないかを測る（読み取りのみ）
//
// 2026-09-23 竹内「ピックアップ出来次第と新着で物件のところの場面の違いを研究。
//   基本的にすべて物件ピックアップしてる形となるから、新しい条件などが送られたり条件広げるなどない限り、
//   新着の物件探す方向で LINE を入れている」
//
// 実送信での裏付け（scripts/audit-pickup-vs-newarrival.ts・180日・948件）:
//   直前に新しい条件あり 268件 → ピックアップ **96.3%**
//   新着型138件のうち **94.9%** が「既に物件を送った後」（ピックアップ型は49.0%）
//   ＝ 竹内さんの説明どおり。分かれ目は「新しい条件・依頼が来たか」。
//
// ここで測るのは**AI が使い分けているか**。設計知見「どちらが正しいかは生成文と実送信の差分で決める」。
//   下書きがピックアップ型 → 実送信が新着型 ＝ スタッフが直した ＝ AI が使い分けられていない
//
// 実行: npx tsx --env-file=.env.local scripts/audit-pickup-newarrival-diff.ts [DAYS=180] [SHOW=6]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const one = (s: string) => s.replace(/\s+/g, " ").trim();
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました[^）]*）|\[返信不要\])\s*$/;

const PICKUP = /(ピックアップ|お探し|探させて|探して)[^。\n]{0,14}(お送り|送らせて|ご連絡|させて(頂き|いただき)ます|出来次第|でき次第)/;
const NEW_ARRIVAL = /新着[^。\n]{0,20}(出次第|出ましたら|入り次第|ご紹介|お送り|お知らせ)|新[^。\n]{0,4}(物件|お部屋)[^。\n]{0,12}(出次第|出ましたら|募集に出|入り次第)/;
const kindOf = (t: string) => {
  const p = PICKUP.test(t), n = NEW_ARRIVAL.test(t);
  return p && n ? "両方" : p ? "ピックアップ" : n ? "新着" : "なし";
};
/** お客様から新しい条件・依頼が来たか（竹内さんの分かれ目。「似た物件も」「他も」まで含める） */
const NEW_REQUEST = /(エリア|駅|沿線|区|市|町)[^。\n]{0,10}(も|でも|変更|追加|広げ|変え)|(家賃|予算|賃料)[^。\n]{0,10}(まで|以内|変更|上げ|下げ)|\d+(?:\.\d+)?万|[0-9]LDK|[0-9]DK|[0-9]K|ワンルーム|(ペット|駐車場|バストイレ別|独立洗面|オートロック|南向き|角部屋|築[0-9]+年)|(似た|似て|同じような|他|ほか|もう少し|もっと|別の)[^。\n]{0,10}(物件|お部屋|ところ|紹介|探し)/;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const SHOW = Number(process.env.SHOW ?? 6);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  type Row = { conversation_id: string | null; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; aix_action: string | null };
  const rows: Row[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("conversation_id, customer_message, ai_draft, sent_reply, aix_action")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const usable = rows.filter((r) => {
    const d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    return d && s && !MARK.test(d) && !MARK.test(s);
  });
  // どちらかに「次に送る約束」が入っている例だけを見る
  const cases = usable.filter((r) => kindOf(r.ai_draft ?? "") !== "なし" || kindOf(r.sent_reply ?? "") !== "なし");
  console.log(`直近${days}日 ${usable.length}件 ／ 次に物件を送る約束が入っている ${cases.length}件\n`);

  const pair = new Map<string, number>();
  for (const r of cases) pair.set(`${kindOf(r.ai_draft ?? "")} → ${kindOf(r.sent_reply ?? "")}`, (pair.get(`${kindOf(r.ai_draft ?? "")} → ${kindOf(r.sent_reply ?? "")}`) ?? 0) + 1);
  console.log(`① 下書き → 実送信 の型の変化`);
  for (const [k, n] of [...pair].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(28)} ${String(n).padStart(5)}件（${pct(n, cases.length)}）`);

  const changedToNew = cases.filter((r) => kindOf(r.ai_draft ?? "") === "ピックアップ" && kindOf(r.sent_reply ?? "") === "新着");
  const changedToPickup = cases.filter((r) => kindOf(r.ai_draft ?? "") === "新着" && kindOf(r.sent_reply ?? "") === "ピックアップ");
  console.log(`\n② スタッフが型を入れ替えた`);
  console.log(`   ピックアップ → 新着  ${String(changedToNew.length).padStart(4)}件  ← AI が「探す」と書いたが、スタッフは「新着待ち」にした`);
  console.log(`   新着 → ピックアップ  ${String(changedToPickup.length).padStart(4)}件`);

  console.log(`\n③ 新しい条件・依頼の有無で、AI と スタッフの選び方が合っているか`);
  const row = (name: string, xs: Row[]) => {
    if (xs.length < 5) return;
    const aiNew = xs.filter((r) => kindOf(r.ai_draft ?? "") === "新着").length;
    const stNew = xs.filter((r) => kindOf(r.sent_reply ?? "") === "新着").length;
    console.log(`   ${name.padEnd(22)} ${String(xs.length).padStart(4)}件 ／ 新着を選んだ AI ${pct(aiNew, xs.length).padStart(6)} ／ スタッフ ${pct(stNew, xs.length).padStart(6)}`);
  };
  row("新しい条件・依頼あり", cases.filter((r) => NEW_REQUEST.test(r.customer_message ?? "")));
  row("新しい条件・依頼なし", cases.filter((r) => !NEW_REQUEST.test(r.customer_message ?? "")));

  console.log(`\n④ 実物（AI がピックアップ → スタッフが新着にした例・${SHOW}件）`);
  for (const r of changedToNew.slice(0, SHOW)) {
    console.log(`\n   客   : ${one(r.customer_message ?? "").slice(0, 70)}`);
    console.log(`   AI   : ${one(r.ai_draft ?? "").slice(0, 96)}`);
    console.log(`   実送信: ${one(r.sent_reply ?? "").slice(0, 96)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
