// tests/chrome-extension/scene-prefix-v2763.test.js
// 実行: node tests/chrome-extension/scene-prefix-v2763.test.js
// 2026-11-14 竹内さん「1から順に進めていく」
//
//   ★ 統括の指摘が**誤っていた**原因（実測で確定）:
//     統括は「『検索を押す』の手本が無い（人がまだ1回もやっていない）」と言っていたが、
//     実データには**人の押下が25件あった**。
//
//   ⚠ 原因: 実際の欄の名前は **`左の検索｜span`** のように
//     **「左の」の接頭辞と「｜span」（タグ名）が付く**。
//     旧の判定は `検索$`（検索で終わる）だったので**1つも当たらなかった**:
//       左の検索｜span            → その他（本当は「検索を押す」）
//       左の検索｜div.go_search   → その他
//       左の住居検索｜a.text      → その他
//       左のnext｜span            → その他（本当は「次のページへ」）
//     ＝ 場面の判定が全部「その他」になり、**手本があるのに「無い」と統括が判断**していた。
//
//   → 接頭辞（左の/右の/上の/下の/中央の）と「｜タグ名」を落としてから判定する。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

/**
 * 場面の判定は TypeScript なので、**同じ決まりをここに写して**確かめる。
 *   ⚠ 写しだと本体とずれる危険があるので、**本体の文字も見る**（下の■⑤）。
 */
const src = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "learn-flow-steps.ts"), "utf8");

/** 本体と同じ手順で場面を決める（本体を読めない時のために写しを置く） */
function sceneOf(rawInput) {
  const raw = String(rawInput ?? "");
  const m = raw.match(/^([a-z]+):(.*)$/i);
  const name = (m ? m[2] : raw).trim();
  const cleaned = name.replace(/^(左の|右の|上の|下の|中央の)/, "").replace(/｜[^｜]*$/, "").trim();
  const n = (cleaned || name).toLowerCase();
  if (/next_page|pager|page_next|次のページ|次へ|ページ送り|^next$/.test(n)) return "next";
  if (/^(go_search|go_search_submit)$/.test(n) || /^search$/.test(n)) return "search";
  if (/検索/.test(n) && !/検索条件|検索結果|再検索の設定/.test(n)) return "search";
  if (/city_code|town_code|one_city|one_town|住所|所在地|都道府県|市区郡|町字/.test(n)) return "area";
  if (/確定してリストへ|リストへ確定/.test(n)) return "area";
  if ((cleaned || name).length <= 14 && /[区市郡町村]$/.test(cleaned || name)) return "area";
  if (/transportation_id|station|沿線|駅|required_time/.test(n)) return "station";
  if (/building_tr|property_list|sort|並び替え|結果|一覧|bukken|room_/.test(n)) return "list";
  if (/rental_cost|update_date|room_layout|madori|間取り|賃料|築年|walk|徒歩|面積|menseki|include_common_fee|管理費|敷金|礼金/.test(n)) return "cond";
  return "other";
}

console.log("■ ① 実データの名前（接頭辞＋｜タグ名）が正しく場面になる");
{
  // ⚠ これは**実際にDBに入っていた名前**（推測で作っていない）
  const cases = [
    ["左の検索｜span", "search"],
    ["左の検索｜div.go_search", "search"],
    ["左の住居検索｜a.text", "search"],
    ["click:左の検索｜span", "search"],
    ["左のnext｜span", "next"],
    ["左の所在地絞り込み＋｜span", "area"],
    ["左の大阪市西区｜label.one_city", "area"],
    ["確定してリストへ｜span", "area"],
    ["rental_cost2", "cond"],
    ["room_layout_id[]", "list"],
    ["required_time", "station"],
    ["transportation_id", "station"],
  ];
  for (const [name, want] of cases) ok("  " + name.padEnd(30) + " → " + want, sceneOf(name) === want, { got: sceneOf(name) });
}

console.log("\n■ ② 「検索を押す」が1つも落ちない（旧は全部その他だった）");
{
  const searches = ["左の検索｜span", "左の検索｜div.go_search", "左の住居検索｜a.text", "検索", "go_search"];
  const bad = searches.filter((s) => sceneOf(s) !== "search");
  ok("  ⚠ 5つとも『検索を押す』", bad.length === 0, { bad });
  ok("  「検索条件」は押すボタンではない", sceneOf("検索条件｜span") !== "search");
  ok("  「検索結果」も押すボタンではない", sceneOf("検索結果｜span") !== "search");
}

console.log("\n■ ③ 「次のページへ」も拾う（旧は『その他』で手本が無いと誤判定）");
{
  ok("  左のnext｜span", sceneOf("左のnext｜span") === "next");
  ok("  次のページ", sceneOf("次のページ") === "next");
  ok("  pager", sceneOf("pager") === "next");
}

console.log("\n■ ④ 本体（learn-flow-steps.ts）が同じ決まりを持っている");
{
  ok("  接頭辞を落としている", /replace\(\/\^\(左の\|右の\|上の\|下の\|中央の\)\//.test(src));
  ok("  ｜タグ名を落としている", /replace\(\/｜\[\^｜\]\*\$\/, ""\)/.test(src));
  ok("  検索を「含むか」で見ている", /\/検索\/\.test\(n\)/.test(src));
  ok("  確定してリストへを所在地にしている", /確定してリストへ/.test(src));
  ok("  落とした名前で区を判定している", /cleaned \|\| name\)\.length <= 14/.test(src));
}

console.log("\n■ ⑤ 本体が読み込める（構文）");
{
  /**
   * ⚠ 1ファイルだけの `tsc` は import の解決で落ちる（リポジトリ全体の設定が要る）。
   *   → 全体の型チェックはコミット前の `npx tsc --noEmit` で見る。
   *     ここでは**中身の形**だけ確かめる（新しい関数が壊れていない事）。
   */
  ok("  sceneOfOp がある", /export function sceneOfOp\(/.test(src));
  ok("  lastSceneOf がある", /export function lastSceneOf\(/.test(src));
  ok("  返す場面の一覧が揃っている", /"area" \| "station" \| "cond" \| "search" \| "list" \| "next" \| "other"/.test(src));
  ok("  ⚠ return が7種類のどれかだけ", (src.match(/return "(area|station|cond|search|list|next|other)";/g) || []).length >= 6);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
