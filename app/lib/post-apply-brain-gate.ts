// app/lib/post-apply-brain-gate.ts — 申込中・審査中の会話でブレイン（LLM）を回す番を決める（純関数・決定論）
//
// 2026-10-07 竹内さんの決定「申込以降は別のツールで対応しているので、申込中・審査中はブレインを否決・取り消し・クレームの時だけ回す」（形 (a)）。
//   測った事（scripts/audit-brain-post-apply.ts・9/23〜14.5日の本番）: 申込へを押した後の brain_fresh 月 約$50 のうち、
//   本当の申込中・審査中（applying/application/screening）は月 約$24 → この形で月 約$3。残り月 約$27 は審査落ち等で提案中に戻した会話
//   （切り替えの期間＝status が申込前＝この関門に入らない・今まで通り全部回す）。
//   審査落ち→別物件の切り替えの番 27（申込中5・戻した期間22）は、否決の文脈で必ず回すので取りこぼし0。
//
// 回す番（どれか1つ）:
//   ① お客様の今の番が 自分の審査落ちの報告（screening-failed-switch.isOwnScreeningFailureTurn）
//   ② センシティブの判定（sensitive-case.detectSensitiveCase＝クレーム・審査否決・キャンセル/リスケ）
//   ③ 取り消し・キャンセル・やめる・他で決めた・否決・クレームの語（POST_APPLY_ALERT_RE・②より広い＝問いの形「キャンセルできますか」も回す。
//      誤って回すのは費用が少し増えるだけ・回さない誤りは取りこぼし＝広い側に倒す）
//   ④ 否決の文脈: 申込へを押した後（無ければ渡された通の中）に、こちらが否決を伝えた通（STAFF_FAIL_RE）かお客様の審査落ちの報告がある
//      ＝審査管理は否決の後も status を screening のまま持つことがある（conversation-status.ts）ので、日数で切らずに否決の後は全部回す
// 回さない番: それ以外（書類の画像・申込フォームの記入・手続きの質問・お礼など＝申込のツールで対応）。
// 戻す: BRAIN_POST_APPLY_GATE=off（申込中も今まで通り全部回す）
import { isOwnScreeningFailureTurn } from "./screening-failed-switch";
import { detectSensitiveCase, withoutImageReadouts } from "./sensitive-case";

/** この関門に入るステータス（竹内さん「申込中・審査中」）。契約・成約以降は BRAIN_SKIP_STATUSES で元から回していない */
export const POST_APPLY_GATE_STATUSES: ReadonlySet<string> = new Set(["applying", "application", "screening"]);

/** こちら（スタッフ）が否決を伝えた通 */
export const STAFF_FAIL_RE = /否決|審査[^。！!？?\n]{0,10}(?:落ち|通ら|NG|ダメ|だめ|通りません)|承認(?:が)?(?:下りず|おりず|頂けず|いただけず)|ご期待に添え/;

/**
 * お客様の取り消し・キャンセル・やめる・他で決めた・否決・クレームの語（③）。
 * 線は申込中・審査中の本番のお客様の番（scripts/audit-post-apply-brain-gate.ts）を読んで引いた。
 *   ・「解約」は今の家の解約の連絡（申込中によくある・手続き）と区別できないので、こちらの契約・申込の語と同じ文の時だけ
 */
export const POST_APPLY_ALERT_RE = new RegExp([
  // 否決・審査落ち（仮定も含めて回す＝誤って回すだけ）
  "否決", "審査[^。！!？?\\n]{0,10}(?:落ち|おち|通ら|とおら|通りませ|ダメ|だめ|駄目|NG|無理)", "落ちました", "落ちちゃ", "落ちてしま", "通りませんでし", "通らなかっ",
  // 取り消し・キャンセル・辞退・撤回・見送り・やめる
  "キャンセル", "取り?消", "取りやめ", "取り止め", "辞退", "白紙", "撤回", "見送", "やめ(?:たい|ます|ておき|とき|よう|させ|る事|ること|て(?:も|い))", "辞め(?:たい|ます|させ)", "止め(?:たい|ます|させ)",
  "なかった(?:こと|事)に", "考え直", "保留",
  // 別の物件への切り替え（「他の物件を探しますので引き続き」0133b787・「ほかの物件と比較」331b0338）。「他の階」は同じ物件の話なので当てない
  "(?:他|ほか|別)の?(?:物件|お部屋|部屋)",
  // 迷い・やめる手前（「一旦考えて、また連絡します」8b260f7e・「沢山考えた結果やはり家賃が高すぎて…見つからないでしょうか」1de819c9・
  //   「違う不動産会社にしてもらいました」60e6d3ab）
  "考えた結果", "一旦考え", "考えさせ", "やっぱり", "やはり", "(?:違う|他の|ほかの)不動産", "他社", "見つからない", "他(?:社|の(?:不動産|会社|業者))で(?:決め|契約|申込|申し込)", "別の(?:不動産|会社|業者)で", "(?:他|別)(?:の)?(?:物件|お部屋|部屋)に(?:決め|します|しよう)",
  // クレーム・不信
  "クレーム", "苦情", "返金", "返して", "納得(?:いか|でき)", "話が違", "聞いてない", "聞いていな", "騙", "詐欺", "おかし(?:い|く)", "普通に考え", "あり(?:え|得)ない", "ふざけ", "怒", "不誠実", "誠意", "訴え", "弁護士", "消費者",
].join("|"));
const IMAGE_MSG_RE = /^\s*\[(?:画像|ファイル|動画)\]/;
const CONTRACT_CANCEL_RE = /解約[^。！!？?\n]{0,12}(?:申込|申し込|審査|契約|そちら|こちら|御社|貴社)|(?:申込|申し込|審査|契約|そちら|こちら|御社|貴社)[^。！!？?\n]{0,12}解約/;

export type GateMsg = { sender: string; text: string | null; created_at: string };
export type PostApplyBrainGateInput = {
  status: string | null | undefined;
  /** 会話の通（古い順・直近 40 通ほど）。お客様の今の番＝最後のこちらの通の後のお客様の連投（最後がこちらなら1つ前のお客様の連投） */
  msgs: readonly GateMsg[];
  /** AIX【申込へ】を最後に押した時刻（ISO）。否決の文脈を探す起点。無ければ渡された通の全部 */
  applicationPushAt?: string | null;
  env?: Record<string, string | undefined>;
};
export type PostApplyBrainGate = { run: boolean; reason: string };

/** 発言の区切り（generate-reply の MSG_SEP と同じ。sensitive-case の画像の読み取りの除外がこの区切りで1通ずつ見る） */
const MSG_SEP = "\n⁣\n";
/** 今のお客様の番（連投）の文（1通ずつ MSG_SEP で区切る） */
export function latestCustomerTurnText(msgs: readonly GateMsg[]): string {
  let end = msgs.length - 1;
  while (end >= 0 && msgs[end].sender !== "customer") end--;
  if (end < 0) return "";
  let start = end;
  while (start - 1 >= 0 && msgs[start - 1].sender === "customer") start--;
  return msgs.slice(start, end + 1).map((m) => m.text ?? "").join(MSG_SEP);
}

/** お客様の文から③の語を探す（画像の読み取りは除く・解約はこちらの契約の時だけ） */
export function postApplyAlertWord(text: string): string | null {
  const body = withoutImageReadouts(text);
  const m = body.match(POST_APPLY_ALERT_RE);
  if (m) return m[0];
  const c = body.match(CONTRACT_CANCEL_RE);
  return c ? c[0] : null;
}

export function decidePostApplyBrainGate(i: PostApplyBrainGateInput): PostApplyBrainGate {
  const env = i.env ?? (typeof process !== "undefined" ? process.env : {});
  if ((env.BRAIN_POST_APPLY_GATE ?? "").toLowerCase() === "off") return { run: true, reason: "gate_off" };
  if (!POST_APPLY_GATE_STATUSES.has((i.status ?? "").trim())) return { run: true, reason: "not_post_apply" };
  const turn = latestCustomerTurnText(i.msgs);
  // 自分の審査落ちの報告は画像の読み取り（請求書・書類の文）を除いた本人の文で見る（d46290ff: 請求書の読み取りで当たった）
  if (isOwnScreeningFailureTurn(withoutImageReadouts(turn))) return { run: true, reason: "own_fail" };
  const sens = detectSensitiveCase(turn);
  if (sens) return { run: true, reason: sens === "審査否決" ? "reject" : sens === "クレーム" ? "claim" : "cancel" };
  const w = postApplyAlertWord(turn);
  if (w) return { run: true, reason: `alert_word:${w}` };
  const fromMs = i.applicationPushAt ? Date.parse(i.applicationPushAt) : NaN;
  const since = i.msgs.filter((m) => !Number.isFinite(fromMs) || Date.parse(m.created_at) >= fromMs);
  if (since.some((m) => m.sender !== "customer" && STAFF_FAIL_RE.test(m.text ?? ""))) return { run: true, reason: "after_staff_fail" };
  if (since.some((m) => m.sender === "customer" && !IMAGE_MSG_RE.test(m.text ?? "") && isOwnScreeningFailureTurn(m.text ?? "")))return { run: true, reason: "after_own_fail" };
  return { run: false, reason: "post_apply_routine" };
}
