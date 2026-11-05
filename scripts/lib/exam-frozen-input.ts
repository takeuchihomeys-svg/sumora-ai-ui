// scripts/lib/exam-frozen-input.ts — 試験の入力を決まった形にする（時計を問題ごとに固定・本番 DB の育つ材料を夜の写しに固定）
//
// 2026-11-05 作業員8（統括役の了承の 1・竹内さんの決まり「試験の質と費用の改善は聞かずに直す」の範囲・弱い所 314）:
//   録音の brain_full 1,431組で入力が同じは 24組。違いの出所は台帳（直した: fe0f621d）・時計 739・本番 DB の材料 694 だった。
//   ① 時計: 走らせた日の「今日」（曜日）が入る＝水曜と木曜で入力が変わる。→ 仮の今＝元の番の時刻を7日の倍数だけ進めた、今に一番近い過去の時刻。
//      曜日と時刻（夜の番は夜）は元の番と同じ・1週間は同じ値＝入力が毎日変わらない（日付は録音の鍵で伏せている）。
//   ② 本番 DB の育つ材料（返信例・ナレッジ・決まり・統計・RAG）: 学習の cron（JST 3:23）で毎日変わる。→ 試験の中だけ、その日（JST 4:00 区切り）に
//      最初に読んだ答えを置き場に控え、同じ日の同じ問い合わせはそれを返す（夜の基準と昼の依頼が同じ材料を見る）。会話ごとの行（テスト用の会話・条件の行の id を含む問い合わせ）は控えない。
//   止める: EXAM_FROZEN_CLOCK=off・EXAM_DB_SNAPSHOT=off
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DAY = 86_400_000, WEEK = 7 * DAY;

// ─── ① 時計 ───────────────────────────────────────────────────────────
/**
 * 仮の今（純関数）: 元の番の時刻 atMs を 7日の倍数だけ進めて、realNowMs 以下で一番近い時刻。
 *   返す shiftDays は場面の文の日付のずらし（7の倍数＝曜日の言い方はそのまま）。atMs が未来なら 0。
 */
export function frozenSceneNow(atMs: number, realNowMs: number): { nowMs: number; shiftDays: number } {
  if (!Number.isFinite(atMs) || !Number.isFinite(realNowMs) || atMs >= realNowMs) return { nowMs: atMs, shiftDays: 0 };
  const k = Math.floor((realNowMs - atMs) / WEEK);
  return { nowMs: atMs + k * WEEK, shiftDays: k * 7 };
}

export const frozenClockOn = (env: Record<string, string | undefined> = process.env) => String(env.EXAM_FROZEN_CLOCK ?? "").trim().toLowerCase() !== "off";
export const dbSnapshotOn = (env: Record<string, string | undefined> = process.env) => String(env.EXAM_DB_SNAPSHOT ?? "").trim().toLowerCase() !== "off";

// ─── ② 本番 DB の育つ材料の夜の写し ─────────────────────────────────────────
/** 学習で育つ材料の表（会話ごとの表は入れない）。brain-core・reply-context が読む物（11/05 の grep） */
export const SNAPSHOT_TABLES: ReadonlySet<string> = new Set([
  "ai_reply_examples", "ai_reply_knowledge", "ai_prompt_rules", "trigger_action_rules", "aix_transition_stats", "winning_pattern_logs",
  "next_action_logs", "brain_manuals", "brain_weaknesses", "brain_unknowns", "brain_aix_feedback", "aix_action_attribution", "line_watch_turns",
  "system_design_thinking", "winning_patterns",
]);
export const SNAPSHOT_RPCS: ReadonlySet<string> = new Set(["match_winning_patterns", "match_templates", "match_reply_knowledge", "match_design_knowledge"]);

/** 写しの日（JST 4:00 で区切る＝学習の cron 3:23 の後）。"YYYY-MM-DD" */
export function snapshotDay(realNowMs: number): string {
  return new Date(realNowMs + 9 * 3_600_000 - 4 * 3_600_000).toISOString().slice(0, 10);
}

/** 控えてよい問い合わせか（純関数）: GET の表か POST の rpc で、会話ごとの id（excludeIds）を含まない */
export function snapshotTarget(url: string, method: string, body: string, excludeIds: readonly string[]): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const m = u.pathname.match(/\/rest\/v1\/(rpc\/)?([a-z_]+)$/);
  if (!m) return null;
  const isRpc = !!m[1], name = m[2];
  const meth = (method || "GET").toUpperCase();
  if (isRpc ? meth !== "POST" || !SNAPSHOT_RPCS.has(name) : meth !== "GET" || !SNAPSHOT_TABLES.has(name)) return null;
  const hay = decodeURIComponent(url) + "\n" + (body ?? "");
  if (excludeIds.some((id) => id && hay.includes(id))) return null;
  return name;
}

/** 鍵（純関数）: 時刻（ISO）は日付まで・数字だけのミリ秒の時刻も伏せる＝同じ日の同じ問い合わせは同じ鍵 */
export function snapshotKey(url: string, method: string, body: string): string {
  const norm = (s: string) => s
    .replace(/(\d{4}-\d{2}-\d{2})[T ]\d{2}(?::|%3A)\d{2}(?:(?::|%3A)\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::|%3A)?\d{2}|%2B\d{2}(?::|%3A)\d{2})?/gi, "$1")
    .replace(/\b1[6-9]\d{11}\b/g, "<ms>");
  return createHash("sha256").update(`${(method || "GET").toUpperCase()}\n${norm(url)}\n${norm(body ?? "")}`).digest("hex").slice(0, 40);
}

type Snap = { status: number; contentType: string | null; contentRange: string | null; body: string; at: string; table: string };
export type SnapshotStats = { hit: number; miss: number; skip: number };

/**
 * globalThis.fetch を包む（brain-exam の setupLlmTest の後に1回）。控えるのは成功（2xx）の答えだけ。
 *   dir＝<置き場>/db-snapshot・excludeIds＝今の会話・条件の行の id（呼ぶたびに読む）
 */
export function installDbSnapshot(opts: { dir: string; excludeIds: () => string[]; nowMs?: () => number }): SnapshotStats {
  const stats: SnapshotStats = { hit: 0, miss: 0, skip: 0 };
  const inner = globalThis.fetch;
  const now = opts.nowMs ?? (() => Date.now());
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? (input as Request).method : "GET")) || "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    const table = snapshotTarget(url, method, body, opts.excludeIds());
    if (!table) return inner(input, init);
    // 2026-11-06 作業員8（弱い所 354・作業員1の気付き）: 夜の基準（22時台＝その日）と翌朝の依頼（4:00 以降＝次の日）で写しの日が分かれていた。
    //   EXAM_DB_SNAPSHOT_DAY があればその日の写しを読む（夜の基準で比べる依頼と前を作る子に、夜の基準の写しの日を渡す）
    const day = (process.env.EXAM_DB_SNAPSHOT_DAY ?? "").trim() || snapshotDay(now());
    const file = join(opts.dir, day, `${snapshotKey(url, method, body)}.json`);
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8")) as Snap;
        stats.hit++;
        const h = new Headers(); if (s.contentType) h.set("content-type", s.contentType); if (s.contentRange) h.set("content-range", s.contentRange);
        return new Response(s.body, { status: s.status, headers: h });
      } catch { /* 壊れた控えは読み直す */ }
    }
    const res = await inner(input, init);
    if (!res.ok) { stats.skip++; return res; }
    const text = await res.text();
    stats.miss++;
    try {
      mkdirSync(join(opts.dir, day), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, JSON.stringify({ status: res.status, contentType: res.headers.get("content-type"), contentRange: res.headers.get("content-range"), body: text, at: new Date().toISOString(), table } satisfies Snap));
      renameSync(tmp, file);
    } catch { /* 控えられなくても答えは返す */ }
    const h = new Headers(res.headers); h.delete("content-length"); h.delete("content-encoding");
    return new Response(text, { status: res.status, statusText: res.statusText, headers: h });
  };
  globalThis.fetch = wrapped;
  return stats;
}
