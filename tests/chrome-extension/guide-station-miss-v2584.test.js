// 実行: node tests/chrome-extension/guide-station-miss-v2584.test.js
// 2026-10-06 v2.5.84 竹内「沿線はちゃんと選択されているのに何で駅直通全て表示されていないのか　駅の部分について把握できていないのか
//   原因見つけて改善するのと改善していく仕組み作る」
//   みくさん（梅田まで電車1本・〜9万・徒歩10分・1LDK・築10年・35㎡〜）: 路線 12本・駅 122（search_audits 522 の intended そのまま）。
//   案内は駅の名前を先頭 40 で切っていた → 御堂筋・阪急京都・阪急宝塚の駅だけが光り、残り 82駅（塚本・姫島・谷町九丁目…）が黙って落ちた。
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
global.AxlxFloorIjou = require(path.join(dir, "floor-ijou.js"));
const P = require(path.join(dir, "realpro-guide-plan.js"));
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log("  ✓ " + name); } else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); } }

// みくさんの実物（search_audits id=522・2026-10-06 18:40 JST・v2.5.82）
const MIKU_STATIONS = "梅田,江坂,東三国,西中島南方,新大阪,中津,淀屋橋,本町,心斎橋,なんば,大国町,動物園前,天王寺,昭和町,西田辺,長居,我孫子,北花田,新金岡,なかもず,大阪梅田,十三,南方,崇禅寺,淡路,上新庄,相川,正雀,摂津市,南茨木,茨木市,三国,庄内,服部天神,曽根,岡町,豊中,蛍池,石橋阪大前,池田,神崎川,園田,塚口,武庫之荘,福島,野田,淀川,姫島,千船,杭瀬,大阪,南吹田,JR淡路,城北公園通,JR野江,鴫野,放出,高井田中央,JR河内永和,JR俊徳道,JR長瀬,衣摺加美北,新加美,久宝寺,西九条,弁天町,大正,芦原橋,今宮,新今宮,寺田町,桃谷,鶴橋,玉造,森ノ宮,大阪城公園,京橋,桜ノ宮,天満,塚本,東淀川,吹田,岸辺,千里丘,茨木,JR総持寺,摂津富田,高槻,島本,西梅田,肥後橋,四ツ橋,花園町,岸里,玉出,北加賀屋,住之江公園,大日,守口,太子橋今市,千林大宮,関目高殿,野江内代,都島,天神橋筋六丁目,中崎町,東梅田,南森町,天満橋,谷町四丁目,谷町六丁目,谷町九丁目,四天王寺前夕陽ヶ丘,阿倍野,文の里,田辺,駒川中野,平野,喜連瓜破,出戸,長原,八尾南".split(",");
const MIKU = {
  rent_max: 90000, walk_minutes: 10, floor_plan: "1LDK", building_age: 10, area_min: 35, rp_update_days: 1, shikirei_free: true,
  area_mode: "station", select_all_line_stations: true,
  route_ids: ["6701", "6711", "6702", "6703", "6664", "6668", "6661", "6671", "6603", "6171", "6650", "6605"],
  station_names: MIKU_STATIONS,
};
// リアプロの駅の小窓の文字（本番の自動入力の読み戻し filled.form.stations から・東海道本線／環状線／おおさか東線の一部）
const RP_LABELS = ["京都", "島本", "高槻", "摂津富田", "ＪＲ総持寺", "茨木", "千里丘", "岸辺", "吹田", "東淀川", "新大阪", "大阪", "塚本", "尼崎",
  "大阪", "福島", "野田", "西九条", "弁天町", "大正", "芦原橋", "今宮", "新今宮", "天王寺", "寺田町", "桃谷", "鶴橋", "玉造", "森ノ宮", "大阪城公園", "京橋", "桜ノ宮", "天満",
  "新大阪", "南吹田", "城北公園通", "放出", "鴫野", "高井田中央", "河内永和", "俊徳道", "長瀬", "衣摺加美北", "新加美", "久宝寺",
  "谷町四丁目", "谷町六丁目", "谷町九丁目", "四天王寺前夕陽ヶ丘", "なんば", "難波"];

console.log("── ① 駅の名前を 40 で切らない（みくさん 122駅）");
const plan = P.buildPlan(MIKU);
const st = plan.steps.find((s) => s.kind === "pick_station");
ok("案内の駅の手順に 122駅が全部入る（旧は 40）", st && st.names.length === 122, st && st.names.length);
ok("旧の切りで落ちていた駅（塚本・姫島・谷町九丁目・JR河内永和）も入る", ["塚本", "姫島", "谷町九丁目", "JR河内永和"].every((n) => st.names.includes(n)));
const old40 = MIKU_STATIONS.slice(0, 40);
const oldLit = RP_LABELS.filter((l) => old40.includes(l));
ok("再現: 旧の 40駅だと東海道・環状・おおさか東の小窓で光るのは 新大阪・天王寺・なんば だけ", JSON.stringify([...new Set(oldLit)].sort()) === JSON.stringify(["なんば", "天王寺", "新大阪"].sort()), [...new Set(oldLit)]);
ok("上限は安全のためだけ（300・自動入力の 240駅より上）", P.MAX_GUIDE_STATIONS >= 240);

console.log("── ② 名前の照らし合わせ（リアプロの文字は別の表）");
const m = P.matchStations(st.names, RP_LABELS);
ok("JR河内永和・JR俊徳道・JR長瀬 → リアプロの「河内永和」「俊徳道」「長瀬」で光る", m.via["JR河内永和"] === "河内永和" && m.via["JR俊徳道"] === "俊徳道" && m.via["JR長瀬"] === "長瀬" && m.want["河内永和"], m.via);
ok("全角の「ＪＲ総持寺」は同じ文字（読み替えなし）", m.want[P.stationKey("ＪＲ総持寺")] && !m.via["JR総持寺"]);
ok("「ヶ」と「ケ」は同じ（四天王寺前夕陽ヶ丘）", P.stationKey("四天王寺前夕陽ヶ丘") === P.stationKey("四天王寺前夕陽ケ丘"));
ok("「谷町9丁目」→「谷町九丁目」（当て直しで 5回）", P.stationKey("谷町9丁目") === "谷町九丁目" && P.stationKey("天神橋筋6丁目") === "天神橋筋六丁目");
ok("同じ文字があれば読み替えない（なんば は 難波 を光らせない）", m.want["なんば"] && !m.want["難波"]);
ok("小窓に無い駅は「見つからない駅」に（黙って落とさない）: JR淡路 等", m.missing.includes("JR淡路") && m.missing.includes("姫島"), m.missing.slice(0, 10));
ok("小窓に出た駅は見つからないに入らない（塚本・大阪・久宝寺）", !["塚本", "大阪", "久宝寺", "JR河内永和"].some((n) => m.missing.includes(n)));
ok("駅の小窓をまだ見ていない（文字なし）時は見つからない駅を作らない", P.matchStations(st.names, []).missing.length === 0);
ok("案内の枠の1行: 6つまで＋他の数", P.missNote(["a", "b", "c", "d", "e", "f", "g", "h"]) === "見つからない駅: a・b・c・d・e・f 他2" && P.missNote([]) === "");
ok("読み替えの表は両向き（我孫子⇔あびこ・恵比須町⇔恵美須町）", P.matchStations(["我孫子"], ["あびこ"]).via["我孫子"] === "あびこ" && P.matchStations(["恵比須町"], ["恵美須町"]).via["恵比須町"] === "恵美須町");
ok("画面の側だけ JR が付く（総持寺 → ＪＲ総持寺）", P.matchStations(["総持寺"], ["ＪＲ総持寺"]).via["総持寺"] === "JR総持寺");

console.log("── ③ 案内・記録の配線");
const g = read("realpro-guide.js"), bg = read("background.js");
ok("案内は Plan.matchStations で光らせる（旧の完全一致の辞書を使わない）", /Plan\.matchStations\(s\.names/.test(g) && !/want\[norm\(n\)\.replace\(\/駅\$\/, ""\)\] = true/.test(g));
ok("見つからない駅を案内の枠の1行に出す", /missNote/.test(g) && /" ／ " \+ sm\.missNote/.test(g));
ok("駅の手順が済んだ・小窓を閉じた・検索を押した時に1回だけ記録", (g.match(/reportStationMiss\(/g) || []).length >= 4 && /stationMissReported/.test(g));
ok("記録は background → search_audits.filled.guide_stations ＋ 拡張の中の 50回", /axlx-guide-station-miss/.test(bg) && /guide_stations/.test(bg) && /axlx_guide_station_miss_log/.test(bg));
ok("駅の小窓の文字はお客様ごとに覚え直す", /_seenStationLabels = \{\}; \/\/ v2\.5\.84/.test(g));
ok("光の枠は先頭 40 で切らない（画面に見えている物を描く・150 まで）", !/(targets || []).filter(Boolean).slice(0, 40)/.test(g) && /rects.length >= 150/.test(g));
ok("集計のスクリプトがある", fs.existsSync(path.join(__dirname, "..", "..", "scripts", "audit-guide-station-miss.ts")));
ok("manifest の版 2.5.84", JSON.parse(read("manifest.json")).version === "2.5.84");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
