// 2026-11-27 作業員L（台帳 #811 任せられる度）
// 実行: npx tsx app/lib/__tests__/delegation-index.test.ts
import assert from "node:assert/strict";
import { dangerOfEdit, delegationTable, delegationLines, promiseDropped } from "../delegation-index";

assert.deepEqual(dangerOfEdit("初期費用は25万円です。", "初期費用は25万円です"), [], "句点だけ＝直していない");
assert.deepEqual(dangerOfEdit("ご案内いたします。よろしくお願いします", "ご案内致します。宜しくお願い致します"), [], "言い回しだけは危なくない");
assert.deepEqual(dangerOfEdit("初期費用は25万円です", "初期費用は28万円です"), ["金額"]);
assert.deepEqual(dangerOfEdit("12/5 14時にご案内します", "12/6 14時にご案内します"), ["日時"]);
assert.deepEqual(dangerOfEdit("グランハイツ 301号室はいかがでしょう", "グランハイツ 302号室はいかがでしょう"), ["物件"]);
assert.deepEqual(dangerOfEdit("空室です", "管理会社に確認させて頂きます"), ["約束"], "約束を足した（下書きが言い切っていた）");
const rows = [
  { scene: "cost", brain: "返信", truth: "返信", draft: "25万円です", sent: "25万円です" },
  { scene: "cost", brain: "返信", truth: "返信", draft: "25万円です", sent: "28万円です" },
  { scene: "cost", brain: "返信", truth: "AIX:estimate_sheet", draft: null, sent: null },
  { scene: "cost", brain: "返信", truth: "返信", draft: "空室です", sent: "確認させて頂きます", aixByText: true },
  { scene: "cost", brain: "AIX:estimate_sheet", truth: "AIX:estimate_sheet", draft: null, sent: null },
  { scene: "viewing", brain: "返信", truth: "返信", draft: null, sent: "手打ち" },
];
const t = delegationTable(rows);
const c = t.find((x) => x.scene === "cost")!;
assert.deepEqual([c.replyTurns, c.asIs, c.asIsRate, c.edited, c.danger, c.dangerKinds.金額], [2, 1, 50, 1, 1, 1], "人の文に AIX の中身がある番は返信の番に入れない");
assert.deepEqual([c.aixTurns, c.aixAsReply], [3, 2], "AIX の番 3 のうち ブレインが返信 2");
assert.equal(t.find((x) => x.scene === "viewing")!.replyTurns, 0, "下書きの無い手打ちは数えない");
assert.match(delegationLines(t, 3)[0], /^- cost: そのまま送れた 50%（1\/2）・危ない間違い 1（値の間違い 1・約束の言い過ぎ 0）（金額1）・AIX の番を返信にした 2\/3$/);
// 2026-11-28: 当てはめの絞り（日にちの書き方・約束の向き・普通のカタカナ）
assert.deepEqual(dangerOfEdit("11/18 に内覧", "11/18日に内覧"), [], "日にちの書き方の違いは同じ");
assert.deepEqual(dangerOfEdit("明日ご連絡します", "明日の朝ご連絡します"), [], "明日 と 明日の は同じ");
assert.deepEqual(dangerOfEdit("ピックアップしてお送りさせて頂きます", "オススメのお部屋です"), ["約束の言い過ぎ"], "普通のカタカナは物件にしない・消した約束は約束の言い過ぎ（統括役 11/28）");
assert.deepEqual(dangerOfEdit("ピックアップのお部屋です", "オススメのお部屋です"), [], "普通のカタカナは危なくない");
assert.equal(promiseDropped("物件お送りさせて頂きます", "かしこまりました"), true, "消した約束は別に数える");
assert.equal(promiseDropped("空室です", "確認させて頂きます"), false);
assert.deepEqual(dangerOfEdit("ご案内します", "グランハイツ 301号室で 25万円・12/5 にご案内します"), [], "スタッフが値を足しただけは危なくない");
console.log("delegation-index ok 17");
