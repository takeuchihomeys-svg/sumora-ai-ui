// 統括の③深さ（2026-10-29・記録だけの第1段）
// 実行: npx tsx app/lib/__tests__/brain-depth.test.ts
import { decideBrainDepth, deepRecheckOn, deepRecheckFor, deepRecheckDigest } from "../brain-depth";
import { toFreshDigest } from "../brain-layers";
import { recheckMaterialLine } from "../brain-recheck";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const base = { stampOnly: false, ackOnly: false, closedBefore: false, pickupReady: null, openPromises: 0, gapHours: 1 };

it("審査の相談・申込・複数の依頼は深く", () => {
  eq(decideBrainDepth({ ...base, turnText: "相談なのですが、審査通るように職場の案内してもらえますか" }).depth, "deep");
  eq(decideBrainDepth({ ...base, turnText: "これは最大の割引でしょうか？あと支払い時期はいつになりますか？" }).depth, "deep");
});
it("締めの後のスタンプ・短いお礼は軽い（送れる候補がある時・約束がある時は軽くしない）", () => {
  eq(decideBrainDepth({ ...base, turnText: "[スタンプ]", stampOnly: true, closedBefore: true }), { depth: "light", reason: "締めの後のスタンプ" });
  eq(decideBrainDepth({ ...base, turnText: "ありがとうございます！", ackOnly: true, closedBefore: true }).depth, "light");
  eq(decideBrainDepth({ ...base, turnText: "ありがとうございます！", ackOnly: true, closedBefore: true, pickupReady: true }).depth, "normal", "送れる候補がある時は軽くしない");
  eq(decideBrainDepth({ ...base, turnText: "[スタンプ]", stampOnly: true, closedBefore: true, openPromises: 1 }).depth, "normal", "約束がある時は軽くしない");
});
it("約束の結果待ちの番の新しい発言・久しぶりは深く", () => {
  eq(decideBrainDepth({ ...base, turnText: "まだですか", openPromises: 1 }).reason, "約束の結果待ちの番");
  eq(decideBrainDepth({ ...base, turnText: "お久しぶりです、まだ探してます", gapHours: 24 * 10 }).reason, "久しぶりの連絡");
});

// 2026-11-05 第2段: 複雑な番だけ深く読み直す（BRAIN_DEEP_RECHECK・既定 off・KB 077d6e18）
it("深く読み直すのは 複数の依頼・申込・審査 の番だけ（約束の結果待ち・久しぶり・普通・軽い番は null）", () => {
  eq(deepRecheckOn({}), false); eq(deepRecheckOn({ BRAIN_DEEP_RECHECK: "on" }), true); eq(deepRecheckOn({ BRAIN_DEEP_RECHECK: "shadow" }), false);
  const multi = decideBrainDepth({ ...base, turnText: "駐車場ありますか？ペットは大丈夫ですか？" });
  eq(multi.reason, "複数の依頼");
  const rc = deepRecheckFor(multi, "property_check_result");
  eq(rc?.from, "deep"); eq(rc?.kind, "reread"); eq(rc?.firstAix, "property_check_result");
  eq(deepRecheckFor(decideBrainDepth({ ...base, turnText: "申込したいです" }), "application_push")?.why, "複雑な番（申込）");
  // 最初が返信の番は読み直さない（deep-on1 の悪化 q217: 申込を見送る了承の番が返信→AIX に変わった）
  eq(deepRecheckFor(decideBrainDepth({ ...base, turnText: "焦って決めたくはないため申し込みはしなくても大丈夫です！" }), null), null);
  eq(deepRecheckFor(decideBrainDepth({ ...base, turnText: "お願いします", openPromises: 1 }), null), null);
  eq(deepRecheckFor(decideBrainDepth({ ...base, turnText: "こんにちは", gapHours: 24 * 30 }), null), null);
  eq(deepRecheckFor(decideBrainDepth({ ...base, turnText: "ありがとうございます", ackOnly: true }), null), null);
  eq(deepRecheckFor(null, null), null);
});
it("読み直しの材料の1行に深く読む理由と依頼の分け方が入る（配線: brain-recheck.recheckMaterialLine）", () => {
  const rc = deepRecheckFor({ depth: "deep", reason: "審査" }, "estimate_sheet")!;
  const line = recheckMaterialLine(rc);
  eq(line.includes("深く読む番と判断された") && line.includes("複雑な番（審査）") && line.includes("竹内さんの順番で決め直す") && line.includes("必要書類") && line.includes("新しいやる事を作らない"), true, line);
});
it("統括の重点（前半）を受け取る口: 重点がある時は材料の先頭に・無い時は今まで通り", () => {
  const dep = { depth: "deep" as const, reason: "複数の依頼" };
  const a = deepRecheckFor(dep, "x"), b = deepRecheckFor(dep, "x", null), c = deepRecheckFor(dep, "x", { focus: "約束を果たす", why: "見積書の約束が開いている" });
  eq(a?.material, b?.material);
  eq(c!.material.startsWith("統括の重点「約束を果たす」（見積書の約束が開いている）に沿って決め直す。"), true, c!.material);
  eq(c!.material.endsWith(a!.material), true);
  eq(deepRecheckFor(dep, "x", { focus: "  " })?.material, a?.material);
});
it("digest に dp（深さ）と dr（深く読み直した番）が残る（配線: brain-layers.toFreshDigest）", () => {
  const d = toFreshDigest({ brain_depth: { depth: "deep", reason: "複数の依頼" }, deep_recheck_digest: deepRecheckDigest("複数の依頼", "estimate_sheet", null) }, null) as Record<string, unknown>;
  eq(d.dp, "d:複数の依頼"); eq(d.dr, "複数の依頼:estimate_sheet→r");
  const e = toFreshDigest({}, null) as Record<string, unknown>; eq("dp" in e || "dr" in e, false);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
