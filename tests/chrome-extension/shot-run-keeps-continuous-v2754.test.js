// tests/chrome-extension/shot-run-keeps-continuous-v2754.test.js
// 実行: node tests/chrome-extension/shot-run-keeps-continuous-v2754.test.js
// 2026-11-14 竹内さん
//   「一番直近で録画したのから動き方学ぶ」
//   「連続して画像をみたらアニメーションのように動き理解できるので、それで押したところ学ぶ」
//   「この連続再生の形を学ぶようにしていくように徹底的におこなっていく」
//
//   ⚠ 実測（決定的な証拠）: run_id が**1秒ごとに変わっていた**
//     20:06:06 run=mwgaus2e / 20:06:06 run=mwgau995 / 20:06:07 run=mwgau1of …
//     → **25個のまとまりが全部1枚**。連続画像にならない＝アニメーションとして学べない。
//
//   原因:
//     ① `_shotLastAt` を撮影の**前**に更新していたため、押すたびに来る撮影要求（同時に走る）が
//        それぞれ「10分あいた」と判断して**新しいまとまり**を作った。
//     ② `_shotRun` は**変数**なので、Service Worker が休むと消える。
//
//   直した事（このテストで固定する）:
//     ① まとまりを **chrome.storage.local に保存**（SWが休んでも続く）
//     ② 「10分あいたら新しいまとまり」は**保存した最後の撮影時刻**で判定
//     ③ 同時に走っても**同じまとまり**（判定と保存を1か所で行う）
//     ④ 検索を始めたら**明示的に新しいまとまり**にできる（_shotRunNew）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const bg = read("background.js");
const code = bg.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

console.log("■ ① まとまり（run_id）を storage に保存する");
{
  ok("_shotRunFor がある", /async function _shotRunFor\(/.test(code));
  ok("  ⚠ 保存した物を読む", /axlx_shot_run/.test(code) && /axlx_shot_last_at/.test(code));
  ok("  保存する", /chrome\.storage\.local\.set\(\{ axlx_shot_run/.test(code));
  ok("  ⚠ 変数だけに頼らない（SWが休んでも続く）", /saved && saved\.run && saved\.at/.test(code));
}

console.log("\n■ ② 10分あいたら新しいまとまり（連続再生の単位）");
{
  ok("SHOT_RUN_GAP_MS = 10分", /var SHOT_RUN_GAP_MS = 10 \* 60 \* 1000;/.test(code));
  ok("  保存した時刻で判定する", /t - saved\.at <= SHOT_RUN_GAP_MS/.test(code));
  ok("  メモリにあればそれを使う（速い道）", /if \(_shotRun && _shotLastAt && t - _shotLastAt <= SHOT_RUN_GAP_MS\) return _shotRun;/.test(code));
}

console.log("\n■ ③ 同時に走っても同じまとまり（旧のバグを潰した）");
{
  ok("⚠ 撮影の前に _shotLastAt を更新していない（旧の原因）", !/_shotSeq\+\+;\s*\n\s*_shotLastAt = t0;/.test(code) || /await _shotRunFor/.test(code));
  ok("  撮影では _shotRunFor を通す", /_shotRun = await _shotRunFor\(t0\);/.test(code));
  ok("  同時実行を1つにする（ロック）", /_shotRunLock/.test(code));
}

console.log("\n■ ④ 検索を始めたら明示的に新しいまとまり");
{
  ok("_shotRunNew がある", /async function _shotRunNew\(/.test(code));
  ok("  新しいIDを作る", /_shotRunNew[\s\S]{0,300}?_shotRun = t\.toString\(36\)/.test(code.replace(/\n\s*/g, " ")));
}

console.log("\n■ ⑤ 実際にまとまりが続く（同じ条件なら同じIDを返す）");
{
  // 関数の本体を取り出して、storage を模して評価する
  const m = bg.match(/async function _shotRunFor\(nowMs\) \{[\s\S]*?\n\}/);
  ok("関数の本体を取り出せる", !!m);
  if (m) {
    const store = {};
    const fakeChrome = { storage: { local: {
      get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; }); return o; },
      set: async (o) => { Object.assign(store, o); },
    } } };
    const vars = { SHOT_RUN_GAP_MS: 10 * 60 * 1000, _shotRun: null, _shotSeq: 0, _shotLastAt: 0, _shotRunLock: null };
    const fn = new Function("chrome", "SHOT_RUN_GAP_MS", "state", `
      let _shotRun = state._shotRun, _shotSeq = state._shotSeq, _shotLastAt = state._shotLastAt, _shotRunLock = state._shotRunLock;
      ${m[0].replace(/^async function _shotRunFor/, "async function f")}
      return async function (t) {
        const r = await f(t);
        state._shotRun = _shotRun; state._shotSeq = _shotSeq; state._shotLastAt = _shotLastAt;
        return r;
      };
    `);
    void vars;
    const state = { _shotRun: null, _shotSeq: 0, _shotLastAt: 0, _shotRunLock: null };
    const call = fn(fakeChrome, 10 * 60 * 1000, state);
    const t0 = Date.parse("2026-11-14T20:06:00+09:00");
    return (async () => {
      const r1 = await call(t0);
      const r2 = await call(t0 + 1000);
      const r3 = await call(t0 + 2000);
      ok("⚠ 1秒後も**同じまとまり**（旧は毎回変わった）", r1 === r2 && r2 === r3, { r1, r2, r3 });
      const r4 = await call(t0 + 11 * 60 * 1000);
      ok("⚠ 10分あいたら新しいまとまり", r4 !== r1, { r1, r4 });
      // SW が休んで変数が消えても、保存から復活する
      state._shotRun = null; state._shotLastAt = 0;
      const r5 = await call(t0 + 11 * 60 * 1000 + 1000);
      ok("⚠ SWが休んでも同じまとまりが続く（保存から復活）", r5 === r4, { r4, r5 });

      console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
      if (failed > 0) process.exit(1);
    })();
  }
  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  if (failed > 0) process.exit(1);
}
