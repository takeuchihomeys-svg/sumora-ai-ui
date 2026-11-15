// scripts/lib/exam-prod-env.ts — 試験の env に本番のスイッチの組（brain_switch_versions の最新の行）を下敷きに入れる（2026-11-15 作業員I・統括役の見つけ）
//   なぜ: 本番は Vercel の環境変数で 61個のスイッチを上書きしている（hash 1b545e72・commit 9df1364・ほぼ全部 on）のに、試験はコードの既定で流れていた
//     ＝本番と違う組で答えている。試験の答えを本番の組に揃える。
//   何を: brain_switch_versions の最後に見た行（5分ごとの cron/ops-anomaly が本番のデプロイの環境から upsert）の K=V を env にする。
//     鍵らしい名前（switch-fingerprint の SECRET_NAME）はもともと表に入っていない。試験の仕組みが決めるスイッチ（LLM_・EXAM_）と
//     本番の外の動き（AUTOMATION_・NEXT_PUBLIC_SUPABASE）は入れない。
//   重なりの順: 本番の組 → 係の設定の examEnv → 依頼の env（依頼が一番強い＝試すスイッチは依頼の値）
//   止める: EXAM_PROD_ENV=off（係・依頼の env）。入れる: 係の設定 config.json の "prodEnv": "on"（＋ "prodEnvFrom": ISO＝その時刻から）か依頼の --prod-env
//   ⚠ 本番の組を入れると録音の鍵（プロンプト）が変わる＝夜の基準も同じ組で作り直す（作り直しは1回・約$5〜12）。だから既定は off・on は夜の基準と同時に
import { readFileSync, writeFileSync, statSync } from "node:fs";

export const PROD_ENV_SKIP = /^(?:LLM_|EXAM_|AUTOMATION_|NEXT_PUBLIC_SUPABASE)/;
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|URL|ENDPOINT|WEBHOOK|DSN/i;

export type ProdEnvCache = { hash: string; n: number; commit: string | null; lastSeenAt: string | null; fetchedAt: string; env: Record<string, string> };

/** brain_switch_versions.switches（K=V の行の並び）→ env（入れない名前を外す） */
export function parseSwitchText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (!k || PROD_ENV_SKIP.test(k) || SECRET_NAME.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 入れるか: EXAM_PROD_ENV（on/off）が一番強い → 依頼の印 → 係の設定（prodEnv: "on"・prodEnvFrom の時刻から） */
export function prodEnvWanted(o: { env?: Record<string, string | undefined>; jobProdEnv?: boolean; config?: { prodEnv?: string; prodEnvFrom?: string } | null; nowMs?: number }): boolean {
  const e = String(o.env?.EXAM_PROD_ENV ?? "").trim().toLowerCase();
  if (e === "off") return false;
  if (e === "on") return true;
  if (o.jobProdEnv) return true;
  const c = o.config;
  if (String(c?.prodEnv ?? "").trim().toLowerCase() !== "on") return false;
  return !c?.prodEnvFrom || (o.nowMs ?? Date.now()) >= Date.parse(c.prodEnvFrom);
}

export function readProdEnvCache(file: string): ProdEnvCache | null {
  try { const c = JSON.parse(readFileSync(file, "utf8")) as ProdEnvCache; return c && c.env && typeof c.env === "object" ? c : null; } catch { return null; }
}
export function prodEnvCacheAgeMs(file: string, nowMs = Date.now()): number | null {
  try { return nowMs - statSync(file).mtimeMs; } catch { return null; }
}

type Db = { from: (t: string) => { select: (c: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> } } } };
/** 最新の行（last_seen_at の新しい順の1行）を読んで控えに書く。読めなければ前の控えのまま（null を返す） */
export async function refreshProdEnv(db: Db, file: string): Promise<ProdEnvCache | null> {
  const { data, error } = await db.from("brain_switch_versions").select("hash, n, commit_sha, last_seen_at, switches").order("last_seen_at", { ascending: false }).limit(1);
  if (error || !data?.length) return null;
  const r = data[0] as { hash: string; n: number; commit_sha: string | null; last_seen_at: string | null; switches: string };
  const c: ProdEnvCache = { hash: r.hash, n: r.n, commit: r.commit_sha, lastSeenAt: r.last_seen_at, fetchedAt: new Date().toISOString(), env: parseSwitchText(r.switches) };
  writeFileSync(file, JSON.stringify(c, null, 1));
  return c;
}
