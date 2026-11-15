// scripts/rag-precision.ts — RAG ごとの精度の物差し（読むだけ・LLM なし・埋め込みも作らない＝費用 0）
//
// 2026-11-15 作業員H（統括役の頼み 土台②）。決まりと数えは scripts/lib/rag-precision.ts（テスト付き）。
//   竹内さん本人の番（line_watch_turns・最初の一手の書き手が takeuchi）ごとに、その番の ai_reply_examples の行の埋め込み（文書と同じ形）を問いにして、
//   match_reply_examples（返信の手本）・match_aix_reply_examples（AIX の手本）・2つを近さで混ぜた物・match_takeuchi_compose（竹内さんの文）を今の形のまま引き直し、
//   道（返信か AIX か・系統）と骨（頭・押さえ・信頼・潜在・つなぎ・締め・事実）の合い方を RAG ごと・場面ごとに出す。
//   DB の重い読み（埋め込みの読み・RPC を番の数×4回）なので、JST 9〜22時は --limit=10 まで（それより多いのは夜に）。
//   使い方: npx tsx --env-file=<.env.local> scripts/rag-precision.ts [--days=30] [--limit=200] [--json=<出力>]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns, readStaffMsgs, aixFamily } from "./lib/prod-yardstick-db";
import { staffFirstMove, aixLogsFromWatch } from "../app/lib/staff-first-move";
import { STATE_SEARCH_ALIASES } from "../app/lib/line-reply-prompts";
import { familyOfExample, scoreHeldOut, tallyRag, formatTally, readingOf, rerankByReading, READING_KEYS, type HeldOut, type Neighbor, type RagScore, type Reading, type ReadingKey } from "./lib/rag-precision";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const days = Number(arg("days") ?? "30"), limit = Number(arg("limit") ?? "200");
const jstHour = (new Date().getUTCHours() + 9) % 24;
if (jstHour >= 9 && jstHour < 22 && limit > 10 && !process.argv.includes("--force")) {
  console.error(`営業時間（JST ${jstHour}時）は --limit=10 まで（DB の重い読みは 22時以降・竹内さんの決まり）`);
  process.exit(1);
}

type ExRow = { id: string; conversation_id: string | null; created_at: string; entry_source: string | null; aix_action: string | null; sent_reply: string | null; conversation_state: string | null };

async function heldOutTurns(sb: SupabaseClient): Promise<Array<HeldOut & { exampleId: string; state: string | null; decisionId: string | null }>> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const msgs = await readStaffMsgs(sb, [...new Set(turns.map((w) => w.conversation_id))], since);
  const out: Array<HeldOut & { exampleId: string; state: string | null; decisionId: string | null }> = [];
  for (const w of [...turns].reverse()) {
    if (out.length >= limit) break;
    const tAt = Date.parse(w.customer_turn_at);
    const fm = staffFirstMove(tAt, msgs.get(w.conversation_id) ?? [], aixLogsFromWatch(w.staff_aix));
    if (!fm || fm.writer !== "takeuchi") continue;
    // その番の手本の行（同じ会話・お客様の通の後 3時間以内の最初の行）＝問いの埋め込みの元
    const { data } = await sb.from("ai_reply_examples").select("id, conversation_state, created_at").eq("conversation_id", w.conversation_id)
      .gte("created_at", w.customer_turn_at).lte("created_at", new Date(tAt + 3 * 3_600_000).toISOString()).not("embedding", "is", null).order("created_at").limit(1);
    const ex = ((data ?? []) as Array<{ id: string; conversation_state: string | null }>)[0];
    if (!ex) continue;
    const { data: st } = await sb.from("line_watch_turns").select("staff_texts").eq("id", w.id).maybeSingle();
    const texts = (((st as { staff_texts?: Array<{ text?: string }> } | null)?.staff_texts) ?? []).map((s) => String(s.text ?? "")).filter(Boolean);
    out.push({ key: String(w.id), scene: w.scene_key ?? "?", conversationId: w.conversation_id, at: w.customer_turn_at, truthFamily: fm.kind === "aix" ? aixFamily(fm.aix) : "返信", takeuchiTexts: fm.kind === "reply" ? texts : [], exampleId: ex.id, state: ex.conversation_state, decisionId: w.decision_id ? String(w.decision_id) : null });
  }
  return out;
}

async function exMeta(sb: SupabaseClient, ids: string[]): Promise<Map<string, ExRow>> {
  if (!ids.length) return new Map();
  const { data } = await sb.from("ai_reply_examples").select("id, conversation_id, created_at, entry_source, aix_action, sent_reply, conversation_state").in("id", ids);
  return new Map(((data ?? []) as ExRow[]).map((r) => [r.id, r]));
}

// 連携①: 判断の読み（digest の要る欄だけ）。会話ごとに1回だけ読む
const SEL = "id, conversation_id, created_at, tc:digest->>tc, ta:digest->>ta, intent:digest->>intent, emoF:digest->>emoF, fc:digest->>fc";
type DRow = { id: string; conversation_id: string; created_at: string; tc: string | null; ta: string | null; intent: string | null; emoF: string | null; fc: string | null };
const convDecisions = new Map<string, DRow[]>();
async function decisionsOf(sb: SupabaseClient, convs: string[]): Promise<void> {
  const need = [...new Set(convs)].filter((c) => !convDecisions.has(c));
  for (let i = 0; i < need.length; i += 50) {
    const { data } = await sb.from("brain_decision_logs").select(SEL).in("conversation_id", need.slice(i, i + 50)).gte("created_at", new Date(Date.now() - (days + 120) * 86_400_000).toISOString()).order("created_at").limit(5000);
    for (const c of need.slice(i, i + 50)) convDecisions.set(c, []);
    for (const r of (data ?? []) as unknown as DRow[]) convDecisions.get(r.conversation_id)?.push(r);
  }
}
const asReading = (r: DRow | undefined | null): Reading | null => (r ? readingOf(r as unknown as Record<string, unknown>) : null);
/** 手本の番の読み＝その会話でその手本より前（6時間以内）の一番近い判断 */
function readingBefore(conv: string | null, at: string | null): Reading | null {
  if (!conv || !at) return null;
  const t = Date.parse(at);
  const rows = (convDecisions.get(conv) ?? []).filter((r) => Date.parse(r.created_at) <= t && t - Date.parse(r.created_at) <= 6 * 3_600_000);
  return asReading(rows[rows.length - 1]);
}
const VARIANTS: Array<{ name: string; keys: ReadingKey[] }> = [...READING_KEYS.map((k) => ({ name: k, keys: [k] as ReadingKey[] })), { name: "全部", keys: [...READING_KEYS] }];

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const hs = await heldOutTurns(sb);
  console.error(`竹内さん本人の番 ${hs.length}（${days}日・上限 ${limit}）`);
  const scores: RagScore[] = [];
  for (const h of hs) {
    const n0 = scores.length;
    const { data: e } = await sb.from("ai_reply_examples").select("embedding").eq("id", h.exampleId).maybeSingle();
    const emb = (e as { embedding?: string } | null)?.embedding;
    if (!emb) continue;
    const [re, ae, tc] = await Promise.all([
      sb.rpc("match_reply_examples", { query_embedding: emb, match_count: 24, filter_states: STATE_SEARCH_ALIASES[h.state ?? "proposing"] ?? [h.state ?? "proposing"] }),
      sb.rpc("match_aix_reply_examples", { query_embedding: emb, match_count: 24, filter_action: null }),
      sb.rpc("match_takeuchi_compose", { query_embedding: emb, p_scene: null, p_purpose: null, match_count: 10, p_exclude_key: null }),
    ]);
    const reRows = ((re.data ?? []) as Array<{ id: string; similarity: number }>), aeRows = ((ae.data ?? []) as Array<{ id: string; similarity: number }>);
    const meta = await exMeta(sb, [...reRows, ...aeRows].map((r) => r.id).filter((id) => id !== h.exampleId));
    const toN = (r: { id: string; similarity: number }): Neighbor | null => { const m = meta.get(r.id); return m ? { id: r.id, family: familyOfExample(m.entry_source, m.aix_action), reply: m.sent_reply, sim: r.similarity, conversationId: m.conversation_id, at: m.created_at } : null; };
    const reN = reRows.map(toN).filter((x): x is Neighbor => !!x), aeN = aeRows.map(toN).filter((x): x is Neighbor => !!x);
    scores.push(scoreHeldOut("返信の手本", h, reN, { routeAware: false }));
    scores.push(scoreHeldOut("AIX の手本", h, aeN));
    scores.push(scoreHeldOut("返信＋AIX（近さ順）", h, [...reN, ...aeN]));
    // 連携①: その番の判断の読みで並べ替えた時（DDL なし・物差しの中だけ）
    if (h.decisionId) {
      await decisionsOf(sb, [h.conversationId, ...[...reN, ...aeN].map((n) => n.conversationId ?? "").filter(Boolean)]);
      const held = asReading((convDecisions.get(h.conversationId) ?? []).find((r) => r.id === h.decisionId));
      if (held) {
        const withR = [...reN, ...aeN].map((n) => ({ ...n, reading: readingBefore(n.conversationId, n.at) }));
        scores.push(scoreHeldOut("連携①: 加点なし（同じ番）", h, withR));
        for (const v of VARIANTS) scores.push(scoreHeldOut(`連携①: +${v.name}`, h, rerankByReading(withR, held, v.keys)));
      }
    }
    // 竹内さんの文（message_id → 会話と時刻で外す）
    const tcRows = ((tc.data ?? []) as Array<{ message_id: string; body: string | null; similarity: number }>);
    let tcN: Neighbor[] = [];
    if (tcRows.length) {
      const { data: mm } = await sb.from("messages").select("id, conversation_id, created_at").in("id", tcRows.map((r) => r.message_id));
      const mOf = new Map(((mm ?? []) as Array<{ id: string; conversation_id: string; created_at: string }>).map((m) => [m.id, m]));
      tcN = tcRows.map((r) => ({ id: r.message_id, family: "返信", reply: r.body, sim: r.similarity, conversationId: mOf.get(r.message_id)?.conversation_id ?? null, at: mOf.get(r.message_id)?.created_at ?? null }));
    }
    scores.push(scoreHeldOut("竹内さんの文", h, tcN, { routeAware: false }));
    // 連携②の下敷き: 同じ数えを、その番の判断の重点（digest.fc の頭・conductor-focus の FOCUS_KINDS）ごとにも（統括が RAG を選ぶ表の鍵）
    const focus = h.decisionId ? asReading((convDecisions.get(h.conversationId) ?? []).find((r) => r.id === h.decisionId))?.focus ?? null : null;
    for (const sc of scores.slice(n0)) scores.push({ ...sc, scene: `重点:${focus ?? "?"}` });
  }
  const t = tallyRag(scores);
  for (const l of formatTally(t)) console.log(l);
  const j = arg("json");
  if (j) writeFileSync(j, JSON.stringify({ at: new Date().toISOString(), days, n: hs.length, tally: t }, null, 1));
})();
