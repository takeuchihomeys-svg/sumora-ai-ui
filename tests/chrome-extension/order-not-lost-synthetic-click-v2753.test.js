// tests/chrome-extension/order-not-lost-synthetic-click-v2753.test.js
// 実行: node tests/chrome-extension/order-not-lost-synthetic-click-v2753.test.js
// 2026-11-14 竹内さん
//   「家賃のプルダウンの部分のマウスのうごきとクリックして選択する動き」
//   「徒歩の部分プルダウンで選択してそのままにしているうごき」
//   「更新日のプルダウンをマウスで動かしてクリックするうごき」
//   「次へを押す場所もちゃんと把握するようにする」
//
//   ⚠ 実測: 欄の名前は21種類あるのに、**押した順番が0件**（`field_order` が2手以上=0）。
//     原因: `recordPoint` が `clientX/clientY` で位置を出していたが、
//       拡張の `el.click()` は**合成クリックで座標が 0,0** になる
//       → `fx = (0 - left) / width` が大きくマイナス → **「枠の外」で捨てていた**。
//     つまり**自動モード・AIX の押下は1つも記録されず、順番が学べなかった**。
//
//   直した事（このテストで固定する）:
//     ① 座標 0,0（合成クリック）は**要素の真ん中**として記録する（捨てない）
//     ② 人の押下は今まで通り実際の位置（正確）
//     ③ 合成の時は `syn:true` を付ける（位置が推測だと分かる）
//     ④ 明らかに枠の外（人が別の所を押した）は今まで通り捨てる
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const L = require(path.join(dir, "human-learn.js"));
const src = read("human-learn.js");
const code = src.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① 合成クリック（座標0,0）を捨てない");
{
  ok("_syn（合成かどうか）を判定している", /var _syn = \(Number\(e\.clientX\) === 0 && Number\(e\.clientY\) === 0\)/.test(code));
  ok("  合成なら真ん中（0.5）", /_syn \? 0\.5 :/.test(code));
  ok("  ⚠ 枠の外で捨てるのは『合成でない時だけ』", /if \(!_syn && !\(fx >= -0\.2/.test(code));
  ok("  印を付ける（位置は推測）", /syn: _syn \|\| undefined/.test(code));
}

console.log("\n■ ② recordPoint の判定（合成クリックを捨てない）");
{
  /**
   * ⚠ **テストの当て所を間違えない**（実装で発覚）:
   *   ・`L.create().attach()` の `guarded` は **`isTrusted` だけ**を通す（＝人の動きの手本）
   *     → 合成クリックは**そもそも入らない**（これは正しい設計・学習を汚さない）
   *   ・拡張の押下を拾うのは `human-learn-record.js` の `_cap`（`isTrusted` を区別して両方拾う）
   *   → `recordPoint`（位置の記録）が合成クリックを捨てない事を、**要素とイベントを直接渡して**確かめる。
   *     `recordPoint` は `human-learn.js` の中の関数だが、外から呼べる形（api）に出していないので、
   *     ここでは**コードの条件**と**挙動の条件**を分けて確かめる。
   */
  ok("⚠ 合成クリック（座標0,0）の時に捨てる条件を通さない", /if \(!_syn && !\(fx >= -0\.2/.test(code));
  ok("  合成なら真ん中を使う", /_syn \? 0\.5 : \(e\.clientX - r\.left\)/.test(code));

  // 人が押した時は今まで通り実際の位置（この経路は isTrusted だけなので人の押下で確かめる）
  const ls = { doc: {}, win: {} };
  const doc = {
    addEventListener: (t, fn) => { (ls.doc[t] = ls.doc[t] || []).push(fn); },
    removeEventListener() {},
    documentElement: { scrollHeight: 3000 },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const win = { innerWidth: 1200, innerHeight: 800, pageYOffset: 0, addEventListener: (t, fn) => { (ls.win[t] = ls.win[t] || []).push(fn); }, removeEventListener() {} };
  const rec = L.create({ now: () => 1000, doc, win });
  rec.attach(doc, win);
  const el = (n) => ({
    tagName: "SELECT",
    getAttribute: (a) => (a === "name" ? n : null),
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 30 }),
    closest: () => null,
  });
  const fire = (list, ev) => (list || []).forEach((f) => f(ev));

  fire(ls.doc.click, { isTrusted: true, target: el("rental_cost2"), clientX: 180, clientY: 115 });
  const d = L.summarizeMotion(rec.detail());
  const f = d.points && d.points.fields && d.points.fields.rental_cost2;
  ok("人が押した所は実際の位置（右寄り80%くらい）", !!f && f.x > 0.7, f);
  ok("  名前が入る", !!(d.points && d.points.fields && d.points.fields.rental_cost2), d.points && Object.keys(d.points.fields || {}));
}

console.log("\n■ ③ 人の押下で明らかに枠の外なら捨てる（今まで通り）");
{
  const ls = { doc: {}, win: {} };
  const doc = {
    addEventListener: (t, fn) => { (ls.doc[t] = ls.doc[t] || []).push(fn); },
    removeEventListener() {},
    documentElement: { scrollHeight: 3000 },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const win = { innerWidth: 1200, innerHeight: 800, pageYOffset: 0, addEventListener: (t, fn) => { (ls.win[t] = ls.win[t] || []).push(fn); }, removeEventListener() {} };
  const rec = L.create({ now: () => 1000, doc, win });
  rec.attach(doc, win);
  const el = { tagName: "SELECT", getAttribute: (a) => (a === "name" ? "rental_cost2" : null), getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 30 }), closest: () => null };
  // 人が全然違う所（x=1000）を押した → 枠の外
  (ls.doc.click || []).forEach((f) => f({ isTrusted: true, target: el, clientX: 1000, clientY: 500 }));
  const s = L.summarizeMotion(rec.detail());
  ok("枠の外の人の押下は記録しない", ((s.points && s.points.n) || 0) === 0, s.points);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
