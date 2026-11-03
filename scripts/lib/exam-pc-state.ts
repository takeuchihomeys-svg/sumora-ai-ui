// scripts/lib/exam-pc-state.ts — PC の空きメモリと動いている試験の本数（試験の統括 exam-conductor.ts と作り置き exam-brain.ts --run-queue が同じ物を見る）
//   2026-11-03 夜 指揮役: 作り置き（--run-queue → --warm-main → brain-exam）が統括の門の外で3本目を始めた（空き 755MB）→ 同じ門を通す
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cheapNow, maxExamsNow } from "./exam-conductor-core";

export function pcState(): { free: number; exams: number; tsc: boolean } {
  try {
    const ps = `$os=Get-CimInstance Win32_OperatingSystem; $n=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tsx.dist.cli\\.mjs' -and $_.CommandLine -match '(brain-exam|exam-aix-text)\\.ts' }).Count; $t=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'tsc' }).Count; Write-Output ("" + [int]($os.FreePhysicalMemory/1024) + " " + $n + " " + $t)`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 60_000 }).trim().split(/\s+/);
    return { free: Number(out[0]), exams: Number(out[1]), tsc: Number(out[2]) > 0 || existsSync(join(process.env.TEMP ?? "", "tsc.lock")) };
  } catch { return { free: 0, exams: 99, tsc: true }; }
}

/** 試験を1本始めてよいか（安い時間・本数の上限・空きメモリ・tsc が動いていない） */
export function examGateNow(o: { minFreeMb?: number; now?: Date } = {}): { ok: boolean; why: string } {
  const now = o.now ?? new Date();
  if (!cheapNow(now)) return { ok: false, why: "DeepSeek の混雑の時間（平日 10〜13・15〜19）" };
  const pc = pcState();
  if (pc.tsc) return { ok: false, why: "tsc が動いている" };
  if (pc.exams >= maxExamsNow(now)) return { ok: false, why: `試験が ${pc.exams}本（上限 ${maxExamsNow(now)}）` };
  const min = o.minFreeMb ?? Number(process.env.EXAM_MIN_FREE_MB ?? "1000");
  if (pc.free < min) return { ok: false, why: `空きメモリ ${pc.free}MB（${min} 未満）` };
  return { ok: true, why: `空き ${pc.free}MB・試験 ${pc.exams}本` };
}

/** 門が開くまで待つ（2分ごと・既定 60分で諦める＝false） */
export async function waitExamGate(o: { maxWaitMin?: number; log?: (s: string) => void } = {}): Promise<boolean> {
  const until = Date.now() + (o.maxWaitMin ?? Number(process.env.EXAM_GATE_WAIT_MIN ?? "60")) * 60_000;
  let last = "";
  for (;;) {
    const g = examGateNow();
    if (g.ok) return true;
    if (g.why !== last) { o.log?.(`  門で待つ: ${g.why}`); last = g.why; }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 120_000));
  }
}
