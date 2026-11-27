// scripts/lib/exam-run-settle.ts — 確かめの道具が1回流した後に、止まった回の残り（条件の行の控え・残った process）を必ず片付ける
// 2026-11-27 作業員L（統括役の頼み「殺した回の控えが残らない形（終わる時に必ず戻す）を、確かめの道具に入れてください」）
//   11/27 朝: 印だけ見る回（exam-preflight-marks）を時間切れで止めた回が、テスト専用の会話（YUMA2〜5）の条件の行の控えを中身入りで残し、
//   後の回がその会話の条件の行を「問題の条件のまま」と見て写し・戻した（3件・脇へ寄せた .stale-*）。
//   spawnSync の timeout は shell（cmd）だけ止め、孫の node（brain-exam）は残る＝戻す処理（restorePc）が走らない。
//   → 1回流した後に ①同じ label の残った node を止め ②中身の残った控えを exam-brain --cleanup --apply で戻す（控えの中身＝流す前の行）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 中身の残った控え（label の物だけ）→ 戻す会話の名前（純関数）。空の控え＝戻し済み */
export function leftoverBackupsOf(files: ReadonlyArray<{ name: string; body: string }>, label: string): Array<{ name: string; conv: string }> {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\.brain-exam-${esc}-(yuma\\d*)-pc-backup\\.json$`);
  return files.flatMap((f) => { const m = f.name.match(re); return m && f.body.trim() ? [{ name: f.name, conv: m[1].toUpperCase() }] : []; });
}
/** その label で動いている node の pid（Windows・コマンドラインの --label=<label> が丸ごと一致する物だけ）（純関数） */
export function labelPidsOf(procs: ReadonlyArray<{ pid: number; cmd: string }>, label: string): number[] {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`--label=${esc}(?=["\\s]|$)`);
  return procs.filter((p) => re.test(p.cmd ?? "")).map((p) => p.pid);
}
function nodeProcs(): Array<{ pid: number; cmd: string }> {
  if (process.platform !== "win32") return [];
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: "utf8", timeout: 60_000 });
  return String(r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((l) => { const i = l.indexOf("\t"); return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) }; }).filter((p) => p.pid && p.pid !== process.pid);
}
/** 1回流した後の片付け（時間切れ・異常終了でも・正常に終わった時は何もしない） */
export function settleExamRun(o: { cwd: string; label: string; envFile: string; log?: (s: string) => void }): { killed: number[]; restored: string[]; failed: string[] } {
  const log = o.log ?? ((s: string) => console.warn(s));
  const killed = labelPidsOf(nodeProcs(), o.label);
  for (const pid of killed) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", timeout: 30_000 });
  if (killed.length) log(`  止まった回の node を止めた（label ${o.label}・${killed.length}本）`);
  const ro = join(o.cwd, "scripts", ".replay-out");
  if (!existsSync(ro)) return { killed, restored: [], failed: [] };
  const files = readdirSync(ro).filter((n) => n.endsWith("-pc-backup.json")).map((n) => { try { return { name: n, body: readFileSync(join(ro, n), "utf8") }; } catch { return { name: n, body: "" }; } });
  const restored: string[] = [], failed: string[] = [];
  for (const b of leftoverBackupsOf(files, o.label)) {
    const r = spawnSync("npx", ["tsx", `"--env-file=${o.envFile}"`, "scripts/exam-brain.ts", "--cleanup", `--conv=${b.conv}`, `--label=${o.label}`, `"--from=${o.cwd}"`, "--apply"], { cwd: o.cwd, encoding: "utf8", shell: true, timeout: 5 * 60_000 });
    const left = (() => { try { return readFileSync(join(ro, b.name), "utf8").trim().length > 0; } catch { return false; } })();
    (r.status === 0 && !left ? restored : failed).push(b.conv);
    log(r.status === 0 && !left ? `  止まった回の条件の行を戻した（${b.conv}・label ${o.label}）` : `  ⛔ 止まった回の条件の行を戻せない（${b.conv}・控え ${b.name} に残す）: ${String(r.stderr ?? "").slice(-200)}`);
  }
  return { killed, restored, failed };
}
