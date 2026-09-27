// app/lib/screening-failed-switch.ts — お客様の「審査落ちた」（自分の審査の否決の報告）への AIX の線（純関数）
//
// 2026-09-27 竹内「重い順から治す」②（YUMA の徹底テスト・9fa0bd64）:
//   お客様「さっき審査落ちたって連絡きました…😢」にブレイン（LLM）が AIX【物件確認した】を選び、
//   物件の資料画像つきで「審査結果につきましては保証会社の審査次第となりますが…」（結果が出た後なのに『審査次第』）が送られた。
//   ブレインの方向の文は「難波エリアの新着1LDK物件を即座に提示して気持ちを切り替えて頂く」＝ AIX の選び間違い。
//   審査落ち→別物件への切り替えは申込以降でも対象（memory project_post_apply_out_of_scope の例外）。
//
// 本番の実送信で引いた線（scripts/audit-screening-failed-switch.ts・180日・グループと YUMA を除く・読むだけ）:
//   ・お客様が自分の審査落ちを伝えた連投（仮定の「ダメな場合」を除く）→ 次にスタッフが押した AIX は 物件ピックアップ か なし。
//     物件確認した を押したのは、同じ連投で「可否を早めに」と特定の物件の募集を聞いた1件だけ
//   ・こちらが否決を伝えた後の最初の AIX（13件）: 物件ピックアップ 5・オススメ 1・なし 3・物件確認した 2（お客様が SUUMO の URL を送った／1番手の否決の番手の話）・申込へ 1・内覧へ 1
//   → 自分の審査落ちの連投で、特定のお部屋を指していない（URL・画像・号室・物件名・「ここの」）・空き/募集・保証会社や再審査・代理契約の話・質問（？）も無い時は、
//     物件確認した（確認します含む）を 物件ピックアップ（property_send）にする。それ以外（ブレインが なし・他の AIX）は変えない
//   ※ 前置き（1時間キャッシュ）は変えていない（出口の決定論だけ）

import { customerPointsAtProperty } from "@/app/lib/cost-question-scope";

/** 自分の審査の否決の報告（「審査落ちた」「審査ダメでした」「否決」「通りませんでした」） */
const OWN_FAIL_RE = /審査[^。！!？?\n]{0,10}(落ち|おち|通らなかっ|とおらなかっ|通りませんでし|ダメ(?:でし|だっ|って|と)|だめ(?:でし|だっ|って|と)|駄目|否決|NG|無理(?:でし|だっ|と))|否決(?:でし|とな|だっ|って|の連絡)|(?:落ちました|落ちちゃ|落ちてしま|落ちたって|落ちたと)/;
/** 仮定（「審査がダメな場合」「もし通らなかった時」「こっちの審査落ちたら」「落ちると」「落ちたってことですかね？」） */
const HYPOTHETICAL_RE = /場合|もし|万が一|としたら|(?:落ち|おち|通らなかっ|ダメだっ|だめだっ|否決だっ|NGだっ)たら|(?:落ち|通らな)(?:ると|れば|ないか|そう)|たら(?:どう|どの|代理|切り替|また)|なかった時|時に(?:代理|切り替)|大丈夫(?:です|でしょう)?か|ますか|ですかね|ってこと/;
// ※「通らなかったため、審査が不安です」（2f352488）は済んだ報告＋心配なので、不安・心配の語だけでは仮定にしない
/** 他人の審査（1番手の方の否決＝番手の繰り上がり） */
const OTHERS_RE = /番手|他の方|前の方|先の方/;
/** 同じお部屋のまま続ける話（空き・募集・別の保証会社・再審査・代理契約）— 物件確認した が正しいことがある */
const SAME_ROOM_ASK_RE = /空い|空き|募集|(?:別|他|違う|ほか)の?保証|保証会社(?:を|で)?(?:変え|変更)|再審査|代理(?:契約|納付)|名義|連帯保証/;
// ※「保証会社の審査に落ちました」「エポス落ちました」は報告なので保証の語・会社名だけでは外さない

/** 今回のお客様の連投が「自分の審査に落ちた」の報告か（仮定・他人の審査は除く） */
export function isOwnScreeningFailureTurn(turnText: string | null | undefined): boolean {
  const t = (turnText ?? "").trim();
  if (!t || !OWN_FAIL_RE.test(t)) return false;
  // 否決の語を含む文だけで仮定・他人を見る（別の文の「ますか」で落とさない）
  const sentences = t.split(/[。！!？?\n]+/).filter((s) => OWN_FAIL_RE.test(s) || /落ち/.test(s));
  const hit = sentences.length ? sentences : [t];
  return hit.some((s) => !HYPOTHETICAL_RE.test(s) && !OTHERS_RE.test(s));
}

export type ScreeningFailedSwitch = { aix: "property_send"; decisionSource: "correction:screening_failed_switch" };

/**
 * 審査落ち→別物件への切り替えの場面で、ブレインの 物件確認した／確認します を 物件ピックアップ にする。
 * 変えない時は null（ブレインの判断のまま）。
 */
export function resolveScreeningFailedSwitch(
  llmAix: string | null | undefined,
  turn: { text: string | null | undefined; hasImage?: boolean },
): ScreeningFailedSwitch | null {
  if (llmAix !== "property_check_result" && llmAix !== "acknowledge_check") return null;
  const t = (turn.text ?? "").trim();
  if (!isOwnScreeningFailureTurn(t)) return null;
  if (turn.hasImage) return null;                 // 画像を持ち込んだ＝特定のお部屋の確認かもしれない
  if (customerPointsAtProperty(t)) return null;   // URL・号室・物件名・「ここの」
  if (SAME_ROOM_ASK_RE.test(t)) return null;      // 空き・別の保証会社・再審査・代理契約の話
  if (/[？?]/.test(t)) return null;               // 何かを聞いている（「同じエポスだと無理ですよね？」）＝答えの材料はブレインの判断に任せる
  return { aix: "property_send", decisionSource: "correction:screening_failed_switch" };
}
