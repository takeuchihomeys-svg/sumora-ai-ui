// app/lib/conductor-reflection.ts — 統括の毎週の振り返り（#10・#14・弱い所 277・作業員5・11/07・純関数・LLM なし）
//
// 統括役の了承（11/07）: 新しい表は作らない。1週間の見張りの番（line_watch_turns）から、場面ごとにブレインの道（返信か AIX か）とスタッフの一手の当たりを数え、
//   当たりの低い場面を brain_weaknesses（key=reflect:<週>:<場面>）に、竹内さんに決めてもらう事を owner_questions（dedupe_key=reflect:<週>:<場面>）に推奨付きで足す。
//   決めるのはブレインと竹内さん（ここは数えて並べるだけ）。KB P0 8805bd74（強化できる所はその場で表に）・P1 ea2a9405③（分からない時は人に正直に渡す）
type Env = Record<string, string | undefined>;
export const conductorReflectionOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_REFLECTION ?? "").trim().toLowerCase() === "on";

export type WatchRow = { scene_key: string | null; brain_action: string | null; brain_reply_mode: string | null; staff_aix: unknown; staff_first_at: string | null };
export type SceneStat = { scene: string; n: number; hit: number; brainAixStaffReply: number; brainReplyStaffAix: number };

const staffAix = (v: unknown) => Array.isArray(v) ? v.length > 0 : !!v && typeof v === "object" && Object.keys(v as object).length > 0;
const brainAix = (r: WatchRow) => !!r.brain_action && r.brain_reply_mode !== "auto_reply";

/** 場面ごとの当たり（スタッフが返した番だけ） */
export function sceneStats(rows: ReadonlyArray<WatchRow>): SceneStat[] {
  const m = new Map<string, SceneStat>();
  for (const r of rows) {
    if (!r.staff_first_at) continue;
    if ((r.scene_key ?? "").startsWith("対象外")) continue; // 申込以降など対象外の番は数えない（project_post_apply_out_of_scope）
    const k = r.scene_key || "不明";
    const s = m.get(k) ?? { scene: k, n: 0, hit: 0, brainAixStaffReply: 0, brainReplyStaffAix: 0 };
    const b = brainAix(r), st = staffAix(r.staff_aix);
    s.n++; if (b === st) s.hit++; else if (b) s.brainAixStaffReply++; else s.brainReplyStaffAix++;
    m.set(k, s);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
/** 振り返りに上げる場面（件数が minN 以上で当たりが maxHit 未満・外れの多い順に top 件） */
export function weakScenes(stats: ReadonlyArray<SceneStat>, o: { minN?: number; maxHit?: number; top?: number } = {}): SceneStat[] {
  const minN = o.minN ?? 5, maxHit = o.maxHit ?? 0.6, top = o.top ?? 3;
  return stats.filter((s) => s.n >= minN && s.hit / s.n < maxHit).sort((a, b) => (b.n - b.hit) - (a.n - a.hit)).slice(0, top);
}
/** ISO 週の印（例 2026-W45） */
export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(), w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
/** brain_weaknesses の1行 */
export function weaknessRow(week: string, s: SceneStat) {
  const pct = Math.round((s.hit / s.n) * 100);
  const lean = s.brainAixStaffReply >= s.brainReplyStaffAix ? "ブレインが AIX・スタッフは返信" : "ブレインが返信・スタッフは AIX";
  return {
    key: `reflect:${week}:${s.scene}`, title: `毎週の振り返り ${week}: 場面「${s.scene}」の返信か AIX かの当たり ${pct}%`, area: "conductor",
    symptom: `${s.n}番のうち ${s.hit}番が合った（外れ ${s.n - s.hit}: ${lean}が多い）`,
    root_cause: null as string | null,
    evidence: { week, scene: s.scene, n: s.n, hit: s.hit, brain_aix_staff_reply: s.brainAixStaffReply, brain_reply_staff_aix: s.brainReplyStaffAix, source: "line_watch_turns（スタッフが返した番）・conductor-reflection" },
    occurrences: s.n - s.hit,
  };
}
/** owner_questions の1行（推奨付き）。外れの向きで推奨を変える（決めるのは竹内さん） */
export function questionRow(week: string, s: SceneStat) {
  const aixHeavy = s.brainAixStaffReply >= s.brainReplyStaffAix;
  return {
    kind: "conductor_reflection", topic: `場面「${s.scene}」の返信か AIX か`,
    question: `${week}: 場面「${s.scene}」で、ブレインの返信か AIX かが ${s.n}番中 ${s.n - s.hit}番スタッフと違いました（${aixHeavy ? "ブレインが AIX・スタッフは返信" : "ブレインが返信・スタッフは AIX"}が多い）。この場面の正しい一手はどちらが多いですか。`,
    options: ["返信（約束・答え）が多い", "AIX が多い", "番による（例を見て決める）"],
    recommended: aixHeavy ? "返信（約束・答え）が多い" : "AIX が多い",
    why: "スタッフの実際の一手の多い方を推奨にしています（竹内さんの番だけで数え直すと変わる事があります）",
    source_kind: "conductor_reflection", source_ref: `reflect:${week}:${s.scene}`, status: "open", priority: 3, dedupe_key: `reflect:${week}:${s.scene}`,
  };
}
