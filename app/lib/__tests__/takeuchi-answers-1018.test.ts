// 2026-10-18 竹内さん 10/18 夜の答え（鍵は入居日・二人入居は資料で即答・家族と相談はサポートの姿勢）のテスト
// 実行: npx tsx app/lib/__tests__/takeuchi-answers-1018.test.ts
import { matchCompanyFacts, COMPANY_FACTS } from "../company-facts";
import { detectContractTermTopics, routeContractTerm, readTwoPersonMaterial, buildContractTermsNote } from "../contract-terms-question";
import { consideringDirectionFor, ensureFamilyConsultSupport, familyConsultSimpleNote } from "../takeuchi-reply-form-r13";
import { hesitationMoveOf } from "../customer-mindset";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ids = (t: string) => matchCompanyFacts(t).map((f) => f.id);
const fact = (id: string) => COMPANY_FACTS.find((f) => f.id === id)!.fact;

// ── 1. 鍵は入居日に渡す ──
it("前倒しの依頼にも鍵の事実が当たる", () => {
  ok(ids("19日中に鍵もらうこと可能でしょうか？").includes("key_handover"), "当たらない");
  ok(ids("鍵って先にもらえたりしますか？").includes("key_handover"), "当たらない2");
});
it("鍵の事実: 入居日より前には渡さない・前倒しは入居日にお渡しの旨", () => {
  const f = fact("key_handover");
  ok(f.includes("ご入居日より前にはお渡ししない"), "前に渡さないが無い");
  ok(f.includes("前倒し"), "前倒しの扱いが無い");
  ok(!/基本\*\*ご入居日/.test(f), "「基本は」が残っている");
});
it("鍵の事実: KEY_HANDOVER_MOVE_IN_DAY=off で 10/16 の文", () => {
  process.env.KEY_HANDOVER_MOVE_IN_DAY = "off";
  try { ok(fact("key_handover").includes("基本**ご入居日に弊社の事務所**"), "戻らない"); } finally { delete process.env.KEY_HANDOVER_MOVE_IN_DAY; }
});

// ── 2. 二人入居は資料で即答 ──
it("二人入居の問いを契約条件として拾う（探す条件・広さの相談は外す）", () => {
  ok(detectContractTermTopics("ふたり入居可ですか？").includes("two_person"), "ふたり");
  ok(detectContractTermTopics("こちら2人入居できますか？").includes("two_person"), "2人");
  ok(!detectContractTermTopics("1LDKにしたら2人入居は厳しいでしょうか？").includes("two_person"), "厳しい");
  ok(!detectContractTermTopics("追加で2人入居可能で、築年数10年以内で一度探してもらえると助かります！").includes("two_person"), "探す");
});
it("TWO_PERSON_MATERIAL_ANSWER=off で拾わない", () => {
  process.env.TWO_PERSON_MATERIAL_ANSWER = "off";
  try { ok(!detectContractTermTopics("ふたり入居可ですか？").includes("two_person"), "off でも拾う"); } finally { delete process.env.TWO_PERSON_MATERIAL_ANSWER; }
});
it("資料の読み: 可・不可・単身限定・相談・両方", () => {
  ok(readTwoPersonMaterial(["条件: 二人入居可 楽器不可"], null)?.verdict === "可", "可");
  ok(readTwoPersonMaterial([], "備考\n2人入居可能\nペット不可")?.verdict === "可", "可能");
  ok(readTwoPersonMaterial(["条件: 二人入居不可"], null)?.verdict === "不可", "不可");
  ok(readTwoPersonMaterial([], "単身者限定")?.verdict === "不可", "単身者限定");
  ok(readTwoPersonMaterial(["条件: 二人入居相談"], null) === null, "相談は言い切れない");
  ok(readTwoPersonMaterial(["ルームシェア不可"], null) === null, "ルームシェア不可は見ない");
  ok(readTwoPersonMaterial(["二人入居可", "単身者限定"], null) === null, "食い違いは確認");
});
it("道: 資料に記載→本文で即答／無い→確認", () => {
  const a = routeContractTerm("two_person", { lines: ["条件: 二人入居可"] });
  ok(a.route === "material" && a.facts[0].startsWith("二人入居可"), JSON.stringify(a));
  const b = routeContractTerm("two_person", { lines: ["駐車場: なし"], pdfText: "" });
  ok(b.route === "confirm", JSON.stringify(b));
  const note = buildContractTermsNote({ name: "テスト荘", roomNo: "101" }, [a]);
  ok(note.includes("二人入居") && note.includes("確認の約束はしない"), note);
});
it("会社の事実: 資料にあれば即答・無い時だけ確認の約束・代理契約は交渉", () => {
  const f = fact("proxy_two_person_check");
  ok(f.includes("資料のとおりに本文で即答") && f.includes("交渉させて頂きます") && f.includes("物件ごとに異なる"), f.slice(0, 80));
  process.env.TWO_PERSON_MATERIAL_ANSWER = "off";
  try { ok(fact("proxy_two_person_check").includes("可否を本文で言い切らない"), "off で戻らない"); } finally { delete process.env.TWO_PERSON_MATERIAL_ANSWER; }
});

// ── 3. ライフライン（事実の文） ──
it("ライフラインの事実: 約束→AIX【ライフラインについて】", () => {
  ok(fact("utilities_procedure").includes("ライフラインについて"), "AIX の案内が無い");
  process.env.AIX_MGMT_LIFELINE = "off";
  try { ok(!fact("utilities_procedure").includes("ライフラインについて"), "off で戻らない"); } finally { delete process.env.AIX_MGMT_LIFELINE; }
});

// ── 4. 家族と相談はサポートの姿勢 ──
it("家族と相談の方向: 申込の一言・内覧の案内を置かずサポートの1文", () => {
  const d = consideringDirectionFor({ afterEstimateOrCheck: true, afterPropertyDetails: false, familyConsult: true });
  ok(d.includes("いつでもお気軽にご連絡ください") && d.includes("申込の一言（お部屋抑え）・内覧の案内・催促") && !d.includes("お部屋抑えさせて頂きます！！」③"), d);
});
it("ブレインの材料: 家族と相談は 10/15 の柔らかい一手を添えない", () => {
  const m = hesitationMoveOf("家族・同居人に相談", {});
  ok(!m.includes("柔らかい次の一手") && m.includes("サポートの姿勢"), m);
  const m2 = hesitationMoveOf("家族・同居人に相談", { FAMILY_CONSULT_SUPPORT: "off" });
  ok(m2.includes("柔らかい次の一手"), "off で旧に戻らない");
  ok(familyConsultSimpleNote({ FAMILY_CONSULT_SUPPORT: "off" }).includes("10/16"), "off の注");
});
it("出口: サポートの1文が無ければ足す・あれば触らない・家族の番でなければ触らない", () => {
  const a = ensureFamilyConsultSupport("はい😊！！\nごゆっくりご検討頂けますと幸いです！！", { familyConsult: true, name: "ゆうこ" }, {});
  ok(a.added && a.text.endsWith("ゆうこさん気になる点等出てきましたらいつでもお気軽にご連絡ください😌！！"), a.text);
  const b = ensureFamilyConsultSupport("はい😊！！\n気になる点出てきましたら何時でもお気軽にご連絡ください！！", { familyConsult: true }, {});
  ok(!b.added, "二重に足した");
  const c = ensureFamilyConsultSupport("はい😊！！", { familyConsult: false }, {});
  ok(!c.added, "家族の番でないのに足した");
  const d = ensureFamilyConsultSupport("はい😊！！", { familyConsult: true }, { FAMILY_CONSULT_SUPPORT: "off" });
  ok(!d.added, "off で足した");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
