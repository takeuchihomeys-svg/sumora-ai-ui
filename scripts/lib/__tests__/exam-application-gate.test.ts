// npx tsx scripts/lib/__tests__/exam-application-gate.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filterGateExcluded, gateCheckSpecs, readGateExcluded, writeGateExcluded } from "../exam-application-gate";
import type { TurnApplicationRecords } from "../../../app/lib/turn-application-gate";

(async () => {
  let n = 0;
  const rec = (records: TurnApplicationRecords["records"], o: Partial<TurnApplicationRecords> = {}): TurnApplicationRecords => ({ status: null, isPostApply: false, records, backAt: null, unreadable: false, ...o });
  const db: Record<string, TurnApplicationRecords> = {
    a: rec([{ kind: "記入済みフォーム", first: "2026-09-15T00:00:00Z", last: "2026-09-15T00:00:00Z" }]),
    b: rec([]),
    c: rec([], { unreadable: true }),
  };
  let loads = 0;
  const load = async (conv: string) => { loads++; return db[conv]; };
  const out = await gateCheckSpecs([
    { id: "q1", conv: "a", at: "2026-09-16T00:00:00Z" }, // 記入済みフォームの後＝外す
    { id: "q2", conv: "a", at: "2026-09-10T00:00:00Z" }, // 前＝残す
    { id: "q3", conv: "b", at: "2026-09-10T00:00:00Z" }, // 記録なし＝残す
    { id: "q4", conv: "c", at: "2026-09-10T00:00:00Z" }, // 読めない＝外す（迷えば外す）
  ], load);
  assert.deepEqual(out.map((x) => x.id), ["q1", "q4"]); n++;
  assert.match(out[0].reason, /申込以降（記入済みフォームの後）/); n++;
  assert.equal(loads, 3); n++; // 会話ごとに1回
  const f = filterGateExcluded([{ id: "q1" }, { id: "q2" }, { id: "q4" }], new Map(out.map((x) => [x.id, x.reason])));
  assert.deepEqual(f.kept.map((x) => x.id), ["q2"]); assert.deepEqual(f.dropped.map((x) => x.id), ["q1", "q4"]); n++;
  // 読み書き（本文は書かない＝id と理由だけ）
  const dir = mkdtempSync(join(tmpdir(), "w10-gate-")); mkdirSync(join(dir, "scripts", "brain-exam"), { recursive: true });
  writeGateExcluded(out, dir);
  const m = readGateExcluded(dir);
  assert.equal(m.get("q1"), out[0].reason); assert.equal(m.size, 2); n++;
  assert.equal(readGateExcluded(join(dir, "none")).size, 0); n++;
  console.log(`exam-application-gate: ${n} pass`);
})();
