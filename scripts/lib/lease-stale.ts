// scripts/lib/lease-stale.ts — テスト用の会話の鍵（.test-conv-<名>.lock）の「古い鍵」を見分けて消し、記録する（純関数＋小さな読み書き）
//
// 2026-11-12 作業員10（統括役の頼み）: 持ち主の実行が全部終わっていた鍵が36個残り、生きて見える鍵で YUMA2〜5 が全部「使用中」になって試験が流れなかった（w10-seven-maj）。
//   原因: ①pid の生き死にを process.kill(pid, 0) だけで見ていた＝Windows は pid がすぐ別の処理に使い回され、終わった実行の pid が生きて見える
//         ②自分の作業ツリーの鍵（tryLock）と exam-brain-io.liveLeaseOf には古さの線が無かった（別の作業ツリーの鍵だけ 12時間）
//   直し: 鍵は次のどれかなら空きとして扱い、消して記録する: pid が無い・pid の処理が生きていない・生きていても node の処理ではない（Windows は tasklist で処理の名前を見る）・
//         鍵が STALE_LEASE_MS（6時間）より古い（試験は最長5時間＝exam-conductor の maxMin 300）
// テスト: npx tsx scripts/lib/__tests__/lease-stale.test.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

export const STALE_LEASE_MS = 6 * 3_600_000;
export type LeaseBody = { pid?: number; owner?: string; at?: string };

/** 処理の名前を読む（Windows: tasklist・それ以外: ps）。読めなければ null（＝名前では判断しない） */
export function processNameOf(pid: number, o: { platform?: string; run?: (cmd: string, args: string[]) => string } = {}): string | null {
  const platform = o.platform ?? process.platform;
  const run = o.run ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }));
  try {
    if (platform === "win32") {
      // 例: "node.exe","30844","Console","1","95,212 K"  ／ 無い時: 情報: 指定された条件に一致するタスクは実行されていません。
      const out = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      const m = out.match(/^"([^"]+)","(\d+)"/m);
      return m && Number(m[2]) === pid ? m[1] : "";
    }
    return run("ps", ["-p", String(pid), "-o", "comm="]).trim();
  } catch { return null; }
}
/** pid の処理が生きていて、試験の実行（node）か。kill(pid,0) で無ければ死・Windows は名前が node でなければ使い回し＝死とみなす */
export function pidAliveAsNode(pid: number | null | undefined, o: { kill?: (pid: number) => boolean; name?: (pid: number) => string | null } = {}): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  const kill = o.kill ?? ((p: number) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; } });
  if (!kill(pid)) return false;
  const name = (o.name ?? ((p: number) => processNameOf(p)))(pid);
  if (name === null) return true; // 名前が読めない時は生きているとみなす（迷えば消さない）
  if (name === "") return false;  // 一覧に無い＝死
  return /node|tsx/i.test(name);
}
/** 古い鍵の理由（空きとして扱ってよい理由）。null＝生きている鍵 */
export function staleLeaseReason(body: LeaseBody | null, o: { now?: number; alive?: (pid: number) => boolean; maxAgeMs?: number } = {}): string | null {
  if (!body || typeof body.pid !== "number") return "pid が無い・壊れた鍵";
  const now = o.now ?? Date.now();
  const at = Date.parse(String(body.at ?? ""));
  if (Number.isFinite(at) && now - at > (o.maxAgeMs ?? STALE_LEASE_MS)) return `古い（${Math.round((now - at) / 3_600_000)}時間前）`;
  if (!(o.alive ?? ((p: number) => pidAliveAsNode(p)))(body.pid)) return `持ち主の pid ${body.pid} が生きていない（または node の処理ではない）`;
  return null;
}
/** 鍵が古ければ消して記録する（消したら理由を返す・生きている鍵は触らない）。log は記録のファイル（無ければ鍵と同じ場所の stale-leases.log） */
export function sweepStaleLease(file: string, o: { now?: number; alive?: (pid: number) => boolean; maxAgeMs?: number; log?: string | null } = {}): string | null {
  if (!existsSync(file)) return null;
  let body: LeaseBody | null = null;
  try { const t = readFileSync(file, "utf8").trim(); body = t ? (JSON.parse(t) as LeaseBody) : null; } catch { body = null; }
  const why = staleLeaseReason(body, o);
  if (!why) return null;
  try { unlinkSync(file); } catch { return null; } // 他が先に消した
  const log = o.log === undefined ? `${dirname(file)}/stale-leases.log` : o.log;
  if (log) { try { if (!existsSync(dirname(log))) mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, `${JSON.stringify({ at: new Date(o.now ?? Date.now()).toISOString(), file, owner: body?.owner ?? null, pid: body?.pid ?? null, lockAt: body?.at ?? null, why })}\n`); } catch { /* 記録できなくても鍵は消した */ } }
  return why;
}
