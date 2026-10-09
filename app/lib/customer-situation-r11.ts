// app/lib/customer-situation-r11.ts — 11巡目（2026-10-08・r12 の調査⑧）: お客様の事情の種類を足す（決まった言い方だけで読む・純関数）
//   customer-circumstances.ts（〇日以降・遠方・体調…＝別の担当が編集中）とぶつからないよう別の部品にし、返信の「場面と返信方針」に短い注記で渡す。
//   種類と返し方（r12 の 40日 194番の調査＋竹内さんの手打ち）:
//     credit   審査・信用の不安（否決・夜の仕事・カードブラック・名義）→ 審査面の一文＋通りやすい保証会社（独立系）中心の物件を並行で
//     money    お金の用意ができる時期（給料日・ボーナス）→ その日以降の内覧・申込の段取り
//     self_see 自分で現地を見に行く → 現地でお待ち合わせしてご内覧も出来る
//     partner_hold 同居の人・家族と相談中で保留 → 物件を約束しない（相談の結果を待つ）
//     life     人生の出来事（別れ・離婚・出産・入院・転職）→「ご事情お聞かせ頂きありがとうございます😌！！」で受ける
//     agent    業者・代理で探している（自分のお客様・会社の人）→ 事実だけ渡す（呼び方は竹内さんに確認中）
//   ⚠ 2人で住む→「〇〇さん達」は竹内さんの返事待ち（呼び名）＝ここでは足さない
// 監査: scripts/audit-r11-customer-situation.ts（180日の当たりを目で読む・10/08: credit 133→フォームを外す・滞納は「滞納歴」だけ・life から転職を外した・self_see は 180日 0件）。戻す CUSTOMER_SITUATION_R11=off
import { takeuchiFormR13Enabled, LIFE_EVENT_NOTE, FAMILY_GROWS_RE, FAMILY_GROWS_NOTE } from "./takeuchi-reply-form-r13";
export type SituationKind = "credit" | "money" | "self_see" | "partner_hold" | "life" | "agent";
export const SITUATION_RE: Record<SituationKind, RegExp> = {
  credit: /(?:審査|保証会社)[^。\n]{0,10}(?:落ち|通ら|通れ|否決|不安|心配|厳し)|否決され|夜職|夜の(?:仕事|お仕事)|水商売|(?:カード|信用)?ブラック(?:リスト)?|滞納(?:歴|した事|したこと)|債務整理|自己破産|名義(?:を)?貸/,
  money: /給料(?:日|が入|入った|が出)|ボーナス(?:が|で|後)|(?:お金|費用|初期費用)[^。\n]{0,8}(?:用意|準備|貯ま|揃)/,
  self_see: /(?:自分で|一人で|先に)[^。\n]{0,6}(?:見に行|見て来|見てき|行ってみ)|外観(?:を|だけ)?(?:見に|見て)/,
  partner_hold: /(?:彼氏|彼女|同居人|旦那|主人|妻|嫁|夫|家族|親|母|父|両親)[^。\n]{0,6}(?:と|に)?(?:相談|聞いて|話して|確認して)(?:み|から|し)/,
  life: /別れ(?:る|た|ること)|離婚|出産|妊娠|赤ちゃん|(?:子供|子ども)が(?:産|生)まれ|家族が増え|入院|亡くな|失業|リストラ/,
  agent: /自分のお客様|お客様(?:の|が)住む|(?:不動産|仲介)(?:会社|業者)(?:の者|です|をして)|業者(?:です|の者)|会社の(?:人|社員|従業員)(?:が|の)住む/,
};
export const SITUATION_NOTE: Record<SituationKind, string> = {
  credit: "審査・信用の不安 → 「審査面も柔軟にサポートさせて頂きます」の一文＋通りやすい保証会社（独立系）中心のお部屋を並行でピックアップ",
  money: "お金の用意ができる時期の話 → その日以降の内覧・お申込みの段取りで（それより前の日を急かさない）",
  self_see: "ご自身で現地を見に行く → 「現地でお待ち合わせしてお部屋の中もご内覧頂けます」を添えてよい",
  partner_hold: "同居の方・ご家族と相談中 → ご相談の結果を待つ。新しい物件・見積を約束しない",
  life: "ご事情（人生の出来事）を話してくれた → ご事情に一言触れてから本題（例「ご事情お聞かせ頂きありがとうございます😌！！」「ご出産おめでとうございます！！」）",
  agent: "業者・代理でお部屋を探している（ご本人の入居ではない）",
};
export function customerSituationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CUSTOMER_SITUATION_R11 ?? "").toLowerCase() !== "off";
}
/** 今の番のお客様の文から事情の種類（URL・画像の書き起こし・申込フォームの行は読まない） */
export function readSituations(customerText: string): SituationKind[] {
  // 条件のフォーム（「お部屋探しご条件」）は項目の語（その他ご要望・保証会社）に当たるので読まない（180日の当たりを読んで外した）
  if (/お部屋探しご条件|お部屋お探し中/.test(String(customerText ?? ""))) return [];
  const t = String(customerText ?? "").normalize("NFKC").split("\n")
    .filter((l) => !/https?:\/\/|^\s*\[画像\]|【[^】]*】\s*[⇒→:：]|^[①-⑩]/.test(l)).join("\n");
  return (Object.keys(SITUATION_RE) as SituationKind[]).filter((k) => SITUATION_RE[k].test(t));
}
export function buildSituationNote(customerText: string, enabled = customerSituationEnabled()): string {
  if (!enabled) return "";
  const ks = readSituations(customerText);
  if (!ks.length) return "";
  // 2026-10-08 竹内さん「人生の出来事は決まり文句で受けるのではなく、その新しい状態に合わせた LINE」（takeuchi-reply-form-r13.LIFE_EVENT_NOTE・TAKEUCHI_FORM_R13=off で旧の一言）
  const noteOf = (k: SituationKind) => (k === "life" && takeuchiFormR13Enabled() ? `${LIFE_EVENT_NOTE}${FAMILY_GROWS_RE.test(customerText) ? `。${FAMILY_GROWS_NOTE}` : ""}` : SITUATION_NOTE[k]);
  return `- 🧭 お客様の事情（今の発言・決まった言い方で読んだ）: ${ks.map(noteOf).join(" ／ ")}`;
}
