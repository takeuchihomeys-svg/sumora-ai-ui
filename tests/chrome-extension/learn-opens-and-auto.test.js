// 録画→学習→自動検索の連携（2026-11-14）
//
// 竹内さん:
//   ① 「新しい録画データでもちゃんと動き学習できるように」
//   ② 「このようにボタンなのかプルダウンなのか、どこで展開されるのかも意識して学習して改善する」
//   ③ 「自動検索の部分学習反映されるようにちゃんと連携する。今自動検索がちゃんと学習連携されていない可能性たかい」
//
// 見つけた穴（本番DBと実装で確認）:
//   A. **AIX（自動）の記録が DB に0件**。自動の動きは `axlx_auto_motion`（PCの中）に貯めるだけで
//      `__axlxHumanMotionUploadNow` を**一度も呼んでいなかった** → by_mode の aix が永遠に0。
//   B. **押したら何が開くかを学んでいなかった**（名前・種類・段階だけ）。
//      自動は「このボタンは小窓を開く」が分からず、開いた前提で次を探して空振り。
//   C. **AIXLINX 自身の小窓を押した記録が学習に混ざっていた**
//      （実測: `左のAIXLINX｜div`・`#axlx-bar`・`#aixlinx-mini-btn`）。
//
// 実行: node tests/chrome-extension/learn-opens-and-auto.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const hl = read("human-learn.js");
const rec = read("human-learn-record.js");
const up = read("human-learn-upload.js");
const ps = read("page-script.js");
const bg = read("background.js");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 自動（AIX）の記録が DB に届く（③の核心）");
{
  t("自動の集計を送る口を呼んでいる", /_U\(\{[\s\S]{0,700}mode: "aix"/.test(rec));
  t("  人の記録とは別枠（mode を付ける）", /_U\(\{[\s\S]{0,600}\}, \{ mode: "aix", site: site \}\)/.test(rec));
  t("  送る物に欄・種類・位置・間隔が入る", /n: adds\.n, kinds: adds\.kinds/.test(rec));
  t("  ⚠ 中身（入力値）は送らない（keys に value が無い）", !/value:/.test(rec.slice(rec.indexOf("function flushAuto"), rec.indexOf("function flushAuto") + 2500)));
  t("送る係が mode を受ける", /function \(agg, opts\)/.test(up));
  t("  自動は5分の間隔で止めない", /if \(mode\) \{[\s\S]{0,120}upload\(agg, \{ site: o2\.site \|\| agg\.site, mode: mode \}\);[\s\S]{0,40}return;/.test(up));
  t("  ⚠ 人の記録の5分の間隔は残す", /if \(last && Date\.now\(\) - last < MIN_GAP_MS\)/.test(up));
}

console.log("\n■ ② 「どこで展開されるか」を学ぶ（②の核心）");
{
  t("uiCounts（小窓・選択肢・欄・結果の数）がある", /function uiCounts\(\)/.test(hl));
  t("  押す直前の数を控える（noteBeforeClick）", /function noteBeforeClick\(el\)/.test(hl));
  t("  押した後に何が増えたか見る（noteOpened）", /function noteOpened\(el\)/.test(hl));
  t("  小窓が開いた＝modal", /if \(a\.modal > b\.modal\) what = "modal"/.test(hl));
  t("  プルダウンの一覧＝options", /a\.options > b\.options \+ 2/.test(hl));
  t("  結果の一覧＝result", /a\.result > b\.result\) what = "result"/.test(hl));
  t("  小窓が閉じた＝modal_close", /a\.modal < b\.modal\) what = "modal_close"/.test(hl));
  t("  click の時に控えて、後で見る", /if \(type === "click"\) \{ try \{ noteBeforeClick\(e\.target\)/.test(hl));
  t("  サイトが描くのを待ってから見る（520ms〜）", /setTimeout\(function \(\) \{ try \{ noteOpened\(_tgt\)/.test(hl));
  t("detail() が opens を返す", /detail: detail/.test(hl) && /opens: opens\.slice\(\)/.test(hl));
  t("summarizeMotion が opens をまとめる", /opens: _opensOf\(d\.opens\)/.test(hl));
  t("  欄ごとに一番多い開き方を残す", /out\[f\] = \{ opens: best, n: v\.n, stage: v\.stage, all: v\.opens \}/.test(hl));
  t("reset で opens も消える", /moves = \[\]; points = \[\]; scrolls = \[\]; opens = \[\];/.test(hl));
}

console.log("\n■ ③ 学んだ開き方が自動検索に届く");
{
  t("記録側が opens / open_kinds を送る", /add\.opens = \(motion\.opens && motion\.opens\.byField\)/.test(rec));
  t("background が axlx_learn_opens を置く", /axlx_learn_opens: opens/.test(bg));
  t("background が bundle.opens を読む", /var opens = \(bundle\.opens/.test(bg));
  t("page-script が axlx_learn_opens を読む", /chrome\.storage\.local\.get\(\["axlx_learn_opens"\]/.test(ps));
  t("  要素から開き方を引く（_opensOfEl）", /function _opensOfEl\(el, keys\)/.test(ps));
  t("  押す時に開き方を点検に残す", /開き方=' \+ opensKind/.test(ps));
}

console.log("\n■ ④ AIXLINX 自身の小窓を学習から除く（学習を濁らせない）");
{
  t("自分の UI を弾く（#axlx- / [data-axlx] / #aixlinx-）", /closest\('#axlx-bar, #axlx-learn-badge, #aixlinx-mini-btn, #axlx-guide, \[data-axlx\]/.test(hl));
  t("  文字でも弾く（id が axlx/aixlinx で始まる）", /indexOf\("axlx"\) === 0/.test(hl));
  t("  ⚠ 弾くのは guarded（記録の入口）", /var guarded = function \(type\)[\s\S]{0,900}#axlx-bar/.test(hl));
}

console.log("\n■ ⑤ サーバー側が opens を受けて束に載せる");
{
  const route = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8");
  const mig = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "migrate-schema", "route.ts"), "utf8");
  const brain = fs.readFileSync(path.join(__dirname, "..", "..", "app", "lib", "human-learn-brain.ts"), "utf8");
  t("受け口が opens を通す", /opens: \(\(\) => \{/.test(route));
  t("  開き方の種類を検査する（知らない値は捨てる）", /\^\(modal\|options\|form\|result\|modal_close\|none\)\$/.test(route));
  t("  中身は入れない（種類と数だけ）", /opens: kind,/.test(route));
  t("migrate-schema が列を足す", /ADD COLUMN IF NOT EXISTS opens JSONB/.test(mig) && /ADD COLUMN IF NOT EXISTS open_kinds JSONB/.test(mig));
  t("学習の束が opens を返す", /\.\.\.\(Object\.keys\(opens\)\.length \? \{ opens \} : \{\}\)/.test(brain));
  t("  learnOpens が欄ごとにまとめる", /export function learnOpens/.test(brain));
  t("  入れ物の名前は学ばない", /if \(!isLearnableName\(name\)\) continue;[\s\S]{0,200}opens/.test(brain) || /learnOpens[\s\S]{0,600}isLearnableName/.test(brain));
}

console.log("\n■ ⑥ 実際に動かす（純関数・本番DBに近い形）");
{
  // _opensOf を単体で動かす
  const a = hl.indexOf("function _opensOf(list)");
  const b = hl.indexOf("function summarizeMotion(detail)");
  const sandbox = { Object, String, Number, Math, Array };
  vm.createContext(sandbox);
  vm.runInContext(hl.slice(a, b) + "\nthis.__opensOf = _opensOf;", sandbox);
  const opensOf = sandbox.__opensOf;

  const r1 = opensOf([
    { f: "左の所在地絞り込み＋｜span", o: "modal", s: "form", n: 1 },
    { f: "左の所在地絞り込み＋｜span", o: "modal", s: "form", n: 2 },
    { f: "rental_cost2", o: "options", s: "form", n: 1 },
    { f: "左の検索｜span", o: "result", s: "form", n: 1 },
    { f: "確定してリストへ｜span", o: "modal_close", s: "modal", n: 1 },
  ]);
  t("小窓を開くボタン＝modal", r1.byField["左の所在地絞り込み＋｜span"].opens === "modal", r1.byField["左の所在地絞り込み＋｜span"]);
  t("プルダウン＝options", r1.byField["rental_cost2"].opens === "options");
  t("検索＝result", r1.byField["左の検索｜span"].opens === "result");
  t("確定＝modal_close", r1.byField["確定してリストへ｜span"].opens === "modal_close");
  t("全体の内訳が数えられる", r1.kinds.modal === 2 && r1.kinds.options === 1, r1.kinds);
  t("  件数が出る", r1.n === 5, r1.n);
  t("空でも落ちない", opensOf([]).n === 0 && Object.keys(opensOf([]).byField).length === 0);
  t("null でも落ちない", opensOf(null).n === 0);
  t("欄の名前が空なら捨てる", opensOf([{ f: "", o: "modal", n: 1 }]).n === 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
