// npx tsx scripts/lib/__tests__/lease-stale.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processNameOf, pidAliveAsNode, staleLeaseReason, sweepStaleLease, STALE_LEASE_MS } from "../lease-stale";

let n = 0;
const ok = (name: string, f: () => void) => { f(); n++; console.log("ok", name); };

ok("Windows の tasklist の出力から処理の名前を読む（一致しない pid・一覧に無い時は空）", () => {
  const run = (out: string) => () => out;
  assert.equal(processNameOf(30844, { platform: "win32", run: run('"node.exe","30844","Console","1","95,212 K"\r\n') }), "node.exe");
  assert.equal(processNameOf(30844, { platform: "win32", run: run("情報: 指定された条件に一致するタスクは実行されていません。\r\n") }), "");
  assert.equal(processNameOf(30844, { platform: "win32", run: run('"chrome.exe","30844","Console","1","10 K"') }), "chrome.exe");
  assert.equal(processNameOf(1, { platform: "win32", run: () => { throw new Error("no tasklist"); } }), null);
  assert.equal(processNameOf(42, { platform: "linux", run: () => "node\n" }), "node");
});
ok("pid の生き死に: kill が死なら死・生きていても node でなければ使い回し＝死・名前が読めなければ生きているとみなす", () => {
  assert.equal(pidAliveAsNode(30844, { kill: () => false, name: () => "node.exe" }), false);
  assert.equal(pidAliveAsNode(30844, { kill: () => true, name: () => "chrome.exe" }), false);
  assert.equal(pidAliveAsNode(30844, { kill: () => true, name: () => "" }), false);
  assert.equal(pidAliveAsNode(30844, { kill: () => true, name: () => "node.exe" }), true);
  assert.equal(pidAliveAsNode(30844, { kill: () => true, name: () => null }), true);
  assert.equal(pidAliveAsNode(null), false);
  // 自分の pid は本当に生きている node（実物の確かめ・この PC の tasklist／ps を使う）
  assert.equal(pidAliveAsNode(process.pid), true);
});
ok("古い鍵の理由: pid 無し・6時間より古い・持ち主が死んだ／生きている鍵は null", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  assert.match(staleLeaseReason(null)!, /pid が無い/);
  assert.match(staleLeaseReason({ pid: 1, at: new Date(now - STALE_LEASE_MS - 60_000).toISOString() }, { now, alive: () => true })!, /古い（6時間前）/);
  assert.match(staleLeaseReason({ pid: 1, at: new Date(now - 60_000).toISOString() }, { now, alive: () => false })!, /生きていない/);
  assert.equal(staleLeaseReason({ pid: 1, at: new Date(now - 60_000).toISOString() }, { now, alive: () => true }), null);
});
ok("古い鍵は消して記録する・生きている鍵は触らない", () => {
  const dir = mkdtempSync(join(tmpdir(), "w10-lease-"));
  const dead = join(dir, ".test-conv-YUMA2.lock"), live = join(dir, ".test-conv-YUMA3.lock"), log = join(dir, "stale-leases.log");
  writeFileSync(dead, JSON.stringify({ pid: 30844, owner: "brain-exam-fc15-fc3a", at: new Date().toISOString() }));
  writeFileSync(live, JSON.stringify({ pid: process.pid, owner: "me", at: new Date().toISOString() }));
  assert.match(sweepStaleLease(dead, { alive: () => false, log })!, /生きていない/);
  assert.equal(existsSync(dead), false);
  assert.equal(sweepStaleLease(live, { alive: () => true, log }), null);
  assert.equal(existsSync(live), true);
  const rec = JSON.parse(readFileSync(log, "utf8").trim()) as { owner: string; why: string };
  assert.equal(rec.owner, "brain-exam-fc15-fc3a");
});
console.log(`lease-stale: ${n} pass`);
