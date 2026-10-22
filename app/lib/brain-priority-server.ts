// app/lib/brain-priority-server.ts — 優先順位の段の「状況の材料の取り寄せ」（DB を読むだけ・LLM・埋め込みなし）
//   場面（reply-scene）→ 竹内さんの決定（system_design_thinking の現行・P0 は必ず先頭・P1 の決定を上位 k）。
//   並べは決まった計算（語と札・hybridRank の keyword）＝外のサービスに会話を送らない（お客様の文は手元の語の点だけに使う）。
//   行はプロセスの間 30分だけ持つ（毎回 DB を読まない）。大きさは上限つき（P0 最大4・P1 最大5・各160字）
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRagRows } from "@/app/lib/design-knowledge-rag-server";
import { hybridRank, rowInScene, sceneQuery, KB_SCENES, type KbScene, type RagRow } from "@/app/lib/design-knowledge-rag";
import type { PulledKbRow } from "@/app/lib/brain-priority";

const TTL_MS = 30 * 60 * 1000;
let cache: { at: number; rows: RagRow[] } | null = null;
async function rowsOf(sb: SupabaseClient): Promise<RagRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await loadRagRows(sb);
  cache = { at: Date.now(), rows };
  return rows;
}

/** 返信の判断に効く P0（AIX・判断・約束の札。監査・試験・診断の行は外す） */
export function isReplyP0(r: RagRow): boolean {
  const t = r.tags ?? [];
  return r.priority === 0 && t.some((x) => x === "AIX" || x === "判断" || x === "約束") && !t.some((x) => x === "監査" || x === "試験" || x === "ブレイン診断");
}
/** 仕組み・画面・運用の札（返信の判断の材料にならない） */
const INFRA_TAGS = new Set(["管理ツール", "やることリスト", "cron", "セキュリティ", "RLS", "試験", "監査", "API費用", "節約", "画面", "DB", "AIXLINX", "個人情報", "デプロイ", "グループ"]);
/** 竹内さんの決定・基本の知識・原則の P1（仕組みの行は外す） */
export function isReplyP1Decision(r: RagRow): boolean {
  const t = r.tags ?? [];
  if (r.priority !== 1) return false;
  if (t.some((x) => INFRA_TAGS.has(x))) return false;
  return t.includes("竹内さんの決定") || t.includes("原則") || /^【(?:決定|基本の知識)/.test(r.title);
}

export const PULL_P0_MAX = 4;
export const PULL_P1_K = 5;

/** 純: 行の一覧 → 引く行（P0 は先頭・場面の P1 の決定を上位 k）。テストできるように DB と分けた */
export function pickPulledRows(rows: RagRow[], scene: string | null, turnText: string, nowIso: string): PulledKbRow[] {
  const cur = rows.filter((r) => r.is_current);
  const p0 = cur.filter(isReplyP0).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).slice(0, PULL_P0_MAX);
  const ks = (scene && scene in KB_SCENES ? scene : "other") as KbScene;
  const cand = cur.filter(isReplyP1Decision);
  const inScene = ks !== "other" ? cand.filter((r) => rowInScene(r, ks)) : [];
  const pool = inScene.length >= 2 ? inScene : cand;
  const q = sceneQuery(turnText.replace(/\s+/g, " ").slice(0, 300), ks === "other" ? null : ks) || KB_SCENES[ks].terms || "返信";
  const ranked = hybridRank(pool, new Map(), q, { nowIso, mode: "keyword", scene: ks === "other" ? null : ks });
  const p1 = ranked.slice(0, PULL_P1_K).map((s) => s.row);
  const brief = (r: RagRow): PulledKbRow => ({ id: r.id, title: r.title, insight: String(r.insight ?? "").replace(/\s+/g, " ").trim().slice(0, 160), priority: r.priority ?? null });
  return [...p0.map(brief), ...p1.map(brief)];
}

export async function pullPriorityKb(sb: SupabaseClient, scene: string | null, turnText: string): Promise<{ rows: PulledKbRow[]; ms: number; err?: string }> {
  const t0 = Date.now();
  try {
    const rows = await rowsOf(sb);
    return { rows: pickPulledRows(rows, scene, turnText, new Date().toISOString()), ms: Date.now() - t0 };
  } catch (e) {
    return { rows: [], ms: Date.now() - t0, err: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
  }
}
