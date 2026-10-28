// ブレインの試験の決まった計算（scripts/lib/brain-exam-score.ts）
// 実行: npx tsx scripts/lib/__tests__/brain-exam-score.test.ts（自己完結。全 PASS で exit 0）
import { brainPathCode, judgePath, codeMatches, problemScore, rateByType, pathOfDirection, normalizeDraftCode, weightedScore, primaryAskIndex } from "../brain-exam-score";

let fail = 0, pass = 0;
function eq(name: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.error(`✗ ${name}\n   得: ${JSON.stringify(a)}\n   期: ${JSON.stringify(b)}`); }
}

// AIX の番
eq("AIX 物件の族", brainPathCode({ reply_mode: "aix", action: "property_send" }).codes, ["AIX:property_send", "AIX:物件", "AIX"]);
eq("AIX 物件確認した＋ピッカー", brainPathCode({ reply_mode: "aix", action: "property_check_result", check_pattern: "available" }).codes[0], "AIX:property_check_result/募集状況");
eq("反応確認は物件確認した の族", codeMatches("AIX:property_check_result", brainPathCode({ reply_mode: "aix", action: "acknowledge_check" }).codes), true);
// action があっても reply_mode が aix でなければ返信側
eq("auto_reply の action は数えない", brainPathCode({ reply_mode: "auto_reply", action: "property_send", reply_direction: "受け止めて締める" }).label, "返信");
// 2段
eq("two_stage", brainPathCode({ reply_mode: "auto_reply", two_stage: "pickup" }).codes, ["2段:pickup", "2段"]);
eq("初回のピックアップ", brainPathCode({ first_contact_pickup: "property_send" }).codes[0], "2段:pickup");
eq("定型の書き出し（見積の約束）", brainPathCode({ reply_direction: "最大限割引した初期費用の御見積書を作成しお送りすると約束する返信にする" }).codes[0], "2段:estimate");
eq("連絡待ち", pathOfDirection("お客様の連絡待ち（返信しない）").path, "なし");
// 曖昧な書き出しは accept には当たるが mustNot には当たらない
const amb = brainPathCode({ reply_direction: "お客様に聞かれた事に答える返信にする（分からない事は確認すると約束）" });
eq("曖昧: accept 返信", judgePath(amb, ["返信"], ["2段:check"]).ok, true);

// 出し切りの問題: 新着待ちの返信は正解・ピックアップの約束は mustNot
eq("出し切り 返信=正解", judgePath(brainPathCode({ reply_direction: "新着を随時確認し出次第お送りすると伝える" }), ["返信", "AIX:zenryoku_support"], ["2段:pickup", "AIX:物件"]).ok, true);
eq("出し切り 再ピックアップ=外れ", judgePath(brainPathCode({ two_stage: "pickup" }), ["返信", "AIX:zenryoku_support"], ["2段:pickup", "AIX:物件"]), { ok: false, acceptHit: null, mustNotHit: "2段:pickup" });
eq("出し切り 全力サポート=正解", judgePath(brainPathCode({ reply_mode: "aix", action: "zenryoku_support" }), ["返信", "AIX:zenryoku_support"], ["AIX:物件"]).ok, true);
eq("物件の族 mustNot", judgePath(brainPathCode({ reply_mode: "aix", action: "property_recommendation" }), ["返信"], ["AIX:物件"]).mustNotHit, "AIX:物件");

// 10/13 竹内さん（KAORI）＋決定（B）: 物件を探す番は左右の形。右（全力サポート）はブレインが候補にした時だけ
//   新着・他にあるかの番＝accept "AIX:左右"／新規の番＝accept "AIX:物件"＋mustNot "右:全力"
const sendRight = brainPathCode({ reply_mode: "aix", action: "property_send", alt_actions: ["zenryoku_support"] });
const sendLeft = brainPathCode({ reply_mode: "aix", action: "property_send", alt_actions: ["property_recommendation"] });
const zen = brainPathCode({ reply_mode: "aix", action: "zenryoku_support" });
eq("新着・他にあるか: 物件の AIX＋右に全力サポート=正解", judgePath(sendRight, ["AIX:左右"], ["2段:pickup"]).ok, true);
eq("新着・他にあるか: 一手が全力サポート（左も並ぶ）=正解", judgePath(zen, ["AIX:左右"], ["2段:pickup"]).ok, true);
eq("新着・他にあるか: 左だけ（全力サポートを候補にしない）=外れ", judgePath(sendLeft, ["AIX:左右"], ["2段:pickup"]).ok, false);
eq("新規: 左だけ=正解", judgePath(sendLeft, ["AIX:物件"], ["右:全力"]).ok, true);
eq("新規: 右も出した=外れ", judgePath(sendRight, ["AIX:物件"], ["右:全力"]), { ok: false, acceptHit: "AIX:物件", mustNotHit: "右:全力" });
eq("新規: 一手が全力サポート=外れ", judgePath(zen, ["AIX:物件"], ["右:全力"]).ok, false);
eq("左右の形でも返信が正解の番は外れ", judgePath(sendRight, ["返信"], ["AIX"]).ok, false);
// 10/13 レビュー（重要3）: 厳しい採点はピックアップ（複数）とオススメ（1件）を分ける。ふつうの採点は今まで通り物件の族で同じ
eq("ふつう: オススメが正解・ピックアップ=正解（族）", judgePath(sendLeft, ["AIX:property_recommendation"]).ok, true);
eq("厳しい: オススメが正解・ピックアップ=外れ", judgePath(sendLeft, ["AIX:property_recommendation"], [], { strict: true }).ok, false);
eq("厳しい: オススメが正解・オススメ=正解", judgePath(brainPathCode({ reply_mode: "aix", action: "property_recommendation" }), ["AIX:property_recommendation"], [], { strict: true }).ok, true);
eq("厳しい: ピックアップが正解・物件を探す=正解（探してピックアップで送る）", judgePath(brainPathCode({ reply_mode: "aix", action: "property_search" }), ["AIX:property_send"], [], { strict: true }).ok, true);
eq("厳しい: 物件の族の正解（AIX:物件）はそのまま", judgePath(sendLeft, ["AIX:物件"], [], { strict: true }).ok, true);
eq("厳しい: 全力サポートと物件の取り違え=外れ", judgePath(zen, ["AIX:物件"], [], { strict: true }).ok, false);
{
  const prev = process.env.SEARCH_SPLIT_CHOICE; process.env.SEARCH_SPLIT_CHOICE = "off";
  eq("SEARCH_SPLIT_CHOICE=off は左右の符号を足さない", brainPathCode({ reply_mode: "aix", action: "property_send", alt_actions: ["zenryoku_support"] }).codes.includes("AIX:左右"), false);
  if (prev === undefined) delete process.env.SEARCH_SPLIT_CHOICE; else process.env.SEARCH_SPLIT_CHOICE = prev;
}

// 1問の合否
const pv = judgePath(brainPathCode({ two_stage: "pickup" }), ["2段:pickup"]);
eq("asks を1つ落とすと不合格", problemScore(pv, [true, false], []).pass, false);
eq("全部当たれば合格", problemScore(pv, [true, true], [false]).pass, true);
eq("判定なしは道だけ", problemScore(pv, null, null).pass, true);
eq("言ってはいけない事を言うと不合格", problemScore(pv, [true], [true]).pass, false);
// 2026-10-23 優先の重み（旧の pass は同じ・主な依頼の外れは他の依頼の外れより重い）
eq("重み: 全部当たり 1", weightedScore(true, [true, true], [false]).weighted, 1);
eq("重み: 主な依頼の外れ（2+1+1 のうち 2 落とす）", weightedScore(true, [false, true], [false]).weighted, 0.5);
eq("重み: 小さな依頼の外れ（2+1+1 のうち 1 落とす）", weightedScore(true, [true, false], [false]).weighted, 0.75);
eq("重み: 道が外れは0", weightedScore(false, [true], []).weighted, 0);
eq("重み: 主な依頼の印", weightedScore(true, [false, true], null).primary, false);
eq("重み: 判定なしは道だけ", weightedScore(true, null, null), { weighted: 1, primary: null });
eq("重み: 主な依頼の位置が依頼の数を超えたら最後に寄せる（印と重みが同じ依頼）", weightedScore(true, [false, true], null, 5), { weighted: 2 / 3, primary: true });
eq("主な依頼の位置: main の印", primaryAskIndex([{}, { main: true }]), 1);
eq("主な依頼の位置: 無ければ1つ目", primaryAskIndex([{}, {}]), 0);
eq("主な依頼の位置で重みが変わる", problemScore(pv, [false, true], [], { primaryIdx: 1 }).weighted, 2 / 3);
eq("旧の pass は重みで変えない", problemScore(pv, [true, false], []).pass, false);

// 型ごと
const r = rateByType([
  { type: "出し切り", score: problemScore(pv, null, null) },
  { type: "出し切り", tags: ["謝罪"], score: problemScore(judgePath(brainPathCode(null), ["返信"]), null, null) },
]);
eq("型ごと", r.map((x) => `${x.type}:${x.pass}/${x.n}`), ["出し切り:1/2", "（札）謝罪:0/1"]);

// 10/13 竹内さん③: 確認＋見積の1文は正解が 2段:check の時 2段:check に数える（q138 の下書き）
eq("確認＋見積→check", normalizeDraftCode("2段:estimate", "お送り頂きました2件の物件、募集状況を確認させて頂きます！！\n確認出来次第、最大限割引させて頂いた初期費用の御見積書をお送りさせて頂きます！！", ["2段:check"]), "2段:check");
eq("見積だけ→そのまま", normalizeDraftCode("2段:estimate", "御見積書を作成しお送りさせて頂きます！！", ["2段:check"]), "2段:estimate");
eq("正解に estimate がある→そのまま", normalizeDraftCode("2段:estimate", "募集状況確認させて頂きます 御見積書", ["2段:check", "2段:estimate"]), "2段:estimate");
// 10/16〜17: 判定が 返信 と付けた確認・交渉の約束の下書きは、正解に 2段:check がある時だけ 2段:check に数える
eq("確認の約束・正解 check→check", normalizeDraftCode("返信", "募集状況確認させて頂きます！！", ["2段:check"]), "2段:check");
eq("結果の報告は替えない", normalizeDraftCode("返信", "確認させて頂きましたところ募集中です", ["2段:check"]), "返信");
eq("正解が 返信 だけ（q007 の形）は替えない", normalizeDraftCode("返信", "募集状況随時確認させて頂きます！！ご条件に合ったお部屋出次第お送りさせて頂きます！！", ["返信"]), "返信");

// 2026-10-27 苦手な問題②（q105）: 室内写真の撮影の約束（本番の2段の種類は check）は "2段:photo" にも当たる
{
  const photoDir = "室内の写真はスタッフが撮影してお送りする物なので、撮影の約束の返信にする（…）";
  const c = brainPathCode({ reply_mode: "aix", two_stage: "check", reply_direction: photoDir } as never);
  eq("撮影の約束は 2段:photo", c.codes.includes("2段:photo"), true);
  eq("撮影の約束は 2段:check にも当たる", c.codes.includes("2段:check"), true);
  eq("q105 の正解に当たる", judgePath(c, ["AIX:property_check_result", "2段:photo"], ["返信"]).ok, true);
  const plain = brainPathCode({ reply_mode: "aix", two_stage: "check", reply_direction: "お客様に聞かれた事に答える返信にする" } as never);
  eq("撮影でない確認の約束は photo にしない", plain.codes.includes("2段:photo"), false);
}

// 2026-10-28 2択の番はどちらかに入れば合格（feedback_two_choice_aix・TWO_CHOICE_PROMISE_OR_NOW）
{
  const two = brainPathCode({ reply_mode: "auto_reply", action: "", two_stage: "check", two_choice_mode: true, two_choice_aix: "property_check_result", two_choice_check_pattern: "available" });
  eq("2択（約束の側）: AIX で合格", judgePath(two, ["AIX:property_check_result"]).ok, true);
  eq("2択（約束の側）: 約束で合格", judgePath(two, ["2段:check"]).ok, true);
  eq("2択（約束の側）: 別の AIX は不合格", judgePath(two, ["AIX:estimate_sheet"]).ok, false);
  const two2 = brainPathCode({ reply_mode: "aix", action: "property_send", two_choice_mode: true, reply_direction: "検討見守り" });
  eq("2択（AIX の側）: 返信も合格", judgePath(two2, ["返信"]).ok, true);
  eq("2択（AIX の側）: AIX も合格", judgePath(two2, ["AIX:property_send"]).ok, true);
  // 10/29: どちらかのボタンが言ってはいけない道なら外す（押せば間違いのボタン）
  eq("2択でも言ってはいけない道のボタンを出したら外す", judgePath(two2, ["AIX:property_send"], ["返信"]).ok, false);
  eq("2択（約束の側）: 左の AIX が言ってはいけない道なら外す", judgePath(two, ["2段:check"], ["AIX:property_check_result"]).ok, false);
  // その場の側（TWO_CHOICE_NOW_SIDE）: 右の返信は約束の下書き＝2段:<種類>
  const two3 = brainPathCode({ reply_mode: "aix", action: "property_send", two_choice_mode: true, two_choice_reply_kind: "pickup" });
  eq("2択（その場の側）: 約束で合格", judgePath(two3, ["2段:pickup"]).ok, true);
  eq("2択（その場の側）: AIX で合格", judgePath(two3, ["AIX:property_send"]).ok, true);
  eq("2択（その場の側）: 別の約束は不合格", judgePath(two3, ["2段:check"]).ok, false);
  eq("2択（その場の側）: 右の約束が言ってはいけない道なら外す", judgePath(two3, ["AIX:property_send"], ["2段:pickup"]).ok, false);
}

console.log(`${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);

