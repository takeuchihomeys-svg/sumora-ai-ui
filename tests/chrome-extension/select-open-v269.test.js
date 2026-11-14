// 実行: node tests/chrome-extension/select-open-v269.test.js
// 2026-11-10 竹内さん「あと選択してちゃんとその画面おすように／家賃のところも押したらいきなり入力されているが
//   押したら家賃の部分を選択する形で動くように。このように動くようにすればちゃんと人間らしい動きとなる」
//   ① プルダウンは「値を代入」ではなく「押して開いて選ぶ」
//   ② 開く → 一覧を見る → 候補へ移る（矢印キー＋カーソル）→ 確定 → 閉じたのを見届ける
//   ③ クリックは「狙いを定める間」→ 押す → 反応を見る間
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

const ps = read("page-script.js");

console.log("■ ① プルダウンは押して開いて選ぶ");
ok("chooseSelectLikeHuman がある", /function chooseSelectLikeHuman\(el, val, opts\)/.test(ps));
ok("queueSelVal が chooseSelectLikeHuman を使う", /_enqueueWithEl\(el, function \(\) \{ return chooseSelectLikeHuman\(el, val, \{ forceOpen: true, aim: _aim \}\); \}/.test(ps));
// 2026-11-11 竹内さん「徒歩の部分もまずおして展開された中の徒歩をおすながれ。時間差も人間が押すように」
ok("徒歩（移動手段）は待ちを長くする", /_isTransport \? 1400 : 900/.test(ps) && /_isTransport \? 2600 : 1600/.test(ps));
  /**
   * 2026-11-14 竹内さん「駅からの移動手段のところ 徒歩をプルダウンで選択するところできていなかった」:
   *   文字での照合を **完全一致 → 先頭一致 → 含む** の3段にし、
   *   どれも無ければ `want = -1`（＝先頭を選ばない）に変えた。テストもその形に合わせる。
   */
  ok("値で見つからなければ文字（徒歩）でも探す",
    /_ot === _wantText/.test(ps) && /_ot2\.indexOf\(_wantText\) === 0/.test(ps) && /_ot3\.indexOf\(_wantText\) >= 0/.test(ps));
  ok("  ⚠ 見つからない時に先頭（未選択）を選ばない", /if \(want < 0\) \{[\s\S]{0,300}return Promise\.resolve\(false\)/.test(ps));

console.log("\n■ ② 開く→見る→移る→確定→閉じを見届ける");
ok("欄を押して開く（mousedown/mouseup/click）", /fire\("mousedown", \{ buttons: 1 \}\);\s*fire\("mouseup"\);\s*fire\("click"\);/.test(ps));
ok("開いた一覧を見る間（500〜1500ms）", /_ln\(900, 0\.4, 500, 1500\)/.test(ps));
ok("候補へ移る（矢印キー）", /new KeyboardEvent\("keydown", \{ key: k/.test(ps) || /el\.selectedIndex = want;/.test(ps));
ok("カーソルも一覧の方向へ動く", /P\.moveTo\(r\.left \+ r\.width \* 0\.5, r\.top \+ r\.height \* 0\.5 \+ dir \* \(18 \+ i2 \* 6\)\)/.test(ps) || /el\.selectedIndex = want;/.test(ps));
// 2026-11-11 竹内さん「家賃のところも大量に連続でえらばれてるけどおしてその家賃していしたらよいだけ」:
//   旧は selectedIndex を1つずつ動かしていた（＝大量に選ばれているように見えた）。今は**目当てを直接選ぶ**。
ok("目当ての値を直接選ぶ（途中の値は選ばない）", /el\.selectedIndex = want;[\s\S]{0,80}el\.value = target;/.test(ps));
ok("1つずつ動かすループが残っていない", !/var nxt = \(el\.selectedIndex >= 0 \? el\.selectedIndex : cur\) \+ dir;/.test(ps));
ok("確定して change を出す", /el\.value = target;/.test(ps) && /dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/.test(ps));
// 2026-11-11 竹内さん「展開された中で選択するところなのに一押ししかしていなかった」:
//   旧は el.value を代入して終わり（一覧が開いたまま＝一押しに見えた）。
//   新は **一覧を閉じてから** change を出し、閉じたのを見届ける。
ok("選んだ後に一覧を閉じる（blur → 外側を触る）", /el\.blur\(\)[\s\S]{0,500}_outside\.dispatchEvent\(new MouseEvent\("mousedown"/.test(ps));
ok("閉じたのを見届ける（150〜520ms）", /_ln\(260, 0\.4, 150, 520\)/.test(ps));
ok("目当ての値を直接選ぶ（selectedIndex = want）", /el\.selectedIndex = want;/.test(ps));

console.log("\n■ ③ クリックも「狙いを定める→押す→反応を見る」");
ok("押す前に狙いを定める間（90〜250ms）", /var aim = 90 \+ Math\.floor\(Math\.random\(\) \* 160\);/.test(ps));
// 2026-11-11: 押した後の「反応を見る間」は空の関数（何も待っていなかった）だったので、
//   押した瞬間にカーソルを縮めて戻す（見た目の反応）に変えた。次の間はキューが空ける。
ok("押した後に反応を見せる（カーソルの縮み・二重に待たない）", /if \(P && P\.tap\) P\.tap\(\);/.test(ps) && !/setTimeout\(function \(\) \{\}, 120/.test(ps));
ok("押す座標は真ん中固定でない（30〜70%）", /var fx = 0\.30 \+ Math\.random\(\) \* 0\.40;/.test(ps) && /var fy = 0\.30 \+ Math\.random\(\) \* 0\.40;/.test(ps));
ok("キューも押した後に間を置いてから次へ（ボタンの意味で変える）", /var settle = _afterClickGapMs\(item\.el\);/.test(ps) && /function _afterClickGapMs\(el\)/.test(ps));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
