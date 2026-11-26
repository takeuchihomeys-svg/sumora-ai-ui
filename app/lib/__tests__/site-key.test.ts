// 実行: npx tsx app/lib/__tests__/site-key.test.ts
// 2026-11-26: サイトの呼び名の唯一の正本（app/lib/site-key.ts）。以前の8か所のコピーと同じ答えを返すことを確かめる。
import { siteKeyOf, commandSiteKeyOf } from "../site-key";

let pass = 0, fail = 0;
function eq<T>(name: string, got: T, want: T) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + "  got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)); }
}

console.log("■ siteKeyOf（サイトの3つ）");
eq("realpro → realpro", siteKeyOf("realpro"), "realpro");
eq("realnetpro（拡張・コマンドの呼び名）→ realpro", siteKeyOf("realnetpro"), "realpro");
eq("リアプロ → realpro", siteKeyOf("リアプロ"), "realpro");
eq("itandi → itandi", siteKeyOf("itandi"), "itandi");
eq("reins → reins", siteKeyOf("reins"), "reins");
eq("レインズ → reins", siteKeyOf("レインズ"), "reins");
eq("大文字・前後の空白は無視（ITANDI → itandi）", siteKeyOf("  ITANDI "), "itandi");
eq("知らない値は null", siteKeyOf("suumo"), null);
eq("空・null・undefined は null", [siteKeyOf(""), siteKeyOf(null), siteKeyOf(undefined)], [null, null, null]);
eq("イタンジ（旧の表記）は今まで通り null（足さない）", siteKeyOf("イタンジ"), null);

console.log("■ commandSiteKeyOf（拡張・コマンドの呼び名）");
eq("realpro → realnetpro", commandSiteKeyOf("realpro"), "realnetpro");
eq("リアプロ → realnetpro", commandSiteKeyOf("リアプロ"), "realnetpro");
eq("realnetpro → realnetpro", commandSiteKeyOf("realnetpro"), "realnetpro");
eq("itandi → itandi", commandSiteKeyOf("itandi"), "itandi");
eq("reins → reins", commandSiteKeyOf("reins"), "reins");
eq("知らない値は null", commandSiteKeyOf("suumo"), null);

console.log("■ 既存の呼び出し口の結果が変わっていないこと");
import("../search-widen-chain").then((w) => {
  eq("commandSiteOf: realpro → realnetpro", w.commandSiteOf("realpro"), "realnetpro");
  eq("commandSiteOf: reins は広げない（null）", w.commandSiteOf("reins"), null);
  eq("pickupSiteOf: realnetpro → realpro", w.pickupSiteOf("realnetpro"), "realpro");
  eq("pickupSiteOf: レインズ → reins", w.pickupSiteOf("レインズ"), "reins");
  return import("../search-audit-check");
}).then((a) => {
  eq("normalizeSite: リアプロ → realpro", a.normalizeSite("リアプロ"), "realpro");
  eq("normalizeSite: 知らない値 → null", a.normalizeSite("suumo"), null);
  console.log("\n" + (fail === 0 ? "✅" : "❌") + " 合格 " + pass + "・不合格 " + fail);
  process.exit(fail === 0 ? 0 : 1);
});
