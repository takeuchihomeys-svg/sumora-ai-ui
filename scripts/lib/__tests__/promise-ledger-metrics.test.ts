// npx tsx scripts/lib/__tests__/promise-ledger-metrics.test.ts
// 2026-11-23 作業員L（台帳 #519）: 行動台帳の約束の開いている数・期日超え・72時間で閉じた割合
import assert from "node:assert/strict";
import { promiseStatesOf, summarizePromises, promiseMetricRows } from "../promise-ledger-metrics";

const now = Date.parse("2026-11-23T00:00:00Z");
const iso = (hAgo: number) => new Date(now - hAgo * 36e5).toISOString();
const rows = [
  // 100時間前の確認の約束 → 10時間後に報告（72時間の内に閉じた）
  { conversation_id: "a", kind: "confirmation_promised", status: "promised", sent_at: iso(100), evidence: "募集状況確認させて頂きます" },
  { conversation_id: "a", kind: "confirmation_reported", status: "done", sent_at: iso(90) },
  // 120時間前のピックアップの約束 → まだ（開いている・72時間を過ぎた＝期日超え）
  { conversation_id: "b", kind: "pickup_declared", status: "promised", sent_at: iso(120), evidence: "ピックアップしてお送りさせて頂きます" },
  // 10時間前の見積の約束 → closed_by の印（閉じた）
  { conversation_id: "c", kind: "estimate_declared", status: "promised", sent_at: iso(10), evidence: "御見積書お送りさせて頂きます", detail: { closed_by: "x" } },
  // 5時間前の確認の約束 → まだ（開いている・期日前）
  { conversation_id: "d", kind: "confirmation_promised", status: "promised", sent_at: iso(5), evidence: "確認させて頂きます" },
];
const s = summarizePromises(promiseStatesOf(rows), now);
assert.deepEqual(s, { open: 2, overdue: 1, madeWindow: 2, keptWindow: 1 });
const m = promiseMetricRows(s);
assert.deepEqual(m.map((r) => `${r.metric}=${r.value}/${r.n}`), ["foundation:promise:open=2/2", "foundation:promise:overdue_rate=50/2", "foundation:promise:kept_72h=50/2"]);
console.log("promise-ledger-metrics: ok");
