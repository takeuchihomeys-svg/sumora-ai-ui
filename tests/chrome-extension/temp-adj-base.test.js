// 実行: node tests/chrome-extension/temp-adj-base.test.js
// 一時調整の履歴は、保存した時の登録の条件と同じ時だけ戻す（chrome-extension/temp-adj-base.js・v2.5.36）。
// 2026-09-27 竹内（未桜さん: 登録の条件を大国町・1K に直したのに、前の一時調整〈九条・大正・8万〉で検索していた＝search_audits 35）
//   「このような場合は一時調整じゃなくて、そもそもの条件を修正する」
const fs = require("fs");
const path = require("path");
const T = require("../../chrome-extension/temp-adj-base.js");
let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }
const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8");

// 未桜さんの実物（登録の条件は 9/27 の言い直しの後）
const MISAKI_NOW = { id: "45e5a835", desired_area: "大国町", area_mode: "station", rent_min: 65000, rent_max: 90000, floor_area_min: 25, floor_area_max: null, floor_plan: "1K" };
const MISAKI_BEFORE = { ...MISAKI_NOW, desired_area: "九条・大正", floor_plan: "1K 1LDK" };
const ENTRY_BEFORE = { area: "", station: "九条・大正", rent_min: "65000", rent_max: "80000", area_min: "25", area_max: "", base: T.baseKey(MISAKI_BEFORE) };

console.log("\n■ 戻すか");
eq("登録の条件が同じ → 戻す", T.shouldRestore({ ...ENTRY_BEFORE, base: T.baseKey(MISAKI_NOW) }, MISAKI_NOW), true);
eq("未桜: 登録の条件が変わった（九条・大正→大国町）→ 戻さない", T.shouldRestore(ENTRY_BEFORE, MISAKI_NOW), false);
eq("家賃の上限だけ変わった（野口: 10万→12万）→ 戻さない", T.shouldRestore({ base: T.baseKey({ ...MISAKI_NOW, rent_max: 100000 }) }, { ...MISAKI_NOW, rent_max: 120000 }), false);
eq("古い履歴（base なし）→ 戻さない", T.shouldRestore({ station: "九条・大正", rent_max: "80000" }, MISAKI_NOW), false);
eq("空・null", [T.shouldRestore(null, MISAKI_NOW), T.shouldRestore(ENTRY_BEFORE, null)], [false, false]);
eq("数字と文字・空白・全角の違いは同じ扱い", T.baseKey({ ...MISAKI_NOW, rent_max: "90000", floor_plan: "１Ｋ " }) === T.baseKey(MISAKI_NOW), true);
eq("検索に効かない列（ai_summary 等）が変わっても同じ", T.baseKey({ ...MISAKI_NOW, ai_summary: "x", updated_at: "y" }) === T.baseKey(MISAKI_NOW), true);

console.log("\n■ 配線（popup）");
const popup = read("popup.js");
eq("保存に base を付ける", /base:\s*\(self\.AxlxTempAdjBase[^\n]*baseKey\(selectedCustomer\)/.test(popup), true);
eq("戻す前に shouldRestore を見る", /_TAB\.shouldRestore\(hist\[0\], c\)/.test(popup) && /if \(_canRestore && !_adjRestoreSuppressed\)/.test(popup), true);
eq("popup.html で popup.js より前に読む", (() => { const h = read("popup.html"); const a = h.indexOf("temp-adj-base.js"), b = h.indexOf('src="popup.js"'); return a > 0 && a < b; })(), true);
eq("manifest の web_accessible_resources に入っている", read("manifest.json").includes('"temp-adj-base.js"'), true);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
