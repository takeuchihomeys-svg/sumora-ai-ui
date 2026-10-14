// app/lib/__tests__/second-material-saved-read.test.ts — 物件オススメの2通目の材料を保存した読みから作る（純関数）
// 実行: npx tsx app/lib/__tests__/second-material-saved-read.test.ts
import { pickSavedReadForHead, secondRowFromSavedRead, savedReadFitLines, appendSavedReadLines, secondMaterialSavedReadEnabled } from "../second-material-saved-read";
import { buildSecondMaterialNote, unfoundedCostClaim } from "../second-message-scene";
import { buildAppealPoints } from "../recommend-appeal-points";
import { customerWants } from "../recommendation-gaps";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info === undefined ? "" : JSON.stringify(info)); } };

// 実物の形（sent_image_properties.facts）
const F = { src: "image", rent: 50000, floor: 1, status: "open", room_no: "102", station: "住吉", area_sqm: 19.36, built_ym: "2014-03", stations: [{ line: null, walk: 14, station: "住吉" }], floor_plan: "1R", building_age: 12, walk_minutes: 14, admin_fee_yen: 3000, deposit_months: 0, key_money_months: 0 };
const rows: any[] = [
  { property_name: "エスリード南堀江", room_no: "1105", facts: { ...F, room_no: "1105" }, created_at: "2026-10-01T00:00:00Z" },
  { property_name: "ルミエール住吉", room_no: "102", facts: F, created_at: "2026-10-02T00:00:00Z" },
  { property_name: "ルミエール住吉", room_no: "0102", facts: { ...F, rent: 51000 }, created_at: "2026-10-03T00:00:00Z" },
  { property_name: "ルミエール住吉", room_no: "203", facts: F, created_at: "2026-10-04T00:00:00Z" },
];

t("既定 on・off で旧", secondMaterialSavedReadEnabled({}) && !secondMaterialSavedReadEnabled({ SECOND_MATERIAL_SAVED_READ: "off" }));
{
  const h = pickSavedReadForHead(rows, { name: "ルミエール住吉", room: "102" });
  t("号室（頭の0を外して）と建物名の頭で当てる・一番新しい物", h?.facts?.rent === 51000, h);
  t("号室が違えば当てない", pickSavedReadForHead(rows, { name: "ルミエール住吉", room: "305" }) === null);
  t("建物名が違えば当てない", pickSavedReadForHead(rows, { name: "グランパシフィック", room: "102" }) === null);
  t("見出しが無ければ null", pickSavedReadForHead(rows, null) === null);
}
{
  const c = secondRowFromSavedRead(F as never)!;
  const note = buildSecondMaterialNote(c.row);
  t("駅・築年・敷礼なしが既存の注記の形で出る", /住吉駅 徒歩14分/.test(note) && /2014年3月築/.test(note) && /敷金・礼金: どちらもなし/.test(note), note);
  t("現況は入れない（退去予定・空室の行が出ない）", !/現況/.test(note), note);
  t("間取り・家賃は渡さない（2通目が並べて長くなる・竹内さんの2通目は1通目の値だけ）", c.extraLines.length === 0 && !/1R|50,000/.test(note), c.extraLines);
  t("敷礼なしと書いた時の出口: 敷礼0 なので止めない", unfoundedCostClaim("敷金礼金なしで初期費用を抑える事ができ", c.row, "") === null);
}
{
  const c = secondRowFromSavedRead({ ...F, key_money_months: 1 } as never)!;
  t("礼金ありの読みでは止めない（読み違い・キャンペーンで正しい文を止めない）・敷礼の行も出さない", unfoundedCostClaim("敷金礼金なしで初期費用を抑える事ができ", c.row, "🌟ルミエール住吉 102") === null && !/敷金・礼金/.test(buildSecondMaterialNote(c.row)));
  const c2 = secondRowFromSavedRead({ ...F, key_money_months: undefined, key_money_yen: 50000 } as never)!;
  t("礼金が月数で読めない時は敷礼を書かない側（terms に入れない）", !/敷金・礼金/.test(buildSecondMaterialNote(c2.row)) && unfoundedCostClaim("敷金礼金なし", c2.row, "") === null);
}
{
  const wants = customerWants({ conditions: { walk_minutes: 10, preferences: "敷金礼金なし" } as never });
  const lines = savedReadFitLines(buildAppealPoints(F as never, wants, { walkMax: 10 }));
  t("希望と照らす: 敷礼なしは合う・徒歩10分以内は満たさない", lines.some((l) => /ご希望に合う点.*敷金礼金なし/.test(l)) && lines.some((l) => /満たさない所.*駅/.test(l)), lines);
}
{
  const c = secondRowFromSavedRead({ ...F, deposit_unit: "unclear" } as never)!;
  t("敷金の単位が決まらない読み（unclear）は敷礼を渡さない", !/敷金・礼金/.test(buildSecondMaterialNote(c.row)));
}
t("注記が空でも追加の行だけで見出しつき", /^【1通目の物件の資料の事実/.test(appendSavedReadLines("", ["・間取り・広さ（資料の読み）: 1K"])));
t("追加の行が無ければ元のまま", appendSavedReadLines("ABC", []) === "ABC");
t("空の読みは null", secondRowFromSavedRead({} as never) === null && secondRowFromSavedRead(null) === null);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
