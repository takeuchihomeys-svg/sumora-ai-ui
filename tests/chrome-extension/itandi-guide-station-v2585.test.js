// 実行: node tests/chrome-extension/itandi-guide-station-v2585.test.js
// 2026-10-06 v2.5.85 ITANDI の案内にもリアプロ v2.5.84 と同じ直し方（竹内「リアプロ同様に ITANDI も」）:
//   ①光の枠を先頭 40 で切らない（画面に見えている物だけ・150 まで）②駅の名前の照らし合わせ（ITANDI の読み替えの表だけ・リアプロと混ぜない）
//   ③見つからない駅を「確定」の所で枠に出し、駅の手順が済んだ／検索を押した時に1回だけ記録（search_audits.filled.guide_stations・site=itandi）
//   実物: みくさん（9/30 の ITANDI の回 search_audits 344: 路線 14本・駅＝梅田・東梅田・西梅田・大阪梅田・大阪・路線の全駅）と、
//   ITANDI の駅の文字（同じ回の reset.after.stations＝チップの駅「JR総持寺」等）。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
global.AxlxFloorIjou = require(path.join(dir, "floor-ijou.js"));
const IT = require(path.join(dir, "itandi-guide-plan.js"));
const RP = require(path.join(dir, "realpro-guide-plan.js"));
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); } }

// 旧の itandi-guide.js stationLabelHit（v2.5.84 まで）の写し: 読み替えの表＋含む・1字差だけ（NFKC なし）
function oldHit(label, stations) {
  const norm = (s) => String(s == null ? "" : s).replace(/（/g, "(").replace(/）/g, ")").replace(/〜/g, "~").replace(/～/g, "~").replace(/　/g, " ").trim();
  const nt = norm(label);
  return stations.some((sn) => IT.getStationAliases(sn).some((a) => { const nn = norm(a); return nt === nn || (nt.length <= 8 && nt.indexOf(nn) >= 0 && nt.length - nn.length <= 1); }));
}
// ITANDI の駅の文字（search_audits 344 reset.after.stations の一部）
const IT_LABELS = ["京都", "島本", "高槻", "摂津富田", "JR総持寺", "茨木", "千里丘", "岸辺", "吹田", "東淀川", "塚本", "尼崎", "野田", "天満", "桜ノ宮", "京橋", "大阪城公園", "森ノ宮", "玉造", "鶴橋", "桃谷", "寺田町", "今宮", "芦原橋", "大正", "弁天町", "西九条"];

console.log("── ① 照らし合わせ（ITANDI の表だけ）");
ok("全角の「ＪＲ総持寺」→ ITANDI の「JR総持寺」（旧は当たらない）", IT.stationLabelWantedIt("JR総持寺", ["ＪＲ総持寺"]) && !oldHit("JR総持寺", ["ＪＲ総持寺"]));
ok("「谷町9丁目」→「谷町九丁目」（旧は当たらない）", IT.stationLabelWantedIt("谷町九丁目", ["谷町9丁目"]) && !oldHit("谷町九丁目", ["谷町9丁目"]));
ok("「ヶ」と「ケ」は同じ", IT.stationLabelWantedIt("四天王寺前夕陽ケ丘", ["四天王寺前夕陽ヶ丘"]));
ok("JR の有無（名前「JR野江」↔ 画面「野江」・名前「総持寺」↔ 画面「JR総持寺」）", IT.stationLabelWantedIt("野江", ["JR野江"]) && IT.stationLabelWantedIt("JR総持寺", ["総持寺"]));
ok("ITANDI の読み替えの表は生きている（なんば ↔ 難波）", IT.stationLabelWantedIt("難波", ["なんば"]));
ok("旧の緩さ（含む・1字差）も残す", IT.stationLabelWantedIt("梅田駅", ["梅田"]) === oldHit("梅田駅", ["梅田"]));
ok("リアプロの読み替え（我孫子⇔あびこ）は ITANDI に混ぜない（サイトごとに独立の表）", RP.matchStations(["我孫子"], ["あびこ"]).via["我孫子"] === "あびこ" && !IT.stationLabelWantedIt("あびこ", ["我孫子"]));
ok("緩さは旧と同じ（「梅田」は 1字差の「西梅田」にも当たる・2字差の「大阪梅田駅前」には当たらない）", IT.stationLabelWantedIt("西梅田", ["梅田"]) === oldHit("西梅田", ["梅田"]) && !IT.stationLabelWantedIt("大阪梅田駅前", ["梅田"]));
const mm = IT.matchStationsIt(["ＪＲ総持寺", "塚本", "姫島", "JR野江", "JR大正"], IT_LABELS);
ok("見つからない駅: 小窓で見た文字のどれにも当たらない駅だけ（姫島・JR野江）", JSON.stringify(mm.missing) === JSON.stringify(["姫島", "JR野江"]), mm);
ok("同じ文字（全角/半角の違いだけ含む）で当たった駅は via に入れない・JR の有無で当たった駅は via", !mm.via["塚本"] && !mm.via["ＪＲ総持寺"] && mm.via["JR大正"] === "大正", mm.via);
ok("小窓をまだ見ていない（文字なし）時は見つからない駅を作らない", IT.matchStationsIt(["梅田"], []).missing.length === 0);
ok("枠の1行は6つまで＋他の数", IT.missNoteIt(["a", "b", "c", "d", "e", "f", "g"]) === "見つからない駅: a・b・c・d・e・f 他1" && IT.missNoteIt([]) === "");

console.log("── ② 案内・記録の配線");
const g = read("itandi-guide.js"), bg = read("background.js");
ok("光の枠は先頭 40 で切らない（画面に見えている物・150 まで）", !/\(targets \|\| \[\]\)\.filter\(Boolean\)\.slice\(0, 40\)/.test(g) && /rects\.length >= 150/.test(g));
ok("駅の光は Plan.stationLabelWantedIt（旧の完全一致・含むだけの照らし合わせを使わない）", /Plan\.stationLabelWantedIt\(/.test(g) && !/var nn = norm\(a\);/.test(g));
ok("小窓で見た駅の文字を覚える（路線ごとに出る駅を全部）・お客様ごとに覚え直す", /noteSeenStations\(cb, isLine\)/.test(g) && /_seenStationLabels = \{\}; \/\/ v2\.5\.85/.test(g));
ok("見つからない駅は「確定」の所でだけ枠に出す（途中＝まだ開いていない路線の駅を数えない）", /note: "選び終えたら「確定」" \+ \(mn \? " ／ " \+ mn : ""\)/.test(g));
ok("駅の手順が済んだ・検索を押した時に1回だけ記録（site=itandi）", (g.match(/reportStationMiss\(/g) || []).length >= 3 && /stationMissReported/.test(g) && /site: "itandi"/.test(g));
ok("background は record.site で search_audits の site を決める", /msg\.record\.site === "itandi"/.test(bg));
ok("集計のスクリプトに --site=itandi", /--site=itandi/.test(fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "audit-guide-station-miss.ts"), "utf8")));
ok("manifest の版 2.5.85", JSON.parse(read("manifest.json")).version === "2.5.85");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
