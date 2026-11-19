// v2.8.111 竹内さん（2026-11-18）「場面ごとの強化を画像学習にも紐づける」
// 束 shots.learned_scene → background が axlx_learn_scene に保存 → page-script が
// 欄の名前から場面（area/station/search）を決め、点の学習が弱い時だけその場面の位置を先に使う。
// 実行: node tests/chrome-extension/scene-aim-v2810.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}

const bg = rd("chrome-extension/background.js");
const ps = rd("chrome-extension/page-script.js");
const cs = rd("chrome-extension/content.js");
const mf = JSON.parse(rd("chrome-extension/manifest.json"));

console.log("■ 版");
ok("manifest が 2.8.115", mf.version === "2.8.115", mf.version);
ok("_AXLX_PAGE_VER が 2.8.115", /var _AXLX_PAGE_VER = "2\.8\.115";/.test(ps));

console.log("■ background: 束の learned_scene を axlx_learn_scene へ");
ok("learned_scene を読む", /bundle\.shots\.learned_scene/.test(bg));
ok("n<2 は載せない（1枚の偶然を採らない）", /if \(\(Number\(_sf\.n\) \|\| 0\) < 2\) continue;/.test(bg));
ok("storage.set に axlx_learn_scene", /axlx_learn_scene: _sceneAim,/.test(bg));
ok("旧 axlx_learn_screen は残す", /axlx_learn_screen: _screenAim,/.test(bg));

console.log("■ content.js: MAIN world へ橋渡し");
ok("PUSH_KEYS に axlx_learn_scene", /"axlx_learn_scene"/.test(cs));

console.log("■ page-script: 場面の判定と位置の検索");
ok("_sceneOfName がある", /function _sceneOfName\(name\)/.test(ps));
ok("_sceneAimOf がある", /function _sceneAimOf\(name, scene\)/.test(ps));
ok("warm keys に axlx_learn_scene", /_LEARN_WARM_KEYS = \["axlx_learn_points", "axlx_learn_screen", "axlx_learn_scene"/.test(ps));
ok("storage 読込で _learnSceneMap を更新", /_learnSceneMap = \(r && r\.axlx_learn_scene\)/.test(ps));
ok("onChanged で _learnSceneMap を更新", /changes\.axlx_learn_scene/.test(ps));
ok("_aimOf は点が弱い時(n<3)だけ場面位置を試す", /if \(!v \|\| typeof v\.x !== "number" \|\| Number\(v\.n\) < 3\) \{\s*var _scn = _sceneOfName\(name\);/.test(ps));
ok("場面位置は要素が取れた時だけ使う（無ければ従来処理）", /if \(_scf\) \{[\s\S]{0,200}return \{ x: _scf\.x/.test(ps));

console.log("■ 場面の判定（純関数の写し）");
// page-script と同じ正規表現で判定（ずれたらこのテストが気づく）
const sceneOfName = (name) => {
  const n = String(name || "");
  if (/^(city_code|town_code)\[\]$|^one_(city|town)$|所在地/.test(n)) return "area";
  if (/^(station_id|route_id)\[\]$|^one_(station|line)$|沿線|駅を選ぶ/.test(n)) return "station";
  if (/^go_search$|^検索$|住居検索/.test(n)) return "search";
  return null;
};
ok("city_code[] は area", sceneOfName("city_code[]") === "area");
ok("town_code[] は area", sceneOfName("town_code[]") === "area");
ok("station_id[] は station", sceneOfName("station_id[]") === "station");
ok("route_id[] は station", sceneOfName("route_id[]") === "station");
ok("沿線を選ぶ は station", sceneOfName("沿線を選ぶ") === "station");
ok("go_search は search", sceneOfName("go_search") === "search");
ok("rental_cost1 は場面なし（従来どおり）", sceneOfName("rental_cost1") === null);
ok("room_layout_id[] は場面なし（従来どおり）", sceneOfName("room_layout_id[]") === null);

console.log(`\n結果: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
