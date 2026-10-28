// scripts/lib/exam-clock.ts — 試験の中だけの時計のずらし（brain-exam --reuse-fixture 用・既定は何もしない）
//
// 2026-10-28 作業員4: 同じ問題の繰り返しで写し（通・台帳）を使い回すと、通の時刻は1回目のまま・今だけが進むので、
//   ブレインの材料の「お客様はまだ返していない（0分→3分）」等の経過がずれて入力が変わった（q125 #2・--replay=strict で確かめ）。
//   ブレインは試験と同じ処理の中で動くので、その回の間だけ Date.now()／new Date() を「1回目の写しを作った時からの経過」だけ戻す
//   ＝毎回写し直した時と同じ経過になる。setTimeout・performance.now は触らない。ずらしが 0 の時は元の Date と同じ値を返す。
const RealDate = Date;
let offsetMs = 0;
let installed = false;

/** 本当の今（ずらしの外） */
export function realNow(): number { return RealDate.now(); }

/** Date を差し替える（1回だけ・ずらし 0 のままなら値は変わらない） */
export function installExamClock(): void {
  if (installed) return;
  installed = true;
  class ExamDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(RealDate.now() - offsetMs);
      else super(...(a as [string | number | Date]));
    }
    static now(): number { return RealDate.now() - offsetMs; }
    // 差し替える前に作られた Date も「Date の仲間」と見えるように（instanceof Date を使う道具のため）
    static [Symbol.hasInstance](x: unknown): boolean { return x instanceof RealDate; }
  }
  (globalThis as { Date: DateConstructor }).Date = ExamDate as unknown as DateConstructor;
}

/** この回の間のずらし（ミリ秒・戻す量）。0 で元に戻す */
export function setExamClockOffset(ms: number): void { offsetMs = Math.max(0, Math.round(ms)); }
export function examClockOffset(): number { return offsetMs; }
