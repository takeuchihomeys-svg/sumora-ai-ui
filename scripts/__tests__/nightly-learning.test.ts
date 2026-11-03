// scripts/__tests__/nightly-learning.test.ts — 竹内さんに聞く事の足し方（同じ問いは足さない）
//   実行: npx tsx scripts/__tests__/nightly-learning.test.ts
import { mergeQuestions } from "../lib/nightly-learning-core";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const a = mergeQuestions("", "2026-11-02", [{ q: "内覧の前日に確認の連絡は要るか", scene: "内覧" }]);
t("空から見出し付きで足す", a.added === 1 && a.md.startsWith("# 竹内さんに聞く事") && a.md.includes("## 2026-11-02") && a.md.includes("- [未] 内覧の前日に確認の連絡は要るか（場面: 内覧）"));
const b = mergeQuestions(a.md, "2026-11-03", [{ q: "内覧の前日に 確認の連絡は要るか", scene: "内覧" }, { q: "新しい問い", scene: "-" }, { q: "新しい問い", scene: "-" }]);
t("同じ問い（空白違い）と同じ回の重なりは足さない", b.added === 1 && b.md.includes("## 2026-11-03\n- [未] 新しい問い"));
t("足す物が無ければそのまま", mergeQuestions(b.md, "2026-11-04", [{ q: "新しい問い", scene: "x" }]).added === 0);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
