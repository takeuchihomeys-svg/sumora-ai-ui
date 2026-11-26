// 2026-11-26 作業員L（連携の一覧の3位「見積書ツール → 統括の入口」）: 入口の見積の1行（CONDUCTOR_INTAKE_ESTIMATE・既定 off）
// 実行: npx tsx app/lib/__tests__/intake-estimate-line.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { intakeEstimateLine, conductorIntakeEstimateOn } from "../estimate-records-block";
import { applyMaterialPriority, USED_MARKERS } from "../material-priority";
import { OWN_ROWS } from "../conductor-ownership";

const now = Date.parse("2026-11-26T03:00:00Z");
const rows = [
  { property_name: "Aハイツ", room_no: "301号室", initial_cost_yen: "250,000", discount_yen: 30000, created_at: "2026-11-20T03:00:00Z" },
  { property_name: "Bコーポ", room_no: "", initial_cost_yen: 300000, discount_yen: null, created_at: "2026-11-10T03:00:00Z" },
];
assert.equal(conductorIntakeEstimateOn({}), false, "既定 off");
assert.equal(conductorIntakeEstimateOn({ CONDUCTOR_INTAKE_ESTIMATE: "on" }), true);
assert.equal(intakeEstimateLine(rows, [], now), "【見積】11/20送付・Aハイツ 301号室・初期費用 250,000円・割引 30,000円（見積 2件）・11/20の見積の後、まだ返事なし（6日）", "一番新しい見積・まだ返事なし（N日）");
assert.match(intakeEstimateLine(rows, [{ sender: "customer", text: "家族と相談します", created_at: "2026-11-21T00:00:00Z" }], now), /見積の後: 家族と相談（1通）$/);
assert.match(intakeEstimateLine([{ ...rows[1] }], [], now), /初期費用 300,000円・11\/10/, "割引が無ければ出さない");
assert.equal(intakeEstimateLine([], [], now), "", "見積が無ければ空");
// 控えの行は動かさない（ブレインの材料の文には無い）
const r = applyMaterialPriority({ cs: "x", route: "y", blocks: [{ key: "intake_estimate", text: "【見積】…", from: "intake" }], keys: ["intake_estimate"], why: "t" });
assert.deepEqual(r.moved, []);
assert.equal(USED_MARKERS.intake_estimate({}), null);
assert.ok(OWN_ROWS.some((x) => x.key === "intake_estimate" && x.owner === "作業員L" && x.mark === "intake_estimate"), "受け持ち表の行");
const core = readFileSync(join(__dirname, "../brain-core.ts"), "utf8");
assert.ok(/erb\.conductorIntakeEstimateOn\(\) \|\| isPostApplyStatus\(convStatus\)/.test(core) && /materialBlocks\.push\(\{ key: "intake_estimate", text: ln, from: "intake" \}\)/.test(core), "入口の前の番の行に配線・申込以降は出さない");
console.log("intake-estimate-line ok 11");
