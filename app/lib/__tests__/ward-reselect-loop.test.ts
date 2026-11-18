// app/lib/__tests__/ward-reselect-loop.test.ts
// 2026-11-18 平田さん自動（run_mwlrwjhx_xoqv・2.8.101・9区指定）:
//   「ずっと同じ淀川区をおしてはずしてをくりかえしていた」
//
// 実測（human_motion_learn の操作・写真）:
//   選ぶ:ward 27123 → 選ぶ済 → 5〜8秒後 外す:ward 27123 → 区を選ぶ → 選ぶ … を約20往復。
//   淀川区以外の8区は一度も押されていない。
//
// 原因:
//   verify（_verifyThenConfirm）は `__axlxWardCodes` を「足りない区だけ」に一時差し替えて
//   clickWardPrecise を呼ぶ。clickWardPrecise の「余計な区を外す」判定がその差し替え後の
//   一覧で見ていたため、選んだ直後の淀川区（足りない一覧から消える）が「余計」扱いで外された。
//
// 直し:
//   ① 余計の判定は差し替えない控え `__axlxWardWantAll`（お客様の欲しい区の全部）で見る
//   ② 余計な区を外すのは押す瞬間に checked を見る `_toggleCheckboxLikeHuman` だけ（盲目トグル禁止）
//   ③ 同じ区を3回選び直したら `ward_reselect_loop` を監査に残す
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/ward-reselect-loop.test.ts
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const src = fs.readFileSync(path.join(root, "chrome-extension", "page-script.js"), "utf8");

console.log("■ 余計な区の判定は欲しい区の全部で見る");
const cwp = src.slice(src.indexOf("function clickWardPrecise("), src.indexOf("function clickWardPrecise(") + 6000);
ok("clickWardPrecise の余計判定が __axlxWardWantAll を使う", /wantAll\s*=\s*\(window\.__axlxWardWantAll/.test(cwp));
ok("wantSet は wantAll から作る", /for \(var wi = 0; wi < wantAll\.length; wi\+\+\) wantSet\[String\(wantAll\[wi\]\)\]/.test(cwp));
ok("同じ区の選び直しを監査に残す", /ward_reselect_loop/.test(cwp));

const wantAllAssign = src.match(/window\.__axlxWardWantAll\s*=\s*[^;=]+;/g) || [];
ok("__axlxWardWantAll は cond.city_codes の控えだけ（verify で差し替えない）",
  wantAllAssign.every((s) => /__axlxWardCodes\.slice\(\)|null/.test(s)), wantAllAssign);

console.log("■ 余計な区は押す瞬間に checked を見て外す");
ok("city_code の stale を simulateClick で盲目トグルしない",
  !/city_code\[\]"\]\[value="'\s*\+\s*String\(code\)\s*\+\s*'"\]'\);[\s\S]{0,400}?enqueueHumanClick\(lbl, function \(el\) \{ (try \{ )?simulateClick\(el\)/.test(src));

console.log("■ 人が引き取ったら自動は手を引く（1486: 人の入力中も裏で淀川区を外し続けた）");
ok("人の操作（isTrusted）で止める仕組みがある", /function _onHumanTakeover\(e\)[\s\S]{0,200}?e\.isTrusted/.test(src));
// 2026-11-18 2.8.106: 自動のクリックで出る change も isTrusted=true（1488 で都島区の後に誤って止まった）→ pointerdown / keydown だけ
ok("pointerdown と keydown を捕まえる（click/change は見ない）", /addEventListener\("pointerdown", _onHumanTakeover, true\)/.test(src) && /addEventListener\("keydown", _onHumanTakeover, true\)/.test(src) && !/addEventListener\("change", _onHumanTakeover/.test(src));
ok("拡張の小窓・カーソルは数えない", /\[id\^="aixlinx-"\], \[id\^="axlx"\], \[data-axlx-shape\]/.test(src));
ok("止めた時は gate（全ページ自動送信を構えない）", /notifyDone\("human_takeover:[^;]+, "human_takeover"\)/.test(src));
ok("enqueueHumanClick が引き取り後は積まない", /function enqueueHumanClick\([^)]*\) \{\s*if \(!el \|\| el\.__axPending\) return false;\s*if \(_axHumanTookOver\) return false;/.test(src));
ok("whenClickQueueIdle が引き取り後は回らない", /function whenClickQueueIdle\(cb\) \{\s*if \(_axHumanTookOver\) return;/.test(src));
ok("waitForClick が引き取り後は回らない", /function attempt\(\) \{\s*if \(_axHumanTookOver\) return;/.test(src));
ok("fill 開始で引き取り印を戻す", /_axHumanTookOver = false;\s*_axFillStartedAt = Date\.now\(\);[\s\S]{0,120}window\._axFillRunning = true;/.test(src));

console.log("■ 区は画面の並び順に1つずつ（人の通常録画と同じ）");
ok("codes を画面の並び順に並べ替える", /codes = codes\.slice\(\)\.sort\(function \(a, b\) \{\s*var ia = _domOrder/.test(cwp + src.slice(src.indexOf("function clickWardPrecise("), src.indexOf("function clickWardPrecise(") + 9000)));

console.log("■ 動きの模型（旧の判定は往復・新の判定は9区そろう）");
function simulate(useWantAll: boolean) {
  const want = ["27123", "27106", "27127", "27103", "27102", "27128", "27111", "27109", "27113"];
  const checked = new Set<string>();
  const selN: Record<string, number> = {};
  for (let round = 0; round < 60; round++) {
    const missing = want.filter((c) => !checked.has(c));
    if (missing.length === 0) return { done: true, round, selN };
    const codes = missing;
    const wantSet = new Set(useWantAll ? want : codes);
    const extra = [...checked].find((c) => !wantSet.has(c));
    if (extra) { checked.delete(extra); continue; }
    const target = codes.find((c) => !checked.has(c))!;
    selN[target] = (selN[target] || 0) + 1;
    checked.add(target);
  }
  return { done: false, round: 60, selN };
}
const oldR = simulate(false);
const newR = simulate(true);
ok("旧の判定は淀川区(27123)の往復で終わらない", !oldR.done && (oldR.selN["27123"] || 0) >= 10, oldR);
ok("新の判定は9区が1回ずつでそろう", newR.done && Object.values(newR.selN).every((n) => n === 1) && Object.keys(newR.selN).length === 9, newR);

console.log(`\n${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
