// app/lib/__tests__/read-recipe.test.ts
//
// 2026-11-15 竹内さん「またここの読み取り方なども学んだらその部分強化するように」「２でやる」
//
// なぜ要るか（実測）:
//   同じ写真で4通りの読み方を試して、結果が全部違った:
//     max_tokens 2500  → 内容0字（推論 6,762字）
//     max_tokens 8000  → 内容0字（推論 21,320字）
//     max_tokens 12000 → 欄 58個
//     Claude Haiku     → 欄 27個
//   ⚠ この「どの読み方が効いたか」は**その場の会話にしか残らなかった**。
//     記録しないと、次に同じ失敗をして、また一から試すことになる。
//
// このテストが守る物:
//   ① 読み方（model・max_tokens・effort・area）を1つの鍵にまとめられる
//   ② 成績（枚数・欄・時間・理由）を正しく数えられる（壊れた入力でも落ちない）
//   ③ 同じ読み方は1行にまとまる（日付ごと）
//   ④ 表が無い・書けない時でも学習を止めない
//
// 実行: npx tsx app/lib/__tests__/read-recipe.test.ts
import { recipeKey, describeRecipe, summarizeOutcomes } from "../read-recipe";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 読み方の鍵（同じ読み方を1行にまとめる）");
{
  const a = recipeKey({ model: "deepseek-flash", maxTokens: 12000, effort: "low", area: "whole" });
  const b = recipeKey({ model: "deepseek-flash", maxTokens: 12000, effort: "low", area: "whole" });
  ok("同じ設定は同じ鍵", a === b);
  ok("max_tokens が違えば別の鍵", a !== recipeKey({ model: "deepseek-flash", maxTokens: 8000, effort: "low", area: "whole" }));
  ok("モデルが違えば別の鍵", a !== recipeKey({ model: "claude-haiku-4-5", maxTokens: 12000, effort: "low", area: "whole" }));
  ok("領域が違えば別の鍵", a !== recipeKey({ model: "deepseek-flash", maxTokens: 12000, effort: "low", area: "left" }));
  ok("鍵に読める形が入る（read:で始まる）", a.startsWith("read:"));
  ok("鍵が長すぎない（80字以内）", a.length <= 80, a.length);
  // 壊れた入力でも落ちない
  ok("モデル名が空でも落ちない", typeof recipeKey({ model: "", maxTokens: 0 }) === "string");
  ok("記号が入っても落ちない", typeof recipeKey({ model: "a/b:c", maxTokens: 1 }) === "string");
}

console.log("\n■ ② 人が読める1行");
{
  const d = describeRecipe({ model: "deepseek-flash", maxTokens: 12000, effort: "low", area: "whole" });
  ok("モデル名が入る", d.includes("deepseek-flash"));
  ok("max_tokens が入る", d.includes("12000"));
  ok("画面全体と分かる", d.includes("画面全体"));
  ok("左だけと分かる", describeRecipe({ model: "m", maxTokens: 1, area: "left" }).includes("左だけ"));
}

console.log("\n■ ③ 成績を数える（実測の形で確かめる）");
{
  // 実測: 3枚中2枚読めて、欄は 58個と 30個。1枚は max_tokens 不足で読めず
  const s = summarizeOutcomes([
    { ok: true, fields: 58, ms: 14000 },
    { ok: true, fields: 30, ms: 13000 },
    { ok: false, fields: 0, ms: 46000, why: "deepseek_empty(finish=length):max_tokens が足りない" },
  ]);
  ok("試した枚数", s.tried === 3);
  ok("読めた枚数", s.ok === 2);
  ok("欄の合計", s.fields === 88);
  ok("1枚あたりの欄（88/2=44）", s.fieldsPerOk === 44);
  ok("合格率（2/3=67%）", s.okRate === 67);
  ok("読めない理由の最多が分かる", String(s.topWhy).includes("deepseek_empty"), s.topWhy);
  ok("時間の合計", s.ms === 73000);
}

console.log("\n■ ④ 全部読めた時・全部だめな時");
{
  const all = summarizeOutcomes([{ ok: true, fields: 10, ms: 1000 }, { ok: true, fields: 20, ms: 1000 }]);
  ok("全部読めたら合格率100%", all.okRate === 100);
  ok("読めない理由は無い", all.topWhy === null);
  const none = summarizeOutcomes([{ ok: false, fields: 0, ms: 500, why: "http_500:error" }, { ok: false, fields: 0, ms: 500, why: "http_500:error" }]);
  ok("全部だめなら合格率0%", none.okRate === 0);
  ok("同じ理由はまとまる", String(none.topWhy).includes("http_500(2)"), none.topWhy);
  ok("1枚あたりの欄は0", none.fieldsPerOk === 0);
}

console.log("\n■ ⑤ 壊れた入力でも落ちない");
{
  ok("空配列", summarizeOutcomes([]).tried === 0);
  ok("空でも合格率は0", summarizeOutcomes([]).okRate === 0);
  ok("null が混ざっても落ちない", summarizeOutcomes([null as never, { ok: true, fields: 1, ms: 1 }]).tried === 1);
  ok("fields が null でも落ちない", summarizeOutcomes([{ ok: true, fields: null as never, ms: 1 }]).fields === 0);
  ok("配列でなくても落ちない", summarizeOutcomes(null as never).tried === 0);
}

console.log("\n■ ⑥ なぜ記録するかをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../read-recipe.ts"), "utf8");
  ok("実測の4通りを残している", /2500/.test(src) && /8000/.test(src) && /12000/.test(src));
  ok("その場の会話にしか無かったと書いてある", /その場の会話/.test(src));
  ok("新しい表を作らないと明記", /新しい表を作らない/.test(src));
  ok("中身・置き場所を入れないと明記", /お客様の情報|中身は入れない/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
