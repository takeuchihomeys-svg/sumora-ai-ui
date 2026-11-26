// 2026-11-25 作業員L（台帳 #664 の①）: 約束の種類の網の広げ（PROMISE_KIND_WIDE2・既定 off）。言い回しは「その他」の残りの形（名前は入れない）
import assert from "node:assert/strict";
import { promiseWide2KindOf, promiseKindNameOf, promiseDropKindOf, promiseKindWide2On } from "../promise-drop-watch";

assert.equal(promiseKindWide2On({}), true, "既定 on（11/26）");
assert.equal(promiseKindWide2On({ PROMISE_KIND_WIDE2: "off" }), false, "=off で止まる");
assert.equal(promiseWide2KindOf("ご入居可能なお部屋をお送りさせて頂きます!"), "pickup");
assert.equal(promiseWide2KindOf("初期費用抑えられるお部屋もお送りさせていただきます"), "pickup");
assert.equal(promiseWide2KindOf("月曜日に室内写真撮影しお送りさせて頂きます"), null, "写真はピックアップでない");
assert.equal(promiseWide2KindOf("こちらでご入居日の最終確認をさせて頂きます。"), "check");
assert.equal(promiseWide2KindOf("礼金について、管理会社に減額交渉をさせて頂きます!"), "check");
assert.equal(promiseWide2KindOf("最大限割引して御見積書をご用意いたします"), "estimate");
assert.equal(promiseWide2KindOf("初期費用を最大限割引させて頂きます"), null, "決まり文句は約束にしない");
const on = { PROMISE_KIND_WIDE2: "on" };
assert.equal(promiseKindNameOf("ご入居可能なお部屋をお送りさせて頂きます!", { PROMISE_KIND_WIDE2: "off" }), "other", "off は今まで通り（その他）");
assert.equal(promiseKindNameOf("ご入居可能なお部屋をお送りさせて頂きます!", on), "pickup");
assert.equal(promiseDropKindOf("こちらでご入居日の最終確認をさせて頂きます。", on), "check");
assert.equal(promiseDropKindOf("最大限割引して御見積書をご用意いたします", on), null, "見張り（探す・確認だけ）には見積を足さない");
console.log("promise-kind-wide2: ok");
