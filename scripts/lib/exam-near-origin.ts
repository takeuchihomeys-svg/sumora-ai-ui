// scripts/lib/exam-near-origin.ts — 試験の近い番の読みを「元の番の状況の文」で引く（純関数・LLM も DB も使わない）
//
// 2026-11-13 作業員8b（統括役の了承・弱い所 517「試験では入口の意見がほとんど出ない」・土台＝材料が届いていない）:
//   試験は状況の文 v2（liveSituationV2）を YUMA の写しの会話・台帳から作るので、本番の状況と違い、近い番が距離 0.2 に入らなかった
//   （nop9-b: 本番 7/7 で意見が出る番が試験では 1/7）。本番は竹内さんの過去の番ごとに状況の文 v2 の埋め込み（conductor_turn_vectors.embedding_v2）を
//   本番の関数で作って持っている。試験の鍵の要る読み（match_conductor_focus の頼み）を夜に鍵で読む時、その元の番の埋め込みで引き直す。
//   問題の控えに残すのは元の番の鍵（source_key と時刻）だけ。本文・実名は残さない。申込以降の番（gate-excluded）は差し替えない。
//   既定 off（EXAM_NEAR_ORIGIN_VECTOR=on・exam-near-resolve で効く）

export const nearOriginVectorOn = (env: Record<string, string | undefined> = process.env): boolean => String(env.EXAM_NEAR_ORIGIN_VECTOR ?? "").trim().toLowerCase() === "on";

/** 元の番（問題の会話・時刻）に一番近い竹内さんの番の行（maxMin 分以内・埋め込みのある物）。無ければ null */
export function pickOriginRow<T extends { source_key: string; turn_at: string; has_emb: boolean }>(rows: ReadonlyArray<T>, atIso: string, maxMin = 10): T | null {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return null;
  let best: T | null = null, bestD = Infinity;
  for (const r of rows) {
    if (!r.has_emb) continue;
    const d = Math.abs(Date.parse(r.turn_at) - at);
    if (Number.isFinite(d) && d <= maxMin * 60_000 && d < bestD) { best = r; bestD = d; }
  }
  return best;
}

/** 頼みの本文の埋め込みを元の番の物に差し替える（会話は元の会話を外す・p_before は元の時刻＝答えの番とその後は入らない）。JSON でなければそのまま */
export function originBody(body: string, embedding: string, origin: { conv: string; at: string }): string {
  let b: Record<string, unknown>;
  try { b = JSON.parse(body) as Record<string, unknown>; } catch { return body; }
  if (!b || typeof b !== "object" || Array.isArray(b)) return body;
  return JSON.stringify({ ...b, query_embedding: embedding, p_exclude_conv: origin.conv, p_before: origin.at });
}

/** 差し替えてよい頼みか: 近い番の RPC・元の会話と時刻と問題 id があり・申込以降で外した問題でない */
export function originEligible(req: { name: string; oconv?: string | null; oat?: string | null; pid?: string | null }, gateExcluded: ReadonlyMap<string, string>): boolean {
  return req.name === "match_conductor_focus" && !!req.oconv && !!req.oat && !!req.pid && !gateExcluded.has(req.pid);
}
