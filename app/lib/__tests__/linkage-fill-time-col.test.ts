// npx tsx app/lib/__tests__/linkage-fill-time-col.test.ts
// 2026-11-28 作業員L: 連携の地図の fill の日付の列（created_at の無い表で「本番の記録を読めなかった」になっていた＝read.facts・read.fact_ledger3・sent.image_role）
import assert from "node:assert/strict";
import { fillTimeColOf, LINKAGE_MAP } from "../linkage-map";
assert.equal(fillTimeColOf("customer_fact_ledger"), "built_at");
assert.equal(fillTimeColOf("image_details"), "read_at");
assert.equal(fillTimeColOf("sent_properties"), "sent_at");
assert.equal(fillTimeColOf("cron_run_logs"), "started_at");
assert.equal(fillTimeColOf("messages"), "created_at");
const ids = (t: string) => LINKAGE_MAP.filter((r) => r.fill.src === "table" && r.fill.table === t).map((r) => r.id);
assert.ok(ids("customer_fact_ledger").includes("read.facts") && ids("customer_fact_ledger").includes("read.fact_ledger3"));
assert.ok(ids("image_details").includes("sent.image_role"));
console.log("linkage-fill-time-col ok 7");
