// 2026-10-14 竹内さん「日本の建物の号室は先頭の0を読まない（0704→704・00101→101）。照合・表示・記録のすべてで同じ形に。号室の化け（1O1 等）も」
// 実行: npx tsx app/lib/__tests__/room-no.test.ts
import { canonicalRoomNo, canonicalRoomLabel } from "../room-no";
import { parseLoose, matchLoose } from "../property-name-loose";
import { parseReadResult } from "../property-image-read";
import { aixPropertyNamesForLog, namesNearSend, reconcileAixPropertyNames } from "../aix-sent-names";
import { normalizeRoomNo } from "../sent-property-record";

let passed = 0, failed = 0;
function t(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ""}`); }
}
console.log("■ 号室の形");
for (const [a, b] of [["0704", "704"], ["00101", "101"], ["00201号室", "201"], ["0302 号室", "302"], ["１０１", "101"], ["502", "502"], ["1O1", "101"], ["I01", "101"], ["0l03", "103"], ["B-0102", "B-102"], ["a203", "A203"], ["3C", "3C"], ["000", "0"], ["", ""]] as const) {
  t(`${a} → ${b}`, canonicalRoomNo(a, {}) === b, canonicalRoomNo(a, {}));
}
t("号室でない字（II）はそのまま", canonicalRoomNo("II", {}) === "II");
t("階の文はそのまま", canonicalRoomNo("2階8号室", {}) === "2階8");
t("戻す ROOM_NO_CANONICAL=off", canonicalRoomNo("0704", { ROOM_NO_CANONICAL: "off" }) === "0704");
console.log("■ 名前の号室だけそろえる");
for (const [a, b] of [["Comforza 0302号室", "Comforza 302号室"], ["メインステージ新大阪 0602号室", "メインステージ新大阪 602号室"], ["グランコート 00201号室", "グランコート 201号室"], ["エスリード新大阪0208号室", "エスリード新大阪208号室"], ["SOL 1O1号室", "SOL 101号室"], ["Luxe難波西2", "Luxe難波西2"], ["CASA1203号室", "CASA1203号室"], ["ハイツ秋桜 2階8号室", "ハイツ秋桜 2階8号室"], ["S-RESIDENCE江坂Eminence601", "S-RESIDENCE江坂Eminence601"]] as const) {
  t(`${a} → ${b}`, canonicalRoomLabel(a, {}) === b, canonicalRoomLabel(a, {}));
}
console.log("■ 照合・記録で同じ形");
t("照合: 0704 と 704 は同じ部屋（前から）", matchLoose("ウインズコート西中島 0704号室", "ウインズコート西中島 704号室") === "same_room");
t("照合: 1O1 と 101 は同じ部屋（化け）", matchLoose("セレニテ梅田 1O1号室", "セレニテ梅田 101号室") === "same_room", parseLoose("セレニテ梅田 1O1号室"));
t("照合: 101 と 102 は別の部屋", matchLoose("セレニテ梅田 101号室", "セレニテ梅田 102号室") === "different_room");
t("normalizeRoomNo と同じ（数字だけの号室）", ["0704", "00101", "502"].every((r) => normalizeRoomNo(r) === canonicalRoomNo(r, {})));
const rr = parseReadResult(JSON.stringify({ items: [{ property_name: "エストドミール東中浜", room_number: "00201" }], is_property: true }));
t("読み取りの号室（00201→201）", rr.items[0]?.roomNumber === "201", rr.items[0]);
t("送付の記録の名前（room_no 00201）", namesNearSend([{ property_name: "エストドミール東中浜", room_no: "00201", sent_at: "2026-10-14T00:00:10Z" }], "2026-10-14T00:00:00Z").join() === "エストドミール東中浜 201号室");
const ax = aixPropertyNamesForLog({ aixType: "estimate_sheet", text: "【Comforza 0302号室】\n\n初期費用…" }, {});
t("AIX の記録の名前（見積書の【】）", ax.join() === "Comforza 302号室", ax);
const rc = reconcileAixPropertyNames(["メインステージ新大阪 0602号室"], "メインステージ新大阪 602号室の募集状況確認させて頂きました！！", () => false, {}, "property_check_result");
t("画面の欄の名前も同じ形で記録（数と並びは同じ）", rc.names?.join() === "メインステージ新大阪 602号室" && rc.changed === false, rc);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
