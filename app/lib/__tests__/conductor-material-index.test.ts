// 統括の指示書の材料の目録（台帳 #675 の続き・CONDUCTOR_MATERIAL_INDEX・app/lib/conductor-material-index.ts）と、統括の行の送った件数（SEND_COUNT_BY_ITEMS）
// 実行: npx tsx app/lib/__tests__/conductor-material-index.test.ts（全 PASS で exit 0）
import { buildMaterialIndex, gistOf, materialIndexText, conductorMaterialIndexOn, MATERIAL_INDEX_MAX, MATERIAL_INDEX_TEXT_MAX } from "../conductor-material-index";
import { buildConductorBrief } from "../conductor-brief";
import { ourSideBlock, sendCountByItemsOn } from "../conductor-our-side";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

ok("既定は off", !conductorMaterialIndexOn({}) && conductorMaterialIndexOn({ CONDUCTOR_MATERIAL_INDEX: "on" }));
ok("要点: 見出しの名前＋続き（24字まで）", gistOf("【時系列の帳面】来月の入居を考えている") === "時系列の帳面：来月の入居を考えている" && Array.from(gistOf("あ".repeat(50))).length === 24);
const idx = buildMaterialIndex({ status: "【状態】物件提案中", empty: "  ", customerState: "【状態の塊A】一つ目\n\n【状態の塊B】二つ目" }, { split: ["customerState"], marks: { ack_confirm: 40, status: 3 } });
ok("空の材料は載せない・まとめた塊は見出しごとに分ける・印は mark. で", idx.map((x) => x.k).join(",") === "status,customerState/状態の塊A,customerState/状態の塊B,mark.ack_confirm,mark.status", idx);
ok("上限の件数", buildMaterialIndex(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, `中身${i}`]))).length === MATERIAL_INDEX_MAX);
const big = buildMaterialIndex(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`material_${i}`, `【見出し${i}】${"中".repeat(40)}`])));
ok("文にした時の上限の字数", materialIndexText(big).length <= MATERIAL_INDEX_TEXT_MAX && materialIndexText(big).endsWith("・…") && materialIndexText([]) === "");

delete process.env.CONDUCTOR_MATERIAL_INDEX; delete process.env.BRIEF_READ_EXTRA;
const meta = { conductor_brief_inputs: { materials: idx } };
ok("off の時は指示書に目録が無い（今と同じ）", buildConductorBrief(meta).extra === undefined);
process.env.CONDUCTOR_MATERIAL_INDEX = "on";
const b = buildConductorBrief(meta);
ok("on: 指示書の extra.materials に目録（BRIEF_READ_EXTRA の3つは off のまま）", b.extra?.materials?.length === idx.length && b.extra?.basis === undefined && b.extra?.clash === undefined, b.extra);
ok("on でも目録が無い番は extra を付けない", buildConductorBrief({}).extra === undefined);
delete process.env.CONDUCTOR_MATERIAL_INDEX;

// SEND_COUNT_BY_ITEMS
const now = Date.parse("2026-11-24T10:00:00Z");
const aix = [
  { aix_type: "property_send", created_at: "2026-11-24T05:00:00Z", sent_at: "2026-11-24T05:00:00Z", property_names: ["A", "B", "C", "D"] },
  { aix_type: "property_send", created_at: "2026-11-23T05:00:00Z", sent_at: "2026-11-23T05:00:00Z", property_names: ["E", "F"] },
];
ok("SEND_COUNT_BY_ITEMS は既定 off", !sendCountByItemsOn({}) && sendCountByItemsOn({ SEND_COUNT_BY_ITEMS: "on" }));
const off = ourSideBlock({ msgs: [], aix, nowMs: now, withChecked: false });
ok("off: 束 N回 のまま（件数を付けない）", off.includes("束 2回・") && !off.includes("計 "), off);
process.env.SEND_COUNT_BY_ITEMS = "on";
const on = ourSideBlock({ msgs: [], aix, nowMs: now, withChecked: false });
ok("on: 束 2回（計 6件）", on.includes("束 2回（計 6件）・"), on);
ok("on でも物件名の無い送付だけなら件数を付けない", !ourSideBlock({ msgs: [], aix: [{ aix_type: "property_send", created_at: "2026-11-24T05:00:00Z" }], nowMs: now, withChecked: false }).includes("計 "));
delete process.env.SEND_COUNT_BY_ITEMS;

console.log(`conductor-material-index: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
