// app/lib/viewed-state-line.ts — 申込までの地図の駅「内覧後」（viewed）の中の状態の1行（#739・2026-11-28 作業員A・統括役の決め）
//   120日の照らし（node=viewed 38番・竹内さん本人 10番）: 竹内さんの外れ 8/10（答える 5・待つ 3）。地図の次の一手は「気に入ったお部屋はお申込みでお部屋を抑える」。
//   申込まで届いた割合（全員）: 申込の誘い（返信）5/5・AIX【申込へ】4/4・待つ 4/5・答える 6/19。＝内覧後の番は「申込へ誘える番か、まず答える番か」の見分けが要る。
//   ここは事実だけを決まった計算で並べる（ブレインに決め直させない・何をするかは書かない）:
//     内覧はいつ済んだか（行動台帳の viewingDone・内覧のお礼の日）／内覧の後のお客様の通に 感想の語・申込の意思の語・問い があるか／その後こちらが申込に誘ったか
//   VIEWED_STATE_LINE（既定 off・段階で読む）・印 material_marks.viewed_state（字数）
import { stagedOn, STAGE_OFF } from "./switch-stage";

type Env = Record<string, string | undefined>;
export const viewedStateLineOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => stagedOn("VIEWED_STATE_LINE", env, STAGE_OFF);

export const IMPRESSION_GOOD_RE = /気に入|良かった|よかった|良い|いい感じ|素敵|綺麗|きれい|広かった|明るかった|ここが一番/;
export const IMPRESSION_WORRY_RE = /微妙|狭かった|狭い|暗かった|気になる|気になりました|うーん|迷って|悩んで|検討/;
export const APPLY_INTENT_RE = /申込|申し込|お申込|ここにします|ここに決め|決めたい|契約したい|進めたい/;
const QUESTION_RE = /[?？]|ですか|でしょうか|ますか/;
const OUR_APPLY_INVITE_RE = /お申込|お申し込み|お部屋(?:を)?(?:抑え|押さえ)/;

type Msg = { sender: string; text: string | null; created_at: string };
/** msgs は新しい順。viewedAt は内覧が済んだと分かった時（内覧のお礼の時刻）。読めなければ "" */
export function viewedStateLine(i: { msgs: ReadonlyArray<Msg>; viewedAt: string | null; nowMs: number }): string {
  const t0 = Date.parse(String(i.viewedAt ?? ""));
  if (!Number.isFinite(t0)) return "";
  const after = i.msgs.filter((m) => Date.parse(m.created_at) >= t0);
  const cust = after.filter((m) => m.sender === "customer").map((m) => String(m.text ?? ""));
  const ours = after.filter((m) => m.sender !== "customer").map((m) => String(m.text ?? ""));
  const days = Math.max(0, Math.floor((i.nowMs - t0) / 86_400_000));
  const facts: string[] = [`内覧は ${days === 0 ? "今日" : `${days}日前`}に済んだ`];
  facts.push(cust.length ? `その後のお客様の通 ${cust.length}` : "その後のお客様の通はまだ無い");
  if (cust.some((t) => APPLY_INTENT_RE.test(t))) facts.push("申込の意思の言葉あり");
  if (cust.some((t) => IMPRESSION_GOOD_RE.test(t))) facts.push("良い感想の言葉あり");
  if (cust.some((t) => IMPRESSION_WORRY_RE.test(t))) facts.push("気になる点・迷いの言葉あり");
  if (cust.some((t) => QUESTION_RE.test(t))) facts.push("問いあり");
  facts.push(ours.some((t) => OUR_APPLY_INVITE_RE.test(t)) ? "こちらは内覧の後に申込のご案内を送った" : "こちらは内覧の後にまだ申込のご案内を送っていない");
  return `【内覧後の駅の状態（事実・材料）】${facts.join("・")}。`;
}
