// app/lib/conductor-focus-server.ts — 今の番に近い、竹内さんの過去の番の重点を引く（作業員5・11/05・既定 off・CONDUCTOR_FOCUS=shadow の時だけ呼ぶ）
//   KB P0 575a7cd5 ④: ベクトルは数の重みのためではなく「竹内さんの近い過去の番で何が重点だったか」を引くために使う。
//   今の番の状況の文は過去の番と同じ関数（conductor-focus.turnSituationTextV2）で作る（KB P1 977cbded ①）。
//   引くのは match_conductor_focus（サーバーの鍵だけ・時間順で前の番だけ・同じ会話とお客様を外す）。
//   束の線: 手元の確かめ（11/05・980番）で、束 0.2・5件以上＋束の外は場面の値が一番良かった（場面の値 42.0% → 46.2%）＝既定の線。決めるのは統括（この1行は参考）
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { nearShapeLine } from "@/app/lib/two-message-plan";
import { nearestFocus, sceneMajorityFocus, FOCUS_KINDS, type Focus, type NearFocus } from "@/app/lib/conductor-focus";

export const FOCUS_BAND = 0.2;
export const FOCUS_MIN_N = 5;

/** 近い番の重点と、近い番の竹内さんの組み合わせの型の参考の1行（作業員7 nearShapeLine・planForConductor の参考だけ・決め直さない） */
export type NearTurns = { near: NearFocus | null; shape: { line: string; digest: string } | null };
/** match_conductor_focus の答えの1行 */
export type FocusRpcRow = { source_key: string; scene: string; focus: string; distance: number; actual: { shape?: string } | null };
/**
 * 近い番の重点（純関数・nearFocusForTurn の中身）。2026-11-07 作業員8（統括役: 試験の写しの台本が試験の道と同じ関数で後ろの読みを作る）:
 *   ids（束の中の近い番・5件まで）は場面に関係なく決まる＝台本は scene=null で呼んでも同じ ids
 */
export function nearFromFocusRows(all: ReadonlyArray<FocusRpcRow>, scene: string | null): NearFocus | null {
  const rows = all.filter((r) => (FOCUS_KINDS as readonly string[]).includes(r.focus));
  // 束の外は場面の多い重点（引いた近い番のうち同じ場面の物から・無ければ null）
  const sceneFocus = sceneMajorityFocus(rows.filter((r) => r.scene === scene).map((r) => r.focus as Focus));
  return nearestFocus(rows.map((r) => ({ id: r.source_key, focus: r.focus as Focus, dist: r.distance })), { band: FOCUS_BAND, minN: FOCUS_MIN_N, sceneFocus });
}
/** keep を読む message_id（純関数・nearKeepShareFor と台本で同じ） */
export function keepMidsOf(ids: ReadonlyArray<string>): string[] {
  return [...new Set(ids.map((k) => (k.startsWith("msg:") ? k.slice(4) : k)).filter(Boolean))].slice(0, 30);
}
/** keep の読み（問い合わせの形を1か所に・nearKeepShareFor と台本で同じ URL になる） */
export function keepQuery(sb: SupabaseClient, mids: ReadonlyArray<string>) {
  return sb.from("takeuchi_compose_examples").select("message_id, keep:anatomy->keep").in("message_id", [...mids]);
}

export async function nearFocusForTurn(sb: SupabaseClient, o: { conversationId: string; propertyCustomerId: string | null; turnAt: string; scene: string; situationV2: string }): Promise<NearTurns | null> {
  try {
    const emb = await generateEmbedding(o.situationV2);
    if (!emb) return null;
    const { data, error } = await sb.rpc("match_conductor_focus", {
      query_embedding: JSON.stringify(emb), p_before: o.turnAt, p_exclude_conv: o.conversationId, p_exclude_pc: o.propertyCustomerId,
      match_count: 30, max_distance: 0.3, p_writer: "takeuchi",
    });
    if (error) return null;
    const all = ((data ?? []) as FocusRpcRow[]);
    const shape = nearShapeLine(all.filter((r) => r.distance <= FOCUS_BAND).map((r) => ({ shape: r.actual?.shape ?? null, dist: r.distance })));
    return { near: nearFromFocusRows(all, o.scene), shape };
  } catch {
    return null;
  }
}

/**
 * 今の番（本番）の状況の文 v2 を、過去の番と同じ作り（conductor-turn-vectors-server の v2）で作って近い番を引く（CONDUCTOR_FOCUS=shadow の時だけ・入口の統括の前）。
 *   読む物: その会話の直近30日の通（新しい順300件まで）・AIX の記録（同じ窓・送信の15分前〜2分後で突き合わせ）・会話の表示名（伏せ用）。埋め込み1回（約 $0.00001）
 *   失敗・時間切れは null（入口の統括は近い番の1行なしで読む＝今まで通り）
 */
export async function liveNearTurns(sb: SupabaseClient, o: { conversationId: string; propertyCustomerId: string | null; turnAt: string; scene: string; customerTurn: string }): Promise<NearTurns | null> {
  const situationV2 = await liveSituationV2(sb, o);
  if (!situationV2) return null;
  return await nearFocusForTurn(sb, { conversationId: o.conversationId, propertyCustomerId: o.propertyCustomerId, turnAt: o.turnAt, scene: o.scene, situationV2 });
}

/** 2026-11-07 作業員4（入口の意見 conductor-near-opinion-server も同じ状況の文 v2 で引くため、liveNearTurns から切り出した・中身は同じ）。失敗は null */
export async function liveSituationV2(sb: SupabaseClient, o: { conversationId: string; turnAt: string; scene: string; customerTurn: string }): Promise<string | null> {
  try {
    const since = new Date(Date.parse(o.turnAt) - 30 * 86_400_000).toISOString();
    const [{ data: msgs }, { data: aix }, { data: conv }] = await Promise.all([
      sb.from("messages").select("sender, text, created_at, is_aix_generated, line_message_id").eq("conversation_id", o.conversationId).gte("created_at", since).lt("created_at", o.turnAt).order("created_at", { ascending: false }).limit(300),
      sb.from("aix_usage_logs").select("created_at, aix_type, line_message_id").eq("conversation_id", o.conversationId).gte("created_at", since).order("created_at", { ascending: true }).limit(500),
      sb.from("conversations").select("customer_name").eq("id", o.conversationId).maybeSingle(),
    ]);
    const { maskPII } = await import("@/app/lib/pii-mask");
    const { customerNameTokens, maskCustomerNames } = await import("@/app/lib/compose-name-mask");
    const { maskContactBits } = await import("@/app/lib/conductor-turn-vectors");
    const { turnSituationTextV2 } = await import("@/app/lib/conductor-focus");
    const tokens = customerNameTokens([(conv as { customer_name?: string | null } | null)?.customer_name ?? null]);
    const mask = (t: string) => maskContactBits(maskPII(maskCustomerNames(t, tokens)));
    const logs = (aix ?? []) as Array<{ created_at: string; aix_type: string; line_message_id: string | null }>;
    const byLine = new Map(logs.filter((a) => a.line_message_id).map((a) => [a.line_message_id as string, a.aix_type]));
    const aixOf = (m: { created_at: string; line_message_id: string | null }) => {
      if (m.line_message_id && byLine.has(m.line_message_id)) return byLine.get(m.line_message_id)!;
      const t = Date.parse(m.created_at);
      const near = logs.filter((a) => Date.parse(a.created_at) >= t - 15 * 60_000 && Date.parse(a.created_at) <= t + 2 * 60_000).sort((x, y) => Math.abs(Date.parse(x.created_at) - t) - Math.abs(Date.parse(y.created_at) - t))[0];
      return near?.aix_type ?? "aix_unknown";
    };
    const hist: Array<{ sender: string; text: string; created_at: string; aixType: string | null }> = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null }>).reverse()
      .map((m) => ({ sender: m.sender, text: mask(m.text ?? ""), created_at: m.created_at, aixType: m.is_aix_generated ? aixOf(m) : null }));
    // 今の番の連投（最後に続くお客様の通）は hist に入れない＝過去の番の作り（番の始まりより前）と揃える
    while (hist.length && hist[hist.length - 1].sender === "customer") hist.pop();
    return turnSituationTextV2({ scene: o.scene, hist, customerMasked: mask(o.customerTurn), nowMs: Date.parse(o.turnAt) });
  } catch {
    return null;
  }
}

/**
 * 近い竹内さんの番（match_conductor_focus の source_key "msg:<id>" か messages.id）の「継続の約束を添えたか」の割合（11/06 統括役・作業員9 が1行で使う）。
 *   読む物: takeuchi_compose_examples.anatomy.keep（重点を読ませた解剖・11/05 から）。分かる番が minN 未満なら null。失敗も null
 *   例: const share = await nearKeepShareFor(sb, near?.ids ?? []); relationKeep({ scene, customerAskedNew, nearKeepShare: share, keptToday })
 */
export async function nearKeepShareFor(sb: SupabaseClient, ids: ReadonlyArray<string>, minN = 3): Promise<number | null> {
  const mids = keepMidsOf(ids);
  if (mids.length < minN) return null;
  try {
    const { data, error } = await keepQuery(sb, mids);
    if (error) return null;
    const { keepShareOf } = await import("@/app/lib/conductor-focus");
    return keepShareOf(((data ?? []) as Array<{ keep: unknown }>).map((r) => (r.keep === true ? true : r.keep === false ? false : null)), minN);
  } catch { return null; }
}
