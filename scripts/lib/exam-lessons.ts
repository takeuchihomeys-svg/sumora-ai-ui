// scripts/lib/exam-lessons.ts — 試験の外れから統括の学び（conductor_lessons の1行）の下書きを作る（純関数・LLM も DB も使わない）
//
// 2026-11-21 作業員H（竹内さんの決定 KB 56691196「試験と連動して統括を鍛える」・欄は作業員L と合わせた）:
//   試験の外れ1件を「場面・駅・気持ち・竹内さんの一手・こちらの一手・答えが変わった段・原因の3つ・確認の順番」の行にする。
//   lesson（型となぜの1行）と埋め込みは呼ぶ側（scripts/exam-lessons.ts）が DeepSeek・OpenAI で足す。
//   ⚠ 正解は竹内さん本人の番だけ（KB 41dadfe6）: takeuchiIds に入っていない問題からは作らない
//   ⚠ 漏れの線: source_conv に問題の元の会話を入れる（読む側が今の会話・試験の問題の会話を外す）
import { classifyMiss, type MissRowLite, type MissCause } from "./exam-miss-stage";
import { turnSituationText } from "../../app/lib/conductor-turn-vectors";

export type LessonRow = MissRowLite & { rep: number; brain?: (MissRowLite["brain"] & Record<string, unknown>) | null; error?: unknown };
export type LessonProblem = { id: string; conv: string; accept?: string[]; why?: string; customer?: string; type?: string };
export type LessonDraft = {
  source: string; source_conv: string; dedupe_key: string;
  scene: string | null; stage: string | null; mood: string | null;
  expected_act: string; got_act: string | null; changed_stage: string | null;
  miss_kind: "material_missing" | "scene_misread" | "reply_vs_aix" | null;
  check_order: string | null; situation_text: string;
  /** lesson を作る材料（DeepSeek に渡す・伏せ済みの問題の why と型だけ） */
  seed: { type: string | null; why: string | null; cause: MissCause; stageNote: string };
};

export function lessonsBuildOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CONDUCTOR_LESSONS_BUILD ?? "").trim().toLowerCase() === "on"; // 既定 off
}
export function missKindOf(c: MissCause): LessonDraft["miss_kind"] {
  return c === "材料が届いていない" ? "material_missing" : c === "場面・決まりの読み違い" ? "scene_misread" : c === "AIX の番を返信にした" ? "reply_vs_aix" : null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
function moodOf(b: Record<string, unknown> | null | undefined): string | null {
  const e = b?.customer_emotion;
  if (typeof e === "string") return str(e);
  if (e && typeof e === "object") { const o = e as Record<string, unknown>; return str(o.label) ?? str(o.primary) ?? str(o.state) ?? null; }
  return null;
}

/**
 * 1本の依頼の答案（今の回）から学びの下書きを作る。外れ＝その問題の道が過半数で✕。
 * takeuchiIds＝正解が竹内さん本人の番の問題（それ以外は作らない）
 */
export function buildLessonDrafts(label: string, rows: ReadonlyArray<LessonRow>, problems: ReadonlyArray<LessonProblem>, takeuchiIds: ReadonlySet<string>): LessonDraft[] {
  const byId = new Map<string, LessonRow[]>();
  for (const r of rows) { if (r.error) continue; byId.set(r.id, [...(byId.get(r.id) ?? []), r]); }
  const probOf = new Map(problems.map((p) => [p.id, p]));
  const out: LessonDraft[] = [];
  for (const [id, rs] of byId) {
    const p = probOf.get(id);
    if (!p || !takeuchiIds.has(id) || !p.accept?.length) continue;
    const okN = rs.filter((r) => r.path?.ok).length;
    if (okN * 2 > rs.length) continue; // 過半数で道○＝外れではない
    const miss = rs.find((r) => !r.path?.ok) ?? rs[0];
    const v = classifyMiss(miss);
    const b = (miss.brain ?? null) as Record<string, unknown> | null;
    const co = (b?.check_order ?? null) as { type?: unknown; scene?: unknown } | null;
    const sn = (b?.situation_now ?? null) as { stage?: unknown } | null;
    const scene = str(co?.scene), check = str(co?.type), stage = str(sn?.stage);
    const expected = p.accept[0], got = str(miss.path?.code);
    out.push({
      source: `exam:${id}#${miss.rep}@${label}`,
      source_conv: p.conv,
      dedupe_key: [p.conv, scene ?? "-", expected, got ?? "-"].join("|"),
      scene, stage, mood: moodOf(b),
      expected_act: expected, got_act: got,
      changed_stage: v.stage === "none" ? null : v.stage,
      miss_kind: missKindOf(v.cause),
      check_order: check,
      situation_text: turnSituationText({ scene, stage, customerMasked: String(p.customer ?? ""), lastStaffKind: null }),
      seed: { type: p.type ?? null, why: str(p.why), cause: v.cause, stageNote: v.line },
    });
  }
  return out;
}

/** lesson（型となぜの1行・80字まで）を作る DeepSeek への問い。答えの文・名前は渡さない（型・正解の一手・外れた一手・問題の why・原因だけ） */
export function lessonPrompt(d: LessonDraft): string {
  return [
    "あなたは不動産仲介の LINE 返信の統括を鍛える係です。下の試験の外れから、次に同じ場面で統括が読むべき『型となぜ』を日本語80字以内の1行で書いてください。",
    "お客様やスタッフの文・名前・物件名・金額は書かない。『〜の場面では〜（なぜ: 〜）』の形。1行だけを返す。",
    `場面: ${d.scene ?? "不明"}・確認の順番: ${d.check_order ?? "不明"}・型: ${d.seed.type ?? "不明"}`,
    `竹内さんの一手: ${d.expected_act}・こちらの一手: ${d.got_act ?? "不明"}`,
    `外れた段: ${d.changed_stage ?? "不明"}・原因: ${d.seed.cause}`,
    `竹内さんがそうした理由（問題の作り手のメモ）: ${(d.seed.why ?? "なし").slice(0, 300)}`,
  ].join("\n");
}
/** 返ってきた1行を整える（80字・改行・名前らしき「〇〇さん」を伏せる） */
export function cleanLesson(s: string): string | null {
  const one = String(s ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";
  const t = one.replace(/^[-・*「『]+|[」』]+$/g, "").replace(/(^|[はにのがをとへ、。\s])([一-龥ァ-ヶー]{1,5})さん/g, "$1お客様").slice(0, 80).trim();
  return t.length >= 8 ? t : null;
}
