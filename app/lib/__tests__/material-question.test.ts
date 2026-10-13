// 物件資料に書いてある事の質問の網と材料の文（app/lib/material-question.ts）・中国の字形の直し（app/lib/japanese-glyph.ts）のテスト
// 実行: npx tsx app/lib/__tests__/material-question.test.ts
import { detectMaterialQuestion, parseMaterialPlanRead, planReadLines, buildMaterialAnswerNote } from "../material-question";
import { fixChineseGlyphs, hasChineseGlyph } from "../japanese-glyph";
import { isEvaluativePrinciple } from "../principle-eval";
import { applySurfaceFixes } from "../validate-reply";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m} ${x} !== ${y}`); }

console.log("網");
it("055d4212 洗面台とトイレ一緒な感じですか → 水回りの配置", () => {
  eq(detectMaterialQuestion("ここって洗面台とトイレ一緒な感じですか？")?.topics, ["water_layout"]);
});
it("広さ・階・向き・収納", () => {
  eq(detectMaterialQuestion("リビングは何帖ありますか？")?.topics.includes("size"), true);
  eq(detectMaterialQuestion("こちらは何階のお部屋ですか？")?.topics, ["floor"]);
  eq(detectMaterialQuestion("日当たりはどうですか？")?.topics, ["direction"]);
  eq(detectMaterialQuestion("収納はありますか？")?.topics, ["storage"]);
});
it("探す条件・希望・質問でない文は拾わない", () => {
  eq(detectMaterialQuestion("バストイレ別のお部屋ありますか？"), null);
  eq(detectMaterialQuestion("南向きがいいです"), null);
  eq(detectMaterialQuestion("収納が多いと嬉しいです"), null);
  eq(detectMaterialQuestion("【ご希望の間取り】1LDK"), null);
});

console.log("図の読み");
it("JSON を読む・不明は書かない・階は図から使わない・中国の字形を直す", () => {
  const r = parseMaterialPlanRead('{"bath_toilet":"別","washbasin":"トイレと同じ空間","laundry":"室内","madori":"1K","rooms":[{"name":"洋室","jo":6}],"kitchen":"壁付け","storage":"","balcony":"不明","floor":13,"direction":"南西","note":"洗面台和トイレ同じ空间"}', (s) => fixChineseGlyphs(s).text);
  if (!r) throw new Error("null");
  const L = planReadLines(r);
  eq(L[0], "水回り: 浴室とトイレは別・洗面台はトイレと同じ空間（アメリカンセパレート）・洗濯機置場は室内");
  eq(L.some((l) => /13階/.test(l)), false);
  eq(L.some((l) => /空间/.test(l)), false, L.join("|"));
});
it("何も読めなければ null", () => {
  eq(parseMaterialPlanRead('{"bath_toilet":"不明","washbasin":"不明","laundry":"不明","madori":"","rooms":[],"kitchen":"不明"}'), null);
  eq(parseMaterialPlanRead("読めません"), null);
});
it("材料の文に物件と決まり", () => {
  const n = buildMaterialAnswerNote({ topics: ["water_layout"], sentences: [] }, [{ name: "エステムコート難波IVアトリ", roomNo: null, by: "直前に送った物件", textLines: ["所在階: 5階"], planLines: ["水回り: 浴室とトイレは別"], sources: [] }]);
  eq(/エステムコート難波IVアトリ/.test(n) && /確認の約束にせず返信の本文で/.test(n) && /所在階: 5階/.test(n), true);
  eq(buildMaterialAnswerNote({ topics: ["size"], sentences: [] }, []), "");
});

console.log("中国の字形");
it("a2d4befd の型（お世话・费用・额・设・顶）を直す", () => {
  const r = fixChineseGlyphs("YUMAさん\nお世话になっております！！初期费用の金额と设备をお送りさせて顶きます！！");
  eq(r.text, "YUMAさん\nお世話になっております！！初期費用の金額と設備をお送りさせて頂きます！！");
  eq(r.fixed.length, 6);   // 设备の备も
});
it("日本語にもある字（机・叶・会・区・号・体）・名前の旧字（澤・櫻・邊）は直さない", () => {
  const s = "机の上・夢が叶う・会社・中央区・号室・体験・澤田さん・櫻井様・渡邊さん";
  eq(fixChineseGlyphs(s).text, s);
  eq(hasChineseGlyph(s), false);
});
it("呼びかけの直前・守る名前の中は直さない／止めれば直さない", () => {
  eq(fixChineseGlyphs("圖書さん、地圖です", { protect: [] }).text, "圖書さん、地図です");
  eq(fixChineseGlyphs("ザ・东京タワー", { protect: ["ザ・东京タワー"] }).text, "ザ・东京タワー");
  eq(fixChineseGlyphs("费用", { env: { JAPANESE_GLYPH_FIX: "off" } }).text, "费用");
});

console.log("入口 #9・#14");
it("学習 cron の評価文（原則：…・〜している）を見分ける・決まりの形は残す", () => {
  eq(isEvaluativePrinciple({ title: "原則：物件への反応", content: "お客様の不安に寄り添っている" }), true);
  eq(isEvaluativePrinciple({ title: "", content: "条件を復唱し安心感を与えている。" }), true);
  eq(isEvaluativePrinciple({ title: "見積の決まり", content: "見積書の金額は本文に書かない" }), false);
});
it("生成の出口で中国の字形を直す（お客様の名前は触らない）", () => {
  const r = applySurfaceFixes("澤田さん\nお世话になっております！！", { customerName: "澤田" });
  eq(r.text, "澤田さん\nお世話になっております！！");
  eq(r.applied.some((a) => /JAPANESE_GLYPH/.test(a)), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
