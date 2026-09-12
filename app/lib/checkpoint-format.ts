// app/lib/checkpoint-format.ts
// 会話のセーブデータ（conversation_checkpoints）の出力の読み取りと整形（純関数・DB 依存なし）
//
// 2026-09-13 竹内（あや事例の続き）「会話の要点を整理する能力が低いってこと？」→ 能力ではなく出力が途中で切れていた:
//   max_tokens 1500 に対し、長い会話ほど summary と key_facts が同じ事実を二重に書き・物件ごとに住所/築年/更新料まで写して膨らみ、
//   JSON が途中で切れて JSON.parse が失敗（本番ログのエラー位置は毎回 1,500〜1,800 文字目）→ 保存されず、
//   あや 74通中16通目・YUYA 73通中17通目・Aoi 61通中18通目・愛乃 126通で未作成のまま止まっていた。
//   ここで (1) 途中で切れた出力を見分け (2) 文字列内の生の改行など軽い崩れを直して読み (3) 上限に収める。

export const CHECKPOINT_SUMMARY_MAX = 1200;   // 読み手（final-check / ground-truth）は 2,000 字で切る。余裕を持って 1,200 字
export const CHECKPOINT_FACTS_MAX = 10;
export const CHECKPOINT_FACT_VALUE_MAX = 80;
const FACT_TYPES = new Set(["confirmed_fact", "aix_sent", "unresolved"]);
const STAGES = new Set(["hearing", "proposing", "applying", "contract"]);

export type CheckpointFact = { type: string; value: string };
export type ParsedCheckpoint = { summary: string; key_facts: CheckpointFact[]; stage: string | null };
export type CheckpointParseResult =
  | { ok: true; value: ParsedCheckpoint; repaired: boolean }
  | { ok: false; reason: "truncated" | "no_json" | "invalid_json" | "empty_summary"; detail?: string };

/** JSON 文字列リテラルの中の生の改行・タブを \n / \t にする（「Bad control character in string literal」対策） */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of json) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { out += ch; inStr = false; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/**
 * モデルの出力を読む。stopReason が max_tokens なら途中で切れている（保存しない）。
 * コードブロック・前後の説明文は外す。軽い崩れ（文字列内の生の改行）は直して読む。
 */
export function parseCheckpointOutput(raw: string, stopReason?: string | null): CheckpointParseResult {
  if (stopReason === "max_tokens") return { ok: false, reason: "truncated" };
  const text = (raw ?? "").replace(/```(?:json)?/g, "");
  const fb = text.indexOf("{");
  const lb = text.lastIndexOf("}");
  if (fb === -1 || lb <= fb) return { ok: false, reason: "no_json" };
  const body = text.slice(fb, lb + 1);
  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = JSON.parse(escapeControlCharsInStrings(body));
      repaired = true;
    } catch (e) {
      return { ok: false, reason: "invalid_json", detail: e instanceof Error ? e.message : String(e) };
    }
  }
  const p = (parsed ?? {}) as { summary?: unknown; key_facts?: unknown; stage?: unknown };
  const summary = typeof p.summary === "string" ? p.summary.trim() : "";
  if (!summary) return { ok: false, reason: "empty_summary" };
  const facts = (Array.isArray(p.key_facts) ? p.key_facts : [])
    .filter((f): f is { type: string; value: string } =>
      !!f && typeof (f as CheckpointFact).value === "string" && FACT_TYPES.has((f as CheckpointFact).type) && !!(f as CheckpointFact).value.trim())
    .map((f) => ({ type: f.type, value: f.value.trim().slice(0, CHECKPOINT_FACT_VALUE_MAX) }))
    .slice(0, CHECKPOINT_FACTS_MAX);
  const stage = typeof p.stage === "string" && STAGES.has(p.stage) ? p.stage : null;
  return { ok: true, repaired, value: { summary: clipSummary(summary), key_facts: facts, stage } };
}

/** 上限を超えた summary は行の途中で切らず、収まる行までにする（最後の行の途中で数字が切れた事実を残さない） */
export function clipSummary(summary: string, max = CHECKPOINT_SUMMARY_MAX * 1.5): string {
  if (summary.length <= max) return summary;
  const lines = summary.split("\n");
  const kept: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > max) break;
    kept.push(l);
    len += l.length + 1;
  }
  return kept.length ? kept.join("\n") : summary.slice(0, max);
}
