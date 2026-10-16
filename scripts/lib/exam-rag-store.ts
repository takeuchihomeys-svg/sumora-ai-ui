// scripts/lib/exam-rag-store.ts — 試験の問題の札（exam-rag.ts）の置き場・埋め込み・設計知見（KB）の読み
//
// 2026-10-16 竹内「試験の問題を DB にためて RAG で選ぶ」: 表（exam_problem_index・exam_problem_kb_links）は竹内さんの OK まで作らない。
//   表が無い間は全部の作業ツリーで共有する置き場（<倉庫の根>/.claude/exam-cache/brain-exam-rag/・.gitignore）に同じ形で持つ。
//   表ができたら（select が通れば）表を読む・書く（止める: EXAM_RAG_STORE=local）。表の設計は scripts/exam-rag-migration.sql。
//   KB（system_design_thinking）は読むだけ（行・RPC match_design_thinking_exact）。書き込みは今まで通り kb-insert。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { examCacheRoot } from "./llm-cassette";
import { atomicWriteJson, updateJsonFile } from "./exam-shared-file";
import { cosine, prefixKeyOfBody, type ExamCard, type KbLink, type KbSnapshot, type Vec } from "./exam-rag";

export const RAG_DIR = join(examCacheRoot(), "brain-exam-rag");
export const CARDS_FILE = join(RAG_DIR, "cards.json");
export const LINKS_FILE = join(RAG_DIR, "kb-links.json");
export const KB_SNAPSHOT_FILE = join(RAG_DIR, "kb-snapshot.json");
export const PREFIX_FILE = join(RAG_DIR, "prefix.json");
export const PENDING_LINKS_FILE = join(RAG_DIR, "kb-links-pending.json");
export const CARD_TABLE = "exam_problem_index";
export const LINK_TABLE = "exam_problem_kb_links";

const readJson = <T,>(f: string, d: T): T => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return d; } };

/** 表を使うか（表があって EXAM_RAG_STORE が local でない）。1回だけ調べる */
let tableOk: boolean | null = null;
export async function useDbStore(sb: SupabaseClient | null, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!sb || String(env.EXAM_RAG_STORE ?? "").trim().toLowerCase() === "local") return false;
  if (tableOk != null) return tableOk;
  // 2026-10-16 確かめる人: 表は RLS で方針なし＝anon の select はエラー無しで 0 行を返す（表があるのに札が空に見え、書き込みは失敗する）。
  //   service role の鍵が無い時（手元の .env.local は anon だけ）は表に切り替えない＝手元の置き場
  if (!String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()) { tableOk = false; return false; }
  const { error } = await sb.from(CARD_TABLE).select("id").limit(1);
  tableOk = !error;
  return tableOk;
}

// ─── 札 ─────────────────────────────────────────────────────────────────
type CardRow = { id: string; spec_hash: string; type: string; sub: string; tags: string[]; stage: string; words: string; answer: string; accept: string[]; parts: ExamCard["parts"]; conv_hash: string; added_at: string | null; source: string; embedding: string | number[] | null; embedding_hash: string | null };
const toCard = (r: CardRow): ExamCard => ({ id: r.id, specHash: r.spec_hash, type: r.type, sub: r.sub, tags: r.tags ?? [], stage: r.stage === "draft" ? "draft" : "brain", words: r.words, answer: r.answer, accept: r.accept ?? [], parts: r.parts ?? { files: [], actions: [] }, convHash: r.conv_hash, addedAt: r.added_at, source: r.source === "takeuchi_send" ? "takeuchi_send" : "spec", embedding: typeof r.embedding === "string" ? JSON.parse(r.embedding) as Vec : r.embedding, embeddingHash: r.embedding_hash });
const toRow = (c: ExamCard) => ({ id: c.id, spec_hash: c.specHash, type: c.type, sub: c.sub, tags: c.tags, stage: c.stage, words: c.words, answer: c.answer, accept: c.accept, parts: c.parts, conv_hash: c.convHash, added_at: c.addedAt, source: c.source, embedding: c.embedding ?? null, embedding_hash: c.embeddingHash ?? null, updated_at: new Date().toISOString() });

export async function loadCards(sb: SupabaseClient | null): Promise<Record<string, ExamCard>> {
  if (await useDbStore(sb)) {
    const out: Record<string, ExamCard> = {};
    for (let p = 0; p < 20; p++) {
      const { data, error } = await sb!.from(CARD_TABLE).select("*").order("id").range(p * 500, p * 500 + 499);
      if (error) throw new Error(`${CARD_TABLE}: ${error.message}`);
      for (const r of (data ?? []) as CardRow[]) out[r.id] = toCard(r);
      if ((data ?? []).length < 500) break;
    }
    return out;
  }
  return readJson<{ cards?: Record<string, ExamCard> }>(CARDS_FILE, {}).cards ?? {};
}
export async function saveCards(sb: SupabaseClient | null, cards: ExamCard[]): Promise<"db" | "local"> {
  if (await useDbStore(sb)) {
    // 2026-10-16 確かめる人: 表への書き込みが失敗しても試験を止めない（手元の置き場に書く・次の読みで札が無い問題は安全側で入る）
    try {
      for (let i = 0; i < cards.length; i += 50) {
        const { error } = await sb!.from(CARD_TABLE).upsert(cards.slice(i, i + 50).map(toRow), { onConflict: "id" });
        if (error) throw new Error(`${CARD_TABLE} upsert: ${error.message}`);
      }
      return "db";
    } catch (e) { console.warn(`表に書けない → 手元の置き場に書く: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`); }
  }
  updateJsonFile<{ version: number; cards: Record<string, ExamCard> }>(CARDS_FILE, () => ({ version: 1, cards: {} }), (cur) => {
    const next = { ...cur.cards };
    for (const c of cards) next[c.id] = c;
    return { version: 1, cards: next };
  });
  return "local";
}

// ─── 問題 ↔ 知見の紐付け ───────────────────────────────────────────────
/** 知見の題・決めた事を手元・結果に写す時の伏せ方（共通の伏せ字。KB の本文に残る会話の名前を写さない） */
export async function kbTextMask(): Promise<(s: string) => string> {
  const { maskForEmbedding } = await import("../../app/lib/pii-mask");
  return (s: string) => maskForEmbedding(s);
}
// 表には知見の文の写しを置かない（KB の本文に会話の名前が残っている行がある＝写すと増える）。題・決めた事は読む時に KB から引き、伏せてから持つ
type LinkRow = { problem_id: string; kb_id: string; kind: string; score: number; note: string | null; created_at: string; system_design_thinking?: { title: string; insight: string } | null };
export async function loadLinks(sb: SupabaseClient | null): Promise<Record<string, KbLink[]>> {
  if (await useDbStore(sb)) {
    const out: Record<string, KbLink[]> = {};
    const { data, error } = await sb!.from(LINK_TABLE).select("problem_id, kb_id, kind, score, note, created_at, system_design_thinking(title, insight)").limit(20000);
    if (error) throw new Error(`${LINK_TABLE}: ${error.message}`);
    const mask = await kbTextMask();
    for (const r of (data ?? []) as unknown as LinkRow[]) (out[r.problem_id] ??= []).push({ kbId: r.kb_id, kind: r.kind === "fixed" ? "fixed" : "auto", score: r.score, title: r.system_design_thinking?.title ? mask(r.system_design_thinking.title) : undefined, decided: r.system_design_thinking?.insight ? mask(r.system_design_thinking.insight).slice(0, 120) : undefined, note: r.note ?? undefined, at: r.created_at });
    return out;
  }
  return readJson<Record<string, KbLink[]>>(LINKS_FILE, {});
}
/** 問題ごとに紐付けを置き換える（change は今の紐付けを受けて次を返す） */
export async function updateLinks(sb: SupabaseClient | null, change: (cur: Record<string, KbLink[]>) => Record<string, KbLink[]>): Promise<"db" | "local"> {
  if (await useDbStore(sb)) try {
    const cur = await loadLinks(sb);
    const next = change(cur);
    for (const [pid, ls] of Object.entries(next)) {
      const before = JSON.stringify(cur[pid] ?? []);
      if (before === JSON.stringify(ls)) continue;
      const del = await sb!.from(LINK_TABLE).delete().eq("problem_id", pid);
      if (del.error) throw new Error(`${LINK_TABLE} delete: ${del.error.message}`);
      if (ls.length) {
        const ins = await sb!.from(LINK_TABLE).insert(ls.map((l) => ({ problem_id: pid, kb_id: l.kbId, kind: l.kind, score: l.score, note: l.note ?? null, created_at: l.at })));
        if (ins.error) throw new Error(`${LINK_TABLE} insert: ${ins.error.message}`);
      }
    }
    return "db";
  } catch (e) { console.warn(`紐付けの表に書けない → 手元の置き場に書く: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`); }
  updateJsonFile<Record<string, KbLink[]>>(LINKS_FILE, () => ({}), change);
  return "local";
}

// ─── 直して通った時の紐付けの控え（知見の id がまだ無い＝親が kb-insert する前は題で控え、次の --index で id に解く） ───
export type PendingLink = { problemId: string; kbRef: string; at: string; note?: string };
export function readPendingLinks(): PendingLink[] { return readJson<PendingLink[]>(PENDING_LINKS_FILE, []); }
export function addPendingLinks(ls: PendingLink[]): void { updateJsonFile<PendingLink[]>(PENDING_LINKS_FILE, () => [], (cur) => [...cur, ...ls]); }
export function writePendingLinks(ls: PendingLink[]): void { atomicWriteJson(PENDING_LINKS_FILE, ls, true); }

// ─── KB（読むだけ） ─────────────────────────────────────────────────────
export type KbRow = { id: string; title: string; insight: string; rationale: string | null; tags: string[] | null; created_at: string; updated_at?: string | null; retired_at?: string | null };
export async function loadKbRows(sb: SupabaseClient): Promise<KbRow[]> {
  const out: KbRow[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, rationale, tags, created_at, updated_at").eq("is_current", true).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(`system_design_thinking: ${error.message}`);
    out.push(...((data ?? []) as KbRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
/** 埋め込みの近い現行の知見（RPC・読むだけ） */
export async function matchKb(sb: SupabaseClient, v: Vec, k = 8): Promise<Array<{ id: string; similarity: number }>> {
  const { data, error } = await sb.rpc("match_design_thinking_exact", { query_embedding: v, match_count: k });
  if (error) throw new Error(`match_design_thinking_exact: ${error.message}`);
  return (data ?? []) as Array<{ id: string; similarity: number }>;
}
export async function kbEmbeddings(sb: SupabaseClient, ids: string[]): Promise<Map<string, Vec>> {
  const out = new Map<string, Vec>();
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await sb.from("system_design_thinking").select("id, embedding").in("id", ids.slice(i, i + 50));
    if (error) throw new Error(`system_design_thinking embedding: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; embedding: string | number[] | null }>) {
      const e = typeof r.embedding === "string" ? JSON.parse(r.embedding) as Vec : r.embedding;
      if (e?.length) out.set(r.id, e);
    }
  }
  return out;
}
export function readKbSnapshot(): KbSnapshot | null { return existsSync(KB_SNAPSHOT_FILE) ? readJson<KbSnapshot | null>(KB_SNAPSHOT_FILE, null) : null; }
export function writeKbSnapshot(s: KbSnapshot): void { atomicWriteJson(KB_SNAPSHOT_FILE, s); }
/** 新しい・変えた知見に近い問題（紐付けがまだ無い知見の分） */
export function nearProblemsOf(kbVec: Vec, cards: ExamCard[], k = 3, min = 0.35): Array<{ id: string; sim: number }> {
  return cards.filter((c) => c.embedding?.length).map((c) => ({ id: c.id, sim: cosine(kbVec, c.embedding!) })).filter((x) => x.sim >= min).sort((a, b) => b.sim - a.sim).slice(0, k);
}

// ─── 録音から: 問題ごとの前置きの印と、見た名札 ───────────────────────────
export type PrefixInfo = { prefix: string | null; actions: string[]; at: string };
/** 録音の置き場を一度読んで、問題ごとに「ブレインの前置きの印（一番新しい録音）」と「名札の一覧」を作る */
export function scanCassetteForProblems(dir: string): Record<string, PrefixInfo> {
  const out: Record<string, PrefixInfo & { _at?: string }> = {};
  if (!existsSync(dir)) return out;
  for (const sub of readdirSync(dir)) {
    const d = join(dir, sub);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      let e: { action: string | null; tag?: Record<string, string>; firstAt: string; normBody: string };
      try { e = JSON.parse(readFileSync(join(d, f), "utf8")); } catch { continue; }
      const pid = e.tag?.problem;
      if (!pid) continue;
      const cur = (out[pid] ??= { prefix: null, actions: [], at: "" });
      const a = e.action ?? "(名札なし)";
      if (!cur.actions.includes(a)) cur.actions.push(a);
      if (/^brain_(?:full|fresh)/.test(a) && e.firstAt > cur.at) { const k = prefixKeyOfBody(e.normBody); if (k) { cur.prefix = k; cur.at = e.firstAt; } }
    }
  }
  for (const v of Object.values(out)) v.actions.sort();
  return out;
}
export function readPrefixes(): Record<string, PrefixInfo> { return readJson<Record<string, PrefixInfo>>(PREFIX_FILE, {}); }
export function writePrefixes(m: Record<string, PrefixInfo>): void { atomicWriteJson(PREFIX_FILE, m); }
