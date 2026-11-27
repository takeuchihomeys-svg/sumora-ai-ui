// app/lib/__tests__/pending-check-answered.test.ts — #829 PENDING_CHECK_ANSWERED_GUARD（実送信の文を名前を伏せて使う）
import assert from "node:assert/strict";
import { pendingCheckAnsweredByStaff, allPendingChecksAnswered, dropAnsweredCheck, type PcaMessage } from "../pending-check-answered";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };
const T0 = "2026-11-01T01:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const staff = (min: number, text: string, isAix = false): PcaMessage => ({ sender: "staff", text, createdAt: at(min), isAix });
const cust = (min: number, text: string): PcaMessage => ({ sender: "customer", text, createdAt: at(min) });

t("文の答え（管理会社に確認させていただき〜とのことです）は答え済み", () => {
  const v = pendingCheckAnsweredByStaff({ taskCreatedAt: T0, messages: [staff(30, "管理会社に確認させていただき、 奇数階が白基調、偶数階がブラウン調とのことです！！")] });
  assert.equal(v.answered, true); assert.equal(v.by, "text");
});
t("募集終了の答えは答え済み", () => {
  assert.equal(pendingCheckAnsweredByStaff({ taskCreatedAt: T0, messages: [staff(5, "12階のお部屋は募集が終了しております！！")] }).answered, true);
});
t("確認させていただきましたが担当者がお休み＝まだ答えていない（実送信 11月）", () => {
  const v = pendingCheckAnsweredByStaff({ taskCreatedAt: T0, messages: [staff(5, "管理会社に確認させていただきましたが、◯さんお休みとなり入居可能日の確認が取れておりません。 明日出社次第ご連絡頂けます")] });
  assert.equal(v.answered, false);
});
t("タスクの作成より前の答えは数えない", () => {
  assert.equal(pendingCheckAnsweredByStaff({ taskCreatedAt: T0, messages: [staff(-10, "管理会社に確認しましたところ募集中とのことです！！")] }).answered, false);
});
t("お客様の通は数えない", () => {
  assert.equal(pendingCheckAnsweredByStaff({ taskCreatedAt: T0, messages: [cust(5, "管理会社に確認しましたところ空いているとのことです")] }).answered, false);
});
t("答えの後にこちらが確認の約束を出したら確認中に戻す（別の依頼）", () => {
  const v = pendingCheckAnsweredByStaff({ taskCreatedAt: T0, messages: [
    staff(5, "管理会社に確認させていただき、内覧可能とのことです！"),
    cust(20, "こちらも空いてますか"),
    staff(25, "かしこまりました！！ お送り頂きましたお部屋の募集状況確認させて頂きます😊！！ 確認出来次第ご連絡させて頂きます！！"),
  ] });
  assert.equal(v.answered, false);
});
t("確認中の約束だけ（確認させていただいております）は答えではない", () => {
  assert.equal(pendingCheckAnsweredByStaff({ taskCreatedAt: T0, messages: [staff(5, "ただいま管理会社担当者の方に室内設備に関して確認させていただいております！！")] }).answered, false);
});
t("時刻が読めない時は答え済みにしない", () => {
  assert.equal(pendingCheckAnsweredByStaff({ taskCreatedAt: null, messages: [staff(5, "募集が終了しております")] }).answered, false);
});
t("pending が2つで片方だけ答え済みなら外さない", () => {
  const ms = [staff(5, "管理会社に確認しましたところ、お申込みが入っているとのことです！！")];
  const r = allPendingChecksAnswered([{ created_at: T0 }, { created_at: at(10) }], ms);
  assert.equal(r.all, false);
  assert.deepEqual(dropAnsweredCheck(["property_check", "estimate"], r.all), ["property_check", "estimate"]);
});
t("全部答え済みなら property_check だけ外す", () => {
  const r = allPendingChecksAnswered([{ created_at: T0 }], [staff(5, "お送り頂きましたお部屋ですが現在募集終了しておりました！！")]);
  assert.equal(r.all, true);
  assert.deepEqual(dropAnsweredCheck(["property_check", "estimate"], r.all), ["estimate"]);
});
t("pending が無ければ外さない", () => {
  assert.equal(allPendingChecksAnswered([], [staff(5, "募集が終了しております")]).all, false);
});

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
