// npx tsx scripts/lib/__tests__/unfinished-audit.test.ts
// 2026-11-27 作業員L（抜けの棚卸し・竹内さん 11/27）
import assert from "node:assert/strict";
import { areaOf, impactOf, decisionsWithoutLedger, stalledLedger, rankUnfinished, countByArea, unfinishedLedgerTitle, type KbDecision, type LedgerRow } from "../unfinished-audit";
assert.equal(areaOf("拡張の次客の検索"), "物件検索");
assert.equal(areaOf("AIX【物件確認した】の2通目"), "AIX");
assert.equal(areaOf("統括の土台"), "統括");
assert.equal(areaOf("返信の締め"), "返信");
assert.equal(areaOf("なにか"), "その他");
assert.equal(impactOf({ priority: 0, text: "" }), "高");
assert.equal(impactOf({ priority: 1, text: "" }), "中");
assert.equal(impactOf({ priority: null, text: "竹内さん「かなり重要」" }), "高");
assert.equal(impactOf({ priority: null, text: "" }), "低");
const k = (o: Partial<KbDecision> & { id: string }): KbDecision => ({ title: "【決定】x", tags: [], applied_to: null, priority: 1, created_at: "2026-11-10T00:00:00Z", ...o });
const l = (o: Partial<LedgerRow> & { id: number }): LedgerRow => ({ title: "t", stage: "todo", owner: "作業員L", switch_name: null, kb_ids: null, next_step: null, requested_at: "2026-11-01T00:00:00Z", lastAt: "2026-11-20T00:00:00Z", priority: null, ...o });
const kb = [k({ id: "aaaaaaaa-1" }), k({ id: "bbbbbbbb-1" }), k({ id: "cccccccc-1", applied_to: "app/lib/x.ts" }), k({ id: "dddddddd-1", applied_to: "配線は予定" }), k({ id: "eeeeeeee-1", created_at: "2026-11-27T01:00:00Z" }), k({ id: "ffffffff-1", title: "【決定】FOO_LINE を足す" })];
const ledger = [l({ id: 1, kb_ids: ["bbbbbbbb"] }), l({ id: 2, switch_name: "FOO_LINE" })];
assert.deepEqual(decisionsWithoutLedger(kb, ledger, "2026-11-27").map((r) => r.id.slice(0, 8)), ["aaaaaaaa", "dddddddd"], "台帳の kb_ids・スイッチ名・作った（applied_to あり）・今日の分は外す");
const now = "2026-11-27T12:00:00Z";
assert.deepEqual(stalledLedger([l({ id: 3, stage: "building" }), l({ id: 4, stage: "done" }), l({ id: 5, requested_at: "2026-11-20T00:00:00Z" }), l({ id: 6, lastAt: "2026-11-26T00:00:00Z" })], now).map((x) => x.id), [3], "頼まれて14日以上・5日以上動いていない todo/building だけ");
const r = rankUnfinished([{ kind: "off のまま", ref: "b", title: "", area: "AIX", impact: "低", owner: null, why: "" }, { kind: "台帳に無い", ref: "a", title: "", area: "統括", impact: "中", owner: null, why: "" }]);
assert.equal(r[0].ref, "a");
assert.deepEqual(countByArea(r), { 統括: { 台帳に無い: 1, 計: 1 }, AIX: { "off のまま": 1, 計: 1 } });
assert.ok(unfinishedLedgerTitle(r[0]).startsWith("【抜けの棚卸し】a: "));
console.log("unfinished-audit: ok");
