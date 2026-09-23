// app/lib/applying-promotion.ts
// 会話の status を「申込・審査中（applying）」へ自動で進めてよいかを1か所で決める（純関数）。
// line-webhook の tryPromoteToApplying / autoPromoteApplyingOnFormImage はこれを呼ぶだけにする。
//
// 2026-09-23 課題②（竹内「順に改善する。実際の成約データや直近のLINEを参考にずれをなくす」）
//
// 【実物】DB の conversations.status がブレインの checkpoint_stage より後ろの会話が 27.4%（32/117）。
//   従来の昇格条件は「申込フォームのテキスト（applying_text_received）＋ 画像の旗（applying_image_received）の両方」だが、
//   画像の旗は**全会話で0件**だった。画像の旗は「直近72h以内のスタッフ発言に /申込書|申込用紙|ご記入|入居申込/」が要るのに、
//   申込の案内は AIX【申込へ】で行われ、押した直後2h以内のスタッフ発言に含まれる語は
//   申込=22/22・フォーマット=21・本人確認=21・免許=21・マイナンバー=21・書類=21 で、**旗の4語は0件**。
//   ＝AIX で申込を案内する運用では画像の旗は一生立たない（語のずれ。時間の線の問題ではない:
//   フォーム前後3日の画像の「直前スタッフ発言からの間隔」中央値 2.9h・72h超 2/70）。
//   さらに従来の画像判定は画像の保存時（Vision の前）に走るので image_type（本人確認書類）も見られなかった。
//
// 【お客様の実際の順番】（後ろの32件のうちフォーム文あり17件）
//   AIX【申込へ】 → 10分〜3h（最大2.4日）でフォーム文 → 0.1〜3h で本人確認書類の画像（image_type=id_document）
//   フォーム文の前に AIX【申込へ】あり 10/17 ／ 本人確認書類あり 10/31
//
// 【線（誤昇格0）】scripts/audit-applying-promotion.ts で「昇格すべき31件」と「昇格すべきでない73件＋手で戻した7件」に当てた:
//   今の本番                                    0/31 拾う ／ 誤って true 0/73・0/7
//   A1 フォーム文だけ（2026-08-20 以前の形）      17/31       ／ 7/73・3/7  ← 誤って true の10件のうち9件は本物のフォーム
//                                                                 （460〜609字・項目15〜20）の後で否決・再検索になった会話。
//                                                                 届いた時点の昇格は正しく、手戻し後は page.tsx の旗リセットで再昇格しない。
//                                                                 本当の誤検知は1件（「法人契約」1語・243字・項目0）→ application-form-detect 側で線を引いた
//   A3' フォーム文＋(本人確認書類 or 先行する AIX【申込へ】) 12/31 ／ 5/73・3/7（上と同じ「本物のフォーム後の手戻し」）
//   → 採る形: フォーム文 ＋（画像の旗 or 14日以内に先行する AIX【申込へ】）。画像の旗は従来の語に加えて image_type=id_document でも立てる。
//     手で前の段階に戻した会話（status_manual_back_at あり）は自動で進めない（戻した判断が正・手で進めた時に印は消える）。
//
// 【14日】内覧・約束の鮮度と同じ線（同じ事実に2つの線を作らない）。実測の AIX→フォーム間隔は最大2.4日なので余裕がある。
//
// 【入れなかった物】
//   ・フォーム文だけ（A1）: 手戻し後の会話で 3/7 が true になる。旗リセット＋印で構造上は防げるが、
//     「法人契約」1語の誤検知のような文で status が動くのは避けたい（誤昇格0の線を守る）
//   ・本人確認書類だけ（A7）／AIX【申込へ】だけ: お客様の意思（フォーム）が無い昇格は作らない
//   ・読む側（brain-core STATUS_MEANING・DRAFT_SKIP_STATUSES）を checkpoint_stage で補正する案B:
//     ブレインの stage=applying は「申込へ向かう」を指すことがあり（d3a56a97「9月末に申込へ進める」で stage=applying）、
//     31件全部が14日以内の更新で鮮度では弾けない。昇格（DB 1か所）なら3か所が同時に直る

import { PRE_APPLY_STATUSES } from "./application-form-detect";

/** AIX【申込へ】の押下を「先行する案内」と数える鮮度（日）。内覧・約束の鮮度と同じ線 */
export const APPLICATION_PUSH_FRESH_DAYS = 14;

/** スタッフの申込書依頼の語（従来どおり。画像の旗の経路①）。監査スクリプトも同じ物を import する（四者同名） */
export const STAFF_FORM_REQUEST_RE = /申込書|申込用紙|ご記入|入居申込/;

export type ApplyingPromotionFacts = {
  /** conversations.status */
  status: string | null | undefined;
  /** conversations.applying_text_received（申込フォームのテキストを受信済み） */
  textReceived: boolean | null | undefined;
  /** conversations.applying_image_received（申込書依頼直後の画像 or 本人確認書類を受信済み） */
  imageReceived: boolean | null | undefined;
  /** conversations.status_manual_back_at（スタッフが手で前の段階に戻した印） */
  statusManualBackAt: string | null | undefined;
  /** 直近の AIX【申込へ】押下（aix_usage_logs.aix_type='application_push'）の時刻 */
  lastApplicationPushAt: string | null | undefined;
  /** 判定時刻 */
  now: string | Date;
};

export type ApplyingPromotionReason = "text_and_image" | "text_and_application_push";
export type ApplyingPromotionBlock = "not_pre_apply" | "manual_back" | "no_text" | "no_second_evidence";

export type ApplyingPromotionResult =
  | { promote: true; reason: ApplyingPromotionReason; blocked: null }
  | { promote: false; reason: null; blocked: ApplyingPromotionBlock };

const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** AIX【申込へ】が判定時刻から freshDays 日以内に**先行**しているか（未来の時刻は数えない） */
export function applicationPushIsFresh(lastApplicationPushAt: string | null | undefined, now: string | Date, freshDays = APPLICATION_PUSH_FRESH_DAYS): boolean {
  const push = toMs(lastApplicationPushAt);
  const at = toMs(now);
  if (push === null || at === null) return false;
  const gap = at - push;
  return gap >= 0 && gap <= freshDays * DAY_MS;
}

/**
 * applying へ進めてよいか。
 *   条件: status が申込前 ∧ 手戻しの印なし ∧ フォーム文あり ∧（画像の旗 ∨ 14日以内に先行する AIX【申込へ】）
 *   従来の「両旗」はそのまま残し、AIX【申込へ】を OR で足した形。
 */
export function resolveApplyingPromotion(f: ApplyingPromotionFacts): ApplyingPromotionResult {
  const status = (f.status ?? "").trim();
  if (!PRE_APPLY_STATUSES.includes(status)) return { promote: false, reason: null, blocked: "not_pre_apply" };
  // 2026-09-16 竹内（𝒮 さん事例）: 手で前の段階に戻した会話は自動で進めない。印はスタッフが手で前に進めた時に外れる（resolveManualBackMark）
  // 2026-09-23 竹内「否決となって再度物件提案中にもどる場合もあるから…そうしたらまた申込までうごく」:
  //   印は**時間順**で読む（app/lib/post-apply.ts と同じ向き・反証者の指摘で揃えた）。
  //   戻した後に AIX【申込へ】をもう一度押していれば、それは再申込なので印では止めない（実物 9b9b81ba: 否決→戻す→再申込）。
  //   押下の記録が無い・押下が戻しより前なら従来どおり止める（本人確認書類だけの経路は押下が無いので止まる）
  if (f.statusManualBackAt) {
    const back = toMs(f.statusManualBackAt), push = toMs(f.lastApplicationPushAt);
    if (back === null || push === null || push <= back) return { promote: false, reason: null, blocked: "manual_back" };
  }
  if (!f.textReceived) return { promote: false, reason: null, blocked: "no_text" };
  if (f.imageReceived) return { promote: true, reason: "text_and_image", blocked: null };
  if (applicationPushIsFresh(f.lastApplicationPushAt, f.now)) return { promote: true, reason: "text_and_application_push", blocked: null };
  return { promote: false, reason: null, blocked: "no_second_evidence" };
}

export type ImageFlagFacts = {
  /** messages.image_type（Vision の分類。保存時はまだ無いので null） */
  imageType?: string | null;
  /** 画像の時点から72h以内の直近スタッフ発言1件の本文（従来の経路） */
  lastStaffTextWithin72h?: string | null;
};

export type ImageFlagResult =
  | { set: true; reason: "id_document" | "staff_form_request" }
  | { set: false; reason: null };

/**
 * applying_image_received を立ててよいか。
 *   ① image_type が本人確認書類（id_document）— AIX【申込へ】の後に届く実物の形（後ろの32件で本人確認書類あり 10/31）
 *   ② 従来: 直近72h以内のスタッフ発言に申込書依頼の語
 *   PDF（file メッセージ）は image_type が無いので②だけで判定する（呼び出し側は imageType を渡さない）
 */
export function shouldSetApplyingImageFlag(f: ImageFlagFacts): ImageFlagResult {
  if ((f.imageType ?? "").trim().toLowerCase() === "id_document") return { set: true, reason: "id_document" };
  if (STAFF_FORM_REQUEST_RE.test(f.lastStaffTextWithin72h ?? "")) return { set: true, reason: "staff_form_request" };
  return { set: false, reason: null };
}
