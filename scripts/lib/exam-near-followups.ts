// scripts/lib/exam-near-followups.ts — 近い番の RPC の答えから、試験の道が続けて出す読み（keep の表・番のベクトルの表）の URL を、試験の道と同じ関数で作る
//
// 2026-11-07 統括役（on → resolve → on の2巡をなくす）: 夜の台本（scripts/exam-near-resolve.ts）が RPC の頼みを鍵で読んだ時に、その答えから
//   後ろの読みも先に控える。URL は supabase-js の問い合わせを本物の関数（keepQuery・turnMetaQuery）で組み立てて、送らずに拾う＝試験の道と同じ URL・同じ鍵。
//   どの関数を使うかは app/lib の持ち主の関数そのもの（nearFromFocusRows・keepMidsOf・nearOpinionRows）。ここで同じ計算を書き直さない
import { createClient } from "@supabase/supabase-js";
import { nearFromFocusRows, keepMidsOf, keepQuery, type FocusRpcRow } from "../../app/lib/conductor-focus-server";
import { nearOpinionRows, turnMetaQuery } from "../../app/lib/conductor-near-opinion-server";

export type Followup = { name: "takeuchi_compose_examples" | "conductor_turn_vectors"; url: string };

/** supabase-js の問い合わせを送らずに URL だけ拾う */
async function captureUrls(baseUrl: string, run: (sb: never) => Promise<unknown>): Promise<string[]> {
  const got: string[] = [];
  const sb = createClient(baseUrl, "capture-only", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (async (input: RequestInfo | URL) => { got.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url); return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch },
  });
  await run(sb as never);
  return got;
}

/**
 * RPC（match_conductor_focus）の答えの行から、試験の道が続けて出す読みの URL（純粋ではないが送らない）。
 *   ① 文の統括（作業員9）: nearFocusForTurn の束の ids → nearKeepShareFor の keep の読み（minN 3 未満は読まない）
 *   ② 入口の意見（作業員4）: nearOpinionForTurn の近い番（今より前・返信か AIX）→ 状況の文の読み（近い順に5件）
 *   同じ RPC は引数（件数・線）を変えて2回呼ばれる＝どちらの答えからも両方を作る（使われない控えが少し増えるだけ）
 */
export async function followupUrls(baseUrl: string, name: string, rows: ReadonlyArray<Record<string, unknown>>, nowMs: number): Promise<Followup[]> {
  if (name !== "match_conductor_focus" || !rows.length) return [];
  const out: Followup[] = [];
  const near = nearFromFocusRows(rows as unknown as FocusRpcRow[], null);
  const mids = keepMidsOf(near?.ids ?? []);
  if (mids.length >= 3) for (const u of await captureUrls(baseUrl, (sb) => keepQuery(sb as never, mids) as unknown as Promise<unknown>)) out.push({ name: "takeuchi_compose_examples", url: u });
  const rows0 = nearOpinionRows(rows as unknown as Array<{ source_key: string; turn_at?: string | null; actual: { route?: string } | null }>, nowMs);
  if (rows0.length) for (const u of await captureUrls(baseUrl, (sb) => turnMetaQuery(sb as never, rows0.slice(0, 5).map((h) => h.source_key)) as unknown as Promise<unknown>)) out.push({ name: "conductor_turn_vectors", url: u });
  return out;
}
