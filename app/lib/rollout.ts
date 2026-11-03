// app/lib/rollout.ts — スイッチを段階で広げる（YUMA → 一部 → 全部）・悪化で1段戻す（2026-11-03 作業員1・作業員2の設計 §5）
//
// 段: off ＜ yuma ＜ pct:N（会話 id の指紋の剰余 0〜99 が N 未満の会話）＜ all
//   ・env `<NAME>_STAGE=off|yuma|pct:10|pct:50|all` で決める（統括役が Vercel で入れる）
//   ・今の `<NAME>=on`（_STAGE が無い）は all とみなす（互換）。`<NAME>=off`・無しは off
//   ・YUMA と YUMA2〜5 などテスト用の会話は yuma 以上で on
//   ・表 rollout_overrides（RLS・サーバーの鍵だけ）に行があれば env より優先（1分の控え）。夜の見張りが悪化を見た時に1段下を書く＝env は書き換えない（統括役の決定は残る）
// 使い方: const on = await stageOnNow("BRAIN_X", conversationId)（新しいスイッチから順に使う・古いスイッチは今まで通り process.env を読む）
// 止める: ROLLOUT_OVERRIDES=off（表を読まない＝env だけ）
import { isTestConversation } from "./test-conversations";
import { fnv1a } from "./switch-fingerprint";

export type Stage = { kind: "off" } | { kind: "yuma" } | { kind: "pct"; pct: number } | { kind: "all" };
export type RolloutOverride = { switch_name: string; stage: string; reason?: string | null; updated_at?: string };

export function parseStage(v: string | null | undefined): Stage | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "off") return { kind: "off" };
  if (s === "yuma") return { kind: "yuma" };
  if (s === "all" || s === "on") return { kind: "all" };
  const m = /^pct:(\d{1,3})$/.exec(s);
  if (m) { const p = Math.min(100, Number(m[1])); return p >= 100 ? { kind: "all" } : p <= 0 ? { kind: "yuma" } : { kind: "pct", pct: p }; }
  return null;
}
export function stageText(s: Stage): string { return s.kind === "pct" ? `pct:${s.pct}` : s.kind; }
/** 会話 id → 0〜99（同じ会話はいつも同じ組） */
export function bucketOf(conversationId: string, name: string): number { return parseInt(fnv1a(`${name}:${conversationId}`), 16) % 100; }

/** env と表からスイッチの段を決める（表が優先・_STAGE・互換の =on の順） */
export function stageOf(name: string, env: Record<string, string | undefined>, overrides: ReadonlyArray<RolloutOverride> = []): Stage {
  const o = overrides.find((x) => x.switch_name === name);
  const fromTable = o ? parseStage(o.stage) : null;
  if (fromTable) return fromTable;
  const st = parseStage(env[`${name}_STAGE`]);
  if (st) return st;
  return String(env[name] ?? "").trim().toLowerCase() === "on" ? { kind: "all" } : { kind: "off" };
}
export function stageOn(name: string, conversationId: string | null | undefined, env: Record<string, string | undefined>, overrides: ReadonlyArray<RolloutOverride> = []): boolean {
  const s = stageOf(name, env, overrides);
  if (s.kind === "off") return false;
  if (s.kind === "all") return true;
  const cid = String(conversationId ?? "");
  if (isTestConversation(cid)) return true;
  return s.kind === "pct" && !!cid && bucketOf(cid, name) < s.pct;
}
/** 1段下（悪化で戻す時）: all → pct:50 → pct:10 → yuma → off */
export function stepDown(s: Stage): Stage {
  if (s.kind === "all") return { kind: "pct", pct: 50 };
  if (s.kind === "pct") return s.pct > 10 ? { kind: "pct", pct: 10 } : { kind: "yuma" };
  return { kind: "off" };
}

// ─── サーバーで表を読む（1分の控え） ─────────────────────────────────────
let cache: { at: number; rows: RolloutOverride[] } | null = null;
/** サーバーだけ（表は RLS・REVOKE＝サーバーの鍵 SUPABASE_SERVICE_ROLE_KEY の client で読む。共通の supabase（公開キー）では読めない）。
 *  画面から呼ばれた時・鍵が無い時は表を読まずに env だけ（その事は1回だけログに出す） */
export async function loadRolloutOverrides(nowMs = Date.now()): Promise<RolloutOverride[]> {
  if (typeof window !== "undefined") return [];
  if (String(process.env.ROLLOUT_OVERRIDES ?? "").trim().toLowerCase() === "off") return [];
  if (cache && nowMs - cache.at < 60_000) return cache.rows;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { if (!cache) console.warn("[rollout] SUPABASE_SERVICE_ROLE_KEY が無い → rollout_overrides を読まず env だけで段を決める"); cache = { at: nowMs, rows: [] }; return []; }
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { data, error } = await createClient(url, key, { auth: { persistSession: false } }).from("rollout_overrides").select("switch_name, stage, reason, updated_at");
    if (error) console.warn("[rollout] rollout_overrides を読めない:", error.message);
    cache = { at: nowMs, rows: error ? cache?.rows ?? [] : ((data ?? []) as RolloutOverride[]) };
  } catch { cache = { at: nowMs, rows: cache?.rows ?? [] }; }
  return cache.rows;
}
export async function stageOnNow(name: string, conversationId: string | null | undefined): Promise<boolean> {
  return stageOn(name, conversationId, process.env, await loadRolloutOverrides());
}
