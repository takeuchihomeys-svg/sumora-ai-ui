// 通常返信（＝自動返信になる経路）で、AI とスタッフの「返し方の型」がどう違うかを数える（読み取りのみ）
//
// 2026-09-23 竹内「通常返信が自動返信の部分になるのでかなり重要。ずれている部分の本質や足りていない部分は調査可能か」
//   → 大幅に書き直された実物を読むと、混入（FINAL_CHECK・作業メモ）は 0.4% しかなく、
//     31% の書き直しの説明にならなかった。実物に見えた型の違いを数える。
//
// 実物で見えた仮説（これを数える）:
//   A) AI は「これから確認します」と宣言する ／ スタッフは**すでに答えを持っていて即答する**
//      例: お客様「外見の写真アップにして見ることは可能ですか？」
//          AI  「外観の写真ご用意できるか確認させて頂きます」
//          実送信「【外観室内イメージ】https://…」
//   B) AI は物件名を本文に挙げる ／ スタッフは挙げずに短く受ける
//      例: AI「フォーリアライズ難波リアンとエスリード難波グレイスの募集状況確認させて頂きます」
//          実送信「お部屋お送りいただきありがとうございます😊！！／お部屋の募集状況確認させていただきます！！」
//   C) AI は日程を出さない ／ スタッフは具体的な日時を出す
//      例: AI「ご内覧可否確認させて頂きます」／実送信「9/21（月）12:00〜16:00の間でご案内可能です」
//   D) 長さの違い
//
// 実行: npx tsx --env-file=.env.local scripts/audit-plain-reply-shape.ts [DAYS=180]
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = { ai_draft: string | null; sent_reply: string | null; ai_similarity: number | null; aix_action: string | null };
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|（AI返信の生成に失敗しました[^）]*）|\[返信不要\])\s*$/;
const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;

/** これから確認する・調べるという宣言（まだ答えていない） */
const WILL_CHECK = /(確認|お調べ|問い合わせ|聞いて)[^。\n]{0,10}(させて(頂き|いただき)ます|いたします|します)|確認(出来|でき)次第/;
/** すでに答えている印（結果・事実・URL・金額・日時） */
const ANSWERED = /(となります|でございます|可能です|募集中|募集終了|出来ます|できます)|https?:\/\/|[0-9０-９,]{3,}円|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\/\d{1,2}/;
/** 物件名らしい固有名詞（カタカナ4字以上＋号室 or 連続カタカナ） */
const PROPERTY_NAME = /[ァ-ヶー]{4,}(?:[\sA-Za-zＡ-Ｚa-z0-9０-９]{0,6})?(?:\d{3,4}号室|[ⅠⅡⅢIVX]{1,3})?/g;
const PROPERTY_HIT = (t: string) => {
  const m = t.match(PROPERTY_NAME) ?? [];
  // 一般語のカタカナを外す（オススメ・ピックアップ 等）
  const NG = /^(オススメ|ピックアップ|エリア|マンション|アパート|ハイツ|コーポ|レジデンス|サポート|スケジュール|キャンセル|フォーマット|メッセージ|ファイル|コンロ|トイレ|キッチン|クローゼット|エアコン|オートロック|バルコニー|リフォーム|リノベ|インターネット|ネット|ガス|ペット|コメント|ポイント|パターン|タイミング|チェック|アドバイス|セキュリティ)/;
  return m.some((w) => w.length >= 4 && !NG.test(w));
};
/** 具体的な日時 */
const HAS_DATETIME = /\d{1,2}\s*[\/月]\s*\d{1,2}[日]?[^\n]{0,6}(\d{1,2}\s*[:：時])|\d{1,2}\s*[:：]\s*\d{2}/;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows: Row[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("ai_draft, sent_reply, ai_similarity, aix_action").gte("created_at", since)
      .order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Row[]; rows.push(...r); if (r.length < 1000) break;
  }
  const plain = rows.filter((r) => {
    const d = (r.ai_draft ?? "").trim(), s = (r.sent_reply ?? "").trim();
    return !r.aix_action && d && s && !MARK.test(d) && !MARK.test(s);
  });
  console.log(`直近${days}日の通常返信（下書きと実送信が両方ある）${plain.length}件\n`);

  const row = (name: string, f: (t: string) => boolean) => {
    const d = plain.filter((r) => f(r.ai_draft ?? "")).length;
    const s = plain.filter((r) => f(r.sent_reply ?? "")).length;
    const gap = (d - s) / plain.length * 100;
    console.log(`   ${name.padEnd(30)} AI ${pct(d, plain.length).padStart(6)} ／ スタッフ ${pct(s, plain.length).padStart(6)} ／ 差 ${(gap >= 0 ? "+" : "") + gap.toFixed(1)}pt`);
  };
  console.log(`① 返し方の型（AI の下書き vs スタッフの実送信）`);
  row("これから確認しますと宣言", (t) => WILL_CHECK.test(t));
  row("すでに答えている（結果・URL・金額・日時）", (t) => ANSWERED.test(t));
  row("物件名を本文に書く", PROPERTY_HIT);
  row("具体的な日時を出す", (t) => HAS_DATETIME.test(t));

  console.log(`\n② 「確認します」だけで終わっているか（答えを1つも持たずに宣言だけ）`);
  const onlyCheck = (t: string) => WILL_CHECK.test(t) && !ANSWERED.test(t);
  row("確認宣言だけ・答えなし", onlyCheck);

  console.log(`\n③ 長さ`);
  console.log(`   AI ${med(plain.map((r) => (r.ai_draft ?? "").length))}字 ／ スタッフ ${med(plain.map((r) => (r.sent_reply ?? "").length))}字`);

  console.log(`\n④ 「AI が確認宣言だけ・スタッフは答えている」組み合わせ（＝材料が足りていない場面）`);
  const gapCases = plain.filter((r) => onlyCheck(r.ai_draft ?? "") && ANSWERED.test(r.sent_reply ?? ""));
  console.log(`   ${gapCases.length}件（通常返信の ${pct(gapCases.length, plain.length)}）／ 似ている度の中央値 ${med(gapCases.map((r) => r.ai_similarity ?? 0)).toFixed(3)}`);
  const other = plain.filter((r) => !(onlyCheck(r.ai_draft ?? "") && ANSWERED.test(r.sent_reply ?? "")));
  console.log(`   それ以外 ${other.length}件 ／ 似ている度の中央値 ${med(other.map((r) => r.ai_similarity ?? 0)).toFixed(3)}`);
  console.log(`\n   実物（5件）`);
  for (const r of gapCases.slice(0, 5)) {
    console.log(`   ── AI    : ${(r.ai_draft ?? "").replace(/\n/g, " / ").slice(0, 86)}`);
    console.log(`      実送信 : ${(r.sent_reply ?? "").replace(/\n/g, " / ").slice(0, 86)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
