// 統括の指示書の材料の目録（台帳 #675 の続き・CONDUCTOR_MATERIAL_INDEX・app/lib/conductor-material-index.ts）と、統括の行の送った件数（SEND_COUNT_BY_ITEMS）
// 実行: npx tsx app/lib/__tests__/conductor-material-index.test.ts（全 PASS で exit 0）
import { buildMaterialIndex, gistOf, materialIndexText, conductorMaterialIndexOn, MATERIAL_INDEX_MAX, MATERIAL_INDEX_TEXT_MAX, materialIndexGapMode, materialGaps, EXPECTED } from "../conductor-material-index";
import { buildConductorBrief } from "../conductor-brief";
import { ourSideBlock, sendCountByItemsOn } from "../conductor-our-side";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, d: unknown = "") => { if (c) pass++; else { fail++; console.error(`✗ ${name}`, d); } };

ok("既定は on（記録だけ）・=off で止まる", conductorMaterialIndexOn({}) && !conductorMaterialIndexOn({ CONDUCTOR_MATERIAL_INDEX: "off" }));
ok("要点: 見出しの名前＋続き（24字まで）", gistOf("【時系列の帳面】来月の入居を考えている") === "時系列の帳面：来月の入居を考えている" && Array.from(gistOf("あ".repeat(50))).length === 24);
const idx = buildMaterialIndex({ status: "【状態】物件提案中", empty: "  ", customerState: "【状態の塊A】一つ目\n\n【状態の塊B】二つ目" }, { split: ["customerState"], marks: { ack_confirm: 40, status: 3 } });
ok("空の材料は載せない・まとめた塊は見出しごとに分ける・印は mark. で", idx.map((x) => x.k).join(",") === "status,customerState/状態の塊A,customerState/状態の塊B,mark.ack_confirm,mark.status", idx);
ok("上限の件数", buildMaterialIndex(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, `中身${i}`]))).length === MATERIAL_INDEX_MAX);
const big = buildMaterialIndex(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`material_${i}`, `【見出し${i}】${"中".repeat(40)}`])));
ok("文にした時の上限の字数", materialIndexText(big).length <= MATERIAL_INDEX_TEXT_MAX && materialIndexText(big).endsWith("・…") && materialIndexText([]) === "");

process.env.CONDUCTOR_MATERIAL_INDEX = "off"; delete process.env.BRIEF_READ_EXTRA;
const meta = { conductor_brief_inputs: { materials: idx } };
ok("=off の時は指示書に目録が無い（前と同じ）", buildConductorBrief(meta).extra === undefined);
delete process.env.CONDUCTOR_MATERIAL_INDEX;
const b = buildConductorBrief(meta);
ok("既定（on）: 指示書の extra.materials に目録（BRIEF_READ_EXTRA の3つは off のまま）", b.extra?.materials?.length === idx.length && b.extra?.basis === undefined && b.extra?.clash === undefined, b.extra);
ok("目録が無い番は extra を付けない", buildConductorBrief({}).extra === undefined);
delete process.env.CONDUCTOR_MATERIAL_INDEX;


// MATERIAL_INDEX_GAP（有るはずの材料の抜け・既定 shadow）
ok("MATERIAL_INDEX_GAP は既定 shadow・=off で止まる", materialIndexGapMode({}) === "shadow" && materialIndexGapMode({ MATERIAL_INDEX_GAP: "off" }) === "off" && materialIndexGapMode({ MATERIAL_INDEX_GAP: "on" }) === "on");
ok("表の行は3つ（送った物件・開いている約束・これからの内覧）", EXPECTED.map((r) => r.id).join(",") === "sent_props,promises_open,viewings");
const sn = { situation_now: { v: 1, sent: [{ kind: "properties_sent" }, { kind: "estimate_sent" }], promises_open: [{ promise_id: "p1" }], timeline: { words: [], viewings: [{ at: "x", type: "内覧", done: false }, { at: "y", type: "内覧", done: true }], promises: [] } } };
const full = [{ k: "sentProps", n: 300, g: "" }, { k: "promise", n: 120, g: "" }, { k: "customerState/お客様の今の状況", n: 400, g: "" }];
ok("証拠があって材料も有る＝抜け無し（内覧はお客様の状態の塊でも足りる）", materialGaps(sn, full).length === 0, materialGaps(sn, full));
const g = materialGaps(sn, [{ k: "status", n: 50, g: "" }]);
ok("証拠があるのに材料が無い＝3つとも抜け（証拠の件数つき）", g.map((x) => x.id).join(",") === "sent_props,promises_open,viewings" && g[0].evidence.includes("1件") && g[2].evidence.includes("1件") && g[0].got === 0, g);
ok("材料が短すぎる（下限未満）も抜け", materialGaps(sn, [...full.slice(1), { k: "sentProps", n: 5, g: "" }]).map((x) => x.id).join(",") === "sent_props");
ok("証拠が無ければ見ない・目録が無い番は見ない", materialGaps({ situation_now: { v: 1 } }, [{ k: "status", n: 5, g: "" }]).length === 0 && materialGaps(sn, []).length === 0);
ok("1番に max 件まで", materialGaps(sn, [{ k: "status", n: 5, g: "" }], 2).length === 2);
const bg = buildConductorBrief({ ...sn, conductor_brief_inputs: { materials: [{ k: "status", n: 50, g: "" }] } });
ok("指示書: 既定（shadow）で extra.material_gaps に残す・疑いの印には入れない", bg.extra?.material_gaps?.length === 3 && !bg.doubts.some((d) => String(d.kind) === "material_gap"), bg.extra);
process.env.MATERIAL_INDEX_GAP = "off";
ok("=off で抜けを残さない", buildConductorBrief({ ...sn, conductor_brief_inputs: { materials: [{ k: "status", n: 50, g: "" }] } }).extra?.material_gaps === undefined);
delete process.env.MATERIAL_INDEX_GAP;

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
