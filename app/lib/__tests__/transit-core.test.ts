// 2026-09-25 路線のつながり（transit-core）: 乗り換えなしで行ける駅・◯分以内の駅・通勤の読み・サーバーと拡張が同じか
// 実行: npx tsx app/lib/__tests__/transit-core.test.ts
// 期待値は代表の目的地（梅田・なんば・天王寺・京橋・本町・新大阪）を実際の路線図と照らして目で読んだ物（scripts/audit-osaka-transit.ts）
import { createRequire } from "module";
import { join } from "path";
import { oneRideStations, stationsWithin, shortestRoute, commuteAsksInText, transitData } from "../transit-route";
import { normStation } from "../osaka-geo";

const req = createRequire(__filename);
const ext = req(join(__dirname, "../../../chrome-extension/osaka-transit.js"));

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const has = (r: ReturnType<typeof oneRideStations>, s: string) => !!r?.stations.some((x) => x.station === s);

console.log("■ サーバーと拡張が同じ（データ・関数を1か所から生成）");
{
  const dests = ["梅田", "なんば", "天王寺", "京橋", "本町", "新大阪", "大阪梅田", "JR難波", "阿部野橋"];
  for (const d of dests) {
    t(`${d}: 乗り換えなしが一致`, JSON.stringify(oneRideStations(d)) === JSON.stringify(ext.oneRideStations(d)));
    t(`${d}: 30分以内（乗換2回まで）が一致`, JSON.stringify(stationsWithin(d, 30)) === JSON.stringify(ext.stationsWithin(d, 30, {})));
  }
  t("最短の乗り方も一致（堺東→梅田）", JSON.stringify(shortestRoute("堺東", "梅田")) === JSON.stringify(ext.shortestRoute("堺東", "梅田")));
  t("normStation が一致（大阪難波駅・天六・谷町9丁目）", ["大阪難波駅", "天六", "谷町9丁目", "阪急淡路駅"].every((s) => normStation(s) === ext.normStation(s)));
  const data = transitData();
  t(`直通の運転 ${data.services.length} 本・駅のまとまり ${Object.keys(data.groups).length}`, data.services.length >= 12 && Object.keys(data.groups).length >= 16);
  t("環状線は輪（天満→大阪がつながる）", data.lines["大阪環状線"][0] === "大阪" && data.lines["大阪環状線"].at(-1) === "大阪");
}

console.log("■ 駅のまとまり（乗り換えで同じ場所）");
{
  const g = ext.groupOf("大阪梅田");
  t("大阪梅田 → 梅田（梅田・大阪・西梅田・北新地）", g.key === "梅田" && ["梅田", "大阪", "西梅田", "北新地"].every((s: string) => g.members.includes(s)));
  t("東梅田・JR大阪・北新地も梅田のまとまり", ["東梅田", "JR大阪", "北新地"].every((s) => ext.groupOf(s)?.key === "梅田"));
  t("JR難波・大阪難波・南海難波 → なんば", ["JR難波", "大阪難波", "南海難波"].every((s) => ext.groupOf(s)?.key === "なんば"));
  t("阿部野橋 → 天王寺（天王寺・大阪阿部野橋・天王寺駅前）", ext.groupOf("阿部野橋")?.key === "天王寺");
  t("日本橋はなんばと別（1駅離れる）", ext.groupOf("日本橋")?.key === "日本橋");
  t("知らない駅は null", ext.groupOf("大和小泉") === null);
}

console.log("■ 乗り換えなしで行ける駅（oneRideStations）");
{
  const u = oneRideStations("梅田");
  t(`梅田: 経路 ${u?.routes.length}・駅 ${u?.stations.length}`, !!u && u.routes.length >= 15 && u.stations.length >= 180);
  t("梅田: 千里中央（北急は御堂筋線と直通）", has(u, "千里中央"));
  t("梅田: 住道（学研都市線→東西線 北新地）", has(u, "住道"));
  t("梅田: 宝塚（JR宝塚線・阪急宝塚線）・京都河原町（阪急京都線）・三ノ宮", has(u, "宝塚") && has(u, "京都河原町") && has(u, "三ノ宮"));
  t("梅田: 久宝寺（おおさか東線は大阪から）", has(u, "久宝寺"));
  t("梅田: 堺東・北千里・天下茶屋・鶴見緑地は乗り換えが要る", !has(u, "堺東") && !has(u, "北千里") && !has(u, "天下茶屋") && !has(u, "鶴見緑地"));
  t("梅田: 目的地のまとまり（大阪・北新地）は候補に入れない", !has(u, "大阪") && !has(u, "北新地"));

  const n = oneRideStations("なんば");
  t("なんば: 甲子園（近鉄奈良線⇔阪神の快速急行）", has(n, "甲子園"));
  t("なんば: 出屋敷は快速急行が止まらない（尼崎で乗り換え）", !has(n, "出屋敷"));
  t("なんば: 和泉中央（泉北線→南海高野線）・柏原（大和路線・JR難波）", has(n, "和泉中央") && has(n, "柏原"));
  t("なんば: 京橋は乗り換えが要る", !has(n, "京橋"));

  const tn = oneRideStations("天王寺");
  t("天王寺: 河内長野（近鉄長野線→南大阪線 阿部野橋）・和泉府中（阪和線）・住吉（阪堺上町線）", has(tn, "河内長野") && has(tn, "和泉府中") && has(tn, "住吉"));
  t("天王寺: 堺東は乗り換えが要る", !has(tn, "堺東"));

  const k = oneRideStations("京橋");
  t("京橋: 樟葉・中之島（京阪）・宝塚（JR宝塚線→東西線）・三ノ宮（JR神戸線→東西線）", has(k, "樟葉") && has(k, "中之島") && has(k, "宝塚") && has(k, "三ノ宮"));
  t("京橋: 梅田（阪急・阪神・地下鉄）は乗り換え、大阪（環状線）は一本", !has(k, "梅田") && has(k, "大阪"));

  const h = oneRideStations("本町");
  t(`本町: ${h?.stations.length}駅・新石切（中央線→けいはんな線）`, !!h && has(h, "新石切") && h.stations.length >= 45);
  t("本町: 京橋は乗り換えが要る", !has(h, "京橋"));

  const s = oneRideStations("新大阪");
  t("新大阪: 京都・三ノ宮（JR京都線⇔神戸線）・千里中央・久宝寺", has(s, "京都") && has(s, "三ノ宮") && has(s, "千里中央") && has(s, "久宝寺"));
  t("新大阪: 十三は乗り換えが要る", !has(s, "十三"));
}

console.log("■ ◯分以内の駅（stationsWithin・所要は駅の間の距離から・乗り換え5分）");
{
  const w = stationsWithin("梅田", 30, { maxTransfers: 1 })!;
  const get = (n: string) => w.stations.find((x) => x.station === n);
  t("十三 3分・乗換0", get("十三")?.minutes === 3 && get("十三")?.transfers === 0);
  t(`京橋 ${get("京橋")?.minutes}分・乗換0（環状線／東西線）`, (get("京橋")?.minutes ?? 99) <= 8 && get("京橋")?.transfers === 0);
  t(`なんば ${get("なんば")?.minutes}分・乗換0`, (get("なんば")?.minutes ?? 99) <= 10 && get("なんば")?.transfers === 0);
  t(`千里中央 ${get("千里中央")?.minutes}分・乗換0（直通）`, (get("千里中央")?.minutes ?? 99) <= 25 && get("千里中央")?.transfers === 0);
  t("堺東・三ノ宮・宝塚は30分を超える", !get("堺東") && !get("三ノ宮") && !get("宝塚"));
  t("分の短い順", w.stations.every((x, i, a) => i === 0 || a[i - 1].minutes <= x.minutes));
  t("乗換1回までに絞ると乗換2回の駅は無い", w.stations.every((x) => x.transfers <= 1));
  const w0 = stationsWithin("梅田", 30, { maxTransfers: 0 })!;
  const one = oneRideStations("梅田")!;
  t("乗り換えなし（maxTransfers 0）の駅は全部「一本」の駅", w0.stations.every((x) => one.stations.some((o) => o.station === x.station) || x.stops === 0));
  const w15 = stationsWithin("梅田", 15)!, w30 = stationsWithin("梅田", 30)!;
  t(`15分（${w15.stations.length}駅）⊂ 30分（${w30.stations.length}駅）`, w15.stations.every((x) => w30.stations.some((y) => y.station === x.station)));
  t("知らない目的地は null", stationsWithin("大和小泉", 30) === null);
}

console.log("■ 最短の乗り方（shortestRoute）の直し");
{
  const r1 = shortestRoute("京橋", "大阪");
  t(`京橋→大阪 ${r1?.minutes}分（環状線が輪になった・前は天王寺回り）`, !!r1 && r1.minutes <= 8 && r1.transfers === 0);
  const r2 = shortestRoute("宝塚", "梅田");
  t(`宝塚→梅田 JR宝塚線は大阪まで乗り換えなし（${r2?.minutes}分）`, !!r2 && r2.transfers === 0);
  const r3 = shortestRoute("出屋敷", "なんば");
  t("出屋敷→なんば 尼崎で乗り換え1回", !!r3 && r3.transfers === 1);
  const r4 = shortestRoute("甲子園", "なんば");
  t("甲子園→なんば 快速急行で乗り換えなし", !!r4 && r4.transfers === 0);
  t("梅田→北新地は同じ場所（0分）", shortestRoute("梅田", "北新地")?.minutes === 0);
}

console.log("■ 文から「◯◯まで一本／◯分／通勤」を読む");
{
  const f = (s: string) => commuteAsksInText(s).map((a) => [a.target, a.oneRide, a.minutes]);
  const eq = (name: string, a: unknown, b: unknown) => t(`${name} → ${JSON.stringify(a)}`, JSON.stringify(a) === JSON.stringify(b));
  eq("梅田まで電車1本", f("梅田まで電車1本"), [["梅田", true, null]]);
  eq("梅田まで電車で30分", f("梅田まで電車で30分"), [["梅田", false, 30]]);
  eq("大阪駅から30分以内（大阪＝梅田のまとまり）", f("大阪駅から30分以内"), [["梅田", false, 30]]);
  eq("梅田30分圏内", f("梅田30分圏内"), [["梅田", false, 30]]);
  eq("梅田まで三十分", f("梅田まで三十分"), [["梅田", false, 30]]);
  eq("JR大阪駅まで電車で25分以内", f("JR大阪駅まで電車で25分以内"), [["梅田", false, 25]]);
  eq("難波まで20分くらい", f("難波まで20分くらい"), [["なんば", false, 20]]);
  eq("京橋乗り換えなし", f("京橋乗り換えなし"), [["京橋", true, null]]);
  eq("本町直通", f("本町直通"), [["本町", true, null]]);
  eq("北新地にアクセスがいい（梅田のまとまり）", f("北新地にアクセスがいい"), [["梅田", false, null]]);
  eq("梅田(大阪)へ通勤しやすい", f("梅田(大阪)へ通勤しやすい"), [["梅田", false, null]]);
  eq("会社が淀屋橋にあり通勤しやすい所", f("会社が淀屋橋にあり通勤しやすい所"), [["淀屋橋", false, null]]);
  eq("同じ目的地はまとめる（一本＋北新地へ通勤）", f("梅田まで電車1本・北新地へ通勤"), [["梅田", true, null]]);
  eq("天王寺から徒歩10分は通勤ではない", f("天王寺から徒歩10分"), []);
  eq("車で15分は読まない", f("車で15分"), []);
  eq("大阪市内へ通勤（大阪駅ではない）", f("大阪市内へ通勤"), []);
  eq("川俣本町へ通勤（町名の本町）", f("川俣本町へ通勤"), []);
  eq("拡張でも同じ読み", ext.commuteAsks("梅田まで電車1本、なんばまで20分").map((a: { target: string; oneRide: boolean; minutes: number | null }) => [a.target, a.oneRide, a.minutes]), f("梅田まで電車1本、なんばまで20分"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
