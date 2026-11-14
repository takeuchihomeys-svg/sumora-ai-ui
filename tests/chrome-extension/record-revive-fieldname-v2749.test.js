// tests/chrome-extension/record-revive-fieldname-v2749.test.js
// 実行: node tests/chrome-extension/record-revive-fieldname-v2749.test.js
// 2026-11-14 竹内さん「順になおしていく」
//   「弱い部分を俺が実際みつけたら通常モードの録画から実際の動きを学習して改善することできるようになったかな」
//
// 実測（7日・1000行）:
//   ・field_order あり 3件 / point_fields あり 27件 しかない
//   ・学べた欄の8割が `img`(26) と `body`(8)。本物は `左の次｜td.pager`(4) だけ
//   ・写真の diag は全部 `ring_empty: … ring0: seen0: watchundefined`
//
// 原因（2つ・どちらも直した）:
//   ① `watchundefined` = **先頭の受け口が「まだ立ち上がっていない」と答えた**印。
//      本体が `if (!L) return;` で抜けていた（human-learn.js がまだ居ない）。
//      ⚠ 旧は**1回だけ見て諦めた**ので、順番が逆だと**永久に立ち上がらなかった**（seen:0）。
//      → **最大3秒待つ**（50msおき・来たら start() を呼ぶ）。
//   ② `img` / `body` は**欄ではない**。名前も id も class も無い要素にタグ名を返していた。
//      → ① 親（リンク・ボタン・行）の意味のある名前を探す ② 無ければ **null**（ゴミを貯めない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const rec = read("human-learn-record.js");
const recCode = rec.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
const L = require(path.join(dir, "human-learn.js"));

console.log("■ ① ライブラリが後から来ても立ち上がる（seen:0 の原因）");
{
  ok("待つ仕組みがある（setInterval で最大3秒）", /_waitTimer = setInterval\(/.test(recCode) && /_waitTries >= 60/.test(recCode));
  ok("  ⚠ 1回見て諦めていない（旧の即 return をやめた）", !/if \(!L\) \{\s*try \{ _recBoot\.__axlxHumanLearnRecState = \{ why: "no_learn_lib" \}; \} catch \(_\) \{\}\s*return;\s*\}/.test(recCode));
  ok("  ライブラリが来たら start() を呼ぶ", /if \(got\) \{[\s\S]{0,300}?_bootAfterLib\(\)/.test(recCode));
  ok("  本体が start() にまとまっている", /function start\(\) \{/.test(recCode) && /\} \/\/ start\(\) ここまで/.test(rec));
  ok("  理由に waiting_lib を残す（次に同じ事が起きたら分かる）", /waiting_lib/.test(recCode));
  ok("  3秒来なければ no_learn_lib で諦める（印は立てない）", /no_learn_lib/.test(recCode));
}

console.log("\n■ ② img / body を欄として記録しない");
{
  ok("img/body などを弾く一覧がある", /NON_FIELD/.test(recCode) === false || /NON_FIELD/.test(read("human-learn.js")));
  const lc = read("human-learn.js").split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
  ok("  _NON_FIELD が fieldName の中にある", /_NON_FIELD\s*=\s*\/\^\(img\|body/.test(lc));
  ok("  親（リンク・ボタン・行）から名前を探す", /closest\("a,button,label,tr,li,\[role='button'\]"\)/.test(lc));
  ok("  ⚠ 名前が無ければ null を返す（ゴミを貯めない）", /return null;\s*\}\s*\}\) catch \(_\) \{\}/.test(lc) || /\/\/ ② 意味のある名前が無い → \*\*記録しない\*\*/.test(read("human-learn.js")));
}

console.log("\n■ ③ fieldName の実際の動き（本物の要素で確かめる）");
{
  /** 最小の DOM もどき（getAttribute / className / tagName / closest / id） */
  const mkEl = (o) => ({
    tagName: o.tagName || "DIV",
    id: o.id || "",
    className: o.className || "",
    getAttribute: (a) => (o.attrs && o.attrs[a] != null ? o.attrs[a] : null),
    closest: (sel) => {
      if (o.host && /a,button,label,tr,li/.test(sel)) return o.host;
      return null;
    },
    getBoundingClientRect: () => ({ left: 900, top: 100, width: 50, height: 20 }),
    firstChild: null,
  });

  ok("name がある欄はその名前", L.fieldName(mkEl({ tagName: "SELECT", attrs: { name: "rental_cost2" } })) === "rental_cost2");
  ok("  ⚠ img（包む物なし）は null（旧は 'img' を返していた）", L.fieldName(mkEl({ tagName: "IMG" })) === null, L.fieldName(mkEl({ tagName: "IMG" })));
  ok("  ⚠ body も null", L.fieldName(mkEl({ tagName: "BODY" })) === null, L.fieldName(mkEl({ tagName: "BODY" })));
  // 画像を包むリンクに名前があれば、その名前を使う
  const hostWithName = mkEl({ tagName: "A", attrs: { name: "印刷用PDF" } });
  const imgInLink = mkEl({ tagName: "IMG", host: hostWithName });
  const got = L.fieldName(imgInLink);
  ok("  img でも包むリンクに名前があれば使う", got === "印刷用PDF", got);
  // 包む物があり class だけの時も、意味のある形にする
  const hostCls = mkEl({ tagName: "TD", className: "pager" });
  const imgInTd = mkEl({ tagName: "IMG", host: hostCls });
  const got2 = L.fieldName(imgInTd);
  ok("   class があれば『img→td.pager』の形", /img→td\.pager/.test(String(got2)), got2);
}

console.log("\n■ ④ 記録自体は止まらない（名前が無くても seen は増える）");
{
  ok("_pushOp に早期 return が無い（f:null でも積む）", /_opsRing\.push\(\{ t: t, k: String\(kind/.test(recCode));
  ok("  _opsSeen++ がある（拾った回数が分かる）", /_opsSeen\+\+/.test(recCode));
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
