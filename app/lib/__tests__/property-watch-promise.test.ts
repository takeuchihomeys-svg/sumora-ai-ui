// 2026-09-17 竹内（慶次事例）: 「オススメできるお部屋を随時確認して出次第お送りします」は
//   物件を探し続ける宣言＝物件ピックアップ（複数）／物件オススメ（1件）。管理会社への確認の約束ではない
// 実行: npx tsx app/lib/__tests__/property-watch-promise.test.ts
import { classifyStaffTextForLedger, classifyStaffTextFacts, isPropertyWatchDeclaration } from "../action-ledger";
import { resolveStaffPromiseAix } from "../aix-task-link";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const AT = "2026-09-17T12:31:00Z";
const kinds = (t: string) => classifyStaffTextFacts(t, AT).map((e) => e.kind).sort();

// 慶次 9/17 21:31（竹内さんのスクショ）
const KEIJI = "かしこまりました！！\nガスコンロ希望のご条件も含めて、慶次さんにオススメできるお部屋随時募集確認させて頂きます！！\n慶次さんのご条件に合ったお部屋出次第お送りさせて頂きます😊！！";

console.log("\n[探し続ける宣言の判定]");
it("実データ8件の言い回しを拾う", () => {
  expect(isPropertyWatchDeclaration("慶次さんにオススメできるお部屋随時募集確認させて頂きます！！")).toBe(true);
  expect(isPropertyWatchDeclaration("あきほさんにオススメできるお部屋新着状況随時確認させて頂き")).toBe(true);
  expect(isPropertyWatchDeclaration("引き続き新着で𝚂𝚊𝚗𝚊.さん達にオススメ出来るお部屋随時確認させて頂き")).toBe(true);
  expect(isPropertyWatchDeclaration("引き続き新着できむらさんにオススメできるお部屋確認させていただきます！！")).toBe(true);
  expect(isPropertyWatchDeclaration("新着でDaikiさんにオススメできるお部屋の募集確認させていただきます😌！！")).toBe(true);
  expect(isPropertyWatchDeclaration("新着で木下さんにオススメできるお部屋、募集に出ているか確認させていただきます！！")).toBe(true);
});
it("本物の確認の約束は拾わない（目的語が特定の物件・条件）", () => {
  expect(isPropertyWatchDeclaration("Nicher'a 加美の募集状況確認させていただきます！！")).toBe(false);
  expect(isPropertyWatchDeclaration("保証会社確認させて頂き、確認出来次第ご連絡させて頂きます！！")).toBe(false);
  expect(isPropertyWatchDeclaration("こちらのお部屋の駐車場の空き状況確認させて頂きます！！")).toBe(false);
  expect(isPropertyWatchDeclaration("お送り頂きました物件の募集状況確認させて頂きます！！")).toBe(false);
  expect(isPropertyWatchDeclaration("")).toBe(false);
});

console.log("\n[分類（慶次さんの通）]");
it("余分な confirmation_promised（設備）が付かない", () => {
  expect(kinds(KEIJI)).toBe(["pickup_declared"]);
  const e = classifyStaffTextForLedger(KEIJI, AT);
  expect(e?.kind).toBe("pickup_declared");
  expect(e?.detail?.watch).toBe(true);
});
it("「引き続き新着で…確認させていただきます」だけの通もピックアップの約束", () => {
  const t = "引き続き新着できむらさんにオススメできるお部屋確認させていただきます！！";
  expect(kinds(t)).toBe(["pickup_declared"]);
  expect(classifyStaffTextForLedger(t, AT)?.detail?.watch).toBe(true);
});
it("本物の確認の約束は confirmation_promised のまま", () => {
  expect(kinds("Nicher'a 加美の募集状況確認させていただきます！！")).toBe(["confirmation_promised"]);
  expect(classifyStaffTextForLedger("保証会社確認させて頂き、確認出来次第ご連絡させて頂きます！！", AT)?.detail?.object).toBe("保証会社");
});
it("1通に探し続ける宣言と本物の確認が両方ある時は両方残す", () => {
  const t = "慶次さんにオススメできるお部屋随時募集確認させて頂きます！！\n保証会社の件も確認出来次第ご連絡させて頂きます！！";
  expect(kinds(t)).toBe(["confirmation_promised", "pickup_declared"]);
});

console.log("\n[押す AIX（物件ピックアップ＋物件オススメ）]");
const msgs = [{ sender: "customer", text: "ガスコンロ付きが良いです" }, { sender: "staff", text: KEIJI }];
it("探し続ける約束 →「次第」が入っていても物件ピックアップをセットし、2つ目に物件オススメ", () => {
  const r = resolveStaffPromiseAix(
    { lastStaffEntry: classifyStaffTextForLedger(KEIJI, AT), estimatePromisedUnfulfilled: false, pickupPromisedUnfulfilled: true, confirmationPromisedUnfulfilled: false },
    msgs, { customerRequestedCheck: true },
  );
  expect(r?.action).toBe("property_send");
  expect(r?.kind).toBe("pickup");
  expect(r?.alt).toBe("property_recommendation");
});
it("AIX【物件確認した】にはならない（お客様から確認の依頼があっても）", () => {
  const r = resolveStaffPromiseAix(
    { lastStaffEntry: classifyStaffTextForLedger(KEIJI, AT), estimatePromisedUnfulfilled: false, pickupPromisedUnfulfilled: true, confirmationPromisedUnfulfilled: true },
    msgs, { customerRequestedCheck: true },
  );
  expect(r?.action === "property_check_result").toBe(false);
});
it("本物の確認の約束は従来どおり物件確認した（2つ目は無し）", () => {
  const t = "お送り頂きました物件の募集状況確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！";
  const r = resolveStaffPromiseAix(
    { lastStaffEntry: classifyStaffTextForLedger(t, AT), estimatePromisedUnfulfilled: false, pickupPromisedUnfulfilled: false, confirmationPromisedUnfulfilled: true },
    [{ sender: "customer", text: "https://suumo.jp/chintai/bc_1/ この物件空いてますか？" }, { sender: "staff", text: t }],
    { customerRequestedCheck: true },
  );
  expect(r?.action).toBe("property_check_result");
  expect(r?.alt).toBe(undefined);
});
it("従来の「次第」つきピックアップ宣言（探し続ける形でない）は AIX を付けない", () => {
  const t = "新着で良いお部屋が出次第お送りさせて頂きます！！";
  const r = resolveStaffPromiseAix(
    { lastStaffEntry: classifyStaffTextForLedger(t, AT), estimatePromisedUnfulfilled: false, pickupPromisedUnfulfilled: true, confirmationPromisedUnfulfilled: false },
    [{ sender: "customer", text: "お願いします" }, { sender: "staff", text: t }], {},
  );
  expect(r).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
