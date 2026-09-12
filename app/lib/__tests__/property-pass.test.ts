// 2026-09-12 竹内（KENYOU 事例）: 送付物件の一部を外した（「フジパレスは無しでお願いします」）＝探索継続。
//   残りの物件を選んだ意味ではない・断り（お別れ）でもない・条件変更でもない
// 実行: npx tsx app/lib/__tests__/property-pass.test.ts
import {
  detectPropertyPass, analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse, resolveTurnPair, resolveClosing,
} from "../reply-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (JSON.stringify(actual) !== JSON.stringify(exp)) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

const KENYOU_STAFF = "現在KENYOUさん達のご条件に近いお部屋こちらになります！！\n1枚目のお部屋（住之江区平林南2丁目戸建）は中型犬の飼育可能となります😊！！\n\nフジパレス戸建賃貸切喜連三丁目3号室\nにつきましては、物件を管理しています管理会社土日休業の為月曜日中型犬飼育可能かご確認させて頂きます！！\n\nお手隙の際にご査収ください😌！！";
const pass = (t: string, staff = KENYOU_STAFF) => detectPropertyPass(t, { recentStaffText: staff })?.basis ?? null;

// ── 見送りとして拾う（実データ） ──
it("KENYOU: フジパレスは無しでお願いします → 建物名の見送り", () => expect(pass("フジパレスは無しでお願いします")).toBe("named"));
it("yasuki: プレサンスは無しでお願い致します。 → 見送り", () => expect(pass("プレサンスは無しでお願い致します。")).toBe("named"));
it("こちらの物件は大丈夫です😭 また、違う物件探して見ます！ → 指示語の見送り", () => expect(pass("こちらの物件は大丈夫です😭 また、違う物件探して見ます！")).toBe("demonstrative"));
it("あや: そちらの物件拝見しましたが（改行）今回はやめておきます → 見送り", () => expect(pass("ありがとうございます！\nそちらの物件拝見しましたが\n今回はやめておきます🙇🏻‍♀️💦")).toBe("demonstrative"));
it("ここはやめときます💦 → 見送り", () => expect(pass("ここはやめときます💦")).toBe("demonstrative"));
it("1枚目はなしでお願いします → 順番の見送り", () => expect(pass("1枚目はなしでお願いします")).toBe("ordinal"));
it("漢字の建物名は直近の物件送付文に建物として出た時だけ: 天下茶屋1丁目貸家は無しで", () =>
  expect(pass("天下茶屋1丁目貸家は無しで", "天下茶屋1丁目貸家のお申込お手続き完了させて頂きます。")).toBe("property_noun"));

// ── 見送りにしない ──
it("尼崎は無しでお願いします（地名＝条件の話）", () => expect(pass("尼崎は無しでお願いします！", "大阪市内・尼崎全域からピックアップさせて頂きます！！")).toBe(null));
it("オートロックは無しでも大丈夫です（設備の条件）", () => expect(pass("オートロックは無しでも大丈夫です")).toBe(null));
it("中崎町でも大丈夫です（受諾）", () => expect(pass("あと中崎町でも大丈夫です！")).toBe(null));
it("天下茶屋の申込は無しで（申込の取消＝断り側）", () => expect(pass("天下茶屋の申込は無しでお願いします")).toBe(null));
it("他で決めました（お部屋探しの終了）", () => expect(pass("こちらの物件は大丈夫です、他で決めました")).toBe(null));
it("住之江は内覧できますか？（質問）", () => expect(pass("住之江は無しですか？")).toBe(null));
it("一旦電話は大丈夫です（物件ではない）", () => expect(pass("一旦電話は大丈夫です")).toBe(null));

// ── 分類とセル ──
const classify = (cust: string, staffText = KENYOU_STAFF) => {
  const staff = classifyLastStaffTurn(staffText);
  const sub = analyzeSubstance(cust, [cust]);
  const customer = classifyCustomerResponse(sub, staff, { recentStaffText: staffText });
  const pair = resolveTurnPair(staff, customer, sub, staffText, { customerName: "KENYOU" });
  return { kind: customer.kind, object: customer.object, rule: pair.rule?.id ?? null };
};
it("KENYOU: 物件送付 → フジパレスは無しで → property_pass / ANY_PROPERTY_PASS（旧: other・セルなし）", () =>
  expect(classify("フジパレスは無しでお願いします")).toBe({ kind: "property_pass", object: "フジパレス", rule: "ANY_PROPERTY_PASS" }));
it("こちらの物件は大丈夫です → 断り（お別れ）ではなく探索継続（旧: decline → ANY_DECLINE）", () =>
  expect(classify("こちらの物件は大丈夫です😭 また、違う物件探して見ます！").rule).toBe("ANY_PROPERTY_PASS"));
it("見送り＋質問 → 質問が主（見送りは副）", () => {
  const staff = classifyLastStaffTurn(KENYOU_STAFF);
  const cust = "フジパレスは無しでお願いします\n住之江は駐車場ありますか？";
  const r = classifyCustomerResponse(analyzeSubstance(cust, [cust]), staff, { recentStaffText: KENYOU_STAFF });
  expect([r.kind, r.secondary.includes("property_pass")]).toBe(["question", true]);
});
it("見送り＋条件 → 条件変更が主", () => {
  const staff = classifyLastStaffTurn(KENYOU_STAFF);
  const cust = "フジパレスは無しでお願いします\n家賃8万以内で探してほしいです";
  const r = classifyCustomerResponse(analyzeSubstance(cust, [cust]), staff, { recentStaffText: KENYOU_STAFF });
  expect(r.kind).toBe("condition_change");
});
it("物件を送る前の「〇〇は無しで」は見送りにしない（送付実績なし）", () =>
  expect(classify("フジパレスは無しでお願いします", "ご条件お伺いしました！！ピックアップさせて頂きます！！").kind === "property_pass").toBe(false));
it("締め: 1つ前が物件の見送りなら、その後のお礼は締め（お別れ）ではない", () => {
  const sub = analyzeSubstance("ありがとうございます", ["ありがとうございます"]);
  expect(resolveClosing(sub, { kind: "ack_only" }, "かしこまりました！！新着でオススメできるお部屋で次第随時お送りさせていただきます😊！！", "こちらの物件は大丈夫です😭").kind).toBe(null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
