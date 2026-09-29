// 2026-09-29 通勤の到達時間で駅を選ぶ（commute-reach-core / commute-reach / 到達時間の表）のテスト
// 実行: npx tsx app/lib/__tests__/commute-reach.test.ts
// 条件の文は property_customers の desired_area・通勤の列の実物の言い回し（名前・電話・番地は無い）
import { commuteReachPlan, stationsReachable, reachAudit, reachSummary, readTargets, serverTransit, SERVER_DEPS } from "../commute-reach";
import { concreteAreaTokens, precedingTargets, DEFAULT_MAX_STATIONS } from "../commute-reach-core";
import { COMMUTE_REACH_TABLE, COMMUTE_REACH_TABLE_MAX_MINUTES, COMMUTE_REACH_TARGETS } from "../commute-reach-table";
import { stationsWithin } from "../transit-route";
import { runSearchAuditChecks, type AuditInput } from "../search-audit-check";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T = serverTransit();
const has = (plan: ReturnType<typeof commuteReachPlan>, s: string) => !!plan && plan.extStations.includes(s);

console.log("■ 到達時間の表（決定論・その場の計算と同じ）");
{
  t(`主な目的の駅 ${COMMUTE_REACH_TARGETS.length} 件（梅田・なんば・天王寺・本町・京橋・新大阪 を含む）`, ["梅田", "なんば", "天王寺", "本町", "京橋", "新大阪"].every((k) => COMMUTE_REACH_TARGETS.includes(k)));
  for (const k of ["梅田", "なんば", "天王寺"]) {
    const live = stationsWithin(k, COMMUTE_REACH_TABLE_MAX_MINUTES, { maxTransfers: 1 })!.stations.map((s) => [s.station, s.minutes, s.transfers]);
    t(`${k}: 表＝その場の計算（${live.length}駅）`, JSON.stringify(live) === JSON.stringify(COMMUTE_REACH_TABLE[k]));
  }
  const r30 = stationsReachable("大阪梅田", 30)!;
  const m = new Map(r30.map((x) => [x.station, x.minutes]));
  t(`梅田まで30分: ${r30.length}駅・分の短い順`, r30.length > 200 && r30.every((x, i, a) => i === 0 || a[i - 1].minutes <= x.minutes));
  t("十三3分・京橋6分・新大阪5分・なんば8分・天王寺14分・尼崎10分・江坂11分（乗り換えなし）", [["十三", 3], ["京橋", 6], ["新大阪", 5], ["なんば", 8], ["天王寺", 14], ["尼崎", 10], ["江坂", 11]].every(([s, n]) => m.get(s as string) === n));
  t("千里中央（北急直通）・住道（東西線→学研都市線）・豊中・茨木市・伊丹 は30分で入る", ["千里中央", "住道", "豊中", "茨木市", "伊丹"].every((s) => m.has(s)));
  t("高槻市・堺東・河内長野・なかもず・枚方市 は30分に入らない（各停の目安）", ["高槻市", "堺東", "河内長野", "なかもず", "枚方市"].every((s) => !m.has(s)));
  t("乗り換え1回の別の沿線の駅も入る（蒲生四丁目＝長堀鶴見緑地線・野田阪神＝千日前線・堺筋本町）", ["蒲生四丁目", "野田阪神", "堺筋本町"].every((s) => m.has(s)) && r30.find((x) => x.station === "蒲生四丁目")!.transfers === 1);
  t("目的の駅そのもの（大阪・西梅田）は表に無い", !m.has("大阪") && !m.has("西梅田") && !m.has("梅田"));
  t("表に無い目的の駅（枚方市）はその場で出す", (stationsReachable("枚方市", 20) ?? []).some((x) => x.station === "香里園"));
  t("路線図に無い駅は null", stationsReachable("存在しない駅", 30) === null);
  const r60 = stationsReachable("梅田", 60)!;
  t("表の上限（45分）を超える分もその場で出す（60分で高槻市が入る）", r60.some((x) => x.station === "高槻市"));
}

console.log("■ 目的の駅と分の読み（実物の言い回し）");
{
  const tg = (input: Parameters<typeof readTargets>[0]) => readTargets(input, T).map((x) => `${x.target}:${x.minutes}:${x.source}`);
  t("「難波駅・梅田駅まで電車で30分以内で行ける距離」→ なんば30・梅田30（前に並んだ駅も目的）", JSON.stringify(tg({ desired_area: "難波駅・梅田駅まで電車で30分以内で行ける距離" })) === JSON.stringify(["梅田:30:text", "なんば:30:text"]));
  t("「なんば駅まで30分圏内(南方では無く大阪市内に近い方)」→ なんば30", JSON.stringify(tg({ desired_area: "なんば駅まで30分圏内(南方では無く大阪市内に近い方)" })) === JSON.stringify(["なんば:30:text"]));
  t("「日本橋又は谷町九丁目通勤20分圏内」→ 谷町九丁目（上本町のまとまり）20・日本橋20", JSON.stringify(tg({ desired_area: "日本橋又は谷町九丁目通勤20分圏内" })) === JSON.stringify(["上本町:20:text", "日本橋:20:text"]));
  t("「梅田から20分以内」→ 梅田20／「江坂、江坂まで20分くらいの駅」→ 江坂20", JSON.stringify(tg({ desired_area: "梅田から20分以内" })) === JSON.stringify(["梅田:20:text"]) && JSON.stringify(tg({ desired_area: "江坂、江坂まで20分くらいの駅" })) === JSON.stringify(["江坂:20:text"]));
  t("「西九条駅から45分以内、大和小泉駅から45分以内」→ 西九条45（大和小泉は路線図に無い）", JSON.stringify(tg({ desired_area: "西九条駅から45分以内、大和小泉駅から45分以内" })) === JSON.stringify(["西九条:45:text"]));
  t("通勤の列（難波駅・15）→ なんば15:column", JSON.stringify(tg({ commute_station: "難波駅", commute_minutes: 15, desired_area: "難波周辺" })) === JSON.stringify(["なんば:15:column"]));
  t("通勤の列（大阪駅・梅田エリア・40）→ 梅田40（大阪と梅田は同じまとまり）", JSON.stringify(tg({ commute_station: "大阪駅・梅田エリア", commute_minutes: 40, desired_area: "大日駅" })) === JSON.stringify(["梅田:40:column"]));
  t("通勤の列（難波駅・梅田駅・40）→ なんば40・梅田40", JSON.stringify(tg({ commute_station: "難波駅・梅田駅", commute_minutes: 40, desired_area: "大阪市内" })) === JSON.stringify(["梅田:40:column", "なんば:40:column"]));
  t("列と文が同じ目的なら短い方（列40・文30 → 30）", JSON.stringify(tg({ commute_station: "梅田", commute_minutes: 40, desired_area: "梅田まで電車で30分" })) === JSON.stringify(["梅田:30:text"]));
  t("列「市内」・分なし・「梅田まで電車1本」・「天王寺へ通勤」は目的にしない", tg({ commute_station: "市内", commute_minutes: 30 }).length === 0 && tg({ commute_station: "天王寺駅", desired_area: "御堂筋線" }).length === 0 && tg({ desired_area: "梅田まで電車1本" }).length === 0 && tg({ desired_area: "天王寺へ通勤" }).length === 0);
  t("徒歩・自転車・車の「◯分」は読まない", tg({ desired_area: "梅田まで徒歩20分" }).length === 0 && tg({ desired_area: "堺筋本町駅から車で15分圏内" }).length === 0 && tg({ desired_area: "難波から自転車15分以内" }).length === 0);
  t("precedingTargets: 「難波駅・」→ なんば／「東大阪、太子橋、清水、」→ 太子橋・清水（東大阪は駅でない）", JSON.stringify(precedingTargets("難波駅・梅田駅まで30分", 4, T)) === JSON.stringify(["なんば"]) && JSON.stringify(precedingTargets("東大阪、太子橋、清水、梅田まで電車30分", 11, T)) === JSON.stringify(["太子橋今市", "清水"]));
}

console.log("■ 希望エリアが具体的か（列だけの時に広げるか）");
{
  const tgt = readTargets({ commute_station: "難波駅", commute_minutes: 15 }, T);
  t("「難波周辺」→ 具体的でない（周辺）", concreteAreaTokens("難波周辺", tgt, T).length === 0);
  t("「大日駅」→ 具体的", JSON.stringify(concreteAreaTokens("大日駅", tgt, T)) === JSON.stringify(["大日駅"]));
  t("「大阪市内」「（空）」「特になし」→ 具体的でない", concreteAreaTokens("大阪市内", tgt, T).length === 0 && concreteAreaTokens("", tgt, T).length === 0 && concreteAreaTokens("特になし", tgt, T).length === 0);
  t("「難波駅」（目的の駅そのもの）→ 具体的でない", concreteAreaTokens("難波駅", tgt, T).length === 0);
  t("「淀川区（柴島、新大阪、三国）、天六周辺」→ 淀川区・柴島・新大阪・三国 が具体的", JSON.stringify(concreteAreaTokens("淀川区（柴島、新大阪、三国）、天六周辺", tgt, T)) === JSON.stringify(["淀川区", "柴島", "新大阪", "三国"]));
}

console.log("■ 検索に入れる駅（planCommuteReach）");
{
  const p1 = commuteReachPlan({ commute_station: "市内", commute_minutes: 30, desired_area: "難波駅・梅田駅まで電車で30分以内で行ける距離" });
  t(`8393580f の実物: なんば30＋梅田30 の和集合 ${p1?.extStations.length}駅（上限で切る）・路線 ${p1?.lines.length}`, !!p1 && p1.capped && p1.extStations.length === DEFAULT_MAX_STATIONS && p1.total > 300 && p1.lines.length >= 30);
  t("目的の駅そのもの（梅田・大阪・西梅田・北新地・なんば）が0分で入る", ["梅田", "大阪", "西梅田", "北新地", "なんば"].every((s) => has(p1, s)) && p1!.stations[0].minutes === 0);
  t("十三・江坂・天王寺・住之江公園（なんば12）が入り、高槻市・河内長野は入らない", ["十三", "江坂", "天王寺", "住之江公園"].every((s) => has(p1, s)) && !has(p1, "高槻市") && !has(p1, "河内長野"));
  t("分の短い順に切っている（切った後の最後の駅の分 ≧ 入れた駅の全部の分）", p1!.stations.every((s) => s.minutes <= p1!.stations[p1!.stations.length - 1].minutes));
  t("路線ごとの区間（御堂筋線: 江坂〜北花田 の並びの中）", (() => { const sg = p1!.segments.find((s) => s.line === "大阪市高速軌道御堂筋線"); return !!sg && sg.from === "江坂" && !!sg.to && sg.count >= 15; })());
  const a1 = reachAudit(p1)!;
  t("点検の記録の形（駅名は載せない・数だけ）", a1.stations === DEFAULT_MAX_STATIONS && a1.capped && a1.targets.length === 2 && a1.transfers === 1 && a1.skipped === null && !("extStations" in a1));
  t("ログの1行", /梅田まで30分・なんばまで30分（乗り換え1回まで）→ 240駅・\d+路線（\d+駅を上限で切った）/.test(reachSummary(p1)));

  const p2 = commuteReachPlan({ commute_station: "難波駅", commute_minutes: 15, desired_area: "難波周辺" });
  t(`09db1fee の実物（列 難波15・「難波周辺」）: 広げる ${p2?.extStations.length}駅（旧は3駅）`, !!p2 && !p2.skipped && p2.extStations.length >= 90 && has(p2, "心斎橋") && has(p2, "天王寺") && has(p2, "西梅田") && !has(p2, "江坂"));

  const p3 = commuteReachPlan({ commute_station: "大阪駅・梅田エリア", commute_minutes: 40, desired_area: "大日駅" });
  t("dbb17e27 の実物（列 梅田40・「大日駅」）: 希望エリアが具体的なので広げない（skipped=concrete_area・記録には残る）", !!p3 && p3.skipped === "concrete_area" && p3.extStations.length === 0 && reachAudit(p3)!.skipped === "concrete_area" && /広げない/.test(reachSummary(p3)));

  const p4 = commuteReachPlan({ desired_area: "東大阪、太子橋、清水、梅田まで電車30分" });
  t("希望エリアの文に通勤の言い方がある時は具体的な地名があっても広げる（今まで通り）", !!p4 && !p4.skipped && p4.extStations.length > 100 && JSON.stringify(p4.concrete) === JSON.stringify(["東大阪"]));

  const p5 = commuteReachPlan({ desired_area: "梅田から20分以内" }, { maxTransfers: 0 });
  t("乗り換えなし（maxTransfers 0）は同じ沿線だけ", !!p5 && has(p5, "十三") && !has(p5, "野田阪神") && p5.maxTransfers === 0);
  t("通勤の分が無い時は null", commuteReachPlan({ desired_area: "御堂筋線" }) === null && commuteReachPlan({ commute_station: "天王寺駅" }) === null && commuteReachPlan({}) === null);
  const p6 = commuteReachPlan({ desired_area: "江坂、江坂まで20分くらいの駅" });
  t("「江坂、江坂まで20分くらいの駅」: 目的の駅そのものは具体的な場所に数えない → 広げる", !!p6 && !p6.skipped && has(p6, "新大阪") && has(p6, "千里中央"));
  t("SERVER_DEPS: 路線→駅の並び・駅→路線", SERVER_DEPS.lineOrderOf!("大阪市高速軌道御堂筋線")[0] === "江坂" && (SERVER_DEPS.extLinesOf("東梅田") ?? []).length >= 1);
}

console.log("■ 点検の札 COMMUTE_REACH（search-audit-check・点検の記録の実物の形）");
{
  const codes = (a: AuditInput) => runSearchAuditChecks(a, Date.now()).checks.filter((c) => c.code === "COMMUTE_REACH");
  const snap = { desired_area: "難波駅・梅田駅まで電車で30分以内で行ける距離", area_mode: "station", rent_max: 80000, commute_station: "市内", commute_minutes: 30 };
  const many = Array.from({ length: 240 }, (_, i) => `駅${i}`);
  const c1 = codes({ site: "realpro", status: "finished", customer_snapshot: snap, intended: { area_mode: "station", station_names: many, route_ids: ["6701"], commute: { targets: [{ target: "梅田", minutes: 30, source: "text" }, { target: "なんば", minutes: 30, source: "text" }], stations: 240, total: 331, capped: true, lines: 37, transfers: 1, skipped: null } }, filled: { search_clicked: true }, result: { property_count: 41 } });
  t("到達時間で選んだ回は ok の札（駅名は載せない・数だけ）", c1.length === 1 && c1[0].severity === "ok" && /梅田まで30分・なんばまで30分・240駅・37路線/.test(c1[0].title) && /331駅を上限で切った/.test(c1[0].detail));
  const c2 = codes({ site: "realpro", status: "finished", customer_snapshot: { desired_area: "大日駅", area_mode: "station", commute_station: "大阪駅・梅田エリア", commute_minutes: 40 }, intended: { area_mode: "station", station_names: ["大日", "守口"], commute: { targets: [{ target: "梅田", minutes: 40, source: "column" }], stations: 0, total: 0, capped: false, lines: 0, transfers: 1, skipped: "concrete_area" } }, filled: { search_clicked: true }, result: { property_count: 10 } });
  t("広げなかった回（concrete_area）は ok で理由を残す", c2.length === 1 && c2[0].severity === "ok" && /広げなかった/.test(c2[0].title) && /具体的/.test(c2[0].detail));
  const c3 = codes({ site: "realpro", status: "finished", customer_snapshot: snap, intended: { area_mode: "station", station_names: ["難波", "なんば", "梅田"], route_ids: ["6701"] }, filled: { search_clicked: true }, result: { property_count: 0 } });
  t("8393580f の実物（旧の拡張・駅3）: 通勤の条件があるのに広げていない → warn", c3.length === 1 && c3[0].severity === "warn" && c3[0].cause_key === "commute_reach:realpro:not_expanded");
  const c4 = codes({ site: "realpro", status: "finished", customer_snapshot: { desired_area: "御堂筋線", area_mode: "station", commute_station: "天王寺駅" }, intended: { area_mode: "station", station_names: ["江坂", "東三国"] }, filled: { search_clicked: true }, result: { property_count: 100 } });
  t("通勤の分が無い（列に駅だけ）・通勤の言い方が無い回は札なし", c4.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
