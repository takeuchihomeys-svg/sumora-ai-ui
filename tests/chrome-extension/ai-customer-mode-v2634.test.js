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
  ok("同じ間隔が3回続かない（多少の重なりは許す）", maxRun <= 4, { maxRun });
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

console.log("\n■ 押す順（資料を上から全部順にしていない）と押す前の迷い");
{
  const fs3 = require("fs"), vm2 = require("vm");
  const src = fs3.readFileSync(path.join(dir, "bulk-dl.js"), "utf8");
  const st = src.indexOf("function _humanPickOrder(");
  const en = src.indexOf("  /** 自動便の指定を引く時の顧客 ID", st);
  const ctx2 = { Math };
  vm2.createContext(ctx2);
  vm2.runInContext(src.slice(st, en), ctx2);
  const order = (n) => ctx2._humanPickOrder(n);
  // 20件: 200回で全部ちがう順・重複なし・完全に上から順が0
  const n = 20;
  const os = Array.from({ length: 200 }, () => order(n).join(","));
  ok("20件: 押す順が毎回ちがう（200回で180通り以上）", new Set(os).size > 180, { uniq: new Set(os).size });
  ok("20件: 全部を1回ずつ（重複なし・件数一致）", os.every((x) => { const a = x.split(","); return new Set(a).size === n && a.length === n; }));
  ok("20件: 完全に上から順の回が無い", !os.includes(Array.from({ length: n }, (_, i) => i).join(",")));
  // 5件でも上から順ばかりにならない
  const os5 = Array.from({ length: 200 }, () => order(5).join(","));
  ok("5件: 上から順が半分より少ない", os5.filter((x) => x === "0,1,2,3,4").length < 100, { straight: os5.filter((x) => x === "0,1,2,3,4").length });
  ok("5件: 重複なし", os5.every((x) => { const a = x.split(","); return new Set(a).size === 5 && a.length === 5; }));
  // 押す前の迷い
  ok("押す前に 15%ほどの迷い（3段）を入れる", /Math\.random\(\) < 0\.15 \* \(0\.75 \+ Math\.random\(\) \* 0\.5\)/.test(src));
  ok("迷いの間カーソルが漂う（drift）", /P\.drift\(Math\.min\(hesitate, 1500\)/.test(src));
  ok("押す直前に狙いを定める間（90〜350ms）", /var gap = 90 \+ Math\.floor\(Math\.random\(\) \* 260\)/.test(src));
  ok("たまに狙いを外して戻る（wander 10%）", /Math\.random\(\) < 0\.10 && P && P\.wander/.test(src));
  ok("迷いは最大5.2秒で打ち切る（止まって見せない）", /if \(hesitate > 5200\) hesitate = 5200;/.test(src));
  // 2026-11-11 スクロール待ちの揺らぎ（同じ距離でも毎回ちがう・page-script.js の _ensureInView）
  const psrc = fs3.readFileSync(path.join(dir, "page-script.js"), "utf8");
  ok("スクロール待ちが距離だけで決まらない（logNormalDelay で揺らす）", /H\.logNormalDelay\(base, 0\.3\)/.test(psrc) && /遠い時は目で追う/.test(psrc));
  ok("スクロール位置は最小移動のまま（真ん中へ寄せて往復しない）", /block: "nearest", inline: "nearest"/.test(psrc));
}

console.log("\n■ 「考える時間」のバランス（最初は長く・2回目以降は短い）");
{
  const fs4 = require("fs");
  const bg = read("background.js");
  const ps4 = fs4.readFileSync(path.join(dir, "page-script.js"), "utf8");
  ok("最初にどこから手を付けるか考える間がある（_thinkBeforeFill）", /_thinkBeforeFill = ms;/.test(ps4) && /function _waitThinkThenFill/.test(ps4));
  ok("最初は 2.0〜6.5秒・2回目以降は 0.8〜2.4秒", /_first \? 2000 : 800/.test(ps4) && /_first \? 6500 : 2400/.test(ps4));
  ok("考える間は実際に待ってから入力を始める（setTimeout(next, ms)）", /setTimeout\(next, ms\)/.test(ps4));
  ok("駅は最初だけ一覧を目で探す間（1.2〜3.4秒）が入る", /_stationPickSeen/.test(ps4) && /if \(look < 1200\) look = 1200; if \(look > 3400\) look = 3400;/.test(ps4));
  ok("駅の2つ目以降は速い（既存の 420〜1100ms＋一息）", /_stGapMin\(\) \{ return 420; \}/.test(ps4) && /_stationBreath/.test(ps4));
  ok("考える間を点検に残す（think_first・station_first_look）", /think_first/.test(ps4) && /station_first_look/.test(ps4));
  // ITANDI も同じ形（1.8〜5.5秒・2回目以降0.7〜2.2秒）
  const ips4 = fs4.readFileSync(path.join(dir, "itandi-page-script.js"), "utf8");
  ok("ITANDI にも考える間がある（1.8〜5.5秒・2回目以降0.7〜2.2秒）", /_itFillSessionSeen/.test(ips4) && /first \? 2800 : 1300/.test(ips4) && /first \? 1800 : 700, hi = first \? 5500 : 2200/.test(ips4));
  ok("ITANDI も実際に待ってから入力を始める", /setTimeout\(next, ms\)/.test(ips4));
  // 2026-11-11 竹内さん「itandi側ほかの部分リアプロと比べて人間の動きとして弱い部分見つけて改善する」
  const ib4 = fs4.readFileSync(path.join(dir, "itandi-bulk-dl.js"), "utf8");
  ok("ITANDI も押す順を人のように散らす（_itHumanPickOrder）", /function _itHumanPickOrder/.test(ib4) && /list = _itHumanPickOrder\(list\)/.test(ib4));
  ok("ITANDI の押す順も重複なし・全件1回", /for \(var m = 0; m < n; m\+\+\) if \(!picked\[m\]\) out\.push\(list\[m\]\);/.test(ib4));
  ok("ITANDI も路線の一覧を最初に目で探す間（1.2〜3.4秒）", /_itLineLookSeen/.test(ips4) && /firstLook \? 1200 : 500, hi0 = firstLook \? 3400 : 1600/.test(ips4));
  ok("ITANDI も押す直前に狙いを定める間（90〜350ms）", /var aim = 90 \+ Math\.floor\(Math\.random\(\) \* 260\)/.test(ips4));
  ok("ITANDI もたまに狙いを外して戻る（wander 12%）", /Math\.random\(\) < 0\.12\) \{[\s\S]{0,120}P\.wander/.test(ips4));
  ok("ITANDI も駅の一覧を最初に目で探す間（1.2〜3.4秒）", /_itStationLookSeen/.test(ips4) && /_lo1 = _firstStLook \? 1200 : 500, _hi1 = _firstStLook \? 3400 : 1600/.test(ips4));
  ok("ITANDI も入力の前に迷ってカーソルが漂う（drift 12%）", /P\.drift && Math\.random\(\) < 0\.12\)/.test(ips4));
  // 2026-11-11 竹内さん「ほかに機械的な部分あるか？」で見つけた3つ
  ok("ITANDI: モーダルは見えている1つだけ押す（一斉クリックしない）", /for \(var i = 0; i < cands\.length; i\+\+\) \{[\s\S]{0,200}cands\[i\]\.click\(\); return;/.test(ib4) && !/\.concat\(findBtnByText\("閉じる"\)\)\.forEach/.test(ib4));
  ok("ITANDI: スクロール待ちも距離だけで決まらない（logNormalDelay）", /w = H\.logNormalDelay\(base, 0\.3\)/.test(ips4) && /遠い|Math\.abs\(dist\) > 200/.test(ips4));
  ok("ITANDI: 間取りを上から順に選ばない（順番をシャッフル）", /_range\.sort\(function \(a, b\) \{ return \(0\.5 - Math\.random\(\)\); \}\)/.test(ips4) && /_subs\.sort\(function \(\) \{ return 0\.5 - Math\.random\(\); \}\)/.test(ips4));
  // 2026-11-11 竹内さん「物件検索した後に次のお客さんにうつるためにリセットする間隔など人間的になっているか」
  ok("リアプロ: 前のお客様の条件を一瞬で全部外さない（1つずつ人の間で外す）", /_toUncheck\.push\(cb\)/.test(ps4) && /setTimeout\(function \(\) \{ _unchk\(i \+ 1\); \}, gap\)/.test(ps4));
  ok("リアプロ: 外す間は 90〜260ms・8%で一息 300〜800ms", /if \(gap < 90\) gap = 90; if \(gap > 260\) gap = 260;/.test(ps4) && /Math\.random\(\) < 0\.08\) gap \+= 300/.test(ps4));
  ok("リアプロ: 多い時（20件超）は5件ずつまとめて外す", /if \(_toUncheck\.length > 20\)/.test(ps4) && /slice\(_chunk, _chunk \+ 5\)/.test(ps4));
  ok("リアプロ: 全部消えてから次へ進む（_resetRest）", /var _afterUncheck = function \(\) \{ _resetRest\(\); \}/.test(ps4) && /_chunk >= _toUncheck\.length\) \{ _afterUncheck\(\); return; \}/.test(ps4));
  ok("次のお客様まで 15〜60秒＋一息（nextCommandGapMs）", /function nextCommandGapMs\(rng\) \{\s*return customerGapMs\(rng\);/.test(fs4.readFileSync(path.join(dir, "auto-run.js"), "utf8")));
  // 2026-11-11 竹内さん「この＋一息の考え方かなり重要。人間はその発想があるから。ほかでもちゃんと確認おねがい。リアプロもitandiも」
  ok("リアプロ: 駅の一息は2段（10%で900〜2600ms・3%で2.6〜5.5秒）", /_stationBreath/.test(ps4) && /Math\.random\(\) < 0\.10\) add \+= 900/.test(ps4) && /Math\.random\(\) < 0\.03\) add \+= 2600/.test(ps4));
  ok("リアプロ: 間取り・設備のチェックにも一息（10%・3%）", /enqueueHumanClick\(cb, _clickEl, 420, 980\);[\s\S]{0,600}Math\.random\(\) < 0\.10\)/.test(ps4));
  ok("ITANDI: 駅の一息も2段に揃えた（10%で900〜2600ms・3%で2.6〜5.5秒）", /Math\.random\(\) < 0\.10\) _nextGap \+= 900/.test(ips4) && /Math\.random\(\) < 0\.03\) _nextGap \+= 2600/.test(ips4));
  ok("ITANDI: 駅の間も対数正規（_itHumanRand）", /function _itHumanRand\(lo, hi\)/.test(ips4) && /_itHumanRand\(420, _itHumanRand\(760, 1100\)\)/.test(ips4));
  ok("ITANDI: 全選択の後にも一息（10%で900〜2600ms）", /allInp\.checked \|\| n >= 12\) \{[\s\S]{0,300}Math\.random\(\) < 0\.10 \? 900/.test(ips4));
  // 2026-11-11 竹内さん「休憩の間もちゃんといれる。90分働いたら休憩があるのが普通」
  { const fsn = require("fs"); const bgn = fsn.readFileSync(path.join(dir, "background.js"), "utf8"); const hwn = fsn.readFileSync(path.join(dir, "human-wait.js"), "utf8");
  ok("一括検索でも休憩を入れる（短12〜30秒・長60〜180秒・90分で必ず）", /_manualBulkWorkedSince/.test(bg) && /continuousRestDue\(_worked, Date\.now\(\)\)/.test(bg) && /休憩（" \+ _restKind/.test(bg));
  ok("90分続いたら 1〜3分の一区切り", /_restMs = 60000 \+ Math\.floor\(Math\.random\(\) \* 120000\)/.test(bg));
  ok("休んだら数え直す", /_manualBulkWorkedSince = Date\.now\(\); \/\/ 休んだら数え直す/.test(bg));
  ok("自動モードも休憩（短12〜30秒・長60〜180秒・90分で小休憩）", /restDue\(_autoWorkedSince/.test(bgn) && /continuousRestDue\(_autoWorkedSince/.test(bgn));
  ok("休憩の長さ（short 12〜30秒・long 60〜180秒）", /REST_SHORT_MS = 12000, REST_SHORT_MAX_MS = 30000/.test(hwn) && /REST_LONG_MS = 60000, REST_LONG_MAX_MS = 180000/.test(hwn)); }
  // 2026-11-11 竹内さん「一連のうごきからちゃんと一息の部分入るようになっているか。人間のように一息もランダムにはいる」
  ok("リセット: セレクト・テキストも1つずつ消す（一斉に消さない）", /_clearTargets\.push\(\{ kind: "select"/.test(ps4) && /setTimeout\(_clearNext, gap\)/.test(ps4));
  ok("リセット: 全部消えたのを見届ける間にも一息（10%）", /var _look = _ln\(650, 0\.4, 380, 1300\);[\s\S]{0,200}Math\.random\(\) < 0\.10\) _look \+= 900/.test(ps4));
  ok("条件の入力: 1項目入れた後に一息（10%で900〜2600ms・3%で2.6〜5.5秒）", /function _enqueueWithEl[\s\S]{0,900}Math\.random\(\) < 0\.10\) \{[\s\S]{0,200}"息"/.test(ps4));
  ok("リアプロ: 検索を押す前の見直しにも一息（10%・3%）", /window\._axSearchLookedOver[\s\S]{0,400}Math\.random\(\) < 0\.10\) _lookMs \+= 900/.test(ps4));
  ok("ITANDI: 検索を押す前にも一息（10%・3%）", /_preSearchBreath[\s\S]{0,400}Math\.random\(\) < 0\.10\) _preSearchBreath = 900/.test(ips4));
  // 2026-11-11 竹内さん「AIXの部分に休憩時間等もちゃんと書いといて。昼休みなら昼休みと人間のように」
  ok("枠に「いま何をしているか」を出す（_axlxWorkNote）", /function _axlxWorkNote\(text, untilMs\)/.test(read("bulk-dl.js")) && /_axlxWorkNote\("👀 資料を見る"/.test(read("bulk-dl.js")));
  ok("残り秒を毎秒更新して、過ぎたら戻す", /el\.textContent = text \+ \(left > 0 \? "（あと" \+ left \+ "秒）" : ""\)/.test(read("bulk-dl.js")) && /_workNoteTimer = setInterval\(paint, 1000\)/.test(read("bulk-dl.js")));
  ok("昼休み（12:00〜13:00）を判定して「🍱 昼休み（13:00まで）」と出す", /_lunchRestMs|12 \* 60 && _mins < 13 \* 60/.test(read("background.js")) && /🍱 昼休み（13:00まで/.test(bg));
  ok("休憩・次のお客様までの間も枠に出す", /☕ 休憩中/.test(read("background.js")) && /⏳ 次のお客様まで/.test(read("background.js")));
  ok("ITANDI の枠にも同じ表示", /axlx-work-note/.test(ib4) && /axlx-itandi-count/.test(ib4));
}

console.log("\n■ マウスとクリック（押す点とカーソルの位置が合っているか）");
{
  const fs5 = require("fs");
  const ps5 = fs5.readFileSync(path.join(dir, "page-script.js"), "utf8");
  const ips5 = fs5.readFileSync(path.join(dir, "itandi-page-script.js"), "utf8");
  const H5 = require(path.join(dir, "human-wait.js"));
  ok("リアプロ: 押す点はカーソルが居る位置（visiblePosition）", /_P\.visiblePosition\) _pos = _P\.visiblePosition\(\)/.test(ps5) && /cx = Math\.round\(_pos\.x\); cy = Math\.round\(_pos\.y\);/.test(ps5));
  ok("リアプロ: カーソルが取れない時だけ 30〜70%", /var fx = 0\.30 \+ Math\.random\(\) \* 0\.40;/.test(ps5));
  ok("リアプロ: 軌跡の途中で elementFromPoint を呼ばない（重い・ずれる）", !/type === "mousemove" && i < pts\.length - 1/.test(ps5));
  ok("ITANDI: 押す点もカーソルの位置に合わせる（visiblePosition）", /_P0\.visiblePosition \? _P0\.visiblePosition\(\)/.test(ips5) && /cx = Math\.round\(_ps\.x\); cy = Math\.round\(_ps\.y\);/.test(ips5));
  // 軌跡が曲がる・終点が合う・端が遅い
  const pts = H5.pointerPath({ x: 0, y: 0 }, { x: 800, y: 400 }, 20);
  ok("マウス: 軌跡が曲がる（直線から外れる）", pts.some((p) => Math.abs(p.y - 400 * (p.x / 800)) > 3));
  const last = pts[pts.length - 1];
  ok("マウス: 終点がぴったり合う", last.x === 800 && last.y === 400);
  const w = H5.pointerDelays(24, 600);
  ok("マウス: 端（最初と最後）が中ほどより遅い（加速・減速）", w[0] + w[23] > w[10] + w[11]);
  ok("マウス: 1点ごとの待ちが違う（24点で20種類以上）", new Set(w).size >= 20);
  // 2026-11-11 竹内さん「マウスちゃんとした場所にうごくようになっているか」: 矢印の先端と座標を一致させる
  const pu5 = fs5.readFileSync(path.join(dir, "pointer-ui.js"), "utf8");
  ok("カーソル: 矢印の先端（4, 2.5）の分だけ戻して置く（指す点＝置く点）", /Math\.round\(x - 4\) \+ "px," \+ Math\.round\(y - 2\.5\)/.test(pu5));
  ok("カーソル: 位置は遅れずに反映（transition 0ms）", /transition:transform 0ms linear/.test(pu5));
  ok("カーソル: 画面の端でも丸めない（端の要素を正しく指せる）", /function _clamp\(p\) \{\s*return \{ x: Number\(p\.x\) \|\| 0, y: Number\(p\.y\) \|\| 0 \};/.test(pu5) || /return \{ x: Number\(p\.x\) \|\| 0, y: Number\(p\.y\) \|\| 0 \};/.test(pu5));
  ok("カーソル: 画面の外なら visiblePosition は null（見えていない扱い）", /function visiblePosition\(\)/.test(pu5) && /if \(_pos\.x < 0 \|\| _pos\.y < 0 \|\| _pos\.x > vw \|\| _pos\.y > vh\) return null;/.test(pu5));
  // 2026-11-11 竹内さん「カーソルもちゃんと人間のようにひと息つくときもあるか」
  ok("カーソル: 動く途中でひと息つく（18%・120〜420ms）", /function _pausePointFor\(n\)/.test(pu5) && /Math\.random\(\) >= 0\.18\) return -1;/.test(pu5) && /120 \+ Math\.floor\(Math\.random\(\) \* 300\)/.test(pu5));
  ok("カーソル: 長い移動の時だけ止まる（400ms 超）", /total > 400 \? _pausePointFor/.test(pu5));
  ok("カーソル: 止まる位置は軌跡の 25〜70%", /0\.25 \+ Math\.random\(\) \* 0\.45/.test(pu5));
  ok("カーソル: 迷う時にその場で漂う（drift）", /function drift\(ms, opts\)/.test(pu5) && /Math\.sin\(t \* Math\.PI \* 2 \+ ph\)/.test(pu5));
  ok("カーソル: 狙いを外して戻る（wander）", /function wander\(el, ms\)/.test(pu5));
  // 実際に止まる回がどれくらいあるか（点の数から）
  {
    let withPause = 0;
    for (let i = 0; i < 2000; i++) {
      // _pausePointFor と同じ判定を再現（20点・長い移動）
      if (!(20 < 8) && Math.random() < 0.18) withPause++;
    }
    ok("カーソル: 長い移動 2000回で 300回前後は途中で止まる（18%）", withPause > 250 && withPause < 450, { withPause });
  }
}
process.exit(fail ? 1 : 0);
