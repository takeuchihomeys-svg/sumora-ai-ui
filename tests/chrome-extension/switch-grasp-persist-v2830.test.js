// 2.8.130: 前客の番号を頁の読み直しを越えて持つ／台帳の番号は始めたお客さんで固定／前客の希望と今客の希望を突き合わせる
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("✓ " + name); } else { fail++; console.log("✗ " + name); } }

const root = path.join(__dirname, "..", "..", "chrome-extension");
const ps = fs.readFileSync(path.join(root, "page-script.js"), "utf8");

function body(src, name) {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) return "";
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}") { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return "";
}

// 前客の番号を sessionStorage にも置く
const ss = {};
const win = { sessionStorage: { getItem: (k) => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); } } };
const mk = new Function("window", "var _AX_LAST_CID_KEY = 'axlx_last_filled_cid';" + body(ps, "_lastFilledCidLoad") + body(ps, "_lastFilledCidSave") + "; return { load: _lastFilledCidLoad, save: _lastFilledCidSave };");
const A = mk(win);
A.save("aaaaaaaa-1111");
ok("保存すると window にも置く", win.__axlxLastFilledCustomerId === "aaaaaaaa-1111");
win.__axlxLastFilledCustomerId = null; // 頁の読み直しで window が消えた
ok("頁を読み直しても sessionStorage から前客の番号が読める", A.load() === "aaaaaaaa-1111");
ss.axlx_last_filled_cid = JSON.stringify({ cid: "old", at: Date.now() - 7 * 3600 * 1000 });
ok("6時間より古い番号は使わない", A.load() === "");

ok("切替把握は _lastFilledCidLoad で前客を読む", /var _prevCid = _lastFilledCidLoad\(\)/.test(ps));
// 2.8.313 退役: 「開始時に _lastFilledCidSave(今客) で残す」は 2.8.201 で意図して置き換わった。開始直後に今客で上書きすると前客≠今客が常に偽になり、
//   前客の残り（駅）を外さず止まったため、前客の番号は一連の完了時（notifyDone／ready_next）にだけ残す（page-script.js のコメント・memory/dept_search_tool.md 2026-11-23 2.8.201）。
ok("今客の番号は開始時でなく完了時にだけ残す（2.8.201）", !/_lastFilledCidSave\(_nextCid\)/.test(ps) && /if \(_doneCid\) _lastFilledCidSave\(_doneCid\)/.test(ps) && /if \(_ndCid\) _lastFilledCidSave\(_ndCid\)/.test(ps));

// 前客の希望と今客の希望の差
const D = new Function(body(ps, "_wantDiff") + "; return _wantDiff;")();
const d = D({ wards: ["27102", "27103"], stations: ["梅田", "難波"] }, { wards: ["27103"], stations: ["難波", "天満"] });
ok("前客にあって今客に無い区を外す候補にする", d.dropWards.length === 1 && d.dropWards[0] === "27102");
ok("前客にあって今客に無い駅を外す候補にする", d.dropStations.length === 1 && d.dropStations[0] === "梅田");
ok("共通の数を数える", d.keep === 2);
ok("前客の希望が無ければ空", D(null, { wards: ["1"] }).dropWards.length === 0);

// 台帳
ok("台帳の番号は始めたお客さんで固定（_axLedgerCid を先に使う）", /cid: String\(_axLedgerCid \|\|/.test(ps));
ok("台帳に希望（want）を残す", /want: _axLedgerWant \|\| null/.test(ps));
ok("切替の時、前客の保存待ちを前客の番号のまま書き切る", /_ledgerSave\("flush_on_switch"\)/.test(ps));
ok("点検に前客の希望→今客の外す候補を残す", /前客の希望→今客: 外す候補/.test(ps));

console.log(pass + " pass / " + fail + " fail");
process.exit(fail ? 1 : 0);
