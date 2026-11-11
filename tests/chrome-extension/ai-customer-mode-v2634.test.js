// 実行: node tests/chrome-extension/ai-customer-mode-v2634.test.js
// 2026-11-11 竹内さん「4つ目にAIXをつけて、AIXの場合選択したお客さんが自動検索できるようにする。
//   もともとあったの。新着で条件きたりしたらそれもAIXで対応できる形とする」
//
// 固定する形:
//   ① モードは4つ: 通常／スタッフ／自動（aix）／AIX（ai）
//   ② AIX は「選んだお客さんを自動で検索」する（aiCustomerSearch）
//   ③ AIX は AIXツールの指示・新着（aix・web_brain）・自動便も受け取る（もともとあった動き）
//   ④ popup はお客さんを選び、条件の読み直しが終わってから検索ボタンを押す（古い条件で押さない）
//   ⑤ 同じお客様×サイトを続けて押さない（10分）・別のお客様に切り替わったら押さない
//   ⑥ 自動モード（aix）は今まで通り「一覧の行を1件ずつ押す」で、AIX とは別物
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
const M = require(path.join(dir, "mode-core.js"));

let pass = 0, fail = 0;
function eq(name, a, b) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok ? "" : `\n      got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)); }
function ok(name, c, extra) { if (c) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 300) : "")); } }

console.log("■ ① モードは4つ");
eq("MODES", M.MODES, ["normal", "staff", "aix", "ai"]);
eq("表示名", [M.modeLabel("normal"), M.modeLabel("staff"), M.modeLabel("aix"), M.modeLabel("ai")], ["通常", "スタッフ", "自動", "AIX"]);
{
  const html = read("popup.html");
  ok("popup.html に4つ目の選択肢（AIX）", /<option value="ai">/.test(html) && /AIX（選んだお客さん）/.test(html));
  const opts = (html.match(/<option value="(normal|staff|aix|ai)"/g) || []).length;
  eq("選択肢の数", opts, 4);
}

console.log("\n■ ② AIX は選んだお客さんの自動検索を開く");
eq("AIX の aiCustomerSearch", M.behavior("ai", false).aiCustomerSearch, true);
eq("AIX × ブレイン", M.behavior("ai", true).aiCustomerSearch, true);
eq("自動（aix）は開かない", M.behavior("aix", false).aiCustomerSearch, false);
eq("通常・スタッフは開かない", [M.behavior("normal", false).aiCustomerSearch, M.behavior("staff", false).aiCustomerSearch], [false, false]);
eq("実効（GUIDE_ONLY 中）でも AIX は開く", M.effectiveBehavior("ai", false).aiCustomerSearch, true);
eq("実効で 通常は閉じる", M.effectiveBehavior("normal", true).aiCustomerSearch, false);
eq("実効で スタッフは閉じる", M.effectiveBehavior("staff", true).aiCustomerSearch, false);

console.log("\n■ ③ AIX は AIXツールの指示・新着・自動便も受け取る（もともとあった動き）");
eq("claimAix（aix 由来の指示）", M.behavior("ai", false).claimAix, true);
eq("runAutoSchedule（11:00/17:00 の自動便）", M.behavior("ai", false).runAutoSchedule, true);
eq("claimCommands（一括検索）", M.behavior("ai", false).claimCommands, true);
eq("claimBrainCommands（web_brain・新着の条件）", M.behavior("ai", true).claimBrainCommands, true);
eq("ブレイン OFF では web_brain を受け取らない（判定する PC だけ）", M.behavior("ai", false).claimBrainCommands, false);
eq("判定はブレインの時だけ", [M.behavior("ai", true).brainJudge, M.behavior("ai", false).brainJudge], [true, false]);

console.log("\n■ ④ popup は条件の読み直しが終わってから押す");
{
  const pj = read("popup.js");
  ok("AIXモードの印を持つ（_aiCustomerModeOn）", /var _aiCustomerModeOn = false;/.test(pj) && /_aiCustomerModeOn = s\.mode === "ai";/.test(pj));
  ok("お客さん選択時の自動検索の関数", /function _maybeAiCustomerAutoSearch\(btn, customer, site\)/.test(pj));
  ok("条件の読み直し（fetchFreshCustomer）が終わってから呼ぶ", /_freshPreloadPromise = fetchFreshCustomer\(c0\?\.id\)\.then\(fresh => \{[\s\S]{0,900}_maybeAiCustomerAutoSearch\(autofillBtn, c0, "realpro"\)/.test(pj));
  ok("itandi でも同じ（読み直しの後）", /setupAreaModeSelector\(selectedCustomer, "itandi"\);[\s\S]{0,400}_maybeAiCustomerAutoSearch\(_itBtn, selectedCustomer, "itandi"\)/.test(pj));
  ok("人が押すのと同じ道（btn.click）", /btn\.click\(\);/.test(pj));
}

console.log("\n■ ⑤ 詰まらない決まり");
{
  const pj = read("popup.js");
  ok("同じお客様×サイトを続けて押さない（10分）", /AIX_RESEARCH_GAP_MS = 10 \* 60 \* 1000/.test(pj) && /同じお客様を続けて検索しない/.test(pj));
  ok("別のお客様に切り替わったら押さない", /String\(selectedCustomer\.id\) !== String\(customer\.id\)\) return;/.test(pj));
  ok("モードが変わったら押さない", /if \(!_aiCustomerModeOn\) return;/.test(pj));
  ok("スタッフモードでは押さない", /if \(!_aiCustomerModeOn \|\| _staffModeOn\) return false;/.test(pj));
  ok("自動の一括の回はそちらに任せる（二重に押さない）", /if \(btn\.dataset\.automated\) return false;/.test(pj));
  ok("押した時刻を記録する（_aiAutoSearchMemo）", /_aiAutoSearchMemo\[key\] = now;/.test(pj));
  ok("人の間（0.9〜4秒）を置いてから押す", /logNormalDelay\(1500, 0\.35\)/.test(pj));
}

console.log("\n■ ⑥ 自動（aix）は一覧の行を1件ずつ押す（AIX とは別物）");
{
  const bd = read("bulk-dl.js");
  ok("自動モードの時だけ一覧を押す（_autoModeOn）", /function autoPressPdfs\(\)[\s\S]{0,400}if \(!_autoModeOn\)/.test(bd));
  ok("自動モードの判定は aixMode＋autoModeAt", /return !staffOn && !!s\.aixMode && Number\(s\.autoModeAt\) > 0;/.test(bd));
}

console.log("\n■ 一括検索の帯（もともとのAIX）は自動・AIXモードの時だけ出る");
{
  const html = read("popup.html"), css = read("styles.css"), pj = read("popup.js"), bg = read("background.js");
  ok("帯のクラスは aklx-auto-only", /id="bulk-toolbar" class="axlx-auto-only"/.test(html));
  ok("CSS: 自動・AIXモード以外は隠す", /body:not\(\.mode-aix\):not\(\.mode-ai\) \.axlx-auto-only \{ display: none !important; \}/.test(css));
  ok("popup: モードを body のクラスに写す", /classList\.remove\("mode-normal", "mode-staff", "mode-aix", "mode-ai"\)/.test(pj) && /classList\.add\("mode-" \+ s\.mode\)/.test(pj));
  ok("background: AIX（ai）も自動の道を開く（一括検索の関所を通す）", /core\.AI_MODE && _m === core\.AI_MODE/.test(bg));
  ok("background: aiMode の変化でも読み直す", /ch\.staffModeAt \|\| ch\.aiMode\) _refreshAutoModeChosen/.test(bg));
  ok("3サイトのボタンがある（リアプロ・itandi・レインズ）", /data-bulk-site="realnetpro"/.test(html) && /data-bulk-site="itandi"/.test(html) && /data-bulk-site="reins"/.test(html));
  ok("ピンポイント／広げての2択がある", /data-bulk-mode="pinpoint"/.test(html) && /data-bulk-mode="wide"/.test(html));
  ok("チェックボックスも自動・AIXモードの時だけ出す", /body:not\(\.mode-aix\):not\(\.mode-ai\) \.bulk-check-wrap \{ display: none !important; \}/.test(css));
  ok("一括検索は次のお客様まで人の間を置く（連続で開かない）", /次のお客様まで .*秒（人の間）/.test(bg) && /_bulkGapMs = function \(\)/.test(bg));
  ok("間の長さの決まりは auto-run.js の1か所（bulkCustomerGapMs）", /bulkCustomerGapMs: bulkCustomerGapMs/.test(read("auto-run.js")) && /self\.AxlxAutoRun\.bulkCustomerGapMs/.test(bg));
  ok("見る間の長さの決まりも1か所（lookAtDocMs）", /lookAtDocMs: lookAtDocMs/.test(read("auto-run.js")) && /self\.AxlxAutoRun\.lookAtDocMs/.test(bg));
  ok("間の途中でストップ要求が来たら止まる", /if \(_batchShouldStop\) \{ console\.log\("\[manual-bulk-search\] ストップ要求（間の間） → 中断"\); break; \}/.test(bg));
  // 2026-11-11 竹内さん「（資料を見る間も）いれる」: 自動モードと同じ 👀 資料を見る間を一括検索にも入れる
  ok("一括検索も送った後に資料を見る間を置く（自動モードと同じ）", /👀 資料を見る間/.test(bg) && /lookAtDocMs/.test(bg));
  ok("見る間の範囲（1.8〜13秒）は呼ぶ側でも守る", /if \(_lookMs < 1800\) _lookMs = 1800;/.test(bg) && /if \(_lookMs > 13000\) _lookMs = 13000;/.test(bg));
  ok("見る間の途中でもストップできる", /ストップ要求（資料を見る間） → 中断/.test(bg));
}

console.log("\n■ ランダム性（同じ間隔が続かない・一様乱数を使わない）");
{
  const A = require(path.join(dir, "auto-run.js"));
  const gaps = Array.from({ length: 300 }, () => A.bulkCustomerGapMs());
  const looks = Array.from({ length: 300 }, () => A.lookAtDocMs());
  const uniq = (xs) => new Set(xs).size;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs) => Math.sqrt(xs.reduce((a, b) => a + (b - mean(xs)) ** 2, 0) / (xs.length - 1));
  ok("次のお客様までの間: 種類が多い（300回で150以上）", uniq(gaps) > 150, { uniq: uniq(gaps) });
  ok("次のお客様までの間: ばらつく（CV > 0.4）", sd(gaps) / mean(gaps) > 0.4, { cv: (sd(gaps) / mean(gaps)).toFixed(2) });
  ok("次のお客様までの間: 8秒を下回らない", Math.min(...gaps) >= 8000, { min: Math.min(...gaps) });
  ok("次のお客様までの間: 250秒を超えない", Math.max(...gaps) <= 200000, { max: Math.max(...gaps) });
  ok("資料を見る間: 1.8〜13秒に収まる", Math.min(...looks) >= 1800 && Math.max(...looks) <= 13000, { min: Math.min(...looks), max: Math.max(...looks) });
  ok("資料を見る間: 毎回ちがう（300回で100種類以上）", uniq(looks) > 100, { uniq: uniq(looks) });
  ok("資料を見る間: 中央値が3〜7秒あたり", (() => { const s = [...looks].sort((a, b) => a - b); const med = s[Math.floor(s.length / 2)]; return med >= 3000 && med <= 7000; })());
  // 一定の間隔が続かない（同じ値が3回続いたら機械的）
  let run = 1, maxRun = 1;
  for (let i = 1; i < gaps.length; i++) { if (gaps[i] === gaps[i - 1]) { run++; maxRun = Math.max(maxRun, run); } else run = 1; }
  ok("同じ間隔が3回続かない（多少の重なりは許す）", maxRun <= 3, { maxRun });
}

console.log("\n■ マウス・クリックの間隔が不規則か（実測）");
{
  const fs2 = require("fs");
  const H = require(path.join(dir, "human-wait.js"));
  const P = require(path.join(dir, "page-script.js") === "" ? "x" : path.join(dir, "human-wait.js"));
  const stat = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    let run = 1, mx = 1;
    for (let i = 1; i < xs.length; i++) { if (xs[i] === xs[i - 1]) { run++; mx = Math.max(mx, run); } else run = 1; }
    return { uniq: new Set(xs).size, min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1], cv: sd / m, run: mx };
  };
  // マウスの1点ごとの待ち（同じ速度で動かない）
  const w = [], w2 = [];
  for (let i = 0; i < 40; i++) { w.push(...H.pointerDelays(24, 600)); w2.push(...H.pointerDelays(28, 900)); }
  const sw = stat(w);
  ok("マウス: 1点ごとの待ちがほぼ毎回ちがう（24点で22種類以上）", (() => { const a = H.pointerDelays(24, 600); return new Set(a).size >= 22; })());
  ok("マウス: ばらつく（CV > 0.4）", sw.cv > 0.4, { cv: sw.cv.toFixed(2) });
  ok("マウス: 加速・減速がある（最初と最後が中ほどより遅い）", (() => { const a = H.pointerDelays(24, 600); return a[0] + a[1] > a[11] + a[12]; })());
  // 軌跡がまっすぐでない
  const path1 = H.pointerPath({ x: 0, y: 0 }, { x: 800, y: 0 }, 20);
  ok("マウス: 軌跡がまっすぐでない（曲がる）", path1.some((p) => Math.abs(p.y) > 3));
  // page-script の humanRand（クリックの列の間）
  const src = fs2.readFileSync(path.join(dir, "page-script.js"), "utf8");
  const st = src.indexOf("function humanRand("), en = src.indexOf("// 2026-09-27 竹内", st);
  const vm = require("vm");
  const ctx = { window: { AxlxHumanWait: H }, Math, isFinite, Number };
  vm.createContext(ctx);
  vm.runInContext(src.slice(st, en), ctx);
  const clicks = [], stations = [];
  for (let i = 0; i < 400; i++) { clicks.push(ctx.humanRand(80, 200)); stations.push(ctx.humanRand(420, 1100)); }
  const sc = stat(clicks);
  ok("クリック間: 8割以上が違う値（同じ値が並ばない）", sc.uniq > 320, { uniq: sc.uniq });
  ok("クリック間: 同じ値が3回続かない", sc.run < 3, { run: sc.run });
  ok("クリック間: 80ms を下回らない", sc.min >= 44, { min: sc.min }); // lo*0.55
  ok("クリック間: ばらつく（CV > 0.3）", sc.cv > 0.3, { cv: sc.cv.toFixed(2) });
  const ss = stat(stations);
  ok("駅の間: 同じ値が3回続かない", ss.run < 3, { run: ss.run });
  ok("駅の間: ばらつく（CV > 0.3）", ss.cv > 0.3, { cv: ss.cv.toFixed(2) });
  // 打鍵（165ms）が 200ms に張り付かない（下限の修正）
  const keys = Array.from({ length: 400 }, () => H.logNormalDelay(165, 0.32));
  const sk = stat(keys);
  ok("打鍵: 200ms に張り付かない（種類が多い）", sk.uniq > 300, { uniq: sk.uniq, min: sk.min, max: sk.max });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
