// app/lib/__tests__/area-station-fix.test.ts — 路線名の付いた駅名・旧字を駅の表の名前に直す（実物の読み取りの形）
// 実行: npx tsx app/lib/__tests__/area-station-fix.test.ts
import { fixStationName, buildPropertyLocation } from "../area-want";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info === undefined ? "" : JSON.stringify(info)); } };

t("御堂筋線東三国 → 東三国", fixStationName("御堂筋線東三国") === "東三国");
t("今里筋線鴫野 → 鴫野（今里にしない）", fixStationName("今里筋線鴫野") === "鴫野", fixStationName("今里筋線鴫野"));
t("大板メトロ千日前線小路 → 小路（誤字の前置きも最後の線で切る）", fixStationName("大板メトロ千日前線小路") === "小路");
t("大國町 → 大国町", fixStationName("大國町") === "大国町");
t("長堀鶴見緑地（路線名だけ）は直さない", fixStationName("長堀鶴見緑地") === "長堀鶴見緑地");
t("表にある駅はそのまま", fixStationName("東三国") === "東三国");
t("戻す: AREA_STATION_LINE_PREFIX=off", fixStationName("御堂筋線東三国", { AREA_STATION_LINE_PREFIX: "off" }) === "御堂筋線東三国");
const loc = buildPropertyLocation("x\n御堂筋線「御堂筋線東三国」徒歩5分", null);
t("場所: 東三国の位置と区が付く", loc.stations[0]?.station === "東三国" && loc.stations[0].known && !!loc.point, loc);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
