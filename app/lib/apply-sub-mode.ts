// app/lib/apply-sub-mode.ts
// AIX【申込へ！】のどの形（申込確定／申込誘導／書類依頼）で作るかを、お客様の発言とこちらの直近の送信から決める（純関数・DB も fetch も持たない）。
//
// 2026-10-02 竹内さん（YUMA の LINE を読んで）「こんなかんじじゃない。実際の言い回しを確認する。AIっぽい文となっている」:
//   お客様「一つ目の福島駅の物件の申し込みをお願いしたいです」→ AIX の文
//   「YUMAさんお申込みのご連絡ありがとうございます！！福島駅のS-RESIDENCE福島Luxe 1308号室でお申込み手続きを進めさせていただきます😊！！
//    お気に召していただけて大変嬉しく思います！！ お申込みに必要な書類をご案内させていただきますので…」
//   ／お客様「江坂の方よろしくお願いします／審査一旦通してもらって行けそうでしたら今月お金振り込みます」→ AIX の文
//   「…プレジオ十三の初期費用も…まずは審査を進めて、ご希望に合えば今月のご入金でお部屋を押さえさせていただきます！！」（別の物件・入金で押さえる＝誤り）。
//   どちらも**申込誘導（push・hold_view）**の形で作られていた: 申込を決めたお客様に「後押し」の文を作るので、お客様の言葉（今月振り込み）を
//   拾って作文し、物件名も会話から推し量る。原因は2つ:
//     ① 本番の画面: 提案のバナーから開くと申込へ！は必ず「申込誘導」で開く（page.tsx openAixWithParams・「モード選択の1タップを省く」）
//     ② テストの道具: aix-autofill-readiness が申込へ！を形の指定なし（＝申込誘導）で作っていた
//
// 線（scripts/audit-apply-intent-wording.ts・365日・お客様が申込を決めた番 32番を全部読んだ）:
//   スタッフの最初の1通は「かしこまりました！！\n〇〇〇号室お申込みさせていただきます😊！！」の2行（手打ち）が 17/23（はっきり決めた番）。
//   そのあと AIX【申込へ！】の申込フォーマット。誘導（お気に召されましたら…）を送った番は 0。
//   → お客様が申込を決めた番は**申込確定（confirm＝この2行の形）**で作る。迷い・検討は申込誘導。申込書を送った後の書類の話は書類依頼。
//   条件付き（「大丈夫ならすぐ申し込みします」「カシータがいけましたらそこに決めます」）は確認の返事（かしこまりました＋確認）＝確定にしない。
//   質問（「申し込んでもいいですか？」）は返信で答える（はい！！もちろんです）＝確定にしない。

/**
 * format＝申込フォーマット（画面の固定文・AixModal／application-format.ts）。2026-10-02 竹内「それでいく。ただここはAIXでいまはスタッフが送る形にするので、AIXで止めておく」:
 *   申込確定の2行の後はフォーマット＝AIX【申込へ！】で**スタッフが押して送る**（自動では送らない・aix-autofill-readiness は staff_confirm・autoSend=false）
 */
export type ApplySubMode = "confirm" | "push" | "docs_request" | "format";
export type ApplySubModeDecision = { mode: ApplySubMode; reason: string };

/** お客様が申込を決めた言い方（実送信の番から） */
const APPLY_DECISION_RE = new RegExp([
  // 申し込み(を)お願いします／申し込みたいです／申込します／申し込みさせていただきたいです
  String.raw`(?:申し?込み?|お申し?込み?)(?:を|は|の方|だけ)?(?:ぜひ|是非)?(?:お願い|おねがい|したい|します|させて(?:頂|いただ)き(?:たい|ます)|たい|進めて)`,
  String.raw`申し?込みます`,
  // この物件で決めます／ここに決めます
  String.raw`(?:に|で)決め(?:ます|ました|たいです)`,
  // 審査通して欲しいです／審査一旦通してもらって
  String.raw`審査(?:を)?(?:一旦|一度|まず)?(?:通して|進めて|お願い|かけて)`,
].join("|"));
/** 条件付き（〜なら申し込みます・〜いけましたら決めます）＝確かめてからの話 */
const CONDITIONAL_RE = /(?:なら|ならば|たら|れば|でしたら|次第|場合)[、,\s]*(?:すぐ|明日|一応)?[^。\n]{0,8}(?:申し?込|決め)/;
/** 申込の可否を聞いている（返信で答える） */
const QUESTION_RE = /(?:申し?込|決め)[^。\n]{0,14}(?:[？?]|ですか|でしょうか|いいですか|できますか|出来ますか|可能)/;
/** 他社で決めた・他で審査中（こちらへの申込ではない）／条件フォームの記入 */
const NOT_OURS_RE = /他(?:の|社|所)?(?:不動産|会社|業者)|他社|他で(?:審査|決め|申し?込)|別の(?:不動産|会社|業者)|【お部屋お探し中！】|ご希望のお部屋探しご条件/;
const HESITATE_RE = /迷|悩|検討|考え|どうしよう|か(?:な|も)[？?🤔]?\s*$/;
const DOCS_RE = /書類|身分証|免許証|保険証|源泉|給与明細|収入証明|住民票|マイナンバー/;
/** こちらが申込確定の2行を送ったか（「お申込みさせていただきます」「お申込させて頂きます」） */
const CONFIRM_SENT_RE = /お申し?込み?(?:手続き)?(?:を)?(?:進め)?させて(?:頂|いただ)きます/;
/** こちらが申込書（記入欄）を送った後か */
const FORM_SENT_RE = /記入欄】/;

/** お客様が申込を決めた（条件付き・質問でない）1番か */
export function isApplyDecision(customerText: string | null | undefined): boolean {
  const t = String(customerText ?? "").normalize("NFKC");
  if (!APPLY_DECISION_RE.test(t)) return false;
  if (NOT_OURS_RE.test(t)) return false;
  if (CONDITIONAL_RE.test(t)) return false;
  if (QUESTION_RE.test(t) && !/お願い(?:します|致します|いたします|したい)/.test(t)) return false;
  return true;
}

/**
 * AIX【申込へ！】の形を決める。
 *   customerText      … 今回のお客様の連投（改行でつないだ物）
 *   recentStaffTexts  … こちらの直近の送信（古→新）
 */
export function decideApplySubMode(i: { customerText: string | null | undefined; recentStaffTexts?: ReadonlyArray<string | null | undefined> }): ApplySubModeDecision {
  const turn = String(i.customerText ?? "");
  const staff = (i.recentStaffTexts ?? []).slice(-6).map((s) => String(s ?? "")).join("\n");
  if (FORM_SENT_RE.test(staff)) {
    return DOCS_RE.test(turn) ? { mode: "docs_request", reason: "申込書を送った後の書類の話" } : { mode: "confirm", reason: "申込書を送った後（申込の確定）" };
  }
  // 申込確定の2行（「〇〇号室お申込みさせていただきます」）を送った後でフォーマットはまだ → 次は申込フォーマット（実送信: 確定の2行の後に AIX のフォーマット）
  const recent = (i.recentStaffTexts ?? []).slice(-3).map((s) => String(s ?? "")).join("\n");
  if (CONFIRM_SENT_RE.test(recent)) return { mode: "format", reason: "申込確定の2行を送った後（次は申込フォーマット＝スタッフが AIX から送る）" };
  if (isApplyDecision(turn)) return { mode: "confirm", reason: "お客様が申込を決めた（実送信は『かしこまりました！！／〇〇号室お申込みさせていただきます』の2行）" };
  if (HESITATE_RE.test(turn)) return { mode: "push", reason: "迷い・検討（申込の後押し）" };
  return { mode: "push", reason: "申込を決めた言葉が無い（申込の後押し）" };
}

/**
 * 申込フォーマット（記入欄）の文か（2026-10-02 竹内「AIXで止めておく」）。自動返信の予約（auto-reply-dispatch）はこの文を積まない＝
 * フォーマットは AIX【申込へ！】でスタッフが送る。見出しは application-format.ts の4つ
 */
export const APPLICATION_FORMAT_RE = /【(?:お申込者様|同居人|緊急連絡先|連帯保証人)(?:様)?(?:記入)?欄】/;
