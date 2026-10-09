// ブレインの試験の決まった計算（scripts/lib/brain-exam-score.ts）
// 実行: npx tsx scripts/lib/__tests__/brain-exam-score.test.ts（自己完結。全 PASS で exit 0）
import { brainPathCode, judgePath, codeMatches, problemScore, rateByType, pathOfDirection } from "../brain-exam-score";

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

// 1問の合否
const pv = judgePath(brainPathCode({ two_stage: "pickup" }), ["2段:pickup"]);
eq("asks を1つ落とすと不合格", problemScore(pv, [true, false], []).pass, false);
eq("全部当たれば合格", problemScore(pv, [true, true], [false]).pass, true);
eq("判定なしは道だけ", problemScore(pv, null, null).pass, true);
eq("言ってはいけない事を言うと不合格", problemScore(pv, [true], [true]).pass, false);

// 型ごと
const r = rateByType([
  { type: "出し切り", score: problemScore(pv, null, null) },
  { type: "出し切り", tags: ["謝罪"], score: problemScore(judgePath(brainPathCode(null), ["返信"]), null, null) },
]);
eq("型ごと", r.map((x) => `${x.type}:${x.pass}/${x.n}`), ["出し切り:1/2", "（札）謝罪:0/1"]);

console.log(`${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
