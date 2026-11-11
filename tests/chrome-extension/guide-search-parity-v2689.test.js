// 実行: node tests/chrome-extension/guide-search-parity-v2689.test.js
// 2026-11-11 竹内さん「まだ検索もおせていない。ちゃんと通常モードのアナウンスのところ参考に改善していくように。
//   あの動きが分かればできるはず。所在地も通常モードならちゃんと光るのに自動モードやAIXモードでできていない」
//
//   原因: 案内モード（realpro-guide.js）の探し方は2つ賢い。
//     ① 文字のノードから上へたどる（textMatches）→ 入れ子が深くても取れる
//     ② 区は `input[name="city_code[]"][value="コード"]` で**コード**を直接探す
//   自動モードは ①は要素の全体文字を比べるだけ・②は**文字で照合**だったので取りこぼしていた。
const fs = require("fs");
const path = require("path");
const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const ps = read("page-script.js"), guide = read("realpro-guide.js");

console.log("■ ① 文字の探し方を案内モードと同じにした（入れ子でも取れる）");
{
  ok("案内モードは文字のノードから上へたどる（textMatches）", /function textMatches\(texts, sel\)/.test(guide) && /createTreeWalker/.test(guide));
  ok("案内モードは「中の要素に同じ文字があれば外側は外す」", /el\.contains\(o\)/.test(guide));
  ok("自動モードにも同じ探し方を入れた（_textMatches）", /function _textMatches\(texts, sel\)/.test(ps));
  ok("  文字のノードから上へたどる", /createTreeWalker\(document\.body, NodeFilter\.SHOW_TEXT/.test(ps));
  ok("  欲しい文字の一部になっているノードだけ見る", /want\.some\(function \(w\) \{ return w\.indexOf\(nt\) >= 0; \}\)/.test(ps));
  ok("  6段まで上へたどる", /el && el !== document\.body && k < 6/.test(ps));
  ok("  長くなったら止める（関係ない箱を拾わない）", /if \(et\.length > maxLen\) break;/.test(ps));
  ok("  一番内側だけ残す", /el\.contains\(o\)/.test(ps));
  ok("  画面に見えている物を優先", /_findByText[\s\S]{0,400}r\.top >= 0 && r\.bottom <=/.test(ps));
}

console.log("\n■ ② 所在地（区）は**コード**で探す（案内モードと同じ）");
{
  ok("案内モードはコードで探す", /checkInput\("city_code\[\]", code\)/.test(guide));
  ok("自動モードもコードで先に探す", /input\[name="city_code\[\]"\]\[value="' \+ String\(codes\[ci2\]\) \+ '"\]/.test(ps));
  ok("  控え（__axlxWardCodes）を使う", /window\.__axlxWardCodes/.test(ps));
  ok("  コードで選べたら点検に残す（ward_by_code）", /_auditStepP\('ward_by_code'/.test(ps));
  ok("  コードで選べたらそこで成功（文字照合へ落ちない）", /_auditStepP\('ward_by_code'[\s\S]{0,120}return true;/.test(ps));
  ok("  コードが無ければ今まで通り文字で探す", /var allLabels = Array\.prototype\.slice\.call\(document\.querySelectorAll\('label'\)\)/.test(ps));
  ok("区のコードを控えに入れる（fillRealpro）", /window\.__axlxWardCodes = \(cond\.city_codes \|\| \[\]\)\.map\(String\)/.test(ps));
}

console.log("\n■ ③ 検索ボタンは案内モードと同じ探し方でも探す（押せないを無くす）");
{
  ok("文字から探す最後の手段がある", /var _byTextBtn = _findByText\(\['住居検索', '検索', '物件を検索する', '条件で検索'\]\)/.test(ps));
  ok("  小窓の中は避ける", /if \(_byTextBtn && !_inModal\(_byTextBtn\)\)/.test(ps));
  ok("  それでも無ければ最後の手段として押す（検索しない方が困る）", /検索ボタンが小窓の中にしかありません（押します）/.test(ps));
  ok("  input[type=button] も候補に入れる", /input\[type="submit"\],a,input\[type="button"\]/.test(ps));
  ok("押すのはカーソルを動かしてから（人の形）", /_humanPointerClick\(btn, function \(\) \{ try \{ btn\.click\(\); \}/.test(ps));
}

console.log("\n■ ④ 場所の欄を開く段取りは残っている（v2.6.82）");
{
  ok("_openerFor がある", /function _openerFor\(el\)/.test(ps));
  ok("_ensureFieldVisible がある", /function _ensureFieldVisible\(el, name, maxMs\)/.test(ps));
  ok("所在地は「所在地絞り込み＋」", /所在地絞り込み＋/.test(ps));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
