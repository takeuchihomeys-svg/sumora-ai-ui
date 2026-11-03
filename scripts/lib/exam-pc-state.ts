// scripts/lib/exam-pc-state.ts — PC の空きメモリと動いている試験の本数（試験の統括 exam-conductor.ts と作り置き exam-brain.ts --run-queue が同じ物を見る）
//   2026-11-03 夜 指揮役: 作り置き（--run-queue → --warm-main → brain-exam）が統括の門の外で3本目を始めた（空き 755MB）→ 同じ門を通す
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cheapNow, maxExamsNow } from "./exam-conductor-core";
import { examCacheRoot } from "./llm-cassette";

export function pcState(): { free: number; exams: number; tsc: boolean } {
  try {
    // 2026-11-04: brain-exam が「前（main）」を子の brain-exam で回すと親子で2本と数えていた（作り置き1本で門の上限 2 に当たり列が止まった）
    //   → 祖先（4代まで）に試験の node がいる物は数えない＝1本の試験は1本
    const ps = `$os=Get-CimInstance Win32_OperatingSystem; $all=@(Get-CimInstance Win32_Process); $byId=@{}; foreach($p in $all){ $byId[[int]$p.ProcessId]=$p }; $isExam={ param($p) $p.Name -eq 'node.exe' -and $p.CommandLine -match 'tsx.dist.cli\\.mjs' -and $p.CommandLine -match '(brain-exam|exam-aix-text)\\.ts' }; $n=@($all | Where-Object { & $isExam $_ } | Where-Object { $q=$byId[[int]$_.ParentProcessId]; $nested=$false; for($i=0;$i -lt 4 -and $q;$i++){ if(& $isExam $q){ $nested=$true; break }; $q=$byId[[int]$q.ParentProcessId] }; -not $nested }).Count;`
      + ` $t=@($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'tsc' }).Count; Write-Output ("" + [int]($os.FreePhysicalMemory/1024) + " " + $n + " " + $t)`;
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

/**
 * 2026-11-04 指揮役（根の直し①）: 試験の統括の列（exam-queue）に、今流れている・流せる試験があるか（作り置きの全問はその間は始めない）。
 *   数える物: brain-exam と、AI を呼ぶ cmd（読むだけの印 readOnly と tsc は数えない）。保留（hold）と、始める時刻（notBefore）が先の物は数えない。.claimed（流れている）は数える
 */
export function conductorExamWaiting(now: Date = new Date(), root: string = join(examCacheRoot(), "exam-queue")): string[] {
  let files: string[] = [];
  try { files = readdirSync(root).filter((f) => (f.endsWith(".json") || f.endsWith(".json.claimed")) && f !== "config.json" && f !== "scene-map.json"); } catch { return []; }
  const out: string[] = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(root, f), "utf8")) as { label?: string; runner?: string; readOnly?: boolean; hold?: string; notBefore?: string };
      if (j.runner === "tsc" || j.runner === "tsc-remote" || (j.runner === "cmd" && j.readOnly)) continue;
      if (!f.endsWith(".claimed") && (j.hold || (j.notBefore && Date.parse(j.notBefore) > now.getTime()))) continue;
      out.push(j.label ?? f);
    } catch { /* 書きかけ */ }
  }
  return out;
}
/** 作り置きの全問を始めてよい時間（夜 JST 22〜9 だけ）。昼に main が push されても全問を始めない */
export function wholeWarmHourOk(now: Date = new Date()): boolean { const h = new Date(now.getTime() + 9 * 3600_000).getUTCHours(); return h >= 22 || h < 9; }
