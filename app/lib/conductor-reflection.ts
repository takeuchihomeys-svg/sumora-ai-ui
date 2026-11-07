// app/lib/conductor-reflection.ts — 統括の毎週の振り返り（#10・#14・弱い所 277・作業員5・11/07・純関数・LLM なし）
//
// 統括役の了承（11/07）: 新しい表は作らない。1週間の見張りの番（line_watch_turns）から、場面ごとにブレインの道（返信か AIX か）とスタッフの一手の当たりを数え、
//   当たりの低い場面を brain_weaknesses（key=reflect:<週>:<場面>）に、竹内さんに決めてもらう事を owner_questions（dedupe_key=reflect:<週>:<場面>）に推奨付きで足す。
//   決めるのはブレインと竹内さん（ここは数えて並べるだけ）。KB P0 8805bd74（強化できる所はその場で表に）・P1 ea2a9405③（分からない時は人に正直に渡す）
import { aixLabelOf } from "./two-message-plan";
type Env = Record<string, string | undefined>;
// 11/07 統括役: 既定 on（書かない形で1回流し、出る行を目で読んで重複・対象外の混ざり無しを確かめた）。止める CONDUCTOR_REFLECTION=off
export const conductorReflectionOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_REFLECTION ?? "").trim().toLowerCase() !== "off";

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
/** 見張りの場面の札（"AIX:application_push"・"返信:意図:chat"）を竹内さんの読む言葉に（AIX は画面のボタン名） */
export function sceneLabel(scene: string): string {
  if (scene.startsWith("AIX:")) return `AIX【${aixLabelOf(scene.slice(4))}】`;
  if (scene.startsWith("返信:")) { const r = scene.slice(3).replace(/^意図:/, ""); return `返信（${({ chat: "雑談" } as Record<string, string>)[r] ?? r}）`; }
  return scene;
}
/** owner_questions の1行（推奨付き・竹内さんが読む短い文）。推奨は今週のスタッフの実際の一手に合わせる（決めるのは竹内さん） */
export function questionRow(week: string, s: SceneStat) {
  const aixHeavy = s.brainAixStaffReply >= s.brainReplyStaffAix;
  const label = sceneLabel(s.scene), staff = aixHeavy ? "返信" : "AIX", brain = aixHeavy ? "AIX" : "返信";
  return {
    kind: "conductor_reflection", topic: `${label}の番`,
    question: `ブレインが${label}にした番（今週 ${s.n}番）で、スタッフは${staff}で送った番が ${s.n - s.hit}番ありました。この番は${staff}で良いですか？`,
    options: [`はい、${staff}で良い`, `いいえ、${brain}で良い`, "番による"],
    // 外れが3分の2以上の時だけ「はい」を推す（半々の時は番による＝例を見て決める）
    recommended: (s.n - s.hit) / s.n >= 0.66 ? `はい、${staff}で良い` : "番による",
    why: `今週のスタッフの実際の一手（${s.n - s.hit}/${s.n}番）に合わせています`,
    source_kind: "conductor_reflection", source_ref: `reflect:${week}:${s.scene}`, status: "open", priority: 3, dedupe_key: `reflect:${week}:${s.scene}`,
  };
}

// ── 返信の番だけの文の質（11/07 統括役・作業員9の app/lib/reply-quality-weekly.ts の stats を振り返りに足す） ──
//   近さの平均・0.6 未満の割合・書き手の外れの数を、終わった週とその前の週で比べる。確認事項（owner_questions）には出さない。
//   弱い所に1行足すのは 0.6 未満の割合が前の週より上がった時だけ（鍵 reflect:<週>:reply_quality）。
export type ReplyWeek = { week: string; n: number; avg: number | null; lowPct: number | null; lowBrain: number; lowWriter: number };
export type ReplyQualityDelta = { week: string; prevWeek: string | null; n: number; avg: number | null; lowPct: number | null; lowWriter: number; lowBrain: number;
  prevN: number | null; avgDiff: number | null; lowPctDiff: number | null; lowWriterDiff: number | null; rose: boolean };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** 終わった週（currentWeek より前）の最後の2週を比べる。currentWeek は jstWeekOf(今)（今週の途中の数を混ぜない） */
export function replyQualityDelta(stats: ReadonlyArray<ReplyWeek>, currentWeek: string, o: { minN?: number } = {}): ReplyQualityDelta | null {
  const minN = o.minN ?? 5;
  const done = stats.filter((s) => s.week < currentWeek).sort((a, b) => a.week.localeCompare(b.week));
  const cur = done[done.length - 1];
  if (!cur || cur.n === 0) return null;
  const prev = done.length >= 2 ? done[done.length - 2] : null;
  const both = !!prev && prev.n >= minN && cur.n >= minN;
  const lowPctDiff = both && cur.lowPct != null && prev!.lowPct != null ? Math.round((cur.lowPct - prev!.lowPct) * 10) / 10 : null;
  return {
    week: cur.week, prevWeek: prev?.week ?? null, n: cur.n, avg: cur.avg, lowPct: cur.lowPct, lowWriter: cur.lowWriter, lowBrain: cur.lowBrain,
    prevN: prev?.n ?? null,
    avgDiff: both && cur.avg != null && prev!.avg != null ? r3(cur.avg - prev!.avg) : null,
    lowPctDiff, lowWriterDiff: both ? cur.lowWriter - prev!.lowWriter : null,
    // 件数が少ない週どうしは比べない（揺れで弱い所を足さない）
    rose: lowPctDiff != null && lowPctDiff > 0,
  };
}
/** 0.6 未満が上がった週だけの brain_weaknesses の1行（rose でなければ null） */
export function replyQualityWeaknessRow(week: string, d: ReplyQualityDelta) {
  if (!d.rose) return null;
  return {
    key: `reflect:${week}:reply_quality`, title: `毎週の振り返り ${week}: 返信の番の文の近さ 0.6 未満が ${d.lowPct}%（前の週より +${d.lowPctDiff}）`, area: "writer",
    symptom: `返信の番 ${d.n}通（竹内さん・AIX の番を除く・週 ${d.week}）の近さの平均 ${d.avg}（前の週との差 ${d.avgDiff ?? "-"}）・0.6 未満 ${d.lowPct}%・うち書き手 ${d.lowWriter}（差 ${d.lowWriterDiff ?? "-"}）・ブレイン ${d.lowBrain}`,
    root_cause: null as string | null,
    evidence: { ...d, source: "ai_reply_examples×messages（reply-quality-weekly）・conductor-reflection" },
    occurrences: d.lowWriter + d.lowBrain,
  };
}
