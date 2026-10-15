// scripts/lib/exam-shared-file.ts — 作業ツリーをまたいで共有する置き場（.claude/exam-cache/）のファイルを、同時に書いても壊さずに書く
//
// 2026-10-15 竹内「試験の API を節約」③: 問題・版の鍵・揺れの記録を全部の作業者で共有する。
//   ・書く: 同じ場所に一時ファイルを書いてから rename（読む側は古いか新しいかのどちらか全体しか見ない＝途中の物を読まない）
//   ・読んで足して書く（read-modify-write）: <file>.lock の「ディレクトリを作る」を鍵にする（mkdir は1人しか成功しない）。
//     落ちた担当の鍵は STALE_MS（既定 2分）で古いと見て外す。鍵の中に pid と時刻を書く。
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** 一時ファイル → rename で置き換える（Windows で他の人が読んでいて rename が EPERM の時は少し待って直す） */
export function atomicWriteText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  for (let k = 0; ; k++) {
    try { renameSync(tmp, file); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (k >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { try { unlinkSync(tmp); } catch { /* */ } throw e; }
      sleepSync(50 + k * 25);
    }
  }
}
export function atomicWriteJson(file: string, v: unknown, pretty = false): void { atomicWriteText(file, JSON.stringify(v, null, pretty ? 1 : undefined)); }

export type LockOpts = { staleMs?: number; waitMs?: number };
/** <file>.lock の鍵を取って fn を回す（取れなければ waitMs で投げる） */
export function withFileLock<T>(file: string, fn: () => T, o: LockOpts = {}): T {
  const lock = `${file}.lock`;
  const staleMs = o.staleMs ?? 120_000, waitMs = o.waitMs ?? 60_000;
  mkdirSync(dirname(file), { recursive: true });
  const t0 = Date.now();
  for (let k = 0; ; k++) {
    try { mkdirSync(lock); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() - t0 > waitMs) throw new Error(`共有の置き場の鍵が取れない（${lock}・${waitMs}ms）。落ちた担当の鍵なら消す`);
      sleepSync(Math.min(500, 20 + k * 20));
    }
  }
  try { writeFileSync(`${lock}/owner`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch { /* */ }
  try { return fn(); } finally { try { rmSync(lock, { recursive: true, force: true }); } catch { /* */ } }
}
/** 読んで（無い・壊れていれば init）、変えて、原子的に書く。鍵の中で回す */
export function updateJsonFile<T>(file: string, init: () => T, change: (cur: T) => T, o: LockOpts = {}): T {
  return withFileLock(file, () => {
    let cur: T;
    try { cur = JSON.parse(readFileSync(file, "utf8")) as T; } catch { cur = init(); }
    const next = change(cur);
    atomicWriteJson(file, next);
    return next;
  }, o);
}
