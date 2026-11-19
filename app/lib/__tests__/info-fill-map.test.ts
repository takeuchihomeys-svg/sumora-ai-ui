// 「分かっている／分かっていない／古い」の土台（app/lib/info-fill-map.ts）のテスト
// 実行: npx tsx app/lib/__tests__/info-fill-map.test.ts
import { infoFillMapOn, fillInfo, infoFillForNode, infoFillMaterialLine, NEEDS_FOR_NEXT, INFO_KEYS } from "../info-fill-map";
import { ROUTE_NODES } from "../apply-route-map";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { if (c) pass++; else { fail++; console.log(`✗ ${n} ${d}`); } };
const now = Date.parse("2026-11-12T03:00:00Z");

ok("既定 off", infoFillMapOn({}) === false && infoFillMapOn({ INFO_FILL_MAP: "on" }) === true);
ok("駅は申込までの地図の全部", Object.keys(NEEDS_FOR_NEXT).sort().join() === Object.keys(ROUTE_NODES).sort().join());
ok("駅の要る物は項目の一覧の中だけ", Object.values(NEEDS_FOR_NEXT).every((ks) => ks.every((k) => (INFO_KEYS as readonly string[]).includes(k))));
{
  const pc = { desired_area: ["梅田", "福島"], rent_max: 80000, floor_plan: null, move_in_time: "10月中", updated_at: null };
  const cells = infoFillForNode("hearing", { nowMs: now, pc });
  const by = Object.fromEntries(cells.map((c) => [c.key, c]));
  ok("条件: エリア・家賃は分かっている", by.area.state === "known" && by.rent.state === "known", JSON.stringify(cells));
  ok("条件: 間取りは分かっていない", by.layout.state === "unknown");
  ok("条件: 入居時期「10月中」は11月には古い", by.move_in.state === "stale", JSON.stringify(by.move_in));
  const line = infoFillMaterialLine("hearing", cells, "条件ヒアリング");
  ok("材料の行は事実だけ（AIX・送る・約束の語なし）", /分かっていない: 間取り/.test(line) && /古い/.test(line) && !/AIX|送る|約束/.test(line), line);
}
ok("登録の条件の材料が無い（undefined）＝届いていない", fillInfo("area", { nowMs: now }).state === "unwired");
ok("登録の条件の行が無い（null）＝分かっていない", fillInfo("area", { nowMs: now, pc: null }).state === "unknown");
ok("「来年3月」は古くしない", fillInfo("move_in", { nowMs: now, pc: { move_in_time: "来年3月" } }).state === "known");
{
  const i = { nowMs: now, focusProperty: "グラン寝屋川 101号室", vacancyCheckedAt: "2026-11-01T00:00:00Z", estimateSent: false };
  const cells = infoFillForNode("interested", i);
  const by = Object.fromEntries(cells.map((c) => [c.key, c]));
  ok("気に入った物件は分かっている・募集状況は11日前で古い・見積はまだ", by.property_chosen.state === "known" && by.vacancy_checked.state === "stale" && by.estimate_sent.state === "unknown", JSON.stringify(cells));
}
ok("全部分かっている駅は空", infoFillMaterialLine("viewing_scheduled", infoFillForNode("viewing_scheduled", { nowMs: now, viewingDate: "11/15 15:00" })) === "");
ok("駅が決まらなければ空", infoFillMaterialLine(null, []) === "");
ok("申込の情報: フォーマットを送っただけは分かっていない", fillInfo("apply_form", { nowMs: now, applyForm: "form_sent" }).state === "unknown" && fillInfo("apply_form", { nowMs: now, applyForm: "received" }).state === "known");
console.log(`info-fill-map: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
