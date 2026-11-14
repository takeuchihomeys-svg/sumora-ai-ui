// 実行: node tests/chrome-extension/human-learn-save-bug-v2668.test.js
// 2026-11-11 竹内さん「今このお客さんを普通モードでやったんやけど動き理解できているかな」
//   → DB を見たら 0行だった。原因を2つ見つけて直した:
//     ① save() から `_saving = true` が抜けていた（前の編集で消えた）→ 保存が走らない/二重に走る
//     ② 貯めた直後に送っていなかった（別スクリプトの storage 変化待ちだけに頼っていた）
//   さらに: 読み込み順が「記録 → 送る係」で、記録側から送る係を呼べなかった → 逆にする
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const rec = read("human-learn-record.js"), up = read("human-learn-upload.js");
const mf = JSON.parse(read("manifest.json"));

console.log("■ ① 保存がちゃんと走る（_saving の掛け金）");
{
  ok("save() の頭で「保存中なら何もしない」を持つ", /if \(_saving\) return;/.test(rec));
  const body = rec.slice(rec.indexOf("function save(force)"), rec.indexOf("function save(force)") + 900);
  ok("  save() の中で _saving を立てている", /_saving = true;/.test(body));
  ok("  立てるのは「貯める対象がある」判定の後（無駄に立てない）", body.indexOf("if (!force && ops.length < MIN_OPS_TO_SAVE) return;") < body.indexOf("_saving = true;"));
  ok("貯めたら _saving を下ろす", /_saving = false;[\s\S]{0,120}rec\.reset\(\);/.test(rec));
  ok("例外でも _saving を下ろす（固まらない）", (rec.match(/\} catch \(_\) \{ _saving = false; \}/g) || []).length >= 2);
  const body2 = rec.slice(rec.indexOf("function save(force)"));
  ok("立てた後に保存している（chrome.storage.local.set）", body2.indexOf("_saving = true;") < body2.indexOf("chrome.storage.local.set"));
}

console.log("\n■ ② 貯めた直後に DB へ送る（変化待ちに頼らない）");
{
  ok("貯めた後の処理で送る係を呼ぶ", /__axlxHumanMotionUploadNow/.test(rec) && /U\(next\)/.test(rec));
  ok("送る係を呼ぶのは storage に書いた後", rec.indexOf("chrome.storage.local.set(o, function ()") < rec.indexOf("U(next)"));
  ok("貯めた内容をコンソールに出す（何が貯まったか分かる）", /人の動きを貯めました:/.test(rec));
  ok("送る係に「その場で送る」口がある", /window\.__axlxHumanMotionUploadNow = function \(agg, opts\)/.test(up));
  ok("その場で送る時も5分の間隔を守る", /if \(last && Date\.now\(\) - last < MIN_GAP_MS\)/.test(up.slice(up.indexOf("__axlxHumanMotionUploadNow"))));
  ok("その場で送る時も送った印を置く", /o\[SENT_KEY\] = Date\.now\(\);[\s\S]{0,80}upload\(agg/.test(up));
  /**
   * 2026-11-14 竹内さん「自動検索の部分学習反映されるようにちゃんと連携する」:
   *   自動モードの記録は `mode` を付けて送る。⚠ 人の5分の間隔で止めない（別枠）。
   */
  ok("自動モードの記録は mode を付けて送れる", /if \(mode\) \{[\s\S]{0,120}upload\(agg, \{ site: o2\.site \|\| agg\.site, mode: mode \}\)/.test(up));
  ok("  自動モードは5分の間隔で止めない（人の記録に影響しない）", /if \(mode\) \{[\s\S]{0,200}return;/.test(up.slice(up.indexOf("__axlxHumanMotionUploadNow"))));
}

console.log("\n■ ③ 読み込み順（記録より先に送る係）");
{
  const c = mf.content_scripts.find((x) => (x.js || []).includes("human-learn-record.js"));
  ok("送る係が先・記録が後", c.js.indexOf("human-learn-upload.js") < c.js.indexOf("human-learn-record.js"), c.js);
  ok("どちらも3サイト＋リアプロ", c.matches.includes("https://www.realnetpro.com/*") && c.matches.includes("https://itandibb.com/*") && c.matches.includes("https://system.reins.jp/*"));
}

console.log("\n■ ④ その場で確かめられる（console）");
{
  ok("__axlxLearnNow がある（いま何を覚えているか）", /window\.__axlxLearnNow = function/.test(rec));
  ok("  貯まった合計を出す", /out\.貯まった合計 =/.test(rec));
  ok("  理解した動きを出す", /out\.理解した動き =/.test(rec));
  ok("  最後に送った時刻を出す", /out\.最後に送った時刻 =/.test(rec));
  ok("__axlxLearnSendNow がある（その場で送る）", /window\.__axlxLearnSendNow = function/.test(rec));
  ok("  送る物が無い時は理由を出す", /送る物がありません/.test(rec));
  ok("  送る係が居ない時は理由を出す", /送る係（human-learn-upload\.js）が居ません/.test(rec));
  ok("__axlxHumanLearnReport も残っている（いま画面で覚えている数）", /window\.__axlxHumanLearnReport = function/.test(rec));
}

console.log("\n■ ⑤ 学習の読み込みが全サイトで有効");
{
  const first = mf.content_scripts[0];
  ok("純関数が先頭（document_start）", first.js.includes("human-learn.js"));
  ok("3サイトすべて", first.matches.length >= 4);
  ok("カーソル（pointer-ui.js）より前（癖を読める）", first.js.indexOf("human-learn.js") < first.js.indexOf("pointer-ui.js"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
