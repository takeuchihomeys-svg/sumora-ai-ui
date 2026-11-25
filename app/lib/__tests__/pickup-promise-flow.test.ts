// app/lib/__tests__/pickup-promise-flow.test.ts — 探す約束の後のお礼だけの番（竹内さんの決め 11/26）
//   実行: npx tsx app/lib/__tests__/pickup-promise-flow.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickupPromiseFlowOf, pickupPromiseFlowLine, brainPickupPromiseFlowOn } from "../pickup-promise-flow";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const T0 = Date.parse("2026-11-01T03:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const base = [
  { sender: "customer", text: "梅田周辺で1LDKお願いします", createdAt: at(0) },
  { sender: "staff", text: "梅田周辺全域から1LDKでオススメできるお部屋をピックアップしてお送りさせて頂きます！！", createdAt: at(5) },
  { sender: "customer", text: "ありがとうございます！", createdAt: at(10) },
];
const now = T0 + 11 * 60_000;
const r1 = pickupPromiseFlowOf(base, [], 3, now);
t("揃っている → ack_ready", r1.scene === "ack_ready" && r1.promised && !r1.fulfilled);
t("揃っていない → ack_not_ready", pickupPromiseFlowOf(base, [], 0, now).scene === "ack_not_ready");
t("候補の数が分からない時は場面にしない", pickupPromiseFlowOf(base, [], null, now).scene === null);
t("約束を果たした後は当たらない", pickupPromiseFlowOf(base, [{ aix_type: "property_send", sent_at: at(8) }], 3, now).scene === null);
t("お礼以外（問い）は当たらない", pickupPromiseFlowOf([...base.slice(0, 2), { sender: "customer", text: "駐車場はありますか？", createdAt: at(10) }], [], 3, now).scene === null);
t("1行: 揃っている時は物件ピックアップした・揃っていない時は受けの返信", pickupPromiseFlowLine(r1).includes("property_send") && pickupPromiseFlowLine(pickupPromiseFlowOf(base, [], 0, now)).includes("出来次第") && pickupPromiseFlowLine(null) === "");
t("既定 off", !brainPickupPromiseFlowOn({}) && brainPickupPromiseFlowOn({ BRAIN_PICKUP_PROMISE_FLOW: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ材料に入れる", bc.includes("ppf.brainPickupPromiseFlowOn() && !isPostApplyStatus(convStatus)") && bc.includes("materialMarks.pickup_promise_flow"));
console.log(`pickup-promise-flow: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
