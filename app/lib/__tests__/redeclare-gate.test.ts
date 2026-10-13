// 出口の再宣言ゲートをブレイン基準に（app/lib/redeclare-gate.ts・validate-reply enforceAixGates）のテスト
// 文は実送信（スタッフの手打ち・scripts/audit-redeclare-gates.ts で旧のゲートが消した文）の形
// 実行: npx tsx app/lib/__tests__/redeclare-gate.test.ts
import { estimateRedeclareArmed, vacancyRedeclareArmed, brainKeepsRedeclare, logMatchesCurrent, sentenceNamesOtherProperty } from "../redeclare-gate";
import { enforceAixGates, applySurfaceFixes } from "../validate-reply";
import { issueContradictsContract, type TurnContract } from "../turn-contract";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m} ${x} !== ${y}`); }
const now = Date.parse("2026-10-14T10:00:00+09:00");
const ago = (h: number) => new Date(now - h * 3600e3).toISOString();
const gateRules = (r: { edits: { rule: string }[] }) => r.edits.map((e) => e.rule).filter((x) => x === "見積作成宣言の繰り返し" || x === "空室確認の再宣言");

console.log("旗");
it("見積: 同じ物件に7日以内に送った → 立つ", () => {
  eq(estimateRedeclareArmed({ legacy: true, logs: [{ aix_type: "estimate_sheet", created_at: ago(5), property_names: ["レオングラン本町橋 502号室"] }], now, currentProperties: ["レオングラン本町橋502"], costAsk: false, staffPromisedEstimate: false }).reason, "sent_same_property");
});
it("見積: 別の物件・8日前・費用の質問 → 立たない", () => {
  eq(estimateRedeclareArmed({ legacy: true, logs: [{ aix_type: "estimate_sheet", created_at: ago(5), property_names: ["アーバネックス難波WEST 903号室"] }], now, currentProperties: ["プレミアス鳳Ⅱ 102号室"], costAsk: false, staffPromisedEstimate: false }).armed, false);
  eq(estimateRedeclareArmed({ legacy: true, logs: [{ aix_type: "estimate_sheet", created_at: ago(24 * 8), property_names: null }], now, currentProperties: [], costAsk: false, staffPromisedEstimate: false }).armed, false);
  eq(estimateRedeclareArmed({ legacy: true, logs: [{ aix_type: "estimate_sheet", created_at: ago(1), property_names: null }], now, currentProperties: [], costAsk: true, staffPromisedEstimate: true }).reason, "cost_ask");
});
it("見積: 直前の約束 → 立つ（二重の約束）・止めた時は旧のまま", () => {
  eq(estimateRedeclareArmed({ legacy: true, logs: [], now, currentProperties: [], costAsk: false, staffPromisedEstimate: true }).reason, "staff_promised");
  eq(estimateRedeclareArmed({ legacy: true, logs: [], now, currentProperties: [], costAsk: true, staffPromisedEstimate: false, env: { REDECLARE_GATE_BRAIN: "off" } }).armed, true);
});
it("空室: 同じ物件の確認だけ", () => {
  const logs = [{ aix_type: "property_check_result", created_at: ago(3), property_names: ["エスリード中之島クロスゲート"] }];
  eq(vacancyRedeclareArmed({ legacy: true, logs, now, currentProperties: ["エスリード中之島クロスゲート"] }).armed, true);
  eq(vacancyRedeclareArmed({ legacy: true, logs, now, currentProperties: ["TKハイツ"] }).armed, false);
  eq(vacancyRedeclareArmed({ legacy: false, logs, now, currentProperties: [] }).armed, false);
});
it("物件名が分からない時は同じと見る", () => {
  eq(logMatchesCurrent(null, ["A"]), true); eq(logMatchesCurrent(["A"], []), true);
});
it("文が送った物件と別の物件の見積", () => {
  eq(sentenceNamesOtherProperty("コーポ平野上町の初期費用確認でき次第お見積書お送りさせていただきます！！", ["メゾンドF02"]), true);
  eq(sentenceNamesOtherProperty("メゾンドF02の最大限割引させていただいたお見積書お送りさせていただきます！！", ["メゾンドF02"]), false);
  eq(sentenceNamesOtherProperty("御見積書作成しお送りさせて頂きます！！", ["メゾンドF02"]), false);
});
it("ブレインの免除: 本質の約束・AIX", () => {
  const c = { source: "brain", asks: [{ quote: "初期費用いくら", topic: "cost", kind: "question", route: "promise", answer: "見積書を作成して送る", basis: null, aixKey: null }], leadWith: 0, closeOnly: false, mustNot: [], proposals: [], alreadySaid: [], settled: [], feeling: { kind: null, acknowledge: false }, humanChecks: [] } as unknown as TurnContract;
  eq(brainKeepsRedeclare(c, null), { estimate: true, vacancy: false });
  eq(brainKeepsRedeclare(null, "property_check_result"), { estimate: false, vacancy: true });
  eq(brainKeepsRedeclare(c, "property_check_result", { REDECLARE_GATE_BRAIN: "off" }), { estimate: false, vacancy: false });
});

console.log("enforceAixGates");
it("旗が立たなければ見積の約束を消さない（旧は消した）", () => {
  const s = "最大限割引させて頂いた御見積書作成しお送りさせて頂きます😌！！";
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: false })), []);
  process.env.REDECLARE_GATE_BRAIN = "off";
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: false })), ["見積作成宣言の繰り返し"]);
  delete process.env.REDECLARE_GATE_BRAIN;
});
it("旗が立っていてもブレインが約束を決めた番は消さない・二重の約束は消す", () => {
  const s = "御見積書作成しお送りさせて頂きます！！";
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: true, brainKeepEstimate: true })), []);
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: true, brainKeepEstimate: true, estimateDoublePromise: true })), ["見積作成宣言の繰り返し"]);
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: true })), ["見積作成宣言の繰り返し"]);
});
it("送った後の結果の報告は残す・送っていないのに送った文は消す", () => {
  const s = "2部屋の最大限割引させていただいたお見積書お送りさせていただきました！！";
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: true, estimateSentSameProperty: true })), []);
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: true, estimateSentSameProperty: false })), ["見積作成宣言の繰り返し"]);
});
it("新しい相手への約束（他のお部屋・も一緒に）は消さない", () => {
  eq(gateRules(enforceAixGates("他お気に召されましたお部屋ございましたらお見積書もお送りさせていただきます！！", { estimatePromised: true, estimateRedeclareArmed: true })), []);
});
it("空室: 結果の報告・お客様が送る物件・管理会社だけの文は消さない", () => {
  const o = { aixVacancyDone: true, vacancyRedeclareArmed: true };
  eq(gateRules(enforceAixGates("エスリード中之島クロスゲート募集状況確認させて頂きましたところ、現在お部屋お申込が入っております！！", o)), []);
  eq(gateRules(enforceAixGates("気になるお部屋お送り頂けましたらお部屋の募集状況確認させていただきます😊！！", o)), []);
  eq(gateRules(enforceAixGates("畳を新品に交換出来るか管理会社に確認させて頂きます！！", o)), []);
  eq(gateRules(enforceAixGates("TKハイツ募集状況確認させていただきます！！", o)), ["空室確認の再宣言"]);
  eq(gateRules(enforceAixGates("TKハイツ募集状況確認させていただきます！！", { ...o, brainKeepVacancy: true })), []);
  eq(gateRules(enforceAixGates("TKハイツ募集状況確認させていただきます！！", { aixVacancyDone: true, vacancyRedeclareArmed: false })), []);
});
it("確かめる人: 二重の約束・空室の再宣言では「も一緒に」「お見積書も」だけで免除しない", () => {
  const s = "募集状況確認させて頂き、最大限割引のお見積書も一緒にお送りさせて頂きます！！";
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: true, estimateDoublePromise: true })), ["見積作成宣言の繰り返し"]);
  eq(gateRules(enforceAixGates(s, { estimatePromised: true, estimateRedeclareArmed: true })), []);
  eq(gateRules(enforceAixGates("他お気に召されましたお部屋ございましたらお見積書もお送りさせていただきます！！", { estimatePromised: true, estimateRedeclareArmed: true, estimateDoublePromise: true })), []);
  eq(gateRules(enforceAixGates("TKハイツの募集状況も一緒に確認させていただきます！！", { aixVacancyDone: true, vacancyRedeclareArmed: true })), ["空室確認の再宣言"]);
});

console.log("#8・#13");
it("閉じる番は EMPTY_CLOSER・SPLIT_ACK_REPLY・PROMISE_ECHO_MISSING を書き直しに渡さない", () => {
  const c = { source: "brain", asks: [], leadWith: null, closeOnly: true, mustNot: [], proposals: [], alreadySaid: [], settled: [], feeling: { kind: null, acknowledge: false }, humanChecks: [] } as unknown as TurnContract;
  for (const code of ["EMPTY_CLOSER", "SPLIT_ACK_REPLY", "PROMISE_ECHO_MISSING"]) eq(issueContradictsContract({ code }, c, {}), true, code);
});
it("ペットの言い回しだけでも本文へ戻す", () => {
  const r = applySurfaceFixes("こちらのお部屋ペット相談可となります！！", {});
  eq(r.text.includes("ペット飼育可能"), true, r.text);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
