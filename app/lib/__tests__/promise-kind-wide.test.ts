// npx tsx app/lib/__tests__/promise-kind-wide.test.ts
// 2026-11-23 作業員L（竹内さん 11/23 P0・約束の細部）: PROMISE_KIND_WIDE（既定 off）で見張り・B1 の種類の網に足す言い回し
import assert from "node:assert/strict";
import { promiseWideKindOf, promiseKindWideOn, promiseDropKindOf, promiseKindNameOf } from "../promise-drop-watch";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
const ON = { PROMISE_KIND_WIDE: "on" };
const OFF = { PROMISE_KIND_WIDE: "off" };

t("既定は off・=on で使う", () => {
  assert.equal(promiseKindWideOn({}), false);
  assert.equal(promiseKindWideOn(ON), true);
  assert.equal(promiseKindWideOn({ PROMISE_KIND_WIDE: "ON " }), true);
});

t("探す: 「お部屋探させて頂きます」「広めのお部屋を探させて頂きます」「追加でお部屋お送りさせて頂きます」", () => {
  for (const s of ["更新可能なお部屋探させて頂きます！", "収納が狭いとのこと、広めのお部屋を探させて頂きます😊！", "広めのお部屋も含めて探させて頂きます！", "可能でしたら追加でお部屋お送りさせていただきます！"]) {
    assert.equal(promiseWideKindOf(s), "pickup", s);
    assert.equal(promiseDropKindOf(s, ON), "pickup", s);
    assert.equal(promiseDropKindOf(s, OFF), null, s);
  }
});

t("確認: 况の字・内覧可能・〜か交渉・管理会社にご連絡・分かり次第ご連絡", () => {
  for (const s of ["お送り頂きました物件の募集状况確認させて頂きます！", "いただきました内覧可能なお部屋も確認させていただきます！", "ご入居日を延ばす事が出来るか交渉させて頂きます！", "明日管理会社様にご連絡させて頂きます！", "実施されるかが分かりますので、分かり次第ご連絡させて頂きます！"]) {
    assert.equal(promiseWideKindOf(s), "check", s);
    assert.equal(promiseKindNameOf(s, ON), "check", s);
  }
});

t("電話・内覧の調整は種類の名前だけ（見張りの判定はしない）", () => {
  assert.equal(promiseKindNameOf("再度明日お電話かけさせていただきます！", ON), "callback");
  assert.equal(promiseDropKindOf("再度明日お電話かけさせていただきます！", ON), null);
  assert.equal(promiseKindNameOf("ご内覧時間調整させていただきますので", ON), "viewing_slot");
});

t("拾わない: 新着の随時・気持ちの言葉・申込以降の説明・過去の報告・お客様の送付待ち", () => {
  assert.equal(promiseDropKindOf("新着で〇〇様に合うお部屋随時探させて頂きます！", ON), null); // 新着は期日の無い約束（今まで通り）
  assert.equal(promiseWideKindOf("お部屋探し全力でサポートさせて頂きます！"), null);
  assert.equal(promiseWideKindOf("日割り家賃が追加で発生いたします！"), null);
  assert.equal(promiseDropKindOf("大きめのお部屋探させて頂きました！", ON), null);
  assert.equal(promiseDropKindOf("ご条件お送り頂きますと、お部屋探させて頂きます！", ON), null);
});

t("off の時は今までと同じ（今の網の言い回しは変わらない）", () => {
  for (const s of ["ピックアップさせて頂きます！", "募集状況確認させて頂きます！", "御見積書お送りさせて頂きます！"]) assert.equal(promiseKindNameOf(s, OFF), promiseKindNameOf(s, ON));
  assert.equal(promiseKindNameOf("お部屋探させて頂きます！", OFF), null); // 今は約束にも数えていない（B1 の分母の外）
});

console.log(`promise-kind-wide: ${n} ok`);
