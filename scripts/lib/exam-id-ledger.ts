// scripts/lib/exam-id-ledger.ts — 試験の問題 id を使い回さない網（一度 spec に出た id は、外しても別の番に使わない）
//
// 2026-11-07 統括役（P0 8805bd74・作業員4の見つけ）: 11/06 15:00 に入った q374 を 23:08 に外し、11/07 03:33 の ee2f4e21 で別の新しい問題に
//   同じ q374 を使った（brain-exam-add は「今の spec の最大＋1」で番号を取る＝一番大きい id を外すと次に同じ番号が出る）。
//   古い答案の q374 を採り直すと新しい問題で採点されてしまう。
//   → 使った id の控え（exam-cache/spec-ids-used.json・id → 番の印「会話|時刻」）を持ち、
//     ① 新しい番号は spec と控えの両方の最大＋1 ② spec の id の番の印が控えと違えば止める（積む時・hazard-audit）
//     ③ 使い回してしまった id（今の spec の番を正にする）は、その番が入る前の答案の行を採点から外す（reused.since）
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export type SpecLite = { id: string; conv?: string; at?: string };
export type IdLedger = { maxN: number; ids: Record<string, string>; reused: Record<string, { since: string; old: string[] }> };

/** 番の印＝会話と時刻（分まで・秒の直しは同じ番） */
export const markOf = (s: SpecLite): string => { const t = Date.parse(String(s.at ?? "")); return `${s.conv ?? ""}|${Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16) : String(s.at ?? "")}`; };
const numOf = (id: string) => Number(String(id).replace(/^q/, "")) || 0;

/** 次の番号（純関数）: spec と控えの両方の最大＋1 */
export function nextIdNumber(spec: ReadonlyArray<SpecLite>, ledger: IdLedger | null): number {
  return Math.max(0, ...spec.map((s) => numOf(s.id)), ledger?.maxN ?? 0) + 1;
}

/** spec の id のうち、控えの番の印と違う物（純関数・使い回しの疑い）。控えの「使い回し済み（reused）」で今の印に直した id は数えない */
export function idClashes(spec: ReadonlyArray<SpecLite>, ledger: IdLedger | null): string[] {
  if (!ledger) return [];
  return spec.filter((s) => ledger.ids[s.id] && ledger.ids[s.id] !== markOf(s)).map((s) => s.id);
}

/** 控えに今の spec を足す（純関数・ある id は上書きしない） */
export function withSpec(ledger: IdLedger | null, spec: ReadonlyArray<SpecLite>): IdLedger {
  const out: IdLedger = { maxN: ledger?.maxN ?? 0, ids: { ...(ledger?.ids ?? {}) }, reused: { ...(ledger?.reused ?? {}) } };
  for (const s of spec) { if (!out.ids[s.id]) out.ids[s.id] = markOf(s); out.maxN = Math.max(out.maxN, numOf(s.id)); }
  return out;
}

/**
 * 歴史から控えを作る（純関数）: versions は古い順の spec の版（時刻つき）。同じ id に違う番が出たら、今の spec の番を正にし、
 *   今の番が初めて出た版の時刻を reused.since にする（それより前の答案の行はその id の採点から外す）
 */
export function ledgerFromHistory(versions: ReadonlyArray<{ at: string; spec: ReadonlyArray<SpecLite> }>, current: ReadonlyArray<SpecLite>): IdLedger {
  const firstSeen = new Map<string, Map<string, string>>(); // id → 印 → 初めて出た時刻
  let maxN = 0;
  for (const v of versions) for (const s of v.spec) {
    maxN = Math.max(maxN, numOf(s.id));
    const m = firstSeen.get(s.id) ?? new Map<string, string>();
    if (!m.has(markOf(s))) m.set(markOf(s), v.at);
    firstSeen.set(s.id, m);
  }
  const cur = new Map(current.map((s) => [s.id, markOf(s)]));
  const ids: Record<string, string> = {}, reused: IdLedger["reused"] = {};
  for (const [id, marks] of firstSeen) {
    const now = cur.get(id);
    if (now) { ids[id] = now; if (marks.size > 1) reused[id] = { since: marks.get(now) ?? new Date().toISOString(), old: [...marks.keys()].filter((k) => k !== now) }; }
    else ids[id] = [...marks.keys()][0];
  }
  for (const s of current) { maxN = Math.max(maxN, numOf(s.id)); if (!ids[s.id]) ids[s.id] = markOf(s); }
  return { maxN, ids, reused };
}

/** その答案の行を採点から外すか（純関数）: 使い回した id で、今の番が入る前の行 */
export function rowFromReusedId(row: { id: string; at?: string }, ledger: IdLedger | null): boolean {
  const r = ledger?.reused?.[row.id];
  if (!r || !row.at) return false;
  return Date.parse(row.at) < Date.parse(r.since);
}

// ─── 置き場（exam-cache） ───
export function ledgerFile(cacheRoot: string): string { return join(cacheRoot, "spec-ids-used.json"); }
export function readLedger(cacheRoot: string): IdLedger | null {
  try { return existsSync(ledgerFile(cacheRoot)) ? (JSON.parse(readFileSync(ledgerFile(cacheRoot), "utf8")) as IdLedger) : null; } catch { return null; }
}
export function writeLedger(cacheRoot: string, l: IdLedger): void {
  const f = ledgerFile(cacheRoot), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 1)); renameSync(tmp, f);
}
/** 控えが無ければ git の歴史（origin/main の spec.json の全部の版）から作る。あれば今の spec を足す */
export function ensureLedger(cacheRoot: string, repoDir: string, current: ReadonlyArray<SpecLite>): IdLedger {
  let l = readLedger(cacheRoot);
  if (!l) {
    const file = "scripts/brain-exam/spec.json";
    const revs = execFileSync("git", ["-C", repoDir, "log", "--reverse", "--format=%H %cI", "origin/main", "--", file], { maxBuffer: 64 * 1024 * 1024 }).toString().trim().split("\n").filter(Boolean);
    const versions: Array<{ at: string; spec: SpecLite[] }> = [];
    for (const line of revs) {
      const [h, at] = line.split(" ");
      try { versions.push({ at, spec: JSON.parse(execFileSync("git", ["-C", repoDir, "show", `${h}:${file}`], { maxBuffer: 64 * 1024 * 1024 }).toString()) as SpecLite[] }); } catch { /* その版は読めない */ }
    }
    l = ledgerFromHistory(versions, current);
  } else l = withSpec(l, current);
  try { writeLedger(cacheRoot, l); } catch { /* 書けなくても網は返す */ }
  return l;
}
