// app/lib/conductor-near-opinion-server.ts — 入口の意見の材料を引く（CONDUCTOR_NEAR_OPINION=on の時だけ呼ぶ・既定 off）
//   2026-11-07 作業員5の指摘で v2 に: v1（match_conductor_turns）の行は穴 291（aix_unknown 152）・292（段階に後の status 292）が残り、
//   v1 の束は場面の値とほぼ同じ当たり（11/05 42%）。KB dc0d77cf の 0.8以上 83% は v2（その時点の進み・直前の要点・開いている約束・送った物）で測った物。
//   今の番の状況の文 v2 は liveNearTurns と同じ作り（conductor-focus-server.liveSituationV2）。引くのは match_conductor_focus
//   （サーバーの鍵だけ・v2 の行だけ・時間順で今の番より前・同じ会話とお客様を外す・竹内さんの番）。埋め込み1回（約 $0.00001）＋読み数回。
//   一番近い番の要約は conductor_turn_vectors.situation（伏せ済み）の「お客様:」の行。失敗・時間切れ・線に届かない時は null（ブレインは今まで通り）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "@/app/lib/knowledge-utils";
import { maskContactBits, APPLY_DOCS_RE } from "@/app/lib/conductor-turn-vectors";
import { liveSituationV2 } from "@/app/lib/conductor-focus-server";
import { nearAnatomyOn, nearAnatomyMajority, nearAnatomyLine, turnAnatomyOf } from "@/app/lib/turn-anatomy-fields";
import { nearOpinion, nearOpinionLine, isPromiseText, NEAR_OPINION_BAND, NEAR_OPINION_MIN_SHARE, type NearOpinion, type NearTurnRow } from "@/app/lib/conductor-near-opinion";

export type NearOpinionResult = { op: NearOpinion | null; line: string; inBand: number };

/**
 * 2026-11-15 作業員H（統括役の頼み 5・nop9o-1 の時間切れ）: match_conductor_focus の RPC そのものは 18ms（1,150行・EXPLAIN）・手元から 130〜180ms。
 *   時間切れの元は RPC ではなく、2秒の中に読みが順番に 8回（状況の文の読み→埋め込み→RPC→状況の文→近い返信の文→手本の文→申込の線→表示名）並ぶ事。
 *   手元の実測（f6e1d308・11/14）: 冷えた1回目 状況 331・埋め込み 451・RPC 178・状況の文 144ms（ここまでで 1.1秒）、2回目以降 0.4秒。ブレインの他の読みと重なる本番・試験の初回で 2秒を越える。
 *   NEAR_OPINION_PARALLEL（11/18 から既定 on・止める =off）: 互いに待たない読みを同時に（状況の文と近い返信の文・申込の線と表示名）＝2往復減らす。読みの URL は変えない（試験の写しの台本が同じ URL で引くため）。
 *   trace を渡すと、どの段まで進んだか・段ごとの ms を書く（時間切れの時にブレインのログに出す）。
 */
// 11/18 統括役の決め: h1115-nopar-on-p1/p2（7問・brain）で悪化0 → 既定 on（止める NEAR_OPINION_PARALLEL=off）
export const nearOpinionParallelOn = (env: Record<string, string | undefined> = process.env): boolean => (env.NEAR_OPINION_PARALLEL ?? "").trim().toLowerCase() !== "off";
export type NearOpinionTrace = { stage: string; ms: Record<string, number> };

/** minShare: 既定 0.8（入口の意見の線）。作業員5の 294（予算と止め時）は 0.65 等を渡して使う */
export async function nearOpinionForTurn(sb: SupabaseClient, o: {
  conversationId: string; propertyCustomerId: string | null; turnAt: string; scene: string; customerTurn: string; minShare?: number;
}, trace?: NearOpinionTrace): Promise<NearOpinionResult | null> {
  let tMark = Date.now();
  const mark = (stage: string) => { if (!trace) return; const n = Date.now(); trace.ms[trace.stage] = n - tMark; trace.stage = stage; tMark = n; };
  if (trace) trace.stage = "situation";
  const parallel = nearOpinionParallelOn();
  try {
    const situationV2 = await liveSituationV2(sb, { conversationId: o.conversationId, turnAt: o.turnAt, scene: o.scene, customerTurn: o.customerTurn });
    if (!situationV2) return null;
    mark("embedding");
    const emb = await generateEmbedding(situationV2);
    if (!emb) return null;
    mark("rpc");
    const { data, error } = await sb.rpc("match_conductor_focus", {
      query_embedding: JSON.stringify(emb), p_before: o.turnAt, p_exclude_conv: o.conversationId, p_exclude_pc: o.propertyCustomerId,
      match_count: 40, max_distance: NEAR_OPINION_BAND, p_writer: "takeuchi",
    });
    if (error || !data) return null;
    const hits = data as Array<{ source_key: string; distance: number; turn_at?: string | null; focus?: string | null; actual: { route?: string; aix?: string | null; picker?: string | null } | null }>;
    if (!hits.length) return { op: null, line: "", inBand: 0 };
    const tNow = Date.parse(o.turnAt);
    const rows0 = nearOpinionRows(hits, tNow);
    mark("meta");
    // NEAR_OPINION_PARALLEL=on: 近い返信の文の読み（下の replyIds と同じ物・同じ URL）を状況の文の読みと同時に始める
    const replyIdsOf = (rs: ReadonlyArray<{ key: string; route: string; distance: number }>) => rs.filter((r) => r.route === "reply" && r.distance <= NEAR_OPINION_BAND).map((r) => (r.key.startsWith("msg:") ? r.key.slice(4) : r.key)).slice(0, 30);
    const early = parallel ? replyIdsOf(rows0.map((h) => ({ key: h.source_key, route: String(h.actual?.route ?? ""), distance: h.distance }))) : [];
    const earlyTx = parallel && early.length ? Promise.resolve(sb.from("messages").select("id, text").in("id", early)).catch(() => ({ data: null })) : null;
    // 一番近い番の要約（伏せ済みの状況の文）。試験の写しは一番近い番の分だけ入っている（作業員8 82ecdb4e）
    const { data: meta } = rows0.length ? await turnMetaQuery(sb, rows0.slice(0, 5).map((h) => h.source_key)) : { data: [] };
    mark("reply_texts");
    const sitOf = new Map(((meta ?? []) as Array<{ source_key: string; situation: string | null }>).map((m) => [m.source_key, m.situation]));
    const rows: NearTurnRow[] = rows0.map((h) => ({ key: h.source_key, distance: h.distance, route: h.actual!.route as "aix" | "reply", aix: h.actual?.aix ?? null, picker: h.actual?.picker ?? null, situation: sitOf.get(h.source_key) ?? null, focus: h.focus ?? null }));
    // 2026-11-07 統括役の決め (a): 重点（focus）は「ピックアップしてお送り」の約束の文を propose に分けていた（nop4-on）。
    //   返信の番は、竹内さんの実際の最初の文が約束の形（探してお送り・確認させて頂きます・作成しお送り）なら約束（promise_make）として数える
    // 2026-11-12 作業員23（根C・CONDUCTOR_NEAR_ANATOMY=on の時だけ・既定 off）: 同じ近い返信の番の文から、誘導先・継続の約束・期日・締め・推す点の多数派（文は渡さない・種類と割合だけ）
    let anatomyLine = "";
    try {
      const replyIds = replyIdsOf(rows);
      if (replyIds.length) {
        const { data: tx } = earlyTx && replyIds.join(",") === early.join(",") ? await earlyTx : await sb.from("messages").select("id, text").in("id", replyIds);
        const promiseOf = new Map(((tx ?? []) as Array<{ id: string; text: string | null }>).map((m) => [m.id, isPromiseText(m.text ?? "")]));
        for (const r of rows) { const id = r.key.startsWith("msg:") ? r.key.slice(4) : r.key; if (r.route === "reply" && promiseOf.get(id)) r.focus = "promise_make"; }
        if (nearAnatomyOn()) {
          const textOf = new Map(((tx ?? []) as Array<{ id: string; text: string | null }>).map((m) => [m.id, m.text ?? ""]));
          const list = replyIds.map((id) => textOf.get(id) ?? "").filter((t) => t.trim() && !APPLY_DOCS_RE.test(t)).map(turnAnatomyOf);
          anatomyLine = nearAnatomyLine(nearAnatomyMajority(list));
        }
      }
    } catch { /* 読めなければ重点のまま */ }
    mark("exemplar");
    const op = nearOpinion(rows, { minShare: o.minShare ?? NEAR_OPINION_MIN_SHARE });
    if (!op) { mark("done"); return { op: null, line: "", inBand: rows.length }; }
    // 一番近い同じ一手の番の、竹内さんの実際の最初の文（伏せる: その会話の表示名・連絡先）
    let tText: string | null = null;
    try {
      const mid = op.exemplar.key.startsWith("msg:") ? op.exemplar.key.slice(4) : op.exemplar.key;
      const { data: msg } = await sb.from("messages").select("text, conversation_id, created_at").eq("id", mid).maybeSingle();
      const m = msg as { text: string | null; conversation_id: string; created_at: string } | null;
      // 2026-11-07 統括役の条件 ③: 申込の書類以降の番の文は渡さない（DeepSeek の線 loadDeepseekCutoff と同じ線・読めない時も渡さない）
      const { loadDeepseekCutoff, NO_CUTOFF } = await import("@/app/lib/post-apply");
      // NEAR_OPINION_PARALLEL=on: 表示名の読み（同じ URL）を申込の線の読みと同時に始める（使うのは線の内側の時だけ）
      const convEarly = parallel && m?.text ? Promise.resolve(sb.from("conversations").select("customer_name").eq("id", m.conversation_id).maybeSingle()).catch(() => ({ data: null })) : null;
      const cut = m ? await loadDeepseekCutoff(sb as unknown as Parameters<typeof loadDeepseekCutoff>[0], m.conversation_id) : null;
      const okByCut = cut === NO_CUTOFF || (typeof cut === "string" && !!m && Date.parse(m.created_at) > Date.parse(cut));
      if (m?.text && okByCut && !APPLY_DOCS_RE.test(m.text)) {
        const { data: conv } = convEarly ? await convEarly : await sb.from("conversations").select("customer_name").eq("id", m.conversation_id).maybeSingle();
        const { maskPII } = await import("@/app/lib/pii-mask");
        const { customerNameTokens, maskCustomerNames } = await import("@/app/lib/compose-name-mask");
        const tokens = customerNameTokens([(conv as { customer_name?: string | null } | null)?.customer_name ?? null]);
        tText = maskContactBits(maskPII(maskCustomerNames(m.text, tokens)));
        if (/^\s*\[(?:画像|スタンプ)\]\s*$/.test(tText)) tText = null;
      }
    } catch { tText = null; }
    mark("done");
    const line0 = nearOpinionLine(op, tText);
    return { op, line: anatomyLine && op.move === "返信" && line0 ? `${line0}\n${anatomyLine}` : line0, inBand: rows.length };
  } catch {
    return null;
  }
}

/** 入口の意見で数える近い番（純関数・今の番より前・返信か AIX の番）。2026-11-07 作業員8: 試験の写しの台本が同じ関数で後ろの読みを先に控える */
export function nearOpinionRows<T extends { turn_at?: string | null; actual: { route?: string } | null }>(hits: ReadonlyArray<T>, tNow: number): T[] {
  return hits.filter((h) => (h.actual?.route === "aix" || h.actual?.route === "reply") && (!h.turn_at || Date.parse(h.turn_at) < tNow));
}
/** 近い番の状況の文の読み（問い合わせの形を1か所に・台本と同じ URL になる） */
export function turnMetaQuery(sb: SupabaseClient, keys: ReadonlyArray<string>) {
  return sb.from("conductor_turn_vectors").select("source_key, situation").in("source_key", [...keys]);
}
