// 実行: npx tsx app/lib/__tests__/learn-keep-fields.test.ts
// 2026-11-18 竹内さん「40欄の切り捨てを広げる（入れる）」:
//   束に載せる写真の欄は、旧「画面ごと上位40」で切られ、区・駅・×とじるなどが落ちていた。
//   → 上位40は残し、その外でも3回以上見た欄を足す（上限300・1回だけの欄は捨てる）。
import { keepLearnedFields, LEARNED_KEEP_TOP, LEARNED_KEEP_MAX } from "../shot-learn";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

// 上位40（回数が多い）＋ 41〜60位は回数 5、61〜80位は回数 2、81〜100位は回数 1 の欄を作る
const fields: Array<{ name: string; n: number }> = [];
for (let i = 0; i < 40; i++) fields.push({ name: "上位" + i, n: 100 - i });
for (let i = 0; i < 20; i++) fields.push({ name: "中" + i, n: 5 });
for (let i = 0; i < 20; i++) fields.push({ name: "薄" + i, n: 2 });
for (let i = 0; i < 20; i++) fields.push({ name: "一回" + i, n: 1 });

console.log("■ 欄の切り捨て（keepLearnedFields）");
{
  const kept = keepLearnedFields(fields);
  const names = new Set(kept.map((f) => f.name));
  t("上位40は必ず残す", LEARNED_KEEP_TOP === 40 && [...Array(40).keys()].every((i) => names.has("上位" + i)));
  t("上位の外でも3回以上の欄（中）は残す", [...Array(20).keys()].every((i) => names.has("中" + i)));
  t("2回の欄（薄）は捨てる（3回未満）", [...Array(20).keys()].every((i) => !names.has("薄" + i)));
  t("1回の欄（誤読の疑い）は捨てる", [...Array(20).keys()].every((i) => !names.has("一回" + i)));
  t("上限を超えない", kept.length === 40 + 20 && kept.length <= LEARNED_KEEP_MAX);
  t("回数の多い順に並ぶ", kept.every((f, i) => i === 0 || (kept[i - 1].n ?? 0) >= (f.n ?? 0)));
}

console.log("\n■ 上限（300）");
{
  const many: Array<{ name: string; n: number }> = [];
  for (let i = 0; i < 500; i++) many.push({ name: "多" + i, n: 10 });
  const kept = keepLearnedFields(many);
  t("3回以上が500あっても上限300", kept.length === LEARNED_KEEP_MAX, kept.length);
}

console.log("\n■ 壊れた入力で落ちない");
{
  t("空", keepLearnedFields([]).length === 0);
  t("n が無い欄でも落ちない（上位40の中なので残る＝旧と同じ）", keepLearnedFields([{ name: "x" }] as never).length === 1);
  t("null 混じりでも落ちない", keepLearnedFields(null as never).length === 0);
}

console.log(`\n結果: ${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
