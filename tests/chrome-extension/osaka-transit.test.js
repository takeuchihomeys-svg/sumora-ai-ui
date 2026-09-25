// 実行: node tests/chrome-extension/osaka-transit.test.js
// 2026-09-25 拡張の路線のつながり（osaka-transit.js・自動生成）と通勤の候補の駅（commute-candidates.js）
//   - UMD をブラウザと同じ形（self）で読めるか
//   - 「梅田まで一本」「◯分以内」の候補が拡張の辞書の駅名（STATION_LINE_MAP のキー）に戻るか（サイトの表記は作らない）
//   - 駅欄への入れ方（通勤の言い方の語を外して足す）
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(name, cond) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); c ? pass++ : fail++; console.log((c ? "  ✓ " : "  ✗ ") + name + (c ? "" : `\n      expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)); }

const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

console.log("\n■ ブラウザと同じ形（self）で読む");
const sandbox = { console };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("osaka-transit.js"), sandbox, { filename: "osaka-transit.js" });
vm.runInContext(read("commute-candidates.js"), sandbox, { filename: "commute-candidates.js" });
const T = sandbox.AxlxOsakaTransit;
const CC = sandbox.AxlxCommuteCandidates;
ok("self.AxlxOsakaTransit がある", !!T && typeof T.oneRideStations === "function" && typeof T.stationsWithin === "function");
ok("self.AxlxCommuteCandidates がある", !!CC && typeof CC.build === "function" && typeof CC.render === "function");
ok("node の require でも読める", typeof require("../../chrome-extension/osaka-transit.js").oneRideStations === "function");

// 拡張の辞書（popup-maps.js は const の塊なので関数で包んで取り出す）
const M = new Function(read("popup-maps.js") + ";return { STATION_LINE_MAP, LINE_ROUTE_MAP, ITANDI_LINE_MAP_FILL, REINS_LINE_MAP };")();
const deps = { extLinesOf: (w) => M.STATION_LINE_MAP[w] || null };

console.log("\n■ 路線のつながり");
{
  const u = T.oneRideStations("大阪梅田");
  ok(`大阪梅田まで一本: ${u.stations.length}駅・${u.routes.length}経路`, u.target.key === "梅田" && u.stations.length >= 180);
  ok("千里中央（北急直通）・住道（学研都市線→東西線）・宝塚", ["千里中央", "住道", "宝塚"].every((s) => u.stations.some((x) => x.station === s)));
  ok("堺東は入らない（乗り換えが要る）", !u.stations.some((x) => x.station === "堺東"));
  const w = T.stationsWithin("梅田", 20, { maxTransfers: 1 });
  ok(`梅田まで20分（乗換1回まで）: ${w.stations.length}駅・分の短い順`, w.stations.length > 50 && w.stations.every((x, i, a) => i === 0 || a[i - 1].minutes <= x.minutes));
  const j = w.stations.find((x) => x.station === "十三");
  eq("十三は3分・乗換0", [j.minutes, j.transfers], [3, 0]);
  eq("「住吉(神戸)」は大阪の住吉と取り違えない（拡張の辞書に無い）", T.extName("住吉(神戸)"), null);
  ok("「平野(能勢)」は谷町線の平野にしない", T.extNames("平野(能勢)").every((w) => w !== "平野" && w !== "JR平野"));
}

console.log("\n■ 拡張の辞書の駅名に戻す（乗る路線で言い方を選ぶ）");
{
  eq("なんば × 大和路線 → JR難波", CC.pickExtNames(T, "なんば", ["関西本線"], deps), ["JR難波"]);
  eq("なんば × 南海本線 → 難波", CC.pickExtNames(T, "なんば", ["南海電鉄南海本線"], deps), ["難波"]);
  eq("なんば × 近鉄奈良線 → 大阪難波", CC.pickExtNames(T, "なんば", ["近鉄難波・奈良線"], deps), ["大阪難波"]);
  eq("なんば × 御堂筋線 → なんば", CC.pickExtNames(T, "なんば", ["大阪市高速軌道御堂筋線"], deps), ["なんば"]);
  eq("平野 × 大和路線 → JR平野", CC.pickExtNames(T, "平野", ["関西本線"], deps), ["JR平野"]);
  eq("梅田 × 阪急宝塚線 → 大阪梅田", CC.pickExtNames(T, "梅田", ["阪急電鉄宝塚線"], deps), ["大阪梅田"]);
  eq("尼崎 × JR神戸線（拡張では東海道本線）", CC.pickExtNames(T, "尼崎", ["JR神戸線"], deps).length <= 2, true);
  eq("辞書に無い駅は入れない（京都）", CC.pickExtNames(T, "京都", ["東海道本線"], deps), []);
}

console.log("\n■ お客様の条件 → 候補（build）");
{
  const r1 = CC.build(T, { desired_area: "梅田まで電車1本" }, deps);
  const b1 = r1.blocks[0];
  ok(`「梅田まで電車1本」→ 一本の候補 ${b1 && b1.extCount}駅`, !!b1 && b1.kind === "one" && b1.extCount >= 150);
  ok("目的地の駅（梅田・東梅田・大阪梅田・大阪・西梅田・北新地）", ["梅田", "東梅田", "大阪梅田", "大阪", "西梅田", "北新地"].every((s) => b1.members.includes(s)));
  const allNames = [].concat(b1.members, b1.allExt);
  ok("入れる駅名は全部 拡張の辞書の駅名（STATION_LINE_MAP のキー）", allNames.every((s) => !!M.STATION_LINE_MAP[s]));
  const siteWords = new Set([].concat(Object.keys(M.LINE_ROUTE_MAP), Object.values(M.ITANDI_LINE_MAP_FILL).flat(), Object.values(M.REINS_LINE_MAP).flat()));
  ok("サイトの路線名（リアプロ・itandi・レインズの表記）は1つも入れない", allNames.every((s) => !siteWords.has(s) && !/線$/.test(s)));
  ok("阪急宝塚線の経路のチップがある（沿線ごとに選べる）", b1.routes.some((r) => r.label === "阪急宝塚線" && r.stations.some((s) => s.station === "豊中")));

  const r2 = CC.build(T, { desired_area: "北区・福島区", commute_station: "本町", commute_minutes: 20 }, deps);
  const b2 = r2.blocks[0];
  ok(`通勤の列（本町・20分）→ 20分以内の候補 ${b2 && b2.extCount}駅`, !!b2 && b2.kind === "time" && b2.minutes === 20 && b2.maxTransfers === 1);
  ok("本町の隣（堺筋本町・心斎橋）は2分", ["堺筋本町", "心斎橋"].every((n) => (b2.stations.find((s) => s.station === n) || {}).minutes === 2));
  const r3 = CC.build(T, { desired_area: "北区・福島区", commute_station: "本町", commute_minutes: 20 }, deps, { minutes: 10, maxTransfers: 0 });
  ok(`分と乗り換えを変える（10分・乗り換えなし）→ ${r3.blocks[0].stations.length}駅に減る`, r3.blocks[0].stations.length < b2.stations.length && r3.blocks[0].stations.every((s) => s.transfers === 0 && s.minutes <= 10));

  const r4 = CC.build(T, { preferences: "なんばに通勤・天王寺まで30分以内" }, deps);
  eq("条件欄の2つの目的地（なんば＝一本／天王寺＝30分）", r4.blocks.map((b) => [b.target, b.kind]), [["なんば", "one"], ["天王寺", "time"]]);
  eq("通勤の言い方が無いお客様は候補なし", CC.build(T, { desired_area: "北区 天王寺区", preferences: "駅から徒歩10分以内" }, deps).blocks, []);
}

console.log("\n■ 駅欄に入れる（mergeStationField）");
{
  eq("通勤の言い方の語は外して足す・重複なし", CC.mergeStationField("梅田まで電車1本・十三", ["梅田", "東梅田", "中津", "十三"]), "十三・梅田・東梅田・中津");
  eq("空の欄", CC.mergeStationField("", ["京橋", "鴫野"]), "京橋・鴫野");
  eq("「本町まで20分」も外す", CC.mergeStationField("本町まで20分 心斎橋", ["本町", "堺筋本町"]), "心斎橋・本町・堺筋本町");
  // 反証レビュー 2026-09-25: 「分」の字を含む駅名（河内国分）は消さない・「梅田30分」は外す
  eq("駅名の「分」は残す（河内国分）", CC.mergeStationField("河内国分・梅田30分", ["鶴橋"]), "河内国分・鶴橋");
  eq("render は box が無ければ何もしない", CC.render(null, T, {}, deps), null);
}

console.log("\n■ 読み込みの順（popup.html・manifest）");
{
  const html = read("popup.html");
  const i1 = html.indexOf('src="osaka-transit.js"'), i2 = html.indexOf('src="commute-candidates.js"'), i3 = html.indexOf('src="popup.js"');
  ok("popup.html: osaka-transit.js → commute-candidates.js → popup.js", i1 > 0 && i1 < i2 && i2 < i3);
  ok("popup.html: 候補の置き場（#commute-candidates）", html.includes('id="commute-candidates"'));
  const mf = JSON.parse(read("manifest.json"));
  const res = mf.web_accessible_resources[0].resources;
  ok("manifest: web_accessible_resources に2つ", res.includes("osaka-transit.js") && res.includes("commute-candidates.js"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
