// app/lib/conductor-turn-vectors-server.ts — 近い過去の番の表（conductor_turn_vectors）を夜に埋める（⑤(a)・作業員1・11/04・既定 off）
//   竹内さん本人の送信（messages.staff_writer='takeuchi'）から、お客様の発言への一手だけを番にする（replay-build と同じ作り・申込の書類の手前まで）。
//   伏せ: compose-name-mask（その会話のお客様の表示名）＋maskPII。埋め込みは knowledge-utils.generateEmbedding（1536次元）。
//   CONDUCTOR_TURN_VECTORS=on かつ apply の時だけ表に書く（表は竹内さんの了承の後に作る）。それ以外は作れる行の数だけ数えて返す（埋め込みも呼ばない＝費用 0）。
//   1晩の上限 limit（既定 200）・同じ source_key は作り直さない・夜だけ（呼ぶ側の cron）
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation } from "@/app/lib/test-conversations";
import { maskPII } from "@/app/lib/pii-mask";
import { customerNameTokens, maskCustomerNames } from "@/app/lib/compose-name-mask";
import { textFingerprint } from "@/app/lib/brain-judge-examples";
import { resolveReplyScene } from "@/app/lib/reply-scene";
import { APPLY_DOCS_RE, actualOf, hitsOf, turnVectorRow, conductorTurnVectorsOn, maskContactBits, turnSendsForShape, type TurnVectorRow } from "@/app/lib/conductor-turn-vectors";
import { shapeOfSends } from "@/app/lib/two-message-plan";
import { focusOfTakeuchiTurn, openPromiseAt, turnSituationTextV2, type HistMsg } from "@/app/lib/conductor-focus";

/** 2026-11-05 作業員5（竹内さん承認・KB P0 575a7cd5・P1 977cbded）: 状況の文 v2・埋め込み v2・竹内さんの番の重点も書く（既定 off・=on で）。列 situation_v2/embedding_v2/focus が要る */
export const conductorTurnVectorsV2On = (env: Record<string, string | undefined> = process.env) => (env.CONDUCTOR_TURN_VECTORS_V2 ?? "").trim().toLowerCase() === "on";

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; line_message_id: string | null; staff_writer: string | null; staff_writer_confidence: string | null };
const COLS = "id, conversation_id, sender, text, created_at, is_aix_generated, line_message_id, staff_writer, staff_writer_confidence";

export type FillResult = { candidates: number; built: number; skippedExisting: number; skippedApplyDocs: number; written: number; dry: boolean; samples?: string[]; timeBudgetHit?: boolean; v2?: boolean; aixByTime?: number };
type V2Row = TurnVectorRow & { situation_v2?: string; focus?: string | null };

export async function fillConductorTurnVectors(sb: SupabaseClient, o: { days?: number; limit?: number; apply?: boolean; samples?: number; before?: string | null; budgetMs?: number } = {}): Promise<FillResult> {
  // 2026-11-04 1回目の一括の埋めが 300秒の上限で切れた（100番を書いた所で時間切れ・番ごとに読みが数回＋埋め込み）＝時間の予算で止めて、それまでの分を必ず書く
  const t0 = Date.now(), budget = o.budgetMs ?? 220_000;
  const days = Math.min(120, Math.max(7, o.days ?? 90)), limit = Math.min(400, Math.max(10, o.limit ?? 200));
  const write = !!o.apply && conductorTurnVectorsOn();
  const v2 = conductorTurnVectorsV2On();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: tk, error } = await sb.from("messages").select(COLS).eq("staff_writer", "takeuchi").eq("staff_writer_confidence", "sure").neq("sender", "customer")
    .gte("created_at", since).lt("created_at", o.before ?? new Date(Date.now() + 60_000).toISOString()).order("created_at", { ascending: false }).limit(limit * 4);
  if (error) throw new Error(`messages: ${error.message}`);
  const sends = ((tk ?? []) as Msg[]).filter((m) => !isTestConversation(m.conversation_id));
  // 表がある時だけ、もう入っている番を外す（dry は表が無くても動く）
  let existing = new Set<string>();
  if (write) {
    const keys = sends.map((s) => `msg:${s.id}`);
    for (let i = 0; i < keys.length; i += 200) {
      let q = sb.from("conductor_turn_vectors").select("source_key").in("source_key", keys.slice(i, i + 200));
      if (v2) q = q.not("embedding_v2", "is", null); // v2 は v2 の埋め込みが無い行を作り直す（v1 の行も v2 で埋める）
      const { data } = await q;
      for (const r of (data ?? []) as Array<{ source_key: string }>) existing.add(r.source_key);
    }
  }
  const res: FillResult = { candidates: sends.length, built: 0, skippedExisting: 0, skippedApplyDocs: 0, written: 0, dry: !write, ...(v2 ? { v2: true, aixByTime: 0 } : {}) };
  const seen = new Set<string>();
  // 2026-11-04 統括役「1番ごとの読みを束ねて速く（読みの回数＝DB の負けも減る）」: 送信を CHUNK 件ずつ、会話の行・前後の通・AIX の記録・見張りの番を
  //   それぞれ1回の問い合わせ（会話×時刻の索引）で読み、手元で合わせる。埋め込みも束ねて1回で呼ぶ（embedding_cache には書かない＝この文は使い回さない）
  const CHUNK = 40;
  const todo = sends.filter((s) => { if (existing.has(`msg:${s.id}`)) { res.skippedExisting++; return false; } return true; });
  for (let ci = 0; ci < todo.length; ci += CHUNK) {
    if (res.built >= limit) break;
    if (Date.now() - t0 > budget) { res.timeBudgetHit = true; break; }
    const chunk = todo.slice(ci, ci + CHUNK);
    const convs = [...new Set(chunk.map((s) => s.conversation_id))];
    // v2 は進み・送った物を見るので 30日さかのぼる（v1 は 3日のまま）
    const tMin = new Date(Math.min(...chunk.map((s) => Date.parse(s.created_at))) - (v2 ? 30 : 3) * 86_400_000).toISOString();
    const tMax = new Date(Math.max(...chunk.map((s) => Date.parse(s.created_at))) + 6 * 3_600_000).toISOString(); // 11/05: 番の型（続く AIX・テンプレート）まで見るので 6時間先まで（前は 5分）
    const [convRows, msgRows, aixRows, watchRows] = await Promise.all([
      sb.from("conversations").select("id, customer_name, property_customer_id, status").in("id", convs),
      pageIn<Msg>(sb, "messages", COLS, convs, "created_at", tMin, tMax),
      pageIn<{ conversation_id: string; created_at: string; aix_type: string; check_pattern: string | null; line_message_id: string | null }>(sb, "aix_usage_logs", "conversation_id, created_at, aix_type, check_pattern, line_message_id", convs, "created_at", new Date(Date.parse(tMin) - 30 * 60_000).toISOString(), tMax),
      pageIn<{ conversation_id: string; customer_turn_at: string; brain_reply_mode: string | null; brain_action: string | null; conv_status: string | null }>(sb, "line_watch_turns", "conversation_id, customer_turn_at, brain_reply_mode, brain_action, conv_status", convs, "customer_turn_at", tMin, tMax),
    ]);
    const convOf = new Map(((convRows.data ?? []) as Array<{ id: string; customer_name: string | null; property_customer_id: string | null; status: string | null }>).map((c) => [c.id, c]));
    const msgsOf = groupBy(msgRows, (m) => m.conversation_id);
    for (const l of msgsOf.values()) l.sort((x, y) => x.created_at.localeCompare(y.created_at));
    const aixByLine = new Map(aixRows.filter((a) => a.line_message_id).map((a) => [a.line_message_id as string, a]));
    // 2026-11-05 穴 291: line_message_id で取れない AIX が 200/323（0件）。同じ会話の送信の15分前〜2分後の記録で取る（199/200 取れた）
    // 2026-11-06 統括役: aixByTime は同じ通を何度も数えて大きく出ていた（番ごとの hist で毎回呼ぶ）＝通ごとに1回だけ数え、突き合わせも覚えて使い回す
    const aixMemo = new Map<string, (typeof aixRows)[number] | undefined>();
    const aixOfMsg = (m: Msg) => {
      if (!m.is_aix_generated) return undefined;
      if (aixMemo.has(m.id)) return aixMemo.get(m.id);
      const byLine = m.line_message_id ? aixByLine.get(m.line_message_id) : undefined;
      if (byLine) { aixMemo.set(m.id, byLine); return byLine; }
      const t = Date.parse(m.created_at);
      const near = aixRows.filter((a) => a.conversation_id === m.conversation_id && Date.parse(a.created_at) >= t - 15 * 60_000 && Date.parse(a.created_at) <= t + 2 * 60_000)
        .sort((x, y) => Math.abs(Date.parse(x.created_at) - t) - Math.abs(Date.parse(y.created_at) - t))[0];
      if (near && res.aixByTime !== undefined) res.aixByTime++;
      aixMemo.set(m.id, near);
      return near;
    };
    const watchOf = new Map(watchRows.map((w) => [`${w.conversation_id}|${new Date(w.customer_turn_at).toISOString()}`, w]));
    const built: V2Row[] = [];
    for (const s of chunk) {
      if (res.built + built.length >= limit) break;
      const all = msgsOf.get(s.conversation_id) ?? [];
      const pv = all.filter((m) => m.created_at < s.created_at).slice(-12).reverse();
      if (!pv.length || pv[0].sender !== "customer") continue; // お客様の発言への一手だけ
      const turn: Msg[] = []; for (const m of pv) { if (m.sender !== "customer") break; turn.push(m); }
      const turnAt = turn[turn.length - 1]?.created_at ?? s.created_at;
      const key = `${s.conversation_id}|${turnAt}`;
      if (seen.has(key)) continue; seen.add(key);
      if (APPLY_DOCS_RE.test([...pv.map((m) => m.text ?? ""), s.text ?? ""].join("\n"))) { res.skippedApplyDocs++; continue; }
      const c = convOf.get(s.conversation_id);
      const tokens = customerNameTokens([c?.customer_name ?? null]);
      const mask = (t: string) => maskPII(maskCustomerNames(t, tokens));
      const custText = [...turn].reverse().map((m) => m.text ?? "").join("\n");
      const al = aixOfMsg(s);
      const last = pv.find((m) => m.sender !== "customer" && (m.text ?? "").trim());
      const lastKind = !last ? null : last.is_aix_generated ? `AIX:${aixOfMsg(last)?.aix_type ?? "aix_unknown"}` : "返信";
      const wt = watchOf.get(`${s.conversation_id}|${new Date(turnAt).toISOString()}`) ?? null;
      const actual = actualOf({ isAix: !!s.is_aix_generated, aixType: s.is_aix_generated ? al?.aix_type ?? "aix_unknown" : null, checkPattern: al?.check_pattern ?? null });
      // 2026-11-05 統括役: この番の竹内さんの組み合わせの型（最初の送信から次のお客様の発言の手前まで・付き物は外す・作業員7 shapeOfSends）
      const firstIdx = all.findIndex((m) => m.id === s.id);
      if (firstIdx >= 0) { const sh = shapeOfSends(turnSendsForShape(all, firstIdx)); if (sh) actual.shape = sh; }
      const row: V2Row = turnVectorRow({
        sendId: s.id, conversationId: s.conversation_id, propertyCustomerId: c?.property_customer_id ?? null,
        // 2026-11-04 場面は統括メタ・重みの表と同じ言葉（ReplyScene）。見張りの scene_key は使わない
        // 2026-11-05 穴 292: 見張りの番が無い時に今の会話の status（未来の値）を入れていた＝答えが漏れる。無い時は null（v2 は進みをその時点の AIX の歴から作る）
        scene: resolveReplyScene({ customerText: custText }).scene, stage: wt?.conv_status ?? null, customerMasked: mask(custText), lastStaffKind: lastKind,
        fp: turn.map((m) => textFingerprint(m.text ?? "")).filter((x): x is string => !!x), actual, hits: hitsOf(actual, wt ? { brainMode: wt.brain_reply_mode, brainAction: wt.brain_action } : null),
        writer: s.staff_writer, turnAt,
      });
      if (v2) {
        const hist: HistMsg[] = all.filter((m) => m.created_at < turnAt).map((m) => ({ sender: m.sender, text: maskContactBits(mask(m.text ?? "")), created_at: m.created_at, aixType: m.is_aix_generated ? aixOfMsg(m)?.aix_type ?? "aix_unknown" : null }));
        row.situation_v2 = turnSituationTextV2({ scene: row.scene, hist, customerMasked: maskContactBits(mask(custText)), nowMs: Date.parse(turnAt) });
        row.focus = focusOfTakeuchiTurn({ route: actual.route, aixType: actual.aix, text: maskContactBits(mask(s.text ?? "")), openPromise: !!openPromiseAt(hist) });
      }
      built.push(row);
    }
    res.built += built.length;
    // 手元の確かめだけ: 伏せの効いた状況の文を数行（cron は渡さない＝返さない）
    if (o.samples) for (const r of built) if ((res.samples ??= []).length < o.samples) res.samples.push(r.situation);
    if (!write || !built.length) continue; // dry: 埋め込みを呼ばない（費用 0）
    const embs = await embedBatch(built.map((r) => r.situation));
    const embs2 = v2 ? await embedBatch(built.map((r) => r.situation_v2 ?? r.situation)) : [];
    const rows = built.map((r, i) => (embs[i] && (!v2 || embs2[i]) ? { ...r, embedding: embs[i] as number[], ...(v2 ? { embedding_v2: embs2[i] as number[] } : {}) } : null)).filter((x): x is V2Row & { embedding: number[]; embedding_v2?: number[] } => !!x);
    if (rows.length) { await flush(sb, rows); res.written += rows.length; }
  }
  return res;
}

/** 会話の束 × 時刻の範囲で読む（会話×時刻の索引・1000件ずつ） */
async function pageIn<T>(sb: SupabaseClient, table: string, cols: string, convs: string[], timeCol: string, from: string, to: string): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from(table).select(cols).in("conversation_id", convs).gte(timeCol, from).lte(timeCol, to).order(timeCol, { ascending: true }).range(i, i + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> { const m = new Map<string, T[]>(); for (const x of xs) { const key = k(x); const l = m.get(key) ?? []; l.push(x); m.set(key, l); } return m; }

/** 埋め込みを束ねて1回で（knowledge-utils.generateEmbedding と同じ型 text-embedding-3-small・同じ伏せ maskForEmbedding・2000字まで）。失敗した物は null */
async function embedBatch(texts: string[]): Promise<Array<number[] | null>> {
  const rawKey = process.env.OPENAI_API_KEY ?? "";
  const apiKey = rawKey.charCodeAt(0) === 0xfeff ? rawKey.slice(1) : rawKey;
  if (!apiKey || !texts.length) return texts.map(() => null);
  const { maskForEmbedding } = await import("@/app/lib/pii-mask");
  try {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts.map((t) => maskForEmbedding(t).slice(0, 2000)) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return texts.map(() => null);
    const j = (await r.json()) as { data: Array<{ index: number; embedding: number[] }> };
    const out: Array<number[] | null> = texts.map(() => null);
    for (const d of j.data ?? []) out[d.index] = d.embedding;
    return out;
  } catch { return texts.map(() => null); }
}


/** 一括の埋め（今日だけ・統括役 11/04）: 表で一番古い番より前を、1回 limit 番ずつ。90日に届いたら done */
export async function backfillCursor(sb: SupabaseClient): Promise<string | null> {
  const { data } = await sb.from("conductor_turn_vectors").select("turn_at").order("turn_at", { ascending: true }).limit(1);
  return ((data ?? []) as Array<{ turn_at: string }>)[0]?.turn_at ?? null;
}

/** v2 の作り直しの印（11/05 作業員5）: v2 の埋め込みがまだ無い一番新しい番の少し後（送信はお客様の番より後なので2日の余裕）。無ければ null＝全部済み */
export async function v2BackfillCursor(sb: SupabaseClient): Promise<string | null> {
  const { data } = await sb.from("conductor_turn_vectors").select("turn_at").is("embedding_v2", null).order("turn_at", { ascending: false }).limit(1);
  const t = ((data ?? []) as Array<{ turn_at: string }>)[0]?.turn_at;
  return t ? new Date(Date.parse(t) + 2 * 86_400_000).toISOString() : null;
}

async function flush(sb: SupabaseClient, rows: Array<V2Row & { embedding: number[]; embedding_v2?: number[] }>): Promise<void> {
  const { error } = await sb.from("conductor_turn_vectors").upsert(rows.map((r) => ({ ...r, embedding: JSON.stringify(r.embedding), ...(r.embedding_v2 ? { embedding_v2: JSON.stringify(r.embedding_v2) } : {}) })), { onConflict: "source_key" });
  if (error) throw new Error(`conductor_turn_vectors: ${error.message}`);
}
