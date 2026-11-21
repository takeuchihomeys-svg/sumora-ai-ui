// app/lib/conductor-lessons.ts — 統括が近い場面の学び（conductor_lessons）を読む口の決まり（純関数・DB/LLM なし）
//
// 2026-11-21 作業員L（竹内さんの決定 11/21・KB 56691196 P1「試験と連動して LINE のブレインの統括を鍛える」・統括役の OK）:
//   試験の外れ（と本番の外れ）を作業員H が1行の学び（型となぜ）にし、conductor_lessons に置く。統括は番ごとに、状況の文の近さ＋場面（scene）
//   と駅（stage）の一致で上位3件を読み、重点と確認の順番の参考にする。答えの文は写さない（学びは型となぜだけ）。
//   漏れの線: 今の会話から作った学び（source_conv が同じ）は読まない（自分の答えを写さない・試験の問題の会話も同じ）。
//   読んだ学びの id は判断の記録（digest の ls）に残す＝効きを測る（学びを作っていない問題の組の前後・竹内さんの一手との一致）。
//   最終チェックの印（記録だけ）: 下書きの一手が、同じ場面の学びで「前に外した一手（got_act）」と同じ時に印。本文は書き換えない。
// 切替 CONDUCTOR_LESSONS: 既定 shadow（読んで記録だけ・材料に渡さない・統括役の決め 11/21）／on（入口の統括の材料に渡す）／off（読まない）。
// テスト: app/lib/__tests__/conductor-lessons.test.ts
type Env = Record<string, string | undefined>;
export type LessonsMode = "off" | "shadow" | "on";
export function conductorLessonsMode(env: Env = typeof process !== "undefined" ? process.env : {}): LessonsMode {
  const v = (env.CONDUCTOR_LESSONS ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "off" ? "off" : "shadow";
}

/** conductor_lessons の1行（欄の名前は作業員H とそろえた・11/21） */
export type LessonRow = {
  id: string; source: string; source_conv?: string | null;
  scene?: string | null; stage?: string | null; mood?: string | null;
  expected_act?: string | null; got_act?: string | null;
  miss_kind?: "material_missing" | "scene_misread" | "reply_vs_aix" | string | null;
  check_order?: string | null; lesson: string; similarity?: number | null;
};

export const LESSONS_TOP = 3;
export const LESSON_MAX_CHARS = 80;
const MISS_JA: Record<string, string> = { material_missing: "材料が届いていない", scene_misread: "場面の読み違い", reply_vs_aix: "返信か AIX かの取り違え" };
const clip = (s: unknown, n: number) => Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, n).join("");

/** 今の会話から作った学びを外す（source_conv の頭8字か source の "prod:<頭8字>" で照らす） */
export function excludeOwnConversation(rows: ReadonlyArray<LessonRow>, conversationId: string | null | undefined): LessonRow[] {
  const head = String(conversationId ?? "").slice(0, 8);
  if (!head) return [...rows];
  return rows.filter((r) => {
    const sc = String(r.source_conv ?? "");
    if (sc && (sc === conversationId || sc.slice(0, 8) === head)) return false;
    if (String(r.source ?? "").startsWith(`prod:${head}`)) return false;
    return true;
  });
}
/** RPC に渡す外す出所（本番の学びの出所の形） */
export function excludeSourcesFor(conversationId: string | null | undefined): string[] {
  const head = String(conversationId ?? "").slice(0, 8);
  return head ? [`prod:${head}`] : [];
}

/** 上位 N 件（同じ学びの文は1つに） */
export function pickLessons(rows: ReadonlyArray<LessonRow>, conversationId: string | null | undefined, top = LESSONS_TOP): LessonRow[] {
  const seen = new Set<string>();
  const out: LessonRow[] = [];
  for (const r of excludeOwnConversation(rows, conversationId)) {
    const k = clip(r.lesson, LESSON_MAX_CHARS);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(r);
    if (out.length >= top) break;
  }
  return out;
}

/** 統括に渡す材料の1塊（on の時だけ使う）。空なら "" */
export function lessonsMaterialLine(rows: ReadonlyArray<LessonRow>): string {
  if (!rows.length) return "";
  const lines = rows.map((r) => `- ${[r.scene, r.stage].filter(Boolean).join("・") || "場面"}: ${clip(r.lesson, LESSON_MAX_CHARS)}${r.expected_act ? `（竹内さんの一手: ${r.expected_act}）` : ""}${r.miss_kind && MISS_JA[r.miss_kind] ? `（前の外れ: ${MISS_JA[r.miss_kind]}）` : ""}`);
  return `【近い場面の学び（型となぜ・参考。答えの文は写さない・今の会話の事実が優先）】\n${lines.join("\n")}`;
}

/** 判断の記録に残す読んだ学びの id（頭8字を , で） */
export function lessonsDigest(rows: ReadonlyArray<LessonRow>): string | null {
  return rows.length ? rows.map((r) => String(r.id).slice(0, 8)).join(",") : null;
}

/**
 * 最終チェックの印（記録だけ）: 下書きの一手が、読んだ学びのうち同じ場面で「前に外した一手（got_act）」と同じで、
 * その学びの竹内さんの一手（expected_act）とは違う時に、その学びの id を返す。無ければ空。
 */
export function sameMissMark(draftAct: string | ReadonlyArray<string> | null | undefined, rows: ReadonlyArray<LessonRow>, scene?: string | null): string[] {
  const acts = (Array.isArray(draftAct) ? draftAct : [draftAct]).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!acts.length) return [];
  return rows.filter((r) => r.got_act && acts.includes(r.got_act) && !acts.includes(String(r.expected_act ?? "")) && (!scene || !r.scene || r.scene === scene)).map((r) => String(r.id).slice(0, 8));
}

/**
 * ブレインの答え（meta）の一手を、学びの got_act と同じ形（試験の道の符号: "AIX:<種類>"・"2段:<種類>"・"返信"）で。
 *   AIX は種類と族（物件の4種＝AIX:物件）も並べる（brain-exam-score.brainPathCode の主な形だけ・2択は先の側）
 */
export function brainActCodes(meta: { reply_mode?: unknown; action?: unknown; two_stage?: unknown; two_choice_mode?: unknown; two_choice_preferred?: unknown; two_choice_aix?: unknown } | null | undefined): string[] {
  if (!meta) return [];
  const action = String(meta.action ?? (meta.two_choice_mode && meta.two_choice_preferred === "aix" ? meta.two_choice_aix : "") ?? "").trim();
  if ((meta.reply_mode === "aix" || (meta.two_choice_mode && meta.two_choice_preferred === "aix")) && action) {
    const fam = /^property_(?:send|recommendation|pickup|search)$/.test(action) ? "物件" : action;
    return [...new Set([`AIX:${action}`, `AIX:${fam}`])];
  }
  const ts = String(meta.two_stage ?? "").trim();
  if (ts) return [`2段:${ts}`];
  return ["返信"];
}
