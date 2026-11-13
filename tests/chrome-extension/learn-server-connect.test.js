// 学習の連携: サーバーで学んだ事が**現場で使われるか**の試験（2026-11-13）
//
// 竹内さん「ほかにちゃんと学習の面とかで連携できていない部分などあるか」で見つけた穴:
//   ① サーバーは motion（速さ・曲がり）・gaps（操作の間）・weak（次に学ぶ事）・site_flow まで
//      計算して返しているのに、background が **next と points だけ**を storage に置いて捨てていた
//   ② 拡張が `touch=0` で読んでいたので、`read_count` / `read_at` が**一度も記録されていなかった**
//      （＝どの PC が読んでいるか分からない・サーバー側で「読まれたか」を見られない）
//   ③ `moveMsFor` が**ローカルの癖だけ**を見ていた（他の PC の実測・写真から学んだ分が届かない）
//
// 実行: node tests/chrome-extension/learn-server-connect.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① background が next/points 以外も置く（捨てない）");
{
  const s = read("background.js");
  t("axlx_learn_motion を置く", s.includes("axlx_learn_motion"));
  t("axlx_learn_gaps を置く", s.includes("axlx_learn_gaps"));
  t("axlx_learn_weak を置く", s.includes("axlx_learn_weak"));
  t("axlx_learn_site_flow を置く", s.includes("axlx_learn_site_flow"));
  t("bundle.motion を読む", /bundle\.motion/.test(s));
  t("bundle.gaps を読む", /bundle\.gaps/.test(s));
  t("bundle.weak を読む", /bundle\.weak/.test(s));
  t("bundle.site_flow を読む", /bundle\.site_flow/.test(s));
}

console.log("■ ② 読んだ印（read_count）が残る＝touch=1 で読む");
{
  const s = read("background.js");
  const line = s.split("\n").find((l) => l.includes("/api/human-learn-profile")) || "";
  t("touch=0 を付けていない", !/human-learn-profile\?touch=0/.test(s), line.trim());
  t("読んだ印のため touch=1（既定）で読む", line.includes("/api/human-learn-profile"));
  // サーバー側: touch が true の時だけ read_count を増やす
  const route = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-learn-profile", "route.ts"), "utf8");
  t("サーバーは touch で read_count を増やす", /read_count:\s*\(Number\(row\.read_count\)/.test(route));
  t("touch=0 なら増やさない", /get\("touch"\)\s*!==\s*"0"/.test(route));
}

console.log("■ ③ サーバーの motion を先に見る（無ければ今まで通り）");
{
  const L = read("human-learn.js");
  t("_serverMotion がある", L.includes("_serverMotion"));
  t("axlx_learn_motion を読む", L.includes('"axlx_learn_motion"'));
  t("serverCurve を出す", L.includes("serverCurve: serverCurve"));
  t("serverGapMs を出す", L.includes("serverGapMs: serverGapMs"));
  t("moveMsFor がサーバーの速さを先に見る", /srvSpeed[\s\S]{0,300}dist \/ srvSpeed/.test(L));
}

console.log("■ ④ moveMsFor の丸め（極端な値で飛ばない・止まらない）");
{
  // human-learn.js を sandbox で動かして moveMsFor を直接試す
  const sandbox = { console, Date, Math, JSON, Object, Number, Array, String, setTimeout, clearTimeout };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("human-learn.js"), sandbox);
  const L = sandbox.AxlxHumanLearn;
  t("AxlxHumanLearn が読めた", !!L);

  // サーバーの motion が無い時＝手元の癖
  const p = { speed_px_s: 500 };
  t("500px/秒 で 500px ＝ 1000ms", L.moveMsFor(p, 500) === 1000, L.moveMsFor(p, 500));
  t("距離0 は null", L.moveMsFor(p, 0) === null);
  t("癖が無ければ null", L.moveMsFor(null, 500) === null);
  // 速さ0・負は使わない
  t("速さ0 は null", L.moveMsFor({ speed_px_s: 0 }, 500) === null);
  t("速さ 100000px/秒 でも 120ms 未満にしない", L.moveMsFor({ speed_px_s: 100000 }, 500) === 120, L.moveMsFor({ speed_px_s: 100000 }, 500));
  t("速さ 1px/秒 でも 1600ms を超えない", L.moveMsFor({ speed_px_s: 1 }, 500) === 1600, L.moveMsFor({ speed_px_s: 1 }, 500));
}

console.log("■ ⑤ pointer-ui がサーバーの曲がりも使う");
{
  const P = read("pointer-ui.js");
  t("serverCurve を呼ぶ", P.includes("serverCurve"));
  t("無ければ手元の癖に戻る", /_curve == null[\s\S]{0,80}prof\.curve/.test(P));
}

console.log("■ ⑥ 写真から学ぶ処理を誰かが呼ぶ（40件の弱い所が埋まる道）");
{
  const cron = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "cron", "human-learn-brain", "route.ts"), "utf8");
  t("cron が shot_learn を埋める", /shot_learn:\s*out/.test(cron));
  t("決定論だけ（LLM を cron から呼ばない）", !/anthropic\.com|SHOT_LEARN_PROMPT/.test(cron));
  t("件数を返す（何件埋めたか分かる）", cron.includes("shot_learned"));
  t("shot_learn 列が無い DB でも止まらない", /shot_learn\|does not exist\|schema cache/.test(cron));
}

console.log("■ ⑦ cron も『決め打ちで外す』をやめた");
{
  const cron = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "cron", "human-learn-brain", "route.ts"), "utf8");
  t("selectDroppingMissing を使う", cron.includes("selectDroppingMissing"));
  t("shot_ops を決め打ちで外していない", !/replace\(", shot_ops", ""\)/.test(cron));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
