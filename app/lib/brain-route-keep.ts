// app/lib/brain-route-keep.ts（純関数・DB/LLM なし）
// ブレインの「方向が空なら取り直す」で、最初の答えの道（返信／約束／AIX の種類）を残す。
//
// 2026-10-16 竹内悠馬（弱い所③）「ブレインを強化するのが質を上げるために最重要・根本的な部分を改善する」:
//   旧: brain-core の取り直し（brain:alt-empty-direction）は、取り直した答えに方向があれば答えを丸ごと入れ替えていた。
//   取り直しの目的は「下書きの芯（方向）が空」だけなのに、AIX の種類・約束の印・turn_contract・reply_mode まで入れ替わり、
//   同じ番で判断が2つの答えの混ぜ物ではなく「後から来た別の判断」になっていた（揺れの元・説明できない道の変わり方）。
// 決め: 道の欄は最初の答えのまま。方向（reply_direction）は取り直しから入れ、最初の答えで空の欄だけ取り直しで埋める。
//   戻す: BRAIN_EMPTY_DIRECTION_KEEP_ROUTE=off（旧の丸ごと入れ替え）

/**
 * 2026-10-16 本質（turn_contract）と最後の AIX の食い違い: ブレインが同じ答えの中で、依頼の答え方（asks の aix）と最後の aix の欄に別の AIX を書く。
 *   本番（Claude）3日で2番: 10/13 の事例 g（依頼の答え cost_breakdown＝竹内さんの正解／最後の欄 viewing_invite）・10/14 の1番。試験の q156（依頼 viewing_invite＝正解／最後 application_push）。
 *   決め: 両方に AIX があって違い、AIX の依頼が1種類だけ（または先に答える依頼 lead_with が AIX）なら、本質の AIX にそろえる（返信の中身は本質で決まる＝同じ答えの中の矛盾は本質を勝たせる）。
 *   最後の欄が null の時は触らない（2段＝約束の後で AIX の作り）。戻す BRAIN_TC_AIX_ALIGN=off
 */
export function tcAixAlignEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_TC_AIX_ALIGN ?? "").trim().toLowerCase() !== "off";
}
export function tcLeadAix(topAix: string | null | undefined, tc: unknown, normalize: (k: unknown) => string | null): string | null {
  const top = normalize(topAix);
  if (!top || !tc || typeof tc !== "object") return null;
  const asks = Array.isArray((tc as { asks?: unknown }).asks) ? ((tc as { asks: Array<{ route?: unknown; aix?: unknown }> }).asks) : [];
  const lw = (tc as { lead_with?: unknown }).lead_with;
  const lead = typeof lw === "number" ? asks[lw] : typeof lw === "string" && /^\d+$/.test(lw) ? asks[Number(lw)] : undefined;
  const aixKeys = [...new Set(asks.filter((a) => a?.route === "aix").map((a) => normalize(String(a.aix ?? "").split("/")[0])).filter((k): k is string => !!k))];
  const leadKey = lead?.route === "aix" ? normalize(String(lead.aix ?? "").split("/")[0]) : null;
  // 確かめる人 10/16（関所 q048）: 最後の欄の AIX も本質の AIX の依頼の1つなら食い違いではない（2つの依頼のどちらを先に AIX にするかの選び）＝触らない。
  //   旧は lead_with（見積）で最後の欄（待ち合わせ場所＝竹内さんの正解）を上書きしていた。そろえるのは最後の欄が本質のどの依頼にも無い AIX の時だけ（q156 の型）
  if (aixKeys.includes(top)) return null;
  const pick = leadKey ?? (aixKeys.length === 1 ? aixKeys[0] : null);
  return pick && pick !== top ? pick : null;
}

/**
 * 2026-10-16 関所（q133・q150・q157）: ブレインが本質（asks）で「募集状況を確認する／御見積書を作る」を route=promise に決め、最後の aix の欄を null にした番は、
 *   2段（約束の返信＋後で AIX）の印が立たず、ただの返信の番になっていた（約束の後の AIX【物件確認した】【見積書送る】が出ない）。
 *   最後の aix が null で、約束の依頼が確認・見積の時だけ、2段の判定（resolveTwoStage）に渡す AIX をその約束から作る（finalAix は変えない）。戻す BRAIN_TC_PROMISE_TWO_STAGE=off
 */
export function tcPromiseTwoStageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BRAIN_TC_PROMISE_TWO_STAGE ?? "").trim().toLowerCase() !== "off";
}
export function promiseAixFromContract(tc: unknown): "property_check_result" | "estimate_sheet" | null {
  if (!tc || typeof tc !== "object") return null;
  const c = tc as { asks?: Array<{ route?: unknown; aix?: unknown; answer?: unknown; about?: unknown }>; close_only?: unknown };
  if (c.close_only === true || c.close_only === "true") return null;
  const promises = (Array.isArray(c.asks) ? c.asks : []).filter((a) => a?.route === "promise");
  if (!promises.length) return null;
  const keys = promises.map((a) => String(a.aix ?? ""));
  if (keys.some((k) => /^property_check_result/.test(k))) return "property_check_result";
  if (keys.some((k) => /^estimate_sheet/.test(k))) return "estimate_sheet";
  const ans = promises.map((a) => `${a.answer ?? ""}`).join(" ");
  if (/募集状況|空き|空室|管理会社に確認|可否.*確認|確認.*可否/.test(ans)) return "property_check_result";
  if (/見積/.test(ans)) return "estimate_sheet";
  return null;
}

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
