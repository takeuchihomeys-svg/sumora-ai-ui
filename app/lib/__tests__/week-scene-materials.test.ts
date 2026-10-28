// 今週の指摘の場面の材料（#33 じゅな・#3 #7 KID・#37 れい）。実物の言い方（名前は伏せた）
// 実行: npx tsx app/lib/__tests__/week-scene-materials.test.ts
import { vacateViewingHoldFirstLine, vacateHoldCancelLine, positiveNoNegativeLine, daysUntilMD, vacatingNameIn, vacateViewingHoldFirstEnabled, vacateHoldCancelCheckEnabled, positiveNoNegativeEnabled } from "../week-scene-materials";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
const NOW = Date.parse("2026-10-27T07:12:00Z"); // JST 16:12
const PROPS = [{ name: "ロンド・エーデルワイス 105号室", vacating: true }, { name: "コスモトム日本橋Ⅱ 5B号室", vacating: false }];

it("切替は既定 off", () => { eq(vacateViewingHoldFirstEnabled({}), false); eq(vacateHoldCancelCheckEnabled({}), false); eq(positiveNoNegativeEnabled({}), false); eq(vacateViewingHoldFirstEnabled({ VACATE_VIEWING_HOLD_FIRST: "on" }), true); });
it("日数: 10/27 から 11/1 は 5日", () => eq(daysUntilMD("11/1", NOW), 5));
it("#33 じゅな: 退去予定の部屋・内覧 11/1（5日後）→ 先に申込で抑える番", () => {
  const t = vacateViewingHoldFirstLine({ appointment: { dateMD: "11/1", place: "ロンド・エーデルワイス 現地エントランス" }, props: PROPS, nowMs: NOW });
  ok(/あと5日/.test(t) && /先にお申込でお部屋を抑えてから内覧/.test(t) && /管理会社に確認しましたところ」は入れない/.test(t), t);
});
it("#33: 8日より先・退去予定でない部屋は出さない", () => {
  eq(vacateViewingHoldFirstLine({ appointment: { dateMD: "11/8", place: "ロンド・エーデルワイス" }, props: PROPS, nowMs: NOW }), "");
  eq(vacateViewingHoldFirstLine({ appointment: { dateMD: "11/1", place: "コスモトム日本橋Ⅱ 現地" }, props: PROPS, nowMs: NOW }), "");
});
it("#3 KID: 「申し込みしてから内覧して気に入らなければキャンセルって可能ですか」→ 管理会社に確認（お部屋止めについて）", () => {
  const t = vacateHoldCancelLine({ customerText: "初期費用安くてかなり気になるんですが、申し込みしてから内覧して気に入らなければキャンセルって可能ですか？", props: [{ name: "アーバネックス難波WEST 903号室", vacating: true }] });
  ok(/お部屋止めについて/.test(t) && /言い切らず/.test(t), t);
  eq(vacateHoldCancelLine({ customerText: "内覧はいつできますか？", props: [{ name: "アーバネックス難波WEST 903号室", vacating: true }] }), "");
});
it("#37 れい: 洗濯機置き場があって気になる → 否定は返信で書かない", () => {
  const t = positiveNoNegativeLine("おおきにずーと狙ってて部屋によって洗濯機置き場がないところが多いのに洗濯機置き場あるみたいで気になります！");
  ok(/洗濯機置/.test(t) && /返信で書かない/.test(t), t);
  eq(positiveNoNegativeLine("洗濯機置き場はありますか？"), "", "質問は別");
});
it("名前の照合: 号室を外した建物名", () => eq(vacatingNameIn("ロンド・エーデルワイス 現地エントランスお待ち合わせ", PROPS), "ロンド・エーデルワイス 105号室"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
