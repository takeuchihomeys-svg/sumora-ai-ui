// app/lib/__tests__/ack-review.test.ts — 見る受けの付いたお礼（2026-11-27 作業員A・q472 の根・ACK_REVIEW_AS_ACK 既定 off）
//   実行: npx tsx app/lib/__tests__/ack-review.test.ts
import { isAckOrReviewTurn, isAckOnlyTurn, ackReviewAsAckOn } from "../ack-topic-scope";
import { pickupPromiseFlowOf } from "../pickup-promise-flow";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
// 60日の実物（探す約束の後・物件を送った後のお客様の一通・名前なし）
const yes = ["ありがとうございます！！\n確認させていただきます！", "有難うございます！\n拝見いたします！", "ありがとうございます！\nご確認させていただきます！", "ありがとうございます。拝見させていただきます！", "お世話になっております！\n拝見させていただきます！ありがとうございます"];
t("見る受けの付いたお礼は数える（今の isAckOnlyTurn は false）", yes.every((x) => isAckOrReviewTurn(x)) && !isAckOnlyTurn(yes[0]));
// 含めない: 問い・条件の変更が続く束（実物の型）
const no = ["確認させていただきます。ちなみに駅から近い物件ありますか？", "ありがとうございます！確認させて頂きます。もう少し家賃抑えたいです", "確認させていただきます！10万以下でもありますか", "ありがとうございます😊\nそこを候補にもう少し見てみます🙇🏻‍♂️"];
t("問い・条件の変更・もう少し が続く束は数えない", no.every((x) => !isAckOrReviewTurn(x)));
t("q474 の形: ご協力ありがとうございます もお礼（問いが続けば数えない）", isAckOrReviewTurn("ご協力ありがとうございます") && !isAckOnlyTurn("ご協力ありがとうございます") && !isAckOrReviewTurn("ご協力ありがとうございます。駅から近い所はありますか"));
t("お礼だけは今と同じ", isAckOrReviewTurn("ありがとうございます！！") && !isAckOrReviewTurn("駅から近いのはありますか"));
t("既定 off", !ackReviewAsAckOn({}) && ackReviewAsAckOn({ ACK_REVIEW_AS_ACK: "on" }));
// q472 の形: 探す約束の後に見る受けの付いたお礼・送れる候補 3件 → on なら ack_ready・off なら場面なし
const now = Date.parse("2026-11-22T07:00:00Z");
const msgs = [{ sender: "staff", text: "物件ピックアップ出来ましたらお送りさせて頂きます！！", createdAt: "2026-11-22T06:40:00Z", isAix: false }, { sender: "customer", text: yes[0], createdAt: "2026-11-22T06:47:00Z", isAix: false }];
const prev = process.env.ACK_REVIEW_AS_ACK;
process.env.ACK_REVIEW_AS_ACK = "on"; const onScene = pickupPromiseFlowOf(msgs as never, [], 3, now).scene;
delete process.env.ACK_REVIEW_AS_ACK; const offScene = pickupPromiseFlowOf(msgs as never, [], 3, now).scene;
if (prev != null) process.env.ACK_REVIEW_AS_ACK = prev;
t("q472 の形: on で ack_ready・off は場面なし（今と同じ）", onScene === "ack_ready" && offScene === null);
console.log(`ack-review: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
