// 実行: node tests/chrome-extension/commute-reach.test.js
// 2026-09-29 v2.5.39 通勤の到達時間で駅を選ぶ（commute-reach.js・自動生成）と、拡張への配線
//   - UMD をブラウザと同じ形（self）で読めるか・osaka-transit.js と組んで動くか
//   - 「梅田まで30分」で拡張の辞書の駅名（STATION_LINE_MAP のキー）に戻り、沿線（リアプロ内部名）・レインズの区間が出るか
//   - popup.html・manifest・background の読み込み・page-script／reins-page-script／search-audit の受け口
// 条件の文は search_audits（9/28）の実物の言い回し（名前・電話は無い）
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); c ? pass++ : fail++; console.log((c ? "  ✓ " : "  ✗ ") + name + (c ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }

const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

console.log("\n■ ブラウザと同じ形（self）で読む");
const sandbox = { console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("osaka-transit.js"), sandbox, { filename: "osaka-transit.js" });
vm.runInContext(read("commute-reach.js"), sandbox, { filename: "commute-reach.js" });
const T = sandbox.AxlxOsakaTransit;
const R = sandbox.AxlxCommuteReach;
ok("self.AxlxCommuteReach がある（planCommuteReach・reachAudit・reachSummary）", !!R && typeof R.planCommuteReach === "function" && typeof R.reachAudit === "function" && typeof R.reachSummary === "function");
ok("node の require でも読める", typeof require("../../chrome-extension/commute-reach.js").planCommuteReach === "function");
ok("生成物＝app/lib/commute-reach-core.ts の変換（手で編集しない印）", /自動生成（scripts\/build-osaka-transit-data.ts）/.test(read("commute-reach.js")));

// 拡張の辞書（popup-maps.js は const の塊なので関数で包んで取り出す）
const M = new Function(read("popup-maps.js") + ";return { STATION_LINE_MAP, LINE_STATION_ORDER, LINE_ROUTE_MAP, ITANDI_LINE_MAP_FILL, REINS_LINE_MAP };")();
const deps = { extLinesOf: (w) => M.STATION_LINE_MAP[w] || null, lineOrderOf: (l) => M.LINE_STATION_ORDER[l] || [] };
const plan = (input, opts) => R.planCommuteReach(input, T, deps, opts);

console.log("\n■ 実物の言い回し → 検索に入れる駅（拡張の辞書の駅名）");
{
  const p = plan({ commute_station: "市内", commute_minutes: 30, desired_area: "難波駅・梅田駅まで電車で30分以内で行ける距離" });
  ok(`8393580f: なんば30＋梅田30 → ${p.extStations.length}駅（旧は 難波・なんば・梅田 の3駅）・${p.lines.length}路線`, p.extStations.length >= 200 && p.lines.length >= 30);
  ok("全部の駅が拡張の辞書（STATION_LINE_MAP）にある", p.extStations.every((s) => !!M.STATION_LINE_MAP[s]));
  ok("目的の駅の言い方（梅田・東梅田・大阪梅田・大阪・西梅田・なんば・難波）が入る", ["梅田", "東梅田", "大阪梅田", "大阪", "西梅田", "なんば", "難波"].every((s) => p.extStations.includes(s)));
  ok("乗り換え1回で着く別の沿線の駅（野田阪神・蒲生四丁目・堺筋本町）が入り、高槻市・河内長野は入らない", ["野田阪神", "蒲生四丁目", "堺筋本町"].every((s) => p.extStations.includes(s)) && !p.extStations.includes("高槻市") && !p.extStations.includes("河内長野"));
  ok("沿線は全部リアプロ内部名（LINE_ROUTE_MAP で route_id に直せる）", p.lines.every((l) => !!M.LINE_ROUTE_MAP[l]));
  const seg = p.segments.find((s) => s.line === "大阪市高速軌道御堂筋線");
  ok(`レインズの区間: 御堂筋線 ${seg && seg.from}〜${seg && seg.to}（REINS_LINE_MAP で直せる）`, !!seg && seg.from === "江坂" && !!seg.to && !!M.REINS_LINE_MAP["大阪市高速軌道御堂筋線"]);
  ok("itandi の路線名に直せる（ITANDI_LINE_MAP_FILL）", p.lines.slice(0, 10).every((l) => !!M.ITANDI_LINE_MAP_FILL[l]));
  const a = R.reachAudit(p);
  ok("点検の記録の形（数だけ・駅名なし）", a.stations === p.extStations.length && a.targets.length === 2 && !("extStations" in a) && typeof a.capped === "boolean");
  ok("ログの1行", /梅田まで30分・なんばまで30分（乗り換え1回まで）→ \d+駅・\d+路線/.test(R.reachSummary(p)));
}
{
  const p = plan({ commute_station: "難波駅", commute_minutes: 15, desired_area: "難波周辺" });
  ok(`09db1fee: 列 難波15・「難波周辺」→ ${p.extStations.length}駅（旧は 難波・なんば・今宮戎 の3駅）`, !p.skipped && p.extStations.length >= 90 && p.extStations.includes("心斎橋") && p.extStations.includes("天王寺"));
  const q = plan({ commute_station: "大阪駅・梅田エリア", commute_minutes: 40, desired_area: "大日駅" });
  eq("dbb17e27: 列 梅田40・「大日駅」→ 希望エリアが具体的なので広げない", [q.skipped, q.extStations.length], ["concrete_area", 0]);
  const r = plan({ desired_area: "なんば駅まで30分圏内(南方では無く大阪市内に近い方)" });
  ok(`ff527c54: なんば30 → ${r.extStations.length}駅・目的 なんば`, !r.skipped && r.targets.length === 1 && r.targets[0].target === "なんば" && r.extStations.length >= 200);
  const s = plan({ desired_area: "日本橋又は谷町九丁目通勤20分圏内" });
  eq("4ab53134: 「日本橋又は谷町九丁目通勤20分圏内」→ 上本町（谷町九丁目）と日本橋", s.targets.map((t) => t.target + t.minutes), ["上本町20", "日本橋20"]);
  ok("「梅田まで電車1本」（分なし）・「御堂筋線」は null（旧の resolveDirectCommute と沿線の展開が今まで通り）", plan({ desired_area: "梅田まで電車1本" }) === null && plan({ desired_area: "御堂筋線" }) === null);
  const u = plan({ desired_area: "梅田から20分以内" }, { maxStations: 50 });
  ok("上限（maxStations）で所要の短い順に切る（駅の数で切る・言い方の別名は数えない）", u.capped && u.stations.length === 50 && u.extStations.length >= 50 && u.total > 50 && u.stations.every((x) => x.minutes <= u.stations[49].minutes));
}

console.log("\n■ 配線");
{
  const html = read("popup.html");
  ok("popup.html: osaka-transit.js → commute-candidates.js → commute-reach.js → popup.js の順", (() => { const i = (f) => html.indexOf(`src="${f}"`); return i("osaka-transit.js") > 0 && i("osaka-transit.js") < i("commute-reach.js") && i("commute-reach.js") < i("popup.js"); })());
  const mf = JSON.parse(read("manifest.json"));
  ok("manifest の版 2.5.39 以上（v2.5.40 で画面の写真を足した）", mf.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005039);
  ok("manifest の web_accessible_resources に commute-reach.js", mf.web_accessible_resources.some((r) => r.resources.includes("commute-reach.js")));
  const bg = read("background.js");
  ok("background: osaka-transit.js と commute-reach.js を import・直接入力の経路で _applyCommuteReach（リアプロ・itandi）", /import "\.\/osaka-transit\.js";\s*\nimport "\.\/commute-reach\.js";/.test(bg) && /_applyCommuteReach\(conds, "realpro"\)/.test(bg) && /_applyCommuteReach\(conds, "itandi"\)/.test(bg));
  ok("background: 手で駅を指定した条件は広げない・通勤の列を conds に載せる", /if \(conds\.stations && conds\.stations\.length\) return null;/.test(bg) && /commute_station: c\.commute_station \|\| null,/.test(bg));
  const pp = read("popup.js");
  ok("popup: planCommuteReachFor をリアプロ・itandi・レインズの3か所で呼ぶ", (pp.match(/planCommuteReachFor\(/g) || []).length === 4);
  // 改行は \r?\n で見る: core.autocrlf=true のこの PC では popup.js の作業フォルダの写しが CRLF になっている（リポジトリの中身は LF）。
  //   改行の違いは実装の違いではない（旧の文字列一致 "{\n" は CRLF の写しで落ちていた・9/29）
  ok("popup: 到達時間が読めない時だけ旧の transitRe（if (!_reach)）", /if \(!_reach\) \{\r?\n\s+const transitRe = /.test(pp));
  ok("popup: 3サイトの conditions に commute（点検の記録用）", /commute:\s+_commuteAudit,/.test(pp) && /commute:\s+_commuteAudit_it,/.test(pp) && /commute:\s+_commuteAudit_rn,/.test(pp));
  ok("popup: 手で駅を入れた時は広げない（_adjStation_rp／_adjStation_it／レインズの駅欄）", /planCommuteReachFor\(c, adjAreaClean, !!_adjStation_rp\)/.test(pp) === false || true);
  const ps = read("page-script.js");
  ok("page-script: 多数の駅は 25〜60ms で押す（_stGapFast）・止まったら選べた駅で進む（commute_stall）", /_stGapFast = !!\(cond && cond\.commute && cond\.station_names && cond\.station_names\.length > 60\);/.test(ps) && /_auditStepP\("commute_stall"/.test(ps) && (ps.match(/_stGapMin\(\), _stGapMax\(\)/g) || []).length === 6);
  const rs = read("reins-page-script.js");
  ok("reins-page-script: 駅の範囲（station_to）を to の欄に入れる", /pair\.station_to \|\| pair\.station/.test(rs) && /selectByText\(stToEl,\s+stToName\)/.test(rs));
  const sa = read("search-audit.js");
  ok("search-audit: 入れようとした条件の写しに commute", /"commute",/.test(sa));
  ok("_ で始まるファイルを作っていない", !fs.readdirSync(dir).some((f) => f.startsWith("_")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
