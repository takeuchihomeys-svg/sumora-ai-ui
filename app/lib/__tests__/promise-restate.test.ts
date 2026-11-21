// npx tsx app/lib/__tests__/promise-restate.test.ts
// 2026-11-21 作業員K2（台帳 #442）: 約束の言い直しの見分け（PROMISE_RESTATE_MARK・既定 off）。言い回しは竹内さんたちの実送信の形（名前・物件は伏せた）
import assert from "node:assert/strict";
import { promiseRestates, promiseRestateNote, promiseRestateMarkOn } from "../promise-restate";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const prior = ["〇〇さんかしこまりました！！ご条件に合うお部屋ピックアップ出来次第お送りさせて頂きます！！"];
t("既定 off", () => { assert.equal(promiseRestateMarkOn({}), false); assert.equal(promiseRestateMarkOn({ PROMISE_RESTATE_MARK: "on" }), true); });
t("お礼だけの番に同じピックアップの約束をまた書く＝言い直し", () => {
  const h = promiseRestates("ありがとうございます！！引き続きピックアップ出来次第お送りさせて頂きます！！", prior, ["ありがとうございます、よろしくお願いします"]);
  assert.equal(h.length, 1); assert.equal(h[0].kind, "restate"); assert.equal(h[0].topic, "pickup"); assert.equal(h[0].back, 1);
  // ピックアップの約束は竹内さんたちも言い直す方が多い（30日 AI だけ 4・両方 15）＝注記には出さない
  assert.equal(promiseRestateNote(h), "");
});
t("催促（まだですか）の番は言い直してよい", () => {
  const h = promiseRestates("申し訳ございません！！本日中にピックアップしてお送りさせて頂きます！！", prior, ["物件まだですか？"]);
  assert.equal(h[0].kind, "reminder"); assert.equal(promiseRestateNote(h), "");
});
t("新しい条件を足した番は新しい約束", () => {
  const h = promiseRestates("かしこまりました！！ペット可のお部屋でピックアップさせて頂きます！！", prior, ["ペット可も条件に入れてほしいです"]);
  assert.equal(h[0].kind, "new_scope");
});
t("前に同じ中身の約束が無い・約束でない文は空", () => {
  assert.deepEqual(promiseRestates("御見積書作成させて頂きます！！", prior, ["初期費用知りたいです"]), []);
  assert.deepEqual(promiseRestates("ありがとうございます！！", prior, ["ありがとうございます"]), []);
});
t("確認できた時のご連絡の言い直しは注記に出す（30日 AI だけ 9・両方 2）", () => {
  const prior2 = ["かしこまりました！！管理会社に確認させて頂き、確認出来次第ご連絡させて頂きます！！"];
  const h = promiseRestates("ありがとうございます！！確認出来次第ご連絡させて頂きます😌！！", prior2, ["ありがとうございます！"]);
  assert.ok(h.some((x) => x.kind === "restate" && x.topic === "contact"), JSON.stringify(h));
  assert.ok(promiseRestateNote(h).includes("確認できた時のご連絡"));
});
console.log(`${n} ok`);
