/**
 * 2.8.136 竹内さん「ほかに人間としての動きがちゃんとできるように／一連の動きをみて／細部まで改善」
 *   実測 run_mwofi2sn_jbec（12:46 の自動・2人）から:
 *   ① 確定してリストへ の前に 14.45/6.92/4.89 秒 → 確定は「決定」（長い迷い・停止なし）
 *   ② 徒歩の欄を 0.6秒で2回押す → カーソルが既に欄の上なら狙い直しの tap をしない
 *   ③ 同じ区・間取りを 0.1秒以内に重ね押し → 反映待ち 240→600ms・押し直しは tap 付き
 *   ④ 外しの 320ms 後の直接押し → 2回確かめてから tap 付きで1回
 *   ⑤ 点検の段が fill_progress で埋まる → 最後の1つだけ残す
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "../../chrome-extension/page-script.js"), "utf8");
const audit = fs.readFileSync(path.join(__dirname, "../../chrome-extension/search-audit.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../chrome-extension/manifest.json"), "utf8"));

let fail = 0;
function check(name, ok) { console.log((ok ? "✓ " : "✗ ") + name); if (!ok) fail++; }

const _vGe = (v) => v.split(".").map(Number).reduce((a, n, i) => a || (n !== [2, 8, 136][i] ? (n > [2, 8, 136][i] ? 1 : -1) : 0), 0) >= 0;
check("manifest 2.8.136 以降", _vGe(manifest.version), manifest.version);
check("_AXLX_PAGE_VER が manifest と同じ", new RegExp('_AXLX_PAGE_VER = "' + manifest.version.replace(/\./g, "\\.") + '"').test(src));

check("① 確定の押下に decide: true", /keys: \["確定してリストへ", "この条件で絞り込む", "modal_confirm"\],\s*aim: _confAim \|\| undefined,\s*decide: true,/.test(src));
check("① 確定の文字の要素は decide", /\^\(確定してリストへ\|この条件で絞り込む\|検索\|決定\)\$/.test(src));

check("② カーソルが欄の上なら押し直さない", /_onSelAlready[\s\S]{0,900}sel_one_press[\s\S]{0,120}_afterAim\(\);\s*return;/.test(src));
check("② aim が無い欄は今まで通り", /if \(!\(_aimSel && typeof _aimSel\.x === "number"\)\) _onSelAlready = false;/.test(src));

check("③ 反映待ち 600ms", /return _settleChk\(600\)\.then\(function \(ok1\)/.test(src));
check("③ 旧 240ms が無い", !/_settleChk\(240\)/.test(src));
check("③ 押し直しはカーソルを動かしてから（_humanPointerClick）2.8.149〜", /_humanPointerClick\(hit, function \(\) \{ try \{ cb\.click\(\); \}/.test(src));
check("③ _tapIfCursorOn はカーソルが欄の上の時だけ", /function _tapIfCursorOn\(el\)[\s\S]{0,500}if \(cp\.x < r\.left - 2 \|\| cp\.x > r\.right \+ 2/.test(src));

check("④ 外しの直接押しは2回確かめてから", /clear_retry_press/.test(src) && !/setTimeout\(function \(\) \{ try \{ if \(cb\.isConnected && cb\.checked\) cb\.click\(\); \} catch \(_\) \{\} \}, 320\);/.test(src));

// ⑤ search-audit: fill_progress は最後の1つだけ
const SA = require(path.join(__dirname, "../../chrome-extension/search-audit.js"));
const tr = SA.createTracker({ post: function () { return Promise.resolve({ ok: true }); }, now: function () { return Date.now(); } });
const run = tr.begin({ run_id: "t1", site: "realpro", post_started: false });
for (let i = 0; i < 30; i++) tr.attachProgress("t1", [{ k: "s" + i, d: null, at: 1000 + i }]);
const fp = run.steps.filter((s) => s.k === "fill_progress").length;
check("⑤ fill_progress は1つだけ（30回の進捗で " + fp + "）", fp === 1);
check("⑤ ページの段は30全部残る", run.steps.filter((s) => /^page:s\d+$/.test(s.k)).length === 30);
check("⑤ 置き換えの印", /進捗の印は最後の1つだけ残す/.test(audit));

if (fail) { console.log(fail + " 件 失敗"); process.exit(1); }
console.log("全部 OK");
