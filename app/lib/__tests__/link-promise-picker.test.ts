// つなぎ①（約束→ピッカー）・⑤（新着とピックアップ）を太くする（LINK_PROMISE_PICKER）。LLM なし・DB なし。文は実物の型（名前・物件名は伏せた）
// 実行: npx tsx app/lib/__tests__/link-promise-picker.test.ts
import { confirmObjectOf, boundObjectTopicOf, stripObjectBoundVacancy, classifyStaffTextFacts, pickupPromiseKindOf, pickupPickerKey, linkPromisePickerEnabled, checkPatternForConfirmTopic } from "../action-ledger";
import { promisesInStaffText } from "../promise-queue";
import { classifyHandFulfillment, isPickupButtonMislabeled } from "../link-brain-watch";
import { resolveStaffPromiseAix, linkPromiseNewArrivalRecEnabled } from "../aix-task-link";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function withEnv(k: string, v: string | undefined, fn: () => void) { const old = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; try { fn(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; } }
const AT = "2026-10-13T04:52:07.000Z";

console.log("① 確認の対象の読み（要件に付いた空き・募集）");
it("切替の既定は on・=off で止まる", () => { eq(linkPromisePickerEnabled({}), true); eq(linkPromisePickerEnabled({ LINK_PROMISE_PICKER: "off" }), false); });
it("「駐車場の空き状況確認させて頂きます」は駐車場（空室ではない）→ mgmt_parking", () => {
  eq(confirmObjectOf("駐車場の空き状況確認させて頂きます！！"), "駐車場");
  eq(checkPatternForConfirmTopic(confirmObjectOf("駐車場の空き状況確認させて頂きます！！")), "mgmt_parking");
});
it("「駐輪場、駐車場の空き状況」「バイク置き場の募集状況」も駐車場のピッカー", () => {
  eq(checkPatternForConfirmTopic(confirmObjectOf("管理会社担当者に駐輪場、駐車場の空き状況催促させていただいております")), "mgmt_parking");
  eq(checkPatternForConfirmTopic(confirmObjectOf("バイク置き場の募集状況確認させて頂きます")), "mgmt_parking");
});
it("物件そのものの募集状況は今まで通り（並べた言い方・お部屋を挟む言い方）", () => {
  eq(confirmObjectOf("お送り頂きました物件の募集状況と猫飼育可能か確認させて頂きます"), "募集状況");
  eq(confirmObjectOf("ご内覧可否と募集状況を管理会社に確認させて頂きます"), "募集状況");
  eq(boundObjectTopicOf("退去予定のお部屋の募集状況確認させて頂きます"), null);
  eq(boundObjectTopicOf("お送り頂きましたお部屋9月末退去予定で募集されております"), null);
  eq(confirmObjectOf("こちらのお部屋の空き状況確認させて頂きます"), "空室");
});
// 2026-10-22 AIX_NEW_PICKERS_1020 を既定 on にした: 旧（今まで通り）は2つの切替を off にした時
it("off の時は今まで通り（空室）", () => withEnv("AIX_NEW_PICKERS_1020", "off", () => withEnv("LINK_PROMISE_PICKER", "off", () => eq(confirmObjectOf("駐車場の空き状況確認させて頂きます！！"), "空室"))));
it("約束の並び: 駐車場の空き状況の約束は 確認（mgmt_parking）だけ・募集状況の確認を足さない", () => {
  const steps = promisesInStaffText("福田さん\n駐車場の空き状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", AT);
  eq(steps.map((s) => `${s.kind}:${s.checkPattern ?? "-"}:${s.pickerKey ?? "-"}`), ["confirm:mgmt_parking:mgmt_parking"]);
});
it("約束の並び（off）: 旧は 募集状況の確認（check）になっていた", () => withEnv("AIX_NEW_PICKERS_1020", "off", () => withEnv("LINK_PROMISE_PICKER", "off", () => {
  const steps = promisesInStaffText("福田さん\n駐車場の空き状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！", AT);
  eq(steps.map((s) => s.kind), ["check"]);
})));
it("要件の句を外す（約束の並びの募集状況の拾い）", () => {
  eq(/空き/.test(stripObjectBoundVacancy("駐車場の空き状況確認させて頂きます")), false);
  eq(/募集/.test(stripObjectBoundVacancy("お部屋の募集状況確認させて頂きます")), true);
});

console.log("② 約束の記録に種類とピッカー");
it("新着の約束 → pickupKind=new_arrival・pickerKey=物件オススメ（新着1件）", () => {
  const e = classifyStaffTextFacts("引き続き新着でオススメ出来るお部屋募集に出次第お送りさせて頂きます！！", AT).find((x) => x.kind === "pickup_declared");
  eq(e?.detail.pickupKind, "new_arrival");
  eq(e?.detail.pickerKey, "property_recommendation/pickup_type=新着1件");
});
it("ピックアップの約束 → pickupKind=pickup・pickerKey=property_send", () => {
  const e = classifyStaffTextFacts("かしこまりました！！心斎橋周辺でオススメできるお部屋ピックアップしお送りさせて頂きます！！", AT).find((x) => x.kind === "pickup_declared");
  eq(e?.detail.pickupKind, "pickup");
  eq(e?.detail.pickerKey, "property_send");
});
it("確認の約束 → pickerKey=check_pattern（ペット）", () => {
  const e = classifyStaffTextFacts("ペット飼育可能か確認させて頂きます！！確認出来次第ご連絡させて頂きます！！", AT).find((x) => x.kind === "confirmation_promised");
  eq(e?.detail.pickerKey, "mgmt_pet");
});
it("off の時は記録に足さない", () => withEnv("LINK_PROMISE_PICKER", "off", () => {
  const e = classifyStaffTextFacts("引き続き新着でオススメ出来るお部屋募集に出次第お送りさせて頂きます！！", AT).find((x) => x.kind === "pickup_declared");
  eq(e?.detail.pickupKind, undefined); eq(e?.detail.pickerKey, undefined);
}));
it("種類の判定は約束の並びと同じ線", () => {
  eq(pickupPromiseKindOf("お部屋探し継続させていただきます", null), "new_arrival");
  eq(pickupPromiseKindOf("ピックアップしお送りさせて頂きます", null), "pickup");
  eq(pickupPromiseKindOf(null, null, true), "new_arrival");
  eq(pickupPickerKey("pickup"), "property_send");
});

console.log("⑤ 新着とピックアップのボタン");
it("新着の約束を 物件ピックアップした（新着まとめ）で果たした＝取り違えではない", () => {
  eq(isPickupButtonMislabeled(true, "property_send", "new_arrival"), false);
  eq(isPickupButtonMislabeled(true, "property_recommendation", null), false);
  eq(isPickupButtonMislabeled(true, "property_send", "normal"), true);
  eq(isPickupButtonMislabeled(true, "property_send", null), true);
  eq(isPickupButtonMislabeled(false, "property_recommendation", null), true);
  eq(isPickupButtonMislabeled(false, "property_send", "new_arrival"), false);
});
it("off の時は旧の数え（新着の約束→物件ピックアップした は全部取り違え）", () => eq(isPickupButtonMislabeled(true, "property_send", "new_arrival", { LINK_PROMISE_PICKER: "off" }), true));
it("新着の約束の続き: 既定（2026-10-22 から on）は 物件オススメが先（＋物件ピックアップした）・LINK_PROMISE_NEW_ARRIVAL_REC=off で旧の 物件ピックアップした", () => {
  const facts = { lastStaffEntry: { kind: "pickup_declared", status: "promised", evidence: "確認させて", detail: { watch: true, pickupKind: "new_arrival" as const } }, estimatePromisedUnfulfilled: false, pickupPromisedUnfulfilled: true };
  const msgs = [{ sender: "customer", text: "お願いします" }, { sender: "staff", text: "引き続き新着でオススメ出来るお部屋随時確認させて頂きます" }];
  eq(linkPromiseNewArrivalRecEnabled({}), true);
  withEnv("LINK_PROMISE_NEW_ARRIVAL_REC", "off", () => eq(resolveStaffPromiseAix(facts, msgs, {})?.action, "property_send"));
  withEnv("LINK_PROMISE_NEW_ARRIVAL_REC", undefined, () => {
    const r = resolveStaffPromiseAix(facts, msgs, {});
    eq(r?.action, "property_recommendation"); eq((r as { alt?: string } | null)?.alt, "property_send");
  });
});

console.log("③ 手打ちで果たした中身の分け方");
it("見積書の金額 → 見積書送る", () => eq(classifyHandFulfillment("最大限割引しました初期費用の御見積書となります！！").action, "estimate_sheet"));
it("設備の報告 → 管理会社に確認した→設備", () => eq(classifyHandFulfillment("管理会社にエアコンの件確認させていただき、リビング洋室共に備わっております。とのご返答でした！！").checkPattern, "mgmt_equipment"));
it("募集終了 → 物件なかった", () => eq(classifyHandFulfillment("12階のお部屋は募集が終了しております！！").checkPattern, "unavailable"));
it("お子様の入居の条件 → ピッカー無し（新しいピッカーの候補）", () => eq(classifyHandFulfillment("管理会社担当者よりご返事があり、過去に小学生以下の年齢のご入居者様でトラブルがあり").action, null));
it("審査の結果 → ピッカー無し（新しいピッカーの候補）", () => eq(classifyHandFulfillment("他仲介業者からのお申込みで審査を継続出来ないとのことです").topic, "審査の結果"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
