// app/lib/brain-route-keep.ts（純関数・DB/LLM なし）
// ブレインの「方向が空なら取り直す」で、最初の答えの道（返信／約束／AIX の種類）を残す。
//
// 2026-10-16 竹内悠馬（弱い所③）「ブレインを強化するのが質を上げるために最重要・根本的な部分を改善する」:
//   旧: brain-core の取り直し（brain:alt-empty-direction）は、取り直した答えに方向があれば答えを丸ごと入れ替えていた。
//   取り直しの目的は「下書きの芯（方向）が空」だけなのに、AIX の種類・約束の印・turn_contract・reply_mode まで入れ替わり、
//   同じ番で判断が2つの答えの混ぜ物ではなく「後から来た別の判断」になっていた（揺れの元・説明できない道の変わり方）。
// 決め: 道の欄は最初の答えのまま。方向（reply_direction）は取り直しから入れ、最初の答えで空の欄だけ取り直しで埋める。
//   戻す: BRAIN_EMPTY_DIRECTION_KEEP_ROUTE=off（旧の丸ごと入れ替え）

/** 道を決める欄（最初の答えのまま残す。null も「AIX なし」という正当な道なので埋めない） */
export const ROUTE_KEYS = [
  "action", "aix", "reply_mode", "two_stage", "turn_contract", "check_pattern", "template_hint", "after_aix_template",
  "first_contact_pickup", "alt_actions", "two_choice_mode", "engagement_stance", "condition_change_type", "condition_change_scope",
] as const;

export function emptyDirectionKeepRouteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_EMPTY_DIRECTION_KEEP_ROUTE ?? "").trim().toLowerCase() !== "off";
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return !v.trim();
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * 最初の答え（first）に、取り直し（retry）の方向を入れる。道の欄は first のまま。
 * first の空の欄（道の欄以外）は retry で埋める。reply_direction は retry の物（first は空なので取り直した）。
 */
export function mergeEmptyDirectionRetry(first: Record<string, unknown>, retry: Record<string, unknown>): Record<string, unknown> {
  const route = new Set<string>(ROUTE_KEYS);
  const out: Record<string, unknown> = { ...first };
  for (const [k, v] of Object.entries(retry)) {
    if (route.has(k)) continue;
    if (k === "reply_direction" || isEmptyValue(out[k])) out[k] = v;
  }
  return out;
}
