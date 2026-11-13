// 統括の③深さ（2026-10-29・記録だけの第1段）
// 実行: npx tsx app/lib/__tests__/brain-depth.test.ts
import { decideBrainDepth, deepRecheckOn, deepRecheckFor, deepRecheckDigest, depthGateRecord, depthCostRecord, brainDepthV2On } from "../brain-depth";
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
it("v2（BRAIN_DEPTH_V2=on・既定 off）: 疑い・指す物が複数・72時間ぶり・持ち込み・40字までのお礼", () => {
  const on = { BRAIN_DEPTH_V2: "on" };
  // 11865「おとり物件てことですか」: 既定は一般・v2 は疑いで深く
  eq(decideBrainDepth({ ...base, turnText: "おとり物件てことですか🙇‍♀️ 調べてくださりありがとうございます！" }, {}).depth, "normal");
  eq(decideBrainDepth({ ...base, turnText: "おとり物件てことですか🙇‍♀️ 調べてくださりありがとうございます！" }, on), { depth: "deep", reason: "疑い" });
  // 12592「こちらこそありがとうございました！分かりました！」: 既定は一般（20字超え）・v2 は浅い
  eq(decideBrainDepth({ ...base, ackOnly: true, turnText: "こちらこそありがとうございました！分かりました！" }, {}).depth, "normal");
  eq(decideBrainDepth({ ...base, ackOnly: true, turnText: "こちらこそありがとうございました！分かりました！" }, on).depth, "light");
  eq(decideBrainDepth({ ...base, turnText: "べニール南堀江とアーベル更紗北堀江どちらがいいですかね", refCount: 2 }, on), { depth: "deep", reason: "指す物が複数" });
  eq(decideBrainDepth({ ...base, gapHours: 80, turnText: "お久しぶりです" }, on), { depth: "deep", reason: "数日ぶりの再開" });
  eq(decideBrainDepth({ ...base, brought: true, turnText: "https://suumo.jp/chintai/x" }, on), { depth: "normal", reason: "持ち込み" });
  // 13898「もぉ少し初期費用安く」: 既定も v2 も費用の不満で深い
  eq(decideBrainDepth({ ...base, turnText: "もぉ少し初期費用安くできたりしませんか？" }, on).reason, "費用の不満");
  eq(decideBrainDepth({ ...base, turnText: "ちょっと不安で…" }, on).reason, "疑い");
  // 問いのあるお礼は40字でも浅くしない
  eq(decideBrainDepth({ ...base, ackOnly: true, turnText: "ありがとうございます！駐車場ありますか？" }, on).depth === "light", false);
  // 7日以上は v2 でも「久しぶりの連絡」のまま（数日ぶりは 72時間〜7日）
  eq(decideBrainDepth({ ...base, gapHours: 24 * 10, turnText: "こんにちは" }, on).reason, "久しぶりの連絡");
  eq(decideBrainDepth({ ...base, gapHours: 50, turnText: "こんにちは" }, on).reason, "一般");
  // 名指す物が1つは深くしない
  eq(decideBrainDepth({ ...base, turnText: "べニール南堀江はまだ空いてますか", refCount: 1 }, on).reason, "一般");
});
it("v2 の記録: 深い時だけ動かす物（run/skip）と浅い番の字数の前後", () => {
  const running = { material_fetch: true, reading_candidates: false, deep_check: true };
  eq(depthGateRecord("deep", running), { run: ["material_fetch", "deep_check"], skip: [] });
  eq(depthGateRecord("normal", running), { run: [], skip: ["material_fetch", "deep_check"] });
  eq(depthGateRecord("light", {}), { run: [], skip: [] });
  eq(depthCostRecord("light", { sysChars: 30000, convChars: 8000, turnChars: 1200 }), { before: 39200, after: 1200, saved: 38000 });
  eq(depthCostRecord("normal", { sysChars: 1, convChars: 1, turnChars: 1 }), null);
  eq(depthCostRecord("light", { sysChars: NaN, convChars: -5, turnChars: 10 }), { before: 10, after: 10, saved: 0 });
  eq(brainDepthV2On({}), false); eq(brainDepthV2On({ BRAIN_DEPTH_V2: " ON " }), true);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
