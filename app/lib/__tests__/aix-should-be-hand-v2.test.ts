// npx tsx app/lib/__tests__/aix-should-be-hand-v2.test.ts
// 2026-11-23 作業員N2（台帳 #641）: 手打ちの網の2版（AIX_SHOULD_BE_HAND_V2・既定 off）
import assert from "node:assert/strict";
import { shouldBeAixOf, shouldBeHandV2On } from "../aix-should-be";

const ON = {}, OFF = { AIX_SHOULD_BE_HAND_V2: "off" };
const promiseOnly = "はい😊！！\n引き続き新着でオススメできるお部屋募集に出次第お送りさせていただきます！！\n何卒よろしくお願い致します😌！！";
const condAck = "かしこまりました！！\n初期費用も出来る限り抑えられるお部屋を中心に、新着のお部屋募集状況を随時確認させて頂きオススメできるお部屋が新たに募集が出次第お送りさせて頂きます！！";
const searched = "現在ご希望のご条件で探させて頂きましたが、ご満足頂けるお部屋が募集に出ていない状況となります！！新着で出次第すぐにお送りさせて頂きます！！";
const apply = "13階のお部屋現在1人審査中となります！その為2番手でのお申込となります！！";
const screening = "管理会社に確認させていただきましたが、まだ一番手お申込みの方での審査中とのご返事でした！！";
const planOnly = "本日お時間頂きありがとうございました！！903号室2番手でお申込みと同時並行でおすすめできる物件が出次第お送りさせて頂きます！";

assert.equal(shouldBeHandV2On({}), true, "既定 on"); assert.equal(shouldBeHandV2On(OFF), false, "=off で止まる");
// off は今まで通り
assert.equal(shouldBeAixOf(promiseOnly, { mode: "hand", env: OFF })?.strength, "strong");
assert.equal(shouldBeAixOf(apply, { mode: "hand", env: OFF })?.key, "property_check_result/available");
// ① 出次第だけの一文は strong にしない（全力サポートの weak のまま）
for (const s of [promiseOnly, condAck]) { const r = shouldBeAixOf(s, { mode: "hand", env: ON }); assert.equal(r?.key, "zenryoku_support"); assert.equal(r?.strength, "weak"); }
// 探した結果の報告がある時は今まで通り（全力サポートか確認の結果。strong の網の外へは出さない）
const rs = shouldBeAixOf(searched, { mode: "hand", env: ON });
assert.deepEqual([rs?.key, rs?.strength], [shouldBeAixOf(searched, { mode: "hand", env: OFF })?.key, shouldBeAixOf(searched, { mode: "hand", env: OFF })?.strength], "探した結果の文は off と同じ");
// ② 申込の状況は物件確認した（申込状況）の strong・ボタンは同じ（見張りの採点はボタンで比べる）
const ra = shouldBeAixOf(apply, { mode: "hand", env: ON });
assert.equal(ra?.key, "property_check_result/mgmt_application_status");
assert.equal(ra?.strength, "strong");
assert.equal(ra?.button, shouldBeAixOf(apply, { mode: "hand", env: OFF })?.button);
// 他のはっきりした確認の結果（審査）は残す・言い切りの無い申込の案内の文は申込状況にしない
assert.equal(shouldBeAixOf(screening, { mode: "hand", env: ON })?.key, shouldBeAixOf(screening, { mode: "hand", env: OFF })?.key);
assert.notEqual(shouldBeAixOf(planOnly, { mode: "hand", env: ON })?.key, "property_check_result/mgmt_application_status");
assert.notEqual(shouldBeAixOf(planOnly, { mode: "hand", env: ON })?.strength, "strong");
// 約束だけ（確認させて頂きます）は当てない
assert.equal(shouldBeAixOf("申込の状況を管理会社に確認させて頂きます！！2番手でのお申込が可能か確認出来次第ご連絡させて頂きます！！", { mode: "hand", env: ON })?.strength === "strong", false);
console.log("aix-should-be-hand-v2: ok");
