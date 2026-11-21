// npx tsx app/lib/__tests__/pickup-line-1121.test.ts
// 2026-11-21 作業員K2: 物件ピックアップした の竹内さんの型が負けている2か所（PICKUP_LINE_1121・既定 off）
import assert from "node:assert/strict";
import { pickupLine1121On, pickupInviteNote1121, pickupInviteRule1121, stripDatedInviteLines, searchedConditionsAddendum1121 } from "../pickup-line-1121";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };
t("既定 off", () => { assert.equal(pickupLine1121On({}), false); assert.equal(pickupLine1121On({ PICKUP_LINE_1121: "on" }), true); });
t("誘いの1行の指示は日時を書かない・入れない時の線つき", () => {
  const s = pickupInviteNote1121();
  assert.ok(s.includes("ご都合よろしいお日にちにご案内させて頂きます") && s.includes("日時") && s.includes("入れない"));
  assert.ok(!s.includes("最重要・内覧提案の省略"));
  assert.ok(pickupInviteRule1121("Aさん").includes("Aさんお気に召されたお部屋"));
});
// 竹内さんの直しの実物（名前は伏せた）
t("出口: 日時の無い誘いの1行は残し、日時・候補の行は落とす", () => {
  const text = "Aさん北浜周辺全域からAさんにオススメできる広めのお部屋ピックアップさせて頂きました！！\nお気に召されたお部屋ご都合よろしいお日にちにご案内させていただきます！！\nお手隙の際にご査収ください！！";
  assert.equal(stripDatedInviteLines(text).removed, 0);
  const dated = "Aさんお気に召されましたら直近ですと\n11/22(土) 10:00〜ご案内可能です！！\nお手隙の際にご査収ください😌！！";
  const r = stripDatedInviteLines(dated);
  assert.ok(r.removed >= 1 && !/直近|ご案内可能/.test(r.text), r.text);
  assert.ok(r.text.includes("ご査収"));
});
t("検索した条件の注意は数を増やさない", () => { const s = searchedConditionsAddendum1121(); assert.ok(s.includes("1つまで") && s.includes("増やす指示ではない")); });
console.log(`${n} ok`);
