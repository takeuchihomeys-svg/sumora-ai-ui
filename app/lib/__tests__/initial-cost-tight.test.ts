// 2026-09-14 くれあ事例: ⑦初期費用の限度額が家賃の3倍未満なら「初期費用を抑える」一文を入れる
// 実行: npx tsx app/lib/__tests__/initial-cost-tight.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveInitialCostTight, manAmounts, INITIAL_COST_SAVE_DECL_RE, insertInitialCostSave } from "../initial-cost-tight";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const form = (rent: string, cost: string) =>
  `（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒10〜11月\n②【ご希望の家賃（◯万円〜◯万円）】⇒${rent}\n③【希望の広さ・間取り】⇒1LDK以上\n⑤【ご希望のエリア・駅名】⇒北新地\n⑦【初期費用の限度額】⇒${cost}\n⑧【その他ご要望あれば】⇒`;

it("くれあ: 家賃15〜17万・限度額「10〜20」（単位なし＝万円）→ 20万 < 45万 で抑えたい", () => {
  const v = resolveInitialCostTight(form("15〜17万", "10〜20"));
  expect(v.tight).toBe(true);
  expect(v.reason).toBe("ratio_under_3");
  expect(v.limitMan).toBe(20);
  expect(v.rentMinMan).toBe(15);
});
it("限度額が家賃の3倍以上（40万・家賃8〜13万）→ 判定しない", () => expect(resolveInitialCostTight(form("8万円〜13万円", "40万円程度")).tight).toBe(false));
it("「なるべく安く」等の言葉 → 抑えたい", () => expect(resolveInitialCostTight(form("8万以内が理想", "なるべく安く")).reason).toBe("wants_low"));
it("「家賃の3ヶ月分以内」→ 抑えたい／「5ヶ月」→ 判定しない", () => {
  expect(resolveInitialCostTight(form("7万", "家賃の3ヶ月分以内")).tight).toBe(true);
  expect(resolveInitialCostTight(form("7万", "5ヶ月分くらい")).tight).toBe(false);
});
it("未定・空欄・⑦が無い → 判定しない", () => {
  expect(resolveInitialCostTight(form("7万", "わからない")).tight).toBe(false);
  expect(resolveInitialCostTight(form("7万", "")).tight).toBe(false);
  expect(resolveInitialCostTight("北新地で1LDK探してます").tight).toBe(false);
});
// 2026-09-16 竹内（M さん事例）「初期費用のところできれば0とお客さん言っているのだから、初期費用抑える旨の文言いれる」
it("M さん: ⑦「出来れば0」（家賃6〜7万）→ 抑えたい（0 は一番抑えたい）", () => {
  const v = resolveInitialCostTight(form("6-7万", "出来れば0"));
  expect(v.tight).toBe(true);
  expect(v.reason).toBe("zero_limit");
  expect(v.limitMan).toBe(0);
});
it("0 の書き方（できれば0・0円・ゼロ・0万）→ 全部抑えたい", () => {
  for (const c of ["できれば0", "0円", "ゼロ", "0万", "可能なら0円"]) expect(resolveInitialCostTight(form("8万", c)).reason).toBe("zero_limit");
});
it("「10万」「20万円」は金額として読む（0 の判定に落ちない）", () => {
  expect(resolveInitialCostTight(form("6万、6.5 共益費込み", "10")).reason).toBe("ratio_under_3");       // 10万 < 18万
  expect(resolveInitialCostTight(form("7-10万円（管理費込み）", "20万円")).reason).toBe("ratio_under_3"); // 20万 < 21万
  expect(resolveInitialCostTight(form("12万〜14万円台", "30万")).reason).toBe("ratio_under_3");            // 30万 < 36万（実データ 8/11 もスタッフは一文あり）
  expect(resolveInitialCostTight(form("3~5万 管理費込み", "10万")).tight).toBe(false);                    // 10万 >= 9万（3倍の境目・従来どおり）
});
it("「少ければ少ないほど」「安ければ助かります」も抑えたい（実データのスタッフ実送信は一文あり）", () => {
  expect(resolveInitialCostTight(form("駐車場など諸々込みで月10万円以下", "少ければ少ないほどありがたいです")).reason).toBe("wants_low");
  expect(resolveInitialCostTight(form("7〜8万", "安ければ助かります。")).reason).toBe("wants_low");
  expect(resolveInitialCostTight(form("1LDK", "できる限り安くでお願いします")).reason).toBe("wants_low");
});
it("「特に無し」「こだわりなし」は指定なし → 判定しない（実データのスタッフ実送信も一文なし）", () => {
  for (const c of ["特に無し", "こだわりなし", "なし", "未定", "不明", "-"]) expect(resolveInitialCostTight(form("〜13万", c)).tight).toBe(false);
  // 「敷金礼金なし希望」は指定なしではない（抑えたい側）
  expect(resolveInitialCostTight(form("8万", "敷金礼金なしが希望で安ければ")).tight).toBe(true);
});
it("金額の読み: 4万5000円・70,000〜120,000・10〜20", () => {
  expect(manAmounts("4万5000円以内").join(",")).toBe("4.5");
  expect(manAmounts("70,000〜120,000").join(",")).toBe("7,12");
  expect(manAmounts("10〜20").join(",")).toBe("10,20");
});
it("返信側の検出: スタッフの実文（くれあ）", () => {
  expect(INITIAL_COST_SAVE_DECL_RE.test("初期費用も最大限割引させて頂き出来る限りくれあさんのお引越しにかかる費用抑えさせていただきます！！")).toBe(true);
  expect(INITIAL_COST_SAVE_DECL_RE.test("くれあさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます")).toBe(false);
});

it("差し込み: 締め（何卒）の前に顧客名入りで入れる・既にあれば入れない", () => {
  const draft = "ご条件お送り頂きありがとうございます😊！！\n北新地周辺全域からくれあさんにオススメできるお部屋ピックアップしてお送りさせて頂きます！！\n何卒よろしくお願い致します！！";
  const r = insertInitialCostSave(draft, "くれあ");
  expect(r.inserted).toBe(true);
  expect(r.text.split("\n")[2]).toBe("初期費用も最大限割引させて頂きくれあさんのお引越しにかかる費用を出来る限り抑えさせて頂きます！！");
  expect(insertInitialCostSave(r.text, "くれあ").inserted).toBe(false);
});
it("差し込み: 全力サポートの行があればその前・締めが無ければ末尾・名前不明なら呼びかけなし", () => {
  const d1 = "…ピックアップしてお送りさせて頂きます！！\nくれあさんがご満足頂くお部屋が見つかるまで全力でサポートさせて頂きます！！";
  expect(insertInitialCostSave(d1, "くれあ").text.split("\n")[1].startsWith("初期費用も最大限割引")).toBe(true);
  expect(insertInitialCostSave("…ピックアップしてお送りさせて頂きます！！", "").text.endsWith("初期費用も最大限割引させて頂きお引越しにかかる費用を出来る限り抑えさせて頂きます！！")).toBe(true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
