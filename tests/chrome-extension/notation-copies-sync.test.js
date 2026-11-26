// tests/chrome-extension/notation-copies-sync.test.js — 表記の写しが正本（popup-maps.js）と同じかを見張る（2026-11-26）
//
// 竹内さん「表記のところリアプロと itandi で違う部分もあるのでちゃんと把握しておけ」→ 実測で、
//   一括・自動の経路が使う resolution-core.js の表が正本の半分しか無く、能勢電鉄・近鉄信貴線などが
//   ITANDI・REINS に出なかった。写しを正本に揃えたので、そのずれが再び入らないように止める。
//
// 見る物（正本 = chrome-extension/popup-maps.js の const）:
//   ・resolution-core.js の var: STATION_WARD_MAP / STATION_LINE_MAP / LINE_STATION_ORDER /
//     ITANDI_LINE_MAP_FILL / LINE_ROUTE_MAP / LINE_ALIAS_MAP / REINS_LINE_MAP
//   ・popup.js の注記用の const ITANDI_LINE_MAP（手順書の表示だけに使う・ITANDI_LINE_MAP_FILL と同じでなければならない）
// 直し方: 正本を直したら、写しも同じ内容に直す（表の本体 { ... } を丸ごと写す）。
// 実行: node tests/chrome-extension/notation-copies-sync.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DIR = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(DIR, f), "utf8");
let pass = 0, fail = 0;
const t = (name, ok, extra) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? "\n      " + extra : ""}`); }
};

// 名前の直後の { ... } を評価して取り出す（const / var / 関数の中のインデント付きも可）
function grab(src, re) {
  const m = re.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") {
      d--;
      if (d === 0) return vm.runInNewContext("(" + src.slice(open, k + 1) + ")", {});
    }
  }
  return null;
}
function diffKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
    if (x !== y) out.push(`${k}: 正本=${x ?? "(無し)"} 写し=${y ?? "(無し)"}`);
  }
  return out;
}

const pm = read("popup-maps.js");
const rc = read("resolution-core.js");
const pj = read("popup.js");

console.log("■ resolution-core.js の表は正本と同じか（一括・自動の経路）");
for (const name of ["STATION_WARD_MAP", "STATION_LINE_MAP", "LINE_STATION_ORDER", "ITANDI_LINE_MAP_FILL", "LINE_ROUTE_MAP", "LINE_ALIAS_MAP", "REINS_LINE_MAP", "WARD_CODE_MAP", "NEIGHBORHOOD_WARD_MAP"]) {
  const canon = grab(pm, new RegExp("const " + name + "\\s*=\\s*\\{"));
  const copy = grab(rc, new RegExp("var " + name + "\\s*=\\s*\\{"));
  if (!canon || !copy) { t(`${name} が両方に読める`, false, `正本=${!!canon} 写し=${!!copy}`); continue; }
  const d = diffKeys(canon, copy);
  t(`${name}（${Object.keys(canon).length}件）が正本と同じ`, d.length === 0, d.slice(0, 8).join("\n      ") + (d.length > 8 ? `\n      …ほか ${d.length - 8} 件` : ""));
}

console.log("■ popup.js の注記用 ITANDI 表は正本と同じか");
{
  const canon = grab(pm, /const ITANDI_LINE_MAP_FILL\s*=\s*\{/);
  const copy = grab(pj, /const ITANDI_LINE_MAP\s*=\s*\{/);
  if (!canon || !copy) t("popup.js の ITANDI_LINE_MAP が読める", false);
  else {
    const d = diffKeys(canon, copy);
    t(`popup.js ITANDI_LINE_MAP（${Object.keys(canon).length}件）が正本と同じ`, d.length === 0, d.join("\n      "));
  }
}

console.log("■ 写しの中身の約束（ずれやすい所）");
{
  const rcRoute = grab(rc, /var LINE_ROUTE_MAP\s*=\s*\{/) || {};
  t("能勢電鉄妙見線・日生線に路線番号（リアプロ 6676）が付く", rcRoute["能勢電鉄妙見線"] === "6676" && rcRoute["能勢電鉄日生線"] === "6676");
  const rcItandi = grab(rc, /var ITANDI_LINE_MAP_FILL\s*=\s*\{/) || {};
  t("近鉄信貴線・西信貴ケーブル線の ITANDI 名が正本どおり", rcItandi["近鉄信貴線"] === "近鉄信貴線" && rcItandi["近鉄西信貴ケーブル線"] === "近鉄西信貴鋼索線(西信貴ケーブル)");
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
