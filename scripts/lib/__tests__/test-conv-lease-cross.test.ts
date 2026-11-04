// scripts/lib/__tests__/test-conv-lease-cross.test.ts — 別の作業ツリーの鍵を見る（2026-11-04・YUMA2 を2つの作業ツリーで同時に使って混ざった）
//   実行: npx tsx scripts/lib/__tests__/test-conv-lease-cross.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { liveLeaseElsewhere, lockFileOf, acquireTestConversation } from "../test-conv-lease";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log(`  NG  ${n}`); } };
const base = mkdtempSync(join(tmpdir(), "lease-x-"));
const a = join(base, "wtA"), b = join(base, "wtB");
mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
const now = new Date().toISOString(), old = new Date(Date.now() - 13 * 3_600_000).toISOString();
writeFileSync(lockFileOf("YUMA2", b), JSON.stringify({ pid: 111, owner: "other", at: now }));
t("別の作業ツリーの生きている鍵は見える", liveLeaseElsewhere("YUMA2", a, (p) => p === 111, [a, b])?.owner === "other");
t("自分の作業ツリーの鍵は見ない（tryLock が見る）", liveLeaseElsewhere("YUMA2", b, () => true, [b]) === null);
t("死んだ実行の鍵は見ない", liveLeaseElsewhere("YUMA2", a, () => false, [a, b]) === null);
writeFileSync(lockFileOf("YUMA3", b), JSON.stringify({ pid: 111, owner: "stale", at: old }));
t("12時間より古い鍵は見ない（pid の使い回し）", liveLeaseElsewhere("YUMA3", a, () => true, [a, b]) === null);
t("別の会話の鍵は関係ない", liveLeaseElsewhere("YUMA4", a, () => true, [a, b]) === null);
// 11/04 2本目: 1本目は関数だけ入って acquireTestConversation に配線されていなかった（改行コードで置き換えが外れた）→ 取る所で効く事を確かめる
const c = join(base, "wtC"); mkdirSync(c, { recursive: true });
const l = acquireTestConversation("auto", "me", { dir: c, pid: 222, alive: (p) => p === 111 || p === 222, exitHook: false, otherDirs: [b, c] });
t("auto は別の作業ツリーが持つ YUMA2 を飛ばして次の会話を取る", l.name === "YUMA3");
l.release();
let threw = false; try { acquireTestConversation("YUMA2", "me", { dir: c, pid: 222, alive: (p) => p === 111, exitHook: false, otherDirs: [b, c] }); } catch { threw = true; }
t("名指しの YUMA2 も別の作業ツリーが持っていたら取らない", threw);
console.log(`test-conv-lease-cross: ${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
