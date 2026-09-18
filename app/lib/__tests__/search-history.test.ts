// app/lib/__tests__/search-history.test.ts
// Chrome 拡張の検索日の記録（chrome-extension/search-history.js）の回帰テスト。
// 拡張にテストの置き場が無いので、既存のハーネス（全 lib テスト）に乗せて一緒に回す。
// 実行: npx tsx app/lib/__tests__/search-history.test.ts
//
// 2026-09-18 竹内「物件検索と一括検索を条件広げて検索でもできるようにする。
//   また一括検索したお客さんも項目のところに日付と一括検索した日にちをいれるようにする」
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const H = require_("../../../chrome-extension/search-history.js") as {
  siteKey(site: string): string | null;
  modeKey(isWide: boolean): string;
  historyKey(site: string, isWide: boolean): string | null;
  lastSearchField(isWide: boolean): string;
  withSearch(history: Record<string, string> | null, site: string, isWide: boolean, nowIso?: string): Record<string, string> | null;
};

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

console.log("── サイト名のゆれを1つのキーに揃える");
{
  t("realnetpro も realpro も リアプロ も realpro", H.siteKey("realnetpro") === "realpro" && H.siteKey("realpro") === "realpro" && H.siteKey("リアプロ") === "realpro");
  t("itandi", H.siteKey("itandi") === "itandi");
  t("reins も レインズ も reins", H.siteKey("reins") === "reins" && H.siteKey("レインズ") === "reins");
  t("知らないサイトは null", H.siteKey("suumo") === null && H.siteKey("") === null);
}

console.log("── モードとキー（顧客リストの RP/IT/RE グリッドが読む形）");
{
  t("ピンポイントは p・広げては w", H.modeKey(false) === "p" && H.modeKey(true) === "w");
  t("realpro × 広げて → realpro_w", H.historyKey("realnetpro", true) === "realpro_w");
  t("itandi × ピンポイント → itandi_p", H.historyKey("itandi", false) === "itandi_p");
  t("reins × 広げて → reins_w", H.historyKey("レインズ", true) === "reins_w");
  t("知らないサイトは null", H.historyKey("suumo", false) === null);
  t("モード別の列名", H.lastSearchField(true) === "last_wide_search_at" && H.lastSearchField(false) === "last_pinpoint_search_at");
}

console.log("── 既存の記録を壊さずに足す");
{
  const before = { realpro_p: "2026-09-01T00:00:00.000Z", itandi_w: "2026-09-02T00:00:00.000Z" };
  const after = H.withSearch(before, "realnetpro", true, "2026-09-18T06:00:00.000Z");
  t("今回の分が足される", after?.realpro_w === "2026-09-18T06:00:00.000Z", JSON.stringify(after));
  t("他のサイト・モードは残る", after?.realpro_p === before.realpro_p && after?.itandi_w === before.itandi_w, JSON.stringify(after));
  t("元のオブジェクトを書き換えない", (before as Record<string, string>).realpro_w === undefined);

  const fromEmpty = H.withSearch(null, "itandi", false, "2026-09-18T06:00:00.000Z");
  t("記録が無い顧客でも作れる", fromEmpty?.itandi_p === "2026-09-18T06:00:00.000Z", JSON.stringify(fromEmpty));

  t("知らないサイトは null（保存しない）", H.withSearch(before, "suumo", false) === null);

  // 同じサイト・同じモードを2回 → 新しい方で上書き（最後に検索した日が出る）
  const twice = H.withSearch(H.withSearch(before, "itandi", false, "2026-09-10T00:00:00.000Z"), "itandi", false, "2026-09-18T00:00:00.000Z");
  t("同じ枠は最後の検索日で上書き", twice?.itandi_p === "2026-09-18T00:00:00.000Z", JSON.stringify(twice));
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
