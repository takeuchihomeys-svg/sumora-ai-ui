// scripts/lib/exam-db-fp.ts — 試験の使い回しの鍵に足す「DB の中身の指紋」（既定・EXAM_DB_FP=fine で旧の時刻の指紋）
//
// 2026-10-18 確かめる人（10/17・10/18）: 旧の指紋（exam-brain-io.ts readDbFingerprint・19表の 件数・最後の時刻）は本番の書き込み
//   （ai_reply_examples 約70件/日・ai_reply_knowledge 約115件/日・ai_prompts／trigger_action_rules の updated_at が毎日・brain_aix_feedback を
//   毎日の cron が updated_at=now で書き直す）で数分ごとに変わり、作業者の間の使い回しが数分しか当たらなかった。
// 直し: 時刻ではなく「試験の問題が実際に読む行の中身」の指紋にする。ブレイン（brain）と下書き（draft＝generate-reply）が DB を直に読む所
//   （.from(表)・コードから確かめた・下の各読みの why）を同じ条件・同じ並び・同じ上限で読み、渡す欄の中身だけを hash する
//   （updated_at・created_at・使った回数・最後に使った時刻は入れない。並びに効く時刻は「並び」として入る）。
//   旧の19表に無かった直読み（brain_action_reach_stats＝申込到達率・winning_pattern_logs＝当たった予測）も足した（質の側）。
// 入れない物と根拠:
//   - 似た物探し（RPC match_*＝知見・手本・勝ちパターン・テンプレ・地図の RAG）: 試験は --replay で RPC も録音から返す（llm-cassette.ts rpcCassette）
//     ＝同じ要求なら DB が変わっても材料は変わらない（同じ鍵の結果を出した回が録っている）
//   - 知見の RAG が時間切れの時だけ通る並べ替えの道（generate-reply の stateDiff・topic 等）: 話題（brain の key_topics）で絞る＝指紋にできない・
//     録音の後は時間切れが起きない（設計知見 35186f9e）
//   - 会話ごとの表（messages 等）・書くだけの記録
// 読めない読みが1つでもあれば、その段は使い回さない（安全側・dbKeyOf が null）。
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DbPart } from "./exam-brain";
import { isEvaluativePrinciple, principleEvalFilterEnabled } from "../../app/lib/principle-eval";
import { isCustomerFacingExample, isUsableExampleText } from "../../app/lib/example-hygiene";
import { STATE_SEARCH_ALIASES } from "../../app/lib/line-reply-prompts";
import { isMeaninglessRuleKeyword } from "../../app/lib/brain-keyword-rules";
import { KNOWLEDGE_RULE } from "../../app/lib/property-search-knowledge";
import { TEST_CONVERSATION_IDS, TEST_ONLY_CONVERSATION_IDS } from "../../app/lib/test-conversations";
import { customerAsksRentLevel } from "../../app/lib/rent-question";

export type Row = Record<string, unknown>;
export type FpFilter =
  | ["eq" | "neq" | "gte" | "gt" | "lte" | "lt" | "like" | "ilike" | "not_ilike" | "neq_or_null", string, string | number | boolean]
  | ["in" | "not_in" | "ilike_any", string, Array<string | number>]
  | ["is_null" | "not_null", string];
/** 1つの問い合わせ（PostgREST にも手元の行にも同じ意味で当てる）。cols＝読んで hash する欄・order の欄は読まなくてよい */
export type FpQuery = {
  cols: string[]; filters?: FpFilter[]; order?: Array<[string, "asc" | "desc", boolean?]>; limit?: number;
  /** 親の表の欄で絞る（ai_reply_examples → conversations.status） */
  join?: { table: string; fk: string; col: string; in: string[] };
};
export type DbContentRead = {
  table: string; stage: "brain" | "draft"; name: string; why: string;
  queries: Record<string, FpQuery>;
  /** 渡す材料に畳む（無ければ読んだ行そのもの）。投げたら読めない＝その段は使い回さない */
  reduce?: (rows: Record<string, Row[]>) => unknown;
  /** 前の答えで次の問い合わせが決まる読み（queries の代わり） */
  fetch?: (run: FpRunner) => Promise<Record<string, Row[]>>;
};
export const DB_FP_MAX_ROWS = 20000;
export type DbFpMode = "content" | "fine";
/** 既定は中身の指紋。EXAM_DB_FP=fine＝旧（件数・最後の時刻・小さい表の hash） */
export function dbFpMode(env: Record<string, string | undefined> = process.env): DbFpMode {
  return String(env.EXAM_DB_FP ?? "").trim().toLowerCase() === "fine" ? "fine" : "content";
}
export const dbPartName = (table: string, stage: "brain" | "draft") => `${table}#${stage === "brain" ? "b" : "d"}`;
/** 相場の材料（rent_observations）は、お客様が家賃の相場を聞いた番（brain-core の customerAsksRentLevel）だけ読む＝問題ごとに鍵に入れるか決める */
export const RENT_PART = "rent_observations#b";
/** 段が見る部分の名前（下書きはブレインを丸ごと受け取る＝ブレインの読みも入れる）。o.rent=false＝相場の材料を読まない問題 */
export function contentPartsOf(stage: "brain" | "draft", reads: DbContentRead[], o: { rent?: boolean } = {}): string[] {
  return [...new Set(reads.filter((r) => r.stage === "brain" || stage === "draft").map((r) => dbPartName(r.table, r.stage)))].filter((p) => o.rent !== false || p !== RENT_PART);
}
/**
 * 問題の番が相場を聞いているか（brain-core: unrepliedCustomerTurn＝最後のこちらの送信の後のお客様の発言 → customerAsksRentLevel）。
 *   問題の customer と、context の最後に続くお客様の発言を合わせて見る。customer が無い（読めない）時は true（安全側＝鍵に入れる）
 */
export function problemReadsRent(p: { customer?: unknown; context?: unknown }): boolean {
  if (typeof p.customer !== "string") return true;
  const ctx = Array.isArray(p.context) ? (p.context as Array<{ s?: unknown; t?: unknown }>) : [];
  const tail: string[] = [];
  for (let i = ctx.length - 1; i >= 0; i--) { if (ctx[i]?.s === "customer") tail.unshift(String(ctx[i].t ?? "")); else break; }
  const texts = [...tail, p.customer];
  return customerAsksRentLevel(texts.join("\n")) || texts.some((t) => customerAsksRentLevel(t));
}

// ─── 手元の行に当てる（単体テスト・過去の見積もり） ─────────────────────────
const likeRe = (p: string, ci: boolean) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, ci ? "is" : "s");
const cmp = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};
function passes(r: Row, f: FpFilter): boolean {
  const v = r[f[1]];
  switch (f[0]) {
    case "eq": return v === f[2];
    case "neq": return v !== null && v !== undefined && v !== f[2];
    case "neq_or_null": return v === null || v === undefined || v !== f[2];
    case "gte": return v !== null && v !== undefined && cmp(v, f[2]) >= 0;
    case "gt": return v !== null && v !== undefined && cmp(v, f[2]) > 0;
    case "lte": return v !== null && v !== undefined && cmp(v, f[2]) <= 0;
    case "lt": return v !== null && v !== undefined && cmp(v, f[2]) < 0;
    case "like": return typeof v === "string" && likeRe(String(f[2]), false).test(v);
    case "ilike": return typeof v === "string" && likeRe(String(f[2]), true).test(v);
    case "not_ilike": return typeof v === "string" && !likeRe(String(f[2]), true).test(v);
    case "in": return f[2].includes(v as never);
    case "not_in": return v !== null && v !== undefined && !f[2].includes(v as never);
    case "ilike_any": return typeof v === "string" && f[2].some((p) => likeRe(String(p), true).test(v));
    case "is_null": return v === null || v === undefined;
    case "not_null": return v !== null && v !== undefined;
  }
}
/** PostgREST と同じ意味で手元の行に当てる（NULL は既定で一番大きい＝asc の最後・desc の最初。nullsFirst を明示した時はそれ） */
export function runFpQueryInMemory(rows: Row[], q: FpQuery, parent?: Map<unknown, Row>): Row[] {
  let out = rows.filter((r) => (q.filters ?? []).every((f) => passes(r, f)));
  if (q.join) { const j = q.join; out = out.filter((r) => { const p = parent?.get(r[j.fk]); return !!p && j.in.includes(p[j.col] as string); }); }
  const ord = q.order ?? [];
  out = [...out].sort((a, b) => {
    for (const [c, dir, nf] of ord) {
      const x = a[c], y = b[c], xn = x === null || x === undefined, yn = y === null || y === undefined;
      if (xn || yn) { if (xn && yn) continue; const nullsFirst = nf ?? dir === "desc"; return (xn ? -1 : 1) * (nullsFirst ? 1 : -1); }
      const d = cmp(x, y); if (d) return dir === "desc" ? -d : d;
    }
    return 0;
  });
  if (q.limit !== undefined) out = out.slice(0, q.limit);
  return out.map((r) => Object.fromEntries(q.cols.map((c) => [c, r[c] ?? null])));
}

// ─── PostgREST に当てる（読むだけ・1000行ずつ） ───────────────────────────
function applyFilter(q: any, f: FpFilter): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (f[0]) {
    case "eq": return q.eq(f[1], f[2]);
    case "neq": return q.neq(f[1], f[2]);
    case "neq_or_null": return q.or(`${f[1]}.is.null,${f[1]}.neq.${f[2]}`);
    case "gte": return q.gte(f[1], f[2]);
    case "gt": return q.gt(f[1], f[2]);
    case "lte": return q.lte(f[1], f[2]);
    case "lt": return q.lt(f[1], f[2]);
    case "like": return q.like(f[1], f[2]);
    case "ilike": return q.ilike(f[1], f[2]);
    case "not_ilike": return q.not(f[1], "ilike", f[2]);
    case "in": return q.in(f[1], f[2]);
    case "not_in": return q.not(f[1], "in", `(${f[2].join(",")})`);
    case "ilike_any": return q.or(f[2].map((p) => `${f[1]}.ilike.${p}`).join(","));
    case "is_null": return q.is(f[1], null);
    case "not_null": return q.not(f[1], "is", null);
  }
}
export type FpRunner = (table: string, q: FpQuery) => Promise<Row[]>;
export function supabaseRunner(sb: SupabaseClient): FpRunner {
  return async (table, q) => {
    const want = q.limit ?? DB_FP_MAX_ROWS + 1;
    const out: Row[] = [];
    for (let from = 0; from < want; from += 1000) {
      const sel = q.join ? `${q.cols.join(",")},${q.join.table}!inner(${q.join.col})` : q.cols.join(",");
      let b: any = sb.from(table).select(sel); // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const f of q.filters ?? []) b = applyFilter(b, f);
      if (q.join) b = b.in(`${q.join.table}.${q.join.col}`, q.join.in);
      for (const [c, dir, nf] of q.order ?? []) b = b.order(c, nf === undefined ? { ascending: dir === "asc" } : { ascending: dir === "asc", nullsFirst: nf });
      const r = await b.range(from, Math.min(want, from + 1000) - 1);
      if (r.error) throw new Error(`${table}: ${r.error.message}`);
      const rows = (r.data ?? []) as Row[];
      out.push(...rows.map((x) => Object.fromEntries(q.cols.map((c) => [c, x[c] ?? null]))));
      if (rows.length < Math.min(1000, want - from)) break;
    }
    if (q.limit === undefined && out.length > DB_FP_MAX_ROWS) throw new Error(`${table}: 行が上限 ${DB_FP_MAX_ROWS} を超えた`);
    return out;
  };
}

// ─── 読みの一覧（コードから確かめた・2026-10-18） ──────────────────────────
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const ALIAS_SETS = (() => { const m = new Map<string, string[]>(); for (const v of Object.values(STATE_SEARCH_ALIASES)) m.set(v.join("|"), v); return [...m.values()]; })();
const RULE_COLS = ["id", "rule_key", "action_type", "rule_text", "condition_key", "condition_value", "priority", "is_permanent"];
const EX_COLS = ["customer_message", "sent_reply", "conversation_state", "is_starred", "reply_angle"];
export const DRAFT_PROMPT_KEYS = ["generation_system", "smora_quick_patterns", "real_estate_rules", "smora_rules", "reply_content_rules", "aix_property_recommendation_rules", "aix_property_send_rules", "template_adapt_rules"];
export const SUCCESS_EXAMPLE_STATUSES = ["closed_won", "applying", "application", "screening", "contract"]; // brain-core.ts と同じ
/** 語のルール（brain-core 信号5.5・8）: 段（newPhase）ごとに 上位200 → 意味の無い語を外す。並びが効くのは竹内さんの回答の規則（最初に当たった物）だけ */
export function reduceKeywordRules(rows: Row[]): unknown {
  const phases = [...new Set(rows.map((r) => r.conversation_status).filter((s): s is string => typeof s === "string"))].sort();
  const out: Record<string, unknown> = {};
  for (const ph of ["*", ...phases]) {
    const list = rows.filter((r) => r.conversation_status === null || r.conversation_status === undefined || r.conversation_status === ph).slice(0, 200)
      .map((r) => ({ a: r.action_type === "alternative_send" ? "property_send" : String(r.action_type), k: String(r.keyword ?? ""), c: Number(r.confidence ?? 0), human: Number(r.confidence ?? 0) >= 0.95 && Number(r.confidence ?? 0) <= 1 && Number(r.occurrence_count ?? 0) >= 10 }))
      .filter((r) => r.k.length >= 2 && !isMeaninglessRuleKeyword(r.k));
    out[ph] = { set: list.map((r) => `${r.a}\t${r.k}\t${r.c}`).sort(), human: list.filter((r) => r.human).map((r) => `${r.a}\t${r.k}`) };
  }
  return out;
}
/** 下書きの手本のフォールバック（generate-reply fetchExamples・RAG が 0.5 未満の時＝試験の下書きの 約1割）: 同じ段 上位6・全体 上位4 */
export function reduceFallbackExamples(r: Record<string, Row[]>): unknown {
  const ok = (x: Row) => isUsableExampleText(x.sent_reply as string) && isCustomerFacingExample(x.sent_reply as string);
  const all = (r.all ?? []).filter(ok);
  return ALIAS_SETS.map((s) => {
    const same = (r[`s:${s.join("|")}`] ?? []).filter(ok);
    return [s.join("|"), same.slice(0, 6), all.filter((x) => !same.some((y) => y.sent_reply === x.sent_reply)).slice(0, 4)];
  });
}
/** 決まり（ai_prompt_rules）・下書き: 渡り得る行（priority 4 以上・線引き・恒久＝全体もアクション別も。prompt-rules の恒久の枠は priority で絞らない＝generate_reply の恒久 priority 3 以下も届く・確かめる人 10/18）を、並び（priority・updated_at・rule_key）の順の一覧で（上限の手前は上位集合）。時刻は並びとしてだけ入る */
export function reducePromptRules(rows: Row[]): unknown {
  return rows.filter((r) => Number(r.priority ?? 0) >= 4 || String(r.rule_key ?? "").startsWith("BOUNDARY-") || r.is_permanent === true)
    .map((r) => [r.rule_key, r.action_type, r.rule_text, r.condition_key, r.condition_value, r.priority, r.is_permanent]);
}
/**
 * 決まり・ブレイン（brain-core の3つの読みと同じ）: 全体の恒久 上位20（priority・id）／線引き 上位40（priority・id）／
 *   アクション別（generate_reply・線引きを除く・priority>=4）上位40（priority・updated_at）。アクションの候補は段で変わる＝アクションごとの上位40の和
 *   （どの候補の組の上位40も、各アクションの上位40の中にある）。rows は priority desc・updated_at desc で並んだ有効な行
 */
export function reduceBrainPromptRules(rows: Row[]): unknown {
  const byPid = (a: Row, b: Row) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || cmp(a.id, b.id);
  const isNull = (v: unknown) => v === null || v === undefined;
  const perm = rows.filter((r) => r.is_permanent === true && isNull(r.action_type)).sort(byPid).slice(0, 20).map((r) => [r.rule_key, r.rule_text, r.priority]);
  const boundary = rows.filter((r) => String(r.rule_key ?? "").startsWith("BOUNDARY-")).sort(byPid).slice(0, 40).map((r) => [r.rule_key, r.action_type, r.rule_text]);
  const per = new Map<string, number>();
  const action = rows.filter((r) => !isNull(r.action_type) && r.action_type !== "generate_reply" && !String(r.rule_key ?? "").startsWith("BOUNDARY-") && Number(r.priority ?? 0) >= 4)
    .filter((r) => { const k = String(r.action_type); const n = per.get(k) ?? 0; per.set(k, n + 1); return n < 40; })
    .map((r) => [r.rule_key, r.action_type, r.rule_text, r.priority, r.condition_key, r.condition_value]);
  return { perm, boundary, action };
}
export function dbContentReads(now = Date.now()): DbContentRead[] {
  const one = (cols: string[], rest: Omit<FpQuery, "cols"> = {}): Record<string, FpQuery> => ({ q: { cols, ...rest } });
  const rows = (r: Record<string, Row[]>) => r.q ?? [];
  return [
    // ── 知見 ai_reply_knowledge（RAG は録音から返る＝入れない・毎日の学習の多く＝phrase・style・pattern の imp 6〜8 は直に読まない）
    { table: "ai_reply_knowledge", stage: "brain", name: "principle_top", why: "brain-core loadBrainSystemInputs【重要原則】imp>=9 を評価文を外して上位10",
      queries: one(["title", "content", "importance"], { filters: [["eq", "category", "principle"], ["gte", "importance", 9], ["neq_or_null", "hypothesis_status", "rejected"]], order: [["importance", "desc"], ["created_at", "desc"], ["id", "asc"]], limit: 60 }),
      reduce: (r) => rows(r).filter((k) => !principleEvalFilterEnabled() || !isEvaluativePrinciple(k as never)).slice(0, 10) },
    { table: "ai_reply_knowledge", stage: "brain", name: "applying_best", why: "brain-core 当てはめの型 imp>=8 の1件（並びの決め手が無い＝一番上の importance の同点を全部）",
      queries: one(["id", "title", "content", "importance"], { filters: [["eq", "category", "applying_pattern"], ["gte", "importance", 8]], order: [["importance", "desc"], ["created_at", "desc"], ["id", "asc"]], limit: 20 }),
      reduce: (r) => { const rs = rows(r); return rs.filter((x) => x.importance === rs[0]?.importance); } },
    { table: "ai_reply_knowledge", stage: "brain", name: "win_summary", why: "summary-winning-patterns 成約パターンの新しい5件",
      queries: one(["content"], { filters: [["in", "category", ["pattern", "applying_pattern"]], ["ilike_any", "title", ["成約パターン_%", "[成約分析]%", "[転換点]%"]]], order: [["created_at", "desc"], ["id", "asc"]], limit: 5 }) },
    { table: "ai_reply_knowledge", stage: "draft", name: "loss", why: "generate-reply・prompt-cache 失注パターン（上限は spec 既定4・多めに20）",
      queries: one(["id", "title", "content", "importance", "category"], { filters: [["ilike", "title", "失注パターン%"], ["neq", "hypothesis_status", "rejected"]], order: [["importance", "desc"], ["created_at", "desc"], ["id", "asc"]], limit: 20 }) },
    { table: "ai_reply_knowledge", stage: "draft", name: "principle10", why: "generate-reply imp=10 の原則 全部・prompt-cache imp>=8 上位12（imp10 が12件以上なら imp10 の中＝この集合）",
      queries: one(["id", "title", "content", "importance", "hypothesis_status"], { filters: [["eq", "category", "principle"], ["eq", "importance", 10], ["neq_or_null", "hypothesis_status", "rejected"]], order: [["created_at", "desc"], ["id", "asc"]] }),
      reduce: (r) => { const rs = rows(r); if (rs.filter((x) => x.hypothesis_status !== null && x.hypothesis_status !== "rejected").length < 12) throw new Error("imp10 の原則が12件未満＝prompt-cache の上位12に imp9 が混ざる（並びの決め手が無い）"); return rs; } },
    ...(["applying_pattern", "viewing_pattern"] as const).map((cat): DbContentRead => ({ table: "ai_reply_knowledge", stage: "draft", name: cat, why: `generate-reply ${cat} 上位3`,
      queries: one(["id", "title", "content", "importance", "category", "conversation_state"], { filters: [["eq", "category", cat], ["neq", "hypothesis_status", "rejected"]], order: [["importance", "desc"], ["created_at", "desc"], ["id", "asc"]], limit: 3 }) })),
    // ── 手本 ai_reply_examples（RAG は録音から返る）
    { table: "ai_reply_examples", stage: "brain", name: "test_starred", why: "brain-core この会話の☆（試験の会話だけ）",
      queries: one(["conversation_id", "sent_reply"], { filters: [["in", "conversation_id", [...TEST_ONLY_CONVERSATION_IDS]], ["eq", "is_starred", true]], order: [["conversation_id", "asc"], ["created_at", "desc"], ["id", "asc"]], limit: 500 }) },
    { table: "ai_reply_examples", stage: "brain", name: "success", why: "brain-core 成約・申込の会話の☆ line_reply 新しい8件（会話の状態で絞る）",
      queries: one(["sent_reply", "conversation_state"], { filters: [["eq", "is_starred", true], ["eq", "entry_source", "line_reply"], ["not_null", "sent_reply"]], join: { table: "conversations", fk: "conversation_id", col: "status", in: SUCCESS_EXAMPLE_STATUSES }, order: [["created_at", "desc"], ["id", "asc"]], limit: 8 }) },
    { table: "ai_reply_examples", stage: "draft", name: "fallback", why: "generate-reply fetchExamples の RAG が当たらない時（☆順・新着順）",
      queries: {
        all: { cols: EX_COLS, filters: [["eq", "entry_source", "line_reply"]], order: [["is_starred", "desc"], ["created_at", "desc"], ["id", "asc"]], limit: 120 },
        ...Object.fromEntries(ALIAS_SETS.map((s) => [`s:${s.join("|")}`, { cols: EX_COLS, filters: [["in", "conversation_state", s], ["eq", "entry_source", "line_reply"]], order: [["is_starred", "desc"], ["created_at", "desc"], ["id", "asc"]], limit: 60 } as FpQuery])),
      }, reduce: reduceFallbackExamples },
    // ── 語のルール trigger_action_rules（使った回数は 竹内さんの回答の印・上位200 の切れ目・並びとしてだけ入る）
    { table: "trigger_action_rules", stage: "brain", name: "keyword_rules", why: "brain-core 信号5.5・8（conf>=0.65・段ごとに上位200）",
      queries: one(["action_type", "keyword", "confidence", "occurrence_count", "conversation_status"], { filters: [["eq", "category", "keyword_rule"], ["gte", "confidence", 0.65], ["gte", "occurrence_count", 1]], order: [["confidence", "desc"], ["occurrence_count", "desc"], ["keyword", "asc"], ["id", "asc"]] }),
      reduce: (r) => reduceKeywordRules(rows(r)) },
    { table: "trigger_action_rules", stage: "brain", name: "template_hint", why: "brain-core テンプレの示唆を止めるか（10件以上で一致率30%未満）だけ",
      queries: one(["keyword", "confidence", "total_occurrence"], { filters: [["eq", "action_type", "template_hint"], ["like", "keyword", "TEMPLATE_HINT_ACCEPT_RATE:%"]], order: [["keyword", "asc"]] }),
      reduce: (r) => rows(r).map((x) => [x.keyword, Number(x.total_occurrence ?? 0) >= 10 && Number(x.confidence ?? 1) < 0.3]) },
    // ── 決まり ai_prompt_rules（ブレインの恒久・線引き・アクション別／下書きの prompt-rules）
    { table: "ai_prompt_rules", stage: "brain", name: "rules", why: "brain-core 3つの読み（全体の恒久 上位20・線引き 上位40・アクション別 上位40 の和）",
      queries: one(RULE_COLS, { filters: [["eq", "is_active", true]], order: [["priority", "desc"], ["updated_at", "desc", false], ["rule_key", "asc"], ["id", "asc"]] }),
      reduce: (r) => reduceBrainPromptRules(rows(r)) },
    { table: "ai_prompt_rules", stage: "draft", name: "rules", why: "prompt-rules.ts（generate_reply・全体・AIX の経路。priority>=4・線引き・全体の恒久。並びは priority・updated_at＝上限の手前の上位集合）",
      queries: one(RULE_COLS, { filters: [["eq", "is_active", true]], order: [["priority", "desc"], ["updated_at", "desc", false], ["rule_key", "asc"], ["id", "asc"]] }),
      reduce: (r) => reducePromptRules(rows(r)) },
    { table: "brain_action_reach_stats", stage: "brain", name: "reach", why: "application-reach-server 場面×段階×判断の申込到達率（毎日の cron が消して入れ直す＝computed_at は見ない）",
      queries: one(["scene_key", "stage_bucket", "action", "n", "reached", "rate", "won"], { order: [["scene_key", "asc"], ["stage_bucket", "asc"], ["action", "asc"]] }) },
    { table: "winning_pattern_logs", stage: "brain", name: "correct", why: "summary-winning-patterns 段階2（当たった予測の新しい50件・人間性が無い行はお客様の要約の人間性）",
      queries: {}, fetch: async (run) => {
        const logs = await run("winning_pattern_logs", { cols: ["customer_id", "predicted_pattern", "personality_profile"], filters: [["eq", "was_correct", true]], order: [["created_at", "desc"], ["id", "asc"]], limit: 50 });
        const ids = [...new Set(logs.filter((l) => !l.personality_profile && l.customer_id).map((l) => String(l.customer_id)))].sort();
        const pcs = ids.length ? await run("property_customers", { cols: ["id", "ai_summary_json"], filters: [["in", "id", ids]], order: [["id", "asc"]] }) : [];
        return { logs, pcs: pcs.map((p) => ({ id: p.id, prof: (p.ai_summary_json as { personality_profile?: unknown } | null)?.personality_profile ?? null })) };
      } },
    // ── 統計・地図・その他
    { table: "brain_aix_feedback", stage: "brain", name: "feedback", why: "brain-core 場面の根拠・降格の一致率（中身だけ・毎日の書き直しの updated_at は見ない）",
      queries: one(["key", "kind", "action", "check_pattern", "scene", "decision_source", "n", "pressed", "matched", "alt_top", "window_days"], { order: [["key", "asc"]] }) },
    // 物件条件ブレイン（property-brain-rag＝brain-core が答えを出した後に void で起動する runConditionBrain・search-params の API）だけが読む表＝この番の答えに効かない
    { table: "brain_meta_insights", stage: "brain", name: "after_answer", why: "property-brain-rag だけ（条件ブレインは答えの後に void で走る）", queries: {}, reduce: () => "after-answer" },
    { table: "aix_action_attribution", stage: "brain", name: "win_rates", why: "brain-core 勝率（BRAIN_ACTION_WIN_RATES=on の時だけ使う・中身）",
      queries: one(["action_type", "win_rate", "usage_count"], { filters: [["not_null", "win_rate"]], order: [["id", "asc"]] }) },
    { table: "aix_transition_stats", stage: "brain", name: "transitions", why: "brain-core AIX の遷移の数",
      queries: one(["from_aix_type", "to_aix_type", "count"], { order: [["from_aix_type", "asc"], ["to_aix_type", "asc"]] }) },
    { table: "templates", stage: "brain", name: "templates", why: "テンプレの中身（RAG は録音から・名前→id の直読み）",
      queries: one(["id", "category", "label", "text", "sort_order"], { order: [["id", "asc"]] }) },
    { table: "winning_patterns", stage: "brain", name: "rpc_only", why: "ブレイン・下書きは match_winning_patterns（RPC・録音から返る）だけ＝直に読む所が無い",
      queries: {}, reduce: () => "rpc-only" },
    { table: "property_search_knowledge", stage: "brain", name: "after_answer", why: "property-search-knowledge-server は property-brain-rag からだけ（答えの後）", queries: {}, reduce: () => "after-answer" },
    { table: "rent_observations", stage: "brain", name: "rent", why: "brain-core の相場（customerAsksRentLevel の番だけ＝問題ごとに鍵に入れるか決める・exam-brain の problemReadsRent）が読む欄（seen_count・last_seen_at・使った段 等は入れない）",
      queries: one(["ward", "plan_group", "rent_total", "pet", "building_age", "walk_minutes", "floor", "structure", "area_sqm", "equipment"], { filters: [["eq", "branch_id", "osaka"], ["not_null", "rent_total"]], order: [["id", "asc"]] }) },
    { table: "region_map", stage: "brain", name: "after_answer", why: "property-brain-rag だけ（答えの後）", queries: {}, reduce: () => "after-answer" },
    { table: "station_map", stage: "brain", name: "after_answer", why: "property-brain-rag だけ（答えの後）", queries: {}, reduce: () => "after-answer" },
    { table: "line_stations", stage: "brain", name: "after_answer", why: "property-brain-rag だけ（答えの後）", queries: {}, reduce: () => "after-answer" },
    // ── 下書き（generate-reply）だけ
    { table: "adaptation_improvement_rules", stage: "draft", name: "adapt", why: "generate-reply 修正学習ルール（中身）",
      queries: one(["id", "category", "rule_text", "confidence", "example_count", "is_active"], { order: [["id", "asc"]] }) },
    { table: "ai_prompts", stage: "draft", name: "prompts", why: "generate-reply が使う8つの鍵だけ（他の鍵は毎日の cron の集計の置き場＝読まない）",
      queries: one(["key", "content"], { filters: [["in", "key", DRAFT_PROMPT_KEYS]], order: [["key", "asc"]] }) },
    { table: "phrase_dictionary", stage: "draft", name: "phrases", why: "generate-reply・prompt-cache priority>=10（同点の並びの決め手が無い＝全部）",
      queries: one(["id", "phrase", "priority", "category", "is_active"], { filters: [["gte", "priority", 10]], order: [["id", "asc"]] }) },
    { table: "template_selection_logs", stage: "draft", name: "staff_examples", why: "template-optimize-examples-server 直近60日のスタッフの送信",
      queries: one(["id", "template_id", "conversation_id", "picker_mode", "final_sent_text"], { filters: [["not_null", "final_sent_text"], ["not_in", "conversation_id", [...TEST_CONVERSATION_IDS]], ["gte", "created_at", new Date(now - 60 * 86400e3).toISOString()]], order: [["id", "asc"]] }) },
  ];
}
/** 1つの読みの指紋（純関数: 読んだ行 → 材料 → hash） */
export function contentSigOf(read: DbContentRead, rows: Record<string, Row[]>): string {
  return sha(read.reduce ? read.reduce(rows) : rows);
}
/** 中身の指紋を1回読む（読むだけ・並べて）。部分＝表×段（表#b／表#d）。読めない読みがあればその部分は ok=false */
export async function readDbContentFingerprint(sb: SupabaseClient | null, reads = dbContentReads(), runner?: FpRunner): Promise<DbPart[]> {
  const run = runner ?? supabaseRunner(sb as SupabaseClient);
  const done = await Promise.all(reads.map(async (rd) => {
    try {
      const rows: Record<string, Row[]> = rd.fetch ? await rd.fetch(run) : {};
      for (const [k, q] of Object.entries(rd.queries)) rows[k] = await run(rd.table, q);
      return { rd, sig: contentSigOf(rd, rows), why: undefined as string | undefined };
    } catch (e) { return { rd, sig: "", why: `${rd.name}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` }; }
  }));
  const by = new Map<string, typeof done>();
  for (const d of done) { const k = dbPartName(d.rd.table, d.rd.stage); by.set(k, [...(by.get(k) ?? []), d]); }
  return [...by.entries()].map(([table, ds]) => {
    const bad = ds.filter((d) => d.why);
    if (bad.length) return { table, ok: false, sig: "", why: bad.map((d) => d.why).join("／") };
    return { table, ok: true, sig: `v=c1;${ds.map((d) => `${d.rd.name}=${d.sig}`).sort().join(";")}` };
  });
}
