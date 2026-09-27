// 2026-09-27 竹内「申込以降のステータス審査中は審査中としておく」: 資料の「現況/入居時期」の3つ目（審査中・商談中）を資料の文字のまま読む
//   資料の文字は property_pickups の実物（#679 Rainbow Court 立売堀 307・#668・#608・#712・YUMA の手元の回）。
// 実行: npx tsx app/lib/__tests__/listing-deal-status.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { listingDealStatus, pickupDealStatus, buildScreeningRoomsBrainText } from "../listing-deal-status";
import { buildPickupCardView } from "../pickup-card-view";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }

console.log("listingDealStatus（資料の文字のまま）");
it("#679「空室/相談/審査中/内装中」→ 審査中", () => eq(listingDealStatus({ evidenceMoveIn: "空室/相談/審査中/内装中" }), "審査中"));
it("#668「空室/2026年9月30日/審査中」→ 審査中", () => eq(listingDealStatus({ evidenceMoveIn: "空室/2026年9月30日/審査中" }), "審査中"));
it("#608「空室/即入/商談中」→ 商談中", () => eq(listingDealStatus({ evidenceMoveIn: "空室/即入/商談中" }), "商談中"));
it("審査中・商談中の無い欄は null（「空室/相談」「居住中/2026年11月上旬」）", () => {
  eq(listingDealStatus({ evidenceMoveIn: "空室/相談" }), null);
  eq(listingDealStatus({ evidenceMoveIn: "居住中/2026年11月上旬" }), null);
});
it("根拠の欄が無い古い行は PDF の文字の「現況/入居時期」の行から読む・本文の別の所の「審査中」は拾わない", () => {
  eq(listingDealStatus({ pdfText: "賃料 62,000円\n現況/入居時期 空室 / 相談 / 審査中 / 内装中\n築年 2004年02月" }), "審査中");
  eq(listingDealStatus({ pdfText: "賃料 62,000円\n現況/入居時期 空室 / 相談\n\n備考 保証会社審査中は入居不可" }), null);
});
it("pickupDealStatus は terms.evidence.moveIn を先に読む", () => {
  eq(pickupDealStatus({ terms: { evidence: { moveIn: "退去予定/相談/審査中" } }, pdf_text: null }), "審査中");
});

console.log("buildScreeningRoomsBrainText（ブレインへ）");
it("審査中の送ったお部屋だけ・資料の名前と号室のまま・同じお部屋は1回", () => {
  const t = buildScreeningRoomsBrainText([
    { property_name: "Rainbow　Court立売堀(レインボーコート立売堀)", room_no: "307", terms: { evidence: { moveIn: "空室/相談/審査中/内装中" } } },
    { property_name: "Rainbow　Court立売堀(レインボーコート立売堀)", room_no: "307", terms: { evidence: { moveIn: "空室/相談/審査中/内装中" } } },
    { property_name: "エステムコート難波WEST-SIDE IV ザ・フォース", room_no: null, terms: { evidence: { moveIn: "空室/相談/商談中" } } },
    { property_name: "プレサンス難波WEST", room_no: "0205", terms: { evidence: { moveIn: "空室/相談" } } },
  ]);
  eq(t.includes("- Rainbow　Court立売堀(レインボーコート立売堀) 307号室"), true);
  eq((t.match(/307号室/g) ?? []).length, 1);
  eq(t.includes("ザ・フォース"), false); // 商談中はブレインへ渡さない（竹内さんに確認中）
  eq(t.includes("0205"), false);
});
it("該当が無ければ空文字（ブレインの材料は増えない）", () => eq(buildScreeningRoomsBrainText([{ property_name: "A", room_no: "101", terms: { evidence: { moveIn: "空室/即入" } } }]), ""));

console.log("カード（売上サポ）");
const base = { rank: 1, property_name: "Rainbow　Court立売堀(レインボーコート立売堀)", room_no: "307", summary_text: null, verdict: "pass", score: 75, ad_yen: null, reason_codes: [], reasons_ja: [] };
it("#679 状態は「空室・審査中」・畳んだ時の1行は審査中", () => {
  const v = buildPickupCardView({ ...base, terms: { moveIn: { kind: "consult", current: "vacant", availableFrom: null } as never, evidence: { moveIn: "空室/相談/審査中/内装中" } } });
  eq(v.cells.find((c) => c.key === "state")?.value, "空室・審査中");
  eq(v.headline?.text, "資料の現況: 審査中（他のお客様の申込が審査中・申込は番手になる）");
});
it("保留（hold）の行は保留の理由のまま・状態には資料の文字（#712 商談中）", () => {
  const v = buildPickupCardView({ ...base, verdict: "hold", terms: { moveIn: { kind: "consult", current: "vacant", availableFrom: null } as never, evidence: { moveIn: "空室/相談/商談中" } } });
  eq(v.cells.find((c) => c.key === "state")?.value, "空室・商談中");
  eq((v.headline?.text ?? "").startsWith("資料の現況"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
